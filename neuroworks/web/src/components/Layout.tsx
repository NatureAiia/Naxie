import { NavLink, Link, useLocation } from "react-router-dom";
import { ReactNode, useEffect, useState, type ComponentType } from "react";
import { ToastRack } from "./Card";
import {
  Search as SearchIcon,
  ChevronRight,
  CalendarDays,
  Sparkles,
  Puzzle,
  LogOut,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Terminal,
  Radar,
  LayoutDashboard,
  GitBranch,
  Boxes,
  Cable,
  ArrowLeftRight,
  Megaphone,
  Building2,
  MessageCircle,
} from "lucide-react";
import { BrandMark } from "./BrandMark";
import { GlitterBackground } from "./GlitterBackground";
import { PixelDriftText } from "./PixelDriftText";
import { CommandPalette } from "./CommandPalette";
import { Kbd, MetaKey } from "./Kbd";
import { matIcon } from "./FileIcon";
import { api, setToken, type User } from "../lib/api";
import { preloadRoute, preloadLikelyRoutes } from "../lib/routePreload";
import { TerminalProvider } from "../lib/terminalContext";
import { TerminalDrawer } from "./TerminalDrawer";
import { NaxieWidget } from "./NaxieWidget";

// Atom Material icons (see FileIcon.tsx) for the nav items with a clean
// conceptual match; everything else keeps its lucide icon — there's no
// material file/folder icon for "Dashboard" or "Chat", so forcing one on
// would read as a worse fit, not a reskin.
const TodoIcon = matIcon("todo");
const ChangelogIcon = matIcon("changelog");
const ReviewFolderIcon = matIcon("folder-review");
const TemplateIcon = matIcon("template");
const RobotFolderIcon = matIcon("folder-robot");
const DocsFolderIcon = matIcon("folder-docs");
const CertificateIcon = matIcon("certificate");
const EventFolderIcon = matIcon("folder-event");
const WorkspaceFolderIcon = matIcon("folder"); // generic nav-group container glyph

type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number | string; className?: string }>;
  badgeKey?: "approvals" | "activity";
  external?: boolean;
  iconColor?: string;
};

// Top-level: Home Base. Everything else folds into a collapsible group so
// the rail stays short. No role-based filtering below — this is a
// single-operator app now (see removed staff/admin/superadmin nav logic);
// server-side gates (requireLayer) still apply where a real secrets
// boundary exists (e.g. Library's Connections tab), this file just no
// longer hides a link from the one person using it.
const primaryNav: NavItem[] = [
  { to: "/naxie", label: "Naxie", icon: Sparkles, iconColor: "text-violet-400" },
  { to: "/command", label: "Command Center", icon: LayoutDashboard },
  { to: "/office", label: "Office", icon: Building2 },
  { to: "/ide", label: "Naxion IDE", icon: Terminal },
];

const agentsNav: NavItem[] = [];

const workNav: NavItem[] = [
  { to: "/my-work", label: "Work", icon: Inbox, badgeKey: "approvals" },
  { to: "/brands", label: "Brands", icon: Megaphone },
  { to: "/planner", label: "Planner", icon: CalendarDays },
  { to: "/schedules", label: "Schedules", icon: EventFolderIcon },
  { to: "/daily-reports", label: "Daily Reports", icon: ChangelogIcon },
];

const memoryNav: NavItem[] = [
  { to: "/library", label: "Library", icon: DocsFolderIcon },
  { to: "/templates", label: "Templates", icon: TemplateIcon },
  { to: "/skills", label: "Skills", icon: TemplateIcon },
  // SkillForge lives as a tab on Skills. Datasets (formerly "Knowledge
  // Packs") lives as a tab on Library.
];

const connectNav: NavItem[] = [
  { to: "/extensions", label: "Extensions", icon: Puzzle },
  { to: "/whatsapp", label: "WhatsApp", icon: MessageCircle },
  { to: "/connectors", label: "Connectors", icon: Boxes },
  { to: "/mcp-servers", label: "MCP Servers", icon: Cable },
  { to: "/hermes", label: "Hermes", icon: ArrowLeftRight },
  { to: "/github-accounts", label: "GitHub Accounts", icon: GitBranch },
  { to: "/connectors?tab=policies", label: "Policies", icon: CertificateIcon },
];

// Ambient Watch — a single stub slot, not a real group yet (no logic behind
// it). Not folded into another group so it's obviously a placeholder, not a
// half-built feature masquerading as done.
const ambientNav: NavItem = { to: "/ambient", label: "Ambient Watch", icon: Radar };

export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [health, setHealth] = useState<{ ready: boolean; missing?: string[] } | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [counts, setCounts] = useState<{ approvals: number; activity: number }>({ approvals: 0, activity: 0 });
  const [persona, setPersona] = useState<{ id: string; name: string; role: string } | null>(null);
  // Per-group open state. Undefined = "not toggled yet"; a group with an active
  // child defaults to open so the current page is always visible in the rail.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  // Atom One Dark only — the theme switcher was removed, but [data-theme]
  // stays set (index.css keys off it, and OfficeScene/PixelDriftText observe
  // it for repaints) so this constant just fixes it to "dark" everywhere.
  const theme = "dark" as const;
  // Collapsed sidebar — an icon-only rail (~4x narrower) for more working
  // space. Sticky across reloads like the theme choice.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    // Default to previous user preference, but we'll override on small
    // viewports so the shell becomes compact on tablet/smaller devices.
    return localStorage.getItem("neuroworks.sidebarCollapsed") === "1";
  });

  // Responsive: keep the sidebar collapsed on tablet and smaller screens by
  // default, and expand on larger viewports. We listen for resize so the
  // layout adapts when the user resizes the window.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(`(max-width: 819px)`);
    const apply = () => {
      // If the viewport is tablet/smaller, force collapsed; otherwise restore
      // the user's saved preference (or expanded by default).
      if (mql.matches) {
        setCollapsed(true);
      } else {
        setCollapsed(localStorage.getItem("neuroworks.sidebarCollapsed") === "1");
      }
    };
    apply();
    mql.addEventListener?.("change", apply);
    window.addEventListener("resize", apply);
    return () => {
      mql.removeEventListener?.("change", apply);
      window.removeEventListener("resize", apply);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, []);

  useEffect(() => {
    localStorage.setItem("neuroworks.sidebarCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  async function tick() {
    try {
      const h = await api.health();
      setHealth(h);
      const j = await api.listJobs().catch(() => ({ jobs: [] }));
      const running = j.jobs.filter((x: any) => x.status === "running").length;
      const pendingApproval = j.jobs.filter((x: any) => x.status === "awaiting-approval").length;
      setCounts({ approvals: pendingApproval, activity: running });
      const p = await api.listPersonas().catch(() => ({ active: null }) as any);
      setPersona(p.active);
      const s = await api.session().catch(() => ({ user: null }));
      setUser(s.user);
    } catch {}
  }

  async function signOut() {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    setToken(null);
    setUser(null);
  }
  useEffect(() => {
    tick();
    const i = setInterval(tick, 5000);
    return () => clearInterval(i);
  }, []);
  // Page-view beacon for MD audit dormancy (S) — best-effort, no await
  useEffect(() => {
    try {
      const page = location.pathname;
      fetch("/api/system-audit/page-view", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ page }) }).catch(() => {});
    } catch { /* ignore */ }
  }, [location.pathname]);
  // Warm the chunks a user almost always opens next, once the app is idle.
  useEffect(() => {
    preloadLikelyRoutes();
  }, []);

  const statusOk = health?.ready === true;
  const statusLabel = !health ? "connecting" : statusOk ? "All systems nominal" : "Degraded — check server logs";

  const renderNavItem = (n: NavItem) => {
    const Icon = n.icon;
    if (n.external) {
      return (
        <a
          key={n.to}
          href={n.to}
          target="_blank"
          rel="noopener noreferrer"
          title={collapsed ? n.label : undefined}
          className={`flex items-center gap-3 py-2 rounded-md text-sm transition-colors ${collapsed ? "justify-center px-2" : "px-3"} text-cream-300 hover:text-cream-50 hover:bg-ink-800/60`}
        >
          <Icon size={16} className={`${n.iconColor ?? "text-cream-300/70"} shrink-0`} />
          {!collapsed && <span className="flex-1 truncate">{n.label}</span>}
          {!collapsed && <span className="text-[9px] text-cream-300/40">↗</span>}
        </a>
      );
    }
    return (
      <NavLink
        key={n.to}
        to={n.to}
        title={collapsed ? n.label : undefined}
        onMouseEnter={() => preloadRoute(n.to)}
        onFocus={() => preloadRoute(n.to)}
        className={({ isActive }) =>
          `flex items-center gap-3 py-2 rounded-md text-sm transition-colors ${collapsed ? "justify-center px-2" : "px-3"} ${isActive ? "bg-ink-800 text-cream-50" : "text-cream-300 hover:text-cream-50 hover:bg-ink-800/60"}`
        }
      >
        <Icon size={16} className={`${n.iconColor ?? "text-cream-300/70"} shrink-0`} />
        {!collapsed && <span className="flex-1 truncate">{n.label}</span>}
        {!collapsed && n.badgeKey && counts[n.badgeKey] > 0 && (
          <span className="bg-violet-500/20 text-violet-400 text-[10px] px-1.5 py-0.5 rounded-full font-mono">
            {counts[n.badgeKey]}
          </span>
        )}
      </NavLink>
    );
  };

  // Collapsible nav group (same pattern the Library used). Open when the user
  // has toggled it open, or — until they touch it — whenever it holds the
  // active route so the current page never hides inside a closed group.
  const renderGroup = (
    key: string,
    label: string,
    Icon: ComponentType<{ size?: number | string; className?: string }>,
    items: NavItem[],
    badge = 0,
  ) => {
    const hasActive = items.some((n) => location.pathname.startsWith(n.to));
    const open = openGroups[key] ?? hasActive;
    return (
      <div key={key}>
        <button
          type="button"
          onClick={() => setOpenGroups((g) => ({ ...g, [key]: !(g[key] ?? hasActive) }))}
          className="w-full flex items-center gap-3 px-3 py-2 mt-3 rounded-md text-sm text-cream-300 hover:text-cream-50 hover:bg-ink-800/60 transition-colors"
        >
          <Icon size={16} className="text-cream-300/70 shrink-0" />
          <span className="flex-1 text-left">{label}</span>
          {/* Aggregate badge — keeps a pending count visible even when collapsed. */}
          {badge > 0 && !open && (
            <span className="bg-violet-500/20 text-violet-400 text-[10px] px-1.5 py-0.5 rounded-full font-mono">
              {badge}
            </span>
          )}
          <ChevronRight size={14} className={`text-cream-300/50 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        {open && <div className="ml-3 pl-3 border-l border-ink-800 space-y-0.5">{items.map(renderNavItem)}</div>}
      </div>
    );
  };

  // Naxie still gets the full-bleed, no-max-width content treatment (it
  // hosts the knowledge-graph "brain", not prose) — but the starfield now
  // shows on every page, Naxie included.
  const clearBackground = location.pathname.startsWith("/naxie") || location.pathname.startsWith("/ide");

  return (
    <TerminalProvider>
      <div className="flex h-full">
        <GlitterBackground />
        <aside
          className={`shrink-0 bg-ink-900 border-r border-ink-800 flex flex-col transition-[width] duration-200 overflow-hidden ${collapsed ? "w-16" : "w-60"}`}
        >
          <div
            className={`flex items-center ${collapsed ? "flex-col gap-2 px-2 py-4" : "justify-between px-4 py-4 tablet:px-5 tablet:py-5"}`}
          >
            <Link to="/naxie" className={`flex items-center gap-2.5 min-w-0 ${collapsed ? "justify-center" : ""}`}>
              <BrandMark size={26} />
              {!collapsed && (
                <div className="w-[168px] h-8">
                  <PixelDriftText text="NeuroWorks" />
                </div>
              )}
            </Link>
            <div className={`flex items-center gap-1 ${collapsed ? "" : "shrink-0"}`}>
              <button
                type="button"
                onClick={() => setCollapsed((c) => !c)}
                title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-label="Toggle sidebar"
                className="grid place-items-center w-7 h-7 border border-ink-700 hover:border-violet-500/40 rounded-md text-cream-300 hover:text-cream-100 transition-colors shrink-0"
              >
                {collapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
              </button>
            </div>
          </div>

          {!collapsed && (
            <div className="px-4 pb-4 tablet:px-5">
              <div className="w-full aspect-square rounded-full overflow-hidden border border-ink-700">
                <img src="/brand/logo.jpg" alt="NeuroWorks" className="w-full h-full object-cover" />
              </div>
            </div>
          )}

          <nav className={`flex-1 space-y-0.5 overflow-y-auto scrollbar-thin ${collapsed ? "px-2" : "px-3"}`}>
            {primaryNav.map(renderNavItem)}
            {collapsed ? (
              <>
                {agentsNav.map(renderNavItem)}
                {workNav.map(renderNavItem)}
                {memoryNav.map(renderNavItem)}
                {connectNav.map(renderNavItem)}
                {renderNavItem(ambientNav)}
              </>
            ) : (
              <>
                {agentsNav.length > 0 && renderGroup("agents", "Agents & Subagents", RobotFolderIcon, agentsNav)}
                {renderGroup("work", "Work Queue", WorkspaceFolderIcon, workNav, counts.approvals + counts.activity)}
                {renderGroup("memory", "Memory & Knowledge", DocsFolderIcon, memoryNav)}
                {renderGroup("connect", "Connect", Puzzle, connectNav)}
                {renderNavItem(ambientNav)}
              </>
            )}
          </nav>

          <div className="px-3 py-3 border-t border-ink-800">
            {!collapsed && <div className="px-3 text-[10px] text-cream-300/40">local, 127.0.0.1</div>}
          </div>
        </aside>

        <main className="flex-1 flex flex-col overflow-hidden">
          <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 tablet:px-6 tablet:py-2 border-b border-ink-800">
            <div className="flex items-center gap-2.5 min-w-0">
              {user ? (
                <>
                  <div className="w-7 h-7 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-coral-500 grid place-items-center text-[11px] font-semibold text-white">
                    {user.name
                      .split(" ")
                      .map((p) => p[0])
                      .slice(0, 2)
                      .join("")
                      .toUpperCase()}
                  </div>
                  <div className="text-sm text-cream-200 truncate">
                    {user.name} <span className="text-cream-300/50 hidden tablet:inline">· {user.email}</span>
                  </div>
                  <span className="hidden tablet:inline text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/70">
                    {user.role}
                  </span>
                  <button
                    type="button"
                    onClick={signOut}
                    title="Sign out"
                    className="ml-1 shrink-0 text-cream-300/50 hover:text-coral-400 p-1"
                  >
                    <LogOut size={14} />
                  </button>
                </>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {persona && (
                <Link
                  to="/office"
                  className="nw-shiny-pill flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border bg-violet-500/10 border-violet-500/30 text-violet-300"
                  title="Active persona"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0" />
                  <span className="truncate max-w-[8rem] tablet:max-w-none">{persona.name}</span>
                  <span className="opacity-60 hidden tablet:inline">· {persona.role}</span>
                </Link>
              )}
              <div
                className={`nw-shiny-pill flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${statusOk ? "bg-leaf-500/10 border-leaf-500/30 text-leaf-400" : "bg-flame-500/10 border-flame-500/30 text-flame-400"}`}
              >
                <span
                  className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${statusOk ? "bg-leaf-500" : "bg-flame-500 animate-pulse"}`}
                />
                <span className="hidden tablet:inline">{statusLabel}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  const ev = new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true });
                  document.dispatchEvent(ev);
                }}
                className="flex items-center gap-2 text-xs px-3 py-1.5 border border-ink-700 hover:border-violet-500/40 rounded-md text-cream-300 hover:text-cream-100 transition-colors"
                title="Open command palette"
              >
                <SearchIcon size={12} />
                <span className="hidden tablet:inline">Search</span>
                <span className="hidden tablet:flex items-center gap-0.5">
                  <MetaKey />
                  <Kbd>K</Kbd>
                </span>
              </button>
            </div>
          </header>
          <div className={`flex-1 scrollbar-thin ${clearBackground ? "overflow-y-auto tablet:overflow-hidden" : "overflow-auto"}`}>
            {/* key re-keys the wrapper on route change, restarting the
              nw-page-enter animation. Reduced-motion users get an instant
              swap (the keyframe collapses to no-op in CSS). Naxie gets a
              full-bleed, full-height canvas instead of the max-w-6xl reading
              column — it hosts the knowledge-graph "brain", not prose. */}
            <div
              key={location.pathname.split("/")[1] || "/"}
              className={
                clearBackground
                  ? "px-6 py-6 tablet:h-full tablet:px-8 tablet:py-6 nw-page-enter"
                  : "max-w-[88rem] mx-auto px-8 py-8 tablet:px-10 tablet:py-8 nw-page-enter"
              }
            >
              {children}
            </div>
          </div>
          <TerminalDrawer />
        </main>
        <CommandPalette />
        <ToastRack />
        <NaxieWidget />
      </div>
    </TerminalProvider>
  );
}
