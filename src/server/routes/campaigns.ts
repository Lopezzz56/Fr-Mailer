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
import { env } from "../config.js";
import {
  ApproveInputSchema,
  CampaignInputSchema,
  CampaignStatusSchema,
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
    const { to, contactId } = TestSendInputSchema.parse(req.body);
    ok(res, await sendTest(req, IdSchema.parse(req.params.id), to, contactId));
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
