// FocusRealm brand mark: Luxury navy rounded square with subtle champagne-gold envelope seal
import { cn } from "../../lib/cn";

export const BRAND_NAVY = "#0B142E";
export const BRAND_BLUE = "#1E5AE6";
export const BRAND_SKY = "#4C8DFF";
export const BRAND_GOLD = "#D4AF67";

export interface FocusRealmLogoProps {
  size?: number;
  /** Backward-compatibility prop */
  primaryColor?: string;
  /** Backward-compatibility prop */
  accentColor?: string;
  animated?: boolean;
  className?: string;
  /** Accessible name; omit when the logo sits next to visible brand text */
  title?: string;
}

export function FocusRealmLogo({
  size = 32,
  animated = false,
  className,
  title,
}: FocusRealmLogoProps) {
  return (
    <div
      style={{ width: size, height: size }}
      className={cn(
        "relative shrink-0 select-none overflow-hidden rounded-[24%] transition-transform duration-200",
        "ring-1 ring-black/10 shadow-[0_2px_8px_-1px_rgba(11,20,46,0.35)] dark:ring-1 dark:ring-white/25 dark:shadow-[0_2px_14px_rgba(59,130,246,0.25)]",
        animated && "motion-safe:hover:scale-105 motion-safe:transition-all",
        className
      )}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <img
        src="/focusrealm_logo.png"
        alt={title ?? "FocusRealm"}
        width={size}
        height={size}
        className="h-full w-full scale-[1.4] object-cover"
        loading="eager"
      />
    </div>
  );
}
