import { cn } from "../../lib/cn";
import { FocusRealmLogo } from "../brand/FocusRealmLogo";

export function BrandMark({ size = 34, className, animated }: { size?: number; className?: string; animated?: boolean }) {
  return <FocusRealmLogo size={size} className={className} animated={animated} />;
}

/** Logo and wordmark. */
export function BrandLockup({ className, size = "md", tone = "light" }: { className?: string; size?: "md" | "lg"; tone?: "light" | "dark" }) {
  const isDarkTone = tone === "dark";
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <FocusRealmLogo size={size === "lg" ? 40 : 36} />
      <div className="min-w-0 leading-tight">
        <p className={cn("font-bold tracking-tight", isDarkTone ? "text-white" : "text-ink", size === "lg" ? "text-lg" : "text-[15px]")}>
          Mail Merge
        </p>
        <p className={cn("font-medium tracking-normal", isDarkTone ? "text-white/70" : "text-ink-subtle", size === "lg" ? "text-xs" : "text-[11px]")}>
          by FocusRealm
        </p>
      </div>
    </div>
  );
}
