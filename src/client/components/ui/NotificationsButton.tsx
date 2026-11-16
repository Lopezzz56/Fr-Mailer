import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  Clock,
  FileCheck,
  Inbox,
  Mail,
  ShieldAlert,
  UserPlus,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { timeAgo } from "../../lib/format";
import { useNotifications } from "../../lib/queries";
import { useAuth } from "../../lib/auth";
import type { NotificationItemDto } from "@shared/types";

function getStorageKey(userId?: string): string {
  return userId ? `focusrealm_read_notifications_${userId}` : "focusrealm_read_notifications";
}

function getReadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    // ignore corrupted storage
  }
  return new Set();
}

function saveReadSet(key: string, set: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

export function NotificationsButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const storageKey = getStorageKey(user?.id);
  const [readIds, setReadIds] = useState<Set<string>>(() => getReadSet(storageKey));
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Reload read set if authenticated user changes
  useEffect(() => {
    setReadIds(getReadSet(storageKey));
  }, [storageKey]);

  const { data, isLoading } = useNotifications();
  const notifications: NotificationItemDto[] = data?.data ?? [];

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
    saveReadSet(storageKey, next);
  };

  const markItemRead = (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const next = new Set(readIds);
    next.add(id);
    setReadIds(next);
    saveReadSet(storageKey, next);
  };

  const handleItemClick = (item: NotificationItemDto) => {
    markItemRead(item.id);
    setOpen(false);
    if (item.link) {
      navigate(item.link);
    }
  };

  const renderIcon = (item: NotificationItemDto) => {
    if (item.category === "assignment") {
      return <UserPlus className="h-3 w-3" />;
    }
    switch (item.tone) {
      case "alert":
        return <ShieldAlert className="h-3 w-3" />;
      case "warning":
        return <AlertTriangle className="h-3 w-3" />;
      case "action":
        return <FileCheck className="h-3 w-3" />;
      case "success":
        return <CheckCircle2 className="h-3 w-3" />;
      case "info":
      default:
        return <Mail className="h-3 w-3" />;
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
          aria-label="Actionable notifications"
          className="absolute right-0 top-full mt-2 w-88 rounded-xl border border-line bg-surface p-1 shadow-pop animate-pop-in z-dropdown"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Notifications</span>
              {unreadCount > 0 ? (
                <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-bold text-brand-ink">
                  {unreadCount} actionable
                </span>
              ) : (
                <span className="text-[10px] text-ink-subtle">Actionable events</span>
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

          {/* List */}
          <div className="max-h-84 overflow-y-auto divide-y divide-line/60">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <p className="text-xs text-ink-muted">Checking notifications...</p>
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center px-4">
                <Inbox className="h-6 w-6 text-ink-faint mb-2" />
                <p className="text-xs font-medium text-ink-muted">No actionable notifications</p>
                <p className="text-2xs text-ink-subtle mt-0.5 max-w-xs">
                  All clear! New replies, overdue follow-ups, and approvals will appear here.
                </p>
              </div>
            ) : (
              notifications.map((item) => {
                const isRead = readIds.has(item.id);
                return (
                  <div
                    key={item.id}
                    className={cn(
                      "group relative flex w-full items-start gap-3 p-3 text-left transition-colors duration-150 select-none cursor-pointer",
                      !isRead ? "bg-brand-soft/20 hover:bg-brand-soft/40" : "hover:bg-surface-muted"
                    )}
                    onClick={() => handleItemClick(item)}
                  >
                    {/* Badge Icon */}
                    <span
                      className={cn(
                        "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs shadow-2xs",
                        item.tone === "alert" && "bg-danger-soft text-danger",
                        item.tone === "warning" && "bg-warning-soft text-warning",
                        item.tone === "action" && "bg-brand-soft text-brand-ink",
                        item.tone === "success" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                        item.tone === "info" && "bg-surface-sunken text-ink-subtle"
                      )}
                    >
                      {renderIcon(item)}
                    </span>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <p className={cn("text-xs truncate", !isRead ? "font-semibold text-ink" : "font-medium text-ink-muted")}>
                          {item.title}
                        </p>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {!isRead && (
                            <span
                              className="h-1.5 w-1.5 rounded-full bg-brand"
                              title="Unread"
                            />
                          )}
                          {!isRead && (
                            <button
                              type="button"
                              onClick={(e) => markItemRead(item.id, e)}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-faint hover:text-ink transition-opacity"
                              title="Mark as read"
                              aria-label="Mark as read"
                            >
                              <Check className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>

                      <p className="text-2xs text-ink-subtle leading-relaxed mt-0.5 line-clamp-2">
                        {item.description}
                      </p>

                      <div className="mt-1 flex items-center justify-between text-[10px]">
                        <span
                          className="flex items-center gap-1 text-ink-faint"
                          title={new Date(item.time).toLocaleString()}
                        >
                          <Clock className="h-2.5 w-2.5" />
                          {timeAgo(item.time)}
                        </span>
                        {item.linkLabel && (
                          <span className="text-brand font-medium group-hover:underline">
                            {item.linkLabel} →
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer linking explicitly to the Activity Log */}
          <div className="border-t border-line bg-surface-muted/50 px-3.5 py-2 flex items-center justify-between text-2xs text-ink-subtle">
            <span>Routine activity (imports, edits, sends)</span>
            <Link
              to="/settings/activity"
              onClick={() => setOpen(false)}
              className="font-medium text-brand hover:text-brand-hover inline-flex items-center gap-1 hover:underline ml-2 shrink-0"
            >
              Activity Log <ArrowRight className="h-2.5 w-2.5" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
