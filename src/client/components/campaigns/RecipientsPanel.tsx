// Per-recipient delivery log with filters, and a drawer showing the exact message sent
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Download, Mail, MessageSquareReply, OctagonX, UserMinus } from "lucide-react";
import type { CampaignCounts, SendDto } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { useInvalidate, useSends, type SendDetail } from "../../lib/queries";
import { useDebounced } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { Card } from "../ui/Card";
import { Badge, DeliveryStatusBadge } from "../ui/Badge";
import { Button, buttonClasses } from "../ui/Button";
import { Checkbox, SearchInput, SelectField, TextField } from "../ui/Field";
import { DataTable, Pagination, type Column } from "../ui/DataTable";
import { FilterChips } from "../ui/Navigation";
import { Callout, EmptyState, ErrorState } from "../ui/Feedback";
import { Drawer } from "../ui/Overlay";
import { PageLoader } from "../ui/Spinner";
import { useToast } from "../ui/Toast";
import { EmailPreview } from "../email/EmailPreview";

type FilterKey = "all" | "pending" | "sent" | "failed" | "unknown" | "skipped" | "cancelled" | "bounced" | "replied" | "unsubscribed";

const EVENT_LABELS: Record<string, string> = { HARD_BOUNCE: "Bounced", SOFT_BOUNCE: "Delivery delayed", REPLY: "Replied", UNSUBSCRIBE: "Unsubscribed" };

function Engagement({ s }: { s: SendDto }) {
  return (
    <div className="flex gap-1.5">
      {s.repliedAt && <Badge tone="success"><MessageSquareReply className="h-3 w-3" /> Replied</Badge>}
      {s.bouncedAt && <Badge tone="danger"><OctagonX className="h-3 w-3" /> Bounced</Badge>}
      {s.unsubscribedAt && <Badge tone="neutral"><UserMinus className="h-3 w-3" /> Unsubscribed</Badge>}
    </div>
  );
}

function OutcomeReviewForm({
  campaignId,
  sendId,
  send,
}: {
  campaignId: string;
  sendId: string;
  send: SendDetail;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();

  // Find latest reply event detail if any
  const replyEvent = [...send.events].reverse().find((e) => e.type === "REPLY");
  const detail = (replyEvent?.detail as Record<string, unknown> | undefined) ?? {};

  const [classification, setClassification] = useState<string>(
    String(detail.classification || "")
  );
  const [meetingBooked, setMeetingBooked] = useState<boolean>(
    Boolean(detail.meetingBooked)
  );
  const [note, setNote] = useState<string>(String(detail.note || ""));

  const save = useMutation({
    mutationFn: () =>
      api.post(`/api/campaigns/${campaignId}/sends/${sendId}/outcome`, {
        replyClassification: classification ? classification : undefined,
        meetingBooked,
        note: note ? note : undefined,
      }),
    onSuccess: async () => {
      await invalidate("campaigns", "overview");
      toast.success("Outcome saved", "Attribution metrics updated.");
    },
    onError: (err) => toast.error("Could not save outcome", errorMessage(err)),
  });

  return (
    <div className="rounded-lg border border-line bg-surface-sunken/40 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-ink uppercase tracking-wider">
          Reply Outcome & Meeting Review
        </span>
        {classification && (
          <Badge
            tone={
              classification === "POSITIVE"
                ? "success"
                : classification === "NEGATIVE"
                ? "danger"
                : classification === "OUT_OF_OFFICE"
                ? "warning"
                : "neutral"
            }
          >
            {classification}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <SelectField
          label="Sentiment Classification"
          value={classification}
          onChange={(e) => setClassification(e.target.value)}
          options={[
            { value: "", label: "Unclassified" },
            { value: "POSITIVE", label: "Positive interest" },
            { value: "NEUTRAL", label: "Neutral / Needs follow-up" },
            { value: "NEGATIVE", label: "Negative / Not interested" },
            { value: "OUT_OF_OFFICE", label: "Out of office / Away" },
          ]}
        />
        <div className="pt-5">
          <Checkbox
            label="Meeting booked from this outreach"
            checked={meetingBooked}
            onChange={(e) => setMeetingBooked(e.target.checked)}
          />
        </div>
      </div>

      <TextField
        label="Notes / Next steps"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="e.g. Call booked for Thursday 2pm with GM"
      />

      <div className="flex justify-end">
        <Button
          size="sm"
          variant="primary"
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save Outcome
        </Button>
      </div>
    </div>
  );
}

function SendDrawer({ campaignId, sendId, fromLine, onClose }: { campaignId: string; sendId: string; fromLine: string; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const invalidate = useInvalidate();
  const send = useQuery({ queryKey: ["campaigns", "send", sendId], queryFn: () => api.get<SendDetail>(`/api/campaigns/${campaignId}/sends/${sendId}`) });
  const resolve = useMutation({
    mutationFn: (outcome: "sent" | "retry") => api.post(`/api/campaigns/${campaignId}/sends/${sendId}/resolve`, { outcome }),
    onSuccess: async (_r, outcome) => {
      await invalidate("campaigns", "overview");
      toast.success(outcome === "sent" ? "Marked as delivered" : "Queued to send again");
      onClose();
    },
    onError: (err) => toast.error("Couldn't update", errorMessage(err)),
  });

  const s = send.data?.data;
  return (
    <Drawer open onClose={onClose} title={s?.email ?? "Message"} subtitle={s && <DeliveryStatusBadge status={s.status} />} width="lg">
      {send.isPending ? (
        <PageLoader />
      ) : send.isError ? (
        <ErrorState error={send.error} onRetry={() => send.refetch()} />
      ) : (
        s && (
          <div className="space-y-5">
            {s.status === "UNKNOWN" && (
              <Callout tone="warning" title="We can't tell whether this was delivered">
                <p>The connection broke while handing this message to the mailbox, so it may or may not have gone out. Check the Sent folder in SpaceMail, then choose:</p>
                {can("campaigns.control") && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => resolve.mutate("sent")} loading={resolve.isPending && resolve.variables === "sent"}>
                      It was delivered
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => resolve.mutate("retry")} loading={resolve.isPending && resolve.variables === "retry"}>
                      It wasn't — send again
                    </Button>
                  </div>
                )}
              </Callout>
            )}
            {s.skipReason && <Callout tone="info" title="Skipped">{s.skipReason}</Callout>}
            {s.lastError && s.status !== "UNKNOWN" && <Callout tone="danger" title="Delivery problem">{s.lastError}</Callout>}

            <dl className="grid grid-cols-2 gap-4 text-[13px]">
              <div><dt className="text-xs text-ink-subtle">Sent</dt><dd className="mt-0.5">{formatDateTime(s.sentAt)}</dd></div>
              <div><dt className="text-xs text-ink-subtle">Attempts</dt><dd className="mt-0.5 tabular">{s.attempts}</dd></div>
            </dl>

            {/* Outcome and Reply Management */}
            {can("campaigns.manage") && (Boolean(s.repliedAt) || s.events.some((e) => e.type === "REPLY")) && (
              <OutcomeReviewForm campaignId={campaignId} sendId={sendId} send={s} />
            )}

            {s.events.length > 0 && (
              <div>
                <p className="mb-2 text-[13px] font-medium">What happened next</p>
                <ol className="space-y-2">
                  {s.events.map((e) => {
                    const d = (e.detail as Record<string, unknown>) || {};
                    const cls = String(d.classification || "");
                    const isMeeting = Boolean(d.meetingBooked);
                    return (
                      <li key={e.id} className="rounded-lg border border-line px-3 py-2 text-[13px]">
                        <div className="flex justify-between items-center gap-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</span>
                            {cls && (
                              <Badge
                                tone={
                                  cls === "POSITIVE"
                                    ? "success"
                                    : cls === "NEGATIVE"
                                    ? "danger"
                                    : cls === "OUT_OF_OFFICE"
                                    ? "warning"
                                    : "neutral"
                                }
                              >
                                {cls}
                              </Badge>
                            )}
                            {isMeeting && <Badge tone="brand">Meeting Booked</Badge>}
                          </div>
                          <span className="text-xs text-ink-subtle">{formatDateTime(e.occurredAt)}</span>
                        </div>
                        {Boolean(d.snippet || d.diagnostic) && (
                          <p className="mt-1 text-xs text-ink-muted leading-relaxed">
                            {String(d.snippet ?? d.diagnostic)}
                          </p>
                        )}
                        {Boolean(d.note) && (
                          <p className="mt-1 text-xs text-ink italic">Note: {String(d.note)}</p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}

            {s.html ? (
              <EmailPreview from={fromLine} to={s.email} subject={s.subject} html={s.html} text={s.text} height={380} />
            ) : (
              <p className="text-[13px] text-ink-subtle">No message was prepared for this recipient.</p>
            )}
          </div>
        )
      )}
    </Drawer>
  );
}

export function RecipientsPanel({ campaignId, counts, live, fromLine, initialFilter }: { campaignId: string; counts: CampaignCounts; live: boolean; fromLine: string; initialFilter?: string }) {
  const [filter, setFilter] = useState<FilterKey>((initialFilter as FilterKey) || "all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const sends = useSends(campaignId, { page, filter, search: useDebounced(search) }, live);

  const options: { key: FilterKey; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.total },
    { key: "pending", label: "Queued", count: counts.pending },
    { key: "sent", label: "Sent", count: counts.sent },
    { key: "failed", label: "Failed", count: counts.failed },
    { key: "unknown", label: "Needs review", count: counts.unknown },
    { key: "skipped", label: "Skipped", count: counts.skipped },
    { key: "cancelled", label: "Cancelled", count: counts.cancelled },
    { key: "replied", label: "Replied", count: counts.replied },
    { key: "bounced", label: "Bounced", count: counts.bounced },
    { key: "unsubscribed", label: "Unsubscribed", count: counts.unsubscribed },
  ];

  const columns: Column<SendDto>[] = [
    { key: "email", header: "Recipient", cell: (s) => <span className="font-medium">{s.email}</span> },
    { key: "status", header: "Delivery", cell: (s) => <DeliveryStatusBadge status={s.status} /> },
    { key: "detail", header: "Details", cell: (s) => <span className="line-clamp-1 max-w-xs text-xs text-ink-subtle">{s.skipReason ?? s.lastError ?? ""}</span> },
    { key: "engagement", header: "Response", cell: (s) => <Engagement s={s} /> },
    { key: "sentAt", header: "Sent", cell: (s) => <span className="whitespace-nowrap text-ink-muted">{formatDateTime(s.sentAt)}</span> },
  ];

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
        <FilterChips
          label="Filter recipients"
          value={filter}
          onChange={(k) => {
            setFilter(k);
            setPage(1);
          }}
          options={options.filter((o) => o.key === "all" || o.count > 0)}
        />
        <div className="flex items-center gap-2">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Find an email" className="w-56" />
          <a href={`/api/campaigns/${campaignId}/export`} className={buttonClasses("secondary", "md")} download>
            <Download className="h-4 w-4" /> Export
          </a>
        </div>
      </div>
      {sends.isError ? (
        <ErrorState error={sends.error} onRetry={() => sends.refetch()} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={sends.data?.data}
            rowKey={(s) => s.id}
            loading={sends.isPending}
            onRowClick={(s) => setOpenId(s.id)}
            caption="Recipients"
            empty={<EmptyState icon={Mail} title="No recipients here" description="Nothing matches this filter." />}
          />
          <Pagination pagination={sends.data?.pagination} onPage={setPage} />
        </>
      )}
      {openId && <SendDrawer campaignId={campaignId} sendId={openId} fromLine={fromLine} onClose={() => setOpenId(null)} />}
    </Card>
  );
}
