import type { Config } from "tailwindcss";

// Colors come from CSS variables in src/client/styles/tokens.css (single source of truth).
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/client/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: token("canvas"),
        surface: {
          DEFAULT: token("surface"),
          muted: token("surface-muted"),
          sunken: token("surface-sunken"),
        },
        line: {
          DEFAULT: token("line"),
          strong: token("line-strong"),
        },
        ink: {
          DEFAULT: token("ink"),
          muted: token("ink-muted"),
          subtle: token("ink-subtle"),
          faint: token("ink-faint"),
        },
        brand: {
          DEFAULT: token("brand"),
          hover: token("brand-hover"),
          soft: token("brand-soft"),
          ink: token("brand-ink"),
        },
        gold: {
          DEFAULT: token("gold"),
          soft: token("gold-soft"),
          border: token("gold-border"),
          ink: token("gold-ink"),
        },
        success: {
          DEFAULT: token("success"),
          soft: token("success-soft"),
        },
        warning: {
          DEFAULT: token("warning"),
          soft: token("warning-soft"),
        },
        danger: {
          DEFAULT: token("danger"),
          hover: token("danger-hover"),
          soft: token("danger-soft"),
        },
        navy: token("navy"),
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      borderRadius: {
        DEFAULT: "6px",
        md: "8px",
        lg: "10px",
        xl: "14px",
        "2xl": "18px",
      },
      boxShadow: {
        "2xs": "0 1px 1px rgb(15 23 42 / 0.03)",
        xs: "0 1px 2px rgb(15 23 42 / 0.04)",
        card: "0 1px 3px rgb(15 23 42 / 0.05), 0 2px 8px -1px rgb(15 23 42 / 0.03)",
        "card-hover": "0 8px 20px -4px rgb(15 23 42 / 0.08), 0 4px 8px -2px rgb(15 23 42 / 0.04)",
        pop: "0 18px 40px -10px rgb(15 23 42 / 0.22), 0 6px 14px -3px rgb(15 23 42 / 0.1)",
        focus: "0 0 0 3px rgb(var(--brand) / 0.22)",
        gold: "0 0 0 3px rgb(var(--gold) / 0.25)",
        "glow-brand": "0 0 24px -4px rgb(var(--brand) / 0.28)",
        "glow-gold": "0 0 24px -4px rgb(var(--gold) / 0.25)",
      },
      zIndex: { sidebar: "30", dropdown: "40", drawer: "50", modal: "60", toast: "70" },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "pop-in": { from: { opacity: "0", transform: "translateY(4px) scale(0.98)" }, to: { opacity: "1", transform: "none" } },
        "slide-in": { from: { transform: "translateX(16px)", opacity: "0" }, to: { transform: "none", opacity: "1" } },
        "drawer-in": { from: { transform: "translateX(-100%)" }, to: { transform: "translateX(0)" } },
        "loader-bar": { from: { transform: "translateX(-100%)" }, to: { transform: "translateX(250%)" } },
        "pulse-subtle": { "0%, 100%": { opacity: "1" }, "50%": { opacity: "0.6" } },
        "nav-progress": { from: { transform: "translateX(-100%)" }, to: { transform: "translateX(100%)" } },
      },
      animation: {
        "fade-in": "fade-in 140ms ease-out",
        "pop-in": "pop-in 160ms cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-in": "slide-in 180ms cubic-bezier(0.16, 1, 0.3, 1)",
        "drawer-in": "drawer-in 240ms cubic-bezier(0.16, 1, 0.3, 1)",
        "loader-bar": "loader-bar 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        "pulse-subtle": "pulse-subtle 2s ease-in-out infinite",
        "nav-progress": "nav-progress 1s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
