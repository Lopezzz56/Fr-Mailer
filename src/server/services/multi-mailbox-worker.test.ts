import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import prisma from "../db.js";
import * as mailer from "./mailer.js";
import * as personalMailbox from "./personal-mailbox.js";
import * as inboxMonitor from "./inbox-monitor.js";
import * as sequenceService from "./sequence-service.js";
import * as config from "../config.js";
import { SendWorker, acquireLease, releaseLease, sentInLast24hForCampaign } from "./send-worker.js";
import { runSenderCycle } from "./background.js";
import { internalRouter } from "../routes/internal.js";
import { errorHandler } from "../middleware/error-handler.js";

/**
 * In-memory simulation of the relevant Prisma tables for deterministic multi-mailbox
 * scheduling, rolling 24h budget, round-robin pacing, and serverless tick tests.
 */
function setupInMemoryStore(initialNow: number) {
  let currentNow = initialNow;
  const mailboxes: { id: string; email: string; fromName: string; encryptedPassword: string; lastVerifiedAt: Date }[] = [];
  const campaigns: {
    id: string;
    name: string;
    status: "DRAFT" | "APPROVED" | "SENDING" | "PAUSED" | "COMPLETED" | "CANCELLED";
    fromName: string;
    fromEmail: string | null;
    replyTo: string | null;
    mailboxId: string | null;
    sendRatePerMinute: number;
    automationMode: "APPROVAL_REQUIRED" | "AUTOMATIC" | "MANUAL";
    createdById: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
  }[] = [];
  const sends: {
    id: string;
    campaignId: string;
    email: string;
    subject: string;
    html: string;
    text: string;
    messageId: string;
    status: "PENDING" | "CLAIMED" | "SENT" | "FAILED" | "SKIPPED" | "CANCELLED" | "UNKNOWN";
    attempts: number;
    stepIndex: number;
    approvedAt: Date | null;
    scheduledFor: Date | null;
    claimedAt: Date | null;
    sentAt: Date | null;
    repliedAt: Date | null;
    lastError: string | null;
    skipReason: string | null;
    mailboxId: string | null;
    sentByUserId: string | null;
    inReplyToId: string | null;
    attachments: unknown[];
    createdAt: Date;
    updatedAt: Date;
  }[] = [];
  const leases = new Map<string, { owner: string; until: number }>();

  const sentMessages: { to: string; fromEmail?: string | null; campaignId?: string }[] = [];
  const fakeTransport: mailer.MailTransport = {
    async send(msg) {
      sentMessages.push({ to: msg.to, fromEmail: msg.fromEmail });
      return { response: "250 OK" };
    },
    async verify() {},
    close() {},
  };
  vi.spyOn(mailer, "getTransport").mockReturnValue(fakeTransport);
  vi.spyOn(personalMailbox, "getMailboxCredentials").mockImplementation(async (id, fromName) => {
    const mb = mailboxes.find((m) => m.id === id);
    if (!mb) return null;
    return {
      accountId: mb.id,
      userId: "",
      email: mb.email,
      password: "pw",
      fromName: fromName || mb.fromName,
      smtpHost: "mail.spacemail.com",
      smtpPort: 465,
      smtpSecure: true,
      imapHost: "mail.spacemail.com",
      imapPort: 993,
    };
  });
  vi.spyOn(sequenceService, "onStepSent").mockResolvedValue(undefined);
  vi.spyOn(inboxMonitor, "anyInboxDue").mockResolvedValue(false);
  vi.spyOn(inboxMonitor, "checkAllInboxes").mockResolvedValue([] as any);

  vi.spyOn(prisma.mailboxAccount, "findMany").mockImplementation((async () => mailboxes) as any);
  vi.spyOn(prisma.mailboxAccess, "findMany").mockResolvedValue([]);
  vi.spyOn(prisma.userMailbox, "findMany").mockResolvedValue([]);

  vi.spyOn(prisma.campaign, "findMany").mockImplementation((async (args: any) => {
    const statusFilter = args?.where?.status;
    let res = campaigns.slice();
    if (statusFilter) {
      res = res.filter((c) => c.status === statusFilter);
    }
    return res;
  }) as any);

  vi.spyOn(prisma.campaign, "findUnique").mockImplementation((async (args: any) => {
    return campaigns.find((c) => c.id === args?.where?.id) ?? null;
  }) as any);

  vi.spyOn(prisma.campaign, "updateMany").mockImplementation((async (args: any) => {
    let count = 0;
    for (const c of campaigns) {
      if (args?.where?.id && c.id !== args.where.id) continue;
      if (args?.where?.status && c.status !== args.where.status) continue;
      Object.assign(c, args.data);
      count++;
    }
    return { count };
  }) as any);

  vi.spyOn(prisma.suppressionEntry, "findUnique").mockResolvedValue(null);
  vi.spyOn(prisma.campaignRecipientState, "count").mockResolvedValue(0);

  vi.spyOn(prisma.send, "count").mockImplementation((async (args: any) => {
    const w = args?.where ?? {};
    return sends.filter((s) => {
      if (w.campaignId && s.campaignId !== w.campaignId) return false;
      if (w.status) {
        if (typeof w.status === "string" && s.status !== w.status) return false;
        if (w.status.in && !w.status.in.includes(s.status)) return false;
      }
      if (w.sentAt?.gt && (!s.sentAt || s.sentAt <= w.sentAt.gt)) return false;
      return true;
    }).length;
  }) as any);

  vi.spyOn(prisma.send, "findFirst").mockImplementation((async (args: any) => {
    const w = args?.where ?? {};
    const filtered = sends.filter((s) => {
      if (w.campaignId) {
        if (typeof w.campaignId === "string" && s.campaignId !== w.campaignId) return false;
        if (w.campaignId.in && !w.campaignId.in.includes(s.campaignId)) return false;
      }
      if (w.status && s.status !== w.status) return false;
      if (w.email && s.email !== w.email) return false;
      if (w.sentAt?.not === null && s.sentAt === null) return false;
      if (w.repliedAt?.not === null && s.repliedAt === null) return false;
      if (w.OR) {
        const matchesOr = w.OR.some((clause: any) => {
          if (clause.mailboxId && s.mailboxId === clause.mailboxId) return true;
          if (clause.campaignId?.in && clause.campaignId.in.includes(s.campaignId)) return true;
          return false;
        });
        if (!matchesOr) return false;
      }
      return true;
    });
    if (args?.orderBy?.sentAt === "desc") {
      filtered.sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0));
    }
    return filtered[0] ?? null;
  }) as any);

  vi.spyOn(prisma.send, "groupBy").mockImplementation((async (args: any) => {
    const w = args?.where ?? {};
    const filtered = sends.filter((s) => {
      if (w.campaignId?.in && !w.campaignId.in.includes(s.campaignId)) return false;
      if (w.status) {
        if (typeof w.status === "string" && s.status !== w.status) return false;
        if (w.status.in && !w.status.in.includes(s.status)) return false;
      }
      if (w.sentAt?.gt && (!s.sentAt || s.sentAt <= w.sentAt.gt)) return false;
      if (w.OR) {
        const dueOk = w.OR.some((o: any) => (o.scheduledFor === null && s.scheduledFor === null) || (o.scheduledFor?.lte && s.scheduledFor && s.scheduledFor <= o.scheduledFor.lte));
        if (!dueOk) return false;
      }
      if (w.AND) {
        const approvedOk = s.approvedAt !== null || campaigns.find((c) => c.id === s.campaignId)?.automationMode === "AUTOMATIC";
        if (!approvedOk) return false;
      }
      return true;
    });

    const groups = new Map<string, any>();
    const by: string[] = args.by ?? [];
    for (const s of filtered) {
      const key = by.map((k) => String((s as any)[k] ?? "null")).join("|");
      if (!groups.has(key)) {
        const obj: any = { _count: { _all: 0 } };
        for (const k of by) obj[k] = (s as any)[k];
        groups.set(key, obj);
      }
      groups.get(key)._count._all++;
    }
    return Array.from(groups.values());
  }) as any);

  vi.spyOn(prisma.send, "update").mockImplementation((async (args: any) => {
    const row = sends.find((s) => s.id === args.where.id);
    if (!row) throw new Error("Send not found");
    const d = args.data;
    for (const [k, v] of Object.entries(d)) {
      if (v && typeof v === "object" && "decrement" in (v as any)) {
        (row as any)[k] -= (v as any).decrement;
      } else {
        (row as any)[k] = v;
      }
    }
    // Use controlled clock for sentAt so rolling 24h expiry tests are deterministic
    if (d.status === "SENT") {
      row.sentAt = new Date(currentNow);
    }
    row.updatedAt = new Date(currentNow);
    return row;
  }) as any);

  vi.spyOn(prisma.send, "updateMany").mockImplementation((async (args: any) => {
    let count = 0;
    for (const s of sends) {
      if (args.where?.status && s.status !== args.where.status) continue;
      if (args.where?.claimedAt?.lt && (!s.claimedAt || s.claimedAt >= args.where.claimedAt.lt)) continue;
      Object.assign(s, args.data);
      count++;
    }
    return { count };
  }) as any);

  vi.spyOn(prisma, "$queryRaw").mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    if (sql.includes("UPDATE sends")) {
      const campaignId = values[0] as string;
      const next = sends.find(
        (s) =>
          s.campaignId === campaignId &&
          s.status === "PENDING" &&
          (s.approvedAt !== null || campaigns.find((c) => c.id === campaignId)?.automationMode === "AUTOMATIC") &&
          (s.scheduledFor === null || s.scheduledFor.getTime() <= currentNow)
      );
      if (!next) return [];
      next.status = "CLAIMED";
      next.claimedAt = new Date(currentNow);
      next.attempts += 1;
      next.updatedAt = new Date(currentNow);
      return [next];
    }
    if (sql.includes("INSERT INTO settings")) {
      const key = values[1] as string;
      const val = JSON.parse(values[2] as string) as { owner: string; until: number };
      const nowParam = values[3] as number;
      const existing = leases.get(key);
      if (existing && existing.until >= nowParam) return [];
      leases.set(key, val);
      return [{ key }];
    }
    return [];
  }) as any);

  vi.spyOn(prisma, "$executeRaw").mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(" ");
    if (sql.includes("DELETE FROM settings")) {
      const key = values[0] as string;
      const owner = values[1] as string;
      const existing = leases.get(key);
      if (existing && existing.owner === owner) {
        leases.delete(key);
        return 1;
      }
    }
    return 0;
  }) as any);

  return {
    mailboxes,
    campaigns,
    sends,
    leases,
    sentMessages,
    getNow: () => currentNow,
    advanceTime: (ms: number) => {
      currentNow += ms;
    },
    addMailbox(id: string, email: string, fromName = "Sender") {
      mailboxes.push({ id, email, fromName, encryptedPassword: "enc", lastVerifiedAt: new Date(currentNow) });
    },
    addCampaign(
      id: string,
      mailboxId: string,
      options: Partial<(typeof campaigns)[0]> = {}
    ) {
      const mb = mailboxes.find((m) => m.id === mailboxId);
      campaigns.push({
        id,
        name: `Campaign ${id}`,
        status: "SENDING",
        fromName: mb?.fromName ?? "Sender",
        fromEmail: mb?.email ?? null,
        replyTo: null,
        mailboxId,
        sendRatePerMinute: 10,
        automationMode: "APPROVAL_REQUIRED",
        createdById: null,
        startedAt: new Date(currentNow),
        completedAt: null,
        ...options,
      });
    },
    addPendingSend(id: string, campaignId: string, email: string, options: Partial<(typeof sends)[0]> = {}) {
      sends.push({
        id,
        campaignId,
        email,
        subject: "Hello",
        html: "<p>Hi</p>",
        text: "Hi",
        messageId: `<${id}@focusrealm.org>`,
        status: "PENDING",
        attempts: 0,
        stepIndex: 0,
        approvedAt: new Date(currentNow - 1000),
        scheduledFor: null,
        claimedAt: null,
        sentAt: null,
        repliedAt: null,
        lastError: null,
        skipReason: null,
        mailboxId: null,
        sentByUserId: null,
        inReplyToId: null,
        attachments: [],
        createdAt: new Date(currentNow),
        updatedAt: new Date(currentNow),
        ...options,
      });
    },
    addHistoricalSent(count: number, campaignId: string, mailboxId: string, sentAtMs: number) {
      for (let i = 0; i < count; i++) {
        const id = `hist-${mailboxId}-${sentAtMs}-${i}`;
        sends.push({
          id,
          campaignId,
          email: `hist-${i}@example.com`,
          subject: "Hello",
          html: "<p>Hi</p>",
          text: "Hi",
          messageId: `<${id}@focusrealm.org>`,
          status: "SENT",
          attempts: 1,
          stepIndex: 0,
          approvedAt: new Date(sentAtMs),
          scheduledFor: null,
          claimedAt: new Date(sentAtMs),
          sentAt: new Date(sentAtMs),
          repliedAt: null,
          lastError: null,
          skipReason: null,
          mailboxId,
          sentByUserId: null,
          inReplyToId: null,
          attachments: [],
          createdAt: new Date(sentAtMs),
          updatedAt: new Date(sentAtMs),
        });
      }
    },
  };
}

describe("Multi-Mailbox Worker, Per-Mailbox Budgets & Vercel Wake-up Architecture", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(config, "liveSendingBlocker").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Per-Mailbox 300/24h Safety Limits", () => {
    it("stops Mailbox A at 300 while Mailbox B at 100 continues uninterrupted, and does not mark A completed", async () => {
      const store = setupInMemoryStore(new Date("2026-11-25T12:00:00Z").getTime());
      store.addMailbox("mb-a", "founderoffice@focusrealm.org", "Founder Office");
      store.addMailbox("mb-b", "founder@focusrealm.org", "Founder");

      store.addCampaign("camp-a", "mb-a", { sendRatePerMinute: 10 });
      store.addCampaign("camp-b", "mb-b", { sendRatePerMinute: 10 });

      // Mailbox A has 300 sent in last 24h; Mailbox B has 100 sent in last 24h
      store.addHistoricalSent(300, "camp-a", "mb-a", store.getNow() - 60 * 60_000);
      store.addHistoricalSent(100, "camp-b", "mb-b", store.getNow() - 60 * 60_000);

      store.addPendingSend("send-a-1", "camp-a", "prospect-a@hotel.com");
      store.addPendingSend("send-b-1", "camp-b", "prospect-b@hotel.com");

      const worker = new SendWorker({ dailyLimitPerMailbox: 300, mailboxMaxRatePerMinute: 10, now: store.getNow });

      // Tick 1: skips exhausted Mailbox A, dispatches Mailbox B
      expect(await worker.tick()).toBe("worked");
      expect(store.sentMessages).toEqual([{ to: "prospect-b@hotel.com", fromEmail: "founder@focusrealm.org" }]);

      // Campaign A remains PENDING and SENDING (NOT completed!)
      expect(store.sends.find((s) => s.id === "send-a-1")?.status).toBe("PENDING");
      expect(store.campaigns.find((c) => c.id === "camp-a")?.status).toBe("SENDING");

      // Tick 2: Mailbox B is now idle (0 pending), Mailbox A is at 300 limit -> returns "limit"
      expect(await worker.tick()).toBe("limit");
      expect(store.campaigns.find((c) => c.id === "camp-a")?.status).toBe("SENDING");
    });

    it("automatically resumes Mailbox A when older sends leave the rolling 24h window", async () => {
      const store = setupInMemoryStore(new Date("2026-11-25T12:00:00Z").getTime());
      store.addMailbox("mb-a", "founderoffice@focusrealm.org", "Founder Office");
      store.addCampaign("camp-a", "mb-a", { sendRatePerMinute: 10 });

      // 300 sends sent 23h 50m ago
      store.addHistoricalSent(300, "camp-a", "mb-a", store.getNow() - (23 * 60 + 50) * 60_000);
      store.addPendingSend("send-a-next", "camp-a", "resume@hotel.com");

      const worker = new SendWorker({ dailyLimitPerMailbox: 300, mailboxMaxRatePerMinute: 10, now: store.getNow });

      // Blocked at 300/300
      expect(await worker.tick()).toBe("limit");
      expect(store.sentMessages).toHaveLength(0);

      // Advance time 11 minutes so the 23h50m batch rolls out of the 24h window
      store.advanceTime(11 * 60_000);

      // Now budget is free -> resumes automatically!
      expect(await worker.tick()).toBe("worked");
      expect(store.sentMessages.map((m) => m.to)).toEqual(["resume@hotel.com"]);
    });

    it("calculates waitingReason per campaign mailbox independently", async () => {
      const store = setupInMemoryStore(new Date("2026-11-25T12:00:00Z").getTime());
      store.addMailbox("mb-a", "founderoffice@focusrealm.org", "Founder Office");
      store.addMailbox("mb-b", "founder@focusrealm.org", "Founder");
      store.addCampaign("camp-a", "mb-a");
      store.addCampaign("camp-b", "mb-b");
      store.addHistoricalSent(300, "camp-a", "mb-a", store.getNow() - 60_000);
      store.addHistoricalSent(50, "camp-b", "mb-b", store.getNow() - 60_000);

      const budgetA = await sentInLast24hForCampaign(store.campaigns[0]!, 300);
      const budgetB = await sentInLast24hForCampaign(store.campaigns[1]!, 300);
      expect(budgetA.sentLast24h).toBe(300);
      expect(budgetA.remainingBudget).toBe(0);
      expect(budgetB.sentLast24h).toBe(50);
      expect(budgetB.remainingBudget).toBe(250);
    });
  });

  describe("2. Coordinated Multi-Campaign & Multi-Mailbox Rate Pacing", () => {
    it("prevents two campaigns on the same mailbox from doubling the mailbox rate (caps at 10/min)", async () => {
      const store = setupInMemoryStore(new Date("2026-11-25T12:00:00Z").getTime());
      store.addMailbox("mb-a", "founderoffice@focusrealm.org", "Founder Office");
      // Even if campaigns ask for 20/min or 10/min, mailbox cap of 10/min enforces 6,000ms interval
      store.addCampaign("camp-1", "mb-a", { sendRatePerMinute: 20 });
      store.addCampaign("camp-2", "mb-a", { sendRatePerMinute: 10 });

      store.addPendingSend("s1", "camp-1", "c1@hotel.com");
      store.addPendingSend("s2", "camp-2", "c2@hotel.com");
      store.addPendingSend("s3", "camp-1", "c3@hotel.com");

      const worker = new SendWorker({ dailyLimitPerMailbox: 300, mailboxMaxRatePerMinute: 10, now: store.getNow });

      // t = 0: Campaign 1 sends
      expect(await worker.tick()).toBe("worked");
      expect(store.sentMessages.map((m) => m.to)).toEqual(["c1@hotel.com"]);

      // t = +2000ms: Campaign 2 has NOT sent yet, but Mailbox A is locked for 6,000ms -> waiting!
      store.advanceTime(2000);
      expect(await worker.tick()).toBe("waiting");
      expect(store.sentMessages).toHaveLength(1);

      // t = +6000ms: Mailbox A pacing ready -> round-robin rotates fairly to Campaign 2!
      store.advanceTime(4000);
      expect(await worker.tick()).toBe("worked");
      expect(store.sentMessages.map((m) => m.to)).toEqual(["c1@hotel.com", "c2@hotel.com"]);

      // t = +12000ms: Campaign 1 sends next
      store.advanceTime(6000);
      expect(await worker.tick()).toBe("worked");
      expect(store.sentMessages.map((m) => m.to)).toEqual(["c1@hotel.com", "c2@hotel.com", "c3@hotel.com"]);
    });

    it("two campaigns on the same mailbox share the 300/24h budget and stop together at 300", async () => {
      const store = setupInMemoryStore(new Date("2026-11-25T12:00:00Z").getTime());
      store.addMailbox("mb-a", "founderoffice@focusrealm.org", "Founder Office");
      store.addCampaign("camp-1", "mb-a", { sendRatePerMinute: 10 });
      store.addCampaign("camp-2", "mb-a", { sendRatePerMinute: 10 });

      store.addHistoricalSent(299, "camp-1", "mb-a", store.getNow() - 60 * 60_000);
      store.addPendingSend("s1", "camp-1", "one@hotel.com");
      store.addPendingSend("s2", "camp-2", "two@hotel.com");

      const worker = new SendWorker({ dailyLimitPerMailbox: 300, mailboxMaxRatePerMinute: 10, now: store.getNow });

      // Sends the 300th email (under camp-1)
      expect(await worker.tick()).toBe("worked");
      expect(store.sentMessages).toHaveLength(1);

      // Even after waiting past the rate interval, camp-2 sees the shared 300/300 limit and stops
      store.advanceTime(10_000);
      expect(await worker.tick()).toBe("limit");
      expect(store.sentMessages).toHaveLength(1);
    });

    it("operates independent mailboxes in parallel without one mailbox pacing blocking the other", async () => {
      const store = setupInMemoryStore(new Date("2026-11-25T12:00:00Z").getTime());
      store.addMailbox("mb-a", "a@focusrealm.org", "Mailbox A");
      store.addMailbox("mb-b", "b@focusrealm.org", "Mailbox B");
      store.addCampaign("camp-a", "mb-a", { sendRatePerMinute: 10 });
      store.addCampaign("camp-b", "mb-b", { sendRatePerMinute: 10 });

      store.addPendingSend("sa-1", "camp-a", "a1@hotel.com");
      store.addPendingSend("sa-2", "camp-a", "a2@hotel.com");
      store.addPendingSend("sb-1", "camp-b", "b1@hotel.com");

      const worker = new SendWorker({ dailyLimitPerMailbox: 300, mailboxMaxRatePerMinute: 10, now: store.getNow });

      // t = 0: Mailbox A sends
      expect(await worker.tick()).toBe("worked");
      // t = +100ms: Mailbox A is pacing, Mailbox B is immediately eligible and sends!
      store.advanceTime(100);
      expect(await worker.tick()).toBe("worked");

      expect(store.sentMessages.map((m) => m.to)).toEqual(["a1@hotel.com", "b1@hotel.com"]);
    });

    it("skips PAUSED and COMPLETED campaigns cleanly and never restarts a completed campaign", async () => {
      const store = setupInMemoryStore(new Date("2026-11-25T12:00:00Z").getTime());
      store.addMailbox("mb-a", "a@focusrealm.org", "Mailbox A");
      store.addCampaign("camp-paused", "mb-a", { status: "PAUSED" });
      store.addCampaign("camp-done", "mb-a", { status: "COMPLETED" });
      store.addPendingSend("sp-1", "camp-paused", "paused@hotel.com");

      const worker = new SendWorker({ dailyLimitPerMailbox: 300, mailboxMaxRatePerMinute: 10, now: store.getNow });
      expect(await worker.tick()).toBe("idle");
      expect(store.sentMessages).toHaveLength(0);
      expect(store.campaigns.find((c) => c.id === "camp-paused")?.status).toBe("PAUSED");
      expect(store.campaigns.find((c) => c.id === "camp-done")?.status).toBe("COMPLETED");
    });
  });

  describe("3. Serverless Wake-up Ticks, Lease Safety & No Recursion", () => {
    it("processes work under global sender lease, prevents concurrent ticks, releases lease, and never self-fetches", async () => {
      const store = setupInMemoryStore(Date.now());
      store.addMailbox("mb-a", "founderoffice@focusrealm.org", "Founder Office");
      store.addCampaign("camp-a", "mb-a", { sendRatePerMinute: 10 });
      store.addPendingSend("s-1", "camp-a", "one@hotel.com");

      const fetchSpy = vi.spyOn(globalThis, "fetch");

      // Hold the global sender lease manually to simulate an active Tick A
      const heldOwner = await acquireLease("sender", 60_000);
      expect(heldOwner).toBeTruthy();

      // Concurrent Tick B cannot acquire lease and returns safely without sending
      const concurrent = await runSenderCycle(5_000);
      expect(concurrent.ran).toBe(false);
      expect(concurrent.reason).toMatch(/already running/i);
      expect(store.sentMessages).toHaveLength(0);

      // Release Tick A lease
      await releaseLease("sender", heldOwner!);

      // Tick executes bounded cycle, sends 1 email, completes, returns per-mailbox stats
      const result = await runSenderCycle(10_000);
      expect(result.ran).toBe(true);
      expect(result.totalSent).toBe(1);
      expect(result.stoppedBecause).toBe("idle");
      expect(result.mailboxes).toEqual([
        expect.objectContaining({
          mailboxId: "mb-a",
          email: "founderoffice@focusrealm.org",
          sent: 1,
          sentLast24h: 1,
          dailyLimit: 300,
          remainingBudget: 299,
          limitReached: false,
        }),
      ]);
      // Lease released cleanly
      expect(store.leases.size).toBe(0);
      // Never recursively calls /api/internal/tick
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("exits gracefully before execution timeout when next pacing interval exceeds remaining budget, and second tick continues", async () => {
      const store = setupInMemoryStore(Date.now());
      store.addMailbox("mb-a", "founderoffice@focusrealm.org", "Founder Office");
      store.addCampaign("camp-a", "mb-a", { sendRatePerMinute: 10 }); // 6,000ms interval
      store.addPendingSend("s-1", "camp-a", "first@hotel.com");
      store.addPendingSend("s-2", "camp-a", "second@hotel.com");

      // Budget of only 1,500ms: sends s-1 immediately, sees s-2 needs 6,000ms (> 1,500ms budget), stops gracefully!
      const tick1 = await runSenderCycle(1_500);
      expect(tick1.ran).toBe(true);
      expect(tick1.totalSent).toBe(1);
      expect(tick1.stoppedBecause).toBe("budget");
      expect(store.sentMessages.map((m) => m.to)).toEqual(["first@hotel.com"]);
      expect(store.sends.find((s) => s.id === "s-2")?.status).toBe("PENDING");

      // Simulate external scheduler waking 15 minutes later -> second tick picks up s-2 seamlessly
      const s1 = store.sends.find((s) => s.id === "s-1")!;
      s1.sentAt = new Date(Date.now() - 15 * 60_000);

      const tick2 = await runSenderCycle(5_000);
      expect(tick2.ran).toBe(true);
      expect(tick2.totalSent).toBe(1);
      expect(tick2.stoppedBecause).toBe("idle");
      expect(store.sentMessages.map((m) => m.to)).toEqual(["first@hotel.com", "second@hotel.com"]);
      expect(store.campaigns[0]?.status).toBe("COMPLETED");
    });

    it("authenticates POST /api/internal/tick via CRON_SECRET and returns per-mailbox stats", async () => {
      const store = setupInMemoryStore(Date.now());
      store.addMailbox("mb-a", "founderoffice@focusrealm.org", "Founder Office");
      store.addCampaign("camp-a", "mb-a", { sendRatePerMinute: 10 });
      store.addPendingSend("s-1", "camp-a", "tick-test@hotel.com");

      vi.spyOn(config, "isServerless", "get").mockReturnValue(true);
      const prevCron = config.env.CRON_SECRET;
      (config.env as any).CRON_SECRET = "test-cron-secret-123";

      const app = express();
      app.use("/api/internal", internalRouter);
      app.use(errorHandler);
      const server = app.listen(0);
      const port = (server.address() as AddressInfo).port;

      try {
        const unauth = await fetch(`http://127.0.0.1:${port}/api/internal/tick`, { method: "POST" });
        expect(unauth.status).toBe(401);

        const okRes = await fetch(`http://127.0.0.1:${port}/api/internal/tick`, {
          method: "POST",
          headers: { Authorization: "Bearer test-cron-secret-123" },
        });
        expect(okRes.status).toBe(200);
        const body = (await okRes.json()) as any;
        expect(body.success).toBe(true);
        expect(body.data.ran).toBe(true);
        expect(body.data.totalSent).toBe(1);
        expect(body.data.mailboxes[0]).toMatchObject({
          email: "founderoffice@focusrealm.org",
          sent: 1,
          remainingBudget: 299,
        });
      } finally {
        (config.env as any).CRON_SECRET = prevCron;
        server.close();
      }
    });
  });

  describe("4. Mailbox IMAP Identity & Follow-up Safeguards", () => {
    it("resolves imap.state.<mailboxId> for follow-ups even when campaign createdById differs from mailboxId", async () => {
      const store = setupInMemoryStore(Date.now());
      store.addMailbox("mb-founderoffice", "founderoffice@focusrealm.org", "Frank Lopes");
      store.addCampaign("camp-fu", "mb-founderoffice", {
        sendRatePerMinute: 10,
        createdById: "user-frank",
      });
      store.addPendingSend("fu-step1", "camp-fu", "lead1@hotel.com", { stepIndex: 1 });
      store.addPendingSend("fu-step2", "camp-fu", "lead2@hotel.com", { stepIndex: 2 });

      const prevPoll = config.env.IMAP_POLL_ENABLED;
      (config.env as any).IMAP_POLL_ENABLED = true;

      try {
        // Store IMAP state under canonical mailboxId (not user-frank)
        vi.spyOn(prisma.setting, "findUnique").mockImplementation((async (args: any) => {
          if (args?.where?.key === "imap.state.mb-founderoffice") {
            return {
              id: "s-mb",
              key: "imap.state.mb-founderoffice",
              value: { lastCheckedAt: new Date(store.getNow()).toISOString(), lastError: null },
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          }
          return null;
        }) as any);

        // Verify isInboxMonitoringSafe checks mailboxId directly
        const health = await inboxMonitor.isInboxMonitoringSafe("mb-founderoffice");
        expect(health).toEqual({ safe: true });

        // Ensure follow-up safeguard queries return no reply/suppression/bounce
        vi.spyOn(prisma.campaignRecipientState, "findUnique").mockResolvedValue({ state: "FOLLOW_UP_SCHEDULED" } as any);

        const worker = new SendWorker({ dailyLimitPerMailbox: 300, mailboxMaxRatePerMinute: 10, now: store.getNow });
        expect(await worker.tick()).toBe("worked");
        store.advanceTime(6_500);
        expect(await worker.tick()).toBe("worked");

        expect(store.sentMessages.map((m) => m.to)).toEqual(["lead1@hotel.com", "lead2@hotel.com"]);
        expect(store.sends.find((s) => s.id === "fu-step1")?.status).toBe("SENT");
        expect(store.sends.find((s) => s.id === "fu-step2")?.status).toBe("SENT");
      } finally {
        (config.env as any).IMAP_POLL_ENABLED = prevPoll;
      }
    });

    it("cancels follow-ups when a prior reply exists, and skips suppressed or bounced recipients", async () => {
      const store = setupInMemoryStore(Date.now());
      store.addMailbox("mb-a", "a@focusrealm.org", "Mailbox A");
      store.addCampaign("camp-a", "mb-a", { sendRatePerMinute: 10, createdById: "user-1" });

      // Lead 1 replied on step 0 -> step 1 must be cancelled
      store.addPendingSend("prior-reply-0", "camp-a", "replied@hotel.com", {
        status: "SENT",
        stepIndex: 0,
        sentAt: new Date(store.getNow() - 86_400_000),
        repliedAt: new Date(store.getNow() - 3_600_000),
      });
      store.addPendingSend("s-replied", "camp-a", "replied@hotel.com", { stepIndex: 1 });
      // Lead 2 is suppressed -> must be skipped
      store.addPendingSend("s-suppressed", "camp-a", "suppressed@hotel.com", { stepIndex: 0 });
      // Lead 3 bounced on prior step -> step 1 must be cancelled
      store.addPendingSend("s-bounced", "camp-a", "bounced@hotel.com", { stepIndex: 1 });

      const prevPoll = config.env.IMAP_POLL_ENABLED;
      (config.env as any).IMAP_POLL_ENABLED = true;

      try {
        vi.spyOn(prisma.setting, "findUnique").mockResolvedValue({
          id: "s-mb",
          key: "imap.state.mb-a",
          value: { lastCheckedAt: new Date(store.getNow()).toISOString(), lastError: null },
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);

        vi.spyOn(prisma.suppressionEntry, "findUnique").mockImplementation((async (args: any) => {
          if (args?.where?.email === "suppressed@hotel.com") {
            return { id: "sup-1", email: "suppressed@hotel.com", expiresAt: null };
          }
          return null;
        }) as any);

        vi.spyOn(prisma.campaignRecipientState, "findUnique").mockImplementation((async (args: any) => {
          const email = args?.where?.campaignId_email?.email;
          if (email === "bounced@hotel.com") return { state: "BOUNCED" };
          return { state: "FOLLOW_UP_SCHEDULED" };
        }) as any);

        const worker = new SendWorker({ dailyLimitPerMailbox: 300, mailboxMaxRatePerMinute: 10, now: store.getNow });
        await worker.tick();
        await worker.tick();
        await worker.tick();

        expect(store.sentMessages).toHaveLength(0);
        expect(store.sends.find((s) => s.id === "s-replied")?.status).toBe("CANCELLED");
        expect(store.sends.find((s) => s.id === "s-suppressed")?.status).toBe("SKIPPED");
        expect(store.sends.find((s) => s.id === "s-bounced")?.status).toBe("CANCELLED");
      } finally {
        (config.env as any).IMAP_POLL_ENABLED = prevPoll;
      }
    });
  });
});
