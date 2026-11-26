// Sending worker. The database is the queue:
// - one message at a time, claimed atomically (FOR UPDATE SKIP LOCKED), so nothing is sent twice
// - global sender lease prevents concurrent workers across serverless ticks
// - per-mailbox rolling 24h budget (default 300/mailbox) and per-mailbox pacing (default 10/min)
// - fair round-robin scheduling across eligible mailboxes and campaigns sharing a mailbox
// - suppression re-checked right before handoff
// - messages left mid-handoff become UNKNOWN for a person to resolve (never auto-resent)
// Runs either as a long-lived loop (self-hosted: start/stop) or in bounded cycles (serverless: runFor).
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { env, liveSendingBlocker } from "../config.js";
import { AppError } from "../middleware/error-handler.js";
import type { MailboxBudgetUsageDto } from "../../shared/types.js";
import { getTransport } from "./mailer.js";
import { classifySmtpError } from "./smtp-outcome.js";
import { unsubscribeHeaders, unsubscribeUrl } from "./unsubscribe.js";
import { pauseCampaign } from "./campaign-service.js";
import { isInboxMonitoringSafe } from "./inbox-monitor.js";
import { onStepSent } from "./sequence-service.js";
import {
  getMailboxCredentials,
  getMailboxCredentialsByEmail,
  getPersonalMailboxCredentials,
} from "./personal-mailbox.js";
import { downloadTemplateAttachment, storedAttachments } from "./template-storage.js";

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

interface ClaimedSend {
  id: string;
  campaignId: string;
  email: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
  stepIndex: number;
  inReplyToId: string | null;
  attachments: unknown;
}

export interface MailboxIdentity {
  key: string;
  mailboxId: string | null;
  email: string;
  fromName: string;
}

export interface MailboxCycleStats {
  mailboxKey: string;
  mailboxId: string | null;
  email: string;
  fromName: string;
  sent: number;
  sentLast24h: number;
  dailyLimit: number;
  remainingBudget: number;
  limitReached: boolean;
}

export interface SendRunResult {
  handled: number;
  totalSent: number;
  stoppedBecause: "budget" | "idle" | "limit";
  mailboxes: MailboxCycleStats[];
}

export interface SendWorkerOptions {
  dailyLimitPerMailbox?: number;
  mailboxMaxRatePerMinute?: number;
  now?: () => number;
}

interface MailboxLookupContext {
  accountsById: Map<string, { id: string; email: string; fromName: string }>;
  accountsByEmail: Map<string, { id: string; email: string; fromName: string }>;
  userDefaultAccount: Map<string, { id: string; email: string; fromName: string }>;
  legacyUserMailboxes: Map<string, { id: string; email: string; fromName: string }>;
}

interface ActiveCampaignRow {
  id: string;
  fromName: string;
  fromEmail: string | null;
  replyTo: string | null;
  sendRatePerMinute: number;
  createdById: string | null;
  mailboxId: string | null;
}

export async function loadMailboxLookupContext(): Promise<MailboxLookupContext> {
  const [accounts, accesses, legacyMailboxes] = await Promise.all([
    prisma.mailboxAccount.findMany({
      select: { id: true, email: true, fromName: true },
      orderBy: { email: "asc" },
    }),
    prisma.mailboxAccess.findMany({
      where: { user: { status: "ACTIVE" } },
      include: { mailbox: { select: { id: true, email: true, fromName: true } } },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
    prisma.userMailbox.findMany({
      where: { user: { status: "ACTIVE" } },
      select: { id: true, userId: true, email: true, fromName: true },
    }),
  ]);

  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const accountsByEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a]));
  const userDefaultAccount = new Map<string, { id: string; email: string; fromName: string }>();
  for (const acc of accesses) {
    if (!userDefaultAccount.has(acc.userId)) {
      userDefaultAccount.set(acc.userId, acc.mailbox);
    }
  }
  const legacyUserMailboxes = new Map(
    legacyMailboxes.map((u) => [u.userId, { id: u.id, email: u.email, fromName: u.fromName }])
  );
  return { accountsById, accountsByEmail, userDefaultAccount, legacyUserMailboxes };
}

export function resolveCampaignMailboxIdentity(
  campaign: {
    mailboxId?: string | null;
    fromEmail?: string | null;
    createdById?: string | null;
    fromName?: string | null;
  },
  ctx: MailboxLookupContext
): MailboxIdentity {
  if (campaign.mailboxId) {
    const acc = ctx.accountsById.get(campaign.mailboxId);
    if (acc) {
      return { key: `mb:${acc.id}`, mailboxId: acc.id, email: acc.email, fromName: acc.fromName };
    }
    return {
      key: `mb:${campaign.mailboxId}`,
      mailboxId: campaign.mailboxId,
      email: campaign.fromEmail ?? campaign.mailboxId,
      fromName: campaign.fromName ?? "Mailbox",
    };
  }
  if (campaign.fromEmail) {
    const emailLower = campaign.fromEmail.trim().toLowerCase();
    const acc = ctx.accountsByEmail.get(emailLower);
    if (acc) {
      return { key: `mb:${acc.id}`, mailboxId: acc.id, email: acc.email, fromName: acc.fromName };
    }
    return {
      key: `email:${emailLower}`,
      mailboxId: null,
      email: emailLower,
      fromName: campaign.fromName ?? emailLower,
    };
  }
  if (campaign.createdById) {
    const acc = ctx.userDefaultAccount.get(campaign.createdById);
    if (acc) {
      return { key: `mb:${acc.id}`, mailboxId: acc.id, email: acc.email, fromName: acc.fromName };
    }
    const legacy = ctx.legacyUserMailboxes.get(campaign.createdById);
    if (legacy) {
      return {
        key: `email:${legacy.email.toLowerCase()}`,
        mailboxId: null,
        email: legacy.email,
        fromName: legacy.fromName,
      };
    }
    const fallbackEmail = env.SMTP_USER || env.SMTP_FROM_EMAIL;
    if (fallbackEmail) {
      return {
        key: `email:${fallbackEmail.toLowerCase()}`,
        mailboxId: null,
        email: fallbackEmail.toLowerCase(),
        fromName: env.SMTP_FROM_NAME || "FocusRealm",
      };
    }
    return {
      key: `user:${campaign.createdById}`,
      mailboxId: null,
      email: campaign.fromName ?? "System mailbox",
      fromName: campaign.fromName ?? "System mailbox",
    };
  }
  const sysEmail = env.SMTP_USER || env.SMTP_FROM_EMAIL;
  if (sysEmail) {
    return {
      key: `email:${sysEmail.toLowerCase()}`,
      mailboxId: null,
      email: sysEmail.toLowerCase(),
      fromName: env.SMTP_FROM_NAME || "FocusRealm",
    };
  }
  return { key: "system:default", mailboxId: null, email: "system", fromName: "FocusRealm" };
}

/**
 * Computes rolling 24h sent counts grouped by canonical mailbox identity key.
 */
async function getRolling24hUsageByMailbox(
  ctx: MailboxLookupContext,
  nowMs = Date.now(),
  knownCampaigns?: Map<string, { mailboxId: string | null; fromEmail: string | null; createdById: string | null; fromName: string }>
): Promise<Map<string, number>> {
  const cutoff = new Date(nowMs - ROLLING_WINDOW_MS);
  const grouped = await prisma.send.groupBy({
    by: ["mailboxId", "campaignId"],
    where: { status: "SENT", sentAt: { gt: cutoff } },
    _count: { _all: true },
  });

  const missingCampaignIds = new Set<string>();
  for (const row of grouped) {
    if (!row.mailboxId && !knownCampaigns?.has(row.campaignId)) {
      missingCampaignIds.add(row.campaignId);
    }
  }

  const campaignMap = new Map(knownCampaigns ?? []);
  if (missingCampaignIds.size > 0) {
    const extraCampaigns = await prisma.campaign.findMany({
      where: { id: { in: Array.from(missingCampaignIds) } },
      select: { id: true, mailboxId: true, fromEmail: true, createdById: true, fromName: true },
    });
    for (const c of extraCampaigns) {
      campaignMap.set(c.id, c);
    }
  }

  const counts = new Map<string, number>();
  for (const row of grouped) {
    let key: string;
    if (row.mailboxId) {
      key = `mb:${row.mailboxId}`;
    } else {
      const c = campaignMap.get(row.campaignId);
      key = c ? resolveCampaignMailboxIdentity(c, ctx).key : "system:default";
    }
    counts.set(key, (counts.get(key) ?? 0) + row._count._all);
  }
  return counts;
}

/**
 * Rolling 24h sent count: either for a specific mailboxId, or total across the workspace.
 */
export async function sentInLast24h(mailboxId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - ROLLING_WINDOW_MS);
  if (!mailboxId) {
    return prisma.send.count({ where: { status: "SENT", sentAt: { gt: cutoff } } });
  }
  return prisma.send.count({
    where: {
      status: "SENT",
      sentAt: { gt: cutoff },
      OR: [{ mailboxId }, { mailboxId: null, campaign: { mailboxId } }],
    },
  });
}

/**
 * Rolling 24h budget status for the mailbox assigned to a given campaign.
 */
export async function sentInLast24hForCampaign(
  campaign: { id: string; mailboxId?: string | null; fromEmail?: string | null; createdById?: string | null; fromName?: string | null },
  dailyLimit = env.DAILY_SEND_LIMIT
): Promise<{ identity: MailboxIdentity; sentLast24h: number; dailyLimit: number; remainingBudget: number }> {
  const ctx = await loadMailboxLookupContext();
  const identity = resolveCampaignMailboxIdentity(campaign, ctx);
  const campaignMap = new Map([
    [
      campaign.id,
      {
        mailboxId: campaign.mailboxId ?? null,
        fromEmail: campaign.fromEmail ?? null,
        createdById: campaign.createdById ?? null,
        fromName: campaign.fromName ?? "Mailbox",
      },
    ],
  ]);
  const usage = await getRolling24hUsageByMailbox(ctx, Date.now(), campaignMap);
  const sentLast24h = usage.get(identity.key) ?? 0;
  return {
    identity,
    sentLast24h,
    dailyLimit,
    remainingBudget: Math.max(0, dailyLimit - sentLast24h),
  };
}

/**
 * Per-mailbox rolling 24h usage summary across all configured mailboxes (plus any active fallback mailboxes).
 */
export async function getMailboxBudgets(dailyLimit = env.DAILY_SEND_LIMIT): Promise<MailboxBudgetUsageDto[]> {
  const ctx = await loadMailboxLookupContext();
  const [sendingCampaigns, pendingByCamp] = await Promise.all([
    prisma.campaign.findMany({
      where: { status: "SENDING" },
      select: { id: true, mailboxId: true, fromEmail: true, createdById: true, fromName: true },
    }),
    prisma.send.groupBy({
      by: ["campaignId"],
      where: { status: "PENDING", campaign: { status: "SENDING" } },
      _count: { _all: true },
    }),
  ]);

  const campaignMap = new Map(sendingCampaigns.map((c) => [c.id, c]));
  const usageMap = await getRolling24hUsageByMailbox(ctx, Date.now(), campaignMap);
  const pendingMap = new Map(pendingByCamp.map((r) => [r.campaignId, r._count._all]));

  const identities = new Map<string, MailboxIdentity>();
  for (const acc of ctx.accountsById.values()) {
    identities.set(`mb:${acc.id}`, {
      key: `mb:${acc.id}`,
      mailboxId: acc.id,
      email: acc.email,
      fromName: acc.fromName,
    });
  }
  const activeCountByKey = new Map<string, number>();
  const pendingByKey = new Map<string, number>();
  for (const c of sendingCampaigns) {
    const id = resolveCampaignMailboxIdentity(c, ctx);
    if (!identities.has(id.key)) identities.set(id.key, id);
    activeCountByKey.set(id.key, (activeCountByKey.get(id.key) ?? 0) + 1);
    pendingByKey.set(id.key, (pendingByKey.get(id.key) ?? 0) + (pendingMap.get(c.id) ?? 0));
  }

  return Array.from(identities.values()).map((id) => {
    const sentLast24h = usageMap.get(id.key) ?? 0;
    return {
      mailboxId: id.mailboxId,
      email: id.email,
      fromName: id.fromName,
      sentLast24h,
      dailyLimit,
      remainingBudget: Math.max(0, dailyLimit - sentLast24h),
      activeCampaigns: activeCountByKey.get(id.key) ?? 0,
      pendingSends: pendingByKey.get(id.key) ?? 0,
    };
  });
}

/**
 * Marks interrupted handoffs as UNKNOWN.
 * Self-hosted (single process) calls this at boot with olderThanMs = 0. Serverless passes a
 * threshold longer than any function can run, so another instance's in-flight send is untouched.
 */
export async function recoverInterruptedSends(olderThanMs = 0): Promise<number> {
  const { count } = await prisma.send.updateMany({
    where: { status: "CLAIMED", ...(olderThanMs ? { claimedAt: { lt: new Date(Date.now() - olderThanMs) } } : {}) },
    data: {
      status: "UNKNOWN",
      lastError:
        "Sending was interrupted while this message was being handed to the mailbox. It may or may not have been delivered.",
    },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Global sender lease: at most one sender at a time across serverless ticks
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

/** True if any sending campaign still has queued messages that are claimable */
export async function hasQueuedWork(): Promise<boolean> {
  const now = new Date();
  const next = await prisma.send.findFirst({
    where: {
      status: "PENDING",
      campaign: { status: "SENDING" },
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
      AND: [
        {
          OR: [
            { approvedAt: { not: null } },
            { campaign: { automationMode: "AUTOMATIC" } },
          ],
        },
      ],
    },
    select: { id: true },
  });
  return Boolean(next);
}

/**
 * Lightweight pre-flight check for `/api/internal/tick`:
 * Returns true only if there is at least one due, approved/automatic PENDING send
 * on a SENDING campaign whose mailbox has remaining 24h budget and whose recipient
 * is not suppressed, replied, or in a terminal sequence state.
 * Never acquires a lease, never starts SendWorker, and never triggers IMAP sync.
 */
export async function hasEligiblePendingWork(
  dailyLimitPerMailbox = env.DAILY_SEND_LIMIT,
  nowMs = Date.now()
): Promise<boolean> {
  if (liveSendingBlocker()) return false;

  const nowDate = new Date(nowMs);
  const campaigns = await prisma.campaign.findMany({
    where: { status: "SENDING" },
    select: {
      id: true,
      fromName: true,
      fromEmail: true,
      createdById: true,
      mailboxId: true,
    },
  });
  if (!campaigns.length) return false;

  const campaignIds = campaigns.map((c) => c.id);
  const dueGrouped = await prisma.send.groupBy({
    by: ["campaignId"],
    where: {
      campaignId: { in: campaignIds },
      status: "PENDING",
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: nowDate } }],
      AND: [
        {
          OR: [{ approvedAt: { not: null } }, { campaign: { automationMode: "AUTOMATIC" } }],
        },
      ],
    },
    _count: { _all: true },
  });

  const dueCampaignIds = dueGrouped.filter((g) => g._count._all > 0).map((g) => g.campaignId);
  if (!dueCampaignIds.length) return false;

  const campaignMap = new Map(campaigns.map((c) => [c.id, c]));
  const ctx = await loadMailboxLookupContext();
  const usageByMailbox = await getRolling24hUsageByMailbox(ctx, nowMs, campaignMap);

  const budgetedCampaignIds = dueCampaignIds.filter((cid) => {
    const c = campaignMap.get(cid);
    if (!c) return false;
    const identity = resolveCampaignMailboxIdentity(c, ctx);
    return (usageByMailbox.get(identity.key) ?? 0) < dailyLimitPerMailbox;
  });
  if (!budgetedCampaignIds.length) return false;

  const candidates = await prisma.send.findMany({
    where: {
      campaignId: { in: budgetedCampaignIds },
      status: "PENDING",
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: nowDate } }],
      AND: [
        {
          OR: [{ approvedAt: { not: null } }, { campaign: { automationMode: "AUTOMATIC" } }],
        },
      ],
    },
    orderBy: [{ stepIndex: "asc" }, { scheduledFor: "asc" }, { createdAt: "asc" }],
    take: 50,
    select: { campaignId: true, email: true, stepIndex: true },
  });
  if (!candidates.length) return false;

  const emails = Array.from(new Set(candidates.map((s) => s.email)));
  const followUpCandidates = candidates.filter((s) => s.stepIndex > 0);
  const followUpCampaignIds = Array.from(new Set(followUpCandidates.map((s) => s.campaignId)));
  const followUpEmails = Array.from(new Set(followUpCandidates.map((s) => s.email)));

  const [suppressions, recipientStates, priorReplies] = await Promise.all([
    prisma.suppressionEntry.findMany({
      where: {
        email: { in: emails },
        OR: [{ expiresAt: null }, { expiresAt: { gt: nowDate } }],
      },
      select: { email: true },
    }),
    followUpCampaignIds.length
      ? prisma.campaignRecipientState.findMany({
          where: {
            campaignId: { in: followUpCampaignIds },
            email: { in: followUpEmails },
            state: { in: ["PAUSED", "CANCELLED", "BOUNCED", "SUPPRESSED", "REPLY_RECEIVED"] },
          },
          select: { campaignId: true, email: true },
        })
      : Promise.resolve([]),
    followUpCampaignIds.length
      ? prisma.send.findMany({
          where: {
            campaignId: { in: followUpCampaignIds },
            email: { in: followUpEmails },
            repliedAt: { not: null },
          },
          select: { campaignId: true, email: true },
        })
      : Promise.resolve([]),
  ]);

  const suppressedSet = new Set(suppressions.map((s) => s.email.toLowerCase()));
  const blockedRecipientKeys = new Set([
    ...recipientStates.map((r) => `${r.campaignId}:${r.email.toLowerCase()}`),
    ...priorReplies.map((r) => `${r.campaignId}:${r.email.toLowerCase()}`),
  ]);

  return candidates.some((s) => {
    const emailLower = s.email.toLowerCase();
    if (suppressedSet.has(emailLower)) return false;
    if (s.stepIndex > 0 && blockedRecipientKeys.has(`${s.campaignId}:${emailLower}`)) return false;
    return true;
  });
}

async function claimNext(campaignId: string): Promise<ClaimedSend | null> {
  const rows = await prisma.$queryRaw<ClaimedSend[]>`
    UPDATE sends
       SET status = 'CLAIMED', "claimedAt" = now(), attempts = attempts + 1, "updatedAt" = now()
     WHERE id = (
       SELECT id FROM sends
        WHERE "campaignId" = ${campaignId}
          AND status = 'PENDING'
          AND ("approvedAt" IS NOT NULL OR EXISTS (
            SELECT 1 FROM campaigns WHERE id = ${campaignId} AND "automationMode" = 'AUTOMATIC'
          ))
          AND ("scheduledFor" IS NULL OR "scheduledFor" <= now())
        ORDER BY "stepIndex" ASC, "scheduledFor" ASC NULLS FIRST, "createdAt" ASC, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
    RETURNING id, "campaignId", email, subject, html, text, "messageId", "stepIndex", "inReplyToId", attachments`;
  return rows[0] ?? null;
}

async function finishIfDone(campaignId: string) {
  const remaining = await prisma.send.count({ where: { campaignId, status: { in: ["PENDING", "CLAIMED"] } } });
  if (remaining > 0) return;

  const activeRecipients = await prisma.campaignRecipientState.count({
    where: {
      campaignId,
      state: { in: ["FOLLOW_UP_SCHEDULED", "AWAITING_APPROVAL"] },
    },
  });
  if (activeRecipients > 0) return;

  await prisma.campaign.updateMany({
    where: { id: campaignId, status: "SENDING" },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
}

async function resolveInboxSafetyIdentity(campaign: {
  mailboxId?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  createdById?: string | null;
}): Promise<string | undefined> {
  if (campaign.mailboxId) return campaign.mailboxId;
  if (campaign.fromEmail) {
    const byEmail = await getMailboxCredentialsByEmail(campaign.fromEmail, campaign.fromName ?? undefined).catch(() => null);
    if (byEmail?.accountId) return byEmail.accountId;
  }
  if (campaign.createdById) {
    const personal = await getPersonalMailboxCredentials(campaign.createdById).catch(() => null);
    if (personal?.accountId) return personal.accountId;
    return campaign.createdById;
  }
  return undefined;
}

export type SendOneOutcome = "sent" | "skipped" | "failed" | "deferred" | "empty";

/**
 * Claims and dispatches one message for a campaign.
 * Returns a granular outcome so the coordinated mailbox scheduler knows whether SMTP was contacted.
 */
export async function sendOneDetailed(campaign: {
  id: string;
  fromName: string;
  fromEmail?: string | null;
  replyTo: string | null;
  createdById?: string | null;
  mailboxId?: string | null;
}): Promise<SendOneOutcome> {
  const send = await claimNext(campaign.id);
  if (!send) {
    await finishIfDone(campaign.id);
    return "empty";
  }

  // Re-check the campaign and the suppression list at the last moment
  const [current, suppression] = await Promise.all([
    prisma.campaign.findUnique({ where: { id: campaign.id }, select: { status: true } }),
    prisma.suppressionEntry.findUnique({ where: { email: send.email } }),
  ]);
  if (current?.status !== "SENDING") {
    await prisma.send.update({
      where: { id: send.id },
      data: { status: current?.status === "CANCELLED" ? "CANCELLED" : "PENDING", attempts: { decrement: 1 } },
    });
    return "skipped";
  }
  if (suppression && (!suppression.expiresAt || suppression.expiresAt > new Date())) {
    await prisma.send.update({ where: { id: send.id }, data: { status: "SKIPPED", skipReason: "Suppressed after approval" } });
    await finishIfDone(campaign.id);
    return "skipped";
  }

  // Follow-up specific safeguards for stepIndex > 0
  if (send.stepIndex > 0) {
    // 1. Reply detection check: cancel if recipient has replied on any prior step
    const priorReply = await prisma.send.findFirst({
      where: { campaignId: campaign.id, email: send.email, repliedAt: { not: null } },
      select: { id: true },
    });
    if (priorReply) {
      await prisma.send.update({
        where: { id: send.id },
        data: { status: "CANCELLED", skipReason: "Reply received on prior outreach — follow-up stopped" },
      });
      await finishIfDone(campaign.id);
      return "skipped";
    }

    // 2. Recipient state check: cancel if paused, cancelled, or suppressed
    const rState = await prisma.campaignRecipientState.findUnique({
      where: { campaignId_email: { campaignId: campaign.id, email: send.email } },
      select: { state: true },
    });
    if (rState && ["PAUSED", "CANCELLED", "BOUNCED", "SUPPRESSED", "REPLY_RECEIVED"].includes(rState.state)) {
      await prisma.send.update({
        where: { id: send.id },
        data: { status: "CANCELLED", skipReason: `Recipient is in state: ${rState.state}` },
      });
      await finishIfDone(campaign.id);
      return "skipped";
    }

    // 3. Inbox monitoring health check: defer if monitoring is unhealthy or stale
    const inboxIdentity = await resolveInboxSafetyIdentity(campaign);
    const inboxHealth = await isInboxMonitoringSafe(inboxIdentity);
    if (!inboxHealth.safe) {
      await prisma.send.update({
        where: { id: send.id },
        data: { status: "PENDING", attempts: { decrement: 1 }, lastError: `Deferred: ${inboxHealth.reason}` },
      });
      return "deferred";
    }
  }

  let mailbox = null;
  try {
    if (campaign.mailboxId) {
      mailbox = await getMailboxCredentials(campaign.mailboxId, campaign.fromName);
    } else if (campaign.fromEmail) {
      mailbox = await getMailboxCredentialsByEmail(campaign.fromEmail, campaign.fromName);
    }
    if (!mailbox && campaign.createdById) {
      mailbox = await getPersonalMailboxCredentials(campaign.createdById);
    }
  } catch (error) {
    await prisma.send.update({ where: { id: send.id }, data: { status: "PENDING", attempts: { decrement: 1 } } });
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2021", "P2022"].includes(error.code)) {
      console.error(`[worker] mailbox database schema is missing for campaign ${campaign.id} (${error.code})`);
      await pauseCampaign(
        null,
        campaign.id,
        "The mailbox database migration is missing. Deploy the latest database migrations, then resume this campaign."
      );
    } else if (error instanceof AppError) {
      await pauseCampaign(null, campaign.id, error.message);
    } else {
      console.error(`[worker] couldn't load the mailbox for campaign ${campaign.id}:`, error);
      await pauseCampaign(
        null,
        campaign.id,
        "The campaign mailbox could not be loaded. Check the mailbox connection and database, then resume this campaign."
      );
    }
    return "failed";
  }
  if (!mailbox && !env.SMTP_USER) {
    await prisma.send.update({ where: { id: send.id }, data: { status: "PENDING", attempts: { decrement: 1 } } });
    await pauseCampaign(
      null,
      campaign.id,
      "The campaign's authorized SpaceMail mailbox is not connected or accessible. Reconnect it in Settings before resuming."
    );
    return "failed";
  }

  let attachments: { filename: string; contentType: string; content: Buffer }[];
  try {
    attachments = await Promise.all(
      storedAttachments(send.attachments).map(async (attachment) => ({
        filename: attachment.name,
        contentType: attachment.contentType,
        content: await downloadTemplateAttachment(attachment.storageKey),
      }))
    );
  } catch (error) {
    console.error(
      `[worker] couldn't load attachments for send ${send.id}:`,
      error instanceof Error ? error.message : "unknown error"
    );
    await prisma.send.update({
      where: { id: send.id },
      data: {
        status: "PENDING",
        attempts: { decrement: 1 },
        lastError: "A template attachment is unavailable. The campaign was paused before sending.",
      },
    });
    await pauseCampaign(null, campaign.id, "A campaign attachment could not be loaded from storage. Check Supabase Storage, then resume.");
    return "failed";
  }

  const url = unsubscribeUrl(send.id);
  const headers: Record<string, string> = {
    ...unsubscribeHeaders(url),
    "X-FR-Send-ID": send.id,
  };
  if (send.stepIndex > 0 && send.inReplyToId) {
    headers["In-Reply-To"] = send.inReplyToId;
    headers["References"] = send.inReplyToId;
  }

  try {
    await getTransport(mailbox ?? undefined).send({
      to: send.email,
      subject: send.subject,
      html: send.html,
      text: send.text,
      messageId: send.messageId,
      fromName: campaign.fromName,
      fromEmail: campaign.fromEmail,
      replyTo: campaign.replyTo,
      headers,
      attachments,
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
        await pauseCampaign(
          null,
          campaign.id,
          outcome.authFailure ? "Couldn't sign in to the mailbox. Check the SMTP password, then resume." : `Couldn't reach the mailbox: ${outcome.message}`
        ).catch(() => undefined);
        break;
      case "unknown":
        await prisma.send.update({ where: { id: send.id }, data: { status: "UNKNOWN", lastError: `Interrupted: ${outcome.message}` } });
        break;
    }
    await finishIfDone(campaign.id);
    return "failed";
  }

  // Outside the catch: if this write fails the row stays CLAIMED -> UNKNOWN on next boot, never resent
  await prisma.send.update({
    where: { id: send.id },
    data: {
      status: "SENT",
      sentAt: new Date(),
      lastError: null,
      mailboxId: mailbox?.accountId ?? campaign.mailboxId ?? null,
      sentByUserId: campaign.createdById ?? null,
    },
  });
  await onStepSent(send.id).catch((err) => {
    console.error(`[worker] onStepSent failed for send ${send.id}:`, (err as Error).message);
  });
  await finishIfDone(campaign.id);
  return "sent";
}

/** Sends one message for the campaign if possible. Returns true if it did any work. */
export async function sendOne(campaign: {
  id: string;
  fromName: string;
  fromEmail?: string | null;
  replyTo: string | null;
  createdById?: string | null;
  mailboxId?: string | null;
}): Promise<boolean> {
  const outcome = await sendOneDetailed(campaign);
  return outcome !== "empty" && outcome !== "deferred";
}

// ---------------------------------------------------------------------------
// Coordinated Multi-Mailbox SendWorker
// ---------------------------------------------------------------------------

interface StepResult {
  outcome: "worked" | "waiting" | "limit" | "idle";
  waitMs?: number;
  actuallySent?: boolean;
  mailboxes: MailboxCycleStats[];
}

export class SendWorker {
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly campaignLastSentAt = new Map<string, number>();
  private readonly mailboxLastSentAt = new Map<string, number>();
  private readonly campaignCursors = new Map<string, number>();
  private mailboxCursor = 0;
  private wakeResolve: (() => void) | null = null;

  private readonly dailyLimitPerMailbox: number;
  private readonly mailboxMaxRatePerMinute: number;
  private readonly now: () => number;

  constructor(options: SendWorkerOptions = {}) {
    this.dailyLimitPerMailbox = options.dailyLimitPerMailbox ?? env.DAILY_SEND_LIMIT;
    this.mailboxMaxRatePerMinute = options.mailboxMaxRatePerMinute ?? env.MAILBOX_MAX_SEND_RATE_PER_MINUTE;
    this.now = options.now ?? (() => Date.now());
  }

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
        const res = await this.step();
        if (res.outcome === "worked") delay = 0;
        else if (res.outcome === "waiting") delay = Math.min(res.waitMs ?? 1000, 5_000);
        else if (res.outcome === "limit") delay = 30_000;
        else delay = 15_000;
      } catch (err) {
        delay = 10_000;
        console.error("[worker] tick failed:", (err as Error).message);
      }
      if (delay && this.running) await this.sleep(delay);
    }
  }

  /**
   * Bounded execution cycle for serverless wake-up ticks (Vercel /api/internal/tick).
   * Processes eligible sends across all mailboxes within per-mailbox 24h budgets and pacing,
   * exiting cleanly before the invocation timeout. Callers must hold the global "sender" lease.
   */
  async runFor(budgetMs: number): Promise<SendRunResult> {
    const deadline = this.now() + budgetMs;
    let handled = 0;
    let totalSent = 0;
    const cycleSentByMailbox = new Map<string, number>();
    let lastMailboxes: MailboxCycleStats[] = [];

    while (this.now() < deadline) {
      const res = await this.step(cycleSentByMailbox);
      if (res.mailboxes.length > 0) {
        lastMailboxes = res.mailboxes;
      }
      if (res.outcome === "worked") {
        handled++;
        if (res.actuallySent) totalSent++;
      } else if (res.outcome === "idle" || res.outcome === "limit") {
        if (lastMailboxes.length === 0) {
          const budgets = await getMailboxBudgets(this.dailyLimitPerMailbox);
          lastMailboxes = budgets.map((b) => ({
            mailboxKey: b.mailboxId ? `mb:${b.mailboxId}` : `email:${b.email}`,
            mailboxId: b.mailboxId,
            email: b.email,
            fromName: b.fromName,
            sent: 0,
            sentLast24h: b.sentLast24h,
            dailyLimit: b.dailyLimit,
            remainingBudget: b.remainingBudget,
            limitReached: b.remainingBudget <= 0,
          }));
        }
        return { handled, totalSent, stoppedBecause: res.outcome, mailboxes: lastMailboxes };
      } else {
        const remainingMs = deadline - this.now();
        const waitMs = res.waitMs ?? 250;
        // Stop cleanly if waiting for the next pacing slot would exceed our remaining execution budget
        if (remainingMs <= 50 || waitMs >= remainingMs) {
          return { handled, totalSent, stoppedBecause: "budget", mailboxes: lastMailboxes };
        }
        await new Promise((r) => setTimeout(r, Math.min(waitMs, remainingMs, 5_000)));
      }
    }

    return { handled, totalSent, stoppedBecause: "budget", mailboxes: lastMailboxes };
  }

  /** Last send time for campaign pacing; seeded from DB on first inspection */
  private async getCampaignLastSent(campaignId: string): Promise<number> {
    const cached = this.campaignLastSentAt.get(campaignId);
    if (cached !== undefined) return cached;
    const last = await prisma.send.findFirst({
      where: { campaignId, status: "SENT", sentAt: { not: null } },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    });
    const at = last?.sentAt?.getTime() ?? 0;
    this.campaignLastSentAt.set(campaignId, at);
    return at;
  }

  /** Last send time for mailbox-level pacing across all campaigns sharing that mailbox */
  private async getMailboxLastSent(identity: MailboxIdentity, campaignIdsOnMailbox: string[]): Promise<number> {
    const cached = this.mailboxLastSentAt.get(identity.key);
    if (cached !== undefined) return cached;

    const where: Prisma.SendWhereInput = identity.mailboxId
      ? {
          status: "SENT",
          sentAt: { not: null },
          OR: [{ mailboxId: identity.mailboxId }, { campaignId: { in: campaignIdsOnMailbox } }],
        }
      : {
          status: "SENT",
          sentAt: { not: null },
          campaignId: { in: campaignIdsOnMailbox },
        };

    const last = await prisma.send.findFirst({
      where,
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    });
    const at = last?.sentAt?.getTime() ?? 0;
    this.mailboxLastSentAt.set(identity.key, at);
    return at;
  }

  /**
   * One coordinated scheduling pass across all active mailboxes & campaigns.
   * worked = sent/handled a message; waiting = mailboxes have budget & work but are pacing;
   * limit = all mailboxes with pending work exhausted their 300/24h budget; idle = no claimable work.
   */
  async tick(): Promise<"worked" | "waiting" | "limit" | "idle"> {
    const res = await this.step();
    return res.outcome;
  }

  private async step(cycleSentByMailbox?: Map<string, number>): Promise<StepResult> {
    const campaigns = await prisma.campaign.findMany({
      where: { status: "SENDING" },
      select: {
        id: true,
        fromName: true,
        fromEmail: true,
        replyTo: true,
        sendRatePerMinute: true,
        createdById: true,
        mailboxId: true,
      },
      orderBy: { startedAt: "asc" },
    });

    if (!campaigns.length) {
      return { outcome: "idle", mailboxes: [] };
    }

    const blocker = liveSendingBlocker();
    if (blocker) {
      for (const c of campaigns) await pauseCampaign(null, c.id, blocker).catch(() => undefined);
      return { outcome: "idle", mailboxes: [] };
    }

    const nowMs = this.now();
    const nowDate = new Date(nowMs);
    const campaignIds = campaigns.map((c) => c.id);

    // Query due claimable sends AND total remaining sends in parallel (only 2 lightweight grouped queries)
    const [dueGrouped, remainingGrouped, ctx] = await Promise.all([
      prisma.send.groupBy({
        by: ["campaignId"],
        where: {
          campaignId: { in: campaignIds },
          status: "PENDING",
          OR: [{ scheduledFor: null }, { scheduledFor: { lte: nowDate } }],
          AND: [
            {
              OR: [{ approvedAt: { not: null } }, { campaign: { automationMode: "AUTOMATIC" } }],
            },
          ],
        },
        _count: { _all: true },
      }),
      prisma.send.groupBy({
        by: ["campaignId"],
        where: { campaignId: { in: campaignIds }, status: { in: ["PENDING", "CLAIMED"] } },
        _count: { _all: true },
      }),
      loadMailboxLookupContext(),
    ]);

    const dueByCamp = new Map(dueGrouped.map((r) => [r.campaignId, r._count._all]));
    const remainingByCamp = new Map(remainingGrouped.map((r) => [r.campaignId, r._count._all]));

    // Complete any SENDING campaigns that genuinely have zero remaining sends and zero active follow-up states
    for (const c of campaigns) {
      if ((remainingByCamp.get(c.id) ?? 0) === 0) {
        await finishIfDone(c.id);
      }
    }

    const campaignMap = new Map(campaigns.map((c) => [c.id, c]));
    const usageByMailbox = await getRolling24hUsageByMailbox(ctx, nowMs, campaignMap);

    // Group campaigns by mailbox identity (track all campaigns on mailbox for lastSent lookup, and eligible ones for sending)
    const allCampaignIdsByMailbox = new Map<string, string[]>();
    const mailboxMetaByKey = new Map<string, MailboxIdentity>();
    const eligibleByMailbox = new Map<string, ActiveCampaignRow[]>();

    for (const c of campaigns) {
      const identity = resolveCampaignMailboxIdentity(c, ctx);
      mailboxMetaByKey.set(identity.key, identity);
      const listAll = allCampaignIdsByMailbox.get(identity.key) ?? [];
      listAll.push(c.id);
      allCampaignIdsByMailbox.set(identity.key, listAll);

      if ((dueByCamp.get(c.id) ?? 0) > 0) {
        const listElig = eligibleByMailbox.get(identity.key) ?? [];
        listElig.push(c);
        eligibleByMailbox.set(identity.key, listElig);
      }
    }

    // Build statistics across all active/configured mailboxes
    const buildStats = (limitKeys: Set<string>): MailboxCycleStats[] => {
      const keys = new Set<string>(mailboxMetaByKey.keys());
      for (const acc of ctx.accountsById.values()) {
        const k = `mb:${acc.id}`;
        keys.add(k);
        if (!mailboxMetaByKey.has(k)) {
          mailboxMetaByKey.set(k, { key: k, mailboxId: acc.id, email: acc.email, fromName: acc.fromName });
        }
      }
      return Array.from(keys)
        .sort()
        .map((key) => {
          const meta = mailboxMetaByKey.get(key)!;
          const sent24h = usageByMailbox.get(key) ?? 0;
          const remaining = Math.max(0, this.dailyLimitPerMailbox - sent24h);
          return {
            mailboxKey: key,
            mailboxId: meta.mailboxId,
            email: meta.email,
            fromName: meta.fromName,
            sent: cycleSentByMailbox?.get(key) ?? 0,
            sentLast24h: sent24h,
            dailyLimit: this.dailyLimitPerMailbox,
            remainingBudget: remaining,
            limitReached: limitKeys.has(key) || remaining === 0,
          };
        });
    };

    const eligibleMailboxes = Array.from(eligibleByMailbox.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    if (!eligibleMailboxes.length) {
      return { outcome: "idle", mailboxes: buildStats(new Set()) };
    }

    const limitReachedKeys = new Set<string>();
    let minWaitMs = Infinity;
    let anyDeferred = false;

    const mailboxIntervalMs = Math.ceil(60_000 / Math.max(1, this.mailboxMaxRatePerMinute));
    const startIdx = this.mailboxCursor % eligibleMailboxes.length;

    for (let mOffset = 0; mOffset < eligibleMailboxes.length; mOffset++) {
      const mIdx = (startIdx + mOffset) % eligibleMailboxes.length;
      const [mailboxKey, mailboxCampaigns] = eligibleMailboxes[mIdx]!;
      const identity = mailboxMetaByKey.get(mailboxKey)!;

      // 1. Check independent per-mailbox 24h rolling budget
      const sent24h = usageByMailbox.get(mailboxKey) ?? 0;
      if (sent24h >= this.dailyLimitPerMailbox) {
        limitReachedKeys.add(mailboxKey);
        continue; // Skip exhausted mailbox — never block other mailboxes
      }

      // 2. Check mailbox-wide pacing (coordinates all campaigns sharing this mailbox)
      const mailboxLastSent = await this.getMailboxLastSent(
        identity,
        allCampaignIdsByMailbox.get(mailboxKey) ?? mailboxCampaigns.map((c) => c.id)
      );
      const mailboxReadyAt = mailboxLastSent + mailboxIntervalMs;
      if (nowMs < mailboxReadyAt) {
        minWaitMs = Math.min(minWaitMs, mailboxReadyAt - nowMs);
        continue;
      }

      // 3. Round-robin across eligible campaigns sharing this mailbox
      const cStartIdx = (this.campaignCursors.get(mailboxKey) ?? 0) % mailboxCampaigns.length;
      for (let cOffset = 0; cOffset < mailboxCampaigns.length; cOffset++) {
        const cIdx = (cStartIdx + cOffset) % mailboxCampaigns.length;
        const c = mailboxCampaigns[cIdx]!;

        const effectiveCampaignRate = Math.max(1, Math.min(c.sendRatePerMinute, this.mailboxMaxRatePerMinute));
        const campaignIntervalMs = Math.ceil(60_000 / effectiveCampaignRate);
        const campaignLastSent = await this.getCampaignLastSent(c.id);
        const campaignReadyAt = campaignLastSent + campaignIntervalMs;
        if (nowMs < campaignReadyAt) {
          minWaitMs = Math.min(minWaitMs, campaignReadyAt - nowMs);
          continue;
        }

        const outcome = await sendOneDetailed(c);
        if (outcome === "sent" || outcome === "failed") {
          const timestamp = this.now();
          this.mailboxLastSentAt.set(mailboxKey, timestamp);
          this.campaignLastSentAt.set(c.id, timestamp);
          this.mailboxCursor = (mIdx + 1) % eligibleMailboxes.length;
          this.campaignCursors.set(mailboxKey, (cIdx + 1) % mailboxCampaigns.length);
          if (outcome === "sent") {
            usageByMailbox.set(mailboxKey, sent24h + 1);
            if (cycleSentByMailbox) {
              cycleSentByMailbox.set(mailboxKey, (cycleSentByMailbox.get(mailboxKey) ?? 0) + 1);
            }
          }
          return {
            outcome: "worked",
            actuallySent: outcome === "sent",
            mailboxes: buildStats(limitReachedKeys),
          };
        }

        if (outcome === "skipped") {
          this.mailboxCursor = (mIdx + 1) % eligibleMailboxes.length;
          this.campaignCursors.set(mailboxKey, (cIdx + 1) % mailboxCampaigns.length);
          return {
            outcome: "worked",
            actuallySent: false,
            mailboxes: buildStats(limitReachedKeys),
          };
        }

        if (outcome === "deferred") {
          anyDeferred = true;
        }
      }
    }

    const stats = buildStats(limitReachedKeys);
    if (minWaitMs < Infinity) {
      return { outcome: "waiting", waitMs: minWaitMs, mailboxes: stats };
    }
    if (limitReachedKeys.size === eligibleMailboxes.length) {
      return { outcome: "limit", mailboxes: stats };
    }
    if (anyDeferred) {
      return { outcome: "idle", mailboxes: stats };
    }
    return { outcome: "idle", mailboxes: stats };
  }
}
