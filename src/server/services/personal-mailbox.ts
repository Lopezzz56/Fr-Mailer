import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import nodemailer from "nodemailer";
import prisma from "../db.js";
import { env } from "../config.js";
import { AppError } from "../middleware/error-handler.js";
import { closeTransport, type SmtpMailboxCredentials } from "./mailer.js";
import type { MailboxAccountDto, MailboxAssignedUserDto, UserAccessibleMailboxDto } from "../../shared/types.js";

const CIPHER_VERSION = "v1";
const SMTP_DEFAULT_HOST = "mail.spacemail.com";
const IMAP_DEFAULT_HOST = "mail.spacemail.com";

export interface PersonalMailboxCredentials extends SmtpMailboxCredentials {
  userId: string;
  imapHost: string;
  imapPort: number;
}

export interface PersonalMailboxStatus {
  id: string;
  email: string;
  fromName: string;
  lastVerifiedAt: Date;
}

export interface PersonalMailboxLookup {
  userId: string;
  email: string;
  credentials?: PersonalMailboxCredentials;
  error?: Error;
}

function encryptionKey(): Buffer {
  return scryptSync(env.APP_SECRET, "focusrealm-user-mailbox-v1", 32);
}

export function encryptMailboxPassword(password: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return [CIPHER_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptMailboxPassword(value: string): string {
  const [version, encodedIv, encodedTag, encodedPassword, ...rest] = value.split(".");
  if (version !== CIPHER_VERSION || !encodedIv || !encodedTag || !encodedPassword || rest.length) {
    throw new Error("Stored mailbox credentials have an unsupported format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedPassword, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function smtpDefaults() {
  return {
    host: env.SMTP_HOST || SMTP_DEFAULT_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
  };
}

function mailboxCredentials(account: {
  id: string;
  userId: string;
  email: string;
  encryptedPassword: string;
  fromName: string;
}): PersonalMailboxCredentials {
  const smtp = smtpDefaults();
  return {
    accountId: account.id,
    userId: account.userId,
    email: account.email,
    password: decryptMailboxPassword(account.encryptedPassword),
    fromName: account.fromName,
    smtpHost: smtp.host,
    smtpPort: smtp.port,
    smtpSecure: smtp.secure,
    imapHost: env.IMAP_HOST || IMAP_DEFAULT_HOST,
    imapPort: env.IMAP_PORT,
  };
}

/**
 * Resolves credentials for a specific mailbox account by its ID.
 */
export async function getMailboxCredentials(
  mailboxId: string,
  customFromName?: string
): Promise<PersonalMailboxCredentials | null> {
  const account = await prisma.mailboxAccount.findUnique({
    where: { id: mailboxId },
  });
  if (!account) return null;
  try {
    return mailboxCredentials({
      id: account.id,
      userId: "",
      email: account.email,
      encryptedPassword: account.encryptedPassword,
      fromName: customFromName || account.fromName,
    });
  } catch (error) {
    console.error(`[mailbox] couldn't decrypt credentials for mailbox ${mailboxId}:`, error);
    throw AppError.conflict(
      "MAILBOX_CREDENTIALS_UNREADABLE",
      "Saved SpaceMail credentials can't be read. Reconnect your mailbox in Settings before sending."
    );
  }
}

/**
 * Resolves credentials by the mailbox's email address.
 */
export async function getMailboxCredentialsByEmail(
  email: string,
  customFromName?: string
): Promise<PersonalMailboxCredentials | null> {
  const account = await prisma.mailboxAccount.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (!account) return null;
  try {
    return mailboxCredentials({
      id: account.id,
      userId: "",
      email: account.email,
      encryptedPassword: account.encryptedPassword,
      fromName: customFromName || account.fromName,
    });
  } catch (error) {
    console.error(`[mailbox] couldn't decrypt credentials for mailbox ${account.id}:`, error);
    throw AppError.conflict(
      "MAILBOX_CREDENTIALS_UNREADABLE",
      "Saved SpaceMail credentials can't be read. Reconnect your mailbox in Settings before sending."
    );
  }
}

/**
 * Resolves credentials for a user. If mailboxId is provided, validates user access.
 * Otherwise, picks the user's default or first assigned mailbox.
 */
export async function getMailboxCredentialsForUser(
  userId: string,
  mailboxId?: string
): Promise<PersonalMailboxCredentials | null> {
  if (mailboxId) {
    const access = await prisma.mailboxAccess.findUnique({
      where: { mailboxId_userId: { mailboxId, userId } },
      include: { mailbox: true },
    });
    if (access) {
      try {
        return mailboxCredentials({
          id: access.mailbox.id,
          userId,
          email: access.mailbox.email,
          encryptedPassword: access.mailbox.encryptedPassword,
          fromName: access.senderName || access.mailbox.fromName,
        });
      } catch (error) {
        console.error(`[mailbox] couldn't decrypt credentials for user ${userId} / mailbox ${mailboxId}:`, error);
        throw AppError.conflict(
          "MAILBOX_CREDENTIALS_UNREADABLE",
          "Your saved SpaceMail credentials can't be read. Reconnect your mailbox in Settings before sending."
        );
      }
    }
  }

  // Look up user's default or first assigned mailbox
  const defaultAccess = await prisma.mailboxAccess.findFirst({
    where: { userId, user: { status: "ACTIVE" } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: { mailbox: true },
  });

  if (defaultAccess) {
    try {
      return mailboxCredentials({
        id: defaultAccess.mailbox.id,
        userId,
        email: defaultAccess.mailbox.email,
        encryptedPassword: defaultAccess.mailbox.encryptedPassword,
        fromName: defaultAccess.senderName || defaultAccess.mailbox.fromName,
      });
    } catch (error) {
      console.error(`[mailbox] couldn't decrypt credentials for user ${userId}:`, error);
      throw AppError.conflict(
        "MAILBOX_CREDENTIALS_UNREADABLE",
        "Your saved SpaceMail credentials can't be read. Reconnect your mailbox in Settings before sending."
      );
    }
  }

  // Fallback check on legacy userMailbox
  const legacy = await prisma.userMailbox.findFirst({
    where: { userId, user: { status: "ACTIVE" } },
    select: { id: true, userId: true, email: true, encryptedPassword: true, fromName: true },
  });
  if (legacy) {
    try {
      return mailboxCredentials(legacy);
    } catch (error) {
      console.error(`[mailbox] couldn't decrypt credentials for user ${userId}:`, error);
      throw AppError.conflict(
        "MAILBOX_CREDENTIALS_UNREADABLE",
        "Your saved SpaceMail credentials can't be read. Reconnect your mailbox in Settings before sending."
      );
    }
  }

  return null;
}

/**
 * Backward compatibility wrapper for getMailboxCredentialsForUser.
 */
export async function getPersonalMailboxCredentials(userId: string): Promise<PersonalMailboxCredentials | null> {
  return getMailboxCredentialsForUser(userId);
}

/**
 * Returns primary status of the mailbox for the specified user.
 */
export async function getPersonalMailboxStatus(userId: string): Promise<PersonalMailboxStatus | null> {
  const access = await prisma.mailboxAccess.findFirst({
    where: { userId, user: { status: "ACTIVE" } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: { mailbox: true },
  });
  if (access) {
    return {
      id: access.mailbox.id,
      email: access.mailbox.email,
      fromName: access.senderName || access.mailbox.fromName,
      lastVerifiedAt: access.mailbox.lastVerifiedAt,
    };
  }
  return prisma.userMailbox.findFirst({
    where: { userId, user: { status: "ACTIVE" } },
    select: { id: true, email: true, fromName: true, lastVerifiedAt: true },
  });
}

/**
 * Lists all mailboxes accessible to a specific user.
 */
export async function listAccessibleMailboxes(userId: string): Promise<UserAccessibleMailboxDto[]> {
  const accessRows = await prisma.mailboxAccess.findMany({
    where: { userId, user: { status: "ACTIVE" } },
    include: { mailbox: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });

  if (accessRows.length > 0) {
    return accessRows.map((a) => ({
      id: a.mailbox.id,
      email: a.mailbox.email,
      fromName: a.mailbox.fromName,
      senderName: a.senderName || a.mailbox.fromName,
      isDefault: a.isDefault,
      lastVerifiedAt: a.mailbox.lastVerifiedAt.toISOString(),
    }));
  }

  const legacy = await prisma.userMailbox.findFirst({
    where: { userId, user: { status: "ACTIVE" } },
  });
  if (legacy) {
    return [
      {
        id: legacy.id,
        email: legacy.email,
        fromName: legacy.fromName,
        senderName: legacy.fromName,
        isDefault: true,
        lastVerifiedAt: legacy.lastVerifiedAt.toISOString(),
      },
    ];
  }

  return [];
}

/**
 * Lists all mailbox accounts in the workspace with assigned users.
 * Founder / Founder Office only.
 */
export async function listAllMailboxAccounts(): Promise<MailboxAccountDto[]> {
  const accounts = await prisma.mailboxAccount.findMany({
    include: {
      accessList: {
        include: {
          user: {
            select: { id: true, name: true, email: true, role: true },
          },
        },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      },
    },
    orderBy: { email: "asc" },
  });

  return accounts.map((acc) => ({
    id: acc.id,
    email: acc.email,
    fromName: acc.fromName,
    lastVerifiedAt: acc.lastVerifiedAt.toISOString(),
    createdAt: acc.createdAt.toISOString(),
    assignedUsers: acc.accessList.map((a) => ({
      userId: a.user.id,
      userName: a.user.name,
      userEmail: a.user.email,
      userRole: a.user.role,
      senderName: a.senderName,
      isDefault: a.isDefault,
      assignedAt: a.createdAt.toISOString(),
    })),
  }));
}

/**
 * Returns distinct active mailbox accounts for IMAP monitoring.
 * Ensures IMAP monitoring connects once per distinct mailbox account rather than per-user duplicate.
 */
export async function listActivePersonalMailboxes(): Promise<PersonalMailboxLookup[]> {
  const accounts = await prisma.mailboxAccount.findMany({
    select: { id: true, email: true, encryptedPassword: true, fromName: true },
    orderBy: { email: "asc" },
  });

  if (accounts.length > 0) {
    return accounts.map((account) => {
      try {
        return {
          userId: account.id,
          email: account.email,
          credentials: mailboxCredentials({ ...account, userId: account.id }),
        };
      } catch (error) {
        console.error(`[mailbox] couldn't decrypt credentials for mailbox ${account.id}:`, error);
        return {
          userId: account.id,
          email: account.email,
          error: new Error("Stored mailbox credentials could not be decrypted."),
        };
      }
    });
  }

  // Fallback to legacy userMailboxes
  const legacyAccounts = await prisma.userMailbox.findMany({
    where: { user: { status: "ACTIVE" } },
    select: { id: true, userId: true, email: true, encryptedPassword: true, fromName: true },
    orderBy: { email: "asc" },
  });
  return legacyAccounts.map((account) => {
    try {
      return { userId: account.userId, email: account.email, credentials: mailboxCredentials(account) };
    } catch (error) {
      console.error(`[mailbox] couldn't decrypt credentials for user ${account.userId}:`, error);
      return { userId: account.userId, email: account.email, error: new Error("Stored mailbox credentials could not be decrypted.") };
    }
  });
}

export async function verifySmtpCredentials(email: string, pass: string): Promise<void> {
  const smtp = smtpDefaults();
  const probe = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: email, pass },
    connectionTimeout: 15_000,
  });
  try {
    await probe.verify();
  } catch (error) {
    console.error("[mailbox] SMTP verification failed:", error);
    throw AppError.badRequest(
      "SMTP_CONNECTION_FAILED",
      "Couldn't verify the SpaceMail credentials. Check the email, password, and connection, then try again."
    );
  } finally {
    probe.close();
  }
}

export async function verifyImapMailbox(credentials: PersonalMailboxCredentials): Promise<void> {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: credentials.imapHost,
    port: credentials.imapPort,
    secure: true,
    auth: { user: credentials.email, pass: credentials.password },
    logger: false,
  });
  try {
    await client.connect();
    await client.mailboxOpen("INBOX", { readOnly: true });
  } catch (error) {
    console.error("[mailbox] IMAP verification failed:", error);
    throw AppError.badRequest(
      "IMAP_CONNECTION_FAILED",
      "Couldn't reach or sign in to the SpaceMail inbox. Check the connection and try again."
    );
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * Connects or updates a shared SpaceMail mailbox.
 * Assigns actor and any optional user IDs.
 * Allows assigning existing mailboxes to additional users without 'already connected' conflict.
 */
export async function connectOrUpdateMailbox(
  actor: { id: string; role: string; name?: string },
  input: {
    email: string;
    password?: string;
    fromName: string;
    assignUserIds?: string[];
  }
): Promise<{ mailboxId: string; email: string; fromName: string; lastVerifiedAt: string }> {
  const email = input.email.trim().toLowerCase();
  const fromName = input.fromName.trim();

  const existing = await prisma.mailboxAccount.findUnique({
    where: { email },
    include: { accessList: true },
  });

  let password = input.password?.trim();
  if (!password && existing) {
    try {
      password = decryptMailboxPassword(existing.encryptedPassword);
    } catch {
      throw AppError.badRequest("PASSWORD_REQUIRED", "Enter the SpaceMail password to reconnect this mailbox.");
    }
  }

  if (!password) {
    throw AppError.badRequest("PASSWORD_REQUIRED", "Enter the SpaceMail password for this mailbox.");
  }

  // 1. Verify SMTP
  await verifySmtpCredentials(email, password);

  // 2. Verify IMAP
  const probeCredentials: PersonalMailboxCredentials = {
    accountId: existing?.id ?? "probe",
    userId: actor.id,
    email,
    password,
    fromName,
    smtpHost: env.SMTP_HOST || SMTP_DEFAULT_HOST,
    smtpPort: env.SMTP_PORT,
    smtpSecure: env.SMTP_SECURE,
    imapHost: env.IMAP_HOST || IMAP_DEFAULT_HOST,
    imapPort: env.IMAP_PORT,
  };
  await verifyImapMailbox(probeCredentials);

  const lastVerifiedAt = new Date();
  const encryptedPassword = encryptMailboxPassword(password);

  const mailbox = await prisma.$transaction(async (tx) => {
    const acc = await tx.mailboxAccount.upsert({
      where: { email },
      update: { fromName, encryptedPassword, lastVerifiedAt },
      create: { email, fromName, encryptedPassword, lastVerifiedAt },
    });

    // Ensure actor and any requested user IDs have access
    const userIdsToAssign = new Set([actor.id, ...(input.assignUserIds ?? [])]);
    for (const uid of userIdsToAssign) {
      const userObj = await tx.user.findUnique({
        where: { id: uid },
        select: { id: true, name: true, senderName: true },
      });
      if (userObj) {
        const hasAccess = await tx.mailboxAccess.findUnique({
          where: { mailboxId_userId: { mailboxId: acc.id, userId: uid } },
        });
        if (!hasAccess) {
          const userHasDefault = await tx.mailboxAccess.findFirst({
            where: { userId: uid, isDefault: true },
          });
          await tx.mailboxAccess.create({
            data: {
              mailboxId: acc.id,
              userId: uid,
              senderName: userObj.senderName || userObj.name || fromName,
              isDefault: !userHasDefault,
            },
          });
        }
      }
    }

    return acc;
  });

  if (existing) closeTransport(existing.id);

  return {
    mailboxId: mailbox.id,
    email: mailbox.email,
    fromName: mailbox.fromName,
    lastVerifiedAt: lastVerifiedAt.toISOString(),
  };
}

/**
 * Assigns a team member to an authorized shared mailbox.
 */
export async function assignUserToMailbox(
  actor: { id: string; role: string },
  mailboxId: string,
  input: { userId: string; senderName?: string; isDefault?: boolean }
): Promise<MailboxAssignedUserDto> {
  if (actor.role === "EMPLOYEE") {
    throw AppError.forbidden("INSUFFICIENT_PERMISSIONS", "Only Founder and Founder Office can assign mailboxes to users.");
  }

  const mailbox = await prisma.mailboxAccount.findUnique({ where: { id: mailboxId } });
  if (!mailbox) throw AppError.notFound("MAILBOX_NOT_FOUND", "Mailbox not found.");

  const targetUser = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, name: true, email: true, role: true, senderName: true },
  });
  if (!targetUser) throw AppError.notFound("USER_NOT_FOUND", "User not found.");

  const senderName = input.senderName?.trim() || targetUser.senderName || targetUser.name || mailbox.fromName;

  if (input.isDefault) {
    await prisma.mailboxAccess.updateMany({
      where: { userId: input.userId },
      data: { isDefault: false },
    });
  }

  const access = await prisma.mailboxAccess.upsert({
    where: { mailboxId_userId: { mailboxId, userId: input.userId } },
    update: {
      senderName,
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
    },
    create: {
      mailboxId,
      userId: input.userId,
      senderName,
      isDefault: input.isDefault ?? false,
    },
  });

  return {
    userId: targetUser.id,
    userName: targetUser.name,
    userEmail: targetUser.email,
    userRole: targetUser.role,
    senderName: access.senderName,
    isDefault: access.isDefault,
    assignedAt: access.createdAt.toISOString(),
  };
}

/**
 * Removes a user's access to a shared mailbox.
 */
export async function removeUserFromMailbox(
  actor: { id: string; role: string },
  mailboxId: string,
  userId: string
): Promise<void> {
  if (actor.role === "EMPLOYEE" && actor.id !== userId) {
    throw AppError.forbidden("INSUFFICIENT_PERMISSIONS", "You can only remove your own mailbox access.");
  }

  await prisma.mailboxAccess.deleteMany({
    where: { mailboxId, userId },
  });
}

/**
 * Updates a user's custom sender display name or default status for a mailbox.
 */
export async function updateMailboxUserAccess(
  actor: { id: string; role: string },
  mailboxId: string,
  userId: string,
  input: { senderName?: string; isDefault?: boolean }
): Promise<void> {
  if (actor.role === "EMPLOYEE" && actor.id !== userId) {
    throw AppError.forbidden("INSUFFICIENT_PERMISSIONS", "You can only edit your own sender identity.");
  }

  if (input.isDefault) {
    await prisma.mailboxAccess.updateMany({
      where: { userId },
      data: { isDefault: false },
    });
  }

  await prisma.mailboxAccess.update({
    where: { mailboxId_userId: { mailboxId, userId } },
    data: {
      ...(input.senderName !== undefined ? { senderName: input.senderName.trim() || null } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
    },
  });
}

/**
 * Permanently removes a shared mailbox account. Founder only.
 */
export async function deleteMailboxAccount(
  actor: { id: string; role: string },
  mailboxId: string
): Promise<void> {
  if (actor.role !== "FOUNDER") {
    throw AppError.forbidden("INSUFFICIENT_PERMISSIONS", "Only the Founder can disconnect an organization mailbox.");
  }

  await prisma.mailboxAccount.delete({ where: { id: mailboxId } });
  closeTransport(mailboxId);
}

/**
 * Backward compatibility: updates or creates mailbox for user.
 */
export async function updatePersonalMailbox(
  userId: string,
  input: { email: string; password?: string; fromName?: string }
): Promise<{ email: string; fromName: string; lastVerifiedAt: string }> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, role: true, name: true, senderName: true },
  });

  const fromName = input.fromName?.trim() || user.senderName || user.name;
  const res = await connectOrUpdateMailbox(user, {
    email: input.email,
    password: input.password,
    fromName,
  });

  return {
    email: res.email,
    fromName: res.fromName,
    lastVerifiedAt: res.lastVerifiedAt,
  };
}

/**
 * Backward compatibility: unassigns user from their default mailbox.
 */
export async function removePersonalMailbox(userId: string): Promise<void> {
  const defaultAccess = await prisma.mailboxAccess.findFirst({
    where: { userId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  if (defaultAccess) {
    await prisma.mailboxAccess.delete({ where: { id: defaultAccess.id } });
  } else {
    const legacy = await prisma.userMailbox.findUnique({ where: { userId } });
    if (legacy) {
      await prisma.userMailbox.delete({ where: { userId } });
      closeTransport(legacy.id);
    }
  }
}

export function personalMailboxServerSettings() {
  return {
    smtpHost: env.SMTP_HOST || SMTP_DEFAULT_HOST,
    smtpPort: env.SMTP_PORT,
    smtpSecure: env.SMTP_SECURE,
    imapHost: env.IMAP_HOST || IMAP_DEFAULT_HOST,
    imapPort: env.IMAP_PORT,
    imapPollingEnabled: env.IMAP_POLL_ENABLED,
    imapPollIntervalSeconds: env.IMAP_POLL_INTERVAL_SECONDS,
  };
}
