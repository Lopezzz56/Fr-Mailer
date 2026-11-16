// Actionable notification service
// Returns strictly actionable/important events (replies, due follow-ups, approvals,
// campaign completions/failures, mailbox issues, outreach assignments).
// Routine events (contact imports, template edits, email sends) belong to Activity Log.

import prisma from "../db.js";
import { Prisma } from "@prisma/client";
import { liveSendingBlocker } from "../config.js";
import { getImapState } from "./inbox-monitor.js";
import type { SessionUser } from "../../shared/auth.js";
import type { NotificationItemDto } from "../../shared/types.js";

export async function getActionableNotifications(user: SessionUser): Promise<NotificationItemDto[]> {
  const now = new Date();
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86_400_000);
  const oneWeekAgo = new Date(now.getTime() - 7 * 86_400_000);

  const isEmployee = user.role === "EMPLOYEE";
  const isFounderOrOffice = user.role === "FOUNDER" || user.role === "FOUNDER_OFFICE";

  // Campaign scoping
  const campaignScope: Prisma.CampaignWhereInput = isEmployee
    ? {
        OR: [
          { createdById: user.id },
          { collaborators: { some: { userId: user.id } } },
        ],
      }
    : {};

  const sendScope: Prisma.SendWhereInput = isEmployee
    ? { campaign: campaignScope }
    : {};

  const items: NotificationItemDto[] = [];

  // -------------------------------------------------------------------------
  // 1. Inbound Replies & Important Outcomes (Positive replies / Meetings)
  // -------------------------------------------------------------------------
  const recentReplies = await prisma.send.findMany({
    where: {
      ...sendScope,
      repliedAt: { not: null },
    },
    include: {
      campaign: { select: { id: true, name: true } },
      contact: { select: { firstName: true, lastName: true } },
      events: {
        where: { type: "REPLY" },
        select: { detail: true, occurredAt: true },
        orderBy: { occurredAt: "desc" },
        take: 1,
      },
    },
    orderBy: { repliedAt: "desc" },
    take: 15,
  });

  for (const reply of recentReplies) {
    const contactName = [reply.contact?.firstName, reply.contact?.lastName].filter(Boolean).join(" ") || reply.email;
    const eventDetail = (reply.events[0]?.detail as Record<string, unknown> | undefined) ?? {};
    const classification = (eventDetail.classification as string | undefined)?.toUpperCase();
    const sentiment = (eventDetail.sentiment as string | undefined)?.toLowerCase();
    const meetingBooked = Boolean(eventDetail.meetingBooked);
    const meetingOutcome = (eventDetail.meetingOutcome as string | undefined)?.toUpperCase();
    const snippet = (eventDetail.snippet as string | undefined) || null;

    const isPositiveOutcome =
      classification === "POSITIVE" ||
      sentiment === "positive" ||
      meetingBooked ||
      meetingOutcome === "BOOKED" ||
      meetingOutcome === "QUALIFIED";

    if (isPositiveOutcome) {
      items.push({
        id: `outcome-reply-${reply.id}`,
        type: "IMPORTANT_OUTCOME",
        category: "outcome",
        title: `Positive response from ${contactName}`,
        description: snippet
          ? `"${snippet.slice(0, 110)}"`
          : `Lead expressed positive interest on ${reply.campaign.name}.`,
        time: (reply.repliedAt ?? now).toISOString(),
        tone: "success",
        link: `/campaigns/${reply.campaign.id}?tab=recipients&filter=replied`,
        linkLabel: "Open conversation",
        entityId: reply.id,
      });
    } else {
      items.push({
        id: `inbound-reply-${reply.id}`,
        type: "INBOUND_REPLY",
        category: "reply",
        title: `Inbound reply from ${contactName}`,
        description: snippet
          ? `"${snippet.slice(0, 110)}"`
          : `New reply received on ${reply.campaign.name}.`,
        time: (reply.repliedAt ?? now).toISOString(),
        tone: "action",
        link: `/campaigns/${reply.campaign.id}?tab=recipients&filter=replied`,
        linkLabel: "View reply",
        entityId: reply.id,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. Follow-ups Due / Overdue
  // -------------------------------------------------------------------------
  const dueFollowUps = await prisma.send.findMany({
    where: {
      ...sendScope,
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
    take: 10,
  });

  for (const send of dueFollowUps) {
    const contactName = [send.contact?.firstName, send.contact?.lastName].filter(Boolean).join(" ") || send.email;
    items.push({
      id: `due-followup-${send.id}`,
      type: "FOLLOW_UP_DUE",
      category: "follow_up",
      title: `Follow-up due: ${contactName}`,
      description: `Step ${send.stepIndex} ready for dispatch · ${send.campaign.name}`,
      time: (send.scheduledFor ?? now).toISOString(),
      tone: "warning",
      link: `/campaigns/${send.campaign.id}?tab=recipients&filter=scheduled`,
      linkLabel: "Dispatch touch",
      entityId: send.id,
    });
  }

  // -------------------------------------------------------------------------
  // 3. Approval Required / Approvals
  // -------------------------------------------------------------------------
  if (isFounderOrOffice) {
    const pendingCampaigns = await prisma.campaign.findMany({
      where: { status: "PENDING_APPROVAL" },
      include: {
        createdBy: { select: { name: true } },
        contactList: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
    });

    for (const c of pendingCampaigns) {
      items.push({
        id: `approval-req-${c.id}`,
        type: "APPROVAL_REQUIRED",
        category: "approval",
        title: `Approval required: ${c.name}`,
        description: `Submitted by ${c.createdBy?.name || "Teammate"} (${c.contactList?.name || "contacts"}). Review content and recipients.`,
        time: (c.approvalRequestedAt ?? c.updatedAt).toISOString(),
        tone: "action",
        link: `/campaigns/${c.id}?tab=review`,
        linkLabel: "Review & approve",
        entityId: c.id,
      });
    }
  } else {
    // For employees: notify when their own campaigns were approved
    const approvedCampaigns = await prisma.campaign.findMany({
      where: {
        createdById: user.id,
        status: "APPROVED",
        approvedAt: { gte: twoWeeksAgo },
      },
      orderBy: { approvedAt: "desc" },
      take: 5,
    });

    for (const c of approvedCampaigns) {
      items.push({
        id: `approved-${c.id}`,
        type: "APPROVAL_REQUIRED",
        category: "approval",
        title: `Campaign approved: ${c.name}`,
        description: "Your campaign has been signed off and is authorized for live sending.",
        time: (c.approvedAt ?? c.updatedAt).toISOString(),
        tone: "success",
        link: `/campaigns/${c.id}`,
        linkLabel: "Open campaign",
        entityId: c.id,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Campaign Completed / Failed / Paused
  // -------------------------------------------------------------------------
  const [completedCampaigns, pausedCampaigns] = await Promise.all([
    prisma.campaign.findMany({
      where: {
        ...campaignScope,
        status: "COMPLETED",
        completedAt: { gte: twoWeeksAgo },
      },
      orderBy: { completedAt: "desc" },
      take: 5,
    }),
    prisma.campaign.findMany({
      where: {
        ...campaignScope,
        status: "PAUSED",
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
  ]);

  for (const c of completedCampaigns) {
    items.push({
      id: `camp-complete-${c.id}`,
      type: "CAMPAIGN_COMPLETED",
      category: "campaign",
      title: `Campaign completed: ${c.name}`,
      description: "All scheduled sequence steps and touchpoints have finished sending.",
      time: (c.completedAt ?? c.updatedAt).toISOString(),
      tone: "info",
      link: `/campaigns/${c.id}`,
      linkLabel: "View results",
      entityId: c.id,
    });
  }

  for (const c of pausedCampaigns) {
    items.push({
      id: `camp-paused-${c.id}`,
      type: "CAMPAIGN_FAILED",
      category: "campaign",
      title: `Campaign paused: ${c.name}`,
      description: "Outreach dispatch is paused. Check settings or resume when ready.",
      time: c.updatedAt.toISOString(),
      tone: "alert",
      link: `/campaigns/${c.id}`,
      linkLabel: "Inspect campaign",
      entityId: c.id,
    });
  }

  // Delivery failures check
  const failedSendsByCampaign = await prisma.send.groupBy({
    by: ["campaignId"],
    where: {
      ...sendScope,
      status: "FAILED",
      updatedAt: { gte: oneWeekAgo },
    },
    _count: { _all: true },
  });

  if (failedSendsByCampaign.length > 0) {
    const cIds = failedSendsByCampaign.map((f) => f.campaignId);
    const affectedCampaigns = await prisma.campaign.findMany({
      where: { id: { in: cIds } },
      select: { id: true, name: true, updatedAt: true },
    });
    const cMap = new Map(affectedCampaigns.map((c) => [c.id, c]));

    for (const fail of failedSendsByCampaign) {
      const c = cMap.get(fail.campaignId);
      if (c && fail._count._all > 0) {
        items.push({
          id: `camp-fail-${c.id}`,
          type: "CAMPAIGN_FAILED",
          category: "campaign",
          title: `Delivery errors on ${c.name}`,
          description: `${fail._count._all} message(s) failed delivery or bounced.`,
          time: c.updatedAt.toISOString(),
          tone: "alert",
          link: `/campaigns/${c.id}?tab=recipients&filter=failed`,
          linkLabel: "Review recipients",
          entityId: c.id,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Mailbox & Infrastructure Issues
  // -------------------------------------------------------------------------
  if (isFounderOrOffice) {
    const blocker = liveSendingBlocker();
    if (blocker) {
      items.push({
        id: "mailbox-blocker-alert",
        type: "MAILBOX_ISSUE",
        category: "mailbox",
        title: "Sending safeguard active",
        description: blocker,
        time: now.toISOString(),
        tone: "alert",
        link: "/settings/mailbox",
        linkLabel: "Configure mailbox",
      });
    }

    const mailboxes = await prisma.mailboxAccount.findMany({
      select: { id: true, email: true, lastVerifiedAt: true },
    });

    if (mailboxes.length === 0) {
      items.push({
        id: "mailbox-none-alert",
        type: "MAILBOX_ISSUE",
        category: "mailbox",
        title: "No outreach mailboxes connected",
        description: "Connect a SpaceMail account in Settings to enable live email delivery.",
        time: now.toISOString(),
        tone: "warning",
        link: "/settings/mailbox",
        linkLabel: "Connect mailbox",
      });
    } else {
      // Check for IMAP errors across accounts
      for (const mb of mailboxes) {
        const state = await getImapState(mb.id);
        if (state.lastError) {
          items.push({
            id: `mailbox-imap-err-${mb.id}`,
            type: "MAILBOX_ISSUE",
            category: "mailbox",
            title: `Mailbox sync error (${mb.email})`,
            description: `Inbox check failed: ${state.lastError}`,
            time: new Date(state.lastCheckedAt ?? now).toISOString(),
            tone: "warning",
            link: "/settings/mailbox",
            linkLabel: "Review connection",
            entityId: mb.id,
          });
        }
      }
    }
  } else {
    // For employees: check if they have any assigned mailbox
    const userAccesses = await prisma.mailboxAccess.count({
      where: { userId: user.id },
    });
    if (userAccesses === 0) {
      items.push({
        id: "employee-no-mailbox",
        type: "MAILBOX_ISSUE",
        category: "mailbox",
        title: "No sending mailbox assigned",
        description: "You have not been granted access to an outreach mailbox yet. Request access from Founder's Office.",
        time: now.toISOString(),
        tone: "warning",
        link: "/settings/mailbox",
        linkLabel: "View mailboxes",
      });
    }
  }

  // -------------------------------------------------------------------------
  // 6. Outreach Assignments
  // -------------------------------------------------------------------------
  // Collaborations assigned to user in the last 14 days
  const recentCollaborations = await prisma.campaignCollaborator.findMany({
    where: {
      userId: user.id,
      addedAt: { gte: twoWeeksAgo },
    },
    include: {
      campaign: { select: { id: true, name: true } },
      addedBy: { select: { name: true } },
    },
    orderBy: { addedAt: "desc" },
    take: 5,
  });

  for (const collab of recentCollaborations) {
    items.push({
      id: `collab-assigned-${collab.id}`,
      type: "OUTREACH_ASSIGNMENT",
      category: "assignment",
      title: `Assigned to campaign: ${collab.campaign.name}`,
      description: `You were added as an outreach collaborator${collab.addedBy?.name ? ` by ${collab.addedBy.name}` : ""}.`,
      time: collab.addedAt.toISOString(),
      tone: "info",
      link: `/campaigns/${collab.campaignId}`,
      linkLabel: "Open campaign",
      entityId: collab.campaignId,
    });
  }

  // Mailbox access granted in the last 14 days
  const recentMailboxAccess = await prisma.mailboxAccess.findMany({
    where: {
      userId: user.id,
      createdAt: { gte: twoWeeksAgo },
    },
    include: {
      mailbox: { select: { id: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  for (const access of recentMailboxAccess) {
    items.push({
      id: `mb-access-granted-${access.id}`,
      type: "OUTREACH_ASSIGNMENT",
      category: "assignment",
      title: `Access granted: ${access.mailbox.email}`,
      description: `You are authorized to send outreach through this mailbox${access.senderName ? ` as "${access.senderName}"` : ""}.`,
      time: access.createdAt.toISOString(),
      tone: "info",
      link: "/settings/mailbox",
      linkLabel: "View mailbox",
      entityId: access.mailboxId,
    });
  }

  // -------------------------------------------------------------------------
  // Deduplicate by ID and sort by time descending
  // -------------------------------------------------------------------------
  const seenIds = new Set<string>();
  const uniqueItems: NotificationItemDto[] = [];

  for (const item of items) {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      uniqueItems.push(item);
    }
  }

  uniqueItems.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  // Cap at 30 most recent actionable notifications
  return uniqueItems.slice(0, 30);
}
