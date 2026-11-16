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

  // 3. Period metric aggregations
  const periodMetrics = async (pStart: Date, pEnd: Date) => {
    if (!matchingCampaignIds.length || pStart >= pEnd) {
      return {
        distinctReached: 0,
        started: 0,
        sent: 0,
        bounced: 0,
        replied: 0,
        positiveReplies: 0,
        meetingsBooked: 0,
        unsubscribed: 0,
      };
    }

    const [sends, outcomes] = await Promise.all([
      prisma.$queryRaw<{
        distinctReached: bigint;
        started: bigint;
        sent: bigint;
        bounced: bigint;
        replied: bigint;
        unsubscribed: bigint;
      }[]>`
        SELECT
          COUNT(DISTINCT email) FILTER (WHERE status = 'SENT' AND "sentAt" >= ${pStart} AND "sentAt" < ${pEnd}) AS "distinctReached",
          COUNT(*) FILTER (WHERE "stepIndex" = 0 AND "sentAt" >= ${pStart} AND "sentAt" < ${pEnd}) AS started,
          COUNT(*) FILTER (WHERE status = 'SENT' AND "sentAt" >= ${pStart} AND "sentAt" < ${pEnd}) AS sent,
          COUNT(*) FILTER (WHERE "bouncedAt" >= ${pStart} AND "bouncedAt" < ${pEnd}) AS bounced,
          COUNT(*) FILTER (WHERE "repliedAt" >= ${pStart} AND "repliedAt" < ${pEnd}) AS replied,
          COUNT(*) FILTER (WHERE "unsubscribedAt" >= ${pStart} AND "unsubscribedAt" < ${pEnd}) AS unsubscribed
        FROM sends
        WHERE "campaignId" = ANY(${matchingCampaignIds})
          AND (
            ("sentAt" >= ${pStart} AND "sentAt" < ${pEnd})
            OR ("bouncedAt" >= ${pStart} AND "bouncedAt" < ${pEnd})
            OR ("repliedAt" >= ${pStart} AND "repliedAt" < ${pEnd})
            OR ("unsubscribedAt" >= ${pStart} AND "unsubscribedAt" < ${pEnd})
          )`,
      prisma.$queryRaw<{ positiveReplies: bigint; meetingsBooked: bigint }[]>`
        SELECT
          COUNT(DISTINCT "sendId") FILTER (
            WHERE "type" = 'REPLY'
              AND ("detail"->>'classification' = 'POSITIVE'
                   OR lower("detail"->>'sentiment') = 'positive'
                   OR "detail"->>'meetingBooked' = 'true'
                   OR "detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
          ) AS "positiveReplies",
          COUNT(DISTINCT "sendId") FILTER (
            WHERE "type" = 'REPLY'
              AND ("detail"->>'meetingBooked' = 'true' OR "detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
          ) AS "meetingsBooked"
        FROM send_events
        WHERE "occurredAt" >= ${pStart} AND "occurredAt" < ${pEnd}
          AND "sendId" IN (SELECT id FROM sends WHERE "campaignId" = ANY(${matchingCampaignIds}))`,
    ]);

    const send = sends[0];
    const outcome = outcomes[0];
    return {
      distinctReached: Number(send?.distinctReached ?? 0),
      started: Number(send?.started ?? 0),
      sent: Number(send?.sent ?? 0),
      bounced: Number(send?.bounced ?? 0),
      replied: Number(send?.replied ?? 0),
      positiveReplies: Number(outcome?.positiveReplies ?? 0),
      meetingsBooked: Number(outcome?.meetingsBooked ?? 0),
      unsubscribed: Number(send?.unsubscribed ?? 0),
    };
  };

  const [currentMetrics, prevMetrics] = await Promise.all([
    periodMetrics(start, end),
    periodMetrics(prevStart, prevEnd),
  ]);

  // Total Outreach / Contacts Reached
  const totalReached = currentMetrics.distinctReached || currentMetrics.sent;
  const previousReached = prevMetrics.distinctReached || prevMetrics.sent;

  // Inbound Replies
  const replies = currentMetrics.replied;
  const previousReplies = prevMetrics.replied;
  const replyRate = totalReached > 0 ? Number(((replies / totalReached) * 100).toFixed(1)) : 0;

  // Positive Outcomes (Interested or meeting booked)
  const positiveOutcomes = currentMetrics.positiveReplies;
  const previousPositiveOutcomes = prevMetrics.positiveReplies;
  const positiveRate = replies > 0 ? Number(((positiveOutcomes / replies) * 100).toFixed(1)) : 0;

  // Active Outreach
  const activeCampaigns = allMatchingCampaigns.filter((c) =>
    ["SENDING", "APPROVED", "PAUSED"].includes(c.status)
  );
  const activeOutreachCampaigns = activeCampaigns.length;
  const totalCampaigns = allMatchingCampaigns.length;

  // Funnel: Reached → Replies → Positive Outcomes → Meetings/Opportunities
  const meetings = currentMetrics.meetingsBooked;
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

  // 4. Outreach by Type Breakdown
  const outreachByType: OutreachTypeMetricDto[] = [];
  for (const oType of CAMPAIGN_OUTREACH_TYPES) {
    const campaignsOfType = allMatchingCampaigns.filter((c) => (c.outreachType as string) === oType);
    const cIds = campaignsOfType.map((c) => c.id);
    let reachedCount = 0;
    let repliesCount = 0;
    let positiveCount = 0;

    if (cIds.length > 0) {
      const [typeSends, typeOutcomes] = await Promise.all([
        prisma.$queryRaw<{ distinctReached: bigint; replied: bigint }[]>`
          SELECT
            COUNT(DISTINCT email) FILTER (WHERE status = 'SENT' AND "sentAt" >= ${start} AND "sentAt" < ${end}) AS "distinctReached",
            COUNT(*) FILTER (WHERE "repliedAt" >= ${start} AND "repliedAt" < ${end}) AS replied
          FROM sends
          WHERE "campaignId" = ANY(${cIds})`,
        prisma.$queryRaw<{ positiveReplies: bigint }[]>`
          SELECT
            COUNT(DISTINCT "sendId") AS "positiveReplies"
          FROM send_events
          WHERE "occurredAt" >= ${start} AND "occurredAt" < ${end}
            AND "type" = 'REPLY'
            AND ("detail"->>'classification' = 'POSITIVE'
                 OR lower("detail"->>'sentiment') = 'positive'
                 OR "detail"->>'meetingBooked' = 'true'
                 OR "detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
            AND "sendId" IN (SELECT id FROM sends WHERE "campaignId" = ANY(${cIds}))`,
      ]);
      reachedCount = Number(typeSends[0]?.distinctReached ?? 0);
      repliesCount = Number(typeSends[0]?.replied ?? 0);
      positiveCount = Number(typeOutcomes[0]?.positiveReplies ?? 0);
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

  // 5. Team Outreach Breakdown
  const teamOutreach: TeamOutreachMetricDto[] = [];
  const relevantUsers = allUsers.filter(
    (u) =>
      u.status === "ACTIVE" ||
      allMatchingCampaigns.some((c) => c.createdById === u.id)
  );

  for (const user of relevantUsers) {
    const userCampaigns = allMatchingCampaigns.filter((c) => c.createdById === user.id);
    const uCampaignIds = userCampaigns.map((c) => c.id);

    let assigned = 0;
    for (const c of userCampaigns) {
      assigned += c.contactList._count.members;
    }

    let reached = 0;
    let userReplies = 0;
    let userPositive = 0;
    let pendingApprovals = userCampaigns.filter((c) => c.status === "PENDING_APPROVAL").length;
    let dueFollowUps = 0;
    let deliveryExceptions = 0;

    if (uCampaignIds.length > 0) {
      const [uSends, uOutcomes, uDue, uExceptions] = await Promise.all([
        prisma.$queryRaw<{ distinctReached: bigint; replied: bigint }[]>`
          SELECT
            COUNT(DISTINCT email) FILTER (WHERE status = 'SENT' AND "sentAt" >= ${start} AND "sentAt" < ${end}) AS "distinctReached",
            COUNT(*) FILTER (WHERE "repliedAt" >= ${start} AND "repliedAt" < ${end}) AS replied
          FROM sends
          WHERE "campaignId" = ANY(${uCampaignIds})`,
        prisma.$queryRaw<{ positiveReplies: bigint }[]>`
          SELECT
            COUNT(DISTINCT "sendId") AS "positiveReplies"
          FROM send_events
          WHERE "occurredAt" >= ${start} AND "occurredAt" < ${end}
            AND "type" = 'REPLY'
            AND ("detail"->>'classification' = 'POSITIVE'
                 OR lower("detail"->>'sentiment') = 'positive'
                 OR "detail"->>'meetingBooked' = 'true'
                 OR "detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
            AND "sendId" IN (SELECT id FROM sends WHERE "campaignId" = ANY(${uCampaignIds}))`,
        prisma.send.count({
          where: {
            campaignId: { in: uCampaignIds },
            status: "PENDING",
            stepIndex: { gt: 0 },
            approvedAt: { not: null },
            scheduledFor: { lte: now },
          },
        }),
        prisma.send.count({
          where: {
            campaignId: { in: uCampaignIds },
            status: { in: ["FAILED", "UNKNOWN"] },
          },
        }),
      ]);
      reached = Number(uSends[0]?.distinctReached ?? 0);
      userReplies = Number(uSends[0]?.replied ?? 0);
      userPositive = Number(uOutcomes[0]?.positiveReplies ?? 0);
      dueFollowUps = uDue;
      deliveryExceptions = uExceptions;
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

    // Unanswered replies
    const recentReplies = await prisma.send.findMany({
      where: {
        campaignId: { in: matchingCampaignIds },
        repliedAt: { not: null },
      },
      include: {
        campaign: { select: { id: true, name: true } },
        contact: { select: { firstName: true, lastName: true } },
      },
      orderBy: { repliedAt: "desc" },
      take: 5,
    });

    for (const reply of recentReplies) {
      const contactName = [reply.contact?.firstName, reply.contact?.lastName].filter(Boolean).join(" ") || reply.email;
      actionableAttention.push({
        id: `reply-${reply.id}`,
        type: "UNANSWERED_REPLY",
        title: `Inbound reply from ${contactName}`,
        subtitle: `Campaign: ${reply.campaign.name} · Action required to reply and qualify conversation`,
        link: `/campaigns/${reply.campaign.id}?tab=recipients&filter=replied`,
        linkLabel: "Open conversation →",
        severity: "high",
        createdAt: reply.repliedAt?.toISOString(),
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

  // 8. Active campaigns with outcomes
  const activeSummaries = await toCampaignSummaries(activeCampaignsRaw);
  const activeWithOutcomes: ActiveCampaignOutreachDto[] = [];

  for (const sum of activeSummaries) {
    let posCount = 0;
    let meetCount = 0;
    if (sum.counts.sent > 0) {
      const outcomes = await prisma.$queryRaw<{ positiveReplies: bigint; meetingsBooked: bigint }[]>`
        SELECT
          COUNT(DISTINCT "sendId") FILTER (
            WHERE "type" = 'REPLY'
              AND ("detail"->>'classification' = 'POSITIVE'
                   OR lower("detail"->>'sentiment') = 'positive'
                   OR "detail"->>'meetingBooked' = 'true'
                   OR "detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
          ) AS "positiveReplies",
          COUNT(DISTINCT "sendId") FILTER (
            WHERE "type" = 'REPLY'
              AND ("detail"->>'meetingBooked' = 'true' OR "detail"->>'meetingOutcome' IN ('BOOKED', 'QUALIFIED'))
          ) AS "meetingsBooked"
        FROM send_events
        WHERE "sendId" IN (SELECT id FROM sends WHERE "campaignId" = ${sum.id})`;
      posCount = Number(outcomes[0]?.positiveReplies ?? 0);
      meetCount = Number(outcomes[0]?.meetingsBooked ?? 0);
    }

    activeWithOutcomes.push({
      ...sum,
      outreachType: (sum.outreachType as CampaignOutreachType) ?? "CUSTOMER_OUTREACH",
      positiveOutcomes: posCount,
      meetingsBooked: meetCount,
    });
  }

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

