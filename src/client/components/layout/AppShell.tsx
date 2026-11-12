// Signed-in application frame: sidebar navigation + content area
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useNavigation } from "react-router-dom";
import {
  ChevronRight,
  FileText,
  LayoutDashboard,
  LogOut,
  Send,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { useAuth } from "../../lib/auth";
import { initials } from "../../lib/format";
import { ROLE_LABELS } from "@shared/auth";
import { BrandLockup } from "./Brand";
import { ThemeToggle } from "../ui/ThemeToggle";
import { NotificationsButton } from "../ui/NotificationsButton";

import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../lib/queries";
import { api } from "../../lib/api";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  badge?: string;
}

function getNavSections(): { title: string; items: NavItem[] }[] {
  return [
    {
      title: "Workspace",
      items: [
        { to: "/campaigns", label: "Campaigns", icon: Send },
        { to: "/contacts", label: "Contacts", icon: Users },
        { to: "/templates", label: "Templates", icon: FileText },
      ],
    },
  ];
}

function NavItemLink({ item }: { item: NavItem }) {
  const Icon = item.icon;
  const { user } = useAuth();
  const qc = useQueryClient();

  const handlePrefetch = () => {
    if (item.to === "/") {
      if (user?.role === "FOUNDER") {
        void qc.prefetchQuery({ queryKey: keys.overview, queryFn: () => api.get("/api/overview") });
      } else {
        void qc.prefetchQuery({ queryKey: keys.workQueue, queryFn: () => api.get("/api/overview/work-queue") });
      }
    } else if (item.to === "/contacts") {
      void qc.prefetchQuery({
        queryKey: keys.contacts({ page: 1, search: "" }),
        queryFn: () => api.get("/api/contacts?page=1&pageSize=25"),
      });
    } else if (item.to === "/campaigns") {
      void qc.prefetchQuery({ queryKey: keys.campaigns({}), queryFn: () => api.get("/api/campaigns") });
    } else if (item.to === "/templates") {
      void qc.prefetchQuery({ queryKey: keys.templates(""), queryFn: () => api.get("/api/templates") });
    }
  };

  return (
    <NavLink
      to={item.to}
      end={item.end}
      onMouseEnter={handlePrefetch}
      onFocus={handlePrefetch}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[13px] font-medium transition-all duration-150 ease-out select-none",
          isActive
            ? "bg-gradient-to-r from-[#0F172A] to-[#182647] text-white shadow-xs ring-1 ring-white/10 dark:from-[#1E2E50] dark:to-[#16233E] dark:text-white dark:ring-1 dark:ring-[#355288] dark:shadow-[0_0_16px_rgba(59,130,246,0.2)]"
            : "text-ink-muted hover:bg-surface-muted hover:text-ink"
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              className="absolute left-1.5 top-1/2 -translate-y-1/2 h-5 w-1 rounded-full bg-brand dark:bg-[#60A5FA] shadow-[0_0_8px_rgba(59,130,246,0.7)]"
              aria-hidden="true"
            />
          )}
          <Icon
            className={cn(
              "h-4 w-4 shrink-0 transition-colors duration-150",
              isActive ? "text-white" : "text-ink-faint group-hover:text-brand"
            )}
            aria-hidden="true"
          />
          <span className="truncate">{item.label}</span>
          {item.badge && (
            <span className="ml-auto rounded-full bg-[#E2C386]/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#B88728] dark:text-[#E2C386] border border-[#E2C386]/40">
              {item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

function UserCard() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!user) return null;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#1E5AE6] to-[#0B142E] text-xs font-bold text-white shadow-xs ring-2 ring-line/80 dark:from-brand dark:to-slate-900">
          {initials(user.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-ink leading-tight">{user.name}</span>
          <span className="block truncate text-2xs text-ink-subtle mt-0.5">
            {ROLE_LABELS[user.role]}
            {user.role === "EMPLOYEE" && user.canSendWithoutApproval && " · Send Enabled"}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-faint" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-line bg-surface p-1.5 shadow-pop animate-pop-in z-dropdown"
        >
          <div className="border-b border-line px-3 py-2">
            <p className="truncate text-xs font-semibold text-ink">{user.name}</p>
            <p className="truncate text-2xs text-ink-subtle">{user.email}</p>
            <div className="mt-1 flex items-center gap-1.5 flex-wrap">
              <span className="inline-block rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                {ROLE_LABELS[user.role]}
              </span>
              {user.role === "EMPLOYEE" && user.canSendWithoutApproval && (
                <span className="inline-block rounded bg-success-soft px-1.5 py-0.5 text-[10px] font-medium text-success">
                  Direct Send Enabled
                </span>
              )}
            </div>
          </div>
          <NavLink
            role="menuitem"
            to="/settings/account"
            onClick={() => setOpen(false)}
            className="block rounded-lg px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface-muted mt-1"
          >
            Account & password
          </NavLink>
          <button
            role="menuitem"
            onClick={() => void logout()}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-medium text-danger transition-colors hover:bg-danger-soft"
          >
            <LogOut className="h-4 w-4 text-danger" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function SidebarContent() {
  const { user } = useAuth();
  const sections = getNavSections();
  const homeLabel = user?.role === "EMPLOYEE" ? "Today" : user?.role === "FOUNDER_OFFICE" ? "Queue" : "Overview";
  const settingsPath = user?.role === "EMPLOYEE" ? "/settings/account" : user?.role === "FOUNDER" ? "/settings/mailbox" : "/settings/team";

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-20 items-center border-b border-line px-5 py-4">
        <BrandLockup />
      </div>
      <nav className="flex-1 space-y-6 overflow-y-auto px-3.5 py-5" aria-label="Main">
        <div className="space-y-1">
          <NavItemLink item={{ to: "/", label: homeLabel, icon: LayoutDashboard, end: true }} />
        </div>
        {sections.map((section) => (
          <div key={section.title}>
            <p className="mb-2 px-3 text-2xs font-bold uppercase tracking-[0.14em] text-ink-faint">
              {section.title}
            </p>
            <div className="space-y-1">
              {section.items.map((item) => (
                <NavItemLink key={item.to + item.label} item={item} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="space-y-1.5 border-t border-line p-3">
        <NavItemLink item={{ to: settingsPath, label: "Settings", icon: Settings }} />
        <UserCard />
      </div>
    </div>
  );
}

function MobileBottomNav() {
  const { user } = useAuth();
  const homeLabel = user?.role === "EMPLOYEE" ? "Today" : user?.role === "FOUNDER_OFFICE" ? "Queue" : "Overview";

  const navItems = [
    { to: "/", label: homeLabel, icon: LayoutDashboard, end: true },
    { to: "/campaigns", label: "Campaigns", icon: Send },
    { to: "/contacts", label: "Contacts", icon: Users },
    { to: "/templates", label: "Templates", icon: FileText },
  ];

  return (
    <nav
      aria-label="Mobile Navigation"
      className="fixed bottom-0 inset-x-0 z-sticky lg:hidden border-t border-line bg-surface/95 backdrop-blur-md pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_20px_rgba(0,0,0,0.06)] dark:shadow-[0_-4px_24px_rgba(0,0,0,0.45)]"
    >
      <div className="flex items-center justify-around h-16 max-w-lg mx-auto px-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "relative flex flex-1 flex-col items-center justify-center py-1 transition-all duration-200 select-none group",
                  isActive
                    ? "text-brand font-semibold dark:text-brand-hover"
                    : "text-ink-subtle hover:text-ink font-medium"
                )
              }
            >
              {({ isActive }) => (
                <>
                  <div
                    className={cn(
                      "flex h-7 w-12 items-center justify-center rounded-full transition-all duration-200",
                      isActive
                        ? "bg-brand-soft text-brand dark:bg-brand/25 dark:text-brand-hover shadow-xs"
                        : "text-ink-subtle group-hover:text-ink"
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <span
                    className={cn(
                      "mt-0.5 text-[11px] tracking-tight truncate",
                      isActive ? "font-semibold text-brand dark:text-brand-hover" : "font-medium text-ink-subtle"
                    )}
                  >
                    {item.label}
                  </span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

/** Thin bar under the top edge while the next page's code loads */
function NavigationProgress() {
  const navigation = useNavigation();
  if (navigation.state !== "loading") return null;
  return (
    <div className="fixed inset-x-0 top-0 z-toast h-0.5 overflow-hidden bg-brand-soft" role="progressbar" aria-label="Loading page">
      <div className="h-full w-1/3 bg-brand motion-safe:animate-nav-progress" />
    </div>
  );
}

export function AppShell() {
  const { user } = useAuth();
  const settingsPath = user?.role === "EMPLOYEE" ? "/settings/account" : user?.role === "FOUNDER" ? "/settings/mailbox" : "/settings/team";

  return (
    <div className="flex min-h-screen w-full bg-canvas">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-toast focus:rounded-lg focus:bg-surface focus:px-3.5 focus:py-2 focus:shadow-pop"
      >
        Skip to content
      </a>
      <NavigationProgress />

      {/* Desktop sidebar: fixed full-height column */}
      <div className="hidden w-64 shrink-0 lg:block">
        <aside className="fixed inset-y-0 left-0 z-sidebar flex h-screen w-64 flex-col overflow-hidden border-r border-line bg-surface">
          <SidebarContent />
        </aside>
      </div>

      <div className="flex w-full min-w-0 flex-1 flex-col overflow-x-hidden">
        {/* Mobile Header Bar — clean, no redundant drawer, native feel */}
        <header className="sticky top-0 z-dropdown flex h-14 w-full items-center justify-between border-b border-line bg-surface/95 px-4 backdrop-blur-md lg:hidden">
          <BrandLockup size="md" />
          <div className="flex items-center gap-2">
            <Link
              to={settingsPath}
              aria-label="Settings"
              className="flex h-9 w-9 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
            >
              <Settings className="h-4 w-4" />
            </Link>
            <NotificationsButton />
            <ThemeToggle />
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 sm:px-6 lg:px-10 lg:py-8 pb-24 lg:pb-8">
          <Outlet />
        </main>
      </div>

      {/* Mobile-first bottom navigation bar */}
      <MobileBottomNav />
    </div>
  );
}
