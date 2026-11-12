// Inline feedback: callouts, empty states, error states, progress
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

type CalloutTone = "info" | "success" | "warning" | "danger" | "gold";

const calloutStyles: Record<CalloutTone, { box: string; icon: LucideIcon; iconClass: string }> = {
  info: { box: "border-brand/20 bg-brand-soft/70", icon: Info, iconClass: "text-brand" },
  success: { box: "border-success/20 bg-success-soft", icon: CheckCircle2, iconClass: "text-success" },
  warning: { box: "border-warning/25 bg-warning-soft", icon: AlertTriangle, iconClass: "text-warning" },
  danger: { box: "border-danger/20 bg-danger-soft", icon: XCircle, iconClass: "text-danger" },
  gold: { box: "border-gold/30 bg-gold-soft", icon: Info, iconClass: "text-gold-ink" },
};

export function Callout({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const s = calloutStyles[tone];
  const Icon = s.icon;
  return (
    <div className={cn("flex gap-3 rounded-xl border px-4 py-3 shadow-xs", s.box, className)} role={tone === "danger" ? "alert" : "status"}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", s.iconClass)} aria-hidden="true" />
      <div className="min-w-0 flex-1 text-[13px] leading-5">
        {title && <p className="font-semibold text-ink">{title}</p>}
        {children && <div className={cn("text-ink-muted leading-relaxed", title ? "mt-0.5" : undefined)}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-14 text-center", className)}>
      {Icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-sunken border border-line text-brand shadow-xs">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
      )}
      <p className="text-base font-semibold text-ink">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-ink-subtle">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div className={cn("flex flex-col items-center px-6 py-14 text-center", className)} role="alert">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger border border-danger/20 shadow-xs">
        <XCircle className="h-5 w-5" aria-hidden="true" />
      </div>
      <p className="text-base font-semibold text-ink">Couldn't load this</p>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-ink-subtle">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function ProgressBar({
  segments,
  className,
  label,
}: {
  segments: { value: number; className: string; label: string }[];
  className?: string;
  label?: string;
}) {
  const total = Math.max(1, segments.reduce((sum, s) => sum + s.value, 0));
  return (
    <div
      className={cn("flex h-2 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-line/50", className)}
      role="img"
      aria-label={label ?? segments.map((s) => `${s.label}: ${s.value}`).join(", ")}
    >
      {segments.map((s) =>
        s.value > 0 ? (
          <div
            key={s.label}
            className={cn("h-full transition-[width] duration-300 ease-out", s.className)}
            style={{ width: `${(s.value / total) * 100}%` }}
          />
        ) : null
      )}
    </div>
  );
}
