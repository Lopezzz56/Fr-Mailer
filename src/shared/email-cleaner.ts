// Email Quote Cleaner & New Reply Content Extractor
// Extracts only the newly composed reply from an email thread, removing repeated/quoted email history.

export interface ExtractedReplyContent {
  cleanBody: string;
  quotedText: string | null;
}

/**
 * Extracts only the newly written content from an email body,
 * separating out previous email chains, headers, and quoted text.
 */
export function extractNewReplyContent(bodyText: string | null | undefined): ExtractedReplyContent {
  if (!bodyText || typeof bodyText !== "string") {
    return { cleanBody: "", quotedText: null };
  }

  const normalized = bodyText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  let splitIndex: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const nextLine1 = (lines[i + 1] ?? "").trim();
    const nextLine2 = (lines[i + 2] ?? "").trim();
    const nextLine3 = (lines[i + 3] ?? "").trim();
    const peek = [line, nextLine1, nextLine2, nextLine3].join("\n");

    // 1. Horizontal dividers followed by email headers (Outlook, SpaceMail, Webmail)
    // e.g. ________________________________\nFrom: ...
    if (/^_{4,}\s*$/.test(line) || /^-{4,}\s*$/.test(line)) {
      if (/^(From|Sender|Sent|Date):\s+/i.test(nextLine1) || /^(From|Sender|Sent|Date):\s+/i.test(nextLine2)) {
        splitIndex = i;
        break;
      }
    }

    // 2. Standard Original Message / Forwarded Message boundaries
    if (
      /^-----+\s*(?:Original Message|Forwarded Message|Ursprüngliche Nachricht|Message d'origine)\s*-----+$/i.test(line) ||
      /^----------+\s*Forwarded message\s*----------+$/i.test(line) ||
      /^-+\s*Original\s*-+$/i.test(line) ||
      /^Begin forwarded message:?$/i.test(line)
    ) {
      splitIndex = i;
      break;
    }

    // 3. Multi-line "From: ... Date/Sent: ... To: ... Subject: ..." header block
    if (/^From:\s+/i.test(line)) {
      const hasDateOrSent = /^(Date|Sent):\s+/im.test(peek) || /\b(Date|Sent):/i.test(line);
      const hasToOrSubject = /^(To|Subject):\s+/im.test(peek) || /\b(To|Subject):/i.test(line);
      if (hasDateOrSent || hasToOrSubject) {
        splitIndex = i;
        break;
      }
    }

    // 4. "On <date>, <person> wrote:" (Gmail, Apple Mail, Thunderbird, etc.)
    // Matches: "On Mon, Nov 17, 2026 at 4:32 PM, Frank Lopes <...> wrote:"
    // Matches: "On 17 Nov 2026, at 14:22, Ajay K. Bakaya wrote:"
    if (/^On\s+.+wrote:\s*$/i.test(line)) {
      splitIndex = i;
      break;
    }
    // Handle wrap across two lines: "On Mon, Nov 17, 2026 at 4:32 PM,\nFrank Lopes wrote:"
    if (/^On\s+.+,\s*$/i.test(line) && /.+wrote:\s*$/i.test(nextLine1)) {
      splitIndex = i;
      break;
    }

    // Common international variants:
    // French: "Le 17 nov. 2026 à 14:22, Ajay a écrit :"
    // German: "Am 17.11.2026 um 14:22 schrieb Ajay:"
    // Spanish: "El 17 de noviembre de 2026, Ajay escribió:"
    if (/^(?:Le\s+.+a écrit|Am\s+.+schrieb|El\s+.+escribió)\s*:?\s*$/i.test(line)) {
      splitIndex = i;
      break;
    }

    // 5. Contiguous block of quoted lines starting with ">"
    if (line.startsWith(">")) {
      const remainingLines = lines.slice(i).filter((l) => l.trim().length > 0);
      const allQuoted = remainingLines.every((l) => l.trim().startsWith(">"));
      if (allQuoted && remainingLines.length > 0) {
        splitIndex = i;
        break;
      }
    }
  }

  // 6. Inline "From: <email> Date: ... To: ..." within a single line or unformatted string
  // Example: "ajay From: Frank Lopes <founderoffice@focusrealm.org> Date: Friday, 13 November..."
  if (splitIndex === null) {
    const inlineMatch = normalized.match(/(?:\n|^)(.*?)\s+(From:\s+[^<\n]+<[^>]+@[^>]+>\s+(?:Date|Sent):[\s\S]*)/i);
    if (inlineMatch && inlineMatch[1] && inlineMatch[1].trim().length > 0) {
      const beforeInline = inlineMatch[1].trim();
      const afterInline = inlineMatch[2]?.trim() ?? null;
      return {
        cleanBody: beforeInline,
        quotedText: afterInline,
      };
    }
  }

  if (splitIndex !== null) {
    const beforeLines = lines.slice(0, splitIndex);
    const afterLines = lines.slice(splitIndex);

    let clean = beforeLines.join("\n").trim();
    const quoted = afterLines.join("\n").trim();

    // Ensure we do not destroy content if the entire email was considered a quote
    if (clean.length > 0) {
      return { cleanBody: clean, quotedText: quoted || null };
    }
  }

  // Fallback: If no quote boundary was confidently found or cleaning left nothing, return original
  return { cleanBody: normalized.trim(), quotedText: null };
}

