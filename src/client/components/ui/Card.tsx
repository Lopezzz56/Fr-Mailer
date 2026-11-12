import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Card({
  children,
  className,
  hoverable = false,
}: {
  children: ReactNode;
  className?: string;
  hoverable?: boolean;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-line bg-surface shadow-card transition-all duration-200",
        hoverable && "hover:border-line-strong hover:shadow-card-hover",
        className
      )}
    >
      {children}
    </section>
  );
}

/** Card with a titled header row, optional actions, and padded body */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  flush = false,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** No body padding (tables, lists) */
  flush?: boolean;
}) {
  return (
    <Card className={className}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(!flush && "p-5", bodyClassName)}>{children}</div>
    </Card>
  );
}

/** Label/value pairs */
export function DescriptionList({ items, columns = 2 }: { items: { label: string; value: ReactNode }[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn("grid gap-x-8 gap-y-4", columns === 2 && "sm:grid-cols-2", columns === 3 && "sm:grid-cols-3")}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs font-medium text-ink-subtle">{item.label}</dt>
          <dd className="mt-1 break-words text-sm font-medium text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  icon,
  trend,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "gold";
  icon?: ReactNode;
  trend?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink-subtle">{label}</p>
        {icon && <span className="text-ink-subtle">{icon}</span>}
      </div>
      <p
        className={cn(
          "tabular mt-1.5 text-2xl font-bold tracking-tight text-ink",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-danger",
          tone === "gold" && "text-gold"
        )}
      >
        {value}
      </p>
      {(hint || trend) && (
        <div className="mt-1 flex items-center gap-1.5 text-xs">
          {trend}
          {hint && <span className="text-ink-subtle">{hint}</span>}
        </div>
      )}
    </div>
  );
}
