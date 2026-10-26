// Campaign lifecycle & business rules.
//
//   DRAFT ──request──▶ PENDING_APPROVAL ──approve (founder)──▶ APPROVED ──start──▶ SENDING ⇄ PAUSED ──▶ COMPLETED
//     ▲                       │ withdraw / request changes                                  │
//     └───────────────────────┘                                   cancel (any non-final) ──▶ CANCELLED
//
// Approval re-checks every recipient, then freezes one Send row per recipient with the exact
// rendered message (footer included). From then on, template edits can't change what goes out.
import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import type { Request } from "express";
import prisma from "../db.js";
import { AppError } from "../middleware/error-handler.js";
import { audit } from "../lib/audit.js";
import { liveSendingBlocker, smtpConfigured } from "../config.js";
import { contactMergeData, renderEmail, validateTemplate, type TemplateParts } from "../../shared/merge.js";
import { FOUNDER_SELF_APPROVAL_ALLOWED } from "../../shared/auth.js";
import { SUPPRESSION_REASON_LABELS, type CampaignReviewDto, type CampaignStatus } from "../../shared/types.js";
import { getTransport, messageIdDomain } from "./mailer.js";
import { unsubscribeHeaders, unsubscribeUrl, withFooter } from "./unsubscribe.js";

type Tx = Prisma.TransactionClient;

export function contentHash(parts: TemplateParts): string {
  return crypto.createHash("sha256").update(JSON.stringify([parts.subject, parts.bodyHtml, parts.bodyText ?? ""])).digest("hex").slice(0, 16);
}

async function getCampaignOr404(id: string, db: Tx | typeof prisma = prisma) {
  const campaign = await db.campaign.findUnique({ where: { id }, include: { template: true } });
  if (!campaign) throw AppError.notFound("CAMPAIGN_NOT_FOUND", "That campaign no longer exists.");
  return campaign;
}

/** Atomic status transition: fails if another request changed the status first */
async function transition(db: Tx | typeof prisma, id: string, from: CampaignStatus[], data: Prisma.CampaignUncheckedUpdateManyInput, conflictMessage: string) {
  const result = await db.campaign.updateMany({ where: { id, status: { in: from } }, data });
  if (result.count !== 1) throw AppError.conflict("INVALID_STATUS", conflictMessage);
}

// ---------------------------------------------------------------------------
// Review (live check against the current template and list)
// ---------------------------------------------------------------------------

interface ReviewWork {
  review: CampaignReviewDto & { contentHash: string };
  ready: { contactId: string; email: string; rendered: ReturnType<typeof renderEmail> }[];
  skipped: { contactId: string; email: string; reason: string }[];
}

async function buildReview(campaignId: string, db: Tx | typeof prisma = prisma, sampleSize = 5): Promise<ReviewWork> {
  const campaign = await getCampaignOr404(campaignId, db);
  const parts: TemplateParts = { subject: campaign.template.subject, bodyHtml: campaign.template.bodyHtml, bodyText: campaign.template.bodyText };
  const templateErrors = validateTemplate(parts);

  const members = await db.listMembership.findMany({
    where: { contactListId: campaign.contactListId },
    include: { contact: true },
    orderBy: { addedAt: "asc" },
  });
  const emails = members.map((m) => m.contact.email);
  const suppressions = emails.length ? await db.suppressionEntry.findMany({ where: { email: { in: emails } } }) : [];
  const suppressedBy = new Map(suppressions.filter((s) => !s.expiresAt || s.expiresAt > new Date()).map((s) => [s.email.toLowerCase(), s.reason]));

  const work: ReviewWork = {
    review: {
      total: members.length,
      ready: 0,
      templateErrors,
      missingFields: [],
      suppressed: [],
      issueCount: 0,
      sample: [],
      contentHash: contentHash(parts),
    },
    ready: [],
    skipped: [],
  };

  for (const { contact } of members) {
    const reason = suppressedBy.get(contact.email.toLowerCase());
    if (reason) {
      const label = `Suppressed: ${SUPPRESSION_REASON_LABELS[reason]}`;
      work.review.suppressed.push({ email: contact.email, contactId: contact.id, reason: label });
      work.skipped.push({ contactId: contact.id, email: contact.email, reason: label });
      continue;
    }
    const rendered = renderEmail(parts, contactMergeData(contact));
    if (rendered.missingFields.length) {
      work.review.missingFields.push({ email: contact.email, contactId: contact.id, fields: rendered.missingFields });
      work.skipped.push({ contactId: contact.id, email: contact.email, reason: `Missing: ${rendered.missingFields.join(", ")}` });
      continue;
    }
    work.ready.push({ contactId: contact.id, email: contact.email, rendered });
  }

  work.review.ready = work.ready.length;
  work.review.issueCount = work.review.missingFields.length + work.review.suppressed.length;
  work.review.sample = work.ready.slice(0, sampleSize).map((r) => ({
    contactId: r.contactId,
    email: r.email,
    subject: r.rendered.subject,
    html: r.rendered.html,
    text: r.rendered.text,
    missingFields: [],
  }));
  // Show at least one problem recipient's render when nobody is ready
  if (!work.review.sample.length && members[0]) {
    const r = renderEmail(parts, contactMergeData(members[0].contact));
    work.review.sample.push({ contactId: members[0].contact.id, email: members[0].contact.email, subject: r.subject, html: r.html, text: r.text, missingFields: r.missingFields });
  }
  return work;
}

export async function reviewCampaign(id: string) {
  return (await buildReview(id)).review;
}

// ---------------------------------------------------------------------------
// Draft editing
// ---------------------------------------------------------------------------

export async function assertEditable(id: string) {
  const c = await getCampaignOr404(id);
  if (c.status !== "DRAFT") {
    throw AppError.conflict("NOT_EDITABLE", c.status === "PENDING_APPROVAL" ? "Withdraw the approval request before editing." : "Only draft campaigns can be edited.");
  }
  return c;
}

// ---------------------------------------------------------------------------
// Approval flow
// ---------------------------------------------------------------------------

export async function requestApproval(req: Request, id: string) {
  const work = await buildReview(id);
  if (work.review.templateErrors.length) {
    throw AppError.badRequest("TEMPLATE_INVALID", `Fix the template first: ${work.review.templateErrors[0]}`);
  }
  if (work.review.ready === 0) {
    throw AppError.badRequest("NO_RECIPIENTS", work.review.total === 0 ? "The recipient list is empty." : "No recipient can receive this email yet. Fix the issues shown in the review.");
  }
  await prisma.$transaction(async (tx) => {
    await transition(tx, id, ["DRAFT"], { status: "PENDING_APPROVAL", approvalRequestedById: req.user!.id, approvalRequestedAt: new Date() }, "Only drafts can be submitted for approval.");
    await audit(req, { action: "campaign.request_approval", entityType: "Campaign", entityId: id, metadata: { ready: work.review.ready, issues: work.review.issueCount } }, tx);
  });
}

export async function withdrawApproval(req: Request, id: string, note?: string) {
  await prisma.$transaction(async (tx) => {
    await transition(tx, id, ["PENDING_APPROVAL"], { status: "DRAFT", approvalRequestedById: null, approvalRequestedAt: null }, "This campaign isn't waiting for approval.");
    await audit(req, { action: "campaign.return_to_draft", entityType: "Campaign", entityId: id, metadata: note ? { note } : {} }, tx);
  });
}

export async function approveCampaign(req: Request, id: string, seen: { contentHash: string; ready: number }) {
  const user = req.user!;
  await prisma.$transaction(
    async (tx) => {
      const campaign = await getCampaignOr404(id, tx);
      if (campaign.status !== "PENDING_APPROVAL") throw AppError.conflict("INVALID_STATUS", "This campaign isn't waiting for approval.");
      if (!FOUNDER_SELF_APPROVAL_ALLOWED && campaign.approvalRequestedById === user.id) {
        throw AppError.forbidden("SELF_APPROVAL", "Another founder must approve a campaign you submitted.");
      }

      const work = await buildReview(id, tx);
      if (work.review.contentHash !== seen.contentHash || work.review.ready !== seen.ready) {
        throw AppError.conflict("REVIEW_STALE", "The template or recipient list changed since you reviewed it. Review it again before approving.");
      }
      if (work.review.templateErrors.length || work.review.ready === 0) {
        throw AppError.badRequest("NOT_READY", "This campaign has no recipients ready to receive it.");
      }

      await transition(
        tx,
        id,
        ["PENDING_APPROVAL"],
        {
          status: "APPROVED",
          approvedById: user.id,
          approvedAt: new Date(),
          subject: campaign.template.subject,
          bodyHtml: campaign.template.bodyHtml,
          bodyText: campaign.template.bodyText,
          contentHash: work.review.contentHash,
        },
        "This campaign isn't waiting for approval."
      );

      const domain = messageIdDomain();
      const rows: Prisma.SendCreateManyInput[] = work.ready.map((r) => {
        const sendId = crypto.randomUUID();
        const content = withFooter(r.rendered.html, r.rendered.text, unsubscribeUrl(sendId), campaign.fromName);
        return {
          id: sendId,
          campaignId: id,
          contactId: r.contactId,
          email: r.email,
          subject: r.rendered.subject,
          html: content.html,
          text: content.text,
          messageId: `<${sendId}@${domain}>`,
          status: "PENDING",
        };
      });
      for (const s of work.skipped) {
        const sendId = crypto.randomUUID();
        rows.push({ id: sendId, campaignId: id, contactId: s.contactId, email: s.email, subject: "", html: "", text: "", messageId: `<${sendId}@${domain}>`, status: "SKIPPED", skipReason: s.reason });
      }
      for (let i = 0; i < rows.length; i += 1000) {
        await tx.send.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true });
      }

      await audit(req, { action: "campaign.approve", entityType: "Campaign", entityId: id, metadata: { recipients: work.ready.length, skipped: work.skipped.length } }, tx);
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
}

// ---------------------------------------------------------------------------
// Sending control
// ---------------------------------------------------------------------------

export async function startCampaign(req: Request, id: string) {
  const blocker = liveSendingBlocker();
  if (blocker) throw AppError.conflict("LIVE_SENDING_LOCKED", blocker);
  await prisma.$transaction(async (tx) => {
    await transition(tx, id, ["APPROVED"], { status: "SENDING", startedAt: new Date(), pausedReason: null }, "Only approved campaigns can be started.");
    await audit(req, { action: "campaign.start", entityType: "Campaign", entityId: id }, tx);
  });
}

export async function pauseCampaign(req: Request | null, id: string, reason?: string) {
  await prisma.$transaction(async (tx) => {
    await transition(tx, id, ["SENDING"], { status: "PAUSED", pausedReason: reason ?? null }, "Only a campaign that is sending can be paused.");
    await audit(req, { action: reason ? "campaign.auto_pause" : "campaign.pause", entityType: "Campaign", entityId: id, metadata: reason ? { reason } : {} }, tx);
  });
}

export async function resumeCampaign(req: Request, id: string) {
  const blocker = liveSendingBlocker();
  if (blocker) throw AppError.conflict("LIVE_SENDING_LOCKED", blocker);
  await prisma.$transaction(async (tx) => {
    await transition(tx, id, ["PAUSED"], { status: "SENDING", pausedReason: null }, "Only a paused campaign can be resumed.");
    await audit(req, { action: "campaign.resume", entityType: "Campaign", entityId: id }, tx);
  });
}

export async function cancelCampaign(req: Request, id: string) {
  await prisma.$transaction(async (tx) => {
    await transition(tx, id, ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENDING", "PAUSED"], { status: "CANCELLED", cancelledAt: new Date() }, "This campaign has already finished.");
    // A message already handed to SMTP (CLAIMED) is left to finish and be recorded honestly
    const cancelled = await tx.send.updateMany({ where: { campaignId: id, status: "PENDING" }, data: { status: "CANCELLED" } });
    await audit(req, { action: "campaign.cancel", entityType: "Campaign", entityId: id, metadata: { unsent: cancelled.count } }, tx);
  });
}

export async function retryFailed(req: Request, id: string) {
  const campaign = await getCampaignOr404(id);
  if (!["SENDING", "PAUSED", "COMPLETED"].includes(campaign.status)) {
    throw AppError.conflict("INVALID_STATUS", "Failed messages can be retried once a campaign has started.");
  }
  if (campaign.status === "COMPLETED") {
    const blocker = liveSendingBlocker();
    if (blocker) throw AppError.conflict("LIVE_SENDING_LOCKED", blocker);
  }
  return prisma.$transaction(async (tx) => {
    const requeued = await tx.send.updateMany({ where: { campaignId: id, status: "FAILED" }, data: { status: "PENDING", lastError: null } });
    if (requeued.count === 0) throw AppError.badRequest("NOTHING_TO_RETRY", "There are no failed messages to retry.");
    if (campaign.status === "COMPLETED") {
      await transition(tx, id, ["COMPLETED"], { status: "SENDING", completedAt: null }, "The campaign changed; refresh and try again.");
    }
    await audit(req, { action: "campaign.retry_failed", entityType: "Campaign", entityId: id, metadata: { count: requeued.count } }, tx);
    return requeued.count;
  });
}

/** A person decides what happened to a message whose handoff was interrupted */
export async function resolveUnknown(req: Request, campaignId: string, sendId: string, outcome: "sent" | "retry") {
  await prisma.$transaction(async (tx) => {
    const send = await tx.send.findFirst({ where: { id: sendId, campaignId } });
    if (!send) throw AppError.notFound("SEND_NOT_FOUND", "That message no longer exists.");
    const updated = await tx.send.updateMany({
      where: { id: sendId, status: "UNKNOWN" },
      data: outcome === "sent" ? { status: "SENT", sentAt: send.claimedAt ?? new Date() } : { status: "PENDING" },
    });
    if (updated.count !== 1) throw AppError.conflict("INVALID_STATUS", "This message has already been resolved.");
    if (outcome === "retry") {
      await tx.campaign.updateMany({ where: { id: campaignId, status: "COMPLETED" }, data: { status: "SENDING", completedAt: null } });
    }
    await audit(req, { action: outcome === "sent" ? "send.mark_sent" : "send.retry_unknown", entityType: "Send", entityId: sendId, metadata: { email: send.email, campaignId } }, tx);
  });
}

// ---------------------------------------------------------------------------
// Test send (internal addresses only; never touches recipients or Send rows)
// ---------------------------------------------------------------------------

export async function sendTest(req: Request, id: string, to: string[], contactId?: string) {
  if (!smtpConfigured) throw AppError.conflict("MAILBOX_NOT_CONFIGURED", "The sending mailbox isn't configured on the server.");
  const campaign = await getCampaignOr404(id);
  const parts: TemplateParts = campaign.subject && campaign.bodyHtml
    ? { subject: campaign.subject, bodyHtml: campaign.bodyHtml, bodyText: campaign.bodyText }
    : { subject: campaign.template.subject, bodyHtml: campaign.template.bodyHtml, bodyText: campaign.template.bodyText };

  const errors = validateTemplate(parts);
  if (errors.length) throw AppError.badRequest("TEMPLATE_INVALID", `Fix the template first: ${errors[0]}`);

  const membership = await prisma.listMembership.findFirst({
    where: { contactListId: campaign.contactListId, ...(contactId ? { contactId } : {}) },
    include: { contact: true },
    orderBy: { addedAt: "asc" },
  });
  if (contactId && !membership) throw AppError.badRequest("NOT_A_RECIPIENT", "That contact isn't on this campaign's list.");

  const data = membership ? contactMergeData(membership.contact) : { firstName: "Alex", lastName: "Sample", fullName: "Alex Sample", company: "Sample Co", email: to[0] };
  const rendered = renderEmail(parts, data);
  const content = withFooter(rendered.html, rendered.text, unsubscribeUrl("test-preview"), campaign.fromName);

  const transport = getTransport();
  const results: { to: string; ok: boolean; error?: string }[] = [];
  for (const address of to) {
    try {
      await transport.send({
        to: address,
        subject: `[Test] ${rendered.subject}`,
        html: content.html,
        text: content.text,
        fromName: campaign.fromName,
        replyTo: campaign.replyTo,
        headers: { "X-FR-Test": "true", ...unsubscribeHeaders(unsubscribeUrl("test-preview")) },
      });
      results.push({ to: address, ok: true });
    } catch (err) {
      results.push({ to: address, ok: false, error: (err as Error).message.slice(0, 300) });
    }
  }
  await audit(req, {
    action: "campaign.test_send",
    entityType: "Campaign",
    entityId: id,
    metadata: { to, renderedFor: membership?.contact.email ?? "sample data", failed: results.filter((r) => !r.ok).length },
  });
  return { results, renderedFor: membership?.contact.email ?? null, missingFields: rendered.missingFields };
}
