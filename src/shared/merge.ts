// Merge-field engine shared by server (sending, approval) and client (editor, preview).
//
// Syntax: {{fieldName}} or {{fieldName|fallback text}}
// - Field names: letters, digits, underscore; must start with a letter or underscore.
// - A field without a fallback is required: a recipient missing it is reported, never
//   silently sent with a blank.
// - Values are HTML-escaped in HTML bodies and stripped of line breaks in subjects.

export interface MergeField {
  name: string;
  fallback?: string;
  required: boolean;
}

export interface TemplateParts {
  subject: string;
  bodyHtml: string;
  bodyText?: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Required fields with no value for this recipient */
  missingFields: string[];
}

export type MergeData = Record<string, unknown>;

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Any {{ ... }} token whose content has no braces
const TOKEN = /\{\{([^{}]*)\}\}/g;

/** Built-in contact fields available to every template, in display order */
export const STANDARD_FIELDS = [
  { name: "firstName", label: "First name" },
  { name: "lastName", label: "Last name" },
  { name: "fullName", label: "Full name" },
  { name: "email", label: "Email" },
  { name: "company", label: "Company" },
  { name: "title", label: "Job title" },
  { name: "phone", label: "Phone" },
] as const;

function parseToken(raw: string): { name: string; fallback?: string } | null {
  const pipe = raw.indexOf("|");
  const name = (pipe === -1 ? raw : raw.slice(0, pipe)).trim();
  if (!FIELD_NAME.test(name)) return null;
  if (pipe === -1) return { name };
  return { name, fallback: raw.slice(pipe + 1).trim() };
}

/** All merge fields used across the given template parts (first occurrence wins for fallback) */
export function extractMergeFields(parts: TemplateParts): MergeField[] {
  const fields = new Map<string, MergeField>();
  for (const text of [parts.subject, parts.bodyHtml, parts.bodyText ?? ""]) {
    for (const match of text.matchAll(TOKEN)) {
      const token = parseToken(match[1]!);
      if (!token) continue;
      const existing = fields.get(token.name);
      if (!existing) {
        fields.set(token.name, { name: token.name, fallback: token.fallback, required: token.fallback === undefined });
      } else if (token.fallback === undefined) {
        // Used somewhere without a fallback -> required overall
        existing.required = true;
      }
    }
  }
  return [...fields.values()];
}

/** Syntax problems, phrased for the person editing the template. Empty array = valid. */
export function validateTemplate(parts: TemplateParts): string[] {
  const errors: string[] = [];
  const named: [string, string][] = [
    ["Subject", parts.subject],
    ["HTML body", parts.bodyHtml],
    ["Plain-text body", parts.bodyText ?? ""],
  ];

  if (!parts.subject.trim()) errors.push("Subject is empty.");
  if (!parts.bodyHtml.trim()) errors.push("Email body is empty.");

  for (const [label, text] of named) {
    if (/\{\{[^}]*\{\{/.test(text)) {
      errors.push(`${label}: merge fields can't be nested inside each other.`);
      continue;
    }
    const opens = (text.match(/\{\{/g) ?? []).length;
    const closes = (text.match(/\}\}/g) ?? []).length;
    if (opens !== closes) {
      errors.push(`${label}: a merge field is missing its closing "}}" or opening "{{".`);
      continue;
    }
    for (const match of text.matchAll(TOKEN)) {
      if (!parseToken(match[1]!)) {
        errors.push(`${label}: "{{${match[1]}}}" isn't a valid field name. Use letters, numbers or _ with no spaces.`);
      }
    }
  }
  return errors;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A value counts as present only if it is a non-blank string/number/boolean */
export function resolveValue(data: MergeData, name: string): string | undefined {
  const value = data[name];
  if (value === null || value === undefined) return undefined;
  const str = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
  return str !== undefined && str.trim() !== "" ? str : undefined;
}

type Mode = "html" | "text" | "subject";

function renderPart(text: string, data: MergeData, mode: Mode, missing: Set<string>): string {
  return text.replace(TOKEN, (whole, raw: string) => {
    const token = parseToken(raw);
    if (!token) return whole;
    let value = resolveValue(data, token.name);
    if (value === undefined) {
      if (token.fallback === undefined) missing.add(token.name);
      value = token.fallback ?? "";
    }
    if (mode === "html") return escapeHtml(value);
    if (mode === "subject") return value.replace(/[\r\n]+/g, " ");
    return value;
  });
}

/** Very small HTML -> text conversion for the plain-text alternative when none is written */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) =>
      label.replace(/<[^>]+>/g, "").trim() === href ? href : `${label} (${href})`
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Plain-text email -> simple HTML: blank lines become paragraphs, single newlines <br>,
 * URLs become links. Merge tokens are left untouched so their fallbacks aren't double-escaped.
 */
export function plainTextToHtml(text: string): string {
  const escapeOutsideTokens = (s: string) =>
    s
      .split(/(\{\{[^{}]*\}\})/g)
      .map((part, i) => (i % 2 === 1 ? part : escapeHtml(part).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`)))
      .join("");
  return text
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeOutsideTokens(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** True when the HTML body is exactly what plainTextToHtml makes from the text body */
export function isPlainTextTemplate(parts: TemplateParts): boolean {
  return Boolean(parts.bodyText && parts.bodyHtml === plainTextToHtml(parts.bodyText));
}

export function renderEmail(parts: TemplateParts, data: MergeData): RenderedEmail {
  const missing = new Set<string>();
  const subject = renderPart(parts.subject, data, "subject", missing).trim();
  const html = renderPart(parts.bodyHtml, data, "html", missing);
  const text = parts.bodyText?.trim() ? renderPart(parts.bodyText, data, "text", missing) : htmlToText(html);
  return { subject, html, text, missingFields: [...missing] };
}

export interface ContactLike {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  phone?: string | null;
  hotelSegment?: string | null;
  contactPersona?: string | null;
  customFields?: unknown;
}

/** Flattens a contact (standard + custom fields) into merge data; standard fields win on name clashes */
export function contactMergeData(contact: ContactLike, overrides?: MergeData): MergeData {
  const custom =
    contact.customFields && typeof contact.customFields === "object" && !Array.isArray(contact.customFields)
      ? (contact.customFields as MergeData)
      : {};
  const fullName = [contact.firstName, contact.lastName].filter((p) => p && p.trim()).join(" ");
  return {
    ...custom,
    email: contact.email,
    firstName: contact.firstName ?? undefined,
    lastName: contact.lastName ?? undefined,
    fullName: fullName || undefined,
    company: contact.company ?? undefined,
    title: contact.title ?? undefined,
    phone: contact.phone ?? undefined,
    hotelSegment: contact.hotelSegment ?? undefined,
    contactPersona: contact.contactPersona ?? undefined,
    ...(overrides ?? {}),
  };
}
