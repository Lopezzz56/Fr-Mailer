import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Inbox,
  Mail,
  MessageSquare,
  Play,
  Plus,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { useMailbox, useOverview, useWorkspaceQueue } from "../lib/queries";
import { useTitle } from "../lib/hooks";
import { num, plural, timeAgo } from "../lib/format";
import { PageHeader } from "../components/ui/Navigation";
import { Panel } from "../components/ui/Card";
import { ButtonLink } from "../components/ui/Button";
import { CampaignStatusBadge } from "../components/ui/Badge";
import { ErrorState } from "../components/ui/Feedback";
import { PageLoader } from "../components/ui/Spinner";
import type { MailboxStatusDto } from "@shared/types";

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

function ReplyClassificationBadge({ classification }: { classification?: string | null }) {
  if (!classification) {
    return <span className="rounded bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-subtle">Reply</span>;
  }
  const upper = classification.toUpperCase();
  if (upper === "POSITIVE" || upper === "INTERESTED") {
    return (
      <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
        Interested / Positive
      </span>
    );
  }
  if (upper === "QUESTION") {
    return (
      <span className="rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
        Question
      </span>
    );
  }
  if (upper === "OUT_OF_OFFICE") {
    return (
      <span className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
        Out of Office
      </span>
    );
  }
  if (upper === "NEGATIVE" || upper === "NOT_INTERESTED") {
    return (
      <span className="rounded border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
        Not Interested
      </span>
    );
  }
  return <span className="rounded bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-subtle">Reply</span>;
}

function mailboxProblems(status?: MailboxStatusDto): string[] {
  if (!status) return [];
  const problems: string[] = [];
  if (!status.smtp.configured) problems.push("Sending mailbox is not configured.");
  if (!status.liveSendingEnabled && status.liveSendingBlocker) problems.push(status.liveSendingBlocker);
  if (!status.imap.configured) problems.push("Inbox monitoring is not configured; replies and bounces may not be detected.");
  else if (status.imap.lastError) problems.push(`Inbox check failed: ${status.imap.lastError}`);
  if (status.teamMailboxHealth) {
    const disconnected = status.teamMailboxHealth.activeUsers - status.teamMailboxHealth.connectedMailboxes;
    if (disconnected > 0) problems.push(`${disconnected} active team member${disconnected === 1 ? "" : "s"} ${disconnected === 1 ? "has" : "have"} not connected a mailbox.`);
    if (status.teamMailboxHealth.inboxErrors > 0) {
      problems.push(`${status.teamMailboxHealth.inboxErrors} team inbox${status.teamMailboxHealth.inboxErrors === 1 ? "" : "es"} have a connection problem.`);
    }
    if (status.teamMailboxHealth.inboxesNotChecked > 0) {
      problems.push(`${status.teamMailboxHealth.inboxesNotChecked} team inbox${status.teamMailboxHealth.inboxesNotChecked === 1 ? "" : "es"} have not completed their first check.`);
    }
  }
  return problems;
}

function MailboxHealthCard({ status, isPending, isError }: { status?: MailboxStatusDto; isPending: boolean; isError: boolean }) {
  const issues = mailboxProblems(status);
  return (
    <Panel title="Mailbox & Infrastructure Health">
      {isPending ? (
        <p className="text-xs text-ink-subtle">Checking mailbox connection…</p>
      ) : isError ? (
        <p className="text-xs text-warning">Mailbox status could not be loaded. Please check Settings.</p>
      ) : issues.length ? (
        <ul className="space-y-2">
          {issues.map((issue) => (
            <li key={issue} className="flex gap-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {issue}
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex items-center gap-2 text-xs text-success">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Sending mailbox (SMTP) and inbox monitoring (IMAP) are healthy and active.</span>
        </div>
      )}
      <div className="mt-3 flex items-center gap-4 text-xs font-medium">
        <Link to="/settings/mailbox" className="text-brand hover:underline">
          Mailbox settings →
        </Link>
        {status?.imap.lastCheckedAt && (
          <span className="text-ink-faint">Last synced {timeAgo(status.imap.lastCheckedAt)}</span>
        )}
      </div>
    </Panel>
  );
}

// ============================================================================
// 1. FOUNDER — BIRD'S-EYE EXECUTIVE OVERVIEW
// ============================================================================

function ExecutiveMetric({
  label,
  current,
  previous,
  rate,
  rateLabel,
}: {
  label: string;
  current: number;
  previous: number;
  rate?: string;
  rateLabel?: string;
}) {
  const delta = current - previous;
  const comparison =
    previous === 0
      ? current === 0
        ? "No activity in either period"
        : `${num(current)}; none in prior 30d`
      : `${delta > 0 ? "+" : ""}${num(delta)} vs prior 30d`;

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <p className="text-xs font-medium text-ink-subtle">{label}</p>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold tracking-tight text-ink">{num(current)}</span>
        {rate && <span className="text-xs font-semibold text-brand">{rate} {rateLabel}</span>}
      </div>
      <p className="mt-1 text-xs text-ink-faint">{comparison}</p>
    </div>
  );
}

function FounderOverview() {
  useTitle("Executive Overview");
  const { can } = useAuth();
  const overview = useOverview();
  const queue = useWorkspaceQueue();
  const mailbox = useMailbox();

  if (overview.isPending || queue.isPending) return <PageLoader label="Loading executive overview…" />;
  if (overview.isError) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />;
  if (queue.isError) return <ErrorState error={queue.error} onRetry={() => queue.refetch()} />;

  const data = overview.data.data;
  const work = queue.data.data;
  const mailboxIssues = mailboxProblems(mailbox.data?.data);

  // Executive Attention Items
  const pendingApprovals = data.awaitingApproval.length ? data.awaitingApproval : work.pendingApproval;
  const campaignsNeedingHelp = work.campaignsNeedingAttention;
  const dueFollowUps = work.dueFollowUps;
  const totalAttentionCount =
    pendingApprovals.length + campaignsNeedingHelp.length + dueFollowUps.length + mailboxIssues.length + (mailbox.isError ? 1 : 0);

  // 30-Day Conversion Rates
  const sent30 = data.last30Days.sent;
  const replied30 = data.last30Days.replied;
  const positive30 = data.last30Days.positiveReplies + data.last30Days.meetingsBooked;
  const replyRate30 = sent30 > 0 ? ((replied30 / sent30) * 100).toFixed(1) + "%" : "0%";
  const positiveRate30 = replied30 > 0 ? ((positive30 / replied30) * 100).toFixed(1) + "%" : "0%";

  // Active campaigns
  const activeCampaigns = work.campaigns.filter((c) => ["SENDING", "APPROVED", "PAUSED"].includes(c.status));

  return (
    <>
      <PageHeader
        title="Overview"
        description="FocusRealm outreach performance, business outcomes, and executive alerts."
        actions={
          <div className="flex items-center gap-2">
            <ButtonLink to="/campaigns" variant="secondary">
              All campaigns
            </ButtonLink>
            {can("campaigns.manage") && (
              <ButtonLink to="/campaigns/new" variant="primary" icon={<Plus className="h-4 w-4" />}>
                New campaign
              </ButtonLink>
            )}
          </div>
        }
      />

      <div className="space-y-6">
        {/* Executive Metrics Grid (Last 30 Days) */}
        <section aria-label="Executive Metrics">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Last 30 Days Performance</h2>
            <span className="text-xs text-ink-subtle">Compared against prior 30-day period</span>
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <ExecutiveMetric
              label="Emails Sent"
              current={sent30}
              previous={data.previous30Days.sent}
            />
            <ExecutiveMetric
              label="Inbound Replies"
              current={replied30}
              previous={data.previous30Days.replied}
              rate={replyRate30}
              rateLabel="reply rate"
            />
            <ExecutiveMetric
              label="Positive Outcomes"
              current={positive30}
              previous={data.previous30Days.positiveReplies + data.previous30Days.meetingsBooked}
              rate={positiveRate30}
              rateLabel="of replies"
            />
            <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
              <p className="text-xs font-medium text-ink-subtle">Active Campaigns</p>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-ink">{num(activeCampaigns.length)}</span>
                <span className="text-xs text-ink-subtle font-medium">in outreach</span>
              </div>
              <p className="mt-1 text-xs text-ink-faint">{num(work.campaigns.length)} total campaigns</p>
            </div>
          </div>
        </section>

        {/* Prioritized Needs Attention Section */}
        <section aria-label="Needs Attention">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-ink">Needs Attention</h2>
              {totalAttentionCount > 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                  {totalAttentionCount}
                </span>
              )}
            </div>
            {totalAttentionCount > 0 && (
              <span className="text-xs text-ink-subtle">Items requiring intervention or review</span>
            )}
          </div>

          <div className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm">
            {mailbox.isError && (
              <Link
                to="/settings/mailbox"
                className="flex items-center justify-between gap-3 px-5 py-3.5 text-xs transition-colors hover:bg-surface-muted/60"
              >
                <span className="flex items-center gap-2.5 font-medium text-warning">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Mailbox connection health check failed.
                </span>
                <span className="text-xs font-medium text-brand">Configure settings →</span>
              </Link>
            )}

            {mailboxIssues.map((issue) => (
              <Link
                key={issue}
                to="/settings/mailbox"
                className="flex items-center justify-between gap-3 px-5 py-3.5 text-xs transition-colors hover:bg-surface-muted/60"
              >
                <span className="flex items-center gap-2.5 font-medium text-warning">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {issue}
                </span>
                <span className="text-xs font-medium text-brand">Resolve in Settings →</span>
              </Link>
            ))}

            {pendingApprovals.map((campaign) => (
              <Link
                key={campaign.id}
                to={`/campaigns/${campaign.id}?tab=review`}
                className="flex items-center justify-between gap-3 px-5 py-3.5 text-xs transition-colors hover:bg-surface-muted/60"
              >
                <span className="flex items-center gap-2.5 font-medium text-ink">
                  <Inbox className="h-4 w-4 shrink-0 text-brand" />
                  Campaign approval needed: <span className="font-semibold">{campaign.name}</span>
                  {campaign.createdBy && <span className="text-ink-subtle">by {campaign.createdBy.name}</span>}
                </span>
                <span className="flex items-center gap-1 font-medium text-brand">
                  Review & Approve <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            ))}

            {campaignsNeedingHelp.map((campaign) => (
              <Link
                key={campaign.id}
                to={`/campaigns/${campaign.id}?tab=recipients&filter=${campaign.counts.unknown ? "unknown" : "failed"}`}
                className="flex items-center justify-between gap-3 px-5 py-3.5 text-xs transition-colors hover:bg-surface-muted/60"
              >
                <span className="flex items-center gap-2.5 font-medium text-ink">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                  Delivery issues on: <span className="font-semibold">{campaign.name}</span>
                  {campaign.counts.failed > 0 && (
                    <span className="text-danger">({plural(campaign.counts.failed, "failed send")})</span>
                  )}
                  {campaign.counts.unknown > 0 && (
                    <span className="text-warning">({plural(campaign.counts.unknown, "to review")})</span>
                  )}
                </span>
                <span className="flex items-center gap-1 font-medium text-brand">
                  View recipients <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            ))}

            {dueFollowUps.slice(0, 3).map((send) => (
              <Link
                key={send.id}
                to={`/campaigns/${send.campaignId}?tab=recipients&filter=scheduled`}
                className="flex items-center justify-between gap-3 px-5 py-3.5 text-xs transition-colors hover:bg-surface-muted/60"
              >
                <span className="flex items-center gap-2.5 font-medium text-ink">
                  <Clock3 className="h-4 w-4 shrink-0 text-brand" />
                  Follow-up due for <span className="font-semibold">{send.contactName || send.email}</span>
                  <span className="text-ink-subtle">({send.campaignName})</span>
                </span>
                <span className="flex items-center gap-1 font-medium text-brand">
                  View scheduled <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            ))}

            {totalAttentionCount === 0 && (
              <div className="flex items-center gap-2 px-5 py-6 text-xs text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>All outreach channels healthy. No pending approvals or campaign delivery exceptions.</span>
              </div>
            )}
          </div>
        </section>

        {/* Executive Conversion Funnel */}
        <section aria-label="Conversion Funnel">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Outreach Funnel (Last 30 Days)</h2>
            <span className="text-xs text-ink-subtle">Sent → Delivered → Inbound Replies → Positive Outcome</span>
          </div>
          <div className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm sm:grid-cols-4">
            <div className="rounded-lg bg-surface-muted/50 p-3.5">
              <span className="text-xs font-medium text-ink-subtle">1. Outreach Sent</span>
              <p className="mt-1 text-xl font-bold text-ink">{num(sent30)}</p>
              <p className="mt-0.5 text-xs text-ink-faint">SpaceMail SMTP dispatches</p>
            </div>
            <div className="rounded-lg bg-surface-muted/50 p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink-subtle">2. Delivered</span>
                <span className="text-xs font-semibold text-brand">
                  {sent30 > 0 ? `${(((sent30 - data.last30Days.bounced) / sent30) * 100).toFixed(1)}%` : "—"}
                </span>
              </div>
              <p className="mt-1 text-xl font-bold text-ink">{num(Math.max(0, sent30 - data.last30Days.bounced))}</p>
              <p className="mt-0.5 text-xs text-ink-faint">Accepted by recipient mailboxes</p>
            </div>
            <div className="rounded-lg bg-surface-muted/50 p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink-subtle">3. Replies Received</span>
                <span className="text-xs font-semibold text-brand">{replyRate30}</span>
              </div>
              <p className="mt-1 text-xl font-bold text-ink">{num(replied30)}</p>
              <p className="mt-0.5 text-xs text-ink-faint">Detected via IMAP sync</p>
            </div>
            <div className="rounded-lg bg-surface-muted/50 p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink-subtle">4. Positive Outcomes</span>
                <span className="text-xs font-semibold text-success">{positiveRate30}</span>
              </div>
              <p className="mt-1 text-xl font-bold text-success">{num(positive30)}</p>
              <p className="mt-0.5 text-xs text-ink-faint">Interested or meeting booked</p>
            </div>
          </div>
        </section>

        {/* Active Campaigns Performance Matrix */}
        <section aria-label="Active Campaigns">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Active Outreach Campaigns</h2>
            <Link to="/campaigns?tab=active" className="text-xs font-medium text-brand hover:underline">
              View all active campaigns →
            </Link>
          </div>

          <div className="divide-y divide-line rounded-xl border border-line bg-surface shadow-sm">
            {activeCampaigns.length > 0 ? (
              activeCampaigns.map((c) => {
                const total = c.counts.total || 1;
                const pct = Math.min(100, Math.round((c.counts.sent / total) * 100));
                const repRate = c.counts.sent > 0 ? ((c.counts.replied / c.counts.sent) * 100).toFixed(1) + "%" : "0%";
                return (
                  <Link
                    key={c.id}
                    to={`/campaigns/${c.id}`}
                    className="flex flex-col gap-2 p-4 transition-colors hover:bg-surface-muted/50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-semibold text-ink">{c.name}</span>
                        <CampaignStatusBadge status={c.status} />
                      </div>
                      <p className="mt-1 truncate text-xs text-ink-subtle">
                        {c.list.name} ({plural(c.list.memberCount, "contact")}) · {c.template.name}
                        {c.createdBy && ` · By ${c.createdBy.name}`}
                      </p>
                    </div>

                    <div className="flex items-center gap-6 shrink-0 text-xs">
                      <div className="w-28">
                        <div className="flex justify-between text-[11px] text-ink-subtle">
                          <span>{pct}% sent</span>
                          <span>{c.counts.sent}/{c.counts.total}</span>
                        </div>
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                          <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
                        </div>
                      </div>

                      <div className="text-right">
                        <p className="font-semibold text-ink">{num(c.counts.replied)} replies</p>
                        <p className="text-[11px] text-brand font-medium">{repRate} reply rate</p>
                      </div>

                      <ArrowUpRight className="h-4 w-4 text-ink-faint" />
                    </div>
                  </Link>
                );
              })
            ) : (
              <div className="px-5 py-8 text-center text-xs text-ink-subtle">
                No campaigns are actively sending right now.
              </div>
            )}
          </div>
        </section>

        {/* Footer Statistics */}
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink-faint border-t border-line pt-4">
          <p>
            {num(data.counts.contacts)} contacts · {num(data.counts.lists)} lists · {num(data.counts.templates)} templates · {num(data.counts.suppressed)} suppressed
          </p>
          <span className="inline-flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5" />
            {num(work.counts.failedSends + work.counts.unknownSends)} delivery exceptions across workspace
          </span>
        </div>
      </div>
    </>
  );
}

// ============================================================================
// 2. FOUNDER OFFICE — OPERATIONAL CONTROL ROOM & QUEUE
// ============================================================================

function FounderOfficeQueue() {
  useTitle("Operational Control Room");
  const queue = useWorkspaceQueue();
  const mailbox = useMailbox();

  if (queue.isPending) return <PageLoader label="Loading control room queues…" />;
  if (queue.isError) return <ErrorState error={queue.error} onRetry={() => queue.refetch()} />;

  const data = queue.data.data;
  const deliveryExceptions = [...data.failedSends, ...data.unknownSends];
  const pendingApprovals = data.pendingApproval ?? [];
  const readyToSend = data.readyToSend ?? data.campaigns.filter((c) => c.status === "APPROVED");

  return (
    <>
      <PageHeader
        title="Queue & Control Room"
        description="Pending approvals, delivery exceptions, scheduled follow-ups, and team mailbox operations."
        actions={
          <ButtonLink to="/campaigns" variant="secondary" icon={<Send className="h-4 w-4" />}>
            All campaigns
          </ButtonLink>
        }
      />

      <div className="space-y-6">
        {/* Operational Status KPI Summary Pills */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm">
            <span className="text-xs font-medium text-ink-subtle">Pending Approvals</span>
            <div className="mt-1 flex items-center justify-between">
              <span className={`text-xl font-bold ${pendingApprovals.length > 0 ? "text-amber-600" : "text-ink"}`}>
                {num(pendingApprovals.length)}
              </span>
              {pendingApprovals.length > 0 ? (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                  Action required
                </span>
              ) : (
                <span className="text-[11px] text-ink-faint">Clear</span>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm">
            <span className="text-xs font-medium text-ink-subtle">Ready to Dispatch</span>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xl font-bold text-ink">{num(readyToSend.length)}</span>
              <span className="text-[11px] text-ink-faint">Approved</span>
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm">
            <span className="text-xs font-medium text-ink-subtle">Delivery Exceptions</span>
            <div className="mt-1 flex items-center justify-between">
              <span className={`text-xl font-bold ${deliveryExceptions.length > 0 ? "text-danger" : "text-ink"}`}>
                {num(deliveryExceptions.length)}
              </span>
              {deliveryExceptions.length > 0 ? (
                <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800">
                  Needs review
                </span>
              ) : (
                <span className="text-[11px] text-ink-faint">Zero</span>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm">
            <span className="text-xs font-medium text-ink-subtle">Follow-ups Due</span>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xl font-bold text-ink">{num(data.counts.dueFollowUps)}</span>
              <span className="text-[11px] text-ink-faint">In sequence</span>
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-3.5 shadow-sm col-span-2 sm:col-span-1">
            <span className="text-xs font-medium text-ink-subtle">Mailbox Status</span>
            <div className="mt-1 flex items-center gap-1.5">
              {mailbox.data?.data.smtp.configured && mailbox.data?.data.imap.configured ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                  <span className="text-xs font-semibold text-success">Healthy</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
                  <span className="text-xs font-semibold text-warning">Attention</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Queue 1: Pending Approvals */}
        <Panel
          title="Campaigns Awaiting Approval"
          description="Campaigns created and submitted by team members requiring review before sending can start."
          flush
        >
          {pendingApprovals.length > 0 ? (
            <div className="divide-y divide-line">
              {pendingApprovals.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between hover:bg-surface-muted/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-ink">{c.name}</span>
                      <CampaignStatusBadge status={c.status} />
                    </div>
                    <p className="mt-1 text-xs text-ink-subtle">
                      Created by <span className="font-medium text-ink">{c.createdBy?.name || "Team member"}</span> · {c.list.name} ({plural(c.list.memberCount, "recipient")}) · Template: {c.template.name}
                    </p>
                  </div>
                  <ButtonLink
                    to={`/campaigns/${c.id}?tab=review`}
                    variant="primary"
                    size="sm"
                    icon={<ShieldCheck className="h-3.5 w-3.5" />}
                  >
                    Review & Approve
                  </ButtonLink>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-6 text-center text-xs text-ink-subtle">
              No campaigns are currently waiting for approval.
            </div>
          )}
        </Panel>

        {/* Queue 2: Campaigns Ready to Dispatch */}
        {readyToSend.length > 0 && (
          <Panel
            title="Campaigns Ready to Dispatch"
            description="Approved campaigns that can be started."
            flush
          >
            <div className="divide-y divide-line">
              {readyToSend.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between p-4 hover:bg-surface-muted/40 transition-colors"
                >
                  <div className="min-w-0">
                    <span className="text-xs font-semibold text-ink">{c.name}</span>
                    <p className="mt-0.5 text-xs text-ink-subtle">
                      {c.list.name} ({plural(c.list.memberCount, "recipient")}) · Approved and locked
                    </p>
                  </div>
                  <ButtonLink to={`/campaigns/${c.id}`} variant="secondary" size="sm" icon={<Play className="h-3.5 w-3.5" />}>
                    Open Campaign
                  </ButtonLink>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {/* Queue 3: Delivery Exceptions & Uncertain Sends */}
        <Panel
          title="Delivery Exceptions & Uncertain Sends"
          description={`${num(data.counts.failedSends)} failed · ${num(data.counts.unknownSends)} to review`}
          flush
        >
          {deliveryExceptions.length > 0 ? (
            <div className="divide-y divide-line">
              {deliveryExceptions.map((item) => (
                <Link
                  key={item.id}
                  to={`/campaigns/${item.campaignId}?tab=recipients&filter=${item.status === "UNKNOWN" ? "unknown" : "failed"}`}
                  className="flex items-center justify-between gap-4 p-4 text-xs hover:bg-surface-muted/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{item.email}</span>
                      {item.contactName && <span className="text-ink-subtle">({item.contactName})</span>}
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${item.status === "FAILED" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800"}`}>
                        {item.status}
                      </span>
                    </div>
                    <p className="mt-0.5 text-ink-subtle">
                      {item.campaignName}{item.stepIndex > 0 ? ` · Step ${item.stepIndex}` : ""}
                    </p>
                  </div>
                  <span className="text-ink-faint shrink-0">Resolve →</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="px-5 py-6 text-center text-xs text-ink-subtle">
              No failed or uncertain sends across the workspace.
            </div>
          )}
        </Panel>

        {/* Queue 4: Follow-ups Due */}
        <Panel
          title="Scheduled Follow-ups Due"
          description={`${num(data.counts.dueFollowUps)} sequence follow-up messages due for dispatch.`}
          flush
        >
          {data.dueFollowUps.length > 0 ? (
            <div className="divide-y divide-line">
              {data.dueFollowUps.map((item) => (
                <Link
                  key={item.id}
                  to={`/campaigns/${item.campaignId}?tab=recipients&filter=scheduled`}
                  className="flex items-center justify-between gap-4 p-4 text-xs hover:bg-surface-muted/40 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{item.contactName ? `${item.contactName} (${item.email})` : item.email}</p>
                    <p className="mt-0.5 text-ink-subtle">
                      {item.campaignName} · Follow-up touch {item.stepIndex}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-xs text-brand font-medium">Due now</span>
                    {item.scheduledFor && <p className="text-[11px] text-ink-faint">{timeAgo(item.scheduledFor)}</p>}
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="px-5 py-6 text-center text-xs text-ink-subtle">
              No approved follow-ups are currently due.
            </div>
          )}
        </Panel>

        {/* Queue 5: Inbound Replies */}
        {data.replies.length > 0 && (
          <Panel
            title="Inbound Replies Requiring Attention"
            description="Recent replies detected by IMAP inbox monitoring across all campaigns."
            flush
          >
            <div className="divide-y divide-line">
              {data.replies.map((item) => (
                <Link
                  key={item.id}
                  to={`/campaigns/${item.campaignId}?tab=recipients&filter=replied`}
                  className="flex items-center justify-between gap-4 p-4 text-xs hover:bg-surface-muted/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{item.contactName ? `${item.contactName} (${item.email})` : item.email}</span>
                      <ReplyClassificationBadge classification={item.classification} />
                    </div>
                    {item.snippet && (
                      <p className="mt-1 text-ink-subtle line-clamp-1 italic text-[11px]">"{item.snippet}"</p>
                    )}
                    <p className="mt-0.5 text-[11px] text-ink-faint">
                      {item.campaignName}{item.subject ? ` · Subj: ${item.subject}` : ""}
                    </p>
                  </div>
                  {item.repliedAt && (
                    <span className="text-[11px] text-ink-subtle shrink-0">{timeAgo(item.repliedAt)}</span>
                  )}
                </Link>
              ))}
            </div>
          </Panel>
        )}

        {/* Mailbox Infrastructure */}
        <MailboxHealthCard status={mailbox.data?.data} isPending={mailbox.isPending} isError={mailbox.isError} />
      </div>
    </>
  );
}

// ============================================================================
// 3. EMPLOYEE — TODAY & ACTIONABLE WORKSPACE
// ============================================================================

function EmployeeToday() {
  useTitle("Today");
  const { user, can } = useAuth();
  const queue = useWorkspaceQueue();

  if (queue.isPending) return <PageLoader label="Loading your actionable workspace…" />;
  if (queue.isError) return <ErrorState error={queue.error} onRetry={() => queue.refetch()} />;

  const data = queue.data.data;
  const myReplies = data.replies;
  const myDueFollowUps = data.dueFollowUps;
  const myActiveCampaigns = data.campaigns.filter((c) => ["SENDING", "APPROVED"].includes(c.status));

  return (
    <>
      <PageHeader
        title="Today"
        description={`Welcome back, ${user?.name || "there"}. Here is your outreach activity and what needs your action today.`}
        actions={
          can("campaigns.manage") && (
            <ButtonLink to="/campaigns/new" variant="primary" icon={<Plus className="h-4 w-4" />}>
              New campaign
            </ButtonLink>
          )
        }
      />

      <div className="space-y-6">
        {/* Action Summary Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
            <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
              <MessageSquare className="h-4 w-4 text-brand" />
              Inbound Replies
            </div>
            <p className="mt-2 text-2xl font-bold tracking-tight text-ink">{num(myReplies.length)}</p>
            <p className="mt-1 text-xs text-ink-faint">Received across your campaigns</p>
          </div>

          <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
            <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
              <Clock3 className="h-4 w-4 text-brand" />
              Follow-ups Due
            </div>
            <p className="mt-2 text-2xl font-bold tracking-tight text-ink">{num(myDueFollowUps.length)}</p>
            <p className="mt-1 text-xs text-ink-faint">Scheduled sequence messages</p>
          </div>

          <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
            <div className="flex items-center gap-2 text-xs font-medium text-ink-subtle">
              <Send className="h-4 w-4 text-brand" />
              Active Campaigns
            </div>
            <p className="mt-2 text-2xl font-bold tracking-tight text-ink">{num(myActiveCampaigns.length)}</p>
            <p className="mt-1 text-xs text-ink-faint">Sending or approved</p>
          </div>
        </div>

        {/* Section 1: Inbound Replies Waiting on My Campaigns */}
        <Panel
          title="Replies Waiting for Response"
          description="Inbound replies from contacts in your campaigns. Review sentiment and follow up."
          flush
        >
          {myReplies.length > 0 ? (
            <div className="divide-y divide-line">
              {myReplies.map((item) => (
                <Link
                  key={item.id}
                  to={`/campaigns/${item.campaignId}?tab=recipients&filter=replied`}
                  className="flex items-center justify-between gap-4 p-4 text-xs hover:bg-surface-muted/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{item.contactName ? `${item.contactName} (${item.email})` : item.email}</span>
                      <ReplyClassificationBadge classification={item.classification} />
                    </div>
                    {item.snippet && (
                      <p className="mt-1 text-xs text-ink-subtle line-clamp-1 italic">"{item.snippet}"</p>
                    )}
                    <p className="mt-0.5 text-[11px] text-ink-faint">
                      {item.campaignName}{item.subject ? ` · Subj: ${item.subject}` : ""}
                    </p>
                  </div>
                  {item.repliedAt && (
                    <span className="text-[11px] text-ink-subtle shrink-0">{timeAgo(item.repliedAt)}</span>
                  )}
                </Link>
              ))}
            </div>
          ) : (
            <div className="px-5 py-8 text-center text-xs text-ink-subtle">
              No replies received on your campaigns yet.
            </div>
          )}
        </Panel>

        {/* Section 2: Follow-ups Due Today */}
        <Panel
          title="Follow-ups Due Today"
          description="Approved follow-up sequence touches scheduled and ready for dispatch."
          flush
        >
          {myDueFollowUps.length > 0 ? (
            <div className="divide-y divide-line">
              {myDueFollowUps.map((item) => (
                <Link
                  key={item.id}
                  to={`/campaigns/${item.campaignId}?tab=recipients&filter=scheduled`}
                  className="flex items-center justify-between gap-4 p-4 text-xs hover:bg-surface-muted/40 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{item.contactName ? `${item.contactName} (${item.email})` : item.email}</p>
                    <p className="mt-0.5 text-ink-subtle">
                      {item.campaignName} · Step {item.stepIndex}
                    </p>
                  </div>
                  <span className="text-xs font-medium text-brand">Due now →</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="px-5 py-8 text-center text-xs text-ink-subtle">
              No scheduled follow-ups are due right now.
            </div>
          )}
        </Panel>

        {/* Section 3: My Campaigns & Approval Pipeline */}
        <Panel
          title="My Campaigns & Approval Status"
          description="Track the status of your campaign drafts, submissions awaiting approval, and active outreach."
          flush
        >
          {data.campaigns.length > 0 ? (
            <div className="divide-y divide-line">
              {data.campaigns.map((c) => (
                <Link
                  key={c.id}
                  to={`/campaigns/${c.id}`}
                  className="flex items-center justify-between gap-4 p-4 text-xs hover:bg-surface-muted/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{c.name}</span>
                      <CampaignStatusBadge status={c.status} />
                    </div>
                    <p className="mt-0.5 text-ink-subtle">
                      {c.list.name} ({plural(c.list.memberCount, "contact")}) · {c.template.name}
                      {c.status === "PENDING_APPROVAL" && (
                        <span className="text-amber-600 font-medium ml-1">· Under review by Founder Office</span>
                      )}
                    </p>
                  </div>
                  <div className="text-right text-xs shrink-0">
                    <p className="font-medium text-ink">{c.counts.sent} sent</p>
                    <p className="text-[11px] text-ink-subtle">{c.counts.replied} replies</p>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="px-5 py-8 text-center text-xs text-ink-subtle">
              You haven't created any campaigns yet. Click "New campaign" to begin outreach.
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

// ============================================================================
// ROOT OVERVIEW PAGE (ROLE-DISPATCHER)
// ============================================================================

export function OverviewPage() {
  const { user } = useAuth();
  if (user?.role === "EMPLOYEE") return <EmployeeToday />;
  if (user?.role === "FOUNDER_OFFICE") return <FounderOfficeQueue />;
  return <FounderOverview />;
}
