// "Write it for me": draft a template with Gemini, paste a draft from ChatGPT/Claude, or pick a starter.
// Either way the result lands in the editor for a person to review; nothing is saved here.
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  HelpCircle,
  RefreshCw,
  Sparkles,
  Wand2,
} from "lucide-react";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useWriterContext } from "../../lib/queries";
import { Drawer } from "../ui/Overlay";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { Checkbox, ChoiceCard, SelectField, TextAreaField, TextField } from "../ui/Field";
import { Callout } from "../ui/Feedback";
import { FilterChips } from "../ui/Navigation";
import { Skeleton } from "../ui/Spinner";
import {
  STARTER_GOALS,
  WRITER_LENGTHS,
  WRITER_TONES,
  buildStarterTemplate,
  convertPersonalDraftToTemplate,
  reviewTemplateDraft,
  type ConvertedPersonalDraft,
  type StarterGoal,
  type TemplateDraftDto,
  type TemplateDraftRequest,
  type WriterLength,
  type WriterTone,
} from "@shared/template-writer";

const BRIEF_IDEAS = [
  "Reach out to hotel leadership about Mise Hotel service execution platform and advisory board pilot",
  "Propose co-marketing partnership between FocusRealm and hospitality training or recruitment platforms",
  "Ask general managers for a 20-minute introductory meeting on SOP task verification",
];

const SAMPLE_AI_DRAFT = `Subject: Exploring partnership with [Company Name]

Hi [First Name],

I hope this email finds you well. I've been following [Company Name]'s hospitality work and admire what your team has built.

At FocusRealm, we are building Mise Hotel, a hospitality Service Execution Platform that helps teams translate corporate SOPs and service standards into verified frontline tasks.

Given [Company Name]'s leadership in the industry, we see an exciting opportunity to collaborate on an exploratory [Initiative] combining your team's expertise with our execution platform.

Would you have 15-20 minutes next week for a brief exploratory discussion with our Founder, Sehej Sharma?

Best regards,
[Your Name]
Founder's Office, FocusRealm`;

const toneOptions = Object.entries(WRITER_TONES).map(([value, label]) => ({ value, label }));

/** Body text with merge fields highlighted */
function MergeText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\{\{[^{}]*\}\})/g).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="rounded bg-brand-soft px-1 py-0.5 font-medium text-brand-ink dark:bg-brand/20 dark:text-blue-300">
            {part}
          </span>
        ) : (
          part
        )
      )}
    </>
  );
}

function DraftPreview({
  draft,
  converted,
}: {
  draft: TemplateDraftDto;
  converted?: ConvertedPersonalDraft | null;
}) {
  return (
    <div className="animate-fade-in space-y-3">
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
        <div className="border-b border-line bg-surface-muted/60 px-4 py-2.5">
          <p className="text-2xs font-semibold uppercase tracking-wider text-ink-faint">Subject Line</p>
          <p className="mt-0.5 text-[14px] font-semibold text-ink">
            <MergeText text={draft.subject} />
          </p>
        </div>
        <div className="max-h-[300px] overflow-y-auto whitespace-pre-wrap px-4 py-3.5 text-[13px] leading-relaxed text-ink">
          <MergeText text={draft.body} />
        </div>

        {draft.warnings.length > 0 && (
          <div className="border-t border-line bg-warning-soft/40 px-4 py-3">
            <p className="mb-1 text-xs font-semibold text-warning">Notice before sending</p>
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-muted">
              {draft.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {converted && converted.rules.length > 0 && (
        <div className="rounded-xl border border-line bg-surface-muted/40 p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-ink uppercase tracking-wider">
              Mail Merge Rule Compliance
            </p>
            <span className="text-2xs text-ink-subtle">
              {converted.rules.filter((r) => r.passed).length} of {converted.rules.length} verified
            </span>
          </div>

          <div className="grid gap-2">
            {converted.rules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-start gap-2.5 rounded-lg border border-line/60 bg-surface px-3 py-2 text-xs"
              >
                {rule.passed ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success mt-0.5" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <span className="font-semibold text-ink">{rule.label}:</span>{" "}
                  <span className="text-ink-muted leading-relaxed">{rule.message}</span>
                </div>
              </div>
            ))}
          </div>

          {converted.convertedPlaceholders.length > 0 && (
            <div className="mt-2 pt-2 border-t border-line/70 text-2xs text-ink-subtle flex flex-wrap items-center gap-1.5">
              <span className="font-medium text-ink">Converted tokens:</span>
              {converted.convertedPlaceholders.map((p, idx) => (
                <span key={idx} className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-ink-muted">
                  {p.original} &rarr; {p.replacement}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TemplateWriter({
  open,
  onClose,
  currentDraft,
  initialTab = "personal",
  onUse,
}: {
  open: boolean;
  onClose: () => void;
  /** The editor's plain-text draft, offered as an example */
  currentDraft: { subject: string; body: string } | null;
  initialTab?: "personal" | "ai" | "starter";
  onUse: (draft: TemplateDraftDto) => void;
}) {
  const { user } = useAuth();
  const context = useWriterContext(open);
  const aiEnabled = context.data?.data.aiEnabled ?? false;
  const fields = context.data?.data.fields ?? [];
  const totalContacts = context.data?.data.totalContacts ?? 0;

  const [tab, setTab] = useState<"personal" | "ai" | "starter" | null>(initialTab);
  const activeTab = tab ?? initialTab;

  // Personal AI Draft State
  const [personalInput, setPersonalInput] = useState("");
  const [showFormatHelp, setShowFormatHelp] = useState(false);

  // AI Prompt State
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState<WriterTone>("warm");
  const [length, setLength] = useState<WriterLength>("medium");
  const [learnFromDraft, setLearnFromDraft] = useState(false);
  const [example, setExample] = useState("");
  const [signOff, setSignOff] = useState(user?.name ?? "");
  const [goal, setGoal] = useState<StarterGoal>("mise_pilot");

  const hasDraft = Boolean(currentDraft && currentDraft.body.replace(/\{\{[^}]*\}\}|Hi|Best|[\s,]/g, "").length > 40);

  const draftMutation = useMutation({
    mutationFn: () => {
      const examples = [
        learnFromDraft && currentDraft ? `Subject: ${currentDraft.subject}\n\n${currentDraft.body}` : "",
        example.trim(),
      ].filter(Boolean);
      const body: TemplateDraftRequest = {
        brief,
        tone,
        length,
        signOff: signOff.trim() || undefined,
        example: examples.join("\n\n---\n\n") || undefined,
      };
      return api.post<TemplateDraftDto>("/api/templates/ai/draft", body);
    },
  });

  // Converted Personal AI Draft Result
  const convertedPersonal = useMemo<ConvertedPersonalDraft | null>(() => {
    if (!personalInput.trim() || personalInput.trim().length < 20) return null;
    return convertPersonalDraftToTemplate(personalInput, fields, totalContacts, {
      signOff: signOff.trim() || user?.name || "Founder’s Office",
    });
  }, [personalInput, fields, totalContacts, signOff, user?.name]);

  const convertedAsDto = useMemo<TemplateDraftDto | null>(() => {
    if (!convertedPersonal) return null;
    return {
      name: convertedPersonal.name,
      subject: convertedPersonal.subject,
      body: convertedPersonal.body,
      warnings: convertedPersonal.warnings,
      source: "bot",
      model: "FocusRealm Ingestion Engine",
    };
  }, [convertedPersonal]);

  const starter = useMemo(() => {
    const t = buildStarterTemplate({ goal, tone, fields, signOff });
    return { ...t, warnings: reviewTemplateDraft(t, fields, totalContacts) };
  }, [goal, tone, fields, signOff, totalContacts]);

  // Current result depending on tab
  const result: TemplateDraftDto | null =
    activeTab === "personal"
      ? convertedAsDto
      : activeTab === "ai"
      ? draftMutation.data?.data ?? null
      : starter;

  const briefTooShort = brief.trim().length < 10;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="lg"
      title="Template Assistant"
      subtitle="Paste drafts from personal AI, write with Gemini, or pick a starter template."
      footer={
        <div className="flex w-full flex-col-reverse sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
          <Button variant="ghost" onClick={onClose} className="w-full sm:w-auto">
            Cancel
          </Button>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            {activeTab === "ai" && aiEnabled && (
              <Button
                variant={result ? "secondary" : "primary"}
                icon={result ? <RefreshCw className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                loading={draftMutation.isPending}
                disabled={briefTooShort}
                onClick={() => draftMutation.mutate()}
                className="w-full sm:w-auto"
              >
                {result ? "Try again" : "Generate draft"}
              </Button>
            )}
            {result && (
              <Button
                variant="primary"
                disabled={draftMutation.isPending}
                onClick={() => {
                  onUse(result);
                  onClose();
                }}
                className="w-full sm:w-auto"
              >
                Use this template
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <FilterChips
          label="Drafting mode"
          value={activeTab}
          onChange={(val) => setTab(val as "personal" | "ai" | "starter")}
          options={[
            { key: "personal", label: "Paste Personal AI Draft" },
            { key: "ai", label: "Generate with AI" },
            { key: "starter", label: "Starter templates" },
          ]}
        />

        {context.isPending && <Skeleton className="h-40 w-full" />}
        {context.isError && <Callout tone="danger">{errorMessage(context.error)}</Callout>}

        {/* ----------------- TAB 1: PASTE PERSONAL AI DRAFT ----------------- */}
        {activeTab === "personal" && (
          <div className="space-y-4">
            <div className="rounded-xl border border-brand/20 bg-brand-soft/40 p-4 text-xs text-ink leading-relaxed dark:border-brand/30 dark:bg-brand/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-bold text-brand-ink dark:text-blue-300">
                  <ClipboardPaste className="h-4 w-4" />
                  <span>Paste drafts from ChatGPT, Claude, or Perplexity</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowFormatHelp((v) => !v)}
                  className="inline-flex items-center gap-1 font-semibold text-brand hover:underline"
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                  <span>{showFormatHelp ? "Hide Format Guide" : "Format Guide & AI Prompt"}</span>
                  {showFormatHelp ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
              </div>
              <p className="mt-1.5 text-ink-muted">
                FocusRealm standardizes your draft into <span className="font-semibold text-ink">one single email</span>, converts tags (e.g. <span className="font-mono">{"{{first_name}}"}</span>, <span className="font-mono">[Company]</span>), and verifies fallback safety against your contacts.
              </p>

              {/* Collapsible Format Guide and AI Prompt Helper */}
              {showFormatHelp && (
                <div className="mt-3.5 border-t border-brand/20 pt-3 space-y-3">
                  <div>
                    <span className="font-bold text-ink flex items-center gap-1.5">
                      1. Best Format for Pasting
                    </span>
                    <p className="mt-0.5 text-ink-muted">
                      Start with a subject line, followed by the email body. Double curly braces or square brackets are both supported:
                    </p>
                    <div className="mt-1.5 rounded-lg border border-line bg-surface p-2.5 font-mono text-[11px] text-ink leading-normal select-all">
                      Subject: Collaboration with {"{{company|your team}}"}<br /><br />
                      Hi {"{{firstName|there}}"},<br /><br />
                      I came across {"{{company}}"} and wanted to reach out regarding...<br /><br />
                      Best regards,<br />
                      Sehej
                    </div>
                  </div>

                  <div>
                    <span className="font-bold text-ink">
                      2. Supported Fields &amp; Built-in Merges
                    </span>
                    <div className="mt-1 grid grid-cols-2 gap-1.5 text-[11px]">
                      <div>• <code className="rounded bg-surface px-1 font-semibold">{"{{firstName|there}}"}</code> or <code className="rounded bg-surface px-1">{"{{first_name}}"}</code></div>
                      <div>• <code className="rounded bg-surface px-1 font-semibold">{"{{company|your team}}"}</code> or <code className="rounded bg-surface px-1">{"{{company_name}}"}</code></div>
                      <div>• <code className="rounded bg-surface px-1 font-semibold">{"{{lastName|}}"}</code> / <code className="rounded bg-surface px-1">{"{{fullName}}"}</code></div>
                      <div>• <code className="rounded bg-surface px-1 font-semibold">{"{{title|leadership}}"}</code> / <code className="rounded bg-surface px-1">{"{{role}}"}</code></div>
                      <div>• <code className="rounded bg-surface px-1 font-semibold">{"{{phone}}"}</code> / <code className="rounded bg-surface px-1">{"{{email}}"}</code></div>
                      <div>• <code className="rounded bg-surface px-1 font-semibold">{"{{partnerStrength}}"}</code> / <code className="rounded bg-surface px-1">{"{{whatItDoes}}"}</code></div>
                    </div>
                    <p className="mt-1 text-[11px] text-ink-subtle">
                      <strong>Tip:</strong> Always use a pipe for fallbacks (<code className="rounded bg-surface px-1">{"{{field|fallback}}"}</code>) so contacts with missing data aren&apos;t skipped.
                    </p>
                  </div>

                  <div>
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-ink">
                        3. Prompt for ChatGPT / Claude (Copy &amp; Paste to your AI):
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const promptText = `Write a concise cold outreach email for FocusRealm Mail Merge.\n\nFormatting instructions:\n- Start with "Subject: <subject line>"\n- Use merge tags with fallback syntax: {{firstName|there}} for recipient name and {{company|your team}} for recipient company.\n- Keep it under 120 words with 1 clear call-to-action.\n- Do not include conversational greeting or explanation before/after the email.`;
                          navigator.clipboard.writeText(promptText);
                        }}
                        className="text-[11px] font-semibold text-brand hover:underline"
                      >
                        Copy Prompt
                      </button>
                    </div>
                    <div className="mt-1 rounded-lg border border-line bg-surface p-2 text-[11px] text-ink-muted italic select-all">
                      &quot;Write a concise cold outreach email. Start with &apos;Subject: ...&apos;. Use merge tags with fallback syntax: {"{{firstName|there}}"} and {"{{company|your team}}"}. Keep it under 120 words with 1 clear call to action. Do not include conversational commentary.&quot;
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[13px] font-semibold text-ink">
                  Paste your draft text
                </label>
                {!personalInput && (
                  <button
                    type="button"
                    onClick={() => setPersonalInput(SAMPLE_AI_DRAFT)}
                    className="text-xs font-semibold text-brand hover:underline inline-flex items-center gap-1"
                  >
                    <Bot className="h-3 w-3" /> Insert sample ChatGPT draft
                  </button>
                )}
              </div>
              <TextAreaField
                aria-label="Paste AI Draft"
                value={personalInput}
                onChange={(e) => setPersonalInput(e.target.value)}
                rows={7}
                maxLength={8000}
                placeholder="Paste the raw output from ChatGPT or Claude here, including 'Subject:' and body..."
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Sign off name"
                optional
                value={signOff}
                onChange={(e) => setSignOff(e.target.value)}
                placeholder="e.g. Frank Lopes / Founder's Office"
                maxLength={200}
              />
              <div className="flex flex-col justify-end">
                <p className="text-2xs text-ink-subtle">
                  Matching against {fields.length} contact fields ({totalContacts.toLocaleString()} contacts).
                </p>
              </div>
            </div>

            {convertedPersonal && convertedAsDto && (
              <div className="space-y-2 pt-2">
                <div className="flex items-center gap-2">
                  <Badge tone="brand">
                    <CheckCircle2 className="mr-1 inline h-3 w-3" />
                    Standardized Single Email
                  </Badge>
                  <span className="text-xs text-ink-faint">Ready for editor</span>
                </div>
                <DraftPreview draft={convertedAsDto} converted={convertedPersonal} />
              </div>
            )}
          </div>
        )}

        {/* ----------------- TAB 2: WRITE WITH AI ----------------- */}
        {activeTab === "ai" && !aiEnabled && context.isSuccess && (
          <Callout
            tone="info"
            title="Gemini AI writing is not configured"
            action={<Button size="sm" onClick={() => setTab("personal")}>Paste personal draft</Button>}
          >
            A founder can enable generative writing by adding a Google Gemini API key (<span className="font-mono">GEMINI_API_KEY</span>) to server settings. You can still paste any draft from ChatGPT or Claude in the first tab!
          </Callout>
        )}

        {activeTab === "ai" && aiEnabled && context.isSuccess && (
          <>
            <div>
              <TextAreaField
                label="What should this email do?"
                hint="Who it's for, what you offer, and what you'd like them to do. Plain words are fine."
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="e.g. Introduce our revenue-management service to boutique hotels in Goa and ask for a 15-minute call next week."
              />
              {!brief && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {BRIEF_IDEAS.map((idea) => (
                    <button
                      key={idea}
                      type="button"
                      onClick={() => setBrief(idea)}
                      className="rounded-full border border-line bg-surface-muted px-2.5 py-1 text-xs text-ink-muted hover:border-brand hover:bg-brand-soft hover:text-brand-ink"
                    >
                      {idea}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField
                label="Tone"
                value={tone}
                onChange={(e) => setTone(e.target.value as WriterTone)}
                options={toneOptions}
              />
              <SelectField
                label="Length"
                hint={WRITER_LENGTHS[length].words}
                value={length}
                onChange={(e) => setLength(e.target.value as WriterLength)}
                options={Object.entries(WRITER_LENGTHS).map(([value, l]) => ({ value, label: l.label }))}
              />
              <TextField
                label="Sign off as"
                optional
                value={signOff}
                onChange={(e) => setSignOff(e.target.value)}
                placeholder="Your name"
                maxLength={200}
              />
            </div>
            <div className="space-y-3 rounded-lg border border-line bg-surface-muted/60 p-4">
              <p className="text-[13px] font-medium">
                Show it an example <span className="font-normal text-ink-subtle">(optional)</span>
              </p>
              {hasDraft && (
                <Checkbox
                  label="Learn from my current draft"
                  description="Keeps your structure and voice, and improves the wording."
                  checked={learnFromDraft}
                  onChange={(e) => setLearnFromDraft(e.target.checked)}
                />
              )}
              <TextAreaField
                aria-label="Example email"
                value={example}
                onChange={(e) => setExample(e.target.value)}
                rows={3}
                maxLength={6000}
                placeholder="Paste an email you liked, even a rough one."
              />
            </div>
            <p className="text-xs text-ink-subtle">
              Sent to Google Gemini: your brief, the example and the names of your contact fields
              {totalContacts ? ` (${totalContacts.toLocaleString()} contacts)` : ""}. Contact details never leave FocusRealm.
            </p>
            {draftMutation.isError && (
              <Callout tone="danger" title="No draft this time">
                {errorMessage(draftMutation.error)}
              </Callout>
            )}
            {draftMutation.isPending && (
              <div className="space-y-2 rounded-lg border border-line p-4" role="status" aria-label="Writing draft">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            )}
            {!draftMutation.isPending && result && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge tone="brand">
                    <Wand2 className="mr-1 inline h-3 w-3" />
                    Draft
                  </Badge>
                  {draftMutation.data?.data.model && (
                    <span className="text-xs text-ink-faint">{draftMutation.data.data.model}</span>
                  )}
                </div>
                <DraftPreview draft={result} />
              </div>
            )}
          </>
        )}

        {/* ----------------- TAB 3: STARTER TEMPLATES ----------------- */}
        {activeTab === "starter" && context.isSuccess && (
          <>
            <div className="grid gap-2.5 sm:grid-cols-2">
              {(Object.keys(STARTER_GOALS) as StarterGoal[]).map((g) => (
                <ChoiceCard
                  key={g}
                  name="starterGoal"
                  value={g}
                  checked={goal === g}
                  onSelect={() => setGoal(g)}
                  title={STARTER_GOALS[g].label}
                  description={STARTER_GOALS[g].description}
                />
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Tone"
                value={tone}
                onChange={(e) => setTone(e.target.value as WriterTone)}
                options={toneOptions}
              />
              <TextField
                label="Sign off as"
                optional
                value={signOff}
                onChange={(e) => setSignOff(e.target.value)}
                placeholder="Your name"
                maxLength={200}
              />
            </div>
            <p className="text-xs text-ink-subtle">
              Built from the fields your contacts have{fields.some((f) => f.custom && f.coverage > 0) ? ", including your custom ones" : ""}. Edit the wording to make it yours.
            </p>
            <DraftPreview draft={starter} />
          </>
        )}
      </div>
    </Drawer>
  );
}
