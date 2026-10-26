// Template writer, shared by server and client:
// - the request/response shapes for AI drafting (Gemini, server-side)
// - built-in starter templates that need no API (generated from the fields the workspace has)
// - reviewTemplateDraft: soft checks on any generated draft before a person uses it
import { z } from "zod";
import { extractMergeFields, STANDARD_FIELDS } from "./merge.js";

export const WRITER_TONES = {
  warm: "Warm and personal",
  professional: "Professional",
  concise: "Short and direct",
  upbeat: "Upbeat",
} as const;
export type WriterTone = keyof typeof WRITER_TONES;

export const WRITER_LENGTHS = {
  short: { label: "Short", words: "60–90 words" },
  medium: { label: "Medium", words: "100–150 words" },
  long: { label: "Detailed", words: "160–220 words" },
} as const;
export type WriterLength = keyof typeof WRITER_LENGTHS;

export const TemplateDraftRequestSchema = z.object({
  brief: z.string().trim().min(10, "Describe the email in a sentence or two.").max(2000),
  tone: z.enum(Object.keys(WRITER_TONES) as [WriterTone, ...WriterTone[]]).default("warm"),
  length: z.enum(Object.keys(WRITER_LENGTHS) as [WriterLength, ...WriterLength[]]).default("medium"),
  /** An example email or the current draft to learn structure and voice from */
  example: z.string().trim().max(6000).optional(),
  signOff: z.string().trim().max(200).optional(),
});
export type TemplateDraftRequest = z.input<typeof TemplateDraftRequestSchema>;

/** A merge field the workspace can fill, with how many contacts have a value (0–1) */
export interface WriterField {
  name: string;
  label: string;
  coverage: number;
  custom: boolean;
}

export interface WriterContextDto {
  aiEnabled: boolean;
  model: string | null;
  totalContacts: number;
  fields: WriterField[];
}

export interface TemplateDraftDto {
  name: string;
  subject: string;
  /** Plain-text body using {{field}} / {{field|fallback}} */
  body: string;
  warnings: string[];
  source: "gemini" | "starter";
  model?: string;
}

// ---------------------------------------------------------------------------
// Review: things a person should look at before using a draft
// ---------------------------------------------------------------------------

export function reviewTemplateDraft(draft: { subject: string; body: string }, fields: WriterField[], totalContacts: number): string[] {
  const warnings: string[] = [];
  const known = new Map(fields.map((f) => [f.name, f]));
  for (const f of extractMergeFields({ subject: draft.subject, bodyHtml: draft.body })) {
    const field = known.get(f.name);
    if (!field) {
      warnings.push(`{{${f.name}}} isn't a field your contacts have. Remove it or import that column.`);
    } else if (f.required && totalContacts > 0 && field.coverage < 1) {
      const missing = Math.round((1 - field.coverage) * 100);
      warnings.push(`{{${f.name}}} has no fallback, and ${missing}% of contacts don't have it. They'd be skipped. Add one, e.g. {{${f.name}|…}}.`);
    }
  }
  if (/\[[^\]\n]{2,60}\]/.test(draft.subject + draft.body)) warnings.push("Replace the [bracketed] placeholders before using this.");
  if (/\*\*|^#{1,3}\s|^\s*[-*]\s/m.test(draft.body)) warnings.push("It contains markdown symbols (** # -) that will show as typed.");
  if (draft.subject.replace(/\{\{[^}]*\}\}/g, "xxxxxx").length > 78) warnings.push("The subject is long; most inboxes cut it off around 60–70 characters.");
  if (/unsubscribe/i.test(draft.body)) warnings.push("An unsubscribe line is added automatically; you can remove the one in the message.");
  return warnings;
}

// ---------------------------------------------------------------------------
// Starter templates (no API): picked by goal, shaped by tone and the fields available
// ---------------------------------------------------------------------------

export const STARTER_GOALS = {
  mise_pilot: { label: "Mise Hotel Outreach", description: "Frontline SOP execution & Advisory Board pilot." },
  co_market: { label: "Co-Market Partnership", description: "Training, recruitment, and service quality partner proposal." },
  introduction: { label: "Introduce yourself", description: "First email to someone new." },
  partnership: { label: "Propose a partnership", description: "Suggest working together." },
  meeting: { label: "Ask for a meeting", description: "Request a short call." },
  follow_up: { label: "Follow up", description: "Nudge after an earlier email." },
  event: { label: "Invite to an event", description: "Webinar, launch or visit." },
  thank_you: { label: "Say thank you", description: "After a call or a purchase." },
} as const;
export type StarterGoal = keyof typeof STARTER_GOALS;

const PLACE_FIELDS = ["city", "location", "region", "area", "town", "state"];
/** Custom columns that usually hold the organisation's name, e.g. "hotelName" */
const ORG_FIELD = /^(company|hotel|property|business|organi[sz]ation|brand|account|venue|restaurant|clinic|school)(name)?$/i;

export function buildStarterTemplate(args: { goal: StarterGoal; tone: WriterTone; fields: WriterField[]; signOff?: string }): TemplateDraftDto {
  const has = (name: string) => args.fields.some((f) => f.name === name && f.coverage > 0);
  const first = has("firstName") ? "{{firstName|there}}" : "there";
  const orgField = has("company") ? "company" : args.fields.find((f) => f.custom && f.coverage > 0 && ORG_FIELD.test(f.name))?.name;
  const company = orgField ? `{{${orgField}|your team}}` : "your team";
  const place = PLACE_FIELDS.find(has);
  const where = place ? ` in {{${place}|your area}}` : "";
  const sign = args.signOff?.trim() || "The FocusRealm team";
  const t = args.tone;

  const greeting = t === "professional" ? `Hello ${first},` : t === "upbeat" ? `Hi ${first}!` : `Hi ${first},`;
  const closing = { warm: "Warm regards,", professional: "Kind regards,", concise: "Thanks,", upbeat: "Cheers," }[t];
  const easyOut =
    t === "concise" ? "" : "If now isn't the right time, just reply and let me know. I won't keep chasing.";

  const goals: Record<StarterGoal, { name: string; subject: string; paragraphs: string[]; customBody?: string }> = {
    mise_pilot: {
      name: "Mise Hotel Outreach",
      subject: `Ensuring frontline service execution at ${company}`,
      paragraphs: [],
      customBody: [
        greeting,
        "I’m reaching out on behalf of Sehej Sharma, Founder & CEO of FocusRealm.",
        "One of the key challenges in hospitality is ensuring that SOPs, training, and service standards defined at the corporate level are consistently followed by frontline teams across properties. Even when standards are clearly documented, ensuring that tasks are executed correctly, verified, and recorded can be difficult across multiple teams and locations.",
        "Mise Hotel, our hospitality-focused Service Execution Platform, is designed to address this challenge by bringing SOPs, training, and operational workflows together in a mobile-first platform. It helps translate documented standards into assigned tasks, supports teams in executing them, and captures evidence of completion to improve operational visibility and accountability.",
        `As we continue developing Mise Hotel, we would welcome the opportunity to explore a pilot with ${company} to demonstrate the platform, understand your operational requirements, and gather feedback from your team.`,
        `We are also bringing together experienced hospitality leaders for the FocusRealm Hotel Advisory Board, where industry experts can help shape Mise Hotel around the real-world needs of hotel operations, workforce training, and service delivery. Given ${company}’s experience in the hospitality industry, we would be honoured to explore your potential involvement.`,
        "Would your team be available for a 20-minute meeting with Sehej to discuss Mise Hotel, a potential pilot, and the advisory opportunity? We would be happy to coordinate a time that suits your schedule.",
        "Thank you for your time. We look forward to the opportunity to connect.",
        `Best wishes,\n${args.signOff?.trim() || "Sachin Annadurai\nFounder’s Office\nFocusRealm\nhttps://misehotel.com/\nhttps://focusrealm.org/"}`,
      ].join("\n\n"),
    },
    co_market: {
      name: "Co-Market Partnership",
      subject: `Co-market partnership opportunity: ${company} & FocusRealm`,
      paragraphs: [],
      customBody: [
        greeting,
        "I’m reaching out on behalf of Sehej Sharma, Founder & CEO of FocusRealm.",
        "One of the key challenges in hospitality is ensuring that SOPs, training, and service standards defined at the corporate level are consistently followed by frontline teams across properties. Even when standards are clearly documented, ensuring that tasks are executed correctly, verified, and recorded can be difficult across multiple teams and locations.",
        "Mise Hotel, our hospitality-focused Service Execution Platform, is designed to address this challenge by bringing SOPs, training, and operational workflows together in a mobile-first platform. It helps translate documented standards into assigned tasks, supports teams in executing them, and captures evidence of completion to improve operational visibility and accountability.",
        `We have been closely following ${company} and your work in hospitality: ${has("whatItDoes") ? "{{whatItDoes|customized training and operational infrastructure}}" : "customized training and operational infrastructure"}.`,
        `We see a natural synergy: ${has("partnershipOpportunity") ? "{{partnershipOpportunity|verifying frontline service execution}}" : "verifying frontline service execution"}.`,
        `As we continue developing Mise Hotel, we would welcome the opportunity to explore a pilot with ${company} to demonstrate the platform, understand your operational requirements, and gather feedback from your team.`,
        `We are also bringing together experienced hospitality leaders for the FocusRealm Hotel Advisory Board, where industry experts can help shape Mise Hotel around the real-world needs of hotel operations, workforce training, and service delivery. Given ${company}’s experience in the hospitality industry, we would be honoured to explore your potential involvement.`,
        "Would your team be available for a 20-minute meeting with Sehej to discuss Mise Hotel, a potential pilot, and the advisory opportunity? We would be happy to coordinate a time that suits your schedule.",
        "Thank you for your time. We look forward to the opportunity to connect.",
        `Best wishes,\n${args.signOff?.trim() || "Sachin\nFounder’s Office\nFocusRealm\nhttps://misehotel.com/\nhttps://focusrealm.org/"}`,
      ].join("\n\n"),
    },
    introduction: {
      name: "Introduction",
      subject: t === "concise" ? `Quick intro for ${company}` : `A quick introduction for ${company}`,
      paragraphs: [
        `I'm reaching out because we work with teams like ${company}${where}, and I think there's a good fit between what we do and what you're building.`,
        "We keep things simple: a short conversation to understand how you work today, and a couple of practical ideas you can use whether or not we work together.",
        "Would you be open to a 15-minute call next week?",
      ],
    },
    partnership: {
      name: "Partnership proposal",
      subject: `An idea for ${company}`,
      paragraphs: [
        `I've been looking at how ${company} works${where}, and I'd love to explore a partnership that helps us both reach more of the right people.`,
        "I have a few concrete ideas in mind, from shared offers to joint introductions, and I'd rather shape them with you than send a long proposal.",
        "Could we find 20 minutes to talk it through?",
      ],
    },
    meeting: {
      name: "Meeting request",
      subject: t === "concise" ? "15 minutes next week?" : `15 minutes with ${company} next week?`,
      paragraphs: [
        `I'd value a short call to learn more about ${company}'s plans for the coming months and see where we might help.`,
        "Does Tuesday or Thursday afternoon work? If another time suits you better, just suggest one and I'll fit around it.",
      ],
    },
    follow_up: {
      name: "Follow-up",
      subject: t === "professional" ? "Following up on my last email" : "Circling back",
      paragraphs: [
        "I wanted to follow up on my earlier note in case it got buried.",
        `I'm still keen to hear how things are going at ${company} and whether a quick conversation would be useful.`,
        "A one-line reply is plenty, even if it's \"not now\".",
      ],
    },
    event: {
      name: "Event invitation",
      subject: `You're invited, ${first === "there" ? "friend" : "{{firstName|friend}}"}`,
      paragraphs: [
        `We're hosting a small session for teams like ${company}${where}, and I'd love for you to join us.`,
        "It's practical and short: what's working right now, what isn't, and time for your questions.",
        "Reply to this email and I'll save you a place and send the details.",
      ],
    },
    thank_you: {
      name: "Thank you",
      subject: "Thank you",
      paragraphs: [
        `Thank you for your time${orgField ? ` and for everything the team at {{${orgField}|your company}} shared` : ""}. I really appreciated it.`,
        "As promised, I'll send over the next steps shortly. If anything comes up in the meantime, just reply here.",
      ],
    },
  };

  const g = goals[args.goal];
  const middle = t === "concise" ? g.paragraphs.filter((_, i) => i !== 1 || g.paragraphs.length < 3) : g.paragraphs;
  const body = g.customBody ?? [greeting, ...middle, ...(easyOut && args.goal !== "thank_you" ? [easyOut] : []), `${closing}\n${sign}`].join("\n\n");
  return { name: `${g.name} (${WRITER_TONES[t].toLowerCase()})`, subject: g.subject, body, warnings: [], source: "starter" };
}

/** Standard fields with labels, for building a WriterField list */
export const STANDARD_FIELD_LABELS: Record<string, string> = Object.fromEntries(STANDARD_FIELDS.map((f) => [f.name, f.label]));
