import { Users, Send, MessageSquare, ThumbsUp, AlertTriangle, UserX, TrendingUp } from "lucide-react";
import { useCampaignAnalytics } from "../../lib/queries";
import { num } from "../../lib/format";
import { Panel } from "../ui/Card";
import { PageLoader } from "../ui/Spinner";
import { ErrorState } from "../ui/Feedback";

interface Props {
  campaignId: string;
}

export function CampaignAnalyticsPanel({ campaignId }: Props) {
  const { data, isPending, isError, error, refetch } = useCampaignAnalytics(campaignId);

  if (isPending) return <PageLoader label="Loading campaign performance analytics…" />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  const a = data?.data;
  if (!a) return null;

  const hasActivity = a.attemptedSends > 0 || a.providerAcceptedCount > 0;
  const uniqueReached = a.uniqueReachedCount ?? a.providerAcceptedCount;
  const totalSends = a.totalSends ?? a.attemptedSends;
  const deliveryRate = a.attemptedSends > 0 ? (a.providerAcceptedCount / a.attemptedSends) * 100 : 0;
  const replyOfReached = uniqueReached > 0 ? (a.repliedCount / uniqueReached) * 100 : 0;
  const positiveTotal = a.positiveRepliesCount + a.meetingsBookedCount;
  const positiveOfReplied = a.repliedCount > 0 ? (positiveTotal / a.repliedCount) * 100 : 0;

  const outcome = a.outcomeBreakdown ?? {
    noResponse: Math.max(0, uniqueReached - a.repliedCount - a.bouncedCount),
    replied: Math.max(0, a.repliedCount - a.positiveRepliesCount - a.meetingsBookedCount),
    interested: a.positiveRepliesCount,
    notInterested: 0,
    meetingBooked: a.meetingsBookedCount,
    bounced: a.bouncedCount,
    unsubscribed: a.unsubscribedCount,
    pending: Math.max(0, a.totalRecipients - uniqueReached),
  };

  const totalOutcomeSample = Math.max(
    1,
    outcome.meetingBooked +
      outcome.interested +
      outcome.replied +
      outcome.notInterested +
      outcome.noResponse +
      outcome.bounced +
      outcome.unsubscribed +
      outcome.pending
  );

  return (
    <div className="space-y-6">
      {/* Top Level KPIs */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <Users className="h-3.5 w-3.5" />
            Unique Recipients
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{num(a.totalRecipients)}</p>
          <p className="mt-1 text-xs text-ink-faint">{num(totalSends)} scheduled touches</p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <Send className="h-3.5 w-3.5 text-brand" />
            Sent / Accepted
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{num(a.providerAcceptedCount)}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {a.attemptedSends > 0 ? `${num(uniqueReached)} recipients reached · ${deliveryRate.toFixed(1)}%` : "Awaiting dispatch"}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <MessageSquare className="h-3.5 w-3.5 text-brand" />
            Unique Repliers
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{num(a.repliedCount)}</p>
          <p className="mt-1 text-xs text-brand font-medium">
            {a.rates.replyRate}% of reached
            {a.totalInboundMessages && a.totalInboundMessages > a.repliedCount ? ` · ${num(a.totalInboundMessages)} msgs` : ""}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <ThumbsUp className="h-3.5 w-3.5 text-success" />
            Positive Outcomes
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-success">
            {num(positiveTotal)}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            {a.repliedCount > 0 ? `${positiveOfReplied.toFixed(1)}% of repliers` : "0% of repliers"}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <AlertTriangle className="h-3.5 w-3.5 text-warning" />
            Bounced
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{num(a.bouncedCount)}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {a.rates.bounceRate}% of reached
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <UserX className="h-3.5 w-3.5" />
            Unsubscribed
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{num(a.unsubscribedCount)}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {a.rates.unsubscribeRate}% of reached
          </p>
        </div>
      </div>

      {!hasActivity && (
        <Panel>
          <div className="py-8 text-center">
            <TrendingUp className="mx-auto h-8 w-8 text-ink-subtle/50" />
            <h3 className="mt-3 text-sm font-semibold text-ink">No outreach activity yet</h3>
            <p className="mx-auto mt-1 max-w-md text-xs text-ink-subtle">
              Once this campaign is approved and starts sending, performance metrics, conversion funnels, follow-up touch comparisons, and outcome distribution will populate here automatically.
            </p>
          </div>
        </Panel>
      )}

      {hasActivity && (
        <>
          {/* Conversion Funnel */}
          <Panel
            title="Conversion Funnel"
            description="Unique Recipients → Recipients Reached (Sent / Provider Accepted) → Unique Repliers → Positive Conversations"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="relative rounded-lg border border-line bg-surface-muted/40 p-4">
                <span className="text-xs font-medium text-ink-subtle">1. Unique Recipients</span>
                <p className="mt-1 text-xl font-bold text-ink">{num(a.totalRecipients)}</p>
                <p className="mt-0.5 text-xs text-ink-faint">{num(totalSends)} email touches</p>
              </div>

              <div className="relative rounded-lg border border-line bg-surface-muted/40 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-subtle">2. Recipients Reached</span>
                  <span className="text-[11px] font-semibold text-brand">
                    {a.totalRecipients > 0 ? ((uniqueReached / a.totalRecipients) * 100).toFixed(1) : "0.0"}%
                  </span>
                </div>
                <p className="mt-1 text-xl font-bold text-ink">{num(uniqueReached)}</p>
                <p className="mt-0.5 text-xs text-ink-faint">{num(a.providerAcceptedCount)} Sent / Provider Accepted</p>
              </div>

              <div className="relative rounded-lg border border-line bg-surface-muted/40 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-subtle">3. Unique Repliers</span>
                  <span className="text-[11px] font-semibold text-brand">{replyOfReached.toFixed(1)}%</span>
                </div>
                <p className="mt-1 text-xl font-bold text-ink">{num(a.repliedCount)}</p>
                <p className="mt-0.5 text-xs text-ink-faint">Unique people who replied</p>
              </div>

              <div className="relative rounded-lg border border-line bg-surface-muted/40 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-subtle">4. Positive Outcome</span>
                  <span className="text-[11px] font-semibold text-success">{positiveOfReplied.toFixed(1)}%</span>
                </div>
                <p className="mt-1 text-xl font-bold text-success">{num(positiveTotal)}</p>
                <p className="mt-0.5 text-xs text-ink-faint">{num(a.meetingsBookedCount)} meetings booked</p>
              </div>
            </div>
          </Panel>

          {/* Recipient Outcome Breakdown */}
          <Panel
            title="Unique Recipient Outcome Breakdown"
            description={`Canonical relationship outcome across all ${num(a.totalRecipients)} unique recipients (never double-counted by follow-up steps).`}
          >
            {/* Horizontal Distribution Bar */}
            <div className="h-3 w-full overflow-hidden rounded-full bg-surface-sunken flex">
              {outcome.meetingBooked > 0 && (
                <div
                  style={{ width: `${(outcome.meetingBooked / totalOutcomeSample) * 100}%` }}
                  className="bg-brand h-full"
                  title={`Meeting Booked: ${outcome.meetingBooked}`}
                />
              )}
              {outcome.interested > 0 && (
                <div
                  style={{ width: `${(outcome.interested / totalOutcomeSample) * 100}%` }}
                  className="bg-success h-full"
                  title={`Interested: ${outcome.interested}`}
                />
              )}
              {outcome.replied > 0 && (
                <div
                  style={{ width: `${(outcome.replied / totalOutcomeSample) * 100}%` }}
                  className="bg-sky-400 h-full"
                  title={`General Reply: ${outcome.replied}`}
                />
              )}
              {outcome.notInterested > 0 && (
                <div
                  style={{ width: `${(outcome.notInterested / totalOutcomeSample) * 100}%` }}
                  className="bg-amber-400 h-full"
                  title={`Not Interested: ${outcome.notInterested}`}
                />
              )}
              {outcome.noResponse > 0 && (
                <div
                  style={{ width: `${(outcome.noResponse / totalOutcomeSample) * 100}%` }}
                  className="bg-slate-300 h-full"
                  title={`No Response: ${outcome.noResponse}`}
                />
              )}
              {outcome.bounced > 0 && (
                <div
                  style={{ width: `${(outcome.bounced / totalOutcomeSample) * 100}%` }}
                  className="bg-rose-400 h-full"
                  title={`Bounced: ${outcome.bounced}`}
                />
              )}
              {outcome.unsubscribed > 0 && (
                <div
                  style={{ width: `${(outcome.unsubscribed / totalOutcomeSample) * 100}%` }}
                  className="bg-neutral-400 h-full"
                  title={`Unsubscribed: ${outcome.unsubscribed}`}
                />
              )}
              {outcome.pending > 0 && (
                <div
                  style={{ width: `${(outcome.pending / totalOutcomeSample) * 100}%` }}
                  className="bg-neutral-200 h-full"
                  title={`Pending: ${outcome.pending}`}
                />
              )}
            </div>

            {/* Outcome Legend Grid */}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-brand shrink-0" />
                <span className="text-ink-subtle">Meeting Booked:</span>
                <span className="font-semibold text-ink">{num(outcome.meetingBooked)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-success shrink-0" />
                <span className="text-ink-subtle">Interested:</span>
                <span className="font-semibold text-ink">{num(outcome.interested)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-sky-400 shrink-0" />
                <span className="text-ink-subtle">General Reply:</span>
                <span className="font-semibold text-ink">{num(outcome.replied)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-400 shrink-0" />
                <span className="text-ink-subtle">Not Interested:</span>
                <span className="font-semibold text-ink">{num(outcome.notInterested)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-slate-300 shrink-0" />
                <span className="text-ink-subtle">No Response:</span>
                <span className="font-semibold text-ink">{num(outcome.noResponse)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-400 shrink-0" />
                <span className="text-ink-subtle">Bounced:</span>
                <span className="font-semibold text-ink">{num(outcome.bounced)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-neutral-400 shrink-0" />
                <span className="text-ink-subtle">Unsubscribed:</span>
                <span className="font-semibold text-ink">{num(outcome.unsubscribed)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-neutral-200 shrink-0" />
                <span className="text-ink-subtle">Pending:</span>
                <span className="font-semibold text-ink">{num(outcome.pending)}</span>
              </div>
            </div>
          </Panel>

          {/* Sequence Step Performance Comparison */}
          {a.bySequenceStep && a.bySequenceStep.length > 0 && (
            <Panel
              title="Sequence Step Performance"
              description="Comparison of performance across initial email and follow-up touches."
              flush
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-line bg-surface-muted/50 text-ink-subtle font-medium">
                    <tr>
                      <th className="px-4 py-2.5">Step</th>
                      <th className="px-4 py-2.5">Purpose</th>
                      <th className="px-4 py-2.5 text-right">Recipients Reached</th>
                      <th className="px-4 py-2.5 text-right">Emails Sent</th>
                      <th className="px-4 py-2.5 text-right">Replies</th>
                      <th className="px-4 py-2.5 text-right">Reply Rate</th>
                      <th className="px-4 py-2.5 text-right">Positive</th>
                      <th className="px-4 py-2.5 text-right">Bounced</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line text-ink">
                    {a.bySequenceStep.map((s) => (
                      <tr key={s.stepIndex} className="hover:bg-surface-muted/30">
                        <td className="px-4 py-3 font-semibold">
                          {s.stepIndex === 0 ? "Initial (Day 0)" : `Follow-up ${s.stepIndex}`}
                        </td>
                        <td className="px-4 py-3 text-ink-subtle">{s.purpose}</td>
                        <td className="px-4 py-3 text-right font-medium">{num(s.recipientsReached ?? s.sentCount)}</td>
                        <td className="px-4 py-3 text-right text-ink-muted">{num(s.sentCount)}</td>
                        <td className="px-4 py-3 text-right font-medium">{num(s.repliedCount)}</td>
                        <td className="px-4 py-3 text-right font-semibold text-brand">
                          {s.replyRate.toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 text-right text-success font-medium">
                          {num(s.positiveRepliesCount + s.meetingsBookedCount)}
                        </td>
                        <td className="px-4 py-3 text-right text-ink-subtle">{num(s.bouncedCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {/* Template Comparison Table (if more than 1 template) */}
          {a.byTemplate && a.byTemplate.length > 1 && (
            <Panel
              title="Template Comparison"
              description="Performance across different templates or version variants."
              flush
            >
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-line bg-surface-muted/50 text-ink-subtle font-medium">
                    <tr>
                      <th className="px-4 py-2.5">Template</th>
                      <th className="px-4 py-2.5">Version</th>
                      <th className="px-4 py-2.5 text-right">Assigned</th>
                      <th className="px-4 py-2.5 text-right">Sent</th>
                      <th className="px-4 py-2.5 text-right">Replies</th>
                      <th className="px-4 py-2.5 text-right">Reply Rate</th>
                      <th className="px-4 py-2.5 text-right">Positive</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line text-ink">
                    {a.byTemplate.map((t) => (
                      <tr key={t.templateId} className="hover:bg-surface-muted/30">
                        <td className="px-4 py-3 font-medium">{t.templateName}</td>
                        <td className="px-4 py-3 text-ink-subtle">v{t.templateVersion}</td>
                        <td className="px-4 py-3 text-right">{num(t.assignedCount)}</td>
                        <td className="px-4 py-3 text-right">{num(t.sentCount)}</td>
                        <td className="px-4 py-3 text-right font-medium">{num(t.repliedCount)}</td>
                        <td className="px-4 py-3 text-right font-semibold text-brand">
                          {(t.replyRate ?? 0).toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 text-right text-success font-medium">
                          {num(t.positiveRepliesCount + t.meetingsBookedCount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {/* Activity Timeline */}
          {a.timeline && a.timeline.length > 0 && (
            <Panel
              title="Daily Activity Timeline"
              description="Outreach volume, replies, and bounces recorded per calendar day."
              flush
            >
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 border-b border-line bg-surface-muted text-ink-subtle font-medium">
                    <tr>
                      <th className="px-4 py-2.5">Date</th>
                      <th className="px-4 py-2.5 text-right">Emails Sent</th>
                      <th className="px-4 py-2.5 text-right">Replies Received</th>
                      <th className="px-4 py-2.5 text-right">Bounces</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line text-ink">
                    {a.timeline.map((row) => (
                      <tr key={row.date} className="hover:bg-surface-muted/30">
                        <td className="px-4 py-2.5 font-mono text-ink-subtle">{row.date}</td>
                        <td className="px-4 py-2.5 text-right font-medium">{num(row.sent)}</td>
                        <td className="px-4 py-2.5 text-right text-brand font-semibold">{num(row.replied)}</td>
                        <td className="px-4 py-2.5 text-right text-ink-subtle">{num(row.bounced)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
