// Outgoing mail transport (SpaceMail SMTP via nodemailer), behind an interface so tests can use a fake.
import nodemailer from "nodemailer";
import { env, smtpConfigured } from "../config.js";

export interface OutgoingMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Full RFC 5322 Message-ID including angle brackets */
  messageId?: string;
  fromName: string;
  replyTo?: string | null;
  headers?: Record<string, string>;
}

export interface MailTransport {
  send(message: OutgoingMessage): Promise<{ response: string }>;
  verify(): Promise<void>;
  close(): void;
}

class SmtpTransport implements MailTransport {
  private readonly transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
    pool: true,
    maxConnections: 1, // one mailbox: keep it to a single connection; the worker paces sending
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  });

  async send(message: OutgoingMessage) {
    const info = await this.transporter.sendMail({
      from: { name: message.fromName, address: env.SMTP_FROM_EMAIL! },
      to: message.to,
      replyTo: message.replyTo ?? undefined,
      subject: message.subject,
      html: message.html,
      text: message.text,
      messageId: message.messageId,
      headers: message.headers,
    });
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
let smtp: SmtpTransport | null = null;

/** Tests (and the local SMTP sink harness) can swap the transport */
export function setTransport(transport: MailTransport | null) {
  override = transport;
}

export function getTransport(): MailTransport {
  if (override) return override;
  if (!smtpConfigured) throw new Error("The sending mailbox isn't configured on the server.");
  smtp ??= new SmtpTransport();
  return smtp;
}

/** A fresh, non-pooled connection used only to check the credentials */
export async function verifyMailbox(): Promise<void> {
  if (override) return override.verify();
  if (!smtpConfigured) throw new Error("The sending mailbox isn't configured on the server.");
  const probe = new SmtpTransport();
  try {
    await probe.verify();
  } finally {
    probe.close();
  }
}

export function closeTransport() {
  smtp?.close();
  smtp = null;
}

/** Domain used for our Message-IDs, so replies and bounces can be matched back */
export function messageIdDomain(): string {
  return (env.SMTP_FROM_EMAIL?.split("@")[1] ?? "focusrealm.local").toLowerCase();
}
