// Outgoing mail transport (SpaceMail SMTP via nodemailer), behind an interface so tests can use a fake.
import nodemailer, { type Transporter } from "nodemailer";
import { env, smtpConfigured } from "../config.js";

export interface OutgoingMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Full RFC 5322 Message-ID including angle brackets */
  messageId?: string;
  fromName: string;
  fromEmail?: string | null;
  replyTo?: string | null;
  headers?: Record<string, string>;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

export interface MailTransport {
  send(message: OutgoingMessage): Promise<{ response: string }>;
  verify(): Promise<void>;
  close(): void;
}

export interface SmtpMailboxCredentials {
  accountId: string;
  userId: string;
  email: string;
  password: string;
  fromName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
}

class SmtpTransport implements MailTransport {
  private readonly transporter: Transporter;

  constructor(private readonly mailbox?: SmtpMailboxCredentials) {
    this.transporter = nodemailer.createTransport({
      host: mailbox?.smtpHost ?? env.SMTP_HOST,
      port: mailbox?.smtpPort ?? env.SMTP_PORT,
      secure: mailbox?.smtpSecure ?? env.SMTP_SECURE,
      auth: mailbox
        ? { user: mailbox.email, pass: mailbox.password }
        : { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
      pool: true,
      maxConnections: 1,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 60_000,
    });
  }

  async send(message: OutgoingMessage) {
    // SpaceMail Jellyfish Antispam strictly requires that the RFC 5322 From: header address matches
    // the envelope-from (authenticated SMTP user). A mismatch triggers error:
    // "554 5.7.1 <From> and <envelope-from> fields in the email headers don't match. Reason: JFE040011"
    // To comply with SpaceMail's policy:
    // 1. Both from.address and envelope.from use the authenticated mailbox account (e.g. namaste@misehotel.com).
    // 2. The user's chosen display name is shown to recipients (e.g. "Frank Lopes <namaste@misehotel.com>").
    // 3. The user's custom email (e.g. founderoffice@focusrealm.org) is set as Reply-To, so all recipient replies
    //    route directly to their preferred inbox.
    const authenticatedAddress = this.mailbox?.email || env.SMTP_USER || env.SMTP_FROM_EMAIL!;
    const senderDisplayName = message.fromName?.trim() || this.mailbox?.fromName || env.SMTP_FROM_NAME || "FocusRealm";

    const customSenderEmail = message.fromEmail?.trim();
    const effectiveReplyTo =
      message.replyTo?.trim() ||
      (customSenderEmail && customSenderEmail.toLowerCase() !== authenticatedAddress.toLowerCase()
        ? customSenderEmail
        : (!this.mailbox && env.SMTP_FROM_EMAIL && env.SMTP_FROM_EMAIL.toLowerCase() !== authenticatedAddress.toLowerCase()
            ? env.SMTP_FROM_EMAIL
            : authenticatedAddress));

    const mailOptions = {
      from: { name: senderDisplayName, address: authenticatedAddress },
      envelope: {
        from: authenticatedAddress,
        to: message.to,
      },
      to: message.to,
      replyTo: effectiveReplyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: attachment.content,
      })),
      messageId: message.messageId,
      headers: {
        ...message.headers,
        "X-Sender-Identity": senderDisplayName,
      },
    };
    const info = await this.transporter.sendMail(mailOptions);

    // Auto-save copy to IMAP Sent folder so it appears in Outlook / webmail
    const imapHost = this.mailbox?.imapHost || env.IMAP_HOST || (env.SMTP_HOST?.includes("spacemail.com") ? "mail.spacemail.com" : env.SMTP_HOST);
    const imapUser = this.mailbox?.email || env.IMAP_USER || env.SMTP_USER || env.SMTP_FROM_EMAIL;
    const imapPass = this.mailbox?.password || env.IMAP_PASS || env.SMTP_PASS;
    const imapPort = this.mailbox?.imapPort || env.IMAP_PORT || 993;

    if (imapHost && imapUser && imapPass) {
      try {
        await Promise.race([
          appendToSent(mailOptions, { host: imapHost, port: imapPort, user: imapUser, pass: imapPass }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("IMAP append timeout (6s)")), 6000)),
        ]);
      } catch (err) {
        console.warn("[mailer] Could not append to Sent folder:", (err as Error).message);
      }
    }

    return { response: String(info.response ?? "") };
  }

  async verify() {
    await this.transporter.verify();
  }

  close() {
    this.transporter.close();
  }
}

let override: MailTransport | null = null;
const smtpTransports = new Map<string, SmtpTransport>();
const SYSTEM_TRANSPORT_KEY = "system";

/** Tests (and the local SMTP sink harness) can swap the transport */
export function setTransport(transport: MailTransport | null) {
  override = transport;
}

export function getTransport(mailbox?: SmtpMailboxCredentials): MailTransport {
  if (override) return override;
  if (!mailbox && !smtpConfigured) throw new Error("The sending mailbox isn't configured on the server.");
  const key = mailbox?.accountId ?? SYSTEM_TRANSPORT_KEY;
  let transport = smtpTransports.get(key);
  if (!transport) {
    transport = new SmtpTransport(mailbox);
    smtpTransports.set(key, transport);
  }
  return transport;
}

/** A fresh, non-pooled connection used only to check the credentials */
export async function verifyMailbox(mailbox?: SmtpMailboxCredentials): Promise<void> {
  if (override) return override.verify();
  if (!mailbox && !smtpConfigured) throw new Error("The sending mailbox isn't configured on the server.");
  const probe = new SmtpTransport(mailbox);
  try {
    await probe.verify();
  } finally {
    probe.close();
  }
}

export function closeTransport(accountId?: string) {
  if (accountId) {
    smtpTransports.get(accountId)?.close();
    smtpTransports.delete(accountId);
    return;
  }
  for (const transport of smtpTransports.values()) transport.close();
  smtpTransports.clear();
}

/** Domain used for our Message-IDs, so replies and bounces can be matched back */
export function messageIdDomain(senderEmail?: string): string {
  return ((senderEmail || env.SMTP_USER || env.SMTP_FROM_EMAIL)?.split("@")[1] ?? "focusrealm.local").toLowerCase();
}

/** Appends a message copy to the IMAP Sent mailbox using ImapFlow */
async function appendToSent(
  mailOptions: Record<string, unknown>,
  credentials: { host: string; port: number; user: string; pass: string }
): Promise<void> {
  const { ImapFlow } = await import("imapflow");
  const MailComposer = (await import("nodemailer/lib/mail-composer/index.js")).default;
  // @ts-ignore MailComposer constructor
  const composer = new MailComposer(mailOptions);
  const raw = await composer.compile().build();

  const client = new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: true,
    auth: { user: credentials.user, pass: credentials.pass },
    logger: false,
    clientInfo: { name: "FocusRealm-Mailer", version: "1.0.0" },
  });

  try {
    await client.connect();
    // Locate Outlook and SpaceMail Sent folder
    const list = await client.list();
    const sentMailbox =
      list.find((m) => m.specialUse === "\\Sent")?.path ||
      list.find((m) => /^sent items$/i.test(m.name) || /^sent items$/i.test(m.path))?.path ||
      list.find((m) => /^sent$/i.test(m.name) || /^inbox\.sent$/i.test(m.path))?.path ||
      list.find((m) => /sent/i.test(m.name))?.path ||
      "Sent";

    await client.append(sentMailbox, raw, ["\\Seen"], new Date());
  } finally {
    await client.logout().catch(() => undefined);
  }
}
