// Overview, mailbox status, and activity
import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { env, liveSendingBlocker } from "../config.js";
import { asyncHandler, AppError } from "../middleware/error-handler.js";
import { requirePermission } from "../middleware/session.js";
import { ok, okPage, skipTake } from "../lib/http.js";
import { summarize } from "../lib/activity.js";
import { campaignSummaryInclude, toCampaignSummaries } from "../lib/serialize.js";
import { sentInLast24h } from "../services/send-worker.js";
import { verifyMailbox } from "../services/mailer.js";
import { checkInbox, getImapState } from "../services/inbox-monitor.js";
import {
  getPersonalMailboxCredentials,
  getPersonalMailboxStatus,
  getMailboxCredentialsForUser,
  listAccessibleMailboxes,
  listAllMailboxAccounts,
  connectOrUpdateMailbox,
  assignUserToMailbox,
  removeUserFromMailbox,
  updateMailboxUserAccess,
  deleteMailboxAccount,
  removePersonalMailbox,
  personalMailboxServerSettings,
  verifyImapMailbox,
} from "../services/personal-mailbox.js";
import {
  PaginationQuerySchema,
  ConnectMailboxInputSchema,
  AssignMailboxUserInputSchema,
  UpdateMailboxUserInputSchema,
  IdSchema,
  type ActivityDto,
  type MailboxStatusDto,
  type OverviewDto,
  type WorkspaceQueueDto,
} from "../../shared/types.js";
import { audit } from "../lib/audit.js";

let cachedOverview: { data: OverviewDto; expiresAt: number } | null = null;
const OVERVIEW_CACHE_TTL_MS = 15_000;

export function invalidateOverviewCache(): void {
  cachedOverview = null;
}

export const overviewRouter = Router();

overviewRouter.get(
  "/",
  requirePermission("audit.view"),
  asyncHandler(async (_req, res) => {
    const now = Date.now();
    if (cachedOverview && cachedOverview.expiresAt > now) {
      return ok(res, cachedOverview.data);
    }

    const since30 = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const since60 = new Date(now - 60 * 24 * 60 * 60 * 1000);
    const periodMetrics = async (start: Date, end: Date) => {
      const [sends, outcomes] = await Promise.all([
        prisma.$queryRaw<{ started: bigint; sent: bigint; bounced: bigint; replied: bigint; unsubscribed: bigint }[]>`
          SELECT
            COUNT(*) FILTER (WHERE "stepIndex" = 0 AND "sentAt" >= ${start} AND "sentAt" < ${end}) AS started,
            COUNT(*) FILTER (WHERE status = 'SENT' AND "sentAt" >= ${start} AND "sentAt" < ${end}) AS sent,
            COUNT(*) FILTER (WHERE "bouncedAt" >= ${start} AND "bouncedAt" < ${end}) AS bounced,
            COUNT(*) FILTER (WHERE "repliedAt" >= ${start} AND "repliedAt" < ${end}) AS replied,
            COUNT(*) FILTER (WHERE "unsubscribedAt" >= ${start} AND "unsubscribedAt" < ${end}) AS unsubscribed
          FROM sends
          WHERE ("sentAt" >= ${start} AND "sentAt" < ${end})
             OR ("bouncedAt" >= ${start} AND "bouncedAt" < ${end})
             OR ("repliedAt" >= ${start} AND "repliedAt" < ${end})
             OR ("unsubscribedAt" >= ${start} AND "unsubscribedAt" < ${end})`,
        prisma.$queryRaw<{ positiveReplies: bigint; meetingsBooked: bigint }[]>`
          SELECT
            COUNT(DISTINCT "sendId") FILTER (
              WHERE "type" = 'REPLY'
                AND ("detail"->>'classification' = 'POSITIVE' OR lower("detail"->>'sentiment') = 'positive')
            ) AS "positiveReplies",
            COUNT(DISTINCT "sendId") FILTER (
              WHERE "type" = 'REPLY'
                AND ("detail"->>'meetingBooked' = 'true' OR "detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
            ) AS "meetingsBooked"
          FROM send_events
          WHERE "occurredAt" >= ${start} AND "occurredAt" < ${end}`,
      ]);
      const send = sends[0];
      const outcome = outcomes[0];
      return {
        started: Number(send?.started ?? 0),
        sent: Number(send?.sent ?? 0),
        bounced: Number(send?.bounced ?? 0),
        replied: Number(send?.replied ?? 0),
        positiveReplies: Number(outcome?.positiveReplies ?? 0),
        meetingsBooked: Number(outcome?.meetingsBooked ?? 0),
        unsubscribed: Number(send?.unsubscribed ?? 0),
      };
    };

    const [countsRaw, sent24h, connectedMailboxes, active, recent, attention, last30Days, previous30Days] = await Promise.all([
      prisma.$queryRaw<{ contacts: bigint; lists: bigint; templates: bigint; suppressed: bigint }[]>`
        SELECT
          (SELECT COUNT(*) FROM contacts) AS contacts,
          (SELECT COUNT(*) FROM contact_lists) AS lists,
          (SELECT COUNT(*) FROM templates) AS templates,
          (SELECT COUNT(*) FROM suppression_entries) AS suppressed`,
      sentInLast24h(),
      prisma.userMailbox.count({ where: { user: { status: "ACTIVE" } } }),
      prisma.campaign.findMany({ where: { status: { in: ["PENDING_APPROVAL", "APPROVED", "SENDING", "PAUSED"] } }, include: campaignSummaryInclude, orderBy: { updatedAt: "desc" } }),
      prisma.campaign.findMany({ where: { status: { in: ["DRAFT", "COMPLETED", "CANCELLED"] } }, include: campaignSummaryInclude, orderBy: { updatedAt: "desc" }, take: 5 }),
      prisma.send.groupBy({ by: ["campaignId", "status"], where: { status: { in: ["FAILED", "UNKNOWN"] } }, _count: { _all: true } }),
      periodMetrics(since30, new Date(now)),
      periodMetrics(since60, since30),
    ]);

    const countsRow = countsRaw[0] ?? { contacts: 0n, lists: 0n, templates: 0n, suppressed: 0n };
    const counts = {
      contacts: Number(countsRow.contacts),
      lists: Number(countsRow.lists),
      templates: Number(countsRow.templates),
      suppressed: Number(countsRow.suppressed),
    };

    const activeSummaries = await toCampaignSummaries(active);
    const issueByCampaign = new Map<string, { failed: number; unknown: number }>();
    for (const row of attention) {
      const entry = issueByCampaign.get(row.campaignId) ?? { failed: 0, unknown: 0 };
      if (row.status === "FAILED") entry.failed += row._count._all;
      else entry.unknown += row._count._all;
      issueByCampaign.set(row.campaignId, entry);
    }
    const names = await prisma.campaign.findMany({ where: { id: { in: [...issueByCampaign.keys()] } }, select: { id: true, name: true } });

    const data: OverviewDto = {
      counts,
      mailbox: { smtpConfigured: connectedMailboxes > 0, liveSendingEnabled: !liveSendingBlocker(), liveSendingBlocker: liveSendingBlocker(), dailyLimit: env.DAILY_SEND_LIMIT, sentLast24h: sent24h },
      awaitingApproval: activeSummaries.filter((c) => c.status === "PENDING_APPROVAL"),
      inProgress: activeSummaries.filter((c) => c.status !== "PENDING_APPROVAL"),
      needsAttention: names.map((c) => ({ campaign: c, ...issueByCampaign.get(c.id)! })),
      recent: await toCampaignSummaries(recent),
      last30Days,
      previous30Days,
    };

    cachedOverview = { data, expiresAt: now + OVERVIEW_CACHE_TTL_MS };
    ok(res, data);
  })
);

overviewRouter.get(
  "/work-queue",
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const campaignScope: Prisma.CampaignWhereInput =
      user.role === "EMPLOYEE"
        ? {
            OR: [
              { createdById: user.id },
              { collaborators: { some: { userId: user.id } } },
            ],
          }
        : {};
    const campaignRows = await prisma.campaign.findMany({
      where: {
        ...campaignScope,
        status: { in: ["PENDING_APPROVAL", "APPROVED", "SENDING", "PAUSED"] },
      },
      include: campaignSummaryInclude,
      orderBy: { updatedAt: "desc" },
    });
    const campaigns = await toCampaignSummaries(campaignRows);
    const campaignIds = campaignRows.map((campaign) => campaign.id);
    const pendingApproval = campaigns.filter((campaign) => campaign.status === "PENDING_APPROVAL");
    const readyToSend = campaigns.filter((campaign) => campaign.status === "APPROVED");
    const drafts = campaigns.filter((campaign) => campaign.status === "DRAFT");
    const campaignsNeedingAttention = campaigns.filter(
      (campaign) => campaign.status === "PAUSED" || campaign.counts.failed > 0 || campaign.counts.unknown > 0
    );

    const emptyQueue: WorkspaceQueueDto = {
      campaigns,
      pendingApproval,
      readyToSend,
      drafts,
      campaignsNeedingAttention,
      replies: [],
      dueFollowUps: [],
      failedSends: [],
      unknownSends: [],
      counts: {
        replies: 0,
        dueFollowUps: 0,
        failedSends: 0,
        unknownSends: 0,
        pendingApproval: pendingApproval.length,
        readyToSend: readyToSend.length,
      },
    };

    if (!campaignIds.length) return ok(res, emptyQueue);

    const now = new Date();
    const baseSendWhere: Prisma.SendWhereInput = { campaignId: { in: campaignIds } };
    const [replyCount, dueFollowUpCount, failedCount, unknownCount, replyRows, followUpRows, failedRows, unknownRows] =
      await Promise.all([
        prisma.send.count({ where: { ...baseSendWhere, repliedAt: { not: null } } }),
        prisma.send.count({
          where: {
            ...baseSendWhere,
            status: "PENDING",
            stepIndex: { gt: 0 },
            approvedAt: { not: null },
            scheduledFor: { lte: now },
          },
        }),
        prisma.send.count({ where: { ...baseSendWhere, status: "FAILED" } }),
        prisma.send.count({ where: { ...baseSendWhere, status: "UNKNOWN" } }),
        prisma.send.findMany({
          where: { ...baseSendWhere, repliedAt: { not: null } },
          include: {
            campaign: { select: { id: true, name: true } },
            contact: { select: { firstName: true, lastName: true } },
            events: {
              where: { type: "REPLY" },
              select: { detail: true },
              orderBy: { occurredAt: "desc" },
              take: 1,
            },
          },
          orderBy: { repliedAt: "desc" },
          take: 12,
        }),
        prisma.send.findMany({
          where: {
            ...baseSendWhere,
            status: "PENDING",
            stepIndex: { gt: 0 },
            approvedAt: { not: null },
            scheduledFor: { lte: now },
          },
          include: { campaign: { select: { id: true, name: true } }, contact: { select: { firstName: true, lastName: true } } },
          orderBy: { scheduledFor: "asc" },
          take: 12,
        }),
        prisma.send.findMany({
          where: { ...baseSendWhere, status: "FAILED" },
          include: { campaign: { select: { id: true, name: true } }, contact: { select: { firstName: true, lastName: true } } },
          orderBy: { updatedAt: "desc" },
          take: 12,
        }),
        prisma.send.findMany({
          where: { ...baseSendWhere, status: "UNKNOWN" },
          include: { campaign: { select: { id: true, name: true } }, contact: { select: { firstName: true, lastName: true } } },
          orderBy: { updatedAt: "desc" },
          take: 12,
        }),
      ]);

    const toQueueSend = (send: (typeof replyRows)[number] | (typeof followUpRows)[number]) => {
      const replyDetail = ("events" in send && Array.isArray(send.events) && send.events[0]?.detail)
        ? (send.events[0].detail as Record<string, unknown>)
        : null;
      return {
        id: send.id,
        campaignId: send.campaign.id,
        campaignName: send.campaign.name,
        contactId: send.contactId,
        contactName: [send.contact?.firstName, send.contact?.lastName].filter(Boolean).join(" ") || null,
        email: send.email,
        status: send.status,
        stepIndex: send.stepIndex,
        lastError: send.lastError,
        sentAt: send.sentAt?.toISOString() ?? null,
        repliedAt: send.repliedAt?.toISOString() ?? null,
        scheduledFor: send.scheduledFor?.toISOString() ?? null,
        subject: send.subject ?? null,
        classification: (replyDetail?.classification as string | undefined) ?? (replyDetail?.sentiment as string | undefined) ?? null,
        snippet: (replyDetail?.snippet as string | undefined) ?? null,
      };
    };

    const result: WorkspaceQueueDto = {
      ...emptyQueue,
      replies: replyRows.map(toQueueSend),
      dueFollowUps: followUpRows.map(toQueueSend),
      failedSends: failedRows.map(toQueueSend),
      unknownSends: unknownRows.map(toQueueSend),
      counts: {
        replies: replyCount,
        dueFollowUps: dueFollowUpCount,
        failedSends: failedCount,
        unknownSends: unknownCount,
        pendingApproval: pendingApproval.length,
        readyToSend: readyToSend.length,
      },
    };
    ok(res, result);
  })
);

export const mailboxRouter = Router();

mailboxRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const [accessibleMailboxes, imap] = await Promise.all([
      listAccessibleMailboxes(user.id),
      getImapState(user.id),
    ]);
    const server = personalMailboxServerSettings();
    const accountConfigured = accessibleMailboxes.length > 0;
    const primaryMailbox = accessibleMailboxes.find((m) => m.isDefault) || accessibleMailboxes[0] || null;

    let allMailboxes = undefined;
    let teamMailboxHealth = undefined;

    if (user.role !== "EMPLOYEE") {
      allMailboxes = await listAllMailboxAccounts();
      const activeUsers = await prisma.user.count({ where: { status: "ACTIVE" } });
      const distinctAssignedUsers = new Set<string>();
      allMailboxes.forEach((m) => m.assignedUsers.forEach((u) => distinctAssignedUsers.add(u.userId)));
      
      const states = await Promise.all(allMailboxes.map((m) => getImapState(m.id)));
      teamMailboxHealth = {
        activeUsers,
        connectedMailboxes: allMailboxes.length,
        inboxErrors: states.filter((s) => Boolean(s.lastError)).length,
        inboxesNotChecked: server.imapPollingEnabled
          ? states.filter((s) => !s.lastCheckedAt).length + Math.max(0, activeUsers - distinctAssignedUsers.size)
          : 0,
      };
    }

    const blocker = liveSendingBlocker();
    const data: MailboxStatusDto = {
      smtp: {
        configured: accountConfigured,
        host: server.smtpHost,
        port: server.smtpPort,
        secure: server.smtpSecure,
        user: primaryMailbox?.email ?? null,
        fromEmail: primaryMailbox?.email ?? null,
        fromName: primaryMailbox?.senderName || primaryMailbox?.fromName || user.name,
      },
      imap: {
        configured: accountConfigured,
        enabled: accountConfigured && server.imapPollingEnabled,
        host: server.imapHost,
        port: server.imapPort,
        lastCheckedAt: imap.lastCheckedAt ?? null,
        lastError: imap.lastError ?? null,
        unmatchedReplies: imap.unmatchedReplies ?? [],
      },
      ...(teamMailboxHealth ? { teamMailboxHealth } : {}),
      accessibleMailboxes,
      ...(allMailboxes ? { allMailboxes } : {}),
      liveSendingEnabled: !blocker && accountConfigured,
      liveSendingBlocker: blocker ?? (!accountConfigured ? "Connect or assign a SpaceMail mailbox before sending campaigns." : null),
      dailyLimit: env.DAILY_SEND_LIMIT,
      sentLast24h: await sentInLast24h(),
      publicUrl: env.PUBLIC_URL,
    };
    ok(res, data);
  })
);

/** Connects or updates a shared SpaceMail mailbox */
mailboxRouter.post(
  "/connect",
  asyncHandler(async (req, res) => {
    const parsed = ConnectMailboxInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.badRequest("INVALID_MAILBOX", "Enter a valid SpaceMail email address, password, and sender display name.");
    }
    const result = await connectOrUpdateMailbox(req.user!, parsed.data);
    await audit(req, {
      action: "mailbox.connect",
      entityType: "MailboxAccount",
      entityId: result.mailboxId,
      metadata: { email: result.email },
    });
    ok(res, result);
  })
);

/** Backward compatibility alias for connect */
mailboxRouter.post(
  "/update-account",
  asyncHandler(async (req, res) => {
    const parsed = ConnectMailboxInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.badRequest("INVALID_MAILBOX", "Enter a valid mailbox email, password, and sender name.");
    }
    const result = await connectOrUpdateMailbox(req.user!, parsed.data);
    ok(res, result);
  })
);

/** Assigns a user to a shared mailbox */
mailboxRouter.post(
  "/:id/assign-user",
  requirePermission("settings.view"),
  asyncHandler(async (req, res) => {
    const mailboxId = IdSchema.parse(req.params.id);
    const parsed = AssignMailboxUserInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.badRequest("INVALID_ASSIGNMENT", "Valid user ID and sender name are required.");
    }
    const result = await assignUserToMailbox(req.user!, mailboxId, {
      userId: parsed.data.userId,
      senderName: parsed.data.senderName ?? undefined,
      isDefault: parsed.data.isDefault,
    });
    await audit(req, {
      action: "mailbox.assign_user",
      entityType: "MailboxAccount",
      entityId: mailboxId,
      metadata: { assignedUserId: parsed.data.userId, senderName: result.senderName },
    });
    ok(res, result);
  })
);

/** Updates user sender name or default status for a mailbox */
mailboxRouter.patch(
  "/:id/users/:userId",
  asyncHandler(async (req, res) => {
    const mailboxId = IdSchema.parse(req.params.id);
    const targetUserId = IdSchema.parse(req.params.userId);
    const parsed = UpdateMailboxUserInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.badRequest("INVALID_REQUEST", "Invalid sender update data.");
    }
    await updateMailboxUserAccess(req.user!, mailboxId, targetUserId, {
      senderName: parsed.data.senderName ?? undefined,
      isDefault: parsed.data.isDefault,
    });
    ok(res, { ok: true });
  })
);

/** Unassigns a user from a mailbox */
mailboxRouter.delete(
  "/:id/users/:userId",
  asyncHandler(async (req, res) => {
    const mailboxId = IdSchema.parse(req.params.id);
    const targetUserId = IdSchema.parse(req.params.userId);
    await removeUserFromMailbox(req.user!, mailboxId, targetUserId);
    await audit(req, {
      action: "mailbox.unassign_user",
      entityType: "MailboxAccount",
      entityId: mailboxId,
      metadata: { unassignedUserId: targetUserId },
    });
    ok(res, { ok: true });
  })
);

/** Disconnects/deletes a mailbox account. Founder only. */
mailboxRouter.delete(
  "/:id",
  requirePermission("settings.manage"),
  asyncHandler(async (req, res) => {
    const mailboxId = IdSchema.parse(req.params.id);
    await deleteMailboxAccount(req.user!, mailboxId);
    await audit(req, {
      action: "mailbox.delete",
      entityType: "MailboxAccount",
      entityId: mailboxId,
    });
    ok(res, { ok: true });
  })
);

/** Signs in to SMTP to check the credentials. Sends nothing. */
mailboxRouter.post(
  "/test-smtp",
  asyncHandler(async (req, res) => {
    try {
      const mailboxId = req.body?.mailboxId ? String(req.body.mailboxId) : undefined;
      const mailbox = await getMailboxCredentialsForUser(req.user!.id, mailboxId);
      if (!mailbox) throw AppError.conflict("MAILBOX_NOT_CONFIGURED", "Connect or assign a SpaceMail mailbox first.");
      await verifyMailbox(mailbox);
      await verifyImapMailbox(mailbox);
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error("[mailbox] connection test failed:", err);
      throw AppError.badRequest("MAILBOX_CONNECTION_FAILED", "Couldn't verify the mailbox connection. Check credentials and try again.");
    }
    ok(res, { ok: true });
  })
);

/** Reads the inbox once now (read-only) for bounces and replies */
mailboxRouter.post(
  "/check-inbox",
  asyncHandler(async (req, res) => {
    const mailboxId = req.body?.mailboxId ? String(req.body.mailboxId) : undefined;
    const mailbox = await getMailboxCredentialsForUser(req.user!.id, mailboxId);
    if (!mailbox) {
      throw AppError.conflict("MAILBOX_NOT_CONFIGURED", "Connect or assign a SpaceMail mailbox first.");
    }
    try {
      ok(res, await checkInbox(mailbox.accountId || req.user!.id));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError || err instanceof Prisma.PrismaClientInitializationError) {
        throw err;
      }
      console.error(`[mailbox] inbox check failed:`, err);
      throw AppError.badRequest("IMAP_FAILED", "Couldn't check the inbox. Please verify connection and try again.");
    }
  })
);

/** Toggles ALLOW_LIVE_SENDING on or off */
mailboxRouter.post(
  "/live-sending",
  requirePermission("settings.manage"),
  asyncHandler(async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== "boolean") {
      throw AppError.badRequest("INVALID_REQUEST", "The 'enabled' boolean is required.");
    }
    const { setLiveSending } = await import("../services/mailbox-config.js");
    const result = await setLiveSending(enabled);
    ok(res, result);
  })
);

mailboxRouter.delete(
  "/account",
  asyncHandler(async (req, res) => {
    await removePersonalMailbox(req.user!.id);
    ok(res, { success: true });
  })
);

export const activityRouter = Router();

activityRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { page, pageSize } = PaginationQuerySchema.parse(req.query);
    const user = req.user!;
    let where: import("@prisma/client").Prisma.AuditLogWhereInput = { action: { not: "auth.login" } };

    if (user.role === "EMPLOYEE") {
      const myCampaigns = await prisma.campaign.findMany({
        where: {
          OR: [{ createdById: user.id }, { collaborators: { some: { userId: user.id } } }],
        },
        select: { id: true },
      });
      const myCampaignIds = myCampaigns.map((c) => c.id);

      where = {
        action: { not: "auth.login" },
        OR: [
          { userId: user.id },
          ...(myCampaignIds.length ? [{ entityType: "Campaign", entityId: { in: myCampaignIds } }] : []),
        ],
      };
    }

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, include: { user: { select: { id: true, name: true } } }, ...skipTake(page, pageSize) }),
      prisma.auditLog.count({ where }),
    ]);
    const data: ActivityDto[] = rows.map((r) => ({
      id: r.id,
      action: r.action,
      summary: summarize(r.action, r.metadata),
      entityType: r.entityType,
      entityId: r.entityId,
      user: r.user,
      createdAt: r.createdAt.toISOString(),
    }));
    okPage(res, data, page, pageSize, total);
  })
);
