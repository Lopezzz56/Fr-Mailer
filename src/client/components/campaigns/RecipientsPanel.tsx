// Per-recipient delivery log with filters, and a drawer showing the exact message sent
import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  Mail,
  MessageSquare,
  Pause,
  Play,
  Square,
  XCircle,
} from "lucide-react";
import {
  RECIPIENT_SEQUENCE_STATE_LABELS,
  CONVERSATION_STATUS_LABELS,
  CONVERSATION_STATUS_TONES,
  type CampaignCounts,
  type CampaignRecipientSummaryDto,
  type SendDto,
  type CampaignRecipientStateDto,
  type RecipientSequenceState,
  type ConversationDto,
  type ConversationStatus,
} from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { useInvalidate, useCampaignRecipients, type SendDetail } from "../../lib/queries";
import { useDebounced } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { formatDateTime } from "../../lib/format";
import { cn } from "../../lib/cn";
import { Card } from "../ui/Card";
import { Badge, DeliveryStatusBadge } from "../ui/Badge";
import { Button, buttonClasses } from "../ui/Button";
import { SearchInput, TextField } from "../ui/Field";
import { DataTable, Pagination, type Column } from "../ui/DataTable";
import { FilterChips } from "../ui/Navigation";
import { Callout, EmptyState, ErrorState } from "../ui/Feedback";
import { DeliveryProblemCallout } from "./DeliveryProblemCallout";
import { Drawer } from "../ui/Overlay";
import { PageLoader } from "../ui/Spinner";
import { useToast } from "../ui/Toast";
import { EmailPreview } from "../email/EmailPreview";

type FilterKey =
  | "all"
  | "awaiting_approval"
  | "scheduled"
  | "pending"
  | "sent"
  | "failed"
  | "unknown"
  | "skipped"
  | "cancelled"
  | "bounced"
  | "replied"
  | "unsubscribed";

type ConversationFilterKey = "all" | ConversationStatus;

const EVENT_LABELS: Record<string, string> = { HARD_BOUNCE: "Bounced", SOFT_BOUNCE: "Delivery delayed", REPLY: "Replied", UNSUBSCRIBE: "Unsubscribed" };

function ConversationReplyWorkspace({
  campaignId,
  recipientEmail,
  send: _send,
  fromLine: _fromLine,
}: {
  campaignId: string;
  recipientEmail: string;
  send: SendDetail;
  fromLine: string;
}) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { can } = useAuth();

  const convQuery = useQuery({
    queryKey: ["campaigns", campaignId, "recipient-conversation", recipientEmail],
    queryFn: () =>
      api
        .get<ConversationDto>(
          `/api/campaigns/${campaignId}/recipients/${encodeURIComponent(recipientEmail)}/conversation`
        )
        .then((r) => r.data),
    staleTime: 5000,
  });

  const conv = convQuery.data;

  const [status, setStatus] = useState<ConversationStatus | "">("");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [meetingBooked, setMeetingBooked] = useState(false);
  const [expandedHtmlMsgId, setExpandedHtmlMsgId] = useState<string | null>(null);
  const [expandedQuotedMsgId, setExpandedQuotedMsgId] = useState<string | null>(null);

  useEffect(() => {
    if (conv) {
      setStatus(conv.status);
      setOutcomeNote(conv.outcome || "");
      setMeetingBooked(conv.status === "MEETING_SCHEDULED" || Boolean(conv.meetingAt));
    }
  }, [conv?.id, conv?.status, conv?.outcome, conv?.meetingAt]);

  const updateConv = useMutation({
    mutationFn: (data: Partial<{
      status: ConversationStatus;
      outcome: string | null;
      meetingAt: string | null;
    }>) =>
      api.patch<ConversationDto>(`/api/conversations/${conv!.id}`, {
        ...data,
      }),
    onSuccess: async () => {
      await convQuery.refetch();
      toast.success("Outcome updated", "Conversation status updated.");
      // Invalidate caches in background without blocking button state
      invalidate("campaigns");
      invalidate("overview");
    },
    onError: (err) => toast.error("Could not update conversation", errorMessage(err)),
  });

  if (convQuery.isPending) {
    return (
      <div className="rounded-xl border border-line bg-surface p-4 text-center">
        <p className="text-xs text-ink-muted">Loading conversation...</p>
      </div>
    );
  }

  if (!conv) {
    return null;
  }

  const messages = conv.messages || [];
  const statusTone = CONVERSATION_STATUS_TONES[conv.status] || "neutral";

  return (
    <div className="space-y-4">
      {/* 1. Header Information: Contact, Campaign, Current Status */}
      <div className="rounded-xl border border-line bg-surface p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
          <div>
            <span className="text-2xs font-semibold uppercase tracking-wider text-ink-subtle">Contact</span>
            <div className="text-sm font-semibold text-ink">
              {conv.contactName ? `${conv.contactName} (${conv.recipientEmail})` : conv.recipientEmail}
            </div>
            {conv.campaignName && (
              <div className="text-xs text-ink-subtle mt-0.5">
                Campaign: <span className="text-ink font-medium">{conv.campaignName}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xs font-semibold uppercase tracking-wider text-ink-subtle">Current Status:</span>
            <Badge tone={statusTone}>
              {CONVERSATION_STATUS_LABELS[conv.status] || conv.status}
            </Badge>
          </div>
        </div>

        {/* 2. Action Section: Status / Outcome, Meeting Booked, Note */}
        {can("campaigns.manage") && (
          <div className="space-y-3 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink uppercase tracking-wider">
                Update Outcome
              </span>
              <span className="text-2xs text-ink-subtle">
                Updates dashboard metrics immediately
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
              <div>
                <label htmlFor="conv-status-select" className="block text-xs font-medium text-ink-subtle mb-1">
                  Status / Outcome
                </label>
                <select
                  id="conv-status-select"
                  value={status}
                  onChange={(e) => {
                    const newStatus = e.target.value as ConversationStatus;
                    setStatus(newStatus);
                    if (newStatus === "MEETING_SCHEDULED") {
                      setMeetingBooked(true);
                    } else if (newStatus === "NOT_INTERESTED" || newStatus === "CLOSED") {
                      setMeetingBooked(false);
                    }
                  }}
                  disabled={updateConv.isPending}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-xs font-medium text-ink hover:border-line-strong focus:outline-none focus:ring-1 focus:ring-brand"
                >
                  <option value="NEEDS_REPLY">Needs Reply</option>
                  <option value="WAITING_FOR_CONTACT">Waiting for Contact</option>
                  <option value="MEETING_COORDINATION">Meeting Coordination</option>
                  <option value="MEETING_SCHEDULED">Meeting Scheduled</option>
                  <option value="INTERESTED">Interested</option>
                  <option value="NOT_INTERESTED">Not Interested</option>
                  <option value="CLOSED">Closed</option>
                </select>
              </div>

              <div className="flex items-center gap-2 h-9 px-3 rounded-lg border border-line bg-surface-muted/30">
                <input
                  type="checkbox"
                  id="meeting-booked-check"
                  checked={meetingBooked}
                  onChange={(e) => {
                    const isBooked = e.target.checked;
                    setMeetingBooked(isBooked);
                    if (isBooked && (status === "NEEDS_REPLY" || status === "WAITING_FOR_CONTACT" || status === "MEETING_COORDINATION" || !status)) {
                      setStatus("MEETING_SCHEDULED");
                    }
                  }}
                  disabled={updateConv.isPending}
                  className="h-4 w-4 rounded border-line text-brand focus:ring-brand"
                />
                <label htmlFor="meeting-booked-check" className="text-xs font-medium text-ink cursor-pointer select-none">
                  Meeting Booked
                </label>
              </div>
            </div>

            <div>
              <TextField
                label="Note (Optional)"
                placeholder="e.g. Intro call planned next week or requested pricing deck..."
                value={outcomeNote}
                onChange={(e) => setOutcomeNote(e.target.value)}
              />
            </div>

            <div className="flex justify-end pt-1">
              <Button
                size="sm"
                variant="primary"
                loading={updateConv.isPending}
                onClick={() =>
                  updateConv.mutate({
                    status: (status as ConversationStatus) || undefined,
                    meetingAt: meetingBooked ? (conv.meetingAt || new Date().toISOString()) : null,
                    outcome: outcomeNote.trim() || null,
                  })
                }
              >
                Save Outcome
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* 3. What they replied / Conversation Messages */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            Conversation ({messages.length} message{messages.length === 1 ? "" : "s"})
          </h3>
          <span className="text-[11px] text-ink-faint">
            Latest reply: {formatDateTime(conv.lastMessageAt)}
          </span>
        </div>

        {messages.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface p-4 text-center">
            <p className="text-xs text-ink-subtle">No messages recorded in this conversation yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => {
              const isInbound = m.direction === "INBOUND";
              return (
                <div
                  key={m.id}
                  className={cn(
                    "rounded-xl border p-4 text-xs transition-colors shadow-sm",
                    isInbound
                      ? "border-brand/40 bg-white"
                      : "border-line bg-surface-muted/30"
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/50 pb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                          isInbound
                            ? "bg-brand/10 text-brand"
                            : "bg-surface-muted text-ink-muted border border-line/60"
                        )}
                      >
                        {isInbound ? "Inbound Reply" : "Outbound Sent"}
                      </span>
                      <span className="font-semibold text-ink">
                        {m.senderName ? `${m.senderName} (${m.senderEmail})` : m.senderEmail}
                      </span>
                    </div>
                    <span className="text-[11px] text-ink-subtle">
                      {formatDateTime(m.sentAt)}
                    </span>
                  </div>

                  <div className="mt-2 text-ink-subtle font-medium">
                    Subject: <span className="text-ink font-normal">{m.subject}</span>
                  </div>

                  <div className="mt-2 text-ink leading-relaxed whitespace-pre-wrap font-sans">
                    {m.cleanBody || m.bodyText || m.snippet || "(No content)"}
                  </div>

                  {m.quotedText && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedQuotedMsgId(expandedQuotedMsgId === m.id ? null : m.id)
                        }
                        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-subtle hover:text-ink transition-colors"
                      >
                        <span className="rounded bg-surface-muted px-1.5 py-0.5 border border-line text-2xs font-mono">···</span>
                        <span>{expandedQuotedMsgId === m.id ? "Hide quoted history" : "Show quoted history"}</span>
                      </button>
                      {expandedQuotedMsgId === m.id && (
                        <div className="mt-2 rounded-lg border border-line/60 bg-surface-muted/50 p-3 text-xs text-ink-muted leading-relaxed whitespace-pre-wrap font-sans">
                          {m.quotedText}
                        </div>
                      )}
                    </div>
                  )}

                  {m.bodyHtml && (
                    <div className="mt-2.5 pt-2 border-t border-line/40">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedHtmlMsgId(expandedHtmlMsgId === m.id ? null : m.id)
                        }
                        className="text-[11px] font-medium text-brand hover:underline"
                      >
                        {expandedHtmlMsgId === m.id ? "Hide HTML preview" : "View formatted HTML"}
                      </button>
                      {expandedHtmlMsgId === m.id && (
                        <div
                          className="mt-2 rounded border border-line bg-white p-3 max-h-60 overflow-y-auto"
                          dangerouslySetInnerHTML={{ __html: m.bodyHtml }}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SendDrawer({ campaignId, sendId, fromLine, onClose }: { campaignId: string; sendId: string; fromLine: string; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const invalidate = useInvalidate();
  const send = useQuery({ queryKey: ["campaigns", "send", sendId], queryFn: () => api.get<SendDetail>(`/api/campaigns/${campaignId}/sends/${sendId}`) });
  const s = send.data?.data;

  const seqQuery = useQuery({
    queryKey: ["campaigns", campaignId, "recipient-sequence", s?.email],
    queryFn: () =>
      api
        .get<{
          recipient: CampaignRecipientStateDto | null;
          sends: SendDto[];
          pendingFollowUp: SendDto | null;
          canApprove: boolean;
          canPause: boolean;
          canResume: boolean;
          canStop: boolean;
        }>(`/api/campaigns/${campaignId}/recipients/${encodeURIComponent(s!.email)}/sequence`)
        .then((r) => r.data),
    enabled: Boolean(s?.email),
  });

  const resolve = useMutation({
    mutationFn: (outcome: "sent" | "retry") => api.post(`/api/campaigns/${campaignId}/sends/${sendId}/resolve`, { outcome }),
    onSuccess: async (_r, outcome) => {
      await invalidate("campaigns", "overview");
      toast.success(outcome === "sent" ? "Marked as delivered" : "Queued to send again");
      onClose();
    },
    onError: (err) => toast.error("Couldn't update", errorMessage(err)),
  });

  const approveFollowUp = useMutation({
    mutationFn: (followUpSendId: string) =>
      api.post(`/api/campaigns/${campaignId}/sends/${followUpSendId}/approve`),
    onSuccess: async () => {
      await invalidate("campaigns", "overview");
      await seqQuery.refetch();
      await send.refetch();
      toast.success("Follow-up approved", "Queued for sending when due.");
    },
    onError: (err) => toast.error("Could not approve follow-up", errorMessage(err)),
  });

  const pauseRecipient = useMutation({
    mutationFn: () =>
      api.post(`/api/campaigns/${campaignId}/recipients/${encodeURIComponent(s!.email)}/pause`),
    onSuccess: async () => {
      await invalidate("campaigns", "overview");
      await seqQuery.refetch();
      toast.success("Recipient sequence paused");
    },
    onError: (err) => toast.error("Could not pause recipient", errorMessage(err)),
  });

  const resumeRecipient = useMutation({
    mutationFn: () =>
      api.post(`/api/campaigns/${campaignId}/recipients/${encodeURIComponent(s!.email)}/resume`),
    onSuccess: async () => {
      await invalidate("campaigns", "overview");
      await seqQuery.refetch();
      toast.success("Recipient sequence resumed");
    },
    onError: (err) => toast.error("Could not resume recipient", errorMessage(err)),
  });

  const stopRecipient = useMutation({
    mutationFn: () =>
      api.post(`/api/campaigns/${campaignId}/recipients/${encodeURIComponent(s!.email)}/stop`),
    onSuccess: async () => {
      await invalidate("campaigns", "overview");
      await seqQuery.refetch();
      toast.success("Recipient sequence stopped", "Future follow-ups cancelled.");
    },
    onError: (err) => toast.error("Could not stop recipient", errorMessage(err)),
  });

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
            {s.lastError && s.status !== "UNKNOWN" && (
              <DeliveryProblemCallout
                error={s.lastError}
                onRetry={can("campaigns.control") ? () => resolve.mutate("retry") : undefined}
                isRetrying={resolve.isPending && resolve.variables === "retry"}
              />
            )}

            {/* Recipient Sequence Status & State Controls */}
            {seqQuery.data?.recipient && (
              <div className="rounded-lg border border-line bg-surface-muted/40 p-3.5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-ink">Sequence Status:</span>
                    {(() => {
                      const stateMeta =
                        RECIPIENT_SEQUENCE_STATE_LABELS[
                          seqQuery.data.recipient.state as RecipientSequenceState
                        ];
                      return (
                        <Badge tone={stateMeta?.tone ?? "neutral"}>
                          {stateMeta?.label ?? seqQuery.data.recipient.state}
                        </Badge>
                      );
                    })()}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {seqQuery.data.canPause && can("campaigns.control") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => pauseRecipient.mutate()}
                        loading={pauseRecipient.isPending}
                        icon={<Pause className="h-3 w-3" />}
                      >
                        Pause
                      </Button>
                    )}
                    {seqQuery.data.canResume && can("campaigns.control") && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => resumeRecipient.mutate()}
                        loading={resumeRecipient.isPending}
                        icon={<Play className="h-3 w-3" />}
                      >
                        Resume
                      </Button>
                    )}
                    {seqQuery.data.canStop && can("campaigns.control") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => stopRecipient.mutate()}
                        loading={stopRecipient.isPending}
                        icon={<Square className="h-3 w-3 text-danger" />}
                      >
                        Stop Sequence
                      </Button>
                    )}
                  </div>
                </div>

                {seqQuery.data.recipient.state === "REPLY_RECEIVED" && (
                  <Callout tone="success" title="Reply Received — Automation Stopped">
                    <p className="text-xs">
                      A response was detected from this contact. All scheduled future outreach has been cancelled immediately to prevent automated selling. Human action is required to review and respond.
                    </p>
                  </Callout>
                )}

                {seqQuery.data.canApprove && seqQuery.data.pendingFollowUp && can("campaigns.approve") && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                    <div className="text-xs">
                      <div className="font-semibold text-ink">
                        Follow-up Step {seqQuery.data.pendingFollowUp.stepIndex} awaiting approval
                      </div>
                      <div className="text-[11px] text-ink-muted mt-0.5">
                        Subject: "{seqQuery.data.pendingFollowUp.subject}"
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={approveFollowUp.isPending}
                      onClick={() => approveFollowUp.mutate(seqQuery.data.pendingFollowUp!.id)}
                      icon={<CheckCircle className="h-3.5 w-3.5" />}
                    >
                      Approve Step {seqQuery.data.pendingFollowUp.stepIndex}
                    </Button>
                  </div>
                )}

                {seqQuery.data.recipient.pausedReason && (
                  <div className="text-xs text-ink-muted">
                    <strong>Pause reason:</strong> {seqQuery.data.recipient.pausedReason}
                  </div>
                )}

                {seqQuery.data.sends && seqQuery.data.sends.length > 1 && (
                  <div className="space-y-1.5 pt-1">
                    <span className="text-[11px] font-semibold text-ink-subtle uppercase tracking-wider block">
                      Sequence Touch Timeline
                    </span>
                    <div className="space-y-1">
                      {seqQuery.data.sends.map((stepSend) => (
                        <div
                          key={stepSend.id}
                          className={`flex items-center justify-between rounded border px-2.5 py-1.5 text-xs ${
                            stepSend.id === s.id ? "border-brand bg-brand-soft/20" : "border-line bg-surface"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-ink">
                              {stepSend.stepIndex === 0 ? "Initial" : `Step ${stepSend.stepIndex}`}
                            </span>
                            <span className="text-[11px] text-ink-subtle line-clamp-1 max-w-[200px]">
                              {stepSend.subject}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <DeliveryStatusBadge status={stepSend.status} />
                            <span className="text-[11px] text-ink-subtle">
                              {stepSend.sentAt
                                ? formatDateTime(stepSend.sentAt)
                                : stepSend.scheduledFor
                                ? `Due: ${formatDateTime(stepSend.scheduledFor)}`
                                : "Pending"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <dl className="grid grid-cols-2 gap-4 text-[13px]">
              <div>
                <dt className="text-xs text-ink-subtle">Timing</dt>
                <dd className="mt-0.5">
                  {s.sentAt
                    ? formatDateTime(s.sentAt)
                    : s.scheduledFor
                    ? `Scheduled: ${formatDateTime(s.scheduledFor)}`
                    : "Pending"}
                </dd>
              </div>
              <div><dt className="text-xs text-ink-subtle">Attempts</dt><dd className="mt-0.5 tabular">{s.attempts}</dd></div>
            </dl>

            {/* Reply Workspace & Conversation Operations */}
            {(Boolean(s.repliedAt) || s.events.some((e) => e.type === "REPLY") || Boolean(s.conversation)) && (
              <ConversationReplyWorkspace
                campaignId={campaignId}
                recipientEmail={s.email}
                send={s}
                fromLine={fromLine}
              />
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
                                    : cls === "NEGATIVE" || cls === "UNSUBSCRIBE"
                                    ? "danger"
                                    : cls === "OBJECTION" || cls === "OUT_OF_OFFICE"
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

function RecipientTimeline({
  recipient,
  onOpenSend,
}: {
  recipient: CampaignRecipientSummaryDto;
  onOpenSend: (sendId: string) => void;
}) {
  const conv = recipient.currentConversation;
  return (
    <div className="space-y-3 py-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="font-semibold text-ink">
            {[recipient.contact?.firstName, recipient.contact?.lastName].filter(Boolean).join(" ") || recipient.email}
            {recipient.contact?.company ? ` / ${recipient.contact.company}` : ""}
          </span>
          <span className="text-ink-subtle">Progress: <strong className="text-ink">{recipient.progressLabel}</strong></span>
          <span className="text-ink-subtle">
            Conversation:{" "}
            <strong className="text-ink">
              {conv ? CONVERSATION_STATUS_LABELS[conv.status] ?? conv.status : "No conversation"}
            </strong>
          </span>
        </div>
        <Button size="sm" variant="secondary" onClick={() => onOpenSend(recipient.primarySendId)}>
          {conv ? "Open reply & actions" : "Open email & sequence"}
        </Button>
      </div>

      <ol className="space-y-1.5 border-l-2 border-line pl-3 ml-1">
        {recipient.timeline.map((step) => {
          const isSent = step.status === "SENT";
          const isCancelled = step.status === "CANCELLED";
          const isFailed = step.status === "FAILED";
          const isAwaiting = step.status === "PENDING" && Boolean(step.scheduledFor) && !step.approvedAt;
          const stepTitle = step.stepIndex === 0 ? "Step 1 (Initial)" : `Step ${step.stepIndex + 1}`;
          return (
            <li key={step.id} className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  {isSent ? (
                    <CheckCircle className="h-3.5 w-3.5 text-success shrink-0" />
                  ) : isCancelled || isFailed ? (
                    <XCircle className="h-3.5 w-3.5 text-ink-subtle shrink-0" />
                  ) : isAwaiting ? (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                  ) : (
                    <Clock className="h-3.5 w-3.5 text-ink-subtle shrink-0" />
                  )}
                  <span className="font-semibold text-ink shrink-0">{stepTitle}</span>
                  <DeliveryStatusBadge status={step.status} />
                  {isAwaiting && <Badge tone="warning">Awaiting Approval</Badge>}
                  {step.skipReason && <span className="text-ink-subtle truncate">— {step.skipReason}</span>}
                  {!step.skipReason && step.lastError && (
                    <span className="text-danger truncate">— {step.lastError}</span>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-[11px] text-ink-subtle">
                    {step.sentAt
                      ? formatDateTime(step.sentAt)
                      : step.scheduledFor
                      ? `Scheduled: ${formatDateTime(step.scheduledFor)}`
                      : "Queued"}
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenSend(step.id)}
                    className="text-[11px] font-medium text-brand hover:underline"
                  >
                    Inspect
                  </button>
                </div>
              </div>

              {step.repliedAt && (
                <div className="ml-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-brand/30 bg-brand-soft/20 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-3.5 w-3.5 text-brand shrink-0" />
                    <span className="font-semibold text-ink">Inbound Reply</span>
                    {conv && (
                      <Badge tone={CONVERSATION_STATUS_TONES[conv.status] ?? "neutral"}>
                        {CONVERSATION_STATUS_LABELS[conv.status] ?? conv.status}
                      </Badge>
                    )}
                    {conv?.snippet && <span className="text-ink-muted truncate max-w-md">"{conv.snippet}"</span>}
                  </div>
                  <span className="text-[11px] text-ink-subtle">{formatDateTime(step.repliedAt)}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function RecipientsPanel({
  campaignId,
  counts,
  live,
  fromLine,
  initialFilter,
  initialConversationStatus,
  targetRecipient,
}: {
  campaignId: string;
  counts: CampaignCounts;
  live: boolean;
  fromLine: string;
  initialFilter?: string;
  initialConversationStatus?: string;
  targetRecipient?: string;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [filter, setFilter] = useState<FilterKey>((initialFilter as FilterKey) || "all");
  const [conversationFilter, setConversationFilter] = useState<ConversationFilterKey>(
    (initialConversationStatus as ConversationFilterKey) || "all"
  );
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expandedEmail, setExpandedEmail] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const debouncedSearch = useDebounced(search);
  const recipientsQuery = useCampaignRecipients(
    campaignId,
    {
      page,
      filter,
      conversationStatus: conversationFilter === "all" ? undefined : conversationFilter,
      search: debouncedSearch,
    },
    live
  );

  const payload = recipientsQuery.data?.data;
  const rows = payload?.items;
  const deliveryCounts = payload?.deliveryCounts;
  const convCountsData = payload?.conversationCounts;

  // Auto-open target recipient if supplied via URL
  useEffect(() => {
    if (targetRecipient && rows) {
      const match = rows.find((r) => r.email.toLowerCase() === targetRecipient.toLowerCase());
      if (match) {
        setExpandedEmail(match.email);
        setOpenId(match.primarySendId);
      }
    }
  }, [targetRecipient, rows]);

  // Bulk actions
  const approveAll = useMutation({
    mutationFn: () => api.post<{ approvedCount: number }>(`/api/campaigns/${campaignId}/sends/approve-all`),
    onSuccess: async (res) => {
      await invalidate("campaigns", "overview");
      await recipientsQuery.refetch();
      toast.success("Follow-ups approved", `${res.data.approvedCount} due follow-up emails approved for dispatch.`);
    },
    onError: (err) => toast.error("Could not approve follow-ups", errorMessage(err)),
  });

  const stopAll = useMutation({
    mutationFn: () => api.post<{ cancelledSendsCount: number }>(`/api/campaigns/${campaignId}/sequence/stop-all`),
    onSuccess: async (res) => {
      await invalidate("campaigns", "overview");
      await recipientsQuery.refetch();
      toast.success("All follow-ups stopped", `${res.data.cancelledSendsCount} scheduled follow-ups cancelled.`);
    },
    onError: (err) => toast.error("Could not stop follow-ups", errorMessage(err)),
  });

  const awaitingRecipientCount = deliveryCounts?.awaiting_approval ?? 0;

  const deliveryOptions: { key: FilterKey; label: string; count?: number }[] = [
    { key: "all", label: "All Recipients", count: deliveryCounts?.all ?? counts.uniqueRecipients ?? counts.total },
    { key: "scheduled", label: "Scheduled", count: deliveryCounts?.scheduled },
    { key: "pending", label: "Queued", count: deliveryCounts?.pending },
    { key: "sent", label: "Sent", count: deliveryCounts?.sent },
    { key: "failed", label: "Failed", count: deliveryCounts?.failed },
    { key: "unknown", label: "Needs review", count: deliveryCounts?.unknown },
    { key: "cancelled", label: "Cancelled", count: deliveryCounts?.cancelled },
    { key: "replied", label: "Replied", count: deliveryCounts?.replied },
    { key: "bounced", label: "Bounced", count: deliveryCounts?.bounced },
    { key: "awaiting_approval", label: "Awaiting Approval", count: awaitingRecipientCount },
    { key: "skipped", label: "Skipped", count: deliveryCounts?.skipped },
    { key: "unsubscribed", label: "Unsubscribed", count: deliveryCounts?.unsubscribed },
  ];

  const convCounts = convCountsData?.counts;
  const conversationOptions: { key: ConversationFilterKey; label: string; count?: number }[] = [
    { key: "all", label: "All Conversations", count: convCountsData?.total },
    { key: "NEEDS_REPLY", label: "Needs Reply", count: convCounts?.NEEDS_REPLY ?? 0 },
    { key: "MEETING_SCHEDULED", label: "Meeting Scheduled", count: convCounts?.MEETING_SCHEDULED ?? 0 },
    { key: "INTERESTED", label: "Interested", count: convCounts?.INTERESTED ?? 0 },
    { key: "WAITING_FOR_CONTACT", label: "Waiting for Contact", count: convCounts?.WAITING_FOR_CONTACT ?? 0 },
    { key: "MEETING_COORDINATION", label: "Meeting Coordination", count: convCounts?.MEETING_COORDINATION ?? 0 },
    { key: "NOT_INTERESTED", label: "Not Interested", count: convCounts?.NOT_INTERESTED ?? 0 },
    { key: "CLOSED", label: "Closed", count: convCounts?.CLOSED ?? 0 },
  ];

  const columns: Column<CampaignRecipientSummaryDto>[] = [
    {
      key: "email",
      header: "Recipient",
      cell: (r) => {
        const name = [r.contact?.firstName, r.contact?.lastName].filter(Boolean).join(" ");
        const isExpanded = expandedEmail === r.email;
        return (
          <div className="flex items-start gap-2 min-w-0">
            <span className="mt-0.5 text-ink-subtle shrink-0">
              {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
            <div className="flex flex-col gap-0.5 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-semibold text-ink text-xs truncate max-w-[200px] sm:max-w-none">
                  {name || r.email}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-2xs text-ink-subtle truncate">
                {name && <span className="truncate">{r.email}</span>}
                {name && r.contact?.company && <span>·</span>}
                {r.contact?.company && <span className="truncate font-medium text-ink-muted">{r.contact.company}</span>}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: "progress",
      header: "Delivery & Progress",
      cell: (r) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {r.deliverySummary === "AWAITING_APPROVAL" ? (
              <Badge tone="warning">Awaiting Approval</Badge>
            ) : r.deliverySummary === "SCHEDULED" ? (
              <Badge tone="neutral">Scheduled</Badge>
            ) : (
              <DeliveryStatusBadge status={r.deliverySummary} />
            )}
          </div>
          <span className="text-2xs text-ink-subtle font-medium">{r.progressLabel}</span>
        </div>
      ),
    },
    {
      key: "conversation",
      header: "Conversation",
      headerClassName: "hidden sm:table-cell",
      className: "hidden sm:table-cell",
      cell: (r) => {
        const conv = r.currentConversation;
        if (!conv) {
          return <span className="text-xs text-ink-faint select-none">No conversation</span>;
        }
        const tone = CONVERSATION_STATUS_TONES[conv.status] ?? "neutral";
        const label = CONVERSATION_STATUS_LABELS[conv.status] ?? conv.status;
        return (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge tone={tone}>{label}</Badge>
            {r.conversationCount > 1 && (
              <span className="text-[10px] text-ink-subtle font-medium" title="Multiple threads">
                +{r.conversationCount - 1}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "lastActivity",
      header: "Last Activity",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      cell: (r) => (
        <div className="text-xs">
          <div className="font-medium text-ink">{r.lastActivityLabel}</div>
          {r.lastActivityAt && (
            <div className="text-2xs text-ink-subtle">{formatDateTime(r.lastActivityAt)}</div>
          )}
        </div>
      ),
    },
    {
      key: "nextAction",
      header: "Next Action",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      cell: (r) => (
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs">
            <span className={cn("font-medium", r.currentConversation?.status === "NEEDS_REPLY" ? "text-brand" : "text-ink-muted")}>
              {r.nextActionLabel}
            </span>
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpenId(r.primarySendId);
            }}
            className="text-2xs font-medium text-brand hover:underline shrink-0"
          >
            Open
          </button>
        </div>
      ),
    },
  ];

  return (
    <Card>
      {awaitingRecipientCount > 0 && can("campaigns.approve") && (
        <div className="flex items-center justify-between gap-3 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2.5 text-xs text-amber-900 dark:text-amber-200">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" />
            <span>
              <strong>{awaitingRecipientCount}</strong> recipient{awaitingRecipientCount === 1 ? "" : "s"} with follow-ups awaiting human approval.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={approveAll.isPending}
              onClick={() => approveAll.mutate()}
              icon={<CheckCircle className="h-3.5 w-3.5" />}
            >
              Approve All Due
            </Button>
          </div>
        </div>
      )}

      <div className="border-b border-line p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-semibold text-ink uppercase tracking-wider">
            Unique Recipients ({deliveryCounts?.all ?? counts.uniqueRecipients ?? counts.total})
          </div>
          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            {can("campaigns.control") && (
              <Button
                size="sm"
                variant="ghost"
                loading={stopAll.isPending}
                onClick={() => {
                  if (window.confirm("Stop all scheduled follow-up emails for this campaign?")) {
                    stopAll.mutate();
                  }
                }}
                icon={<Square className="h-3.5 w-3.5 text-danger" />}
                className="w-full sm:w-auto"
              >
                Stop All Follow-ups
              </Button>
            )}
            <SearchInput
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder="Search email, name, company..."
              className="w-full sm:w-64"
            />
            <a
              href={`/api/campaigns/${campaignId}/export`}
              className={cn(buttonClasses("secondary", "md"), "w-full sm:w-auto justify-center")}
              download
            >
              <Download className="h-4 w-4" /> Export
            </a>
          </div>
        </div>

        {/* Delivery Status Filters */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-2xs font-semibold uppercase tracking-wider text-ink-subtle w-24 shrink-0">
            Delivery:
          </span>
          <div className="flex-1 min-w-0">
            <FilterChips
              label="Filter delivery status"
              value={filter}
              onChange={(k) => {
                setFilter(k);
                setPage(1);
              }}
              options={deliveryOptions.filter((o) => o.key === "all" || (o.count !== undefined ? o.count > 0 : true))}
            />
          </div>
        </div>

        {/* Conversation Status Filters */}
        <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-line/60">
          <span className="text-2xs font-semibold uppercase tracking-wider text-ink-subtle w-24 shrink-0">
            Conversation:
          </span>
          <div className="flex-1 min-w-0">
            <FilterChips
              label="Filter conversation status"
              value={conversationFilter}
              onChange={(k) => {
                setConversationFilter(k);
                setPage(1);
              }}
              options={conversationOptions}
            />
          </div>
        </div>
      </div>

      {recipientsQuery.isError ? (
        <ErrorState error={recipientsQuery.error} onRetry={() => recipientsQuery.refetch()} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.email}
            loading={recipientsQuery.isPending}
            onRowClick={(r) => setExpandedEmail(expandedEmail === r.email ? null : r.email)}
            expandedRow={{
              isExpanded: (r) => expandedEmail === r.email,
              render: (r) => <RecipientTimeline recipient={r} onOpenSend={(sid) => setOpenId(sid)} />,
            }}
            caption="Unique campaign recipients"
            empty={<EmptyState icon={Mail} title="No recipients here" description="Nothing matches this filter." />}
          />
          <Pagination pagination={recipientsQuery.data?.pagination} onPage={setPage} />
        </>
      )}
      {openId && <SendDrawer campaignId={campaignId} sendId={openId} fromLine={fromLine} onClose={() => setOpenId(null)} />}
    </Card>
  );
}
