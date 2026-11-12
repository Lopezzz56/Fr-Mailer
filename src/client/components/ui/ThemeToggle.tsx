import { Moon, Sun } from "lucide-react";
import { useTheme } from "../../lib/theme";
import { cn } from "../../lib/cn";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggleTheme}
      className={cn(
        "group relative inline-flex h-7 w-[50px] shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-200 focus-visible:outline-none focus-visible:shadow-focus select-none",
        isDark
          ? "border border-[#233554] bg-[#0A1224] hover:border-[#385285]"
          : "border border-slate-300 bg-slate-200/90 hover:border-slate-400",
        className
      )}
    >
      {/* Background icons inside the track */}
      <div className="absolute inset-0 flex items-center justify-between px-1.5 pointer-events-none">
        <Sun
          className={cn(
            "h-3 w-3 transition-opacity duration-150",
            isDark ? "text-slate-500 opacity-60" : "opacity-0"
          )}
        />
        <Moon
          className={cn(
            "h-3 w-3 transition-opacity duration-150",
            isDark ? "opacity-0" : "text-slate-400 opacity-70"
          )}
        />
      </div>

      {/* Sliding indicator knob */}
      <span
        className={cn(
          "pointer-events-none relative z-10 flex h-5 w-5 items-center justify-center rounded-full transition-transform duration-200 ease-out",
          isDark
            ? "translate-x-6 border border-[#E2C386]/60 bg-[#16233E] text-[#E2C386] shadow-[0_0_8px_rgba(226,195,134,0.35)]"
            : "translate-x-0 border border-slate-200 bg-white text-amber-500 shadow-xs"
        )}
      >
        {isDark ? (
          <Moon className="h-3 w-3 fill-[#E2C386]/30" />
        ) : (
          <Sun className="h-3 w-3 fill-amber-500/20" />
        )}
      </span>
    </button>
  );
}
