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
  const deliveryRate = a.attemptedSends > 0 ? (a.providerAcceptedCount / a.attemptedSends) * 100 : 0;
  const replyOfDelivered = a.providerAcceptedCount > 0 ? (a.repliedCount / a.providerAcceptedCount) * 100 : 0;
  const positiveOfReplied = a.repliedCount > 0 ? ((a.positiveRepliesCount + a.meetingsBookedCount) / a.repliedCount) * 100 : 0;

  const outcome = a.outcomeBreakdown ?? {
    noResponse: Math.max(0, a.providerAcceptedCount - a.repliedCount - a.bouncedCount),
    replied: Math.max(0, a.repliedCount - a.positiveRepliesCount - a.meetingsBookedCount),
    interested: a.positiveRepliesCount,
    notInterested: 0,
    meetingBooked: a.meetingsBookedCount,
    bounced: a.bouncedCount,
    unsubscribed: a.unsubscribedCount,
    pending: Math.max(0, a.totalRecipients - a.providerAcceptedCount),
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
            Recipients
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{num(a.totalRecipients)}</p>
          <p className="mt-1 text-xs text-ink-faint">Assigned to list</p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <Send className="h-3.5 w-3.5 text-brand" />
            Delivered
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{num(a.providerAcceptedCount)}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {a.attemptedSends > 0 ? `${deliveryRate.toFixed(1)}% accepted` : "Awaiting dispatch"}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <MessageSquare className="h-3.5 w-3.5 text-brand" />
            Replies
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{num(a.repliedCount)}</p>
          <p className="mt-1 text-xs text-brand font-medium">
            {a.rates.replyRate}% reply rate
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <ThumbsUp className="h-3.5 w-3.5 text-success" />
            Positive
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-success">
            {num(a.positiveRepliesCount + a.meetingsBookedCount)}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            {a.repliedCount > 0 ? `${positiveOfReplied.toFixed(1)}% of replies` : "0% of replies"}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <AlertTriangle className="h-3.5 w-3.5 text-warning" />
            Bounced
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{num(a.bouncedCount)}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {a.rates.bounceRate}% bounce rate
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
            <UserX className="h-3.5 w-3.5" />
            Unsubscribed
          </div>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{num(a.unsubscribedCount)}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {a.rates.unsubscribeRate}% of delivered
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
            description="Recipients → Provider Accepted → Inbound Replies → Positive Business Outcomes"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="relative rounded-lg border border-line bg-surface-muted/40 p-4">
                <span className="text-xs font-medium text-ink-subtle">1. Audience List</span>
                <p className="mt-1 text-xl font-bold text-ink">{num(a.totalRecipients)}</p>
                <p className="mt-0.5 text-xs text-ink-faint">Target recipients</p>
              </div>

              <div className="relative rounded-lg border border-line bg-surface-muted/40 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-subtle">2. Delivered</span>
                  <span className="text-[11px] font-semibold text-brand">{deliveryRate.toFixed(1)}%</span>
                </div>
                <p className="mt-1 text-xl font-bold text-ink">{num(a.providerAcceptedCount)}</p>
                <p className="mt-0.5 text-xs text-ink-faint">Provider accepted</p>
              </div>

              <div className="relative rounded-lg border border-line bg-surface-muted/40 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-subtle">3. Replied</span>
                  <span className="text-[11px] font-semibold text-brand">{replyOfDelivered.toFixed(1)}%</span>
                </div>
                <p className="mt-1 text-xl font-bold text-ink">{num(a.repliedCount)}</p>
                <p className="mt-0.5 text-xs text-ink-faint">Inbound responses</p>
              </div>

              <div className="relative rounded-lg border border-line bg-surface-muted/40 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-subtle">4. Positive Outcome</span>
                  <span className="text-[11px] font-semibold text-success">{positiveOfReplied.toFixed(1)}%</span>
                </div>
                <p className="mt-1 text-xl font-bold text-success">{num(a.positiveRepliesCount + a.meetingsBookedCount)}</p>
                <p className="mt-0.5 text-xs text-ink-faint">Interested or booked</p>
              </div>
            </div>
          </Panel>

          {/* Recipient Outcome Breakdown */}
          <Panel
            title="Recipient Outcome Breakdown"
            description="Outcome status distribution across all contacts assigned to this campaign."
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
                      <th className="px-4 py-2.5 text-right">Sent</th>
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
                        <td className="px-4 py-3 text-right">{num(s.sentCount)}</td>
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
