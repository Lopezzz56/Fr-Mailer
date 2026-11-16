// Team management: invitations, roles, disabling, password reset links.
// Rule: the organization always keeps at least MIN_ACTIVE_FOUNDERS active founders.
import type { Request } from "express";
import prisma from "../db.js";
import { env, smtpConfigured } from "../config.js";
import { AppError } from "../middleware/error-handler.js";
import { audit } from "../lib/audit.js";
import { MIN_ACTIVE_FOUNDERS, ROLE_LABELS, type UserRole } from "../../shared/auth.js";
import { escapeHtml } from "../../shared/merge.js";
import { createAuthToken, revokeAllSessions } from "./auth-service.js";
import { getTransport } from "./mailer.js";
import { emailBrandHeader } from "../lib/brand.js";

const INVITE_TTL_HOURS = 7 * 24;
const RESET_TTL_HOURS = 24;

const resolveBaseUrl = (req?: Request): string => {
  if (req) {
    const origin = req.get("origin");
    if (origin && origin.startsWith("http")) return origin.replace(/\/+$/, "");
    const referer = req.get("referer");
    if (referer) {
      try {
        const u = new URL(referer);
        return `${u.protocol}//${u.host}`;
      } catch {}
    }
    const host = req.get("x-forwarded-host") || req.get("host");
    if (host) {
      const proto = req.get("x-forwarded-proto") || (req.secure ? "https" : "http");
      return `${proto}://${host}`;
    }
  }
  return env.PUBLIC_URL.replace(/\/+$/, "");
};

const link = (req: Request | undefined, path: string, token: string) =>
  `${resolveBaseUrl(req)}${path}?token=${encodeURIComponent(token)}`;

async function emailLink(to: string, subject: string, intro: string, url: string, cta: string): Promise<boolean> {
  if (!smtpConfigured) return false;
  const html = `<div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:24px;color:#101828;max-width:520px">
${emailBrandHeader()}
<p>${escapeHtml(intro)}</p>
<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="background:#2168E8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(cta)}</a></p>
<p style="color:#64748B;font-size:13px">Or paste this link into your browser:<br>${escapeHtml(url)}</p>
</div>`;
  try {
    await getTransport().send({ to, subject, html, text: `${intro}\n\n${cta}: ${url}`, fromName: env.SMTP_FROM_NAME });
    return true;
  } catch (err) {
    console.error("[team] email failed:", (err as Error).message);
    return false;
  }
}

async function activeFounderCount(excludingUserId?: string) {
  return prisma.user.count({ where: { role: "FOUNDER", status: "ACTIVE", ...(excludingUserId ? { id: { not: excludingUserId } } : {}) } });
}

export async function inviteUser(req: Request, input: { email: string; name: string; role: UserRole; canSendWithoutApproval?: boolean; sendEmail: boolean }) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing && existing.status !== "INVITED") throw AppError.conflict("DUPLICATE", "Someone on the team already uses this email.");

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          name: input.name,
          role: input.role,
          canSendWithoutApproval: input.canSendWithoutApproval ?? false,
        },
      })
    : await prisma.user.create({
        data: {
          email: input.email,
          name: input.name,
          role: input.role,
          status: "INVITED",
          canSendWithoutApproval: input.canSendWithoutApproval ?? false,
          invitedById: req.user!.id,
        },
      });

  const token = await createAuthToken(user.id, "INVITE", INVITE_TTL_HOURS);
  const url = link(req, "/accept-invite", token);
  const emailed = input.sendEmail
    ? await emailLink(
        user.email,
        `${req.user!.name} invited you to FocusRealm Mail Merge`,
        `${req.user!.name} invited you to join FocusRealm Mail Merge as ${ROLE_LABELS[input.role].toLowerCase()}. Set your password to get started. This link works for 7 days.`,
        url,
        "Accept invitation"
      )
    : false;

  await audit(req, {
    action: "team.invite",
    entityType: "User",
    entityId: user.id,
    metadata: { email: user.email, role: input.role, canSendWithoutApproval: input.canSendWithoutApproval, emailed },
  });
  return { user, inviteUrl: url, emailed };
}

export async function updateUser(
  req: Request,
  id: string,
  input: { name?: string; role?: UserRole; status?: "ACTIVE" | "DISABLED"; canSendWithoutApproval?: boolean }
) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw AppError.notFound("USER_NOT_FOUND", "That person isn't on the team.");

  const losingFounder =
    user.role === "FOUNDER" && user.status === "ACTIVE" && ((input.role && input.role !== "FOUNDER") || input.status === "DISABLED");
  if (losingFounder && (await activeFounderCount(user.id)) < MIN_ACTIVE_FOUNDERS) {
    throw AppError.conflict("LAST_FOUNDER", "The team needs at least one active founder. Make someone else a founder first.");
  }
  if (input.status === "ACTIVE" && user.status === "INVITED") {
    throw AppError.badRequest("INVITE_PENDING", "This person hasn't accepted their invite yet.");
  }

  const updated = await prisma.user.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.canSendWithoutApproval !== undefined ? { canSendWithoutApproval: input.canSendWithoutApproval } : {}),
    },
  });
  if (input.status === "DISABLED" || (input.role && input.role !== user.role)) await revokeAllSessions(id);

  await audit(req, {
    action: "team.update",
    entityType: "User",
    entityId: id,
    metadata: {
      email: user.email,
      ...(input.role && input.role !== user.role ? { role: input.role } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.canSendWithoutApproval !== undefined ? { canSendWithoutApproval: input.canSendWithoutApproval } : {}),
    },
  });
  return updated;
}

export async function createResetLink(req: Request, id: string, sendEmail: boolean) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw AppError.notFound("USER_NOT_FOUND", "That person isn't on the team.");
  if (user.status !== "ACTIVE") throw AppError.badRequest("NOT_ACTIVE", "Only active members can reset their password.");
  const token = await createAuthToken(user.id, "PASSWORD_RESET", RESET_TTL_HOURS);
  const url = link(req, "/reset-password", token);
  const emailed = sendEmail
    ? await emailLink(user.email, "Reset your FocusRealm Mail Merge password", "A founder created a password reset link for your account. It works once, for 24 hours.", url, "Choose a new password")
    : false;
  await audit(req, { action: "team.reset_link", entityType: "User", entityId: id, metadata: { email: user.email, emailed } });
  return { resetUrl: url, emailed };
}

export async function removeUser(req: Request, id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw AppError.notFound("USER_NOT_FOUND", "That person isn't on the team.");

  if (id === req.user!.id) {
    throw AppError.badRequest("CANNOT_REMOVE_SELF", "You cannot remove your own account from the organization.");
  }

  if (user.role === "FOUNDER" && (await activeFounderCount(user.id)) < MIN_ACTIVE_FOUNDERS) {
    throw AppError.conflict("LAST_FOUNDER", "The team needs at least one active founder. Make someone else a founder first.");
  }

  const founderId = req.user!.id;

  await prisma.$transaction(async (tx) => {
    // 1. Terminate user sessions and tokens
    await tx.session.deleteMany({ where: { userId: id } });
    await tx.authToken.deleteMany({ where: { userId: id } });

    // 2. Remove mailbox assignments
    await tx.mailboxAccess.deleteMany({ where: { userId: id } });
    await tx.userMailbox.deleteMany({ where: { userId: id } });

    // 3. Remove campaign collaborator memberships
    await tx.campaignCollaborator.deleteMany({ where: { userId: id } });
    await tx.campaignCollaborator.updateMany({ where: { addedById: id }, data: { addedById: null } });

    // 4. Preserve templates by reassigning to founder and ensuring scope is ORGANIZATION
    await tx.template.updateMany({
      where: { createdById: id },
      data: { createdById: founderId, scope: "ORGANIZATION" },
    });

    // 5. Preserve contacts and lists
    await tx.contact.updateMany({ where: { createdById: id }, data: { createdById: founderId } });
    await tx.contactList.updateMany({ where: { createdById: id }, data: { createdById: founderId } });

    // 6. Preserve campaigns and approvals
    await tx.campaign.updateMany({ where: { createdById: id }, data: { createdById: founderId } });
    await tx.campaign.updateMany({ where: { approvalRequestedById: id }, data: { approvalRequestedById: null } });
    await tx.campaign.updateMany({ where: { approvedById: id }, data: { approvedById: null } });

    // 7. Preserve import batches
    await tx.importBatch.updateMany({ where: { createdById: id }, data: { createdById: founderId } });

    // 8. Preserve send records (nullify sentByUserId)
    await tx.send.updateMany({ where: { sentByUserId: id }, data: { sentByUserId: null } });

    // 9. Unlink user who invited other users
    await tx.user.updateMany({ where: { invitedById: id }, data: { invitedById: null } });

    // 10. Nullify audit log user references so audit trail is strictly kept
    await tx.auditLog.updateMany({ where: { userId: id }, data: { userId: null } });

    // 11. Delete the user
    await tx.user.delete({ where: { id } });
  });

  await audit(req, {
    action: "team.remove",
    entityType: "User",
    entityId: id,
    metadata: { email: user.email, name: user.name, role: user.role },
  });

  return user;
}
