import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "../db.js";
import { listCampaignRecipients } from "./campaign-recipients.js";
import { getCampaignAnalytics } from "./analytics-service.js";

function makeSend(overrides: Record<string, unknown>) {
  const now = new Date("2026-11-26T10:00:00Z");
  return {
    id: `send-${Math.random().toString(36).slice(2, 8)}`,
    campaignId: "camp-1",
    email: "lead@hotel.com",
    contactId: "c-1",
    subject: "Intro",
    status: "SENT",
    skipReason: null,
    attempts: 1,
    lastError: null,
    sentAt: now,
    bouncedAt: null,
    repliedAt: null,
    unsubscribedAt: null,
    updatedAt: now,
    createdAt: now,
    templateId: "tpl-1",
    templateVersion: 1,
    assignmentReason: null,
    stepIndex: 0,
    scheduledFor: now,
    approvedAt: now,
    inReplyToId: null,
    isCustom: false,
    contact: { firstName: "Ajay", lastName: "Bakaya", company: "Sarovar", hotelSegment: "CHAIN", contactPersona: "GM" },
    events: [],
    ...overrides,
  };
}

describe("Campaign Recipients Aggregation & Recipient-Oriented Analytics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("1, 2, 13: groups 15 recipients x 3 steps (45 sends) into 15 recipient rows and 15 outcome counts", async () => {
    const sends: any[] = [];
    for (let i = 1; i <= 15; i++) {
      const email = `lead${i}@hotel.com`;
      for (let step = 0; step < 3; step++) {
        sends.push(
          makeSend({
            id: `s-${i}-${step}`,
            email,
            contactId: `c-${i}`,
            stepIndex: step,
            status: "SENT",
            sentAt: new Date(`2026-11-${10 + step}T10:00:00Z`),
            ...(i === 1 && step === 0 ? { repliedAt: new Date("2026-11-11T12:00:00Z") } : {}),
            ...(i === 2 && step === 1 ? { repliedAt: new Date("2026-11-12T12:00:00Z") } : {}),
            contact: { firstName: `Lead`, lastName: `${i}`, company: `Hotel ${i}`, hotelSegment: "LUXURY", contactPersona: "GM" },
          })
        );
      }
    }

    const conversations = [
      {
        id: "conv-1",
        recipientEmail: "lead1@hotel.com",
        status: "MEETING_SCHEDULED",
        sentiment: "POSITIVE",
        snippet: "3pm please",
        outcome: "Booked",
        meetingAt: new Date("2026-11-18T09:30:00Z"),
        lastMessageAt: new Date("2026-11-11T12:00:00Z"),
      },
      {
        id: "conv-2",
        recipientEmail: "lead2@hotel.com",
        status: "NEEDS_REPLY",
        sentiment: "POSITIVE",
        snippet: "Interested in learning more",
        outcome: null,
        meetingAt: null,
        lastMessageAt: new Date("2026-11-12T12:00:00Z"),
      },
    ];

    vi.spyOn(prisma.campaignSequenceStep, "count").mockResolvedValue(3);
    vi.spyOn(prisma.send, "findMany").mockResolvedValue(sends as any);
    vi.spyOn(prisma.conversation, "findMany").mockResolvedValue(conversations as any);
    vi.spyOn(prisma.campaignRecipientState, "findMany").mockResolvedValue([] as any);

    const res = await listCampaignRecipients("camp-1", { page: 1, pageSize: 25 });
    expect(res.pagination.total).toBe(15);
    expect(res.items).toHaveLength(15);
    expect(res.deliveryCounts.all).toBe(15);
    expect(res.deliveryCounts.sent).toBe(15);
    expect(res.conversationCounts.total).toBe(2);
    expect(res.conversationCounts.counts.NEEDS_REPLY).toBe(1);
    expect(res.conversationCounts.counts.MEETING_SCHEDULED).toBe(1);

    // Lead 1 has 3 touches in timeline and 3/3 completed
    const lead1 = res.items.find((r) => r.email === "lead1@hotel.com")!;
    expect(lead1.emailsSent).toBe(3);
    expect(lead1.stepsCompleted).toBe(3);
    expect(lead1.stepsTotal).toBe(3);
    expect(lead1.progressLabel).toBe("3/3 completed");
    expect(lead1.timeline).toHaveLength(3);

    // Combinable filter: Delivery=sent + Conversation=NEEDS_REPLY returns only lead2
    const combined = await listCampaignRecipients("camp-1", { filter: "sent", conversationStatus: "NEEDS_REPLY" });
    expect(combined.items).toHaveLength(1);
    expect(combined.items[0]!.email).toBe("lead2@hotel.com");

    // Campaign analytics reports 15 unique recipients, 45 touches, and outcome breakdown summing to 15
    vi.spyOn(prisma.campaign, "findUnique").mockResolvedValue({
      id: "camp-1",
      name: "Test 15x3",
      templateId: "tpl-1",
      template: { id: "tpl-1", name: "Intro", version: 1 },
      campaignTemplates: [],
      sequenceSteps: [
        { stepIndex: 0, purpose: "Initial" },
        { stepIndex: 1, purpose: "Follow-up 1" },
        { stepIndex: 2, purpose: "Follow-up 2" },
      ],
    } as any);
    vi.spyOn(prisma.conversationMessage, "count").mockResolvedValue(2);

    const analytics = await getCampaignAnalytics("camp-1");
    expect(analytics.totalRecipients).toBe(15);
    expect(analytics.totalSends).toBe(45);
    expect(analytics.providerAcceptedCount).toBe(45);
    expect(analytics.uniqueReachedCount).toBe(15);
    expect(analytics.repliedCount).toBe(2);
    expect(analytics.meetingsBookedCount).toBe(1);
    expect(analytics.positiveRepliesCount).toBe(1);

    const b = analytics.outcomeBreakdown!;
    expect(b.meetingBooked).toBe(1);
    expect(b.interested).toBe(1);
    expect(b.noResponse).toBe(13);
    expect(b.meetingBooked + b.interested + b.replied + b.notInterested + b.noResponse + b.bounced + b.unsubscribed + b.pending).toBe(15);

    expect(analytics.bySequenceStep?.map((s) => ({ step: s.stepIndex, reached: s.recipientsReached, sent: s.sentCount }))).toEqual([
      { step: 0, reached: 15, sent: 15 },
      { step: 1, reached: 15, sent: 15 },
      { step: 2, reached: 15, sent: 15 },
    ]);
  });

  it("3, 4, 5, 6, 7, 8, 9, 10, 11, 12: handles replies, cancelled steps, future/unapproved steps, bounces, unsubscribes, multiple conversations, and 1x5 sequence", async () => {
    const sends = [
      // Case 3,4,5: replied after step 0, multiple replies in 1 conversation, step 1 cancelled
      makeSend({ id: "r1-0", email: "replied@h.com", stepIndex: 0, status: "SENT", repliedAt: new Date("2026-11-20T10:00:00Z") }),
      makeSend({ id: "r1-1", email: "replied@h.com", stepIndex: 1, status: "CANCELLED", sentAt: null, skipReason: "Reply received on prior outreach" }),

      // Case 6 & 7: step 0 sent, step 1 awaiting approval, step 2 scheduled future
      makeSend({ id: "f1-0", email: "future@h.com", stepIndex: 0, status: "SENT" }),
      makeSend({ id: "f1-1", email: "future@h.com", stepIndex: 1, status: "PENDING", sentAt: null, approvedAt: null, scheduledFor: new Date("2026-12-01T10:00:00Z") }),
      makeSend({ id: "f1-2", email: "future@h.com", stepIndex: 2, status: "PENDING", sentAt: null, approvedAt: new Date(), scheduledFor: new Date("2026-12-05T10:00:00Z") }),

      // Case 8: bounced on step 0, step 1 cancelled
      makeSend({ id: "b1-0", email: "bounced@h.com", stepIndex: 0, status: "FAILED", sentAt: null, bouncedAt: new Date("2026-11-20T11:00:00Z") }),
      makeSend({ id: "b1-1", email: "bounced@h.com", stepIndex: 1, status: "CANCELLED", sentAt: null, skipReason: "Recipient bounced" }),

      // Case 9: unsubscribed mid-sequence
      makeSend({ id: "u1-0", email: "unsub@h.com", stepIndex: 0, status: "SENT", unsubscribedAt: new Date("2026-11-21T10:00:00Z") }),
      makeSend({ id: "u1-1", email: "unsub@h.com", stepIndex: 1, status: "CANCELLED", sentAt: null, skipReason: "Unsubscribed" }),

      // Case 12: 1 recipient x 5 sequence steps
      makeSend({ id: "five-0", email: "five@h.com", stepIndex: 0, status: "SENT" }),
      makeSend({ id: "five-1", email: "five@h.com", stepIndex: 1, status: "SENT" }),
      makeSend({ id: "five-2", email: "five@h.com", stepIndex: 2, status: "PENDING", sentAt: null, scheduledFor: new Date("2026-12-10T10:00:00Z") }),
      makeSend({ id: "five-3", email: "five@h.com", stepIndex: 3, status: "PENDING", sentAt: null, scheduledFor: new Date("2026-12-14T10:00:00Z") }),
      makeSend({ id: "five-4", email: "five@h.com", stepIndex: 4, status: "PENDING", sentAt: null, scheduledFor: new Date("2026-12-18T10:00:00Z") }),
    ];

    // Case 11: Multiple conversations for replied@h.com (latest surfaces, count=2, nothing destroyed)
    const conversations = [
      {
        id: "conv-latest",
        recipientEmail: "replied@h.com",
        status: "NEEDS_REPLY",
        sentiment: "NEUTRAL",
        snippet: "Let's talk Friday",
        outcome: null,
        meetingAt: null,
        lastMessageAt: new Date("2026-11-22T10:00:00Z"),
      },
      {
        id: "conv-older",
        recipientEmail: "replied@h.com",
        status: "CLOSED",
        sentiment: "NEUTRAL",
        snippet: "Old thread",
        outcome: null,
        meetingAt: null,
        lastMessageAt: new Date("2026-11-15T10:00:00Z"),
      },
    ];

    vi.spyOn(prisma.campaignSequenceStep, "count").mockResolvedValue(5);
    vi.spyOn(prisma.send, "findMany").mockResolvedValue(sends as any);
    vi.spyOn(prisma.conversation, "findMany").mockResolvedValue(conversations as any);
    vi.spyOn(prisma.campaignRecipientState, "findMany").mockResolvedValue([
      { email: "replied@h.com", state: "REPLY_RECEIVED", pausedReason: null },
      { email: "bounced@h.com", state: "BOUNCED", pausedReason: null },
      { email: "unsub@h.com", state: "SUPPRESSED", pausedReason: null },
    ] as any);

    const res = await listCampaignRecipients("camp-1", { page: 1, pageSize: 25 });
    expect(res.pagination.total).toBe(5);

    const repliedRow = res.items.find((r) => r.email === "replied@h.com")!;
    expect(repliedRow.stepsCompleted).toBe(1); // cancelled step 1 not counted
    expect(repliedRow.currentConversation?.id).toBe("conv-latest");
    expect(repliedRow.conversationCount).toBe(2);
    expect(repliedRow.nextActionLabel).toBe("Review reply");
    expect(res.conversationCounts.counts.NEEDS_REPLY).toBe(1); // deduplicated

    const futureRow = res.items.find((r) => r.email === "future@h.com")!;
    expect(futureRow.stepsCompleted).toBe(1); // awaiting/future not counted
    expect(futureRow.deliverySummary).toBe("AWAITING_APPROVAL");
    expect(futureRow.nextActionLabel).toContain("Approve");

    const bouncedRow = res.items.find((r) => r.email === "bounced@h.com")!;
    expect(bouncedRow.stepsCompleted).toBe(0);
    expect(bouncedRow.deliverySummary).toBe("FAILED");

    const unsubRow = res.items.find((r) => r.email === "unsub@h.com")!;
    expect(unsubRow.deliverySummary).toBe("SKIPPED");

    const fiveRow = res.items.find((r) => r.email === "five@h.com")!;
    expect(fiveRow.stepsCompleted).toBe(2);
    expect(fiveRow.stepsTotal).toBe(5);
    expect(fiveRow.timeline).toHaveLength(5);
  });
});
