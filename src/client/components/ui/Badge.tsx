import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { CampaignStatus, DeliveryStatus } from "@shared/types";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "brand" | "gold";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-ink-muted ring-1 ring-inset ring-line",
  info: "bg-brand-soft text-brand-ink ring-1 ring-inset ring-brand/20",
  brand: "bg-navy text-white ring-1 ring-inset ring-white/10 dark:bg-brand-soft dark:text-brand-ink",
  gold: "bg-gold-soft text-gold-ink ring-1 ring-inset ring-gold/30",
  success: "bg-success-soft text-success ring-1 ring-inset ring-success/20",
  warning: "bg-warning-soft text-warning ring-1 ring-inset ring-warning/20",
  danger: "bg-danger-soft text-danger ring-1 ring-inset ring-danger/20",
};

const dots: Record<Tone, string> = {
  neutral: "bg-ink-faint",
  info: "bg-brand",
  brand: "bg-white",
  gold: "bg-gold",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export function Badge({
  tone = "neutral",
  dot = false,
  pulse = false,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium tracking-tight select-none",
        tones[tone],
        className
      )}
    >
      {dot && (
        <span className="relative flex h-1.5 w-1.5">
          {pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", dots[tone])} />}
          <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", dots[tone])} aria-hidden="true" />
        </span>
      )}
      {children}
    </span>
  );
}

export const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; tone: Tone; description: string }> = {
  DRAFT: { label: "Draft", tone: "neutral", description: "Being prepared. Nothing will send." },
  PENDING_APPROVAL: { label: "Awaiting approval", tone: "warning", description: "Waiting for a founder to review and approve." },
  APPROVED: { label: "Approved", tone: "info", description: "Content and recipients are locked. Ready to start." },
  SENDING: { label: "Sending", tone: "info", description: "Messages are going out at the configured pace." },
  PAUSED: { label: "Paused", tone: "warning", description: "Sending is on hold. Resume to continue." },
  COMPLETED: { label: "Completed", tone: "success", description: "Every message has been handled." },
  CANCELLED: { label: "Cancelled", tone: "neutral", description: "Stopped. Unsent messages were cancelled." },
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const s = CAMPAIGN_STATUS[status];
  return (
    <Badge tone={s.tone} dot pulse={status === "SENDING"}>
      {s.label}
    </Badge>
  );
}

export const DELIVERY_STATUS: Record<DeliveryStatus, { label: string; tone: Tone }> = {
  PENDING: { label: "Queued", tone: "neutral" },
  CLAIMED: { label: "Sending", tone: "info" },
  SENT: { label: "Sent", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  UNKNOWN: { label: "Needs review", tone: "warning" },
  SKIPPED: { label: "Skipped", tone: "neutral" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const s = DELIVERY_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
