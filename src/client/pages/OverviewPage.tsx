import { useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUpRight,
  Briefcase,
  CheckCircle2,
  Clock3,
  Filter,
  GraduationCap,
  Handshake,
  Inbox,
  Mail,
  Megaphone,
  MessageSquare,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Users,
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
import {
  CAMPAIGN_OUTREACH_TYPES,
  CAMPAIGN_OUTREACH_TYPE_LABELS,
  type CampaignOutreachType,
  type OverviewFilterQuery,
  type OutreachTypeMetricDto,
  type TeamOutreachMetricDto,
  type DailyActivityTrendDto,
  type OutreachFunnelDto,
  type AttentionItemDto,
  type MailboxStatusDto,
} from "@shared/types";

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
  periodLabel = "prior period",
}: {
  label: string;
  current: number;
  previous: number;
  rate?: string;
  rateLabel?: string;
  periodLabel?: string;
}) {
  const delta = current - previous;
  const comparison =
    previous === 0
      ? current === 0
        ? "No activity in either period"
        : `${num(current)}; none in ${periodLabel}`
      : `${delta > 0 ? "+" : ""}${num(delta)} vs ${periodLabel}`;

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

function getOutreachTypeIcon(type: CampaignOutreachType) {
  switch (type) {
    case "CUSTOMER_OUTREACH":
      return <Briefcase className="h-4 w-4 text-brand" />;
    case "PARTNERSHIPS":
      return <Handshake className="h-4 w-4 text-emerald-600" />;
    case "ADVISORS":
      return <GraduationCap className="h-4 w-4 text-indigo-600" />;
    case "HIRING_TALENT":
      return <Users className="h-4 w-4 text-amber-600" />;
    case "PRESS_MEDIA":
      return <Megaphone className="h-4 w-4 text-rose-600" />;
    default:
      return <Send className="h-4 w-4 text-slate-600" />;
  }
}

function OutreachTrendChart({ trend }: { trend: DailyActivityTrendDto[] }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const maxReached = Math.max(...trend.map((d) => d.reached), 5);

  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-ink">30-Day Outreach Activity Trend</h3>
          <p className="text-xs text-ink-subtle mt-0.5">Daily contacts reached, replies detected, and positive outcomes</p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-brand" />
            <span className="text-ink-subtle">Reached</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-sky-400" />
            <span className="text-ink-subtle">Replies</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />
            <span className="text-ink-subtle">Positive Outcomes</span>
          </div>
        </div>
      </div>

      <div className="relative pt-3">
        <div className="h-32 flex items-end gap-1 sm:gap-1.5 w-full">
          {trend.map((d, i) => {
            const heightPct = Math.max(d.reached > 0 ? 8 : 2, Math.round((d.reached / maxReached) * 100));
            const hasReplies = d.replies > 0;
            const hasPositive = d.positiveOutcomes > 0;
            const isHovered = hoveredIdx === i;

            return (
              <div
                key={d.date}
                className="group relative flex-1 flex flex-col justify-end items-center h-full cursor-pointer"
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                {isHovered && (
                  <div className="absolute -top-12 z-20 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] text-white shadow-md pointer-events-none">
                    <span className="font-semibold">{d.label}: </span>
                    <span>{num(d.reached)} reached</span>
                    {d.replies > 0 && <span> · {num(d.replies)} rep</span>}
                    {d.positiveOutcomes > 0 && <span> · {num(d.positiveOutcomes)} pos</span>}
                  </div>
                )}

                <div className="flex items-center gap-0.5 mb-1 h-3">
                  {hasPositive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                  {hasReplies && !hasPositive && <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />}
                </div>

                <div
                  className={`w-full rounded-t transition-all ${
                    d.reached > 0
                      ? isHovered
                        ? "bg-brand/80"
                        : "bg-brand"
                      : "bg-surface-sunken"
                  }`}
                  style={{ height: `${heightPct}%` }}
                />
              </div>
            );
          })}
        </div>

        <div className="flex justify-between items-center text-[10px] text-ink-faint mt-2 pt-1 border-t border-line">
          <span>{trend[0]?.label ?? "30 days ago"}</span>
          <span>{trend[Math.floor(trend.length / 2)]?.label ?? "15 days ago"}</span>
          <span>{trend[trend.length - 1]?.label ?? "Today"}</span>
        </div>
      </div>
    </div>
  );
}

function OutreachFunnelCard({ funnel }: { funnel: OutreachFunnelDto }) {
  return (
    <section aria-label="Conversion Funnel">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Outreach Funnel</h2>
        <span className="text-xs text-ink-subtle">Reached → Replies → Positive Outcomes → Meetings / Opportunities</span>
      </div>
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-line bg-surface p-4 shadow-sm sm:grid-cols-4">
        <div className="rounded-lg bg-surface-muted/50 p-3.5 border border-line/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-subtle">1. Outreach Reached</span>
            <span className="text-[10px] font-semibold text-brand bg-brand/10 px-1.5 py-0.5 rounded">100%</span>
          </div>
          <p className="mt-1.5 text-2xl font-bold tracking-tight text-ink">{num(funnel.reached)}</p>
          <p className="mt-0.5 text-xs text-ink-faint">Verified recipient dispatches</p>
        </div>

        <div className="rounded-lg bg-surface-muted/50 p-3.5 border border-line/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-subtle">2. Replies Received</span>
            <span className="text-[10px] font-semibold text-brand bg-brand/10 px-1.5 py-0.5 rounded">
              {funnel.replyRate}% of reached
            </span>
          </div>
          <p className="mt-1.5 text-2xl font-bold tracking-tight text-ink">{num(funnel.replies)}</p>
          <p className="mt-0.5 text-xs text-ink-faint">Inbound engagement via IMAP</p>
        </div>

        <div className="rounded-lg bg-surface-muted/50 p-3.5 border border-line/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-subtle">3. Positive Outcomes</span>
            <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
              {funnel.positiveRate}% of replies
            </span>
          </div>
          <p className="mt-1.5 text-2xl font-bold tracking-tight text-emerald-700">{num(funnel.positiveOutcomes)}</p>
          <p className="mt-0.5 text-xs text-ink-faint">Interested / qualified conversations</p>
        </div>

        <div className="rounded-lg bg-surface-muted/50 p-3.5 border border-line/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-ink-subtle">4. Meetings / Opps</span>
            <span className="text-[10px] font-semibold text-indigo-700 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-200">
              {funnel.overallConversionRate}% overall
            </span>
          </div>
          <p className="mt-1.5 text-2xl font-bold tracking-tight text-indigo-700">{num(funnel.meetings)}</p>
          <p className="mt-0.5 text-xs text-ink-faint">Booked or business opportunities</p>
        </div>
      </div>
    </section>
  );
}

function OutreachByTypeCard({ metrics }: { metrics: OutreachTypeMetricDto[] }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Outreach by Type</h3>
          <p className="text-xs text-ink-subtle mt-0.5">Performance across customer, partnership, advisor, and team channels</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map((m) => (
          <div key={m.outreachType} className="rounded-lg border border-line/60 bg-surface-muted/30 p-3.5 hover:border-line transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getOutreachTypeIcon(m.outreachType)}
                <span className="text-xs font-semibold text-ink">{m.label}</span>
              </div>
              {m.activeCampaigns > 0 ? (
                <span className="rounded bg-emerald-50 text-emerald-700 px-1.5 py-0.5 text-[10px] font-medium border border-emerald-200">
                  {plural(m.activeCampaigns, "active")}
                </span>
              ) : (
                <span className="text-[11px] text-ink-faint">0 active</span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2 mt-3 pt-2.5 border-t border-line/40 text-center">
              <div>
                <p className="text-[11px] text-ink-subtle font-medium">Reached</p>
                <p className="text-sm font-bold text-ink mt-0.5">{num(m.reached)}</p>
              </div>
              <div>
                <p className="text-[11px] text-ink-subtle font-medium">Replies</p>
                <p className="text-sm font-bold text-ink mt-0.5">{num(m.replies)}</p>
                <p className="text-[10px] text-brand font-medium">{m.replyRate}%</p>
              </div>
              <div>
                <p className="text-[11px] text-ink-subtle font-medium">Positive</p>
                <p className="text-sm font-bold text-emerald-600 mt-0.5">{num(m.positiveOutcomes)}</p>
                <p className="text-[10px] text-emerald-600 font-medium">{m.positiveRate}%</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TeamOutreachCard({ team }: { team: TeamOutreachMetricDto[] }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">Team Outreach</h3>
          <p className="text-xs text-ink-subtle mt-0.5">Assigned contacts, reach volume, outcomes, and pending work per owner</p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-line text-ink-subtle font-medium">
              <th className="pb-2.5 font-medium">Team Member</th>
              <th className="pb-2.5 font-medium text-right">Assigned</th>
              <th className="pb-2.5 font-medium text-right">Reached</th>
              <th className="pb-2.5 font-medium text-right">Replies</th>
              <th className="pb-2.5 font-medium text-right">Positive</th>
              <th className="pb-2.5 font-medium text-right">Pending Work</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line/60">
            {team.length > 0 ? (
              team.map((t) => (
                <tr key={t.userId} className="hover:bg-surface-muted/40 transition-colors">
                  <td className="py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{t.userName}</span>
                      <span className="rounded bg-surface-sunken px-1.5 py-0.2 text-[10px] font-medium text-ink-subtle border border-line/40">
                        {t.userRole.replace("_", " ")}
                      </span>
                    </div>
                    <p className="text-[11px] text-ink-subtle">{t.userEmail}</p>
                  </td>
                  <td className="py-2.5 text-right font-medium text-ink">{num(t.assigned)}</td>
                  <td className="py-2.5 text-right font-semibold text-ink">{num(t.reached)}</td>
                  <td className="py-2.5 text-right">
                    <span className="font-semibold text-ink">{num(t.replies)}</span>
                    <span className="text-[10px] text-brand ml-1">({t.replyRate}%)</span>
                  </td>
                  <td className="py-2.5 text-right">
                    <span className="font-semibold text-emerald-600">{num(t.positiveOutcomes)}</span>
                    <span className="text-[10px] text-emerald-600 ml-1">({t.positiveRate}%)</span>
                  </td>
                  <td className="py-2.5 text-right">
                    {t.pendingWork.total > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 text-[11px] font-medium">
                        {plural(t.pendingWork.total, "item")} pending
                      </span>
                    ) : (
                      <span className="text-[11px] text-ink-faint">Clear</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="py-4 text-center text-ink-subtle">
                  No outreach team members found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FounderOverview() {
  useTitle("Founder Overview");
  const { can } = useAuth();

  // Filters State: Date Range | Outreach Type | Owner
  const [dateRange, setDateRange] = useState<"7d" | "30d" | "90d" | "all">("30d");
  const [outreachType, setOutreachType] = useState<string>("");
  const [ownerId, setOwnerId] = useState<string>("");

  const filters: OverviewFilterQuery = {
    dateRange,
    ...(outreachType ? { outreachType: outreachType as CampaignOutreachType } : {}),
    ...(ownerId ? { ownerId } : {}),
  };

  const overview = useOverview(filters);
  const queue = useWorkspaceQueue();
  const mailbox = useMailbox();

  if (overview.isPending || queue.isPending) return <PageLoader label="Loading founder outreach overview…" />;
  if (overview.isError) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />;
  if (queue.isError) return <ErrorState error={queue.error} onRetry={() => queue.refetch()} />;

  const data = overview.data.data;
  const work = queue.data.data;
  const mailboxIssues = mailboxProblems(mailbox.data?.data);

  // KPIs
  const totalReached = data.kpis?.totalReached ?? data.last30Days.sent;
  const prevReached = data.kpis?.previousReached ?? data.previous30Days.sent;
  const replies = data.kpis?.replies ?? data.last30Days.replied;
  const prevReplies = data.kpis?.previousReplies ?? data.previous30Days.replied;
  const replyRate = data.kpis?.replyRate ? `${data.kpis.replyRate}%` : (totalReached > 0 ? `${((replies / totalReached) * 100).toFixed(1)}%` : "0%");

  const positiveOutcomes = data.kpis?.positiveOutcomes ?? (data.last30Days.positiveReplies + data.last30Days.meetingsBooked);
  const prevPositive = data.kpis?.previousPositiveOutcomes ?? (data.previous30Days.positiveReplies + data.previous30Days.meetingsBooked);
  const positiveRate = data.kpis?.positiveRate ? `${data.kpis.positiveRate}%` : (replies > 0 ? `${((positiveOutcomes / replies) * 100).toFixed(1)}%` : "0%");

  const activeOutreachCount = data.kpis?.activeOutreachCampaigns ?? work.campaigns.filter((c) => ["SENDING", "APPROVED", "PAUSED"].includes(c.status)).length;
  const totalCampaignsCount = data.kpis?.totalCampaigns ?? work.campaigns.length;

  const periodLabel = dateRange === "7d" ? "prior 7d" : dateRange === "90d" ? "prior 90d" : dateRange === "all" ? "prior all" : "prior 30d";

  // Actionable Attention Items
  const attentionItems: AttentionItemDto[] = data.actionableAttention ?? [];
  const totalAttentionCount = attentionItems.length + mailboxIssues.length + (mailbox.isError ? 1 : 0);

  // Outreach Funnel
  const funnel: OutreachFunnelDto = data.funnel ?? {
    reached: totalReached,
    replies,
    positiveOutcomes,
    meetings: data.last30Days.meetingsBooked,
    replyRate: totalReached > 0 ? Number(((replies / totalReached) * 100).toFixed(1)) : 0,
    positiveRate: replies > 0 ? Number(((positiveOutcomes / replies) * 100).toFixed(1)) : 0,
    meetingRate: positiveOutcomes > 0 ? Number(((data.last30Days.meetingsBooked / positiveOutcomes) * 100).toFixed(1)) : 0,
    overallConversionRate: totalReached > 0 ? Number(((data.last30Days.meetingsBooked / totalReached) * 100).toFixed(1)) : 0,
  };

  // Outreach by Type
  const outreachByType = data.outreachByType ?? [];

  // Team Outreach
  const teamOutreach = data.teamOutreach ?? [];

  // 30-Day Activity Trend
  const activityTrend = data.activityTrend ?? [];

  // Active Campaigns
  const activeCampaigns = data.activeCampaigns ?? work.campaigns.filter((c) => ["SENDING", "APPROVED", "PAUSED"].includes(c.status));

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
        {/* Dashboard Filter Bar: Date Range | Outreach Type | Owner */}
        <section aria-label="Dashboard Filters" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-ink-subtle">
              <Filter className="h-3.5 w-3.5 text-ink-muted" />
              <span className="font-medium">Filter by:</span>
            </div>

            {/* Date Range */}
            <div className="flex items-center gap-1.5">
              <select
                value={dateRange}
                onChange={(e) => setDateRange(e.target.value as any)}
                className="rounded-lg border border-line bg-surface-muted/40 px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
                <option value="all">All time</option>
              </select>
            </div>

            {/* Outreach Type */}
            <div className="flex items-center gap-1.5">
              <select
                value={outreachType}
                onChange={(e) => setOutreachType(e.target.value)}
                className="rounded-lg border border-line bg-surface-muted/40 px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value="">All Outreach Types</option>
                {CAMPAIGN_OUTREACH_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CAMPAIGN_OUTREACH_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>

            {/* Owner */}
            <div className="flex items-center gap-1.5">
              <select
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
                className="rounded-lg border border-line bg-surface-muted/40 px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value="">All Owners</option>
                {(data.availableFilters?.owners ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {(dateRange !== "30d" || outreachType !== "" || ownerId !== "") && (
            <button
              onClick={() => {
                setDateRange("30d");
                setOutreachType("");
                setOwnerId("");
              }}
              className="text-xs font-medium text-brand hover:underline"
            >
              Reset filters
            </button>
          )}
        </section>

        {/* 1. Core Outreach KPIs Grid */}
        <section aria-label="Outreach KPIs">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Outreach Operations Performance</h2>
            <span className="text-xs text-ink-subtle">
              {dateRange === "7d" ? "Last 7 Days" : dateRange === "90d" ? "Last 90 Days" : dateRange === "all" ? "All Time" : "Last 30 Days"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <ExecutiveMetric
              label="Total Outreach / Contacts Reached"
              current={totalReached}
              previous={prevReached}
              periodLabel={periodLabel}
            />
            <ExecutiveMetric
              label="Inbound Replies"
              current={replies}
              previous={prevReplies}
              rate={replyRate}
              rateLabel="reply rate"
              periodLabel={periodLabel}
            />
            <ExecutiveMetric
              label="Positive Outcomes"
              current={positiveOutcomes}
              previous={prevPositive}
              rate={positiveRate}
              rateLabel="of replies"
              periodLabel={periodLabel}
            />
            <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
              <p className="text-xs font-medium text-ink-subtle">Active Outreach</p>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-2xl font-bold tracking-tight text-ink">{num(activeOutreachCount)}</span>
                <span className="text-xs text-ink-subtle font-medium">campaigns active</span>
              </div>
              <p className="mt-1 text-xs text-ink-faint">{num(totalCampaignsCount)} total campaigns</p>
            </div>
          </div>
        </section>

        {/* 2. Conversion Funnel: Reached → Replies → Positive Outcomes → Meetings/Opportunities */}
        <OutreachFunnelCard funnel={funnel} />

        {/* 2b. Post-Reply Conversation Operations Breakdown */}
        {/* <ConversationBreakdownCard breakdown={conversationBreakdown} /> */}

        {/* 3. Simple 30-Day Activity Trend */}
        {activityTrend.length > 0 && <OutreachTrendChart trend={activityTrend} />}

        {/* 4. Outreach by Type */}
        {outreachByType.length > 0 && <OutreachByTypeCard metrics={outreachByType} />}

        {/* 5. Team Outreach */}
        {teamOutreach.length > 0 && <TeamOutreachCard team={teamOutreach} />}

        {/* 6. Prioritized Needs Attention Section */}
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
              <span className="text-xs text-ink-subtle">Actionable items requiring intervention or review</span>
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

            {attentionItems.map((item) => (
              <Link
                key={item.id}
                to={item.link}
                className="flex items-center justify-between gap-3 px-5 py-3.5 text-xs transition-colors hover:bg-surface-muted/60"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {item.type === "OVERDUE_FOLLOW_UP" && <Clock3 className="h-4 w-4 shrink-0 text-brand" />}
                  {item.type === "UNANSWERED_REPLY" && <MessageSquare className="h-4 w-4 shrink-0 text-emerald-600" />}
                  {item.type === "PENDING_APPROVAL" && <Inbox className="h-4 w-4 shrink-0 text-amber-600" />}
                  {item.type === "MAILBOX_ISSUE" && <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />}
                  {item.type === "DELIVERY_EXCEPTION" && <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />}
                  <div className="min-w-0">
                    <p className="font-semibold text-ink truncate">{item.title}</p>
                    <p className="text-ink-subtle text-[11px] truncate">{item.subtitle}</p>
                  </div>
                </div>
                <span className="flex items-center gap-1 font-medium text-brand shrink-0">
                  {item.linkLabel} <ArrowUpRight className="h-3.5 w-3.5" />
                </span>
              </Link>
            ))}

            {totalAttentionCount === 0 && (
              <div className="flex items-center gap-2 px-5 py-6 text-xs text-success">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>All outreach channels healthy. No overdue follow-ups, unanswered conversations, or delivery exceptions.</span>
              </div>
            )}
          </div>
        </section>

        {/* 7. Active Campaigns Performance Matrix */}
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
                const posOutcomes = (c as any).positiveOutcomes ?? 0;
                const meetingsCount = (c as any).meetingsBooked ?? 0;
                const oType = c.outreachType as CampaignOutreachType | undefined;

                return (
                  <Link
                    key={c.id}
                    to={`/campaigns/${c.id}`}
                    className="flex flex-col gap-2 p-4 transition-colors hover:bg-surface-muted/50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="truncate text-xs font-semibold text-ink">{c.name}</span>
                        <CampaignStatusBadge status={c.status} />
                        {oType && (
                          <span className="rounded bg-surface-sunken border border-line px-1.5 py-0.2 text-[10px] font-medium text-ink-subtle">
                            {CAMPAIGN_OUTREACH_TYPE_LABELS[oType] || oType}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-ink-subtle">
                        {c.list.name} ({plural(c.list.memberCount, "contact")}) · {c.template.name}
                        {c.createdBy && ` · Owner: ${c.createdBy.name}`}
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

                      <div className="text-right min-w-[70px]">
                        <p className="font-semibold text-ink">{num(c.counts.replied)} replies</p>
                        <p className="text-[11px] text-brand font-medium">{repRate} reply rate</p>
                      </div>

                      <div className="text-right min-w-[80px]">
                        <p className="font-semibold text-emerald-600">{num(posOutcomes)} positive</p>
                        <p className="text-[11px] text-ink-subtle">{num(meetingsCount)} meetings</p>
                      </div>

                      <ArrowUpRight className="h-4 w-4 text-ink-faint" />
                    </div>
                  </Link>
                );
              })
            ) : (
              <div className="px-5 py-8 text-center text-xs text-ink-subtle">
                No campaigns match the selected filters or are actively sending right now.
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
