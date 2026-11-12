// Page header, tabs, filter chips, and a row-action menu
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, MoreHorizontal } from "lucide-react";
import { cn } from "../../lib/cn";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationsButton } from "./NotificationsButton";

export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
  hideGlobalControls = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  meta?: ReactNode;
  hideGlobalControls?: boolean;
}) {
  return (
    <div className="mb-7">
      {back && (
        <Link
          to={back.to}
          className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-ink-subtle transition-colors hover:text-ink"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-[26px]">{title}</h1>
            {meta}
          </div>
          {description && <p className="mt-1 text-[13px] text-ink-subtle leading-relaxed">{description}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5 w-full sm:w-auto">
          {!hideGlobalControls && (
            <div className="hidden lg:flex items-center gap-2.5">
              <ThemeToggle />
              <NotificationsButton />
            </div>
          )}
          {actions}
        </div>
      </div>
    </div>
  );
}

export interface TabItem<K extends string> {
  key: K;
  label: string;
  count?: number;
}

export function Tabs<K extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "flex gap-4 sm:gap-6 overflow-x-auto border-b border-line -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-none",
        className
      )}
    >
      {tabs.map((t) => {
        const selected = t.key === active;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.key)}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-2 border-b-2 pb-3 pt-1 text-sm font-medium transition-colors select-none",
              selected
                ? "border-brand text-ink font-semibold"
                : "border-transparent text-ink-subtle hover:border-line-strong hover:text-ink"
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={cn(
                  "tabular rounded-full px-2 py-0.5 text-2xs font-semibold",
                  selected ? "bg-brand-soft text-brand-ink" : "bg-surface-sunken text-ink-subtle"
                )}
              >
                {t.count.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Compact segmented filter, e.g. All / Sent / Failed */
export function FilterChips<K extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { key: K; label: string; count?: number }[];
  value: K;
  onChange: (k: K) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.key)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-all select-none",
              active
                ? "border-brand bg-brand-soft text-brand-ink shadow-xs"
                : "border-line bg-surface text-ink-muted hover:border-line-strong hover:text-ink hover:bg-surface-muted"
            )}
          >
            {o.label}
            {o.count !== undefined && <span className="tabular text-ink-subtle font-normal">{o.count.toLocaleString()}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
  hidden?: boolean;
}

export function ActionMenu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visible = items.filter((i) => !i.hidden);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (visible.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-subtle shadow-xs transition-colors hover:border-line-strong hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-dropdown mt-1.5 w-44 rounded-xl border border-line bg-surface p-1 shadow-pop animate-pop-in"
        >
          {visible.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cn(
                "flex w-full items-center rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                it.tone === "danger"
                  ? "text-danger hover:bg-danger-soft"
                  : "text-ink hover:bg-surface-muted"
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
