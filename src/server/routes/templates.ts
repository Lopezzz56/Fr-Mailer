// Email templates
import { Router } from "express";
import crypto from "crypto";
import multer from "multer";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { asyncHandler, AppError } from "../middleware/error-handler.js";
import { requirePermission } from "../middleware/session.js";
import { audit } from "../lib/audit.js";
import { ok, searchParam } from "../lib/http.js";
import { toTemplateDto, templateInclude } from "../lib/serialize.js";
import { canAct } from "../../shared/auth.js";
import { validateTemplate } from "../../shared/merge.js";
import { IdSchema, TemplateInputSchema } from "../../shared/types.js";
import { TemplateDraftRequestSchema } from "../../shared/template-writer.js";
import { env } from "../config.js";
import { draftWithGemini, generateBotDraft, writerContext, writerFields } from "../services/template-ai.js";
import { deleteTemplateAttachmentObject, storedAttachments, uploadTemplateAttachment } from "../services/template-storage.js";
import { assertTemplateAccessible, visibleTemplatesWhere } from "../lib/resource-visibility.js";

const router = Router();
const withCount = { _count: { select: { campaigns: true } } } as const;
const attachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const MAX_TEMPLATE_ATTACHMENTS = 5;
const MAX_TEMPLATE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Map([
  [".pdf", "application/pdf"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

async function editableTemplate(id: string, user: NonNullable<Express.Request["user"]>) {
  const template = await prisma.template.findUnique({ where: { id } });
  assertTemplateAccessible(template, user);
  if (template.scope === "ORGANIZATION" && !canAct(user, "templates.manage_org")) {
    throw AppError.forbidden("PERMISSION_DENIED", "Only Founders and Founder's Office can edit organization templates.");
  }
  return template;
}

function requireAttachment(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file) throw AppError.badRequest("NO_FILE", "Choose a PDF, PowerPoint, or image file to attach.");
  const ext = file.originalname.slice(file.originalname.lastIndexOf(".")).toLowerCase();
  const allowedType = ALLOWED_ATTACHMENT_TYPES.get(ext);
  if (!allowedType || file.mimetype !== allowedType) {
    throw AppError.badRequest("UNSUPPORTED_ATTACHMENT", "Only PDF, PPT, PPTX, and image (PNG, JPEG, GIF, WEBP) attachments are supported.");
  }
  return file;
}

function assertValid(parts: { subject: string; bodyHtml: string; bodyText?: string | null }) {
  const errors = validateTemplate(parts);
  if (errors.length) throw AppError.badRequest("TEMPLATE_INVALID", errors[0]!, { errors });
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const search = searchParam(req.query.search);
    const scopeParam = searchParam(req.query.scope);
    const categoryParam = searchParam(req.query.category);
    const campaignIdParam = searchParam(req.query.campaignId);
    const user = req.user!;

    const searchWhere: Prisma.TemplateWhereInput = search
      ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { subject: { contains: search, mode: "insensitive" } }] }
      : {};
    const normalizedScope = scopeParam?.toUpperCase();
    const scopeWhere: Prisma.TemplateWhereInput =
      campaignIdParam
        ? {
            OR: [
              { campaignTemplates: { some: { campaignId: campaignIdParam } } },
              { sequenceSteps: { some: { campaignId: campaignIdParam } } },
            ],
          }
        : normalizedScope === "MINE"
          ? { createdById: user.id }
          : normalizedScope === "PERSONAL"
            ? { scope: "PERSONAL", createdById: user.id }
            : normalizedScope === "SHARED" || normalizedScope === "ORGANIZATION"
              ? { scope: normalizedScope }
              : normalizedScope === "CAMPAIGN"
                ? { scope: "CAMPAIGN" }
                : visibleTemplatesWhere(user.id);

    const categoryWhere: Prisma.TemplateWhereInput = categoryParam
      ? { category: { equals: categoryParam, mode: "insensitive" } }
      : {};

    const scopedWhere: Prisma.TemplateWhereInput = { AND: [searchWhere, scopeWhere, categoryWhere] };

    const templates = await prisma.template.findMany({ where: scopedWhere, orderBy: { updatedAt: "desc" }, include: templateInclude });
    ok(res, templates.map(toTemplateDto));
  })
);

router.post(
  "/:id/attachments",
  requirePermission("templates.manage"),
  attachmentUpload.single("file"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const template = await editableTemplate(id, req.user!);
    const file = requireAttachment(req.file);
    const attachments = storedAttachments(template.attachments);
    const currentBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
    if (attachments.length >= MAX_TEMPLATE_ATTACHMENTS) {
      throw AppError.badRequest("ATTACHMENT_LIMIT", `A template can have up to ${MAX_TEMPLATE_ATTACHMENTS} attachments.`);
    }
    if (currentBytes + file.size > MAX_TEMPLATE_ATTACHMENT_BYTES) {
      throw AppError.badRequest("ATTACHMENT_LIMIT", "Template attachments cannot exceed 20 MB in total.");
    }

    const attachmentId = crypto.randomUUID();
    const storageKey = `${id}/${attachmentId}`;
    const attachment = {
      id: attachmentId,
      name: file.originalname.replace(/[\\/\u0000-\u001f\u007f]/g, "_").slice(0, 180) || "attachment",
      contentType: file.mimetype,
      size: file.size,
      storageKey,
    };
    await uploadTemplateAttachment(storageKey, file.mimetype, file.buffer);
    try {
      await prisma.template.update({
        where: { id },
        data: { attachments: [...attachments, attachment], version: { increment: 1 } },
      });
    } catch (error) {
      await deleteTemplateAttachmentObject(storageKey).catch(() => {
        console.error("[templates] couldn't clean up an unlinked attachment after a database error");
      });
      throw error;
    }

    await audit(req, {
      action: "template.attachment.add",
      entityType: "Template",
      entityId: id,
      metadata: { name: attachment.name, size: attachment.size },
    });
    ok(res, { id: attachment.id, name: attachment.name, contentType: attachment.contentType, size: attachment.size }, 201);
  })
);

router.delete(
  "/:id/attachments/:attachmentId",
  requirePermission("templates.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const attachmentId = z.string().uuid().parse(req.params.attachmentId);
    const template = await editableTemplate(id, req.user!);
    const attachments = storedAttachments(template.attachments);
    const removed = attachments.find((attachment) => attachment.id === attachmentId);
    if (!removed) throw AppError.notFound("ATTACHMENT_NOT_FOUND", "That template attachment no longer exists.");

    await prisma.template.update({
      where: { id },
      data: {
        attachments: attachments.filter((attachment) => attachment.id !== attachmentId),
        version: { increment: 1 },
      },
    });
    const [reference] = await prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM templates WHERE attachments @> ${JSON.stringify([{ id: attachmentId }])}::jsonb
        UNION ALL
        SELECT 1 FROM sends WHERE attachments @> ${JSON.stringify([{ id: attachmentId }])}::jsonb
      ) AS "exists"`;
    if (!reference?.exists) {
      await deleteTemplateAttachmentObject(removed.storageKey).catch(() => {
        console.error("[templates] removed attachment remains in storage and may need cleanup");
      });
    }
    await audit(req, {
      action: "template.attachment.remove",
      entityType: "Template",
      entityId: id,
      metadata: { name: removed.name },
    });
    ok(res, { id: attachmentId });
  })
);

// ---------------------------------------------------------------------------
// Template writer (registered before "/:id")
// ---------------------------------------------------------------------------

/** Fields the workspace can personalize with, and whether AI drafting is available */
router.get(
  "/ai/context",
  asyncHandler(async (_req, res) => {
    ok(res, await writerContext());
  })
);

// Counted from the audit log, so the limit holds across restarts and serverless instances
const AI_DRAFTS_PER_HOUR_PER_PERSON = 30;
const AI_DRAFTS_PER_DAY = 300;

router.post(
  "/ai/draft",
  requirePermission("templates.manage"),
  asyncHandler(async (req, res) => {
    const input = TemplateDraftRequestSchema.parse(req.body);
    const hourAgo = new Date(Date.now() - 3600_000);
    const dayAgo = new Date(Date.now() - 86_400_000);
    const [mine, all] = await Promise.all([
      prisma.auditLog.count({ where: { action: "template.ai_draft", userId: req.user!.id, createdAt: { gte: hourAgo } } }),
      prisma.auditLog.count({ where: { action: "template.ai_draft", createdAt: { gte: dayAgo } } }),
    ]);
    if (mine >= AI_DRAFTS_PER_HOUR_PER_PERSON) throw new AppError("AI_LIMIT", `You've made ${mine} AI drafts in the last hour. Try again later, or use a starter template.`, 429);
    if (all >= AI_DRAFTS_PER_DAY) throw new AppError("AI_LIMIT", "The workspace reached today's AI draft limit. Try again tomorrow, or use a starter template.", 429);

    const fields = await writerFields();
    let draft;
    try {
      draft = await draftWithGemini(input, fields);
    } catch (err) {
      console.warn("[templates] Gemini drafting failed; falling back to intelligent template engine:", (err as Error).message);
      draft = generateBotDraft(input, fields);
    }

    await audit(req, {
      action: "template.ai_draft",
      entityType: "Template",
      metadata: { model: draft.model || env.GEMINI_MODEL, tone: input.tone, length: input.length, briefChars: input.brief.length, withExample: Boolean(input.example), warnings: draft.warnings.length },
    });
    ok(res, draft);
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const user = req.user!;
    const template = await prisma.template.findUnique({ where: { id }, include: templateInclude });
    assertTemplateAccessible(template, user);

    ok(res, toTemplateDto(template));
  })
);

async function findUniqueTemplateName(baseName: string, excludeId?: string): Promise<string> {
  const trimmed = baseName.trim() || "Untitled template";
  let candidate = trimmed;
  let counter = 2;

  const match = trimmed.match(/^(.*?)\s*\((\d+)\)$/);
  let prefix = trimmed;
  if (match) {
    prefix = match[1]!.trim();
    counter = parseInt(match[2]!, 10) + 1;
  }

  while (true) {
    const existing = await prisma.template.findUnique({ where: { name: candidate } });
    if (!existing || (excludeId && existing.id === excludeId)) {
      return candidate;
    }
    candidate = `${prefix} (${counter})`;
    counter++;
  }
}

router.post(
  "/",
  requirePermission("templates.manage"),
  asyncHandler(async (req, res) => {
    const input = TemplateInputSchema.parse(req.body);
    const user = req.user!;
    assertValid(input);

    let scope = input.scope ?? (input.campaignId ? "CAMPAIGN" : "PERSONAL");
    if (scope === "ORGANIZATION" && !canAct(user, "templates.manage_org")) {
      throw AppError.forbidden("PERMISSION_DENIED", "Only Founders and Founder's Office can create organization-wide templates.");
    }

    const { campaignId, ...templateData } = input;
    const name = await findUniqueTemplateName(input.name);
    const template = await prisma.$transaction(async (tx) => {
      const created = await tx.template.create({
        data: {
          ...templateData,
          name,
          scope,
          createdById: user.id,
        },
        include: templateInclude,
      });

      if (campaignId) {
        await tx.campaignTemplate.upsert({
          where: { campaignId_templateId: { campaignId, templateId: created.id } },
          create: { campaignId, templateId: created.id, isFallback: false, priority: 0 },
          update: {},
        });
      }
      return created;
    });

    await audit(req, { action: "template.create", entityType: "Template", entityId: template.id, metadata: { name: template.name, scope, campaignId } });
    ok(res, toTemplateDto(template), 201);
  })
);

router.patch(
  "/:id",
  requirePermission("templates.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const user = req.user!;
    const existing = await prisma.template.findUnique({ where: { id } });
    if (!existing) throw AppError.notFound("TEMPLATE_NOT_FOUND", "That template no longer exists.");

    assertTemplateAccessible(existing, user);
    if (existing.scope === "ORGANIZATION" && !canAct(user, "templates.manage_org")) {
      throw AppError.forbidden("PERMISSION_DENIED", "Only Founders and Founder's Office can edit organization templates.");
    }

    const input = TemplateInputSchema.partial().parse(req.body);
    if (input.scope === "ORGANIZATION" && existing.scope !== "ORGANIZATION" && !canAct(user, "templates.manage_org")) {
      throw AppError.forbidden("PERMISSION_DENIED", "Only Founders and Founder's Office can set a template to organization scope.");
    }

    const { campaignId, ...updateData } = input;
    const next = {
      subject: updateData.subject ?? existing.subject,
      bodyHtml: updateData.bodyHtml ?? existing.bodyHtml,
      bodyText: updateData.bodyText !== undefined ? updateData.bodyText : existing.bodyText,
    };
    assertValid(next);
    const contentChanged = next.subject !== existing.subject || next.bodyHtml !== existing.bodyHtml || next.bodyText !== existing.bodyText;
    let name = updateData.name;
    if (updateData.name && updateData.name.trim() !== existing.name) {
      name = await findUniqueTemplateName(updateData.name, id);
    }
    const template = await prisma.template.update({
      where: { id },
      data: {
        ...updateData,
        name,
        ...(contentChanged ? { version: { increment: 1 } } : {}),
      },
      include: templateInclude,
    });
    if (campaignId) {
      await prisma.campaignTemplate.upsert({
        where: { campaignId_templateId: { campaignId, templateId: id } },
        create: { campaignId, templateId: id, isFallback: false, priority: 99 },
        update: {},
      });
    }
    await audit(req, { action: "template.update", entityType: "Template", entityId: id, metadata: { name: template.name, version: template.version } });
    ok(res, toTemplateDto(template));
  })
);

router.post(
  "/:id/duplicate",
  requirePermission("templates.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const user = req.user!;
    const source = await prisma.template.findUnique({ where: { id } });
    assertTemplateAccessible(source, user);

    let name = `${source.name} (copy)`;
    for (let n = 2; await prisma.template.findUnique({ where: { name } }); n++) name = `${source.name} (copy ${n})`;
    const copy = await prisma.template.create({
      data: {
        name,
        subject: source.subject,
        bodyHtml: source.bodyHtml,
        bodyText: source.bodyText,
        attachments: source.attachments === null ? Prisma.JsonNull : source.attachments,
        description: source.description,
        scope: "PERSONAL",
        createdById: user.id,
      },
      include: templateInclude,
    });
    await audit(req, { action: "template.duplicate", entityType: "Template", entityId: copy.id, metadata: { from: source.name } });
    ok(res, toTemplateDto(copy), 201);
  })
);

router.delete(
  "/:id",
  requirePermission("templates.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const user = req.user!;
    const existing = await prisma.template.findUnique({ where: { id } });
    if (!existing) throw AppError.notFound("TEMPLATE_NOT_FOUND", "That template no longer exists.");

    if (existing.scope === "ORGANIZATION" && !canAct(user, "templates.manage_org")) {
      throw AppError.forbidden("PERMISSION_DENIED", "Only Founders and Founder's Office can delete organization templates.");
    }
    if (existing.scope === "PERSONAL" && existing.createdById && existing.createdById !== user.id && user.role === "EMPLOYEE") {
      throw AppError.forbidden("PERMISSION_DENIED", "You cannot delete another person's personal template.");
    }

    const [usedInCampaign, usedInMulti, usedInRules] = await Promise.all([
      prisma.campaign.count({ where: { templateId: id } }),
      prisma.campaignTemplate.count({ where: { templateId: id } }),
      prisma.campaignRule.count({ where: { templateId: id } }),
    ]);
    const totalUses = usedInCampaign + usedInMulti + usedInRules;
    if (totalUses > 0) {
      throw AppError.conflict("TEMPLATE_IN_USE", `This template is used by ${usedInCampaign || usedInMulti} campaign(s) and ${usedInRules} targeting rule(s). Remove it from those campaigns first, or duplicate it.`);
    }
    const template = await prisma.template.delete({ where: { id } });
    await audit(req, { action: "template.delete", entityType: "Template", entityId: id, metadata: { name: template.name } });
    ok(res, { id });
  })
);

/** Server-side validation, for clients that want the authoritative answer */
router.post(
  "/validate",
  asyncHandler(async (req, res) => {
    const parts = z.object({ subject: z.string(), bodyHtml: z.string(), bodyText: z.string().optional().nullable() }).parse(req.body);
    ok(res, { errors: validateTemplate(parts) });
  })
);

export default router;
