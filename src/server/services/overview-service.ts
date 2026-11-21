import prisma from "../db.js";
import { Prisma } from "@prisma/client";
import { env, liveSendingBlocker } from "../config.js";
import { sentInLast24h } from "./send-worker.js";
import { campaignSummaryInclude, toCampaignSummaries } from "../lib/serialize.js";
import {
  CAMPAIGN_OUTREACH_TYPES,
  CAMPAIGN_OUTREACH_TYPE_LABELS,
  type CampaignOutreachType,
  type OverviewDto,
  type OverviewFilterQuery,
  type OutreachTypeMetricDto,
  type TeamOutreachMetricDto,
  type DailyActivityTrendDto,
  type OutreachFunnelDto,
  type AttentionItemDto,
  type ActiveCampaignOutreachDto,
} from "../../shared/types.js";

export async function getOverviewData(filters: OverviewFilterQuery = { dateRange: "30d" }): Promise<OverviewDto> {
  const now = new Date();
  const dateRange = filters.dateRange ?? "30d";

  let start: Date;
  let end: Date = now;
  let prevStart: Date;
  let prevEnd: Date;

  if (dateRange === "7d") {
    start = new Date(now.getTime() - 7 * 86_400_000);
    prevStart = new Date(now.getTime() - 14 * 86_400_000);
    prevEnd = start;
  } else if (dateRange === "90d") {
    start = new Date(now.getTime() - 90 * 86_400_000);
    prevStart = new Date(now.getTime() - 180 * 86_400_000);
    prevEnd = start;
  } else if (dateRange === "all") {
    start = new Date(0);
    prevStart = new Date(0);
    prevEnd = new Date(0);
  } else {
    // 30d default
    start = new Date(now.getTime() - 30 * 86_400_000);
    prevStart = new Date(now.getTime() - 60 * 86_400_000);
    prevEnd = start;
  }

  // 1. Build campaign filter
  const campaignWhere: Prisma.CampaignWhereInput = {
    ...(filters.outreachType ? { outreachType: filters.outreachType } : {}),
    ...(filters.ownerId ? { createdById: filters.ownerId } : {}),
  };

  // 2. Load workspace counts, mailboxes, and matching campaigns
  const [
    countsRaw,
    sent24h,
    connectedMailboxes,
    allMatchingCampaigns,
    activeCampaignsRaw,
    recentCampaignsRaw,
    allUsers,
  ] = await Promise.all([
    prisma.$queryRaw<{ contacts: bigint; lists: bigint; templates: bigint; suppressed: bigint }[]>`
      SELECT
        (SELECT COUNT(*) FROM contacts) AS contacts,
        (SELECT COUNT(*) FROM contact_lists) AS lists,
        (SELECT COUNT(*) FROM templates) AS templates,
        (SELECT COUNT(*) FROM suppression_entries) AS suppressed`,
    sentInLast24h(),
    prisma.userMailbox.count({ where: { user: { status: "ACTIVE" } } }),
    prisma.campaign.findMany({
      where: campaignWhere,
      include: campaignSummaryInclude,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.campaign.findMany({
      where: {
        ...campaignWhere,
        status: { in: ["PENDING_APPROVAL", "APPROVED", "SENDING", "PAUSED"] },
      },
      include: campaignSummaryInclude,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.campaign.findMany({
      where: {
        ...campaignWhere,
        status: { in: ["DRAFT", "COMPLETED", "CANCELLED"] },
      },
      include: campaignSummaryInclude,
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
    prisma.user.findMany({
      select: { id: true, name: true, email: true, role: true, status: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const countsRow = countsRaw[0] ?? { contacts: 0n, lists: 0n, templates: 0n, suppressed: 0n };
  const counts = {
    contacts: Number(countsRow.contacts),
    lists: Number(countsRow.lists),
    templates: Number(countsRow.templates),
    suppressed: Number(countsRow.suppressed),
  };

  const matchingCampaignIds = allMatchingCampaigns.map((c) => c.id);

  // 3. High-performance batch metric aggregations (all in parallel, grouped by campaignId)
  type SendsRow = {
    campaignId: string;
    distinctReached: bigint;
    started: bigint;
    sent: bigint;
    bounced: bigint;
    replied: bigint;
    unsubscribed: bigint;
  };

  type ConvRow = {
    campaignId: string;
    positiveReplies: bigint;
    meetingsBooked: bigint;
  };

  type PrevSendsRow = {
    distinctReached: bigint;
    sent: bigint;
    replied: bigint;
  };

  type PrevConvRow = {
    positiveReplies: bigint;
    meetingsBooked: bigint;
  };

  type DueExceptionsRow = {
    campaignId: string;
    due: bigint;
    exceptions: bigint;
  };

  const emptySendsMap = new Map<string, { distinctReached: number; started: number; sent: number; bounced: number; replied: number; unsubscribed: number }>();
  const emptyOutcomesMap = new Map<string, { positiveReplies: number; meetingsBooked: number }>();
  const dueByCampaign = new Map<string, number>();
  const exceptionsByCampaign = new Map<string, number>();

  let totalReached = 0;
  let previousReached = 0;
  let replies = 0;
  let previousReplies = 0;
  let positiveOutcomes = 0;
  let previousPositiveOutcomes = 0;
  let meetings = 0;
  let totalStarted = 0;
  let totalSent = 0;
  let totalBounced = 0;
  let totalUnsubscribed = 0;

  if (matchingCampaignIds.length > 0) {
    const [
      sendsRows,
      prevSendsRows,
      convRows,
      prevConvRows,
      legacyRows,
      prevLegacyRows,
      dueExceptionRows,
    ] = await Promise.all([
      prisma.$queryRaw<SendsRow[]>`
        SELECT
          s."campaignId",
          COUNT(DISTINCT s.email) FILTER (WHERE s.status = 'SENT' AND s."sentAt" >= ${start} AND s."sentAt" < ${end}) AS "distinctReached",
          COUNT(*) FILTER (WHERE s."stepIndex" = 0 AND s."sentAt" >= ${start} AND s."sentAt" < ${end}) AS started,
          COUNT(*) FILTER (WHERE s.status = 'SENT' AND s."sentAt" >= ${start} AND s."sentAt" < ${end}) AS sent,
          COUNT(*) FILTER (WHERE s."bouncedAt" >= ${start} AND s."bouncedAt" < ${end}) AS bounced,
          COUNT(DISTINCT s.email) FILTER (WHERE s."repliedAt" >= ${start} AND s."repliedAt" < ${end}) AS replied,
          COUNT(*) FILTER (WHERE s."unsubscribedAt" >= ${start} AND s."unsubscribedAt" < ${end}) AS unsubscribed
        FROM sends s
        WHERE s."campaignId" = ANY(${matchingCampaignIds})
        GROUP BY s."campaignId"`,
      prisma.$queryRaw<PrevSendsRow[]>`
        SELECT
          COUNT(DISTINCT s.email) FILTER (WHERE s.status = 'SENT' AND s."sentAt" >= ${prevStart} AND s."sentAt" < ${prevEnd}) AS "distinctReached",
          COUNT(*) FILTER (WHERE s.status = 'SENT' AND s."sentAt" >= ${prevStart} AND s."sentAt" < ${prevEnd}) AS sent,
          COUNT(DISTINCT s.email) FILTER (WHERE s."repliedAt" >= ${prevStart} AND s."repliedAt" < ${prevEnd}) AS replied
        FROM sends s
        WHERE s."campaignId" = ANY(${matchingCampaignIds})`,
      prisma.$queryRaw<ConvRow[]>`
        SELECT
          c."campaignId",
          COUNT(*) FILTER (
            WHERE (c."status" IN ('INTERESTED', 'MEETING_COORDINATION', 'MEETING_SCHEDULED')
                   OR c."meetingAt" IS NOT NULL
                   OR (c."sentiment" = 'POSITIVE' AND c."status" NOT IN ('NOT_INTERESTED', 'CLOSED')))
              AND c."lastMessageAt" >= ${start} AND c."lastMessageAt" < ${end}
          ) AS "positiveReplies",
          COUNT(*) FILTER (
            WHERE (c."status" = 'MEETING_SCHEDULED' OR c."meetingAt" IS NOT NULL)
              AND c."lastMessageAt" >= ${start} AND c."lastMessageAt" < ${end}
          ) AS "meetingsBooked"
        FROM conversations c
        WHERE c."campaignId" = ANY(${matchingCampaignIds})
        GROUP BY c."campaignId"`,
      prisma.$queryRaw<PrevConvRow[]>`
        SELECT
          COUNT(*) FILTER (
            WHERE (c."status" IN ('INTERESTED', 'MEETING_COORDINATION', 'MEETING_SCHEDULED')
                   OR c."meetingAt" IS NOT NULL
                   OR (c."sentiment" = 'POSITIVE' AND c."status" NOT IN ('NOT_INTERESTED', 'CLOSED')))
              AND c."lastMessageAt" >= ${prevStart} AND c."lastMessageAt" < ${prevEnd}
          ) AS "positiveReplies",
          COUNT(*) FILTER (
            WHERE (c."status" = 'MEETING_SCHEDULED' OR c."meetingAt" IS NOT NULL)
              AND c."lastMessageAt" >= ${prevStart} AND c."lastMessageAt" < ${prevEnd}
          ) AS "meetingsBooked"
        FROM conversations c
        WHERE c."campaignId" = ANY(${matchingCampaignIds})`,
      prisma.$queryRaw<ConvRow[]>`
        SELECT
          s."campaignId",
          COUNT(DISTINCT s.email) FILTER (
            WHERE (se."detail"->>'classification' = 'POSITIVE'
                   OR lower(se."detail"->>'sentiment') = 'positive'
                   OR se."detail"->>'meetingBooked' = 'true'
                   OR se."detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
              AND se."occurredAt" >= ${start} AND se."occurredAt" < ${end}
          ) AS "positiveReplies",
          COUNT(DISTINCT s.email) FILTER (
            WHERE (se."detail"->>'meetingBooked' = 'true'
                   OR se."detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
              AND se."occurredAt" >= ${start} AND se."occurredAt" < ${end}
          ) AS "meetingsBooked"
        FROM send_events se
        JOIN sends s ON s.id = se."sendId"
        WHERE se."type" = 'REPLY'
          AND s."campaignId" = ANY(${matchingCampaignIds})
          AND NOT EXISTS (
            SELECT 1 FROM conversations c
            WHERE c."campaignId" = s."campaignId" AND lower(c."recipientEmail") = lower(s.email)
          )
        GROUP BY s."campaignId"`,
      prisma.$queryRaw<PrevConvRow[]>`
        SELECT
          COUNT(DISTINCT s.email) FILTER (
            WHERE (se."detail"->>'classification' = 'POSITIVE'
                   OR lower(se."detail"->>'sentiment') = 'positive'
                   OR se."detail"->>'meetingBooked' = 'true'
                   OR se."detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
              AND se."occurredAt" >= ${prevStart} AND se."occurredAt" < ${prevEnd}
          ) AS "positiveReplies",
          COUNT(DISTINCT s.email) FILTER (
            WHERE (se."detail"->>'meetingBooked' = 'true'
                   OR se."detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
              AND se."occurredAt" >= ${prevStart} AND se."occurredAt" < ${prevEnd}
          ) AS "meetingsBooked"
        FROM send_events se
        JOIN sends s ON s.id = se."sendId"
        WHERE se."type" = 'REPLY'
          AND s."campaignId" = ANY(${matchingCampaignIds})
          AND NOT EXISTS (
            SELECT 1 FROM conversations c
            WHERE c."campaignId" = s."campaignId" AND lower(c."recipientEmail") = lower(s.email)
          )`,
      prisma.$queryRaw<DueExceptionsRow[]>`
        SELECT
          s."campaignId",
          COUNT(*) FILTER (WHERE s.status = 'PENDING' AND s."stepIndex" > 0 AND s."approvedAt" IS NOT NULL AND s."scheduledFor" <= ${now}) AS due,
          COUNT(*) FILTER (WHERE s.status IN ('FAILED', 'UNKNOWN')) AS exceptions
        FROM sends s
        WHERE s."campaignId" = ANY(${matchingCampaignIds})
        GROUP BY s."campaignId"`,
    ]);

    for (const r of sendsRows) {
      emptySendsMap.set(r.campaignId, {
        distinctReached: Number(r.distinctReached),
        started: Number(r.started),
        sent: Number(r.sent),
        bounced: Number(r.bounced),
        replied: Number(r.replied),
        unsubscribed: Number(r.unsubscribed),
      });
      totalReached += Number(r.distinctReached || r.sent);
      totalStarted += Number(r.started);
      totalSent += Number(r.sent);
      totalBounced += Number(r.bounced);
      replies += Number(r.replied);
      totalUnsubscribed += Number(r.unsubscribed);
    }

    const prevS = prevSendsRows[0];
    previousReached = Number(prevS?.distinctReached ?? prevS?.sent ?? 0);
    previousReplies = Number(prevS?.replied ?? 0);

    for (const r of convRows) {
      emptyOutcomesMap.set(r.campaignId, {
        positiveReplies: Number(r.positiveReplies),
        meetingsBooked: Number(r.meetingsBooked),
      });
      positiveOutcomes += Number(r.positiveReplies);
      meetings += Number(r.meetingsBooked);
    }

    for (const r of legacyRows) {
      const prev = emptyOutcomesMap.get(r.campaignId) ?? { positiveReplies: 0, meetingsBooked: 0 };
      const pos = prev.positiveReplies + Number(r.positiveReplies);
      const meet = prev.meetingsBooked + Number(r.meetingsBooked);
      emptyOutcomesMap.set(r.campaignId, { positiveReplies: pos, meetingsBooked: meet });
      positiveOutcomes += Number(r.positiveReplies);
      meetings += Number(r.meetingsBooked);
    }

    const prevC = prevConvRows[0];
    const prevL = prevLegacyRows[0];
    previousPositiveOutcomes = Number(prevC?.positiveReplies ?? 0) + Number(prevL?.positiveReplies ?? 0);

    for (const r of dueExceptionRows) {
      dueByCampaign.set(r.campaignId, Number(r.due));
      exceptionsByCampaign.set(r.campaignId, Number(r.exceptions));
    }
  }

  const currentMetrics = {
    distinctReached: totalReached,
    started: totalStarted,
    sent: totalSent,
    bounced: totalBounced,
    replied: replies,
    positiveReplies: positiveOutcomes,
    meetingsBooked: meetings,
    unsubscribed: totalUnsubscribed,
  };

  const prevMetrics = {
    distinctReached: previousReached,
    started: 0,
    sent: previousReached,
    bounced: 0,
    replied: previousReplies,
    positiveReplies: previousPositiveOutcomes,
    meetingsBooked: 0,
    unsubscribed: 0,
  };

  const replyRate = totalReached > 0 ? Number(((replies / totalReached) * 100).toFixed(1)) : 0;
  const positiveRate = replies > 0 ? Number(((positiveOutcomes / replies) * 100).toFixed(1)) : 0;

  // Active Outreach
  const activeCampaigns = allMatchingCampaigns.filter((c) =>
    ["SENDING", "APPROVED", "PAUSED"].includes(c.status)
  );
  const activeOutreachCampaigns = activeCampaigns.length;
  const totalCampaigns = allMatchingCampaigns.length;

  // Funnel: Reached → Replies → Positive Outcomes → Meetings/Opportunities
  const funnel: OutreachFunnelDto = {
    reached: totalReached,
    replies,
    positiveOutcomes,
    meetings,
    replyRate,
    positiveRate,
    meetingRate: positiveOutcomes > 0 ? Number(((meetings / positiveOutcomes) * 100).toFixed(1)) : 0,
    overallConversionRate: totalReached > 0 ? Number(((meetings / totalReached) * 100).toFixed(1)) : 0,
  };

  // 4. Outreach by Type Breakdown (aggregated in-memory instantly)
  const outreachByType: OutreachTypeMetricDto[] = [];
  for (const oType of CAMPAIGN_OUTREACH_TYPES) {
    const campaignsOfType = allMatchingCampaigns.filter((c) => (c.outreachType as string) === oType);
    let reachedCount = 0;
    let repliesCount = 0;
    let positiveCount = 0;

    for (const c of campaignsOfType) {
      const s = emptySendsMap.get(c.id);
      if (s) {
        reachedCount += s.distinctReached || s.sent;
        repliesCount += s.replied;
      }
      const o = emptyOutcomesMap.get(c.id);
      if (o) {
        positiveCount += o.positiveReplies;
      }
    }

    const activeCount = campaignsOfType.filter((c) =>
      ["SENDING", "APPROVED", "PAUSED"].includes(c.status)
    ).length;

    const repRate = reachedCount > 0 ? Number(((repliesCount / reachedCount) * 100).toFixed(1)) : 0;
    const posRate = repliesCount > 0 ? Number(((positiveCount / repliesCount) * 100).toFixed(1)) : 0;

    outreachByType.push({
      outreachType: oType,
      label: CAMPAIGN_OUTREACH_TYPE_LABELS[oType],
      reached: reachedCount,
      replies: repliesCount,
      replyRate: repRate,
      positiveOutcomes: positiveCount,
      positiveRate: posRate,
      activeCampaigns: activeCount,
      totalCampaigns: campaignsOfType.length,
    });
  }

  // 5. Team Outreach Breakdown (aggregated in-memory instantly)
  const teamOutreach: TeamOutreachMetricDto[] = [];
  const relevantUsers = allUsers.filter(
    (u) =>
      u.status === "ACTIVE" ||
      allMatchingCampaigns.some((c) => c.createdById === u.id)
  );

  for (const user of relevantUsers) {
    const userCampaigns = allMatchingCampaigns.filter((c) => c.createdById === user.id);

    let assigned = 0;
    let reached = 0;
    let userReplies = 0;
    let userPositive = 0;
    let pendingApprovals = userCampaigns.filter((c) => c.status === "PENDING_APPROVAL").length;
    let dueFollowUps = 0;
    let deliveryExceptions = 0;

    for (const c of userCampaigns) {
      assigned += c.contactList._count.members;
      const s = emptySendsMap.get(c.id);
      if (s) {
        reached += s.distinctReached || s.sent;
        userReplies += s.replied;
      }
      const o = emptyOutcomesMap.get(c.id);
      if (o) {
        userPositive += o.positiveReplies;
      }
      dueFollowUps += dueByCampaign.get(c.id) ?? 0;
      deliveryExceptions += exceptionsByCampaign.get(c.id) ?? 0;
    }

    const uRepRate = reached > 0 ? Number(((userReplies / reached) * 100).toFixed(1)) : 0;
    const uPosRate = userReplies > 0 ? Number(((userPositive / userReplies) * 100).toFixed(1)) : 0;

    teamOutreach.push({
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      userRole: user.role,
      assigned,
      reached,
      replies: userReplies,
      replyRate: uRepRate,
      positiveOutcomes: userPositive,
      positiveRate: uPosRate,
      pendingWork: {
        pendingApprovals,
        dueFollowUps,
        deliveryExceptions,
        total: pendingApprovals + dueFollowUps + deliveryExceptions,
      },
    });
  }

  // 6. Simple 30-Day Activity Trend
  const activityTrend: DailyActivityTrendDto[] = [];
  const trendDays = 30;
  const dayBuckets: { dateStr: string; label: string; dStart: Date; dEnd: Date }[] = [];

  for (let i = trendDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const dEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    const dateStr = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    dayBuckets.push({ dateStr, label, dStart, dEnd });
  }

  const thirtyDaysAgo = dayBuckets[0]!.dStart;
  if (matchingCampaignIds.length > 0) {
    const [trendSends, trendOutcomes] = await Promise.all([
      prisma.$queryRaw<{ day: string; reached: bigint; replies: bigint }[]>`
        SELECT
          to_char("sentAt", 'YYYY-MM-DD') AS day,
          COUNT(*) FILTER (WHERE status = 'SENT') AS reached,
          COUNT(*) FILTER (WHERE "repliedAt" IS NOT NULL) AS replies
        FROM sends
        WHERE "campaignId" = ANY(${matchingCampaignIds})
          AND "sentAt" >= ${thirtyDaysAgo} AND "sentAt" <= ${now}
        GROUP BY day`,
      prisma.$queryRaw<{ day: string; positiveReplies: bigint }[]>`
        SELECT
          to_char("occurredAt", 'YYYY-MM-DD') AS day,
          COUNT(DISTINCT "sendId") AS "positiveReplies"
        FROM send_events
        WHERE "occurredAt" >= ${thirtyDaysAgo} AND "occurredAt" <= ${now}
          AND "type" = 'REPLY'
          AND ("detail"->>'classification' = 'POSITIVE'
               OR lower("detail"->>'sentiment') = 'positive'
               OR "detail"->>'meetingBooked' = 'true'
               OR "detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
          AND "sendId" IN (SELECT id FROM sends WHERE "campaignId" = ANY(${matchingCampaignIds}))
        GROUP BY day`,
    ]);

    const sendMap = new Map(trendSends.map((r) => [r.day, { reached: Number(r.reached), replies: Number(r.replies) }]));
    const outcomeMap = new Map(trendOutcomes.map((r) => [r.day, Number(r.positiveReplies)]));

    for (const b of dayBuckets) {
      const s = sendMap.get(b.dateStr) ?? { reached: 0, replies: 0 };
      const pos = outcomeMap.get(b.dateStr) ?? 0;
      activityTrend.push({
        date: b.dateStr,
        label: b.label,
        reached: s.reached,
        replies: s.replies,
        positiveOutcomes: pos,
      });
    }
  } else {
    for (const b of dayBuckets) {
      activityTrend.push({
        date: b.dateStr,
        label: b.label,
        reached: 0,
        replies: 0,
        positiveOutcomes: 0,
      });
    }
  }

  // 7. Actionable Needs Attention
  const actionableAttention: AttentionItemDto[] = [];

  // Overdue follow-ups
  if (matchingCampaignIds.length > 0) {
    const dueSends = await prisma.send.findMany({
      where: {
        campaignId: { in: matchingCampaignIds },
        status: "PENDING",
        stepIndex: { gt: 0 },
        approvedAt: { not: null },
        scheduledFor: { lte: now },
      },
      include: {
        campaign: { select: { id: true, name: true } },
        contact: { select: { firstName: true, lastName: true } },
      },
      orderBy: { scheduledFor: "asc" },
      take: 5,
    });

    for (const send of dueSends) {
      const contactName = [send.contact?.firstName, send.contact?.lastName].filter(Boolean).join(" ") || send.email;
      actionableAttention.push({
        id: `due-${send.id}`,
        type: "OVERDUE_FOLLOW_UP",
        title: `Overdue follow-up for ${contactName}`,
        subtitle: `Campaign: ${send.campaign.name} (Step ${send.stepIndex}) · Scheduled for ${send.scheduledFor?.toLocaleDateString() ?? "now"}`,
        link: `/campaigns/${send.campaign.id}?tab=recipients&filter=scheduled`,
        linkLabel: "Dispatch touch →",
        severity: "medium",
        createdAt: send.scheduledFor?.toISOString(),
      });
    }

    // Unanswered replies and conversation action items
    const needsReplyConvs = await prisma.conversation.findMany({
      where: {
        campaignId: { in: matchingCampaignIds },
        status: "NEEDS_REPLY",
      },
      include: {
        campaign: { select: { id: true, name: true } },
        contact: { select: { firstName: true, lastName: true } },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 5,
    });

    for (const conv of needsReplyConvs) {
      const contactName = [conv.contact?.firstName, conv.contact?.lastName].filter(Boolean).join(" ") || conv.recipientEmail;
      actionableAttention.push({
        id: `conv-reply-${conv.id}`,
        type: "UNANSWERED_REPLY",
        title: `Inbound reply from ${contactName}`,
        subtitle: conv.snippet ? `"${conv.snippet.slice(0, 90)}"` : `Awaiting response on ${conv.campaign.name}`,
        link: `/campaigns/${conv.campaignId}?tab=recipients&recipient=${encodeURIComponent(conv.recipientEmail)}`,
        linkLabel: "Open conversation →",
        severity: "high",
        createdAt: conv.lastMessageAt.toISOString(),
      });
    }

    if (needsReplyConvs.length < 5) {
      const remainingSlots = 5 - needsReplyConvs.length;
      const recentReplies = await prisma.send.findMany({
        where: {
          campaignId: { in: matchingCampaignIds },
          repliedAt: { not: null },
          conversation: null,
        },
        include: {
          campaign: { select: { id: true, name: true } },
          contact: { select: { firstName: true, lastName: true } },
        },
        orderBy: { repliedAt: "desc" },
        take: remainingSlots,
      });

      for (const reply of recentReplies) {
        const contactName = [reply.contact?.firstName, reply.contact?.lastName].filter(Boolean).join(" ") || reply.email;
        actionableAttention.push({
          id: `reply-${reply.id}`,
          type: "UNANSWERED_REPLY",
          title: `Inbound reply from ${contactName}`,
          subtitle: `Campaign: ${reply.campaign.name} · Action required to reply and qualify conversation`,
          link: `/campaigns/${reply.campaign.id}?tab=recipients&recipient=${encodeURIComponent(reply.email)}`,
          linkLabel: "Open conversation →",
          severity: "high",
          createdAt: reply.repliedAt?.toISOString(),
        });
      }
    }

    // Meeting coordination in progress
    const meetingCoordConvs = await prisma.conversation.findMany({
      where: {
        campaignId: { in: matchingCampaignIds },
        status: "MEETING_COORDINATION",
      },
      include: {
        campaign: { select: { id: true, name: true } },
        contact: { select: { firstName: true, lastName: true } },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 4,
    });

    for (const conv of meetingCoordConvs) {
      const contactName = [conv.contact?.firstName, conv.contact?.lastName].filter(Boolean).join(" ") || conv.recipientEmail;
      actionableAttention.push({
        id: `conv-coord-${conv.id}`,
        type: "MEETING_COORDINATION",
        title: `Meeting coordination: ${contactName}`,
        subtitle: conv.meetingNotes || `Aligning meeting time on ${conv.campaign.name}`,
        link: `/campaigns/${conv.campaignId}?tab=recipients&recipient=${encodeURIComponent(conv.recipientEmail)}`,
        linkLabel: "Coordinate meeting →",
        severity: "medium",
        createdAt: conv.lastMessageAt.toISOString(),
      });
    }

    // Overdue conversation next actions
    const overdueActionConvs = await prisma.conversation.findMany({
      where: {
        campaignId: { in: matchingCampaignIds },
        nextActionDueAt: { lte: now },
        status: { notIn: ["CLOSED", "NOT_INTERESTED"] },
      },
      include: {
        campaign: { select: { id: true, name: true } },
        contact: { select: { firstName: true, lastName: true } },
      },
      orderBy: { nextActionDueAt: "asc" },
      take: 4,
    });

    for (const conv of overdueActionConvs) {
      const contactName = [conv.contact?.firstName, conv.contact?.lastName].filter(Boolean).join(" ") || conv.recipientEmail;
      actionableAttention.push({
        id: `conv-action-${conv.id}`,
        type: "OVERDUE_ACTION",
        title: `Overdue action: ${conv.nextAction || "Follow-up"} (${contactName})`,
        subtitle: `Due ${conv.nextActionDueAt?.toLocaleDateString()} · ${conv.campaign.name}`,
        link: `/campaigns/${conv.campaignId}?tab=recipients&recipient=${encodeURIComponent(conv.recipientEmail)}`,
        linkLabel: "Take action →",
        severity: "high",
        createdAt: conv.nextActionDueAt?.toISOString(),
      });
    }
  }

  // Pending Approvals
  const pendingApprovalsList = allMatchingCampaigns.filter((c) => c.status === "PENDING_APPROVAL");
  for (const campaign of pendingApprovalsList) {
    actionableAttention.push({
      id: `approval-${campaign.id}`,
      type: "PENDING_APPROVAL",
      title: `Campaign approval needed: ${campaign.name}`,
      subtitle: `Submitted by ${campaign.createdBy?.name || "Team member"} · Ready for review`,
      link: `/campaigns/${campaign.id}?tab=review`,
      linkLabel: "Review & Approve →",
      severity: "high",
      createdAt: campaign.updatedAt.toISOString(),
    });
  }

  // Mailbox Issues
  const blocker = liveSendingBlocker();
  if (connectedMailboxes === 0) {
    actionableAttention.push({
      id: "mailbox-none",
      type: "MAILBOX_ISSUE",
      title: "No outreach mailboxes connected",
      subtitle: "Connect a SpaceMail email account to enable live sending for your workspace.",
      link: "/settings/mailbox",
      linkLabel: "Connect mailbox →",
      severity: "high",
    });
  } else if (blocker) {
    actionableAttention.push({
      id: "mailbox-blocker",
      type: "MAILBOX_ISSUE",
      title: "Live sending paused by safeguard",
      subtitle: blocker,
      link: "/settings/mailbox",
      linkLabel: "Resolve issue →",
      severity: "high",
    });
  }

  // Delivery exceptions on campaigns
  const issueByCampaign = new Map<string, { failed: number; unknown: number }>();
  if (matchingCampaignIds.length > 0) {
    const attention = await prisma.send.groupBy({
      by: ["campaignId", "status"],
      where: {
        campaignId: { in: matchingCampaignIds },
        status: { in: ["FAILED", "UNKNOWN"] },
      },
      _count: { _all: true },
    });
    for (const row of attention) {
      const entry = issueByCampaign.get(row.campaignId) ?? { failed: 0, unknown: 0 };
      if (row.status === "FAILED") entry.failed += row._count._all;
      else entry.unknown += row._count._all;
      issueByCampaign.set(row.campaignId, entry);
    }
    for (const [cId, issues] of issueByCampaign.entries()) {
      const c = allMatchingCampaigns.find((item) => item.id === cId);
      if (c && (issues.failed > 0 || issues.unknown > 0)) {
        actionableAttention.push({
          id: `exception-${cId}`,
          type: "DELIVERY_EXCEPTION",
          title: `Delivery issues on ${c.name}`,
          subtitle: `${issues.failed > 0 ? `${issues.failed} failed send(s)` : ""} ${issues.unknown > 0 ? `${issues.unknown} to review` : ""}`.trim(),
          link: `/campaigns/${cId}?tab=recipients&filter=${issues.failed > 0 ? "failed" : "unknown"}`,
          linkLabel: "Inspect recipients →",
          severity: issues.failed > 0 ? "high" : "medium",
        });
      }
    }
  }

  // 8. Active campaigns with outcomes (aggregated in-memory instantly)
  const activeSummaries = await toCampaignSummaries(activeCampaignsRaw);
  const activeWithOutcomes: ActiveCampaignOutreachDto[] = activeSummaries.map((sum) => {
    const o = emptyOutcomesMap.get(sum.id) ?? { positiveReplies: 0, meetingsBooked: 0 };
    return {
      ...sum,
      outreachType: (sum.outreachType as CampaignOutreachType) ?? "CUSTOMER_OUTREACH",
      positiveOutcomes: o.positiveReplies,
      meetingsBooked: o.meetingsBooked,
    };
  });

  // 9. Available filter options
  const distinctOwnerIds = new Set(allMatchingCampaigns.map((c) => c.createdById).filter(Boolean));
  const availableOwners = allUsers
    .filter((u) => distinctOwnerIds.has(u.id) || u.status === "ACTIVE")
    .map((u) => ({ id: u.id, name: u.name }));

  const availableOutreachTypes = CAMPAIGN_OUTREACH_TYPES.map((t) => ({
    value: t,
    label: CAMPAIGN_OUTREACH_TYPE_LABELS[t],
  }));

  const names = await prisma.campaign.findMany({
    where: { id: { in: [...issueByCampaign.keys()] } },
    select: { id: true, name: true },
  });

  // 10. Post-Reply Conversation Status Breakdown
  const convCounts = await prisma.conversation.groupBy({
    by: ["status"],
    where: matchingCampaignIds.length ? { campaignId: { in: matchingCampaignIds } } : {},
    _count: { _all: true },
  });
  const convMap = new Map<string, number>();
  let totalConversations = 0;
  for (const row of convCounts) {
    convMap.set(row.status, row._count._all);
    totalConversations += row._count._all;
  }
  const conversationBreakdown = {
    needsReply: convMap.get("NEEDS_REPLY") ?? 0,
    waitingForContact: convMap.get("WAITING_FOR_CONTACT") ?? 0,
    meetingCoordination: convMap.get("MEETING_COORDINATION") ?? 0,
    meetingScheduled: convMap.get("MEETING_SCHEDULED") ?? 0,
    interested: convMap.get("INTERESTED") ?? 0,
    notInterested: convMap.get("NOT_INTERESTED") ?? 0,
    closed: convMap.get("CLOSED") ?? 0,
    totalConversations,
  };

  return {
    counts,
    mailbox: {
      smtpConfigured: connectedMailboxes > 0,
      liveSendingEnabled: !blocker,
      liveSendingBlocker: blocker,
      dailyLimit: env.DAILY_SEND_LIMIT,
      sentLast24h: sent24h,
    },
    awaitingApproval: activeSummaries.filter((c) => c.status === "PENDING_APPROVAL"),
    inProgress: activeSummaries.filter((c) => c.status !== "PENDING_APPROVAL"),
    needsAttention: names.map((c) => ({ campaign: c, ...issueByCampaign.get(c.id)! })),
    recent: await toCampaignSummaries(recentCampaignsRaw),
    last30Days: currentMetrics,
    previous30Days: prevMetrics,

    // Extended Founder Executive outreach metrics
    kpis: {
      totalReached,
      previousReached,
      replies,
      previousReplies,
      replyRate,
      positiveOutcomes,
      previousPositiveOutcomes,
      positiveRate,
      activeOutreachCampaigns,
      totalCampaigns,
    },
    funnel,
    conversationBreakdown,
    outreachByType,
    teamOutreach,
    activityTrend,
    actionableAttention,
    activeCampaigns: activeWithOutcomes,
    availableFilters: {
      owners: availableOwners,
      outreachTypes: availableOutreachTypes,
    },
  };
}

