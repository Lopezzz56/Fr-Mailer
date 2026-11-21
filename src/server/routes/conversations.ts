import { Router } from "express";
import { z } from "zod";
import prisma from "../db.js";
import { asyncHandler, AppError } from "../middleware/error-handler.js";
import { requirePermission } from "../middleware/session.js";
import { audit } from "../lib/audit.js";
import { ok } from "../lib/http.js";
import {
  toConversationDto,
  updateConversation,
  sendInAppReply,
} from "../services/conversation-service.js";
import type { SessionUser } from "../../shared/auth.js";
import type { ConversationStatus } from "../../shared/types.js";

export const conversationsRouter = Router();

const IdParamSchema = z.object({
  id: z.string().min(1),
});

const ConversationStatusSchema = z.enum([
  "NEEDS_REPLY",
  "WAITING_FOR_CONTACT",
  "MEETING_COORDINATION",
  "MEETING_SCHEDULED",
  "INTERESTED",
  "NOT_INTERESTED",
  "CLOSED",
]);

const PatchConversationSchema = z.object({
  status: ConversationStatusSchema.optional(),
  nextAction: z.string().nullable().optional(),
  nextActionDueAt: z.string().datetime().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  meetingAt: z.string().datetime().nullable().optional(),
  meetingNotes: z.string().nullable().optional(),
  outcome: z.string().nullable().optional(),
  sentiment: z.string().nullable().optional(),
});

const PostReplySchema = z.object({
  bodyText: z.string().min(1, "Reply text is required"),
  bodyHtml: z.string().optional(),
  subject: z.string().optional(),
});

/** Helper to check whether user can access the conversation */
async function assertConversationAccess(
  conversationId: string,
  user: SessionUser
) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      campaign: {
        include: {
          collaborators: true,
        },
      },
    },
  });

  if (!conv) {
    throw AppError.notFound("CONVERSATION_NOT_FOUND", "Conversation not found.");
  }

  if (user.role === "FOUNDER" || user.role === "FOUNDER_OFFICE") {
    return conv;
  }

  // For employee: owner, campaign creator, or collaborator
  const isOwner = conv.ownerId === user.id;
  const isCreator = conv.campaign.createdById === user.id;
  const isCollaborator = conv.campaign.collaborators.some((c) => c.userId === user.id);

  if (!isOwner && !isCreator && !isCollaborator) {
    throw AppError.forbidden("You do not have access to this conversation.");
  }

  return conv;
}

/**
 * GET /api/conversations
 * Lists conversations with filtering by status, campaign, owner, and search.
 */
conversationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const user = req.user!;
    const isFounderOrOffice = user.role === "FOUNDER" || user.role === "FOUNDER_OFFICE";

    const status = req.query.status as ConversationStatus | undefined;
    const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
    const ownerId = typeof req.query.ownerId === "string" ? req.query.ownerId : undefined;
    const search = typeof req.query.search === "string" ? req.query.search.trim().toLowerCase() : undefined;

    const where: any = {
      ...(status ? { status } : {}),
      ...(campaignId ? { campaignId } : {}),
      ...(ownerId ? { ownerId } : {}),
    };

    if (!isFounderOrOffice) {
      where.OR = [
        { ownerId: user.id },
        { campaign: { createdById: user.id } },
        { campaign: { collaborators: { some: { userId: user.id } } } },
      ];
    }

    if (search) {
      where.AND = [
        {
          OR: [
            { recipientEmail: { contains: search, mode: "insensitive" } },
            { subject: { contains: search, mode: "insensitive" } },
            { snippet: { contains: search, mode: "insensitive" } },
            { contact: { firstName: { contains: search, mode: "insensitive" } } },
            { contact: { lastName: { contains: search, mode: "insensitive" } } },
          ],
        },
      ];
    }

    const conversations = await prisma.conversation.findMany({
      where,
      include: {
        messages: { orderBy: { sentAt: "asc" } },
        campaign: { select: { id: true, name: true } },
        contact: { select: { id: true, firstName: true, lastName: true } },
        owner: { select: { id: true, name: true, email: true } },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 50,
    });

    ok(res, conversations.map(toConversationDto));
  })
);

/**
 * GET /api/conversations/:id
 * Fetches conversation details with full message history.
 */
conversationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    await assertConversationAccess(id, req.user!);

    const conv = await prisma.conversation.findUniqueOrThrow({
      where: { id },
      include: {
        messages: { orderBy: { sentAt: "asc" } },
        campaign: { select: { id: true, name: true } },
        contact: { select: { id: true, firstName: true, lastName: true } },
        owner: { select: { id: true, name: true, email: true } },
      },
    });

    ok(res, toConversationDto(conv));
  })
);

/**
 * PATCH /api/conversations/:id
 * Updates conversation status, next action, due date, owner, meeting, or outcome.
 */
conversationsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const conv = await assertConversationAccess(id, req.user!);
    const body = PatchConversationSchema.parse(req.body);

    const updated = await updateConversation(id, {
      status: body.status,
      nextAction: body.nextAction,
      nextActionDueAt: body.nextActionDueAt ? new Date(body.nextActionDueAt) : body.nextActionDueAt === null ? null : undefined,
      ownerId: body.ownerId,
      meetingAt: body.meetingAt ? new Date(body.meetingAt) : body.meetingAt === null ? null : undefined,
      meetingNotes: body.meetingNotes,
      outcome: body.outcome,
      sentiment: body.sentiment,
    });

    await audit(req, {
      action: "conversation.update",
      entityType: "Conversation",
      entityId: id,
      metadata: {
        campaignId: conv.campaignId,
        recipientEmail: conv.recipientEmail,
        changes: body,
      },
    });

    ok(res, updated);
  })
);

/**
 * POST /api/conversations/:id/reply
 * Dispatches an in-app reply via SpaceMail SMTP and records it in the conversation thread.
 */
conversationsRouter.post(
  "/:id/reply",
  requirePermission("campaigns.manage"),
  asyncHandler(async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const conv = await assertConversationAccess(id, req.user!);
    const body = PostReplySchema.parse(req.body);

    const result = await sendInAppReply({
      conversationId: id,
      bodyText: body.bodyText,
      bodyHtml: body.bodyHtml,
      subject: body.subject,
      user: req.user!,
    });

    await audit(req, {
      action: "conversation.reply.sent",
      entityType: "Conversation",
      entityId: id,
      metadata: {
        campaignId: conv.campaignId,
        recipientEmail: conv.recipientEmail,
        subject: body.subject,
      },
    });

    ok(res, result);
  })
);
