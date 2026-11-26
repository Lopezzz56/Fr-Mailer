import prisma from "../db.js";
import type {
  CampaignRecipientSummaryDto,
  CampaignRecipientsResponseDto,
  ConversationStatus,
  DeliveryStatus,
  Pagination,
  RecipientSequenceState,
  SendDto,
} from "../../shared/types.js";

export interface CampaignRecipientsQuery {
  page?: number;
  pageSize?: number;
  filter?: string;
  conversationStatus?: string;
  search?: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function stepLabel(stepIndex: number): string {
  return stepIndex === 0 ? "Initial" : `Step ${stepIndex + 1}`;
}

function formatShortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function matchesDeliveryFilter(
  filterKey: string,
  sends: SendDto[],
  recipientState: RecipientSequenceState | null
): boolean {
  switch (filterKey) {
    case "all":
      return true;
    case "awaiting_approval":
      return sends.some((s) => s.status === "PENDING" && Boolean(s.scheduledFor) && !s.approvedAt);
    case "scheduled":
      return sends.some((s) => s.status === "PENDING" && Boolean(s.scheduledFor));
    case "pending":
      return sends.some((s) => s.status === "PENDING" || s.status === "CLAIMED");
    case "sent":
      return sends.some((s) => s.status === "SENT");
    case "failed":
      return sends.some((s) => s.status === "FAILED");
    case "unknown":
      return sends.some((s) => s.status === "UNKNOWN");
    case "skipped":
      return sends.some((s) => s.status === "SKIPPED");
    case "cancelled":
      return sends.some((s) => s.status === "CANCELLED");
    case "bounced":
      return recipientState === "BOUNCED" || sends.some((s) => Boolean(s.bouncedAt));
    case "replied":
      return recipientState === "REPLY_RECEIVED" || sends.some((s) => Boolean(s.repliedAt));
    case "unsubscribed":
      return recipientState === "SUPPRESSED" || sends.some((s) => Boolean(s.unsubscribedAt));
    default:
      return true;
  }
}

export async function listCampaignRecipients(
  campaignId: string,
  query: CampaignRecipientsQuery = {}
): Promise<CampaignRecipientsResponseDto & { pagination: Pagination }> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.max(1, Math.min(200, query.pageSize ?? 25));
  const filter = query.filter && query.filter !== "all" ? query.filter : "all";
  const conversationStatus =
    query.conversationStatus && query.conversationStatus !== "all" ? query.conversationStatus : undefined;
  const search = query.search?.trim().toLowerCase() ?? "";

  const [sequenceStepsCount, rawSends, conversations, recipientStates] = await Promise.all([
    prisma.campaignSequenceStep.count({ where: { campaignId } }),
    prisma.send.findMany({
      where: { campaignId },
      select: {
        id: true,
        campaignId: true,
        email: true,
        contactId: true,
        subject: true,
        status: true,
        skipReason: true,
        attempts: true,
        lastError: true,
        sentAt: true,
        bouncedAt: true,
        repliedAt: true,
        unsubscribedAt: true,
        updatedAt: true,
        createdAt: true,
        templateId: true,
        templateVersion: true,
        assignmentReason: true,
        stepIndex: true,
        scheduledFor: true,
        approvedAt: true,
        inReplyToId: true,
        isCustom: true,
        contact: { select: { firstName: true, lastName: true, company: true } },
      },
      orderBy: [{ stepIndex: "asc" }, { createdAt: "asc" }],
    }),
    prisma.conversation.findMany({
      where: { campaignId },
      orderBy: { lastMessageAt: "desc" },
      select: {
        id: true,
        recipientEmail: true,
        status: true,
        snippet: true,
        outcome: true,
        meetingAt: true,
        lastMessageAt: true,
      },
    }),
    prisma.campaignRecipientState.findMany({
      where: { campaignId },
      select: {
        email: true,
        state: true,
        pausedReason: true,
      },
    }),
  ]);

  const convsByEmail = new Map<string, typeof conversations>();
  for (const conv of conversations) {
    const em = conv.recipientEmail.toLowerCase();
    const arr = convsByEmail.get(em) ?? [];
    arr.push(conv);
    convsByEmail.set(em, arr);
  }

  const stateByEmail = new Map<string, RecipientSequenceState>();
  for (const rs of recipientStates) {
    stateByEmail.set(rs.email.toLowerCase(), rs.state as RecipientSequenceState);
  }

  const sendsByEmail = new Map<string, typeof rawSends>();
  for (const s of rawSends) {
    const em = s.email.toLowerCase();
    const arr = sendsByEmail.get(em) ?? [];
    arr.push(s);
    sendsByEmail.set(em, arr);
  }

  const now = new Date();
  const summaries: CampaignRecipientSummaryDto[] = [];

  for (const [emailLower, group] of sendsByEmail.entries()) {
    const first = group[0]!;
    const recipientConvs = convsByEmail.get(emailLower) ?? [];
    const primaryConv = recipientConvs[0] ?? null;
    const recipientState = stateByEmail.get(emailLower) ?? null;

    const timeline: SendDto[] = group.map((s) => ({
      id: s.id,
      email: s.email,
      contactId: s.contactId,
      subject: s.subject,
      status: s.status as DeliveryStatus,
      skipReason: s.skipReason,
      attempts: s.attempts,
      lastError: s.lastError,
      sentAt: iso(s.sentAt),
      bouncedAt: iso(s.bouncedAt),
      repliedAt: iso(s.repliedAt),
      unsubscribedAt: iso(s.unsubscribedAt),
      updatedAt: s.updatedAt.toISOString(),
      templateId: s.templateId,
      templateVersion: s.templateVersion,
      assignmentReason: s.assignmentReason,
      stepIndex: s.stepIndex,
      scheduledFor: iso(s.scheduledFor),
      approvedAt: iso(s.approvedAt),
      inReplyToId: s.inReplyToId,
      isCustom: s.isCustom,
      contact: s.contact,
      conversation: primaryConv
        ? {
            id: primaryConv.id,
            status: primaryConv.status as ConversationStatus,
            snippet: primaryConv.snippet,
            outcome: primaryConv.outcome,
            meetingAt: iso(primaryConv.meetingAt),
          }
        : null,
    }));

    const sentSteps = new Set<number>();
    let emailsSent = 0;
    let maxStepIndex = 0;

    for (const s of group) {
      maxStepIndex = Math.max(maxStepIndex, s.stepIndex ?? 0);
      if (s.status === "SENT") {
        emailsSent++;
        sentSteps.add(s.stepIndex ?? 0);
      }
    }

    const stepsCompleted = sentSteps.size;
    const stepsTotal = Math.max(sequenceStepsCount || 1, maxStepIndex + 1);

    const hasSent = emailsSent > 0;
    const hasBounced = recipientState === "BOUNCED" || group.some((s) => Boolean(s.bouncedAt));
    const hasUnsub = recipientState === "SUPPRESSED" || group.some((s) => Boolean(s.unsubscribedAt));
    const hasReplied = recipientState === "REPLY_RECEIVED" || group.some((s) => Boolean(s.repliedAt)) || Boolean(primaryConv);
    const hasUnknown = group.some((s) => s.status === "UNKNOWN");
    const hasFailed = group.some((s) => s.status === "FAILED");
    const nextAwaiting = group.find((s) => s.status === "PENDING" && Boolean(s.scheduledFor) && !s.approvedAt);
    const nextPending = group.find((s) => s.status === "PENDING" || s.status === "CLAIMED");
    const hasCancelled = group.some((s) => s.status === "CANCELLED");

    let deliverySummary: CampaignRecipientSummaryDto["deliverySummary"] = "PENDING";
    if (hasUnknown) deliverySummary = "UNKNOWN";
    else if (hasUnsub) deliverySummary = "SKIPPED";
    else if (hasBounced && !hasSent) deliverySummary = "FAILED";
    else if (nextAwaiting) deliverySummary = "AWAITING_APPROVAL";
    else if (nextPending) {
      deliverySummary = nextPending.scheduledFor && nextPending.scheduledFor > now ? "SCHEDULED" : "PENDING";
    } else if (hasSent) deliverySummary = "SENT";
    else if (hasFailed) deliverySummary = "FAILED";
    else if (hasCancelled) deliverySummary = "CANCELLED";
    else deliverySummary = (group[group.length - 1]?.status as DeliveryStatus) ?? "PENDING";

    // Progress label (precise, never counts scheduled/approval-blocked/cancelled as completed)
    let progressLabel = `${stepsCompleted}/${stepsTotal} sent`;
    if (stepsCompleted >= stepsTotal && stepsTotal > 0) {
      progressLabel = `${stepsCompleted}/${stepsTotal} completed`;
    } else if (nextAwaiting) {
      progressLabel = `${stepsCompleted}/${stepsTotal} sent · ${stepLabel(nextAwaiting.stepIndex)} awaiting approval`;
    } else if (nextPending?.scheduledFor) {
      progressLabel = `${stepsCompleted}/${stepsTotal} sent · ${stepLabel(nextPending.stepIndex)} scheduled ${formatShortDate(nextPending.scheduledFor)}`;
    }

    // Last activity (pick latest meaningful timestamp across sends and conversation)
    let lastActivityDate: Date | null = null;
    let lastActivityLabel = "Queued";

    const considerActivity = (dt: Date | null | undefined, label: string) => {
      if (!dt) return;
      if (!lastActivityDate || dt.getTime() > lastActivityDate.getTime()) {
        lastActivityDate = dt;
        lastActivityLabel = label;
      }
    };

    for (const s of group) {
      considerActivity(s.sentAt, `${stepLabel(s.stepIndex)} sent`);
      considerActivity(s.repliedAt, "Reply received");
      considerActivity(s.bouncedAt, `${stepLabel(s.stepIndex)} bounced`);
      considerActivity(s.unsubscribedAt, "Unsubscribed");
      if (s.status === "CANCELLED" && !s.sentAt) {
        considerActivity(s.updatedAt, `${stepLabel(s.stepIndex)} cancelled`);
      } else if (s.status === "FAILED" && !s.bouncedAt) {
        considerActivity(s.updatedAt, `${stepLabel(s.stepIndex)} failed`);
      }
    }
    if (primaryConv && hasReplied) {
      considerActivity(primaryConv.lastMessageAt, "Reply received");
    }
    if (!lastActivityDate) {
      lastActivityDate = group[group.length - 1]?.updatedAt ?? null;
    }

    // Next Action
    let nextActionAt: string | null = null;
    let nextActionLabel = "No action";

    if (primaryConv?.status === "NEEDS_REPLY") {
      nextActionLabel = "Review reply";
      nextActionAt = primaryConv.lastMessageAt.toISOString();
    } else if (primaryConv?.status === "MEETING_COORDINATION") {
      nextActionLabel = "Coordinate meeting";
      nextActionAt = primaryConv.lastMessageAt.toISOString();
    } else if (primaryConv?.status === "MEETING_SCHEDULED") {
      nextActionLabel = "Meeting scheduled";
      nextActionAt = iso(primaryConv.meetingAt) ?? primaryConv.lastMessageAt.toISOString();
    } else if (hasUnknown) {
      nextActionLabel = "Review uncertain send";
    } else if (nextAwaiting) {
      nextActionAt = iso(nextAwaiting.scheduledFor);
      nextActionLabel = `Approve ${stepLabel(nextAwaiting.stepIndex)}`;
    } else if (nextPending) {
      nextActionAt = iso(nextPending.scheduledFor);
      nextActionLabel = nextPending.scheduledFor
        ? `Follow up · ${formatShortDate(nextPending.scheduledFor)}`
        : `Send ${stepLabel(nextPending.stepIndex)}`;
    } else if (hasFailed) {
      nextActionLabel = "Retry failed send";
    }

    // Choose primary send ID to open in drawer (prefer replied send, else latest active/sent send)
    const primarySend =
      group.find((s) => Boolean(s.repliedAt)) ??
      nextAwaiting ??
      nextPending ??
      [...group].reverse().find((s) => s.status === "SENT") ??
      group[0]!;

    summaries.push({
      campaignId,
      email: first.email,
      contactId: first.contactId,
      contact: first.contact,
      emailsSent,
      stepsCompleted,
      stepsTotal,
      deliverySummary,
      recipientState,
      currentConversation: primaryConv
        ? {
            id: primaryConv.id,
            status: primaryConv.status as ConversationStatus,
            snippet: primaryConv.snippet,
            outcome: primaryConv.outcome,
            meetingAt: iso(primaryConv.meetingAt),
            lastMessageAt: primaryConv.lastMessageAt.toISOString(),
          }
        : null,
      conversationCount: recipientConvs.length,
      lastActivityAt: lastActivityDate ? (lastActivityDate as Date).toISOString() : null,
      lastActivityLabel,
      nextActionAt,
      nextActionLabel,
      progressLabel,
      timeline,
      primarySendId: primarySend.id,
    });
  }

  // Sort by most recent activity descending, then email ascending
  summaries.sort((a, b) => {
    const tA = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
    const tB = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
    if (tB !== tA) return tB - tA;
    return a.email.localeCompare(b.email);
  });

  // Search filter applies to all counts & rows when searching
  const searched = search
    ? summaries.filter((r) => {
        const name = [r.contact?.firstName, r.contact?.lastName].filter(Boolean).join(" ").toLowerCase();
        const company = (r.contact?.company ?? "").toLowerCase();
        return r.email.toLowerCase().includes(search) || name.includes(search) || company.includes(search);
      })
    : summaries;

  // Recipient-level delivery filter counts
  const deliveryFilterKeys = [
    "all",
    "awaiting_approval",
    "scheduled",
    "pending",
    "sent",
    "failed",
    "unknown",
    "cancelled",
    "replied",
    "bounced",
    "skipped",
    "unsubscribed",
  ];
  const deliveryCounts: Record<string, number> = {};
  for (const key of deliveryFilterKeys) {
    deliveryCounts[key] = searched.filter((r) => matchesDeliveryFilter(key, r.timeline, r.recipientState)).length;
  }

  // Recipient-level conversation filter counts
  const convStatuses: ConversationStatus[] = [
    "NEEDS_REPLY",
    "WAITING_FOR_CONTACT",
    "MEETING_COORDINATION",
    "MEETING_SCHEDULED",
    "INTERESTED",
    "NOT_INTERESTED",
    "CLOSED",
  ];
  const convCountsMap: Record<ConversationStatus, number> = {
    NEEDS_REPLY: 0,
    WAITING_FOR_CONTACT: 0,
    MEETING_COORDINATION: 0,
    MEETING_SCHEDULED: 0,
    INTERESTED: 0,
    NOT_INTERESTED: 0,
    CLOSED: 0,
  };
  let totalConversations = 0;
  for (const r of searched) {
    if (r.currentConversation) {
      totalConversations++;
      const st = r.currentConversation.status;
      if (st in convCountsMap) {
        convCountsMap[st]++;
      }
    }
  }
  void convStatuses;

  // Apply combinable Delivery + Conversation filters
  const filtered = searched.filter((r) => {
    if (filter !== "all" && !matchesDeliveryFilter(filter, r.timeline, r.recipientState)) {
      return false;
    }
    if (conversationStatus && r.currentConversation?.status !== conversationStatus) {
      return false;
    }
    return true;
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const startIdx = (safePage - 1) * pageSize;
  const items = filtered.slice(startIdx, startIdx + pageSize);

  return {
    items,
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
    },
    deliveryCounts,
    conversationCounts: {
      total: totalConversations,
      counts: convCountsMap,
    },
  };
}
