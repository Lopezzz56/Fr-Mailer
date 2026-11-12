// Pre-approval review: who will receive it, who won't and why, and what they'll see
import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Split } from "lucide-react";
import type { CampaignReviewDto } from "@shared/types";
import { num, plural } from "../../lib/format";
import { useMailbox } from "../../lib/queries";
import { Panel, Stat } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Callout } from "../ui/Feedback";
import { SelectField } from "../ui/Field";
import { EmailPreview } from "../email/EmailPreview";

function IssueList<T extends { email: string }>({ title, items, render }: { title: string; items: T[]; render: (item: T) => string }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const shown = expanded ? items : items.slice(0, 5);
  return (
    <div>
      <p className="mb-2 text-[13px] font-medium">{title}</p>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {shown.map((i) => (
          <li key={i.email} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
            <span className="truncate">{i.email}</span>
            <span className="shrink-0 text-xs text-ink-subtle">{render(i)}</span>
          </li>
        ))}
      </ul>
      {items.length > 5 && (
        <button className="link mt-2 text-xs" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show fewer" : `Show all ${num(items.length)}`}
        </button>
      )}
    </div>
  );
}

export function ReviewPanel({ review, fromLine }: { review: CampaignReviewDto; fromLine: string }) {
  const [sampleIndex, setSampleIndex] = useState(0);
  const sample = review.sample[sampleIndex] ?? review.sample[0];
  const skipped = review.total - review.ready;
  const mailbox = useMailbox();

  const mailboxEmail = mailbox.data?.data.smtp.fromEmail || mailbox.data?.data.smtp.user || "";
  const mailboxDomain = mailboxEmail.includes("@") ? mailboxEmail.split("@")[1]?.toLowerCase() : "";
  const senderEmailMatch = fromLine.match(/<([^>]+)>/);
  const senderEmail = senderEmailMatch ? senderEmailMatch[1] : fromLine;
  const senderDomain = senderEmail && senderEmail.includes("@") ? senderEmail.split("@")[1]?.toLowerCase() : "";
  const isDomainMismatch = Boolean(mailboxDomain && senderDomain && mailboxDomain !== senderDomain);

  const hasMultiTemplate = (review.templateBreakdown?.length ?? 0) > 1;

  return (
    <div className="space-y-6">
      <Panel title="Recipients" description="Checked against the current template and list. This updates until the campaign is approved.">
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat label="In the list" value={num(review.total)} />
          <Stat label="Will receive it" value={num(review.ready)} tone={review.ready ? "success" : "warning"} />
          <Stat label="Missing information" value={num(review.missingFields.length)} tone={review.missingFields.length ? "warning" : "default"} />
          <Stat label="Suppressed" value={num(review.suppressed.length)} />
        </div>

        {/* Template distribution breakdown */}
        {review.templateBreakdown && review.templateBreakdown.length > 0 && (
          <div className="mt-5 rounded-lg border border-line bg-surface-muted/40 p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <Split className="h-4 w-4 text-brand" />
                <span>Template distribution {hasMultiTemplate ? `(${review.templateBreakdown.length} eligible templates)` : ""}</span>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {review.templateBreakdown.map((tb) => {
                const pct = Math.round((tb.count / Math.max(1, review.ready)) * 100);
                return (
                  <div key={tb.templateId} className="flex flex-col justify-between rounded-md border border-line bg-surface p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-ink truncate" title={tb.templateName}>
                        {tb.templateName}
                        {tb.isFallback && " (Fallback)"}
                      </span>
                      <Badge tone="info">{pct}%</Badge>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-ink-subtle">
                      <span>{plural(tb.count, "recipient")}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-5 space-y-4">
          {review.templateErrors.length > 0 && (
            <Callout tone="danger" title="The template has errors">
              {review.templateErrors.join(" ")}
            </Callout>
          )}
          {review.total === 0 && <Callout tone="warning" title="The list is empty">Add contacts to the list before submitting.</Callout>}
          {review.total > 0 && skipped === 0 && review.templateErrors.length === 0 && (
            <p className="flex items-center gap-2 text-[13px] text-success">
              <CheckCircle2 className="h-4 w-4" /> Every contact in the list can receive this email.
            </p>
          )}
          {skipped > 0 && (
            <Callout tone="warning" title={`${plural(skipped, "contact")} won't receive this email`}>
              They'll be listed as skipped. Fill in missing data or add a fallback in the template to include them.
            </Callout>
          )}
          <div className="grid gap-5 lg:grid-cols-2">
            <IssueList title="Missing information" items={review.missingFields} render={(i) => `missing ${i.fields.join(", ")}`} />
            <IssueList title="Suppressed (won't be emailed)" items={review.suppressed} render={(i) => i.reason.replace("Suppressed: ", "")} />
          </div>
          {review.missingFields.length > 0 && (
            <p className="text-xs text-ink-subtle">
              Fix contact details in <Link to="/contacts" className="link">Contacts</Link>, or add fallbacks in the template.
            </p>
          )}
        </div>
      </Panel>

      {sample && (
        <Panel
          title="Preview"
          description="Personalized for real recipients. An unsubscribe footer is added to every email."
          actions={
            review.sample.length > 1 && (
              <SelectField
                aria-label="Preview recipient"
                value={String(sampleIndex)}
                onChange={(e) => setSampleIndex(Number(e.target.value))}
                options={review.sample.map((s, i) => ({ value: String(i), label: `${s.email}${s.templateName ? ` (${s.templateName})` : ""}` }))}
                className="w-72"
              />
            )
          }
        >
          {/* Explanation of assigned template */}
          {sample.templateName && (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-muted/60 px-3.5 py-2.5 text-xs text-ink-muted">
              <span className="font-semibold text-ink">Selected template:</span>
              <span className="font-medium text-ink">{sample.templateName}</span>
              {sample.assignmentSource && (
                <Badge tone={sample.assignmentSource === "OVERRIDE" ? "brand" : sample.assignmentSource === "RULE" ? "info" : "neutral"}>
                  {sample.assignmentSource === "OVERRIDE" ? "Manual Override" : sample.assignmentSource === "RULE" ? "Targeting Rule" : "Fallback"}
                </Badge>
              )}
              {sample.assignmentReason && (
                <span className="text-ink-subtle ml-auto text-[11px] italic truncate max-w-md" title={sample.assignmentReason}>
                  {sample.assignmentReason}
                </span>
              )}
            </div>
          )}

          {!!sample.attachments?.length && (
            <p className="mb-4 text-xs text-ink-muted">
              Attachments: {sample.attachments.join(", ")}
            </p>
          )}

          {sample.missingFields.length > 0 && <Callout tone="warning" className="mb-4">This contact is missing {sample.missingFields.join(", ")} and won't be sent this email.</Callout>}
          {isDomainMismatch && (
            <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50/80 p-3.5 text-xs text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                <div>
                  <p className="font-semibold text-[13px] text-amber-900 dark:text-amber-300">
                    Sender Domain Protection Active (SpaceMail JFE040011)
                  </p>
                  <p className="mt-1 leading-relaxed text-amber-900/90 dark:text-amber-300/90">
                    The campaign sender is set to <span className="font-mono font-medium">{senderEmail}</span>, while the active SMTP mailbox is authenticated as <span className="font-mono font-medium">{mailboxEmail}</span>.
                    To prevent SpaceMail antispam rejection (554 5.7.1) and protect company domain reputation, the mailer will dispatch via the authenticated mailbox and automatically route all recipient responses to <span className="font-mono font-medium">{senderEmail}</span> via Reply-To.
                  </p>
                </div>
              </div>
            </div>
          )}
          <EmailPreview from={fromLine} to={sample.email} subject={sample.subject} html={sample.html} text={sample.text} />
        </Panel>
      )}
    </div>
  );
}
