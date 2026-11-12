import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { cn } from "../../lib/cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "brand" | "secondary" | "ghost" | "gold" | "danger" | "danger-ghost";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-all duration-150 select-none " +
  "focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-50 active:scale-[0.985]";

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-[#0F172A] text-white shadow-xs hover:bg-[#1E293B] border border-[#1E293B] dark:bg-[#152238] dark:border-[#2B4066] dark:text-white dark:hover:bg-[#1D2F4E] dark:hover:border-[#3B588C]",
  brand:
    "bg-brand text-white shadow-xs hover:bg-brand-hover border border-transparent shadow-[0_1px_2px_rgba(30,90,230,0.2)]",
  secondary:
    "border border-line bg-surface text-ink shadow-xs hover:bg-surface-muted hover:border-line-strong dark:hover:bg-surface-muted/80",
  ghost: "text-ink-muted hover:bg-surface-sunken hover:text-ink border border-transparent",
  gold:
    "bg-gradient-to-r from-[#D4AF67] to-[#C49A55] text-[#0A1329] font-semibold hover:brightness-105 shadow-xs border border-white/20",
  danger: "bg-danger text-white shadow-xs hover:bg-danger-hover border border-transparent",
  "danger-ghost": "text-danger hover:bg-danger-soft border border-transparent",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 px-2.5 text-xs",
  md: "h-9 px-3.5 text-[13px]",
  lg: "h-10 px-4 text-sm",
};

export function buttonClasses(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, disabled, className, children, type = "button", ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, className)}
      {...props}
    >
      {loading ? (
        <Spinner size={14} className={variant === "primary" || variant === "brand" || variant === "danger" ? "text-white" : undefined} />
      ) : (
        icon
      )}
      {children}
    </button>
  );
});

export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  ...props
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode }) {
  return (
    <Link className={buttonClasses(variant, size, className)} {...props}>
      {icon}
      {children}
    </Link>
  );
}

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: "default" | "danger" }>(
  function IconButton({ label, tone = "default", className, children, type = "button", ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-transparent transition-all duration-150 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40 active:scale-95",
          tone === "danger"
            ? "text-ink-subtle hover:bg-danger-soft hover:text-danger"
            : "text-ink-subtle hover:bg-surface-sunken hover:text-ink hover:border-line",
          className
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);
