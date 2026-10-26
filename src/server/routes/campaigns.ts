// Campaigns: drafts, review, approval, sending control, per-recipient log
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { asyncHandler, AppError } from "../middleware/error-handler.js";
import { requirePermission } from "../middleware/session.js";
import { audit } from "../lib/audit.js";
import { ok, okPage, searchParam, skipTake } from "../lib/http.js";
import { campaignInclude, toCampaignDetail, toCampaignSummaries, toSendDto } from "../lib/serialize.js";
import {
  approveCampaign,
  assertEditable,
  cancelCampaign,
  pauseCampaign,
  requestApproval,
  resolveUnknown,
  resumeCampaign,
  retryFailed,
  reviewCampaign,
  sendTest,
  startCampaign,
  withdrawApproval,
} from "../services/campaign-service.js";
import { sentInLast24h } from "../services/send-worker.js";
import { kickBackground } from "../services/background.js";
import { getCampaignAnalytics, recordSendOutcome } from "../services/analytics-service.js";
import { env } from "../config.js";
import {
  ApproveInputSchema,
  CampaignInputSchema,
  CampaignRecipientOverrideInputSchema,
  CampaignRuleInputSchema,
  CampaignStatusSchema,
  CampaignTemplateInputSchema,
  IdSchema,
  PaginationQuerySchema,
  TestSendInputSchema,
} from "../../shared/types.js";

const router = Router();

async function loadDetail(id: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: campaignInclude });
  if (!campaign) throw AppError.notFound("CAMPAIGN_NOT_FOUND", "That campaign no longer exists.");
  const detail = await toCampaignDetail(campaign);
  const sent24h = await sentInLast24h();
  return {
    ...detail,
    waitingReason:
      campaign.status === "SENDING" && sent24h >= env.DAILY_SEND_LIMIT
        ? `Waiting: the mailbox reached its limit of ${env.DAILY_SEND_LIMIT} emails in 24 hours. Sending continues automatically.`
        : null,
  };
}

async function assertReferences(templateId: string, contactListId: string) {
  const [template, list] = await Promise.all([
    prisma.template.findUnique({ where: { id: templateId } }),
    prisma.contactList.findUnique({ where: { id: contactListId } }),
  ]);
  if (!template) throw AppError.badRequest("TEMPLATE_NOT_FOUND", "Choose a template that still exists.");
  if (!list) throw AppError.badRequest("LIST_NOT_FOUND", "Choose a list that still exists.");
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = CampaignStatusSchema.optional().parse(searchParam(req.query.status));
    const search = searchParam(req.query.search);
    const where: Prisma.CampaignWhereInput = {
      ...(status ? { status } : {}),
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
    };
    const campaigns = await prisma.campaign.findMany({ where, include: campaignInclude, orderBy: { updatedAt: "desc" }, take: 200 });
    ok(res, await toCampaignSummaries(campaigns));
  })
);

router.post(
  "/",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const input = CampaignInputSchema.parse(req.body);
    await assertReferences(input.templateId, input.contactListId);
    const campaign = await prisma.campaign.create({ data: { ...input, createdById: req.user!.id } });
    await audit(req, { action: "campaign.create", entityType: "Campaign", entityId: campaign.id, metadata: { name: campaign.name } });
    ok(res, await loadDetail(campaign.id), 201);
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => ok(res, await loadDetail(IdSchema.parse(req.params.id))))
);

router.patch(
  "/:id",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await assertEditable(id);
    const input = CampaignInputSchema.partial().parse(req.body);
    const current = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    await assertReferences(input.templateId ?? current.templateId, input.contactListId ?? current.contactListId);
    await prisma.campaign.update({ where: { id }, data: input });
    await audit(req, { action: "campaign.update", entityType: "Campaign", entityId: id, metadata: { fields: Object.keys(input) } });
    ok(res, await loadDetail(id));
  })
);

router.post(
  "/:id/duplicate",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const source = await prisma.campaign.findUnique({ where: { id } });
    if (!source) throw AppError.notFound("CAMPAIGN_NOT_FOUND", "That campaign no longer exists.");
    let name = `${source.name} (copy)`;
    for (let n = 2; await prisma.campaign.findUnique({ where: { name } }); n++) name = `${source.name} (copy ${n})`;
    const copy = await prisma.campaign.create({
      data: {
        name,
        description: source.description,
        templateId: source.templateId,
        contactListId: source.contactListId,
        fromName: source.fromName,
        replyTo: source.replyTo,
        sendRatePerMinute: source.sendRatePerMinute,
        createdById: req.user!.id,
      },
    });
    await audit(req, { action: "campaign.duplicate", entityType: "Campaign", entityId: copy.id, metadata: { from: source.name } });
    ok(res, await loadDetail(copy.id), 201);
  })
);

router.delete(
  "/:id",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw AppError.notFound("CAMPAIGN_NOT_FOUND", "That campaign no longer exists.");
    const sent = await prisma.send.count({ where: { campaignId: id, status: { in: ["SENT", "UNKNOWN", "CLAIMED"] } } });
    if (!["DRAFT", "CANCELLED"].includes(campaign.status) || sent > 0) {
      throw AppError.conflict("NOT_DELETABLE", "Only drafts and cancelled campaigns that sent nothing can be deleted. Sent history is kept.");
    }
    await prisma.campaign.delete({ where: { id } });
    await audit(req, { action: "campaign.delete", entityType: "Campaign", entityId: id, metadata: { name: campaign.name } });
    ok(res, { id });
  })
);

// ---------------------------------------------------------------------------
// Multi-Template & Rules Management
// ---------------------------------------------------------------------------

router.get(
  "/:id/templates",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const detail = await loadDetail(id);
    ok(res, detail.templates);
  })
);

router.post(
  "/:id/templates",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await assertEditable(id);
    const input = CampaignTemplateInputSchema.parse(req.body);
    const template = await prisma.template.findUnique({ where: { id: input.templateId } });
    if (!template) throw AppError.badRequest("TEMPLATE_NOT_FOUND", "Choose a template that still exists.");

    await prisma.$transaction(async (tx) => {
      if (input.isFallback) {
        await tx.campaignTemplate.updateMany({ where: { campaignId: id }, data: { isFallback: false } });
      }
      await tx.campaignTemplate.upsert({
        where: { campaignId_templateId: { campaignId: id, templateId: input.templateId } },
        create: { campaignId: id, templateId: input.templateId, isFallback: input.isFallback, priority: input.priority },
        update: { isFallback: input.isFallback, priority: input.priority },
      });
      await audit(req, { action: "campaign.template_add", entityType: "Campaign", entityId: id, metadata: { templateId: input.templateId, templateName: template.name } }, tx);
    });
    ok(res, await loadDetail(id));
  })
);

router.delete(
  "/:id/templates/:templateId",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const templateId = IdSchema.parse(req.params.templateId);
    await assertEditable(id);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id }, include: { campaignTemplates: true } });
    if (campaign.templateId === templateId && campaign.campaignTemplates.length <= 1) {
      throw AppError.badRequest("LAST_TEMPLATE", "A campaign must have at least one template.");
    }
    await prisma.$transaction(async (tx) => {
      await tx.campaignRule.deleteMany({ where: { campaignId: id, templateId } });
      await tx.campaignRecipientOverride.deleteMany({ where: { campaignId: id, templateId } });
      await tx.campaignTemplate.deleteMany({ where: { campaignId: id, templateId } });
      await audit(req, { action: "campaign.template_remove", entityType: "Campaign", entityId: id, metadata: { templateId } }, tx);
    });
    ok(res, await loadDetail(id));
  })
);

router.get(
  "/:id/rules",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const detail = await loadDetail(id);
    ok(res, detail.rules);
  })
);

router.post(
  "/:id/rules",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await assertEditable(id);
    const input = CampaignRuleInputSchema.parse(req.body);
    const template = await prisma.template.findUnique({ where: { id: input.templateId } });
    if (!template) throw AppError.badRequest("TEMPLATE_NOT_FOUND", "Choose a template that still exists.");

    const rule = await prisma.campaignRule.create({
      data: {
        campaignId: id,
        templateId: input.templateId,
        priority: input.priority,
        hotelSegment: input.hotelSegment || null,
        contactPersona: input.contactPersona || null,
        requiresVerified: input.requiresVerified,
        minConfidence: input.minConfidence,
        city: input.city || null,
        description: input.description,
      },
      include: { template: { select: { id: true, name: true } } },
    });
    await audit(req, { action: "campaign.rule_create", entityType: "CampaignRule", entityId: rule.id, metadata: { priority: rule.priority, template: template.name } });
    ok(res, await loadDetail(id), 201);
  })
);

router.put(
  "/:id/rules/:ruleId",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const ruleId = IdSchema.parse(req.params.ruleId);
    await assertEditable(id);
    const input = CampaignRuleInputSchema.partial().parse(req.body);
    if (input.templateId) {
      const template = await prisma.template.findUnique({ where: { id: input.templateId } });
      if (!template) throw AppError.badRequest("TEMPLATE_NOT_FOUND", "Choose a template that still exists.");
    }
    await prisma.campaignRule.update({
      where: { id: ruleId, campaignId: id },
      data: input,
    });
    await audit(req, { action: "campaign.rule_update", entityType: "CampaignRule", entityId: ruleId });
    ok(res, await loadDetail(id));
  })
);

router.delete(
  "/:id/rules/:ruleId",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const ruleId = IdSchema.parse(req.params.ruleId);
    await assertEditable(id);
    await prisma.campaignRule.delete({ where: { id: ruleId, campaignId: id } });
    await audit(req, { action: "campaign.rule_delete", entityType: "CampaignRule", entityId: ruleId });
    ok(res, await loadDetail(id));
  })
);

router.get(
  "/:id/overrides",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const overrides = await prisma.campaignRecipientOverride.findMany({
      where: { campaignId: id },
      include: { contact: { select: { email: true } }, template: { select: { name: true } } },
    });
    ok(
      res,
      overrides.map((o) => ({
        id: o.id,
        campaignId: o.campaignId,
        contactId: o.contactId,
        contactEmail: o.contact.email,
        templateId: o.templateId,
        templateName: o.template.name,
        reason: o.reason,
        createdAt: o.createdAt.toISOString(),
      }))
    );
  })
);

router.post(
  "/:id/overrides",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await assertEditable(id);
    const input = CampaignRecipientOverrideInputSchema.parse(req.body);
    const [contact, template] = await Promise.all([
      prisma.contact.findUnique({ where: { id: input.contactId } }),
      prisma.template.findUnique({ where: { id: input.templateId } }),
    ]);
    if (!contact) throw AppError.badRequest("CONTACT_NOT_FOUND", "Contact no longer exists.");
    if (!template) throw AppError.badRequest("TEMPLATE_NOT_FOUND", "Template no longer exists.");

    const override = await prisma.campaignRecipientOverride.upsert({
      where: { campaignId_contactId: { campaignId: id, contactId: input.contactId } },
      create: { campaignId: id, contactId: input.contactId, templateId: input.templateId, reason: input.reason },
      update: { templateId: input.templateId, reason: input.reason },
    });
    await audit(req, { action: "campaign.override_set", entityType: "CampaignRecipientOverride", entityId: override.id, metadata: { contact: contact.email, template: template.name } });
    ok(res, await loadDetail(id));
  })
);

router.delete(
  "/:id/overrides/:contactId",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const contactId = IdSchema.parse(req.params.contactId);
    await assertEditable(id);
    await prisma.campaignRecipientOverride.deleteMany({ where: { campaignId: id, contactId } });
    await audit(req, { action: "campaign.override_remove", entityType: "Campaign", entityId: id, metadata: { contactId } });
    ok(res, await loadDetail(id));
  })
);

// ---------------------------------------------------------------------------
// Review & approval
// ---------------------------------------------------------------------------

router.get(
  "/:id/review",
  asyncHandler(async (req, res) => ok(res, await reviewCampaign(IdSchema.parse(req.params.id))))
);

router.post(
  "/:id/request-approval",
  requirePermission("campaigns.request_approval"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await requestApproval(req, id);
    ok(res, await loadDetail(id));
  })
);

router.post(
  "/:id/return-to-draft",
  requirePermission("campaigns.request_approval"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const { note } = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    await withdrawApproval(req, id, note);
    ok(res, await loadDetail(id));
  })
);

router.post(
  "/:id/approve",
  requirePermission("campaigns.approve"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await approveCampaign(req, id, ApproveInputSchema.parse(req.body));
    ok(res, await loadDetail(id));
  })
);

// ---------------------------------------------------------------------------
// Sending control
// ---------------------------------------------------------------------------

const control = (fn: (req: Parameters<typeof startCampaign>[0], id: string) => Promise<unknown>) =>
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await fn(req, id);
    ok(res, await loadDetail(id));
  });

router.post("/:id/start", requirePermission("campaigns.control"), control(async (req, id) => { await startCampaign(req, id); kickBackground(); }));
router.post("/:id/pause", requirePermission("campaigns.control"), control((req, id) => pauseCampaign(req, id)));
router.post("/:id/resume", requirePermission("campaigns.control"), control(async (req, id) => { await resumeCampaign(req, id); kickBackground(); }));
router.post("/:id/cancel", requirePermission("campaigns.control"), control(cancelCampaign));
router.post("/:id/retry-failed", requirePermission("campaigns.control"), control(async (req, id) => { await retryFailed(req, id); kickBackground(); }));

router.post(
  "/:id/sends/:sendId/resolve",
  requirePermission("campaigns.control"),
  asyncHandler(async (req, res) => {
    const { outcome } = z.object({ outcome: z.enum(["sent", "retry"]) }).parse(req.body);
    await resolveUnknown(req, IdSchema.parse(req.params.id), IdSchema.parse(req.params.sendId), outcome);
    if (outcome === "retry") kickBackground();
    ok(res, null);
  })
);

router.post(
  "/:id/test",
  requirePermission("campaigns.send_test"),
  asyncHandler(async (req, res) => {
    const { to, contactId, dryRun } = TestSendInputSchema.parse(req.body);
    ok(res, await sendTest(req, IdSchema.parse(req.params.id), to, contactId, { dryRun }));
  })
);

router.get(
  "/:id/analytics",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    ok(res, await getCampaignAnalytics(id));
  })
);

router.post(
  "/:id/sends/:sendId/outcome",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const sendId = IdSchema.parse(req.params.sendId);
    const input = z
      .object({
        replyClassification: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL", "OUT_OF_OFFICE"]).optional(),
        meetingBooked: z.boolean().optional(),
        note: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const event = await recordSendOutcome(sendId, input);
    await audit(req, {
      action: "send.record_outcome",
      entityType: "Send",
      entityId: sendId,
      metadata: input,
    });
    ok(res, event);
  })
);

// ---------------------------------------------------------------------------
// Per-recipient log
// ---------------------------------------------------------------------------

const SEND_FILTERS: Record<string, Prisma.SendWhereInput> = {
  pending: { status: { in: ["PENDING", "CLAIMED"] } },
  sent: { status: "SENT" },
  failed: { status: "FAILED" },
  unknown: { status: "UNKNOWN" },
  skipped: { status: "SKIPPED" },
  cancelled: { status: "CANCELLED" },
  bounced: { bouncedAt: { not: null } },
  replied: { repliedAt: { not: null } },
  unsubscribed: { unsubscribedAt: { not: null } },
};

router.get(
  "/:id/sends",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const { page, pageSize } = PaginationQuerySchema.parse(req.query);
    const filter = searchParam(req.query.filter);
    const search = searchParam(req.query.search);
    const where: Prisma.SendWhereInput = {
      campaignId: id,
      ...(filter && SEND_FILTERS[filter] ? SEND_FILTERS[filter] : {}),
      ...(search ? { email: { contains: search, mode: "insensitive" } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.send.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "asc" }], ...skipTake(page, pageSize) }),
      prisma.send.count({ where }),
    ]);
    okPage(res, rows.map(toSendDto), page, pageSize, total);
  })
);

router.get(
  "/:id/sends/:sendId",
  asyncHandler(async (req, res) => {
    const send = await prisma.send.findFirst({
      where: { id: IdSchema.parse(req.params.sendId), campaignId: IdSchema.parse(req.params.id) },
      include: { events: { orderBy: { occurredAt: "asc" } } },
    });
    if (!send) throw AppError.notFound("SEND_NOT_FOUND", "That message no longer exists.");
    ok(res, {
      ...toSendDto(send),
      subject: send.subject,
      html: send.html,
      text: send.text,
      events: send.events.map((e) => ({ id: e.id, type: e.type, occurredAt: e.occurredAt.toISOString(), detail: e.detail })),
    });
  })
);

router.get(
  "/:id/export",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw AppError.notFound("CAMPAIGN_NOT_FOUND", "That campaign no longer exists.");
    const sends = await prisma.send.findMany({ where: { campaignId: id }, orderBy: { email: "asc" } });
    const cell = (v: unknown) => {
      const s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? "" : String(v);
      // Quote everything; neutralise spreadsheet formula injection
      return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
    };
    const header = ["Email", "Status", "Reason / error", "Attempts", "Sent at", "Bounced at", "Replied at", "Unsubscribed at"];
    const lines = sends.map((s) =>
      [s.email, s.status, s.skipReason ?? s.lastError, s.attempts, s.sentAt, s.bouncedAt, s.repliedAt, s.unsubscribedAt].map(cell).join(",")
    );
    const safeName = campaign.name.replace(/[^A-Za-z0-9 _-]/g, "").trim().replace(/\s+/g, "-") || "campaign";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}-recipients.csv"`);
    res.send("﻿" + [header.map(cell).join(","), ...lines].join("\r\n"));
  })
);

export default router;
