// Sending worker. The database is the queue:
// - one message at a time, claimed atomically (FOR UPDATE SKIP LOCKED), so nothing is sent twice
// - paced by each campaign's per-minute rate and the mailbox-wide rolling 24h limit
// - suppression re-checked right before handoff
// - messages left mid-handoff become UNKNOWN for a person to resolve (never auto-resent)
// Runs either as a long-lived loop (self-hosted: start/stop) or in bounded bursts (serverless: runFor).
import crypto from "crypto";
import prisma from "../db.js";
import { env, liveSendingBlocker } from "../config.js";
import { getTransport } from "./mailer.js";
import { classifySmtpError } from "./smtp-outcome.js";
import { unsubscribeHeaders, unsubscribeUrl } from "./unsubscribe.js";
import { pauseCampaign } from "./campaign-service.js";

const IDLE_DELAY_MS = 3000;

interface ClaimedSend {
  id: string;
  campaignId: string;
  email: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
}

export async function sentInLast24h(): Promise<number> {
  return prisma.send.count({ where: { status: "SENT", sentAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });
}

/**
 * Marks interrupted handoffs as UNKNOWN.
 * Self-hosted (single process) calls this at boot with olderThanMs = 0. Serverless passes a
 * threshold longer than any function can run, so another instance's in-flight send is untouched.
 */
export async function recoverInterruptedSends(olderThanMs = 0): Promise<number> {
  const { count } = await prisma.send.updateMany({
    where: { status: "CLAIMED", ...(olderThanMs ? { claimedAt: { lt: new Date(Date.now() - olderThanMs) } } : {}) },
    data: { status: "UNKNOWN", lastError: "Sending was interrupted while this message was being handed to the mailbox. It may or may not have been delivered." },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Lease: at most one sender at a time across instances (settings row with an expiry)
// ---------------------------------------------------------------------------

export async function acquireLease(name: string, ttlMs: number): Promise<string | null> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  const value = JSON.stringify({ owner, until: now + ttlMs });
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    INSERT INTO settings (id, key, value, "updatedAt")
    VALUES (${crypto.randomUUID()}, ${`lease:${name}`}, ${value}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()
      WHERE (settings.value->>'until')::bigint < ${now}
    RETURNING key`;
  return rows.length ? owner : null;
}

export async function releaseLease(name: string, owner: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM settings WHERE key = ${`lease:${name}`} AND value->>'owner' = ${owner}`;
}

/** True if any sending campaign still has queued messages */
export async function hasQueuedWork(): Promise<boolean> {
  const next = await prisma.send.findFirst({ where: { status: "PENDING", campaign: { status: "SENDING" } }, select: { id: true } });
  return Boolean(next);
}

async function claimNext(campaignId: string): Promise<ClaimedSend | null> {
  const rows = await prisma.$queryRaw<ClaimedSend[]>`
    UPDATE sends
       SET status = 'CLAIMED', "claimedAt" = now(), attempts = attempts + 1, "updatedAt" = now()
     WHERE id = (
       SELECT id FROM sends
        WHERE "campaignId" = ${campaignId} AND status = 'PENDING'
        ORDER BY "createdAt", id
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
    RETURNING id, "campaignId", email, subject, html, text, "messageId"`;
  return rows[0] ?? null;
}

async function finishIfDone(campaignId: string) {
  const remaining = await prisma.send.count({ where: { campaignId, status: { in: ["PENDING", "CLAIMED"] } } });
  if (remaining === 0) {
    await prisma.campaign.updateMany({ where: { id: campaignId, status: "SENDING" }, data: { status: "COMPLETED", completedAt: new Date() } });
  }
}

/** Sends one message for the campaign if possible. Returns true if it did any work. */
export async function sendOne(campaign: { id: string; fromName: string; replyTo: string | null }): Promise<boolean> {
  const send = await claimNext(campaign.id);
  if (!send) {
    await finishIfDone(campaign.id);
    return false;
  }

  // Re-check the campaign and the suppression list at the last moment
  const [current, suppression] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: campaign.id }, select: { status: true } }),
    prisma.suppressionEntry.findUnique({ where: { email: send.email } }),
  ]);
  if (current?.status !== "SENDING") {
    await prisma.send.update({ where: { id: send.id }, data: { status: current?.status === "CANCELLED" ? "CANCELLED" : "PENDING", attempts: { decrement: 1 } } });
    return true;
  }
  if (suppression && (!suppression.expiresAt || suppression.expiresAt > new Date())) {
    await prisma.send.update({ where: { id: send.id }, data: { status: "SKIPPED", skipReason: "Suppressed after approval" } });
    return true;
  }

  const url = unsubscribeUrl(send.id);
  try {
    await getTransport().send({
      to: send.email,
      subject: send.subject,
      html: send.html,
      text: send.text,
      messageId: send.messageId,
      fromName: campaign.fromName,
      replyTo: campaign.replyTo,
      headers: { ...unsubscribeHeaders(url), "X-FR-Send-ID": send.id },
    });
  } catch (err) {
    const outcome = classifySmtpError(err);
    switch (outcome.kind) {
      case "rejected":
        await prisma.send.update({
          where: { id: send.id },
          data: { status: "FAILED", lastError: `Rejected: ${outcome.message}`, ...(outcome.badAddress ? { bouncedAt: new Date() } : {}) },
        });
        if (outcome.badAddress) {
          await prisma.suppressionEntry.upsert({
            where: { email: send.email },
            update: {},
            create: { email: send.email, reason: "HARD_BOUNCE", source: "smtp-rejection", campaignId: campaign.id, metadata: { message: outcome.message } },
          });
          await prisma.sendEvent.create({ data: { sendId: send.id, type: "HARD_BOUNCE", occurredAt: new Date(), detail: { diagnostic: outcome.message, via: "smtp" } } });
        }
        break;
      case "temporary":
        await prisma.send.update({ where: { id: send.id }, data: { status: "FAILED", lastError: `Temporarily refused: ${outcome.message}` } });
        break;
      case "not_sent":
        // Nothing left our side: put it back and stop the campaign so a person can fix the mailbox
        await prisma.send.update({ where: { id: send.id }, data: { status: "PENDING", attempts: { decrement: 1 }, lastError: outcome.message } });
        await pauseCampaign(null, campaign.id, outcome.authFailure ? "Couldn't sign in to the mailbox. Check the SMTP password, then resume." : `Couldn't reach the mailbox: ${outcome.message}`).catch(() => undefined);
        break;
      case "unknown":
        await prisma.send.update({ where: { id: send.id }, data: { status: "UNKNOWN", lastError: `Interrupted: ${outcome.message}` } });
        break;
    }
    await finishIfDone(campaign.id);
    return true;
  }

  // Outside the catch: if this write fails the row stays CLAIMED -> UNKNOWN on next boot, never resent
  await prisma.send.update({ where: { id: send.id }, data: { status: "SENT", sentAt: new Date(), lastError: null } });
  await finishIfDone(campaign.id);
  return true;
}

export class SendWorker {
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly lastSentAt = new Map<string, number>();
  private wakeResolve: (() => void) | null = null;

  start() {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop() {
    this.running = false;
    this.wake();
    await this.loop;
  }

  wake() {
    if (this.wakeResolve) {
      const res = this.wakeResolve;
      this.wakeResolve = null;
      res();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      this.wakeResolve = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, ms);
    });
  }

  private async run() {
    while (this.running) {
      let delay = 15_000;
      try {
        const result = await this.tick();
        delay = result === "worked" ? 0 : result === "waiting" ? 250 : result === "limit" ? 30_000 : 15_000;
      } catch (err) {
        console.error("[worker] tick failed:", (err as Error).message);
      }
      if (delay && this.running) await this.sleep(delay);
    }
  }

  /**
   * Serverless mode: send for up to budgetMs, then return. Stops early when there is nothing
   * to send or the daily limit is reached. Callers must hold the "sender" lease.
   */
  async runFor(budgetMs: number): Promise<{ handled: number; stoppedBecause: "budget" | "idle" | "limit" }> {
    const deadline = Date.now() + budgetMs;
    let handled = 0;
    while (Date.now() < deadline) {
      const result = await this.tick();
      if (result === "worked") handled++;
      else if (result === "idle" || result === "limit") return { handled, stoppedBecause: result };
      else await new Promise((r) => setTimeout(r, 250));
    }
    return { handled, stoppedBecause: "budget" };
  }

  /** Last send time for pacing; seeded from the database so a fresh instance keeps the pace */
  private async lastSent(campaignId: string): Promise<number> {
    const cached = this.lastSentAt.get(campaignId);
    if (cached !== undefined) return cached;
    const last = await prisma.send.findFirst({ where: { campaignId, sentAt: { not: null } }, orderBy: { sentAt: "desc" }, select: { sentAt: true } });
    const at = last?.sentAt?.getTime() ?? 0;
    this.lastSentAt.set(campaignId, at);
    return at;
  }

  /**
   * One scheduling pass: sends at most one message across the campaigns that are due.
   * worked = sent/handled a message; waiting = campaigns exist but none due yet (rate);
   * limit = daily cap reached; idle = nothing to do.
   */
  async tick(): Promise<"worked" | "waiting" | "limit" | "idle"> {
    const campaigns = await prisma.campaign.findMany({
      where: { status: "SENDING" },
      select: { id: true, fromName: true, replyTo: true, sendRatePerMinute: true },
      orderBy: { startedAt: "asc" },
    });
    if (!campaigns.length) return "idle";

    const blocker = liveSendingBlocker();
    if (blocker) {
      for (const c of campaigns) await pauseCampaign(null, c.id, blocker).catch(() => undefined);
      return "idle";
    }
    if ((await sentInLast24h()) >= env.DAILY_SEND_LIMIT) return "limit"; // waits; shown in the UI

    const now = Date.now();
    let anyWaiting = false;
    for (const c of campaigns) {
      const interval = 60_000 / c.sendRatePerMinute;
      if (now - (await this.lastSent(c.id)) < interval) {
        anyWaiting = true;
        continue;
      }
      this.lastSentAt.set(c.id, now);
      if (await sendOne(c)) return "worked";
    }
    return anyWaiting ? "waiting" : "idle";
  }
}
