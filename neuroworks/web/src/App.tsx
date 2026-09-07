import { Routes, Route, Navigate, useParams } from "react-router-dom";
import { lazy, Suspense } from "react";
import { Layout } from "./components/Layout";
import { Skeleton } from "./components/Card";

// Route-level code splitting — every page is fetched on demand (see
// vite.config.ts's manualChunks for the vendor split that pairs with this),
// so a change to one page doesn't bust the cache for the others.

// Home Base
const Naxie = lazy(() => import("./pages/Naxie").then(m => ({ default: m.Naxie })));
const NaxieMemory = lazy(() => import("./pages/NaxieMemory").then(m => ({ default: m.NaxieMemory })));
const BoardMeeting = lazy(() => import("./pages/BoardMeeting").then(m => ({ default: m.BoardMeeting })));
const CommandCenter = lazy(() => import("./pages/CommandCenter").then(m => ({ default: m.CommandCenter })));

// Agents & Subagents
const AgentRoster = lazy(() => import("./pages/AgentRoster").then(m => ({ default: m.AgentRoster })));
const Squads = lazy(() => import("./pages/Squads").then(m => ({ default: m.Squads })));
const Orchestrate = lazy(() => import("./pages/Orchestrate").then(m => ({ default: m.Orchestrate })));
const SpinUpAgent = lazy(() => import("./pages/SpinUpAgent").then(m => ({ default: m.SpinUpAgent })));

// Work Queue
const Runs = lazy(() => import("./pages/Runs").then(m => ({ default: m.Runs })));
const RunDetail = lazy(() => import("./pages/Runs").then(m => ({ default: m.RunDetail })));
const AgentApprovals = lazy(() => import("./pages/AgentApprovals").then(m => ({ default: m.AgentApprovals })));
const MyTasks = lazy(() => import("./pages/MyTasks").then(m => ({ default: m.MyTasks })));
const CalendarPage = lazy(() => import("./pages/CalendarPage").then(m => ({ default: m.CalendarPage })));
const Schedules = lazy(() => import("./pages/Schedules").then(m => ({ default: m.Schedules })));

// Build
const IDE = lazy(() => import("./pages/IDE").then(m => ({ default: m.IDE })));

// Memory & Knowledge
const Library = lazy(() => import("./pages/Library").then(m => ({ default: m.Library })));
const KnowledgePacks = lazy(() => import("./pages/KnowledgePacks").then(m => ({ default: m.KnowledgePacks })));
const DailyReports = lazy(() => import("./pages/DailyReports").then(m => ({ default: m.DailyReports })));
const Templates = lazy(() => import("./pages/Templates").then(m => ({ default: m.Templates })));
const Skills = lazy(() => import("./pages/Skills").then(m => ({ default: m.Skills })));

// Connect
const Extensions = lazy(() => import("./pages/Extensions").then(m => ({ default: m.Extensions })));
const GithubAccounts = lazy(() => import("./pages/GithubAccounts").then(m => ({ default: m.GithubAccounts })));

// Govern
const Policies = lazy(() => import("./pages/Policies").then(m => ({ default: m.Policies })));
const AuditLog = lazy(() => import("./pages/AuditLog").then(m => ({ default: m.AuditLog })));
const Cost = lazy(() => import("./pages/Cost").then(m => ({ default: m.Cost })));

// Ambient Watch — stub only, no logic yet
const AmbientWatch = lazy(() => import("./pages/AmbientWatch").then(m => ({ default: m.AmbientWatch })));

// Misc / unchanged
const DocEditor = lazy(() => import("./pages/DocEditor").then(m => ({ default: m.DocEditor })));
const MyWork = lazy(() => import("./pages/MyWork").then(m => ({ default: m.MyWork })));
const SkillForge = lazy(() => import("./pages/SkillForge").then(m => ({ default: m.SkillForge })));

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
        <Route path="/chat" element={<BoardMeeting />} />
        <Route path="/command" element={<CommandCenter />} />

        {/* Agents & Subagents */}
        <Route path="/agents" element={<AgentRoster />} />
        <Route path="/squads" element={<Squads />} />
        <Route path="/orchestrate" element={<Orchestrate />} />
        <Route path="/spin-up" element={<SpinUpAgent />} />

        {/* Work Queue */}
        <Route path="/runs" element={<Runs />} />
        <Route path="/runs/:jobId" element={<RunDetail />} />
        <Route path="/approvals" element={<AgentApprovals />} />
        <Route path="/my-tasks" element={<MyTasks />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/schedules" element={<Schedules />} />

        {/* Build — Home Base's "Naxion IDE" nav entry links here */}
        <Route path="/ide" element={<IDE />} />

        {/* Memory & Knowledge */}
        <Route path="/library/*" element={<Library />} />
        <Route path="/knowledge-packs" element={<KnowledgePacks />} />
        <Route path="/daily-reports" element={<DailyReports />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/skills" element={<Skills />} />

        {/* Connect */}
        <Route path="/extensions" element={<Extensions />} />
        <Route path="/integrations" element={<Navigate to="/extensions?tab=integrations" replace />} />
        <Route path="/connectors" element={<Navigate to="/extensions?tab=connectors" replace />} />
        <Route path="/github-accounts" element={<GithubAccounts />} />

        {/* Govern */}
        <Route path="/policies" element={<Policies />} />
        <Route path="/audit" element={<AuditLog />} />
        <Route path="/cost" element={<Cost />} />

        {/* Ambient Watch — stub */}
        <Route path="/ambient" element={<AmbientWatch />} />

        {/* Misc, unchanged */}
        <Route path="/edit" element={<DocEditor />} />
        <Route path="/edit/*" element={<DocEditor />} />
        <Route path="/my-work" element={<MyWork />} />
        <Route path="/skill-forge" element={<SkillForge />} />

        {/* Transition redirects — old paths never hard-404 */}
        <Route path="/dashboard" element={<Navigate to="/naxie" replace />} />
        <Route path="/activity" element={<Navigate to="/runs" replace />} />
        <Route path="/tasks" element={<Navigate to="/runs" replace />} />
        <Route path="/results" element={<Navigate to="/runs" replace />} />
        <Route path="/results/:jobId" element={<ResultsRedirect />} />
        <Route path="/quality" element={<Navigate to="/runs?filter=quality" replace />} />
        <Route path="/team" element={<Navigate to="/orchestrate" replace />} />
        <Route path="/presets" element={<Navigate to="/spin-up" replace />} />
        <Route path="/workforce" element={<Navigate to="/agents" replace />} />
        <Route path="/personas" element={<Navigate to="/agents" replace />} />
        <Route path="/departments" element={<Navigate to="/squads" replace />} />
        <Route path="/governance" element={<Navigate to="/policies" replace />} />
        <Route path="/security" element={<Navigate to="/audit" replace />} />
        <Route path="/knowledge/*" element={<Navigate to="/library" replace />} />
        <Route path="/data-sources" element={<Navigate to="/library/data" replace />} />
        <Route path="/terminal" element={<Navigate to="/ide" replace />} />
        <Route path="/onboarding" element={<Navigate to="/naxie" replace />} />

        <Route path="*" element={<Navigate to="/naxie" />} />
      </Routes>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  return <AppShell />;
}
