// Classifies an incoming message as a bounce (delivery failure report), a reply to one of our
// sends, an auto-reply, or unrelated. Pure functions over a parsed message — no IMAP here.

export interface IncomingMessage {
  from: string;
  subject: string;
  headers: Record<string, string>;
  text: string;
  /** Raw text of attached parts (message/delivery-status, message/rfc822, text/rfc822-headers) */
  attachments: { contentType: string; content: string }[];
  date: Date;
}

export type Classification =
  | { type: "bounce"; hard: boolean; recipient: string | null; messageIds: string[]; diagnostic: string }
  | { type: "reply"; messageIds: string[]; snippet: string }
  | { type: "auto_reply"; messageIds: string[] }
  | { type: "other" };

const MESSAGE_ID = /<[^<>\s@]+@[^<>\s]+>/g;

function idsIn(text: string, domain: string): string[] {
  const ids = (text.match(MESSAGE_ID) ?? []).map((m) => m.toLowerCase());
  return [...new Set(ids.filter((id) => id.endsWith(`@${domain}>`)))];
}

const header = (m: IncomingMessage, name: string) => m.headers[name.toLowerCase()] ?? "";

function isDeliveryReport(m: IncomingMessage): boolean {
  if (/report-type=["']?delivery-status/i.test(header(m, "content-type"))) return true;
  if (m.attachments.some((a) => /message\/delivery-status/i.test(a.contentType))) return true;
  if (header(m, "x-failed-recipients")) return true;
  const from = m.from.toLowerCase();
  const subject = m.subject.toLowerCase();
  if (/mailer-daemon|postmaster|mail delivery (subsystem|system)/i.test(from)) {
    return true;
  }
  if (
    /undeliver|delivery (status|failure|has failed)|failure notice|returned mail|could not be delivered|delivery failed|delivery report/i.test(
      subject
    )
  ) {
    return true;
  }
  return /final-recipient:\s*(?:rfc822;)?/i.test(m.text) || m.attachments.some((a) => /final-recipient:/i.test(a.content));
}

function cleanEmail(raw: string): string | null {
  const email = raw
    .replace(/[>.,;:)\s]+$/, "")
    .replace(/^[<(\s]+/, "")
    .trim()
    .toLowerCase();
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email) ? email : null;
}

function extractBounceRecipient(m: IncomingMessage, report: string): string | null {
  // 1. Final-Recipient (RFC 3464 standard DSN field)
  const finalMatch = report.match(/^\s*Final-Recipient:\s*(?:rfc822;\s*)?<?([^\s>;\r\n]+)>?/im);
  if (finalMatch?.[1]) {
    const cleaned = cleanEmail(finalMatch[1]);
    if (cleaned) return cleaned;
  }

  // 2. X-Failed-Recipients (Header or report line, SpaceMail / Postfix / Jellyfish)
  const xFailedHeader = header(m, "x-failed-recipients");
  if (xFailedHeader) {
    const match = xFailedHeader.match(/<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/);
    if (match?.[1]) {
      const cleaned = cleanEmail(match[1]);
      if (cleaned) return cleaned;
    }
  }

  const xFailedLine = report.match(/^\s*X-Failed-Recipients:\s*<?([^\s>;\r\n]+)>?/im);
  if (xFailedLine?.[1]) {
    const match = xFailedLine[1].match(/<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/);
    if (match?.[1]) {
      const cleaned = cleanEmail(match[1]);
      if (cleaned) return cleaned;
    }
  }

  // 3. Fallback to common delivery-failure body patterns
  const patterns: RegExp[] = [
    // "The following address(es) failed: <email>" or "The following address(es) failed:\n<email>"
    /the following address(?:\(es\)|es)? failed:[\s\r\n]*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/im,
    // "Delivery to the following recipient(s) [permanently] failed: <email>"
    /delivery to the following recipient(?:\(s\)|s)? (?:permanently )?failed:[\s\r\n]*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/im,
    // "Your message to user@example.com couldn't be delivered"
    /your message to\s+<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?\s+couldn't be delivered/im,
    // "The following recipient(s) cannot be reached: <email>"
    /the following recipient(?:\(s\)|s)? cannot be reached:[\s\r\n]*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/im,
    // "Recipient address rejected: <email>" or "Recipient address rejected: email"
    /recipient address rejected:[\s\r\n]*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/im,
    // "Failed to deliver to <email>" or "Failed to deliver to: email"
    /failed to deliver to:?[\s\r\n]*<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?/im,
    // "<email>: ... Recipient address rejected / User unknown / Mailbox unavailable / 550"
    /<([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>:\s*(?:.+?(?:user unknown|mailbox unavailable|does not exist|address rejected|relay access denied|550|5\.1\.1))/im,
    // "Original-Recipient: rfc822; email"
    /^\s*Original-Recipient:\s*(?:rfc822;\s*)?<?([^\s>;\r\n]+)>?/im,
  ];

  for (const pattern of patterns) {
    const match = report.match(pattern);
    if (match?.[1]) {
      const cleaned = cleanEmail(match[1]);
      if (cleaned) return cleaned;
    }
  }

  return null;
}

function isAutoReply(m: IncomingMessage): boolean {
  const auto = header(m, "auto-submitted");
  if (auto && auto.toLowerCase() !== "no") return true;
  if (header(m, "x-autoreply") || header(m, "x-autorespond")) return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test(header(m, "precedence"))) return true;
  return /^(auto(matic)?[ -]?reply|out of (the )?office|automatic response|on vacation)/i.test(m.subject.trim());
}

export function classifyIncoming(m: IncomingMessage, ourDomain: string): Classification {
  const domain = ourDomain.toLowerCase();

  if (isDeliveryReport(m)) {
    const report = m.attachments.map((a) => a.content).join("\n") + "\n" + m.text;
    const status = report.match(/^\s*Status:\s*([245])\.\d{1,3}\.\d{1,3}/im)?.[1];
    const recipient = extractBounceRecipient(m, report);
    const diagnostic =
      report.match(/^\s*Diagnostic-Code:\s*(?:smtp;\s*)?(.+(?:\n[ \t]+.+)*)/im)?.[1]?.replace(/\s+/g, " ").trim() ??
      m.text.split("\n").find((l) => /\b[45]\d\d\b/.test(l))?.trim() ??
      m.subject;
    const hard = status
      ? status === "5"
      : !/(?:mailbox (?:is )?full|quota exceeded|temporary failure|temporarily deferred|\b4\d\d\b)/i.test(report) &&
        (/user unknown|no such user|does not exist|address rejected|mailbox unavailable|invalid recipient|unknown user|account has been disabled|5\.\d\.\d|\b55\d\b/i.test(
          report
        ) || true);
    return { type: "bounce", hard, recipient, messageIds: idsIn(report, domain), diagnostic: diagnostic.slice(0, 500) };
  }

  const referenced = idsIn(`${header(m, "in-reply-to")} ${header(m, "references")}`, domain);
  if (!referenced.length) return { type: "other" };
  if (isAutoReply(m)) return { type: "auto_reply", messageIds: referenced };

  const snippet = m.text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith(">"))
    .join(" ")
    .split(/\bOn .{5,80} wrote:/)[0]!
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  return { type: "reply", messageIds: referenced, snippet };
}

export type ReplySentiment = "POSITIVE" | "NEGATIVE" | "OBJECTION" | "OUT_OF_OFFICE" | "UNSUBSCRIBE" | "UNCERTAIN" | "NEUTRAL";

export interface ReplyClassificationResult {
  sentiment: ReplySentiment;
  category?: "POSITIVE" | "NEGATIVE" | "OBJECTION" | "OUT_OF_OFFICE" | "UNSUBSCRIBE" | "UNCERTAIN";
  confidence: number;
  matchedKeywords: string[];
  isUnsubscribe?: boolean;
}

const OUT_OF_OFFICE_PATTERNS = [
  /\bout of (the )?office\b/i,
  /\baway from (the )?office\b/i,
  /\bannual leave\b/i,
  /\bon (vacation|holiday|leave)\b/i,
  /\bmaternity leave\b/i,
  /\bpaternity leave\b/i,
  /\bcurrently away\b/i,
  /\breturning on\b/i,
  /\bback in the office\b/i,
  /\blimited access to (my )?email\b/i,
  /\bautomated response\b/i,
  /\bauto-generated\b/i,
];

const UNSUBSCRIBE_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bremove (me|us|my email|this address)\b/i,
  /\bplease remove\b/i,
  /\btake (me|us) off\b/i,
  /\bstop (emailing|contacting|sending|reaching out)\b/i,
  /\bdo not contact\b/i,
  /\bcease and desist\b/i,
  /\blose my email\b/i,
  /\bopt out\b/i,
];

const OBJECTION_PATTERNS = [
  /\b(no|lack of|don't have) budget\b/i,
  /\btoo expensive\b/i,
  /\balready (using|have|working with|contracted)\b/i,
  /\bhave an existing (vendor|partner|solution|system)\b/i,
  /\bnot right now\b/i,
  /\bbad timing\b/i,
  /\btiming (is|isn't) (good|right)\b/i,
  /\bcheck back (in|next) (month|quarter|year|q[1-4])\b/i,
  /\breach back out\b/i,
  /\bfocusing on other (priorities|initiatives)\b/i,
  /\bhappy with our current\b/i,
];

const NEGATIVE_PATTERNS = [
  /\bnot interested\b/i,
  /\bno thank(s)?\b/i,
  /\bwrong person\b/i,
  /\bspam\b/i,
  /\bnot a good fit\b/i,
  /\bunsolicited\b/i,
  /\bpass on this\b/i,
  /\bno need\b/i,
];

const POSITIVE_PATTERNS = [
  /\binterested\b/i,
  /\bsounds good\b/i,
  /\bsounds great\b/i,
  /\blet'?s (talk|chat|connect|speak|discuss)\b/i,
  /\bschedule a (call|demo|meeting|time)\b/i,
  /\bbook a (call|demo|meeting|time)\b/i,
  /\bfree (on|next week|tomorrow|this week)\b/i,
  /\bconvenient time\b/i,
  /\bsend (over )?(some )?(pricing|information|details|deck)\b/i,
  /\bshare more details\b/i,
  /\btell me more\b/i,
  /\bwould love to learn more\b/i,
  /\bavailable on\b/i,
  /\bcall me at\b/i,
  /\bhere is my (number|calendar|calendly)\b/i,
  /\bforward(ed)? to our\b/i,
  /\b[0-9]+\s*(min|minute|minutes)\b/i,
  /\bopen to (a )?(brief |quick )?(call|chat|conversation|talk|meeting)\b/i,
];

export function classifyReplySentiment(text: string, subject = ""): ReplyClassificationResult {
  const combined = `${subject} ${text}`.toLowerCase();

  // 1. Check out of office
  const oooMatches = OUT_OF_OFFICE_PATTERNS.filter((p) => p.test(combined)).map((p) => combined.match(p)![0]);
  if (oooMatches.length > 0) {
    return {
      sentiment: "OUT_OF_OFFICE",
      confidence: 0.95,
      matchedKeywords: oooMatches,
    };
  }

  // 2. Check explicit unsubscribe
  const unsubMatches = UNSUBSCRIBE_PATTERNS.filter((p) => p.test(combined)).map((p) => combined.match(p)![0]);
  if (unsubMatches.length > 0) {
    return {
      sentiment: "NEGATIVE",
      category: "UNSUBSCRIBE",
      isUnsubscribe: true,
      confidence: 0.98,
      matchedKeywords: unsubMatches,
    };
  }

  // 3. Check objections (timing, budget, existing vendor)
  const objectionMatches = OBJECTION_PATTERNS.filter((p) => p.test(combined)).map((p) => combined.match(p)![0]);
  if (objectionMatches.length > 0) {
    return {
      sentiment: "OBJECTION",
      confidence: 0.88,
      matchedKeywords: objectionMatches,
    };
  }

  // 4. Check negative rejection
  const negativeMatches = NEGATIVE_PATTERNS.filter((p) => p.test(combined)).map((p) => combined.match(p)![0]);
  if (negativeMatches.length > 0) {
    return {
      sentiment: "NEGATIVE",
      confidence: 0.9,
      matchedKeywords: negativeMatches,
    };
  }

  // 5. Check positive interest
  const positiveMatches = POSITIVE_PATTERNS.filter((p) => p.test(combined)).map((p) => combined.match(p)![0]);
  if (positiveMatches.length > 0) {
    return {
      sentiment: "POSITIVE",
      confidence: 0.85,
      matchedKeywords: positiveMatches,
    };
  }

  // 6. Default Neutral / Uncertain
  return {
    sentiment: "NEUTRAL",
    confidence: 0.6,
    matchedKeywords: [],
  };
}

