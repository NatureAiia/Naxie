import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Layout } from "./components/Layout";
import { Skeleton } from "./components/Card";

// Route-level code splitting — every page is fetched on demand (see
// vite.config.ts's manualChunks for the vendor split that pairs with this),
// so a change to one page doesn't bust the cache for the others.

// Home Base
const Naxie = lazy(() => import("./pages/Naxie").then(m => ({ default: m.Naxie })));
const Onboarding = lazy(() => import("./pages/Onboarding").then(m => ({ default: m.Onboarding })));
const NaxieMemory = lazy(() => import("./pages/NaxieMemory").then(m => ({ default: m.NaxieMemory })));
const BoardMeeting = lazy(() => import("./pages/BoardMeeting").then(m => ({ default: m.BoardMeeting })));
const CommandCenter = lazy(() => import("./pages/CommandCenter").then(m => ({ default: m.CommandCenter })));

// Agents & Subagents
const Office = lazy(() => import("./pages/Office").then(m => ({ default: m.Office })));

// Work Queue — Runs + Approvals now live inside MyWork; detail stays standalone
const RunDetail = lazy(() => import("./pages/Runs").then(m => ({ default: m.RunDetail })));
const Planner = lazy(() => import("./pages/Planner").then(m => ({ default: m.Planner })));
const MyFinances = lazy(() => import("./pages/MyFinances").then(m => ({ default: m.MyFinances })));
const WorkflowTree = lazy(() => import("./pages/WorkflowTree").then(m => ({ default: m.WorkflowTree })));
const Schedules = lazy(() => import("./pages/Schedules").then(m => ({ default: m.Schedules })));

// Build
const IDE = lazy(() => import("./pages/IDE").then(m => ({ default: m.IDE })));

// Memory & Knowledge
const Library = lazy(() => import("./pages/Library").then(m => ({ default: m.Library })));
const DailyReports = lazy(() => import("./pages/DailyReports").then(m => ({ default: m.DailyReports })));
const Templates = lazy(() => import("./pages/Templates").then(m => ({ default: m.Templates })));
const Skills = lazy(() => import("./pages/Skills").then(m => ({ default: m.Skills })));

// Connect
const Extensions = lazy(() => import("./pages/Extensions").then(m => ({ default: m.Extensions })));
const WhatsApp = lazy(() => import("./pages/WhatsApp").then(m => ({ default: m.WhatsApp })));
const Connectors = lazy(() => import("./pages/Connectors").then(m => ({ default: m.Connectors })));
const McpServers = lazy(() => import("./pages/McpServers").then(m => ({ default: m.McpServers })));
const Hermes = lazy(() => import("./pages/Hermes").then(m => ({ default: m.Hermes })));
const Brands = lazy(() => import("./pages/Brands").then(m => ({ default: m.Brands })));
const GithubAccounts = lazy(() => import("./pages/GithubAccounts").then(m => ({ default: m.GithubAccounts })));
const Pentest = lazy(() => import("./pages/Pentest").then(m => ({ default: m.Pentest })));

// Govern — Policies now lives as a tab inside Connectors; OrgDashboard merged into CommandCenter
const PoliciesRedirect = () => <Navigate to="/connectors?tab=policies" replace />;

// Ambient Watch — stub only, no logic yet
const AmbientWatch = lazy(() => import("./pages/AmbientWatch").then(m => ({ default: m.AmbientWatch })));

// Misc / unchanged
const DocEditor = lazy(() => import("./pages/DocEditor").then(m => ({ default: m.DocEditor })));
const MyWork = lazy(() => import("./pages/MyWork").then(m => ({ default: m.MyWork })));

// Lightweight, layout-shift-free placeholder while a route chunk downloads —
// on a warm cache this never has time to paint; on a cold load it beats a
// blank white flash.
// Shown only in the gap between a route's chunk being requested and resolving.
// With hover-prefetch (routePreload.ts) that gap is usually zero — this exists
// for a cold click on a not-yet-warmed route. Fades in (nw-fade-up) so a
// sub-frame flash doesn't strobe, and the skeletons shimmer (`.skeleton`).
function RouteFallback() {
  return (
    <div className="space-y-3 nw-fade-up">
      <div className="flex items-center gap-2 text-xs text-cream-300/50">
        <span className="nw-thinking-dots" aria-hidden><span /><span /><span /></span>
        Loading…
      </div>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

// react-router's <Navigate> can't interpolate a route param directly in JSX —
// this tiny wrapper forwards :jobId from the old /results/:jobId path to its
// new home at /runs/:jobId.
function ResultsRedirect() {
  const { jobId } = useParams();
  return <Navigate to={`/runs/${jobId}`} replace />;
}

function AppShell() {
  return (
    <Layout>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<Navigate to="/naxie" />} />

        {/* Home Base */}
        <Route path="/naxie" element={<Naxie />} />
        <Route path="/naxie/memory" element={<NaxieMemory />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/chat" element={<BoardMeeting />} />
        <Route path="/command" element={<CommandCenter />} />

        {/* Agents & Subagents */}
        <Route path="/office" element={<Office />} />

        {/* Work Queue — My Work + Runs merged into one Work page; approvals live in the Inbox */}
        <Route path="/runs" element={<Navigate to="/my-work?tab=runs" replace />} />
        <Route path="/runs/:jobId" element={<RunDetail />} />
        <Route path="/approvals" element={<Navigate to="/my-work" replace />} />
        <Route path="/my-tasks" element={<Navigate to="/planner" replace />} />
        <Route path="/brands" element={<Brands />} />
        <Route path="/crm" element={<Navigate to="/naxie" replace />} />
        <Route path="/planner" element={<Planner />} />
        <Route path="/my-finances" element={<MyFinances />} />
        <Route path="/workflow-tree" element={<WorkflowTree />} />
        <Route path="/calendar" element={<Navigate to="/planner" replace />} />
        <Route path="/schedules" element={<Schedules />} />

        {/* Build — Home Base's "Naxion IDE" nav entry links here */}
        <Route path="/ide" element={<IDE />} />

        {/* Memory & Knowledge */}
        <Route path="/library/*" element={<Library />} />
        <Route path="/daily-reports" element={<DailyReports />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/skills" element={<Skills />} />

        {/* Connect */}
        <Route path="/extensions" element={<Extensions />} />
        <Route path="/integrations" element={<Navigate to="/extensions?tab=integrations" replace />} />
        <Route path="/whatsapp" element={<WhatsApp />} />
        <Route path="/connectors" element={<Connectors />} />
        <Route path="/mcp-servers" element={<McpServers />} />
        <Route path="/hermes" element={<Hermes />} />
        <Route path="/hermes-bridge" element={<Navigate to="/hermes" replace />} />
        <Route path="/github-accounts" element={<GithubAccounts />} />
        <Route path="/pentest" element={<Pentest />} />

        {/* Govern — merged */}
        <Route path="/policies" element={<PoliciesRedirect />} />
        <Route path="/audit" element={<Navigate to="/extensions?tab=audit" replace />} />
        <Route path="/org-dashboard" element={<Navigate to="/command?tab=org" replace />} />
        <Route path="/cost" element={<Navigate to="/extensions?tab=cost" replace />} />
        <Route path="/admin/notifications" element={<Navigate to="/audit" replace />} />
        <Route path="/admin/email-telegram" element={<Navigate to="/connectors" replace />} />

        {/* Ambient Watch — stub */}
        <Route path="/ambient" element={<AmbientWatch />} />

        {/* Misc, unchanged */}
        <Route path="/edit" element={<DocEditor />} />
        <Route path="/edit/*" element={<DocEditor />} />
        <Route path="/my-work" element={<MyWork />} />

        {/* Transition redirects — old paths never hard-404 */}
        <Route path="/dashboard" element={<Navigate to="/naxie" replace />} />
        <Route path="/activity" element={<Navigate to="/runs" replace />} />
        <Route path="/tasks" element={<Navigate to="/runs" replace />} />
        <Route path="/results" element={<Navigate to="/runs" replace />} />
        <Route path="/results/:jobId" element={<ResultsRedirect />} />
        <Route path="/quality" element={<Navigate to="/runs?filter=quality" replace />} />
        <Route path="/agents" element={<Navigate to="/office" replace />} />
        <Route path="/team" element={<Navigate to="/office" replace />} />
        <Route path="/presets" element={<Navigate to="/office" replace />} />
        <Route path="/workforce" element={<Navigate to="/office" replace />} />
        <Route path="/personas" element={<Navigate to="/office" replace />} />
        <Route path="/departments" element={<Navigate to="/office" replace />} />
        <Route path="/squads" element={<Navigate to="/office" replace />} />
        <Route path="/orchestrate" element={<Navigate to="/office" replace />} />
        <Route path="/spin-up" element={<Navigate to="/office" replace />} />
        <Route path="/skill-forge" element={<Navigate to="/skills?tab=forge" replace />} />
        <Route path="/governance" element={<Navigate to="/connectors?tab=policies" replace />} />
        <Route path="/security" element={<Navigate to="/audit" replace />} />
        <Route path="/knowledge/*" element={<Navigate to="/library" replace />} />
        <Route path="/knowledge-packs" element={<Navigate to="/library/datasets" replace />} />
        <Route path="/data-sources" element={<Navigate to="/library/data" replace />} />
        <Route path="/terminal" element={<Navigate to="/ide" replace />} />

        <Route path="*" element={<Navigate to="/naxie" />} />
      </Routes>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  return <AppShell />;
}
