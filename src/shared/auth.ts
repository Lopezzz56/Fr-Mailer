// Organization roles & permissions for FocusRealm Mail Merge
// Single source of truth for both server (enforcement) and client (UI gating).
//
// Model: one organization (FocusRealm), many users. Every user has exactly one role.
// - FOUNDER:        Full administrative control, bird's-eye view, team & mailbox settings, overrides.
// - FOUNDER_OFFICE: Operational management, approves employee sends, grants send permissions, coordinates campaigns.
// - EMPLOYEE:      Operational outreach creator (campaigns, templates, contacts, sequences). Cannot send without approval/permission.

import { z } from "zod";

// Not imported from ./types: a stale compiled types.js sits beside types.ts and
// bundlers resolve "./types.js" to it.
const EmailSchema = z.string().email({ message: "Invalid email address" });

// ============================================================================
// ROLES & USER STATUS
// ============================================================================

export const UserRoleSchema = z.enum(["FOUNDER", "FOUNDER_OFFICE", "EMPLOYEE"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserStatusSchema = z.enum(["INVITED", "ACTIVE", "DISABLED"]);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const CampaignAccessRoleSchema = z.enum(["OWNER", "EDITOR", "VIEWER"]);
export type CampaignAccessRole = z.infer<typeof CampaignAccessRoleSchema>;

export const TemplateScopeSchema = z.enum(["ORGANIZATION", "PERSONAL", "SHARED", "CAMPAIGN"]);
export type TemplateScope = z.infer<typeof TemplateScopeSchema>;

export const ROLE_LABELS: Record<UserRole, string> = {
  FOUNDER: "Founder",
  FOUNDER_OFFICE: "Founder's Office",
  EMPLOYEE: "Employee",
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  FOUNDER: "Full administrative access. Oversees the organization, manages team roles, mailbox credentials and settings.",
  FOUNDER_OFFICE: "Operational management. Coordinates team outreach, approves employee sending, manages shared campaigns and templates.",
  EMPLOYEE: "Creates campaigns, prepares contacts and templates, collaborates on shared outreach. Cannot send without approval.",
};

// ============================================================================
// PERMISSIONS
// ============================================================================

export const PERMISSIONS = [
  "contacts.view",
  "contacts.manage", // import, edit, delete contacts and lists
  "templates.view",
  "templates.manage", // create and edit own templates
  "templates.manage_org", // manage official FocusRealm templates (Founder & Founder Office)
  "campaigns.view",
  "campaigns.manage", // create and edit draft campaigns
  "campaigns.share", // collaborate with teammates on campaigns
  "campaigns.request_approval",
  "campaigns.approve", // approve campaigns for sending (Founder & Founder Office)
  "campaigns.control", // start / pause / resume / cancel campaigns
  "campaigns.send_test",
  "suppressions.view",
  "suppressions.add",
  "suppressions.remove", // compliance-sensitive: re-enables mail to an address (Founder only)
  "settings.view",
  "settings.manage", // change workspace settings (Founder only)
  "mailbox.manage", // change SMTP/IMAP credentials and connection settings (Founder only)
  "users.view",
  "users.manage", // invite, change role, disable team members (Founder only)
  "users.grant_send", // grant/revoke employee direct send permissions (Founder & Founder Office)
  "audit.view", // view organizational audit log (Founder & Founder Office)
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  "contacts.view": "View contacts and lists",
  "contacts.manage": "Import, edit and delete contacts",
  "templates.view": "View templates",
  "templates.manage": "Create and edit personal templates",
  "templates.manage_org": "Manage official FocusRealm templates",
  "campaigns.view": "View campaigns and send logs",
  "campaigns.manage": "Create and edit draft campaigns",
  "campaigns.share": "Share campaigns with team members",
  "campaigns.request_approval": "Submit campaigns for approval",
  "campaigns.approve": "Approve campaigns for sending",
  "campaigns.control": "Start, pause, resume and cancel approved campaigns",
  "campaigns.send_test": "Send test emails to internal addresses",
  "suppressions.view": "View the suppression list",
  "suppressions.add": "Add addresses to the suppression list",
  "suppressions.remove": "Remove addresses from the suppression list",
  "settings.view": "View settings",
  "settings.manage": "Change settings",
  "mailbox.manage": "Manage mailbox connection and credentials",
  "users.view": "View team members",
  "users.manage": "Invite, change roles and disable team members",
  "users.grant_send": "Grant or revoke employee direct send permissions",
  "audit.view": "View the audit log",
};

export const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  FOUNDER: new Set(PERMISSIONS),
  FOUNDER_OFFICE: new Set([
    "contacts.view",
    "contacts.manage",
    "templates.view",
    "templates.manage",
    "templates.manage_org",
    "campaigns.view",
    "campaigns.manage",
    "campaigns.share",
    "campaigns.request_approval",
    "campaigns.approve",
    "campaigns.control",
    "campaigns.send_test",
    "suppressions.view",
    "suppressions.add",
    "settings.view",
    "users.view",
    "users.grant_send",
    "audit.view",
  ]),
  EMPLOYEE: new Set([
    "contacts.view",
    "contacts.manage",
    "templates.view",
    "templates.manage",
    "campaigns.view",
    "campaigns.manage",
    "campaigns.share",
    "campaigns.request_approval",
    "campaigns.send_test",
    "suppressions.view",
    "suppressions.add",
  ]),
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

// ============================================================================
// ORGANIZATION RULES
// ============================================================================

/** The organization must always keep at least this many active founders. */
export const MIN_ACTIVE_FOUNDERS = 1;

/**
 * Whether a founder or founder office member may approve a campaign they requested themselves.
 * Allowed for small teams; flip to false to require peer approval.
 */
export const FOUNDER_SELF_APPROVAL_ALLOWED = true;

/** Disabled or invited users can never act, regardless of role. */
export function canAct(
  user: Pick<SessionUser, "role" | "status"> & { canSendWithoutApproval?: boolean },
  permission: Permission
): boolean {
  if (user.status !== "ACTIVE") return false;
  if (hasPermission(user.role, permission)) return true;
  // An employee explicitly granted send permissions can control, approve and start their campaigns
  if (user.canSendWithoutApproval && (permission === "campaigns.control" || permission === "campaigns.approve")) {
    return true;
  }
  return false;
}

// ============================================================================
// API CONTRACTS
// ============================================================================

/** The authenticated user as exposed to the client (never includes secrets). */
export const SessionUserSchema = z.object({
  id: z.string(),
  email: EmailSchema,
  name: z.string(),
  role: UserRoleSchema,
  status: UserStatusSchema,
  canSendWithoutApproval: z.boolean().default(false),
  senderName: z.string().nullable().optional(),
  sendingEmail: z.string().nullable().optional(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const InviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  name: z.string().trim().min(1, "Name is required").max(100),
  role: UserRoleSchema.default("EMPLOYEE"),
  canSendWithoutApproval: z.boolean().default(false),
  /** Email the invite link from the mailbox; the link is always shown to the inviter too */
  sendEmail: z.boolean().default(true),
});
export type InviteUserInput = z.input<typeof InviteUserSchema>;

const PasswordSchema = z.string().min(12, "Use at least 12 characters").max(200);

export const AcceptInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1, "Name is required").max(100),
  password: PasswordSchema,
});

export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: PasswordSchema,
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: PasswordSchema,
});

export interface TeamMemberDto extends SessionUser {
  lastLoginAt: string | null;
  createdAt: string;
  invitedBy: string | null;
}

export const UpdateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: UserRoleSchema.optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  canSendWithoutApproval: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

export interface CampaignCollaboratorDto {
  id: string;
  campaignId: string;
  userId: string;
  userName: string;
  userEmail: string;
  role: CampaignAccessRole;
  addedAt: string;
}

export const AddCollaboratorSchema = z.object({
  userId: z.string().min(1, "User ID is required"),
  role: CampaignAccessRoleSchema.default("EDITOR"),
});
export type AddCollaboratorInput = z.infer<typeof AddCollaboratorSchema>;

export const PASSWORD_MIN_LENGTH = 12;
export const SESSION_TTL_DAYS = 14;
export const SESSION_COOKIE_NAME = "fr_session";
