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
  Menu,
  X,
  Terminal,
  LayoutDashboard,
  GitBranch,
  Boxes,
  Cable,
  ArrowLeftRight,
  Megaphone,
  Building2,
  MessageCircle,
  PiggyBank,
  Brain,
  Webhook as WebhookIcon,
  Waypoints,
  Users,
  UserPlus,
  Cpu,
  Wallet,
  Briefcase,
  Settings,
  Radar,
  ShieldAlert,
  BookOpen,
  Dna,
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
import { OfflineToggle, OfflineFooterLabel } from "./OfflineToggle";
import { PAGE_CATALOG, pageInfo, type PageId } from "../lib/pageCatalog";

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

function pageNav(id: PageId, icon: NavItem["icon"], options: Omit<NavItem, "to" | "label" | "icon"> = {}): NavItem {
  const page = pageInfo(id);
  return { to: page.path, label: page.label, icon, ...options };
}

// Top-level: Home Base. Everything else folds into a collapsible group so
// the rail stays short. No role-based filtering below — this is a
// single-operator app now (see removed staff/admin/superadmin nav logic);
// server-side gates (requireLayer) still apply where a real secrets
// boundary exists (e.g. Library's Connections tab), this file just no
// longer hides a link from the one person using it.
const primaryNav: NavItem[] = [
  pageNav("naxie", Sparkles, { iconColor: "text-violet-400" }),
  pageNav("office", Building2, { iconColor: "text-violet-300" }),
];

const agentsNav: NavItem[] = [];

const workspaceNav: NavItem[] = [
  pageNav("inbox", Inbox, { badgeKey: "approvals" }),
  pageNav("ambient", Radar),
  pageNav("council", Waypoints),
  pageNav("schedules", EventFolderIcon),
  pageNav("dailyReports", ChangelogIcon),
];

const mySuiteNav: NavItem[] = [
  pageNav("command", LayoutDashboard),
  pageNav("brands", Megaphone),
  pageNav("planner", CalendarDays),
  pageNav("myFinances", PiggyBank),
  pageNav("businessFinance", Building2),
];

const knowledgeNav: NavItem[] = [
  pageNav("memory", Brain, { iconColor: "text-teal-300" }),
  pageNav("library", DocsFolderIcon, { iconColor: "text-teal-300" }),
  pageNav("templates", TemplateIcon, { iconColor: "text-teal-300" }),
  pageNav("skills", TemplateIcon, { iconColor: "text-teal-300" }),
  // SkillForge lives as a tab on Skills. Datasets (formerly "Knowledge
  // Packs") lives as a tab on Library.
];

const connectNav: NavItem[] = [
  pageNav("extensions", Puzzle),
  pageNav("connectors", Boxes),
  pageNav("mcp", Cable),
  pageNav("hermes", ArrowLeftRight),
  pageNav("github", GitBranch),
];

const systemNav: NavItem[] = [
  pageNav("automation", WebhookIcon),
  pageNav("ide", Terminal),
  pageNav("models", Cpu),
  pageNav("cost", Wallet),
  pageNav("policies", CertificateIcon),
];

// Security Scan — a single standalone slot outside the groups, same spot
// Ambient Watch used to occupy (Ambient moved into My Work as a tab). Kept
// out of connectNav so it stays visible without expanding a group — a
// pentest trigger is not something you want buried.
const securityScanNav: NavItem = pageNav("security", ShieldAlert, { iconColor: "text-coral-400" });
const somaticOraNav: NavItem = pageNav("somatic-ora", Dna, { iconColor: "text-violet-400" });

export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  useEffect(() => {
    const routeTitles: Record<string, string> = {
      ...Object.fromEntries(Object.values(PAGE_CATALOG).map(page => [page.path, page.label])),
      "/": "Naxie",
      "/runs": "Runs",
    };
    const pathParts = location.pathname.split("/").filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1];
    const title = routeTitles[location.pathname]
      ?? (location.pathname.startsWith("/library/") ? "Library" : undefined)
      ?? (/^\/runs\/[^/]+/.test(location.pathname) ? "Run details" : undefined)
      ?? lastPart?.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase())
      ?? "Workspace";
    document.title = `${title} · Naxie`;
  }, [location.pathname]);
  const [health, setHealth] = useState<{ ready: boolean; missing?: string[] } | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [counts, setCounts] = useState<{ approvals: number; activity: number }>({ approvals: 0, activity: 0 });
  const [persona, setPersona] = useState<{ id: string; name: string; role: string } | null>(null);
  // Per-group open state. Undefined = "not toggled yet"; a group with an active
  // child defaults to open so the current page is always visible in the rail.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const saved = localStorage.getItem("naxie.sidebarGroups");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [isSmallScreen, setIsSmallScreen] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 819px)").matches);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
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
    return localStorage.getItem("naxie.sidebarCollapsed") === "1";
  });
  const compactNav = isSmallScreen ? false : collapsed;

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
        setIsSmallScreen(true);
        setCollapsed(true);
        setMobileNavOpen(false);
      } else {
        setIsSmallScreen(false);
        setCollapsed(localStorage.getItem("naxie.sidebarCollapsed") === "1");
        setMobileNavOpen(false);
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
    if (!isSmallScreen) localStorage.setItem("naxie.sidebarCollapsed", collapsed ? "1" : "0");
  }, [collapsed, isSmallScreen]);

  // Persist group expand/collapse state across reloads so the user's
  // preferred sidebar shape survives a refresh.
  useEffect(() => {
    if (isSmallScreen) return;
    localStorage.setItem("naxie.sidebarGroups", JSON.stringify(openGroups));
  }, [openGroups, isSmallScreen]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavOpen]);

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

  const renderNavItem = (n: NavItem, _idx?: number | { glow?: boolean }, _arr?: NavItem[], opts?: { glow?: boolean }) => {
    const Icon = n.icon;
    // Accepts both renderNavItem(n, { glow: true }) and .map(renderNavItem)
    // (which passes (item, index, array)) — the index/array are ignored.
    const glowClass = (opts?.glow ?? (typeof _idx === "object" ? _idx.glow : false)) ? "nw-nav-glow" : "";
    if (n.external) {
      return (
        <a
          key={n.to}
          href={n.to}
          target="_blank"
          rel="noopener noreferrer"
          title={compactNav ? n.label : undefined}
          className={`flex items-center gap-3 py-2 rounded-md text-sm transition-colors ${compactNav ? "justify-center px-2" : "px-3"} text-cream-300 hover:text-cream-50 hover:bg-ink-800/60 hover:shadow-[0_0_12px_-2px_rgba(167,139,250,0.4)]`}
        >
          <Icon size={16} className={`${n.iconColor ?? "text-cream-300/70"} shrink-0 drop-shadow-[0_0_4px_rgba(167,139,250,0.3)] ${glowClass}`} />
          {!compactNav && <span className="flex-1 truncate">{n.label}</span>}
          {!compactNav && <span className="text-[9px] text-cream-300/40">↗</span>}
        </a>
      );
    }
    return (
      <NavLink
        key={n.to}
        to={n.to}
        title={compactNav ? n.label : undefined}
        onMouseEnter={() => preloadRoute(n.to)}
        onFocus={() => preloadRoute(n.to)}
        onClick={() => { if (isSmallScreen) setMobileNavOpen(false); }}
        className={({ isActive }) =>
          `flex items-center gap-3 py-2 rounded-md text-sm transition-colors ${compactNav ? "justify-center px-2" : "px-3"} ${isActive ? "bg-ink-800 text-cream-50 shadow-[0_0_16px_-4px_rgba(167,139,250,0.5)]" : "text-cream-300 hover:text-cream-50 hover:bg-ink-800/60 hover:shadow-[0_0_12px_-2px_rgba(167,139,250,0.4)]"}`
        }
      >
        <Icon size={16} className={`${n.iconColor ?? "text-cream-300/70"} shrink-0 drop-shadow-[0_0_4px_rgba(167,139,250,0.3)] ${glowClass}`} />
        {!compactNav && <span className="flex-1 truncate">{n.label}</span>}
        {!compactNav && n.badgeKey && counts[n.badgeKey] > 0 && (
          <span className="bg-violet-500/20 text-violet-400 text-[10px] px-1.5 py-0.5 rounded-full font-mono shadow-[0_0_8px_rgba(167,139,250,0.3)]">
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
    const isKnowledgeGroup = key === "knowledge";
    const toggle = () => setOpenGroups((g) => ({ ...g, [key]: !(g[key] ?? hasActive) }));
    return (
      <div key={key}>
        <button
          type="button"
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              toggle();
            }
          }}
          aria-expanded={open}
          aria-controls={`nav-group-${key}`}
          className={`w-full flex items-center gap-3 px-3 py-2 mt-3 rounded-lg text-sm transition-colors ${hasActive && isKnowledgeGroup ? "bg-teal-400/[0.08] text-teal-100 ring-1 ring-inset ring-teal-300/10 shadow-[0_0_16px_-4px_rgba(45,212,191,0.3)]" : "text-cream-300 hover:text-cream-50 hover:bg-ink-800/60 hover:shadow-[0_0_12px_-2px_rgba(167,139,250,0.3)]"}`}
        >
          <Icon size={16} className={`${hasActive && isKnowledgeGroup ? "text-teal-300" : "text-cream-300/70"} shrink-0 drop-shadow-[0_0_4px_rgba(167,139,250,0.3)]`} />
          <span className="flex-1 text-left">{label}</span>
          {/* Aggregate badge — keeps a pending count visible even when collapsed. */}
          {badge > 0 && !open && (
            <span className="bg-violet-500/20 text-violet-400 text-[10px] px-1.5 py-0.5 rounded-full font-mono shadow-[0_0_8px_rgba(167,139,250,0.3)]">
              {badge}
            </span>
          )}
          <ChevronRight size={14} className={`text-cream-300/50 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
        {open && (
          <div id={`nav-group-${key}`} className="ml-3 space-y-0.5 border-l border-ink-800 pl-3">
            {items.map((item) => renderNavItem(item))}
          </div>
        )}
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
        {isSmallScreen && mobileNavOpen && (
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          />
        )}
        <aside
           id="main-navigation"
           aria-label="Main navigation"
           hidden={isSmallScreen && !mobileNavOpen}
           style={isSmallScreen && !mobileNavOpen ? { display: "none" } : undefined}
           className={`${isSmallScreen ? "fixed inset-y-0 left-0 z-50 w-72 shadow-2xl" : `shrink-0 ${collapsed ? "w-16" : "w-60"}`} bg-ink-900 border-r border-ink-800 flex flex-col transition-[width,transform] duration-200 overflow-hidden shadow-[0_0_40px_-10px_rgba(167,139,250,0.15)]`}
         >
           <div
             className={`flex items-center ${compactNav ? "flex-col gap-2 px-2 py-4" : "justify-between px-4 py-4 tablet:px-5 tablet:py-5"}`}
           >
             <Link to="/naxie" onClick={() => setMobileNavOpen(false)} className={`flex items-center gap-2.5 min-w-0 ${compactNav ? "justify-center" : ""} group`}>
               <div className="drop-shadow-[0_0_12px_rgba(167,139,250,0.4)] group-hover:drop-shadow-[0_0_20px_rgba(167,139,250,0.6)] transition-all nw-nav-glow">
                 <BrandMark size={26} />
               </div>
               {!compactNav && (
                 <div className="w-[168px] h-8">
                   <PixelDriftText text="NaxionAI" />
                 </div>
               )}
             </Link>
             <div className={`flex items-center gap-1 ${compactNav ? "" : "shrink-0"}`}>
               {!isSmallScreen && <button
                 type="button"
                 onClick={() => setCollapsed((c) => !c)}
                 title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                 aria-label="Toggle sidebar"
                 className="grid place-items-center w-7 h-7 border border-ink-700 hover:border-violet-500/40 rounded-md text-cream-300 hover:text-cream-100 transition-colors shrink-0 hover:shadow-[0_0_12px_-3px_rgba(167,139,250,0.4)]"
               >
                 {collapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}
               </button>}
               {isSmallScreen && <button type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" className="grid place-items-center w-9 h-9 rounded-md text-cream-300 hover:bg-ink-800"><X size={18} /></button>}
             </div>
           </div>

           {!compactNav && (
             <div className="px-4 pb-4 tablet:px-5">
               <div className="w-full aspect-square rounded-full overflow-hidden border border-ink-700">
                 <img src="/brand/logo.jpg" alt="Naxie" className="w-full h-full object-cover" />
               </div>
             </div>
           )}

           <nav aria-label="Primary" className={`flex-1 space-y-0.5 overflow-y-auto scrollbar-thin ${compactNav ? "px-2" : "px-3"}`}>
             {primaryNav.map(n => renderNavItem(n, { glow: true }))}
{compactNav ? (
                <>
                  {workspaceNav.map(renderNavItem)}
                  {mySuiteNav.map(renderNavItem)}
                  {knowledgeNav.map(renderNavItem)}
                  {connectNav.map(renderNavItem)}
                  {systemNav.map(renderNavItem)}
                  {renderNavItem(securityScanNav, { glow: true })}
                  {renderNavItem(somaticOraNav, { glow: true })}
                </>
              ) : (
                <>
                  {renderGroup("workspace", "WorkSpace", WorkspaceFolderIcon, workspaceNav, counts.approvals + counts.activity)}
                  {renderGroup("mysuite", "My Suite", Briefcase, mySuiteNav)}
                  {renderGroup("knowledge", "Knowledge Studio", BookOpen, knowledgeNav)}
                  {renderGroup("connect", "Connect", Puzzle, connectNav)}
                  {renderGroup("system", "System", Settings, systemNav)}
                  {renderNavItem(securityScanNav, { glow: true })}
                  {renderNavItem(somaticOraNav, { glow: true })}
                </>
              )}
           </nav>

           <div className="px-3 py-3 border-t border-ink-800">
             {!compactNav && <OfflineFooterLabel />}
           </div>
         </aside>

         <main className="flex-1 flex flex-col overflow-hidden">
           <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 tablet:px-6 tablet:py-2 border-b border-ink-800 shadow-[0_0_30px_-10px_rgba(167,139,250,0.1)]">
             <div className="flex items-center gap-2.5 min-w-0">
               {isSmallScreen && <button type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation" aria-controls="main-navigation" aria-expanded={mobileNavOpen} className="grid place-items-center w-9 h-9 -ml-2 rounded-md text-cream-200 hover:bg-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"><Menu size={18} /></button>}
               {user ? (
                 <>
                   <div className="w-7 h-7 shrink-0 rounded-full bg-gradient-to-br from-violet-500 to-coral-500 grid place-items-center text-[11px] font-semibold text-white shadow-[0_0_12px_-2px_rgba(167,139,250,0.5)]">
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
                   className="nw-shiny-pill flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border bg-violet-500/10 border-violet-500/30 text-violet-300 shadow-[0_0_12px_-3px_rgba(167,139,250,0.4)] hover:shadow-[0_0_16px_-2px_rgba(167,139,250,0.5)] transition-shadow"
                   title="Active persona"
                 >
                   <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0 drop-shadow-[0_0_4px_rgba(167,139,250,0.6)]" />
                   <span className="truncate max-w-[8rem] tablet:max-w-none">{persona.name}</span>
                   <span className="opacity-60 hidden tablet:inline">· {persona.role}</span>
                 </Link>
               )}
               <div
                 className={`nw-shiny-pill flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${statusOk ? "bg-leaf-500/10 border-leaf-500/30 text-leaf-400 shadow-[0_0_12px_-3px_rgba(34,197,94,0.3)]" : "bg-flame-500/10 border-flame-500/30 text-flame-400 shadow-[0_0_12px_-3px_rgba(239,68,68,0.3)]"}`}
               >
                 <span
                   className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${statusOk ? "bg-leaf-500" : "bg-flame-500 animate-pulse"}`}
                 />
                 <span className="hidden tablet:inline">{statusLabel}</span>
               </div>
               <OfflineToggle />
               <button
                 type="button"
                 onClick={() => {
                   const ev = new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true });
                   document.dispatchEvent(ev);
                 }}
                 className="flex items-center gap-2 text-xs px-3 py-1.5 border border-ink-700 hover:border-violet-500/40 rounded-md text-cream-300 hover:text-cream-100 transition-colors hover:shadow-[0_0_12px_-3px_rgba(167,139,250,0.3)]"
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
           <a href="#main-content" className="skip-link">Skip to main content</a>
           <div id="main-content" tabIndex={-1} className={`flex-1 scrollbar-thin ${clearBackground ? "overflow-y-auto tablet:overflow-hidden" : "overflow-auto"}`}>
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