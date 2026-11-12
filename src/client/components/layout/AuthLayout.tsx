// Sign-in, invite and password screens: brand panel on the left (desktop), form on the right
import type { ReactNode } from "react";
import { History, Mail, ShieldCheck, type LucideIcon } from "lucide-react";
import { FocusRealmLogo } from "../brand/FocusRealmLogo";
import { BrandLockup } from "./Brand";
import { ThemeToggle } from "../ui/ThemeToggle";

const POINTS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: ShieldCheck, title: "Approved before it sends", text: "A person reviews every campaign. Test sends and limits come first." },
  { icon: Mail, title: "From your own mailbox", text: "Messages go out through the FocusRealm address, so replies come home." },
  { icon: History, title: "Every result on record", text: "Delivered, bounced, replied or unsubscribed, recipient by recipient." },
];

function BrandPanel() {
  return (
    <aside className="relative hidden w-[46%] max-w-[620px] flex-col justify-between overflow-hidden bg-[#0A1329] px-12 py-10 text-white lg:flex xl:px-16 border-r border-[#1B294B]">
      {/* Subtle luxury mesh & gold/sapphire ambient radiance */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage: "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
        aria-hidden="true"
      />
      <div className="pointer-events-none absolute -right-32 -top-32 h-[460px] w-[460px] rounded-full bg-brand/20 blur-3xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -left-20 bottom-10 h-[360px] w-[360px] rounded-full bg-gold/15 blur-3xl" aria-hidden="true" />

      <div className="relative flex items-center gap-3.5">
        <FocusRealmLogo size={42} animated />
        <div className="leading-tight">
          <p className="text-[17px] font-bold tracking-tight text-white">FocusRealm</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/60">Mail Merge</p>
        </div>
      </div>

      <div className="relative max-w-md py-12">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-2xs font-semibold text-gold tracking-wide">
          <span className="h-1.5 w-1.5 rounded-full bg-gold" />
          ENTERPRISE OUTREACH
        </div>
        <h2 className="text-[34px] font-bold leading-[1.18] tracking-tight text-white">
          Personal outreach, sent with precision.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-white/70">
          One template, a personal email for every recipient, and a clear audit record of every delivery, bounce, and reply.
        </p>
        <ul className="mt-10 space-y-6">
          {POINTS.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.08] ring-1 ring-white/10 shadow-xs">
                <Icon className="h-5 w-5 text-gold" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm font-semibold text-white">{title}</span>
                <span className="mt-0.5 block text-xs leading-5 text-white/65">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs text-white/40">© {new Date().getFullYear()} FocusRealm · Internal workspace</p>
    </aside>
  );
}

export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <BrandPanel />
      <main className="flex flex-1 flex-col justify-between">
        <div className="flex items-center justify-between p-6 sm:px-10">
          <div className="lg:hidden">
            <BrandLockup size="md" />
          </div>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center px-6 py-8 sm:px-10">
          <div className="w-full max-w-[390px] animate-fade-in">
            <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
            {description && <p className="mt-2 text-xs leading-relaxed text-ink-subtle">{description}</p>}
            <div className="mt-8">{children}</div>
            {footer && (
              <div className="mt-8 border-t border-line pt-6 text-xs leading-relaxed text-ink-subtle">{footer}</div>
            )}
          </div>
        </div>

        <p className="pb-6 text-center text-2xs text-ink-faint">FocusRealm Mail Merge · Enterprise internal workspace</p>
      </main>
    </div>
  );
}
