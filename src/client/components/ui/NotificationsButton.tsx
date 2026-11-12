import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Bell, Clock, FileCheck, Inbox, Mail, ShieldAlert } from "lucide-react";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { useActivity, useOverview } from "../../lib/queries";
import { useAuth } from "../../lib/auth";

interface NotificationItem {
  id: string;
  title: string;
  description: string;
  time: string;
  tone: "alert" | "warning" | "action" | "info";
  link?: string;
}

const STORAGE_KEY = "focusrealm_read_notifications";

function getReadSet(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // ignore
  }
  return new Set();
}

function saveReadSet(set: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

export function NotificationsButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [readIds, setReadIds] = useState<Set<string>>(() => getReadSet());
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { can } = useAuth();

  const overview = useOverview();
  const activity = useActivity(1, can("audit.view"));

  // Build real live notifications from system state and audit logs
  const notifications = useMemo<NotificationItem[]>(() => {
    const items: NotificationItem[] = [];
    const ov = overview.data?.data;

    if (ov) {
      // 1. High-priority items needing attention (failed sends, unverified)
      for (const n of ov.needsAttention) {
        if (n.failed > 0) {
          items.push({
            id: `fail-${n.campaign.id}`,
            title: `${n.campaign.name}: ${n.failed} failed delivery`,
            description: "Some recipients bounced or encountered errors. Review delivery details.",
            time: new Date().toISOString(),
            tone: "alert",
            link: `/campaigns/${n.campaign.id}?tab=recipients&filter=failed`,
          });
        }
        if (n.unknown > 0) {
          items.push({
            id: `unknown-${n.campaign.id}`,
            title: `${n.campaign.name}: ${n.unknown} unverified messages`,
            description: "Delivery status could not be confirmed automatically. Manual review needed.",
            time: new Date().toISOString(),
            tone: "warning",
            link: `/campaigns/${n.campaign.id}?tab=recipients&filter=unknown`,
          });
        }
      }

      // 2. Campaigns awaiting approval
      for (const c of ov.awaitingApproval) {
        items.push({
          id: `approval-${c.id}`,
          title: `Approval needed: ${c.name}`,
          description: `Prepared with ${c.template.name} for ${c.list.name}. Awaiting founder sign-off.`,
          time: c.updatedAt,
          tone: "action",
          link: `/campaigns/${c.id}`,
        });
      }

      // 3. Mailbox alerts
      if (ov.mailbox.liveSendingBlocker) {
        items.push({
          id: "mailbox-blocker",
          title: "Mailbox alert",
          description: ov.mailbox.liveSendingBlocker,
          time: new Date().toISOString(),
          tone: "warning",
          link: "/settings/mailbox",
        });
      } else if (ov.mailbox.liveSendingEnabled) {
        items.push({
          id: "mailbox-live",
          title: "Mailbox active",
          description: `Connected to SpaceMail. ${ov.mailbox.sentLast24h} of ${ov.mailbox.dailyLimit} daily sent.`,
          time: new Date().toISOString(),
          tone: "info",
          link: "/settings/mailbox",
        });
      }
    }

    // 4. Real audit activity events (recent team actions)
    const actRows = activity.data?.data ?? [];
    for (const a of actRows.slice(0, 6)) {
      items.push({
        id: `act-${a.id}`,
        title: a.summary,
        description: `Action by ${a.user?.name ?? "Teammate"}`,
        time: a.createdAt,
        tone: "info",
        link: a.entityType === "campaign" ? `/campaigns/${a.entityId}` : undefined,
      });
    }

    return items;
  }, [overview.data, activity.data]);

  const unreadCount = notifications.filter((i) => !readIds.has(i.id)).length;

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const markAllRead = () => {
    const next = new Set([...readIds, ...notifications.map((n) => n.id)]);
    setReadIds(next);
    saveReadSet(next);
  };

  const handleItemClick = (item: NotificationItem) => {
    const next = new Set(readIds);
    next.add(item.id);
    setReadIds(next);
    saveReadSet(next);
    setOpen(false);
    if (item.link) {
      navigate(item.link);
    }
  };

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        aria-expanded={open}
        className={cn(
          "relative flex h-8 w-8 items-center justify-center rounded-lg border transition-all duration-150 focus-visible:outline-none focus-visible:shadow-focus select-none",
          open
            ? "border-line-strong bg-surface-muted text-ink shadow-xs"
            : "border-line bg-surface text-ink-muted hover:border-line-strong hover:bg-surface-muted hover:text-ink shadow-xs"
        )}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-surface" />
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications list"
          className="absolute right-0 top-full mt-2 w-84 rounded-xl border border-line bg-surface p-1 shadow-pop animate-pop-in z-dropdown"
        >
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Notifications</span>
              {unreadCount > 0 && (
                <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand-ink">
                  {unreadCount} new
                </span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-2xs font-semibold text-brand hover:text-brand-hover hover:underline transition-colors"
              >
                Mark all as read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-line/60">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Inbox className="h-6 w-6 text-ink-faint mb-2" />
                <p className="text-xs font-medium text-ink-muted">No notifications</p>
                <p className="text-2xs text-ink-subtle mt-0.5">Your workspace is completely up to date.</p>
              </div>
            ) : (
              notifications.map((item) => {
                const isRead = readIds.has(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleItemClick(item)}
                    className={cn(
                      "flex w-full items-start gap-3 p-3 text-left transition-colors duration-150 select-none",
                      !isRead ? "bg-brand-soft/30 hover:bg-brand-soft/50" : "hover:bg-surface-muted"
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs shadow-2xs",
                        item.tone === "alert" && "bg-danger-soft text-danger",
                        item.tone === "warning" && "bg-warning-soft text-warning",
                        item.tone === "action" && "bg-brand-soft text-brand-ink",
                        item.tone === "info" && "bg-surface-sunken text-ink-subtle"
                      )}
                    >
                      {item.tone === "alert" && <ShieldAlert className="h-3 w-3" />}
                      {item.tone === "warning" && <AlertTriangle className="h-3 w-3" />}
                      {item.tone === "action" && <FileCheck className="h-3 w-3" />}
                      {item.tone === "info" && <Mail className="h-3 w-3" />}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <p className={cn("text-xs font-semibold truncate", !isRead ? "text-ink" : "text-ink-muted")}>
                          {item.title}
                        </p>
                        {!isRead && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />}
                      </div>
                      <p className="text-2xs text-ink-subtle leading-relaxed mt-0.5 line-clamp-2">{item.description}</p>
                      <span className="mt-1 flex items-center gap-1 text-[10px] text-ink-faint">
                        <Clock className="h-2.5 w-2.5" />
                        {timeAgo(item.time)}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
