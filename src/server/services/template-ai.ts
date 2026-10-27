// AI template drafting with Google Gemini (REST generateContent, structured JSON output).
// What leaves the server: the person's brief, an optional example email they supplied, the sign-off,
// and merge-field names with coverage percentages. Contact records are never sent.
// The draft comes back to a person for review; nothing is saved or sent automatically.
import { z } from "zod";
import prisma from "../db.js";
import { env } from "../config.js";
import { AppError } from "../middleware/error-handler.js";
import { validateTemplate } from "../../shared/merge.js";
import {
  STANDARD_FIELD_LABELS,
  WRITER_LENGTHS,
  WRITER_TONES,
  reviewTemplateDraft,
  type TemplateDraftDto,
  type TemplateDraftRequestSchema,
  type WriterContextDto,
  type WriterField,
} from "../../shared/template-writer.js";

type DraftInput = z.output<typeof TemplateDraftRequestSchema>;

// ---------------------------------------------------------------------------
// What the workspace can personalize with
// ---------------------------------------------------------------------------

export async function writerFields(): Promise<{ totalContacts: number; fields: WriterField[] }> {
  const [counts] = await prisma.$queryRaw<{ total: bigint; firstName: bigint; lastName: bigint; company: bigint; title: bigint; phone: bigint }[]>`
    SELECT COUNT(*) AS total,
      COUNT(NULLIF(TRIM("firstName"), '')) AS "firstName",
      COUNT(NULLIF(TRIM("lastName"), '')) AS "lastName",
      COUNT(NULLIF(TRIM(company), '')) AS company,
      COUNT(NULLIF(TRIM(title), '')) AS title,
      COUNT(NULLIF(TRIM(phone), '')) AS phone
    FROM contacts`;
  const custom = await prisma.$queryRaw<{ key: string; count: bigint }[]>`
    SELECT key, COUNT(*) AS count FROM contacts, jsonb_each_text("customFields") AS kv(key, value)
    WHERE TRIM(value) <> '' GROUP BY key ORDER BY count DESC, key LIMIT 60`;

  const total = Number(counts?.total ?? 0);
  const share = (n: bigint | number | undefined) => (total ? Math.min(1, Number(n ?? 0) / total) : 0);
  const standard: [string, number][] = [
    ["firstName", share(counts?.firstName)],
    ["lastName", share(counts?.lastName)],
    ["fullName", share(counts?.firstName)],
    ["email", total ? 1 : 0],
    ["company", share(counts?.company)],
    ["title", share(counts?.title)],
    ["phone", share(counts?.phone)],
  ];
  return {
    totalContacts: total,
    fields: [
      ...standard.map(([name, coverage]) => ({ name, label: STANDARD_FIELD_LABELS[name] ?? name, coverage, custom: false })),
      ...custom.map((c) => ({ name: c.key, label: c.key, coverage: share(c.count), custom: true })),
    ],
  };
}

export async function writerContext(): Promise<WriterContextDto> {
  const { totalContacts, fields } = await writerFields();
  return { aiEnabled: Boolean(env.GEMINI_API_KEY), model: env.GEMINI_API_KEY ? env.GEMINI_MODEL : null, totalContacts, fields };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_INSTRUCTION = `You write email templates for FocusRealm Mail Merge, a tool that sends one personalised copy of a template to each contact in a list.

Write like a thoughtful executive, not a generic marketer: specific, plain, friendly, no hype, no clichés ("I hope this email finds you well", "game-changer"), no exclamation-mark pile-ups.

TONE GUIDELINES:
- warm: Warm, personal, conversational, relationship-first. Starts with "Hi {{firstName|there}},", sincere appreciation for their work, respectful and collaborative.
- professional: Executive, polished, strategic commercial rationale. Starts with "Hello {{firstName|there}},", structured reasoning, focuses on complementary client value and pilot assessment.
- concise: Short, direct, under 85 words. Zero filler sentences. Respects executive time, rapid value contrast.
- upbeat: Energetic, enthusiastic, forward-looking ("Hi {{firstName|there}}!"). Celebrates what they build and proposes teaming up.

CRITICAL RULE FOR CO-MARKETING / PARTNERSHIPS:
When writing co-marketing or partnership emails (hospitality training, recruitment, creative/PR agencies, hotel tech providers, consultants):
- DO NOT sell software or pitch a software product.
- Propose how both companies COMPLEMENT each other (mutual synergy, joint client value, co-marketing content/workshops).
- Weave in what they do using fields like {{aboutCompany|whatItDoes|servicesProvided}} and the specific partnership angle using fields like {{partnershipOpportunity|personalizationAngle|potentialPartnership}}.
- Position FocusRealm as an operational-readiness complement (verifying frontline service execution) that enhances what they already deliver for hotels and resorts.
- Reference the Founder's Office / Sehej Sharma (Founder & CEO of FocusRealm).

REFERENCE EXAMPLE 1 (Hospitality Creative / Marketing Agency):
"Hi {{firstName|there}},

I'm reaching out on behalf of Sehej Sharma, Founder & CEO of FocusRealm.

{{company|Your team}}'s work across {{aboutCompany|whatItDoes|servicesProvided|hospitality marketing, PR, content and events}} presents an interesting opportunity for us to explore a complementary partnership.

At FocusRealm, we're focused on helping hotels improve frontline service execution and operational consistency. While your work helps hotels strengthen their visibility and guest acquisition, we could potentially help those same properties deliver a more consistent guest experience once guests arrive.

We'd love to explore a joint initiative around {{partnershipOpportunity|personalizationAngle|"Guest Experience Beyond the Booking"}}, combining hospitality marketing with operational readiness for selected hotel clients.

Would you be open to a 15–20 minute conversation with Sehej to explore whether there's a fit?

Best wishes,
Founder’s Office
FocusRealm
https://misehotel.com/
https://focusrealm.org/"

REFERENCE EXAMPLE 2 (Revenue, Pricing & Commercial Operations):
"Hello {{firstName|there}},

I am reaching out on behalf of Sehej Sharma, Founder & CEO of FocusRealm.

{{company|Your team}}'s focus on {{aboutCompany|whatItDoes|servicesProvided|hotel revenue, pricing and distribution}} presents an interesting opportunity to explore a complementary partnership.

At FocusRealm, we help hotels strengthen frontline service execution and operational consistency. We believe there may be an opportunity to combine revenue-growth initiatives with operational improvements, helping selected properties focus on both commercial performance and the guest experience.

We'd be interested in exploring a small referral or pilot initiative around {{partnershipOpportunity|personalizationAngle|a collaborative service add-on}} before considering anything more extensive.

Would you or someone from your leadership team be available for a 15–20 minute conversation with Sehej to discuss mutual fit?

Best regards,
Founder’s Office
FocusRealm
https://misehotel.com/
https://focusrealm.org/"

Personalisation uses merge fields: {{fieldName}} or {{fieldName|fallback}} or chained fallbacks {{field1|field2|fallback}}.
- Use only fields from the list you are given, spelled exactly (case-sensitive). Never invent a field.
- Any field that not every contact has MUST have a fallback that reads naturally, e.g. "Hi {{firstName|there}}," or "teams like {{company|yours}}".
- Use personalisation where it helps; don't force every field in.

Facts: use only what the brief and the example state. Don't invent results, numbers, prices, clients, awards, dates or links. Where a detail is unknown, write around it. Never leave [placeholders].

Format: the body is plain text. Paragraphs are separated by one blank line. No markdown, no bullet symbols, no HTML. End with a short sign-off. Don't add an unsubscribe line or postal address (the platform adds them). The subject is under 60 characters, specific, and not clickbait.`;

export function buildPrompt(input: DraftInput, fields: WriterField[], totalContacts: number): string {
  const fieldLines = fields
    .filter((f) => f.coverage > 0 || totalContacts === 0)
    .map((f) => `- ${f.name}: ${f.label}${totalContacts ? ` (${Math.round(f.coverage * 100)}% of contacts have it)` : ""}`)
    .join("\n");
  const defaultSignOff = "Founder’s Office\nFocusRealm\nhttps://misehotel.com/\nhttps://focusrealm.org/";
  return [
    "Write one email template.",
    `What the email should do:\n<brief>\n${input.brief}\n</brief>`,
    `Tone: ${WRITER_TONES[input.tone]}. Body length: ${WRITER_LENGTHS[input.length].words}.`,
    `Sign off with:\n${input.signOff ? input.signOff : defaultSignOff}`,
    `Merge fields available${totalContacts ? ` (${totalContacts} contacts)` : " (no contacts imported yet)"}:\n${fieldLines}`,
    input.example
      ? `Example email to learn structure and voice from. Improve on it; keep its facts but add none; only use its merge fields if they are in the list above:\n<example>\n${input.example}\n</example>`
      : "",
    'Also give the template a short internal name (2–5 words), e.g. "Hotel partnership intro".',
  ]
    .filter(Boolean)
    .join("\n\n");
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short internal name for the template, 2–5 words" },
    subject: { type: "string", description: "Subject line, may use merge fields" },
    body: { type: "string", description: "Plain-text body; paragraphs separated by a blank line" },
  },
  required: ["name", "subject", "body"],
} as const;

const OutputSchema = z.object({ name: z.string().trim().min(1).max(100), subject: z.string().trim().min(1).max(300), body: z.string().trim().min(1).max(20_000) });

// ---------------------------------------------------------------------------
// Gemini call
// ---------------------------------------------------------------------------

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

const TIMEOUT_MS = 45_000;

function apiError(status: number, body: GeminiResponse | null): AppError {
  const reason = body?.error?.message ?? "";
  console.error(`[template-ai] Gemini HTTP ${status}: ${reason.slice(0, 300)}`);
  if (status === 400 && /api key/i.test(reason)) return new AppError("AI_MISCONFIGURED", "The Gemini API key was rejected. Check GEMINI_API_KEY on the server.", 503);
  if (status === 401 || status === 403) return new AppError("AI_MISCONFIGURED", "The Gemini API key isn't allowed to use this model. Check GEMINI_API_KEY and the project's access.", 503);
  if (status === 404) return new AppError("AI_MISCONFIGURED", `The model "${env.GEMINI_MODEL}" isn't available. Check GEMINI_MODEL on the server.`, 503);
  if (status === 429) return new AppError("AI_RATE_LIMITED", "Gemini's usage limit was reached. Wait a minute and try again.", 429);
  if (status >= 500) return new AppError("AI_UNAVAILABLE", "Gemini is having trouble right now. Try again in a moment.", 502);
  return new AppError("AI_FAILED", "Gemini couldn't write this draft. Try rephrasing the brief.", 502);
}

export async function draftWithGemini(
  input: DraftInput,
  ctx: { fields: WriterField[]; totalContacts: number },
  opts: { apiKey?: string; model?: string; baseUrl?: string } = {}
): Promise<TemplateDraftDto> {
  const apiKey = opts.apiKey ?? env.GEMINI_API_KEY;
  const model = opts.model ?? env.GEMINI_MODEL;
  if (!apiKey) throw new AppError("AI_DISABLED", "AI writing isn't set up on this server. Add GEMINI_API_KEY, or use a starter template.", 503);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${opts.baseUrl ?? env.GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: buildPrompt(input, ctx.fields, ctx.totalContacts) }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: RESPONSE_SCHEMA },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new AppError("AI_TIMEOUT", "Gemini took too long to answer. Try again.", 504);
    console.error("[template-ai] request failed:", (err as Error).message);
    throw new AppError("AI_UNAVAILABLE", "Couldn't reach Gemini. Check the server's internet connection and try again.", 502);
  } finally {
    clearTimeout(timer);
  }

  const body = (await res.json().catch(() => null)) as GeminiResponse | null;
  if (!res.ok) throw apiError(res.status, body);

  if (body?.promptFeedback?.blockReason) {
    throw new AppError("AI_DECLINED", "Gemini declined this brief. Rephrase it and try again.", 422, { reason: body.promptFeedback.blockReason });
  }
  const candidate = body?.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(finish)) {
    const message = finish === "MAX_TOKENS" ? "The draft came out too long. Ask for a shorter email." : "Gemini stopped before finishing this draft. Rephrase the brief and try again.";
    throw new AppError("AI_DECLINED", message, 422, { reason: finish });
  }
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");

  let parsed: z.infer<typeof OutputSchema>;
  try {
    parsed = OutputSchema.parse(JSON.parse(text));
  } catch {
    throw new AppError("AI_BAD_OUTPUT", "Gemini's answer wasn't a usable draft. Try again.", 502);
  }

  const draft = {
    name: parsed.name.replace(/^["']|["']$/g, ""),
    subject: parsed.subject.replace(/\s+/g, " "),
    body: parsed.body.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n"),
  };
  const errors = validateTemplate({ subject: draft.subject, bodyHtml: draft.body });
  if (errors.length) throw new AppError("AI_BAD_OUTPUT", `The draft had a broken merge field (${errors[0]}). Try again.`, 502);

  return { ...draft, warnings: reviewTemplateDraft(draft, ctx.fields, ctx.totalContacts), source: "gemini", model };
}
