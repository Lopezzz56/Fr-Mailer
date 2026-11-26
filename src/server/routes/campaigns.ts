// Campaigns: drafts, review, approval, sending control, per-recipient log
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { asyncHandler, AppError } from "../middleware/error-handler.js";
import { requirePermission } from "../middleware/session.js";
import { audit } from "../lib/audit.js";
import { assertListAccessible, assertTemplateAccessible } from "../lib/resource-visibility.js";
import { ok, okPage, searchParam, skipTake } from "../lib/http.js";
import { campaignInclude, campaignSummaryInclude, toCampaignDetail, toCampaignSummaries, toSendDto } from "../lib/serialize.js";
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
import { sentInLast24hForCampaign } from "../services/send-worker.js";
import { kickBackground } from "../services/background.js";
import { getPersonalMailboxStatus } from "../services/personal-mailbox.js";
import { getCampaignAnalytics, recordSendOutcome } from "../services/analytics-service.js";
import { listCampaignRecipients } from "../services/campaign-recipients.js";
import { selectTemplateForRecipient, type EligibleTemplate, type SelectionContext } from "../services/template-selection.js";
import { inferPersonaFromTitle, inferSegmentFromCompany } from "../services/classification.js";
import { contactMergeData, htmlToText, renderEmail, type TemplateParts } from "../../shared/merge.js";
import { synthesizeRecipientPersonalization } from "../../shared/partner-intelligence.js";
import { env } from "../config.js";
import {
  ApproveInputSchema,
  CampaignAutomationModeSchema,
  CampaignInputSchema,
  CampaignRecipientOverrideInputSchema,
  CampaignRuleInputSchema,
  CampaignStatusSchema,
  CampaignTemplateInputSchema,
  ConversationStatus,
  IdSchema,
  PaginationQuerySchema,
  SequenceStepInputSchema,
  TestSendInputSchema,
} from "../../shared/types.js";
import {
  AddCollaboratorSchema,
  canAct,
  type CampaignAccessRole,
  type SessionUser,
} from "../../shared/auth.js";
import {
  approveFollowUpSend,
  approveAllPendingFollowUps,
  pauseRecipientSequence,
  resumeRecipientSequence,
  stopSequenceForRecipient,
  stopAllPendingFollowUps,
  getRecipientSequenceDetails,
  aiDraftFollowUp,
} from "../services/sequence-service.js";
import { findOrCreateConversation, toConversationDto } from "../services/conversation-service.js";

const router = Router();

export type CampaignAccessLevel = "VIEW" | "EDIT" | "ADMIN";

export function checkCampaignAccess(
  campaign: { createdById?: string | null; collaborators?: { userId: string; role: CampaignAccessRole }[] },
  user: SessionUser,
  required: CampaignAccessLevel
): boolean {
  if (user.role === "FOUNDER" || user.role === "FOUNDER_OFFICE") return true;
  if (campaign.createdById === user.id) return true;

  const collaborator = campaign.collaborators?.find((c) => c.userId === user.id);
  if (!collaborator) return false;

  if (required === "VIEW") return true;
  if (required === "EDIT") return collaborator.role === "OWNER" || collaborator.role === "EDITOR";
  if (required === "ADMIN") return collaborator.role === "OWNER";

  return false;
}

async function loadDetail(id: string, user?: SessionUser, requiredAccess: CampaignAccessLevel = "VIEW") {
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: campaignInclude });
  if (!campaign) throw AppError.notFound("CAMPAIGN_NOT_FOUND", "That campaign no longer exists.");

  if (user) {
    const hasAccess = checkCampaignAccess(campaign, user, requiredAccess);
    if (!hasAccess) {
      const canView = checkCampaignAccess(campaign, user, "VIEW");
      if (canView) {
        throw AppError.forbidden("PERMISSION_DENIED", "You do not have sufficient permissions for this campaign.");
      }
      throw AppError.notFound("CAMPAIGN_NOT_FOUND", "That campaign no longer exists.");
    }
  }

  const detail = await toCampaignDetail(campaign);
  const budget = await sentInLast24hForCampaign(campaign);
  return {
    ...detail,
    waitingReason:
      campaign.status === "SENDING" && budget.remainingBudget <= 0
        ? `Waiting: mailbox ${budget.identity.email} reached its ${budget.dailyLimit} emails in 24 hours safety limit. Sending continues automatically as capacity frees up.`
        : null,
  };
}

async function assertReferences(templateId: string, contactListId: string, user: NonNullable<Express.Request["user"]>) {
  const [template, list] = await Promise.all([
    prisma.template.findUnique({ where: { id: templateId } }),
    prisma.contactList.findUnique({ where: { id: contactListId } }),
  ]);
  assertTemplateAccessible(template, user);
  assertListAccessible(list, user);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = CampaignStatusSchema.optional().parse(searchParam(req.query.status));
    const search = searchParam(req.query.search);
    const user = req.user!;

    const baseWhere: Prisma.CampaignWhereInput = {
      ...(status ? { status } : {}),
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
    };

    const where: Prisma.CampaignWhereInput =
      user.role === "FOUNDER" || user.role === "FOUNDER_OFFICE"
        ? baseWhere
        : {
            ...baseWhere,
            OR: [
              { createdById: user.id },
              { collaborators: { some: { userId: user.id } } },
            ],
          };

    const campaigns = await prisma.campaign.findMany({ where, include: campaignSummaryInclude, orderBy: { updatedAt: "desc" }, take: 200 });
    ok(res, await toCampaignSummaries(campaigns));
  })
);

router.post(
  "/preview-simulation",
  asyncHandler(async (req, res) => {
    const { contactListId, templates, rules, defaultTemplateId, campaignId } = z
      .object({
        contactListId: IdSchema,
        campaignId: IdSchema.optional(),
        templates: z
          .array(
            z.object({
              templateId: IdSchema,
              isFallback: z.boolean().default(false),
              priority: z.coerce.number().int().default(0),
            })
          )
          .min(1, "Select at least one template"),
        rules: z.array(CampaignRuleInputSchema).default([]),
        defaultTemplateId: IdSchema.optional(),
      })
      .parse(req.body);

    const list = await prisma.contactList.findUnique({
      where: { id: contactListId },
      include: {
        members: {
          include: { contact: true },
        },
      },
    });
    if (!list) throw AppError.notFound("LIST_NOT_FOUND", "Contact list not found.");
    assertListAccessible(list, req.user!);

    const overrides = campaignId
      ? await prisma.campaignRecipientOverride.findMany({
          where: { campaignId },
          include: { template: true },
        })
      : [];
    const overrideMap = new Map(overrides.map((o) => [o.contactId, o]));

    const templateIds = templates.map((t) => t.templateId);
    const dbTemplates = await prisma.template.findMany({
      where: { id: { in: templateIds } },
    });
    const templateMap = new Map(dbTemplates.map((t) => [t.id, t]));
    if (defaultTemplateId) assertTemplateAccessible(templateMap.get(defaultTemplateId) ?? null, req.user!);

    const eligibleTemplates: EligibleTemplate[] = templates.map((t) => {
      const dbT = templateMap.get(t.templateId);
      if (!dbT) throw AppError.badRequest("TEMPLATE_NOT_FOUND", `Template ${t.templateId} not found`);
      assertTemplateAccessible(dbT, req.user!);
      return {
        id: dbT.id,
        name: dbT.name,
        subject: dbT.subject,
        bodyHtml: dbT.bodyHtml,
        bodyText: dbT.bodyText,
        version: dbT.version,
        isFallback: t.isFallback,
      };
    });

    const fallback = eligibleTemplates.find((t) => t.isFallback) ?? eligibleTemplates[0]!;
    const defId = defaultTemplateId || fallback.id;

    const selectionContext: SelectionContext = {
      templates: eligibleTemplates,
      rules: rules.map((r, i) => ({
        id: `sim-rule-${i}`,
        templateId: r.templateId,
        priority: r.priority,
        hotelSegment: r.hotelSegment,
        contactPersona: r.contactPersona,
        requiresVerified: r.requiresVerified,
        minConfidence: r.minConfidence,
        city: r.city,
        description: r.description,
      })),
      defaultTemplateId: defId,
    };

    const countsByTemplate = new Map<string, number>();
    for (const t of eligibleTemplates) countsByTemplate.set(t.id, 0);

    const sample: any[] = [];
    const missingFields: { email: string; contactId: string; fields: string[] }[] = [];
    let readyCount = 0;

    for (const { contact } of list.members) {
      const customMap =
        typeof contact.customFields === "object" && contact.customFields !== null
          ? (contact.customFields as Record<string, string>)
          : {};

      let effectiveSegment = contact.hotelSegment;
      let effectiveSegmentConfidence = contact.hotelSegmentConfidence;
      let effectiveSegmentStatus = contact.hotelSegmentStatus;

      if (!effectiveSegment || effectiveSegment === "UNKNOWN") {
        const segInferred = inferSegmentFromCompany(contact.company, customMap, contact.email);
        if (segInferred && segInferred.value !== "UNKNOWN") {
          effectiveSegment = segInferred.value;
          effectiveSegmentConfidence = segInferred.confidence;
          effectiveSegmentStatus = segInferred.status;
          prisma.contact
            .update({
              where: { id: contact.id },
              data: {
                hotelSegment: segInferred.value,
                hotelSegmentStatus: segInferred.status,
                hotelSegmentConfidence: segInferred.confidence,
              },
            })
            .catch(() => {});
        }
      }

      let effectivePersona = contact.contactPersona;
      let effectivePersonaConfidence = contact.contactPersonaConfidence;
      let effectivePersonaStatus = contact.contactPersonaStatus;

      if (!effectivePersona || effectivePersona === "UNKNOWN") {
        const perInferred = inferPersonaFromTitle(contact.title);
        if (perInferred && perInferred.value !== "UNKNOWN") {
          effectivePersona = perInferred.value;
          effectivePersonaConfidence = perInferred.confidence;
          effectivePersonaStatus = perInferred.status;
          prisma.contact
            .update({
              where: { id: contact.id },
              data: {
                contactPersona: perInferred.value,
                contactPersonaStatus: perInferred.status,
                contactPersonaConfidence: perInferred.confidence,
              },
            })
            .catch(() => {});
        }
      }

      const selection = selectTemplateForRecipient(
        {
          id: contact.id,
          email: contact.email,
          firstName: contact.firstName,
          lastName: contact.lastName,
          company: contact.company,
          title: contact.title,
          hotelSegment: effectiveSegment,
          hotelSegmentConfidence: effectiveSegmentConfidence,
          hotelSegmentStatus: effectiveSegmentStatus,
          contactPersona: effectivePersona,
          contactPersonaConfidence: effectivePersonaConfidence,
          contactPersonaStatus: effectivePersonaStatus,
          customFields: customMap,
        },
        selectionContext
      );

      const ov = overrideMap.get(contact.id);
      let rendered: ReturnType<typeof renderEmail>;
      let targetTemplateId = selection.templateId;
      let targetTemplateName = selection.templateName;
      let assignmentSource = selection.assignmentSource;
      let assignmentReason = selection.explanation;
      let isCustom = false;

      if (ov && ov.isCustom && ov.customSubject && ov.customBodyHtml) {
        rendered = {
          subject: ov.customSubject,
          html: ov.customBodyHtml,
          text: ov.customBodyText || htmlToText(ov.customBodyHtml),
          missingFields: [],
        };
        assignmentSource = "OVERRIDE";
        assignmentReason = ov.reason || "Customized by user";
        isCustom = true;
        if (ov.template) {
          targetTemplateId = ov.template.id;
          targetTemplateName = ov.template.name;
        }
      } else {
        const parts: TemplateParts = {
          subject: selection.template.subject,
          bodyHtml: selection.template.bodyHtml,
          bodyText: selection.template.bodyText,
        };
        rendered = renderEmail(parts, contactMergeData(contact));
      }

      if (rendered.missingFields.length) {
        missingFields.push({ email: contact.email, contactId: contact.id, fields: rendered.missingFields });
        continue;
      }

      readyCount++;
      countsByTemplate.set(targetTemplateId, (countsByTemplate.get(targetTemplateId) ?? 0) + 1);

      if (sample.length < 15) {
        sample.push({
          contactId: contact.id,
          email: contact.email,
          firstName: contact.firstName,
          lastName: contact.lastName,
          company: contact.company,
          hotelSegment: effectiveSegment,
          contactPersona: effectivePersona,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          missingFields: rendered.missingFields,
          templateId: targetTemplateId,
          templateName: targetTemplateName,
          assignmentSource,
          assignmentReason,
          isCustom,
        });
      }
    }

    const templateBreakdown = eligibleTemplates.map((t) => ({
      templateId: t.id,
      templateName: t.name,
      count: countsByTemplate.get(t.id) ?? 0,
      isFallback: Boolean(t.isFallback),
    }));

    ok(res, {
      total: list.members.length,
      ready: readyCount,
      missingFields,
      templateBreakdown,
      sample,
    });
  })
);

router.post(
  "/",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const input = CampaignInputSchema.parse(req.body);
    await assertReferences(input.templateId, input.contactListId, req.user!);
    const additionalTemplateIds = new Set([
      ...(input.templates ?? []).map((item) => item.templateId),
      ...(input.rules ?? []).map((item) => item.templateId),
      ...(input.sequenceSteps ?? []).map((item) => item.templateId),
    ]);
    for (const templateId of additionalTemplateIds) {
      const found = await prisma.template.findUnique({ where: { id: templateId } });
      assertTemplateAccessible(found, req.user!);
    }

    let mailboxId: string | null = null;
    let fromEmail: string | null = null;

    if (input.mailboxId) {
      const mailbox = await prisma.mailboxAccount.findUnique({
        where: { id: input.mailboxId },
        include: { accessList: true },
      });
      if (!mailbox) throw AppError.notFound("MAILBOX_NOT_FOUND", "Mailbox not found.");
      const hasAccess = req.user!.role === "FOUNDER" || mailbox.accessList.some((a) => a.userId === req.user!.id);
      if (!hasAccess) {
        throw AppError.forbidden("MAILBOX_ACCESS_DENIED", "You are not authorized to send through this mailbox.");
      }
      mailboxId = mailbox.id;
      fromEmail = mailbox.email;
    } else {
      const userDefault = await prisma.mailboxAccess.findFirst({
        where: { userId: req.user!.id },
        include: { mailbox: true },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      });
      if (userDefault) {
        mailboxId = userDefault.mailbox.id;
        fromEmail = userDefault.mailbox.email;
      } else {
        const senderMailbox = await getPersonalMailboxStatus(req.user!.id);
        fromEmail = senderMailbox?.email ?? null;
      }
    }

    const campaign = await prisma.$transaction(async (tx) => {
      const created = await tx.campaign.create({
        data: {
          name: input.name,
          description: input.description,
          outreachType: input.outreachType ?? "CUSTOMER_OUTREACH",
          templateId: input.templateId,
          contactListId: input.contactListId,
          fromName: input.fromName,
          fromEmail,
          mailboxId,
          replyTo: input.replyTo,
          sendRatePerMinute: input.sendRatePerMinute,
          automationMode: input.automationMode ?? "APPROVAL_REQUIRED",
          createdById: req.user!.id,
        },
      });

      const stepsToInsert = input.sequenceSteps?.length
        ? input.sequenceSteps
        : [
            {
              stepIndex: 0,
              purpose: "Initial Outreach",
              delayDays: 0,
              delayBusinessDaysOnly: true,
              subjectMode: "STANDALONE" as const,
              templateId: input.templateId,
            },
            {
              stepIndex: 1,
              purpose: "Follow-up 1 — Add value & relevance",
              delayDays: 3,
              delayBusinessDaysOnly: true,
              subjectMode: "THREADED" as const,
              templateId: input.templateId,
            },
          ];

      for (const st of stepsToInsert) {
        await tx.campaignSequenceStep.create({
          data: {
            campaignId: created.id,
            stepIndex: st.stepIndex,
            purpose: st.purpose,
            delayDays: st.delayDays ?? (st.stepIndex === 0 ? 0 : 3),
            delayBusinessDaysOnly: st.delayBusinessDaysOnly ?? true,
            subjectMode: st.subjectMode ?? (st.stepIndex === 0 ? "STANDALONE" : "THREADED"),
            customSubject: st.customSubject,
            templateId: st.templateId,
            promptInstructions: st.promptInstructions,
          },
        });
      }

      const templatesToInsert = input.templates?.length
        ? input.templates
        : [{ templateId: input.templateId, isFallback: true, priority: 0 }];

      for (const t of templatesToInsert) {
        await tx.campaignTemplate.upsert({
          where: { campaignId_templateId: { campaignId: created.id, templateId: t.templateId } },
          create: { campaignId: created.id, templateId: t.templateId, isFallback: t.isFallback, priority: t.priority ?? 0 },
          update: { isFallback: t.isFallback, priority: t.priority ?? 0 },
        });
      }

      for (const st of stepsToInsert) {
        if (st.templateId) {
          await tx.campaignTemplate.upsert({
            where: { campaignId_templateId: { campaignId: created.id, templateId: st.templateId } },
            create: { campaignId: created.id, templateId: st.templateId, isFallback: false, priority: 99 },
            update: {},
          });
        }
      }

      if (input.rules?.length) {
        for (const r of input.rules) {
          await tx.campaignRule.create({
            data: {
              campaignId: created.id,
              templateId: r.templateId,
              priority: r.priority,
              hotelSegment: r.hotelSegment || null,
              contactPersona: r.contactPersona || null,
              requiresVerified: r.requiresVerified,
              minConfidence: r.minConfidence,
              city: r.city || null,
              description: r.description,
            },
          });
        }
      }

      return created;
    });

    await audit(req, { action: "campaign.create", entityType: "Campaign", entityId: campaign.id, metadata: { name: campaign.name } });
    ok(res, await loadDetail(campaign.id), 201);
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => ok(res, await loadDetail(IdSchema.parse(req.params.id), req.user!, "VIEW")))
);

router.patch(
  "/:id",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "EDIT");
    await assertEditable(id);
    const input = CampaignInputSchema.partial().parse(req.body);
    const current = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    if (input.templateId && input.templateId !== current.templateId) {
      const template = await prisma.template.findUnique({ where: { id: input.templateId } });
      assertTemplateAccessible(template, req.user!);
    }
    if (input.contactListId && input.contactListId !== current.contactListId) {
      const list = await prisma.contactList.findUnique({ where: { id: input.contactListId } });
      assertListAccessible(list, req.user!);
    }
    const [existingCampaignTemplates, existingRules, existingSequenceSteps, existingOverrides] = await Promise.all([
      prisma.campaignTemplate.findMany({ where: { campaignId: id }, select: { templateId: true } }),
      prisma.campaignRule.findMany({ where: { campaignId: id }, select: { templateId: true } }),
      prisma.campaignSequenceStep.findMany({ where: { campaignId: id }, select: { templateId: true } }),
      prisma.campaignRecipientOverride.findMany({ where: { campaignId: id }, select: { templateId: true } }),
    ]);
    const campaignTemplateIds = new Set([
      current.templateId,
      ...existingCampaignTemplates.map((item) => item.templateId),
      ...existingRules.map((item) => item.templateId),
      ...existingSequenceSteps.map((item) => item.templateId),
      ...existingOverrides.map((item) => item.templateId),
    ]);
    for (const templateId of [
      ...(input.templates ?? []).map((item) => item.templateId),
      ...(input.rules ?? []).map((item) => item.templateId),
      ...(input.sequenceSteps ?? []).map((item) => item.templateId),
    ]) {
      if (!campaignTemplateIds.has(templateId)) {
        const template = await prisma.template.findUnique({ where: { id: templateId } });
        assertTemplateAccessible(template, req.user!);
      }
    }

    await prisma.$transaction(async (tx) => {
      const { templates, rules, sequenceSteps, ...baseData } = input;
      if (baseData.mailboxId !== undefined) {
        if (baseData.mailboxId) {
          const mailbox = await tx.mailboxAccount.findUnique({
            where: { id: baseData.mailboxId },
            include: { accessList: true },
          });
          if (!mailbox) throw AppError.notFound("MAILBOX_NOT_FOUND", "Mailbox not found.");
          const hasAccess = req.user!.role === "FOUNDER" || mailbox.accessList.some((a) => a.userId === req.user!.id);
          if (!hasAccess) {
            throw AppError.forbidden("MAILBOX_ACCESS_DENIED", "You are not authorized to send through this mailbox.");
          }
          baseData.fromEmail = mailbox.email;
        } else {
          baseData.mailboxId = null;
        }
      }
      await tx.campaign.update({ where: { id }, data: baseData });

      if (sequenceSteps) {
        await tx.campaignSequenceStep.deleteMany({ where: { campaignId: id } });
        for (const st of sequenceSteps) {
          await tx.campaignSequenceStep.create({
            data: {
              campaignId: id,
              stepIndex: st.stepIndex,
              purpose: st.purpose,
              delayDays: st.delayDays,
              delayBusinessDaysOnly: st.delayBusinessDaysOnly,
              subjectMode: st.subjectMode,
              customSubject: st.customSubject,
              templateId: st.templateId,
              promptInstructions: st.promptInstructions,
            },
          });
        }
      }

      if (templates) {
        await tx.campaignTemplate.deleteMany({ where: { campaignId: id } });
        for (const t of templates) {
          await tx.campaignTemplate.create({
            data: { campaignId: id, templateId: t.templateId, isFallback: t.isFallback, priority: t.priority ?? 0 },
          });
        }
        if (sequenceSteps) {
          for (const st of sequenceSteps) {
            if (st.templateId) {
              await tx.campaignTemplate.upsert({
                where: { campaignId_templateId: { campaignId: id, templateId: st.templateId } },
                create: { campaignId: id, templateId: st.templateId, isFallback: false, priority: 99 },
                update: {},
              });
            }
          }
        }
      }

      if (rules) {
        await tx.campaignRule.deleteMany({ where: { campaignId: id } });
        for (const r of rules) {
          await tx.campaignRule.create({
            data: {
              campaignId: id,
              templateId: r.templateId,
              priority: r.priority,
              hotelSegment: r.hotelSegment || null,
              contactPersona: r.contactPersona || null,
              requiresVerified: r.requiresVerified,
              minConfidence: r.minConfidence,
              city: r.city || null,
              description: r.description,
            },
          });
        }
      }
    });

    await audit(req, { action: "campaign.update", entityType: "Campaign", entityId: id, metadata: { fields: Object.keys(input) } });
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

router.post(
  "/:id/duplicate",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const source = await loadDetail(id, req.user!, "VIEW");
    let name = `${source.name} (copy)`;
    for (let n = 2; await prisma.campaign.findUnique({ where: { name } }); n++) name = `${source.name} (copy ${n})`;
    const userDefault = await prisma.mailboxAccess.findFirst({
      where: { userId: req.user!.id },
      include: { mailbox: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    });
    const fallbackMailbox = await getPersonalMailboxStatus(req.user!.id);
    const mailboxId = userDefault?.mailbox.id ?? null;
    const fromEmail = userDefault?.mailbox.email ?? fallbackMailbox?.email ?? null;
    const copy = await prisma.campaign.create({
      data: {
        name,
        description: source.description,
        outreachType: (source as any).outreachType ?? "CUSTOMER_OUTREACH",
        templateId: source.template.id,
        contactListId: source.list.id,
        fromName: source.fromName,
        fromEmail,
        mailboxId,
        replyTo: source.replyTo,
        sendRatePerMinute: source.sendRatePerMinute,
        createdById: req.user!.id,
      },
    });
    await audit(req, { action: "campaign.duplicate", entityType: "Campaign", entityId: copy.id, metadata: { from: source.name } });
    ok(res, await loadDetail(copy.id, req.user!, "VIEW"), 201);
  })
);

router.delete(
  "/:id",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "ADMIN");
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
    const detail = await loadDetail(id, req.user!, "VIEW");
    ok(res, detail.templates);
  })
);

router.post(
  "/:id/templates",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "EDIT");
    await assertEditable(id);
    const input = CampaignTemplateInputSchema.parse(req.body);
    const template = await prisma.template.findUnique({ where: { id: input.templateId } });
    assertTemplateAccessible(template, req.user!);

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
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

router.delete(
  "/:id/templates/:templateId",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const templateId = IdSchema.parse(req.params.templateId);
    await loadDetail(id, req.user!, "EDIT");
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
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

router.get(
  "/:id/rules",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const detail = await loadDetail(id, req.user!, "VIEW");
    ok(res, detail.rules);
  })
);

router.post(
  "/:id/rules",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "EDIT");
    await assertEditable(id);
    const input = CampaignRuleInputSchema.parse(req.body);
    const template = await prisma.template.findUnique({ where: { id: input.templateId } });
    assertTemplateAccessible(template, req.user!);

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
    ok(res, await loadDetail(id, req.user!, "VIEW"), 201);
  })
);

router.put(
  "/:id/rules/:ruleId",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const ruleId = IdSchema.parse(req.params.ruleId);
    await loadDetail(id, req.user!, "EDIT");
    await assertEditable(id);
    const input = CampaignRuleInputSchema.partial().parse(req.body);
    if (input.templateId) {
      const template = await prisma.template.findUnique({ where: { id: input.templateId } });
      assertTemplateAccessible(template, req.user!);
    }
    await prisma.campaignRule.update({
      where: { id: ruleId, campaignId: id },
      data: input,
    });
    await audit(req, { action: "campaign.rule_update", entityType: "CampaignRule", entityId: ruleId });
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

router.delete(
  "/:id/rules/:ruleId",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const ruleId = IdSchema.parse(req.params.ruleId);
    await loadDetail(id, req.user!, "EDIT");
    await assertEditable(id);
    await prisma.campaignRule.delete({ where: { id: ruleId, campaignId: id } });
    await audit(req, { action: "campaign.rule_delete", entityType: "CampaignRule", entityId: ruleId });
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

router.get(
  "/:id/overrides",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "VIEW");
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
        customSubject: o.customSubject,
        customBodyHtml: o.customBodyHtml,
        customBodyText: o.customBodyText,
        isCustom: o.isCustom,
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
    await loadDetail(id, req.user!, "EDIT");
    await assertEditable(id);
    const input = CampaignRecipientOverrideInputSchema.parse(req.body);

    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw AppError.notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");

    const targetTemplateId = input.templateId || campaign.templateId;
    const [contact, template] = await Promise.all([
      prisma.contact.findUnique({ where: { id: input.contactId } }),
      prisma.template.findUnique({ where: { id: targetTemplateId } }),
    ]);
    if (!contact) throw AppError.badRequest("CONTACT_NOT_FOUND", "Contact no longer exists.");
    const existingOverride = await prisma.campaignRecipientOverride.findUnique({
      where: { campaignId_contactId: { campaignId: id, contactId: input.contactId } },
      select: { templateId: true },
    });
    if (existingOverride?.templateId !== targetTemplateId) assertTemplateAccessible(template, req.user!);
    else if (!template) throw AppError.badRequest("TEMPLATE_NOT_FOUND", "Template no longer exists.");

    const customBodyText = input.customBodyText || (input.customBodyHtml ? htmlToText(input.customBodyHtml) : null);
    const isCustom = input.isCustom ?? Boolean(input.customSubject && input.customBodyHtml);

    const override = await prisma.campaignRecipientOverride.upsert({
      where: { campaignId_contactId: { campaignId: id, contactId: input.contactId } },
      create: {
        campaignId: id,
        contactId: input.contactId,
        templateId: targetTemplateId,
        reason: input.reason,
        customSubject: input.customSubject,
        customBodyHtml: input.customBodyHtml,
        customBodyText,
        isCustom,
      },
      update: {
        templateId: targetTemplateId,
        reason: input.reason,
        customSubject: input.customSubject,
        customBodyHtml: input.customBodyHtml,
        customBodyText,
        isCustom,
      },
    });
    await audit(req, {
      action: "campaign.override_set",
      entityType: "CampaignRecipientOverride",
      entityId: override.id,
      metadata: { contact: contact.email, template: template.name, isCustom },
    });
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

router.get(
  "/:id/recipients/:contactId/preview",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const contactId = IdSchema.parse(req.params.contactId);
    await loadDetail(id, req.user!, "VIEW");

    const [campaign, contact, override] = await Promise.all([
      prisma.campaign.findUnique({
        where: { id },
        include: {
          template: true,
          campaignTemplates: { include: { template: true }, orderBy: { priority: "asc" } },
          rules: { include: { template: true }, orderBy: { priority: "asc" } },
        },
      }),
      prisma.contact.findUnique({ where: { id: contactId } }),
      prisma.campaignRecipientOverride.findUnique({
        where: { campaignId_contactId: { campaignId: id, contactId } },
        include: { template: true },
      }),
    ]);

    if (!campaign) throw AppError.notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
    if (!contact) throw AppError.notFound("CONTACT_NOT_FOUND", "Contact not found.");

    const eligibleTemplates: EligibleTemplate[] = campaign.campaignTemplates.length
      ? campaign.campaignTemplates.map((ct) => ({
          id: ct.template.id,
          name: ct.template.name,
          subject: ct.template.subject,
          bodyHtml: ct.template.bodyHtml,
          bodyText: ct.template.bodyText,
          version: ct.template.version,
          isFallback: ct.isFallback,
        }))
      : [
          {
            id: campaign.template.id,
            name: campaign.template.name,
            subject: campaign.template.subject,
            bodyHtml: campaign.template.bodyHtml,
            bodyText: campaign.template.bodyText,
            version: campaign.template.version,
            isFallback: true,
          },
        ];

    const fallback = eligibleTemplates.find((t) => t.isFallback) ?? eligibleTemplates[0]!;
    const customMap =
      typeof contact.customFields === "object" && contact.customFields !== null
        ? (contact.customFields as Record<string, string>)
        : {};

    const segInferred = (!contact.hotelSegment || contact.hotelSegment === "UNKNOWN")
      ? inferSegmentFromCompany(contact.company, customMap, contact.email)
      : null;
    const effectiveSegment = contact.hotelSegment && contact.hotelSegment !== "UNKNOWN"
      ? contact.hotelSegment
      : (segInferred && segInferred.value !== "UNKNOWN" ? segInferred.value : null);

    const perInferred = (!contact.contactPersona || contact.contactPersona === "UNKNOWN")
      ? inferPersonaFromTitle(contact.title)
      : null;
    const effectivePersona = contact.contactPersona && contact.contactPersona !== "UNKNOWN"
      ? contact.contactPersona
      : (perInferred && perInferred.value !== "UNKNOWN" ? perInferred.value : null);

    const selection = selectTemplateForRecipient(
      {
        id: contact.id,
        email: contact.email,
        firstName: contact.firstName,
        lastName: contact.lastName,
        company: contact.company,
        title: contact.title,
        hotelSegment: effectiveSegment,
        hotelSegmentConfidence: contact.hotelSegmentConfidence ?? segInferred?.confidence,
        hotelSegmentStatus: contact.hotelSegmentStatus ?? segInferred?.status,
        contactPersona: effectivePersona,
        contactPersonaConfidence: contact.contactPersonaConfidence ?? perInferred?.confidence,
        contactPersonaStatus: contact.contactPersonaStatus ?? perInferred?.status,
        customFields: customMap,
      },
      {
        templates: eligibleTemplates,
        rules: campaign.rules.map((r) => ({
          id: r.id,
          templateId: r.templateId,
          priority: r.priority,
          hotelSegment: r.hotelSegment,
          contactPersona: r.contactPersona,
          requiresVerified: r.requiresVerified,
          minConfidence: r.minConfidence,
          city: r.city,
          description: r.description,
        })),
        defaultTemplateId: fallback.id,
      }
    );

    const targetTemplate = override?.template ?? selection.template;
    const defaultRender = renderEmail(
      {
        subject: targetTemplate.subject,
        bodyHtml: targetTemplate.bodyHtml,
        bodyText: targetTemplate.bodyText,
      },
      contactMergeData(contact)
    );

    const personalization = synthesizeRecipientPersonalization(contact);
    const isCustom = Boolean(override?.isCustom && override?.customSubject && override?.customBodyHtml);

    ok(res, {
      contact: {
        id: contact.id,
        email: contact.email,
        firstName: contact.firstName,
        lastName: contact.lastName,
        company: contact.company,
        title: contact.title,
      },
      template: {
        id: targetTemplate.id,
        name: targetTemplate.name,
      },
      isCustom,
      subject: isCustom ? override!.customSubject! : defaultRender.subject,
      bodyHtml: isCustom ? override!.customBodyHtml! : defaultRender.html,
      bodyText: isCustom ? (override!.customBodyText ?? htmlToText(override!.customBodyHtml!)) : defaultRender.text,
      defaultSubject: defaultRender.subject,
      defaultBodyHtml: defaultRender.html,
      defaultBodyText: defaultRender.text,
      understanding: personalization.understanding,
      reasoning: personalization.reasoning,
      assignmentSource: isCustom ? "OVERRIDE" : selection.assignmentSource,
      assignmentReason: override?.reason || selection.explanation,
    });
  })
);

router.delete(
  "/:id/overrides/:contactId",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const contactId = IdSchema.parse(req.params.contactId);
    await loadDetail(id, req.user!, "EDIT");
    await assertEditable(id);
    await prisma.campaignRecipientOverride.deleteMany({ where: { campaignId: id, contactId } });
    await audit(req, { action: "campaign.override_remove", entityType: "Campaign", entityId: id, metadata: { contactId } });
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

router.get(
  "/:id/collaborators",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "VIEW");
    const collaborators = await prisma.campaignCollaborator.findMany({
      where: { campaignId: id },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { addedAt: "asc" },
    });
    ok(
      res,
      collaborators.map((c) => ({
        id: c.id,
        campaignId: c.campaignId,
        userId: c.userId,
        userName: c.user.name,
        userEmail: c.user.email,
        role: c.role,
        addedAt: c.addedAt.toISOString(),
      }))
    );
  })
);

router.post(
  "/:id/collaborators",
  requirePermission("campaigns.share"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "ADMIN");
    const input = AddCollaboratorSchema.parse(req.body);

    const targetUser = await prisma.user.findUnique({ where: { id: input.userId } });
    if (!targetUser) throw AppError.notFound("USER_NOT_FOUND", "User not found.");

    const collaborator = await prisma.campaignCollaborator.upsert({
      where: { campaignId_userId: { campaignId: id, userId: input.userId } },
      create: {
        campaignId: id,
        userId: input.userId,
        role: input.role,
      },
      update: {
        role: input.role,
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    await audit(req, {
      action: "campaign.add_collaborator",
      entityType: "Campaign",
      entityId: id,
      metadata: { targetUserId: input.userId, role: input.role },
    });

    ok(res, {
      id: collaborator.id,
      campaignId: collaborator.campaignId,
      userId: collaborator.userId,
      userName: collaborator.user.name,
      userEmail: collaborator.user.email,
      role: collaborator.role,
      addedAt: collaborator.addedAt.toISOString(),
    });
  })
);

router.delete(
  "/:id/collaborators/:userId",
  requirePermission("campaigns.share"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const userId = IdSchema.parse(req.params.userId);
    await loadDetail(id, req.user!, "ADMIN");

    await prisma.campaignCollaborator.deleteMany({
      where: { campaignId: id, userId },
    });

    await audit(req, {
      action: "campaign.remove_collaborator",
      entityType: "Campaign",
      entityId: id,
      metadata: { targetUserId: userId },
    });

    ok(res, { success: true });
  })
);

// ---------------------------------------------------------------------------
// Review & approval
// ---------------------------------------------------------------------------

router.get(
  "/:id/review",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "VIEW");
    ok(res, await reviewCampaign(id));
  })
);

router.post(
  "/:id/request-approval",
  requirePermission("campaigns.request_approval"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "EDIT");
    await requestApproval(req, id);
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

router.post(
  "/:id/return-to-draft",
  requirePermission("campaigns.request_approval"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "EDIT");
    const { note } = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
    await withdrawApproval(req, id, note);
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

router.post(
  "/:id/approve",
  requirePermission("campaigns.approve"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "VIEW");
    await approveCampaign(req, id, ApproveInputSchema.parse(req.body));
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

// ---------------------------------------------------------------------------
// Sending control
// ---------------------------------------------------------------------------

const control = (fn: (req: Parameters<typeof startCampaign>[0], id: string) => Promise<unknown>) =>
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const user = req.user!;
    await loadDetail(id, user, "EDIT");
    if (!canAct(user, "campaigns.control")) {
      throw AppError.forbidden("PERMISSION_DENIED", "You do not have permission to control campaign sending.");
    }
    await fn(req, id);
    ok(res, await loadDetail(id, user, "VIEW"));
  });

router.post(
  "/:id/start",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const user = req.user!;
    const campaign = await loadDetail(id, user, "VIEW");

    // Sending gate:
    // 1. Founder or Founder Office can always start
    // 2. An employee with explicit sending permission (canSendWithoutApproval === true) can start
    // 3. An employee without sending permission can ONLY start if the campaign is APPROVED
    const isFounderOrOffice = user.role === "FOUNDER" || user.role === "FOUNDER_OFFICE";
    const hasSendPermission = Boolean(user.canSendWithoutApproval);
    const isApproved = campaign.status === "APPROVED" && Boolean(campaign.approvedBy);

    if (!isFounderOrOffice && !hasSendPermission && !isApproved) {
      throw AppError.forbidden("SEND_APPROVAL_REQUIRED", "Sending requires approval from Founder Office or explicit sending permission.");
    }

    await startCampaign(req, id);
    kickBackground();
    ok(res, await loadDetail(id, user, "VIEW"));
  })
);

router.post("/:id/pause", control((req, id) => pauseCampaign(req, id)));
router.post("/:id/resume", control(async (req, id) => { await resumeCampaign(req, id); kickBackground(); }));
router.post("/:id/cancel", control(cancelCampaign));
router.post("/:id/retry-failed", control(async (req, id) => { await retryFailed(req, id); kickBackground(); }));

router.post(
  "/:id/sends/:sendId/resolve",
  requirePermission("campaigns.control"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "EDIT");
    const { outcome } = z.object({ outcome: z.enum(["sent", "retry"]) }).parse(req.body);
    await resolveUnknown(req, id, IdSchema.parse(req.params.sendId), outcome);
    if (outcome === "retry") kickBackground();
    ok(res, null);
  })
);

router.post(
  "/:id/test",
  requirePermission("campaigns.send_test"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "VIEW");
    const { to, contactId, dryRun } = TestSendInputSchema.parse(req.body);
    ok(res, await sendTest(req, id, to, contactId, { dryRun }));
  })
);

router.get(
  "/:id/analytics",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "VIEW");
    ok(res, await getCampaignAnalytics(id));
  })
);

router.post(
  "/:id/sends/:sendId/outcome",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "EDIT");
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
  scheduled: { status: "PENDING", stepIndex: { gt: 0 }, approvedAt: { not: null } },
  awaiting_approval: { status: "PENDING", stepIndex: { gt: 0 }, approvedAt: null },
};

router.get(
  "/:id/conversation-counts",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "VIEW");

    const conversations = await prisma.conversation.findMany({
      where: { campaignId: id },
      orderBy: { lastMessageAt: "desc" },
      select: { recipientEmail: true, status: true },
    });

    const counts: Record<ConversationStatus, number> = {
      NEEDS_REPLY: 0,
      WAITING_FOR_CONTACT: 0,
      MEETING_COORDINATION: 0,
      MEETING_SCHEDULED: 0,
      INTERESTED: 0,
      NOT_INTERESTED: 0,
      CLOSED: 0,
    };

    const seenEmails = new Set<string>();
    let total = 0;
    for (const c of conversations) {
      const em = c.recipientEmail.toLowerCase();
      if (seenEmails.has(em)) continue;
      seenEmails.add(em);
      if (c.status in counts) {
        counts[c.status as ConversationStatus]++;
        total++;
      }
    }

    ok(res, { total, counts });
  })
);

router.get(
  "/:id/recipients",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "VIEW");
    const { page, pageSize } = PaginationQuerySchema.parse(req.query);
    const filter = searchParam(req.query.filter);
    const conversationStatus = searchParam(req.query.conversationStatus);
    const search = searchParam(req.query.search);

    const result = await listCampaignRecipients(id, {
      page,
      pageSize,
      filter,
      conversationStatus,
      search,
    });

    res.json({
      success: true,
      data: {
        items: result.items,
        deliveryCounts: result.deliveryCounts,
        conversationCounts: result.conversationCounts,
      },
      pagination: result.pagination,
    });
  })
);

router.get(
  "/:id/sends",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "VIEW");
    const { page, pageSize } = PaginationQuerySchema.parse(req.query);
    const filter = searchParam(req.query.filter);
    const conversationStatus = searchParam(req.query.conversationStatus);
    const search = searchParam(req.query.search);
    const step = req.query.step !== undefined ? Number(req.query.step) : undefined;

    let emailFilter: Prisma.StringFilter | undefined = undefined;
    if (conversationStatus && conversationStatus !== "all") {
      const matchingConversations = await prisma.conversation.findMany({
        where: {
          campaignId: id,
          status: conversationStatus as ConversationStatus,
        },
        select: { recipientEmail: true },
      });
      const matchingEmails = matchingConversations.map((c) => c.recipientEmail);
      if (matchingEmails.length === 0) {
        return okPage(res, [], page, pageSize, 0);
      }
      emailFilter = { in: matchingEmails };
    }

    const where: Prisma.SendWhereInput = {
      campaignId: id,
      ...(filter && SEND_FILTERS[filter] ? SEND_FILTERS[filter] : {}),
      ...(emailFilter ? { email: emailFilter } : {}),
      ...(step !== undefined && !isNaN(step) ? { stepIndex: step } : {}),
    };

    if (search) {
      where.AND = [
        {
          OR: [
            { email: { contains: search, mode: "insensitive" } },
            { contact: { firstName: { contains: search, mode: "insensitive" } } },
            { contact: { lastName: { contains: search, mode: "insensitive" } } },
            { contact: { company: { contains: search, mode: "insensitive" } } },
          ],
        },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.send.findMany({
        where,
        include: {
          contact: {
            select: { firstName: true, lastName: true, company: true },
          },
          conversation: {
            select: { id: true, status: true, snippet: true, outcome: true, meetingAt: true },
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        ...skipTake(page, pageSize),
      }),
      prisma.send.count({ where }),
    ]);

    const emailsNeedingConv = Array.from(
      new Set(rows.filter((r) => !r.conversation).map((r) => r.email.toLowerCase()))
    );
    const extraConvMap = new Map<string, any>();
    if (emailsNeedingConv.length > 0) {
      const convs = await prisma.conversation.findMany({
        where: {
          campaignId: id,
          recipientEmail: { in: emailsNeedingConv },
        },
        select: { id: true, recipientEmail: true, status: true, snippet: true, outcome: true, meetingAt: true },
      });
      for (const c of convs) {
        extraConvMap.set(c.recipientEmail.toLowerCase(), c);
      }
    }

    const dtoList = rows.map((r) => {
      const conv = r.conversation || extraConvMap.get(r.email.toLowerCase()) || null;
      return toSendDto({ ...r, conversation: conv });
    });

    okPage(res, dtoList, page, pageSize, total);
  })
);

router.get(
  "/:id/sends/:sendId",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "VIEW");
    const send = await prisma.send.findFirst({
      where: { id: IdSchema.parse(req.params.sendId), campaignId: id },
      include: {
        contact: {
          select: { firstName: true, lastName: true, company: true },
        },
        events: { orderBy: { occurredAt: "asc" } },
        conversation: {
          select: { id: true, status: true, snippet: true, outcome: true, meetingAt: true },
        },
      },
    });
    if (!send) throw AppError.notFound("SEND_NOT_FOUND", "That message no longer exists.");

    if (!send.conversation) {
      const conv = await prisma.conversation.findFirst({
        where: { campaignId: id, recipientEmail: send.email },
        select: { id: true, status: true, snippet: true, outcome: true, meetingAt: true },
      });
      if (conv) {
        (send as any).conversation = conv;
      }
    }

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

// ---------------------------------------------------------------------------
// Follow-up Sequence Controls & Approvals
// ---------------------------------------------------------------------------

router.get(
  "/:id/sequence",
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    const detail = await loadDetail(id, req.user!, "VIEW");
    ok(res, {
      automationMode: detail.automationMode,
      sequenceSteps: detail.sequenceSteps,
    });
  })
);

router.put(
  "/:id/sequence",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const id = IdSchema.parse(req.params.id);
    await loadDetail(id, req.user!, "EDIT");
    const campaign = await prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw AppError.notFound("CAMPAIGN_NOT_FOUND", "Campaign not found.");
    if (campaign.status !== "DRAFT" && campaign.status !== "PAUSED" && campaign.status !== "SENDING") {
      throw AppError.conflict("INVALID_STATUS", "Sequence configuration can only be modified for active, paused, or draft campaigns.");
    }

    const { automationMode, sequenceSteps } = z
      .object({
        automationMode: CampaignAutomationModeSchema.optional(),
        sequenceSteps: z.array(SequenceStepInputSchema).min(1, "At least one step required"),
      })
      .parse(req.body);

    const currentSteps = await prisma.campaignSequenceStep.findMany({
      where: { campaignId: id },
      select: { templateId: true },
    });
    const currentTemplateIds = new Set(currentSteps.map((step) => step.templateId));
    for (const st of sequenceSteps) {
      if (!currentTemplateIds.has(st.templateId)) {
        const exists = await prisma.template.findUnique({ where: { id: st.templateId } });
        assertTemplateAccessible(exists, req.user!);
      }
    }

    await prisma.$transaction(async (tx) => {
      if (automationMode) {
        await tx.campaign.update({ where: { id }, data: { automationMode } });
      }
      await tx.campaignSequenceStep.deleteMany({ where: { campaignId: id } });
      for (const st of sequenceSteps) {
        await tx.campaignSequenceStep.create({
          data: {
            campaignId: id,
            stepIndex: st.stepIndex,
            purpose: st.purpose,
            delayDays: st.delayDays,
            delayBusinessDaysOnly: st.delayBusinessDaysOnly,
            subjectMode: st.subjectMode,
            customSubject: st.customSubject,
            templateId: st.templateId,
            promptInstructions: st.promptInstructions,
          },
        });
        if (st.templateId) {
          await tx.campaignTemplate.upsert({
            where: { campaignId_templateId: { campaignId: id, templateId: st.templateId } },
            create: { campaignId: id, templateId: st.templateId, isFallback: false, priority: 99 },
            update: {},
          });
        }
      }
    });

    await audit(req, { action: "campaign.sequence.update", entityType: "Campaign", entityId: id, metadata: { stepsCount: sequenceSteps.length, automationMode } });
    ok(res, await loadDetail(id, req.user!, "VIEW"));
  })
);

router.post(
  "/:id/sends/:sendId/approve",
  requirePermission("campaigns.control"),
  asyncHandler(async (req, res) => {
    const campaignId = IdSchema.parse(req.params.id);
    await loadDetail(campaignId, req.user!, "EDIT");
    const sendId = IdSchema.parse(req.params.sendId);
    await approveFollowUpSend(campaignId, sendId);
    await audit(req, { action: "campaign.followup.approve", entityType: "Send", entityId: sendId, metadata: { campaignId } });
    ok(res, { approved: true });
  })
);

router.post(
  "/:id/sends/approve-all",
  requirePermission("campaigns.control"),
  asyncHandler(async (req, res) => {
    const campaignId = IdSchema.parse(req.params.id);
    await loadDetail(campaignId, req.user!, "EDIT");
    const count = await approveAllPendingFollowUps(campaignId);
    await audit(req, { action: "campaign.followup.approve_all", entityType: "Campaign", entityId: campaignId, metadata: { count } });
    ok(res, { approvedCount: count });
  })
);

router.get(
  "/:id/recipients/:email/sequence",
  asyncHandler(async (req, res) => {
    const campaignId = IdSchema.parse(req.params.id);
    await loadDetail(campaignId, req.user!, "VIEW");
    const email = String(req.params.email).toLowerCase().trim();
    const recipient = await getRecipientSequenceDetails(campaignId, email);
    if (!recipient) throw AppError.notFound("RECIPIENT_NOT_FOUND", "Recipient state not found in this campaign.");

    const rawSends = await prisma.send.findMany({
      where: { campaignId, email },
      orderBy: { stepIndex: "asc" },
    });
    const sends = rawSends.map(toSendDto);
    const pendingFollowUp = sends.find((s) => s.stepIndex > 0 && s.status === "PENDING") ?? null;
    const isTerminal = ["REPLY_RECEIVED", "BOUNCED", "SUPPRESSED", "CANCELLED", "COMPLETED"].includes(recipient.state);

    ok(res, {
      ...recipient,
      recipient,
      sends,
      pendingFollowUp,
      canApprove: Boolean(pendingFollowUp && !pendingFollowUp.approvedAt && recipient.state === "AWAITING_APPROVAL"),
      canPause: !isTerminal && recipient.state !== "PAUSED",
      canResume: recipient.state === "PAUSED",
      canStop: !isTerminal,
    });
  })
);

router.post(
  "/:id/recipients/:email/pause",
  requirePermission("campaigns.control"),
  asyncHandler(async (req, res) => {
    const campaignId = IdSchema.parse(req.params.id);
    await loadDetail(campaignId, req.user!, "EDIT");
    const email = String(req.params.email).toLowerCase().trim();
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "Paused by user";
    await pauseRecipientSequence(campaignId, email, reason);
    await audit(req, { action: "campaign.recipient.pause", entityType: "Campaign", entityId: campaignId, metadata: { email, reason } });
    ok(res, { paused: true });
  })
);

router.post(
  "/:id/recipients/:email/resume",
  requirePermission("campaigns.control"),
  asyncHandler(async (req, res) => {
    const campaignId = IdSchema.parse(req.params.id);
    await loadDetail(campaignId, req.user!, "EDIT");
    const email = String(req.params.email).toLowerCase().trim();
    await resumeRecipientSequence(campaignId, email);
    await audit(req, { action: "campaign.recipient.resume", entityType: "Campaign", entityId: campaignId, metadata: { email } });
    ok(res, { resumed: true });
  })
);

router.post(
  "/:id/recipients/:email/stop",
  requirePermission("campaigns.control"),
  asyncHandler(async (req, res) => {
    const campaignId = IdSchema.parse(req.params.id);
    await loadDetail(campaignId, req.user!, "EDIT");
    const email = String(req.params.email).toLowerCase().trim();
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "Stopped by user";
    const cancelledCount = await stopSequenceForRecipient(campaignId, email, reason, "CANCELLED");
    await audit(req, { action: "campaign.recipient.stop", entityType: "Campaign", entityId: campaignId, metadata: { email, reason, cancelledCount } });
    ok(res, { stopped: true, cancelledCount });
  })
);

router.post(
  "/:id/sequence/stop-all",
  requirePermission("campaigns.control"),
  asyncHandler(async (req, res) => {
    const campaignId = IdSchema.parse(req.params.id);
    await loadDetail(campaignId, req.user!, "EDIT");
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "All follow-ups stopped by user";
    const cancelledCount = await stopAllPendingFollowUps(campaignId, reason);
    await audit(req, { action: "campaign.sequence.stop_all", entityType: "Campaign", entityId: campaignId, metadata: { reason, cancelledCount } });
    ok(res, { cancelledCount, cancelledSendsCount: cancelledCount });
  })
);

router.post(
  "/:id/sequence/ai-draft",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const campaignId = IdSchema.parse(req.params.id);
    await loadDetail(campaignId, req.user!, "EDIT");
    const { stepIndex, purpose, previousSubject, previousBody, instructions } = z
      .object({
        stepIndex: z.coerce.number().int().min(1),
        purpose: z.string().optional(),
        previousSubject: z.string().optional(),
        previousBody: z.string().optional(),
        instructions: z.string().optional(),
      })
      .parse(req.body);

    const draft = await aiDraftFollowUp({
      stepIndex,
      purpose,
      previousSubject,
      previousBody,
      instructions,
    });
    ok(res, { ...draft, body: draft.bodyText });
  })
);

router.get(
  "/:id/recipients/:email/conversation",
  asyncHandler(async (req, res) => {
    const campaignId = IdSchema.parse(req.params.id);
    await loadDetail(campaignId, req.user!, "VIEW");
    const email = String(req.params.email).toLowerCase().trim();

    // 1. Look for existing conversation
    let conv = await prisma.conversation.findUnique({
      where: {
        campaignId_recipientEmail: { campaignId, recipientEmail: email },
      },
      include: {
        messages: { orderBy: { sentAt: "asc" } },
        campaign: { select: { id: true, name: true } },
        contact: { select: { id: true, firstName: true, lastName: true } },
        owner: { select: { id: true, name: true, email: true } },
      },
    });

    // 2. If not found, check if there is a send with a reply event to backfill
    if (!conv) {
      const replyEvent = await prisma.sendEvent.findFirst({
        where: {
          send: { campaignId, email },
          type: "REPLY",
        },
        include: { send: true },
      });

      if (replyEvent) {
        const created = await findOrCreateConversation({
          campaignId,
          recipientEmail: email,
          initialSendId: replyEvent.sendId,
          contactId: replyEvent.send.contactId,
        });
        conv = await prisma.conversation.findUnique({
          where: { id: created.id },
          include: {
            messages: { orderBy: { sentAt: "asc" } },
            campaign: { select: { id: true, name: true } },
            contact: { select: { id: true, firstName: true, lastName: true } },
            owner: { select: { id: true, name: true, email: true } },
          },
        });
      }
    }

    ok(res, conv ? toConversationDto(conv) : null);
  })
);

export default router;
