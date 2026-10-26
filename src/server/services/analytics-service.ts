// Campaign analytics and attribution service
import prisma from "../db.js";
import { AppError } from "../middleware/error-handler.js";
import type { CampaignAnalyticsSummaryDto } from "../../shared/types.js";

export async function getCampaignAnalytics(campaignId: string): Promise<CampaignAnalyticsSummaryDto> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      template: { select: { id: true, name: true, version: true } },
      campaignTemplates: {
        include: { template: { select: { id: true, name: true, version: true } } },
      },
    },
  });

  if (!campaign) {
    throw AppError.notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
  }

  // Fetch all sends for this campaign with contact classification and events
  const sends = await prisma.send.findMany({
    where: { campaignId },
    include: {
      contact: {
        select: {
          id: true,
          hotelSegment: true,
          contactPersona: true,
        },
      },
      events: {
        select: {
          id: true,
          type: true,
          occurredAt: true,
          detail: true,
        },
      },
    },
  });

  const totalRecipients = sends.length;
  let attemptedSends = 0;
  let providerAcceptedCount = 0;
  let bouncedCount = 0;
  let repliedCount = 0;
  let positiveRepliesCount = 0;
  let meetingsBookedCount = 0;
  let unsubscribedCount = 0;

  // Breakdown aggregators
  const templateMap = new Map<
    string,
    {
      templateId: string;
      templateName: string;
      templateVersion: number;
      assignedCount: number;
      sentCount: number;
      repliedCount: number;
      positiveRepliesCount: number;
      meetingsBookedCount: number;
    }
  >();

  // Initialize known campaign templates
  if (campaign.campaignTemplates.length > 0) {
    for (const ct of campaign.campaignTemplates) {
      templateMap.set(ct.templateId, {
        templateId: ct.templateId,
        templateName: ct.template.name,
        templateVersion: ct.template.version,
        assignedCount: 0,
        sentCount: 0,
        repliedCount: 0,
        positiveRepliesCount: 0,
        meetingsBookedCount: 0,
      });
    }
  } else {
    templateMap.set(campaign.template.id, {
      templateId: campaign.template.id,
      templateName: campaign.template.name,
      templateVersion: campaign.template.version,
      assignedCount: 0,
      sentCount: 0,
      repliedCount: 0,
      positiveRepliesCount: 0,
      meetingsBookedCount: 0,
    });
  }

  const segmentMap = new Map<
    string,
    {
      segment: string;
      assignedCount: number;
      sentCount: number;
      repliedCount: number;
      positiveRepliesCount: number;
      meetingsBookedCount: number;
    }
  >();

  const personaMap = new Map<
    string,
    {
      persona: string;
      assignedCount: number;
      sentCount: number;
      repliedCount: number;
      positiveRepliesCount: number;
      meetingsBookedCount: number;
    }
  >();

  for (const send of sends) {
    attemptedSends += Math.max(1, send.attempts);
    const isSent = send.status === "SENT";
    const isBounced = Boolean(send.bouncedAt || (send.status === "FAILED" && send.attempts > 0));
    const isReplied = Boolean(send.repliedAt);
    const isUnsubscribed = Boolean(send.unsubscribedAt);

    if (isSent) providerAcceptedCount++;
    if (isBounced) bouncedCount++;
    if (isReplied) repliedCount++;
    if (isUnsubscribed) unsubscribedCount++;

    // Check for positive replies or meetings booked from events
    let isPositive = false;
    let isMeeting = false;

    for (const ev of send.events) {
      const d = ev.detail as Record<string, unknown> | null;
      if (d) {
        if (d.classification === "POSITIVE" || d.sentiment === "positive") isPositive = true;
        if (d.meetingBooked === true || d.meetingOutcome === "BOOKED" || d.meetingOutcome === "QUALIFIED") {
          isMeeting = true;
        }
      }
    }

    if (isPositive) positiveRepliesCount++;
    if (isMeeting) meetingsBookedCount++;

    // Template attribution
    const tId = send.templateId || campaign.templateId;
    let tEntry = templateMap.get(tId);
    if (!tEntry) {
      tEntry = {
        templateId: tId,
        templateName: "Assigned Template",
        templateVersion: send.templateVersion || 1,
        assignedCount: 0,
        sentCount: 0,
        repliedCount: 0,
        positiveRepliesCount: 0,
        meetingsBookedCount: 0,
      };
      templateMap.set(tId, tEntry);
    }
    tEntry.assignedCount++;
    if (isSent) tEntry.sentCount++;
    if (isReplied) tEntry.repliedCount++;
    if (isPositive) tEntry.positiveRepliesCount++;
    if (isMeeting) tEntry.meetingsBookedCount++;

    // Segment attribution
    const seg = send.contact?.hotelSegment || "UNCLASSIFIED";
    let sEntry = segmentMap.get(seg);
    if (!sEntry) {
      sEntry = {
        segment: seg,
        assignedCount: 0,
        sentCount: 0,
        repliedCount: 0,
        positiveRepliesCount: 0,
        meetingsBookedCount: 0,
      };
      segmentMap.set(seg, sEntry);
    }
    sEntry.assignedCount++;
    if (isSent) sEntry.sentCount++;
    if (isReplied) sEntry.repliedCount++;
    if (isPositive) sEntry.positiveRepliesCount++;
    if (isMeeting) sEntry.meetingsBookedCount++;

    // Persona attribution
    const per = send.contact?.contactPersona || "UNCLASSIFIED";
    let pEntry = personaMap.get(per);
    if (!pEntry) {
      pEntry = {
        persona: per,
        assignedCount: 0,
        sentCount: 0,
        repliedCount: 0,
        positiveRepliesCount: 0,
        meetingsBookedCount: 0,
      };
      personaMap.set(per, pEntry);
    }
    pEntry.assignedCount++;
    if (isSent) pEntry.sentCount++;
    if (isReplied) pEntry.repliedCount++;
    if (isPositive) pEntry.positiveRepliesCount++;
    if (isMeeting) pEntry.meetingsBookedCount++;
  }

  // Denominator: Provider-accepted sends (never count rejected attempts or total list size as delivered)
  const denominator = Math.max(1, providerAcceptedCount);

  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    totalRecipients,
    attemptedSends,
    providerAcceptedCount,
    bouncedCount,
    repliedCount,
    positiveRepliesCount,
    meetingsBookedCount,
    unsubscribedCount,
    rates: {
      bounceRate: Number(((bouncedCount / denominator) * 100).toFixed(1)),
      replyRate: Number(((repliedCount / denominator) * 100).toFixed(1)),
      positiveReplyRate: Number(((positiveRepliesCount / denominator) * 100).toFixed(1)),
      meetingRate: Number(((meetingsBookedCount / denominator) * 100).toFixed(1)),
      unsubscribeRate: Number(((unsubscribedCount / denominator) * 100).toFixed(1)),
    },
    byTemplate: [...templateMap.values()],
    byHotelSegment: [...segmentMap.values()],
    byContactPersona: [...personaMap.values()],
  };
}

export async function recordSendOutcome(
  sendId: string,
  outcome: {
    replyClassification?: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "OUT_OF_OFFICE";
    meetingBooked?: boolean;
    note?: string;
  }
) {
  const send = await prisma.send.findUnique({
    where: { id: sendId },
    include: { events: true },
  });

  if (!send) {
    throw AppError.notFound("SEND_NOT_FOUND", "Send message record not found.");
  }

  // If classifying reply, ensure reply timestamp is marked
  if (outcome.replyClassification && !send.repliedAt) {
    await prisma.send.update({
      where: { id: sendId },
      data: { repliedAt: new Date() },
    });
  }

  // Record an audit/outcome event on the Send
  const event = await prisma.sendEvent.create({
    data: {
      sendId,
      type: "REPLY",
      occurredAt: new Date(),
      detail: {
        classification: outcome.replyClassification ?? null,
        meetingBooked: outcome.meetingBooked ?? false,
        note: outcome.note ?? null,
        recordedManually: true,
      },
    },
  });

  return event;
}
