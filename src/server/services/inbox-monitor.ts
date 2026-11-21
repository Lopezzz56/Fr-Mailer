// Read-only IMAP monitor: finds bounce reports and replies to our sends in the SpaceMail inbox.
// Opens INBOX read-only (no flags changed, nothing moved) and remembers the last UID it processed.
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import type { Prisma } from "@prisma/client";
import prisma from "../db.js";
import { env, imapConfigured } from "../config.js";
import { messageIdDomain } from "./mailer.js";
import {
  getMailboxCredentials,
  getMailboxCredentialsForUser,
  getPersonalMailboxCredentials,
  listActivePersonalMailboxes,
} from "./personal-mailbox.js";
import { classifyIncoming, classifyReplySentiment, type IncomingMessage } from "./inbox-classifier.js";
import { stopSequenceForRecipient } from "./sequence-service.js";
import { recordInboundReplyToConversation } from "./conversation-service.js";

const STATE_KEY = "imap.state";
const FIRST_RUN_LOOKBACK_DAYS = 14;
const MAX_MESSAGES_PER_RUN = 500;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export interface ImapState {
  uidValidity?: string;
  lastUid?: number;
  lastCheckedAt?: string;
  lastError?: string | null;
  processed?: { bounces: number; replies: number };
  unmatchedReplies?: {
    from: string;
    subject: string;
    snippet: string;
    date: string;
    detectedSentiment: string;
  }[];
  unmatchedBounces?: {
    from: string;
    subject: string;
    recipient: string | null;
    diagnostic: string;
    date: string;
    hard: boolean;
  }[];
}

export function getImapPollIntervalMs(): number {
  return env.IMAP_POLL_INTERVAL_MS ?? env.IMAP_POLL_INTERVAL_SECONDS * 1000;
}

function stateKey(userId?: string): string {
  return userId ? `${STATE_KEY}.${userId}` : STATE_KEY;
}

export async function getImapState(userId?: string): Promise<ImapState> {
  const row = await prisma.setting.findUnique({ where: { key: stateKey(userId) } });
  return (row?.value as ImapState | undefined) ?? {};
}

async function saveImapState(state: ImapState, userId?: string) {
  const key = stateKey(userId);
  await prisma.setting.upsert({
    where: { key },
    update: { value: state as Prisma.InputJsonValue },
    create: { key, value: state as Prisma.InputJsonValue },
  });
}

function toIncoming(mail: ParsedMail): IncomingMessage {
  // Raw header values (unfolded), keyed by lower-case name; first occurrence wins
  const headers: Record<string, string> = {};
  for (const { key, line } of mail.headerLines) {
    headers[key] ??= line.slice(line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim();
  }
  return {
    from: mail.from?.text ?? "",
    subject: mail.subject ?? "",
    headers,
    text: mail.text ?? "",
    attachments: mail.attachments.map((a) => ({ contentType: a.contentType, content: a.content.toString("utf8").slice(0, 200_000) })),
    date: mail.date ?? new Date(),
  };
}

/** Applies one classified message. Idempotent: re-processing the same message changes nothing. */
async function applyClassification(message: IncomingMessage, domain: string, mailboxIdOrUserId?: string): Promise<"bounce" | "reply" | null> {
  const result = classifyIncoming(message, domain);
  if (result.type === "other" || result.type === "auto_reply") return null;

  // 1. Direct messageId match (globally unique UUID in sends table)
  let targets: Awaited<ReturnType<typeof prisma.send.findMany>> = [];
  if (result.messageIds.length > 0) {
    targets = await prisma.send.findMany({
      where: { messageId: { in: result.messageIds } },
    });
  }

  // 1b. Check conversation_messages table if targets is still empty (e.g. replies to in-app sent messages)
  if (!targets.length && result.messageIds.length > 0) {
    try {
      const matchedConvMsg = await prisma.conversationMessage?.findFirst?.({
        where: { messageId: { in: result.messageIds } },
        include: {
          send: true,
          conversation: {
            include: {
              initialSend: true,
            },
          },
        },
      });
      if (matchedConvMsg?.send) {
        targets = [matchedConvMsg.send];
      } else if (matchedConvMsg?.conversation?.initialSend) {
        targets = [matchedConvMsg.conversation.initialSend];
      } else if (matchedConvMsg?.conversation) {
        const conv = matchedConvMsg.conversation;
        const send = await prisma.send.findFirst({
          where: { campaignId: conv.campaignId, email: conv.recipientEmail, status: "SENT" },
          orderBy: { sentAt: "desc" },
        });
        if (send) targets = [send];
      }
    } catch {
      // In disconnected unit test stubs, continue to fallback
    }
  }

  // 2. Fallback when recipient mail client stripped In-Reply-To / References headers
  if (!targets.length) {
    const scopeFilter: Prisma.SendWhereInput = mailboxIdOrUserId
      ? {
          OR: [
            { mailboxId: mailboxIdOrUserId },
            { campaign: { mailboxId: mailboxIdOrUserId } },
            { campaign: { createdById: mailboxIdOrUserId } },
            { sentByUserId: mailboxIdOrUserId },
          ],
        }
      : {};

    if (result.type === "bounce" && result.recipient) {
      // Some servers drop original headers; fall back to most recent send to that address
      let recent = await prisma.send.findFirst({
        where: { email: result.recipient, status: "SENT", ...scopeFilter },
        orderBy: { sentAt: "desc" },
      });
      if (!recent && mailboxIdOrUserId) {
        recent = await prisma.send.findFirst({
          where: { email: result.recipient, status: "SENT" },
          orderBy: { sentAt: "desc" },
        });
      }
      if (!recent) {
        recent = await prisma.send.findFirst({
          where: { email: result.recipient, bouncedAt: { not: null }, ...scopeFilter },
          orderBy: { sentAt: "desc" },
        });
      }
      targets = recent ? [recent] : [];
    } else if (result.type === "reply") {
      // Extract from email from header
      const fromEmail = message.from.match(/<([^>]+)>/)?.[1] || message.from.trim();
      if (fromEmail) {
        const recent = await prisma.send.findFirst({
          where: { email: fromEmail, status: "SENT", ...scopeFilter },
          orderBy: { sentAt: "desc" },
        });
        if (recent) targets = [recent];
      }
    }
  }

  // If a bounce still cannot be matched to any send record, record as unmatched
  if (!targets.length && result.type === "bounce") {
    // If recipient is known and already handled, don't record as unmatched
    if (result.recipient) {
      const alreadyHandledSend = await prisma.send.findFirst({
        where: {
          email: result.recipient,
          bouncedAt: { not: null },
        },
      });
      if (alreadyHandledSend) {
        return "bounce";
      }
    }

    const state = await getImapState(mailboxIdOrUserId);
    const unmatched = state.unmatchedBounces ?? [];
    const dateStr = message.date.toISOString();
    const alreadyLogged = unmatched.some(
      (b) =>
        b.recipient === result.recipient &&
        b.diagnostic === result.diagnostic &&
        (b.date === dateStr || b.from === message.from)
    );
    if (!alreadyLogged) {
      unmatched.unshift({
        from: message.from,
        subject: message.subject,
        recipient: result.recipient,
        diagnostic: result.diagnostic,
        date: dateStr,
        hard: result.hard,
      });
      await saveImapState({ ...state, unmatchedBounces: unmatched.slice(0, 50) }, mailboxIdOrUserId);
    }
    return null;
  }

  // If a reply still cannot be matched to any send record, record as unmatched
  if (!targets.length && result.type === "reply") {
    const sentiment = classifyReplySentiment(result.snippet || message.text, message.subject);
    const state = await getImapState(mailboxIdOrUserId);
    const unmatched = state.unmatchedReplies ?? [];
    unmatched.unshift({
      from: message.from,
      subject: message.subject,
      snippet: result.snippet,
      date: message.date.toISOString(),
      detectedSentiment: sentiment.sentiment,
    });
    // Keep last 50 unmatched replies
    await saveImapState({ ...state, unmatchedReplies: unmatched.slice(0, 50) }, mailboxIdOrUserId);
    return null;
  }

  for (const send of targets) {
    if (result.type === "bounce") {
      const type = result.hard ? "HARD_BOUNCE" : "SOFT_BOUNCE";
      const already = await prisma.sendEvent.findFirst({ where: { sendId: send.id, type } });
      if (already) continue;
      await prisma.$transaction(async (tx) => {
        await tx.sendEvent.create({ data: { sendId: send.id, type, occurredAt: message.date, detail: { diagnostic: result.diagnostic, from: message.from } } });
        if (result.hard) {
          await tx.send.update({
            where: { id: send.id },
            data: {
              status: "FAILED",
              bouncedAt: message.date,
              lastError: result.diagnostic ? result.diagnostic.slice(0, 500) : "Hard bounce reported by mail system",
            },
          });
          await tx.suppressionEntry.upsert({
            where: { email: send.email },
            update: {
              reason: "HARD_BOUNCE",
              source: "bounce-report",
              campaignId: send.campaignId,
              metadata: { diagnostic: result.diagnostic },
            },
            create: {
              email: send.email,
              reason: "HARD_BOUNCE",
              source: "bounce-report",
              campaignId: send.campaignId,
              metadata: { diagnostic: result.diagnostic },
            },
          });
          await stopSequenceForRecipient(send.campaignId, send.email, `Hard bounce: ${result.diagnostic}`, "BOUNCED", tx);
        }
      });
    } else {
      const incomingMsgId = message.headers["message-id"] || null;
      const inReplyTo = message.headers["in-reply-to"] || null;
      const references = message.headers["references"] || null;

      const fromEmail = message.from.match(/<([^>]+)>/)?.[1] || message.from.trim();
      const fromName = message.from.replace(/<[^>]+>/, "").trim() || null;

      // Deduplicate: if incoming message has a message-id, verify if it was already recorded
      if (incomingMsgId) {
        try {
          const alreadyMsg = await prisma.conversationMessage?.findUnique?.({
            where: { messageId: incomingMsgId },
          });
          if (alreadyMsg) continue;
        } catch {
          // Ignore in disconnected test environments
        }
      } else {
        // Fall back to checking whether a reply was already recorded for this send
        const already = await prisma.sendEvent.findFirst({ where: { sendId: send.id, type: "REPLY" } });
        if (already) continue;
      }

      const sentiment = classifyReplySentiment(result.snippet || message.text, message.subject);

      await prisma.$transaction(async (tx) => {
        // Record into Conversation thread (creates Conversation if first reply or appends if multi-turn)
        const { isFirstReply } = await recordInboundReplyToConversation({
          campaignId: send.campaignId,
          recipientEmail: send.email,
          sendId: send.id,
          fromEmail,
          fromName,
          subject: message.subject,
          bodyText: message.text,
          snippet: result.snippet,
          messageId: incomingMsgId,
          inReplyTo,
          references,
          occurredAt: message.date,
          classification: sentiment.sentiment,
          tx,
        });

        // Record SendEvent audit entry
        await tx.sendEvent.create({
          data: {
            sendId: send.id,
            type: "REPLY",
            occurredAt: message.date,
            detail: {
              from: message.from,
              subject: message.subject,
              snippet: result.snippet,
              classification: sentiment.sentiment,
              confidence: sentiment.confidence,
              matchedKeywords: sentiment.matchedKeywords,
              isSubsequentReply: !isFirstReply,
              messageId: incomingMsgId,
              meetingBooked: false,
            },
          },
        });

        // If this is the initial reply from the recipient, update send.repliedAt and stop sequence
        if (isFirstReply) {
          await tx.send.update({
            where: { id: send.id },
            data: { repliedAt: send.repliedAt ?? message.date },
          });

          if (sentiment.sentiment === "UNSUBSCRIBE") {
            await tx.suppressionEntry.upsert({
              where: { email: send.email },
              update: {},
              create: {
                email: send.email,
                reason: "UNSUBSCRIBE",
                source: "reply-unsubscribe",
                campaignId: send.campaignId,
                metadata: { snippet: result.snippet },
              },
            });
            await stopSequenceForRecipient(
              send.campaignId,
              send.email,
              "Unsubscribe requested in reply",
              "SUPPRESSED",
              tx
            );
          } else {
            await stopSequenceForRecipient(
              send.campaignId,
              send.email,
              "Reply received — automated outreach stopped",
              "REPLY_RECEIVED",
              tx
            );
          }
        }
      });
    }
  }
  return targets.length ? result.type : null;
}

export async function isInboxMonitoringSafe(userId?: string): Promise<{ safe: boolean; reason?: string }> {
  if (!env.IMAP_POLL_ENABLED) return { safe: true };
  if (userId) {
    try {
      if (!(await getPersonalMailboxCredentials(userId))) {
        const mb = await getMailboxCredentials(userId);
        if (!mb) {
          const userMb = await getMailboxCredentialsForUser(userId);
          if (!userMb) {
            return { safe: false, reason: "The campaign owner has not connected a SpaceMail mailbox." };
          }
        }
      }
    } catch (error) {
      return { safe: false, reason: "The campaign owner mailbox credentials couldn't be read. Reconnect the mailbox in Settings." };
    }
  }
  if (!userId && !imapConfigured) return { safe: true };
  const state = await getImapState(userId);
  if (state.lastError) {
    return { safe: false, reason: `Inbox monitoring error: ${state.lastError}` };
  }
  if (!state.lastCheckedAt) {
    return { safe: false, reason: "Inbox monitoring has not executed yet" };
  }
  const ageMs = Date.now() - new Date(state.lastCheckedAt).getTime();
  const maxStaleMs = getImapPollIntervalMs() * 4 + 180000;
  if (ageMs > maxStaleMs) {
    return { safe: false, reason: `Inbox monitoring is delayed (last sync ${Math.round(ageMs / 60000)}m ago)` };
  }
  return { safe: true };
}

export async function checkInbox(mailboxIdOrUserId?: string): Promise<ImapState> {
  let personalMailbox = null;
  if (mailboxIdOrUserId) {
    personalMailbox = await getMailboxCredentials(mailboxIdOrUserId);
    if (!personalMailbox) {
      personalMailbox = await getMailboxCredentialsForUser(mailboxIdOrUserId);
    }
  }
  if (mailboxIdOrUserId && !personalMailbox) throw new Error("Connect your SpaceMail mailbox first.");
  if (!personalMailbox && !imapConfigured) throw new Error("IMAP isn't configured.");
  const state = await getImapState(mailboxIdOrUserId);
  const mailboxEmail = personalMailbox?.email || env.IMAP_USER || env.SMTP_USER || env.SMTP_FROM_EMAIL;
  const domain = messageIdDomain(mailboxEmail);
  const client = new ImapFlow({
    host: personalMailbox?.imapHost || env.IMAP_HOST!,
    port: personalMailbox?.imapPort || env.IMAP_PORT,
    secure: true,
    auth: personalMailbox
      ? { user: personalMailbox.email, pass: personalMailbox.password }
      : { user: env.IMAP_USER!, pass: env.IMAP_PASS! },
    logger: false,
  });

  let bounces = 0;
  let replies = 0;
  try {
    await client.connect();
    const mailbox = await client.mailboxOpen("INBOX", { readOnly: true });
    const uidValidity = String(mailbox.uidValidity);
    const resume = state.uidValidity === uidValidity && state.lastUid;

    const range = resume
      ? { uid: `${state.lastUid! + 1}:*` }
      : { since: new Date(Date.now() - FIRST_RUN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000) };
    const uids = ((await client.search(range, { uid: true })) || []).filter((u) => !resume || u > state.lastUid!).slice(0, MAX_MESSAGES_PER_RUN);

    let lastUid = resume ? state.lastUid! : 0;
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { source: true, size: true }, { uid: true });
      if (msg && msg.source && (msg.size ?? 0) <= MAX_MESSAGE_BYTES) {
        const outcome = await applyClassification(toIncoming(await simpleParser(msg.source)), domain, mailboxIdOrUserId);
        if (outcome === "bounce") bounces++;
        if (outcome === "reply") replies++;
      }
      lastUid = Math.max(lastUid, uid);
    }

    const next: ImapState = {
      ...state,
      uidValidity,
      lastUid: lastUid || (mailbox.uidNext ? mailbox.uidNext - 1 : 0),
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      processed: { bounces: (state.processed?.bounces ?? 0) + bounces, replies: (state.processed?.replies ?? 0) + replies },
    };
    await saveImapState(next, mailboxIdOrUserId);
    return next;
  } catch (err) {
    console.error(`[inbox] check failed for ${personalMailbox?.email ?? "system mailbox"}:`, err);
    const failed: ImapState = {
      ...state,
      lastCheckedAt: new Date().toISOString(),
      lastError: "The mailbox inbox could not be reached. Check the connection and try again.",
    };
    await saveImapState(failed, mailboxIdOrUserId);
    throw err;
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function anyInboxDue(): Promise<boolean> {
  if (!env.IMAP_POLL_ENABLED) return false;
  const accounts = await listActivePersonalMailboxes();
  const systemEmail = (env.IMAP_USER || env.SMTP_USER || env.SMTP_FROM_EMAIL || "").toLowerCase();
  const states = await Promise.all(accounts.map(({ userId }) => getImapState(userId)));
  if (states.some((state) => inboxStateDue(state))) return true;
  if (imapConfigured && !accounts.some((account) => account.email.toLowerCase() === systemEmail)) {
    return inboxStateDue(await getImapState());
  }
  return false;
}

function inboxStateDue(state: ImapState): boolean {
  const last = state.lastCheckedAt ? new Date(state.lastCheckedAt).getTime() : 0;
  return Date.now() - last >= getImapPollIntervalMs();
}

export async function checkAllInboxes(dueOnly = false): Promise<void> {
  if (!env.IMAP_POLL_ENABLED) return;
  const accounts = await listActivePersonalMailboxes();
  for (const account of accounts) {
    if (dueOnly && !inboxStateDue(await getImapState(account.userId))) continue;
    if (!account.credentials) {
      const state = await getImapState(account.userId);
      await saveImapState({
        ...state,
        lastCheckedAt: new Date().toISOString(),
        lastError: account.error?.message ?? "Stored mailbox credentials could not be read. Reconnect this mailbox in Settings.",
      }, account.userId);
      continue;
    }
    try {
      await checkInbox(account.userId);
    } catch (error) {
      console.error(`[inbox] check failed for ${account.email}:`, (error as Error).message);
    }
  }

  const systemEmail = (env.IMAP_USER || env.SMTP_USER || env.SMTP_FROM_EMAIL || "").toLowerCase();
  if (imapConfigured && !accounts.some((account) => account.email.toLowerCase() === systemEmail)) {
    if (!dueOnly || inboxStateDue(await getImapState())) {
      try {
        await checkInbox();
      } catch (error) {
        console.error("[inbox] system mailbox check failed:", (error as Error).message);
      }
    }
  }
}

export class InboxMonitor {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  start() {
    if (!env.IMAP_POLL_ENABLED || this.timer) return;
    const run = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        await checkAllInboxes(true);
      } catch (err) {
        console.error("[inbox] check failed:", (err as Error).message);
      } finally {
        this.busy = false;
      }
    };
    void run();
    this.timer = setInterval(run, getImapPollIntervalMs());
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// exported for tests
export { applyClassification as _applyClassification };
