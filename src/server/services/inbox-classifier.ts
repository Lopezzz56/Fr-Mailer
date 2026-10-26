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
  const from = m.from.toLowerCase();
  const subject = m.subject.toLowerCase();
  return (
    /mailer-daemon|postmaster|mail delivery (subsystem|system)/.test(from) &&
    /undeliver|delivery (status|failure|has failed)|failure notice|returned mail|could not be delivered|delivery failed/.test(subject)
  );
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
    const recipient = report.match(/^\s*Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/im)?.[1]?.toLowerCase() ?? null;
    const diagnostic =
      report.match(/^\s*Diagnostic-Code:\s*(?:smtp;\s*)?(.+(?:\n[ \t]+.+)*)/im)?.[1]?.replace(/\s+/g, " ").trim() ??
      m.text.split("\n").find((l) => /\b[45]\d\d\b/.test(l))?.trim() ??
      m.subject;
    const hard = status
      ? status === "5"
      : /user unknown|no such user|does not exist|address rejected|mailbox unavailable|invalid recipient/i.test(report);
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
