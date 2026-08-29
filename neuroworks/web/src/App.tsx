import { Routes, Route, Navigate } from "react-router-dom";
import { lazy, Suspense, useEffect, useState } from "react";
import { Layout } from "./components/Layout";
import { Skeleton } from "./components/Card";
import { api, layerOfRole, type AccessLayer } from "./lib/api";

// Client-side route guard for admin-only pages (Approvals, Security). This is
// defense-in-depth — the server already gates these APIs with requireLayer —
// but without it a staff user could navigate straight to the URL and load a
// page that only 403s on action. No session = loopback operator = full access,
// mirroring Layout's own layer logic. While the session resolves we render
// nothing (avoids a flash), then redirect staff to /chat.
function AdminOnly({ children }: { children: React.ReactNode }) {
  const [layer, setLayer] = useState<AccessLayer | "loading">("loading");
  useEffect(() => {
    let alive = true;
    api.session()
      .then(s => { if (alive) setLayer(!s.user ? "superadmin" : layerOfRole(s.user.role)); })
      .catch(() => { if (alive) setLayer("superadmin"); });
    return () => { alive = false; };
  }, []);
  if (layer === "loading") return null;
  if (layer === "staff") return <Navigate to="/chat" replace />;
  return <>{children}</>;
}

// Route-level code splitting. Onboarding loads eagerly (it's the first thing
// a fresh workspace sees); everything behind the app shell is fetched on
// demand — a user opening the app to check one page shouldn't download all
// 30+ pages' worth of JS up front. Each page becomes its own fingerprinted
// chunk (see vite.config.ts's manualChunks for the vendor split that pairs
// with this), so a change to one page doesn't bust the cache for the others
// either.
import { Onboarding } from "./pages/Onboarding";
const Dashboard = lazy(() => import("./pages/Dashboard").then(m => ({ default: m.Dashboard })));
const Tasks = lazy(() => import("./pages/Tasks").then(m => ({ default: m.Tasks })));
const MyTasks = lazy(() => import("./pages/MyTasks").then(m => ({ default: m.MyTasks })));
const Templates = lazy(() => import("./pages/Templates").then(m => ({ default: m.Templates })));
const Approvals = lazy(() => import("./pages/Approvals").then(m => ({ default: m.Approvals })));
const Security = lazy(() => import("./pages/Security").then(m => ({ default: m.Security })));
const Activity = lazy(() => import("./pages/Activity").then(m => ({ default: m.Activity })));
const Knowledge = lazy(() => import("./pages/Knowledge").then(m => ({ default: m.Knowledge })));
const Admin = lazy(() => import("./pages/Admin").then(m => ({ default: m.Admin })));
const Chat = lazy(() => import("./pages/Chat").then(m => ({ default: m.Chat })));
const Personas = lazy(() => import("./pages/Personas").then(m => ({ default: m.Personas })));
const Team = lazy(() => import("./pages/Team").then(m => ({ default: m.Team })));
const ResultsIndex = lazy(() => import("./pages/Results").then(m => ({ default: m.ResultsIndex })));
const Results = lazy(() => import("./pages/Results").then(m => ({ default: m.Results })));
const Skills = lazy(() => import("./pages/Skills").then(m => ({ default: m.Skills })));
const Schedules = lazy(() => import("./pages/Schedules").then(m => ({ default: m.Schedules })));
const Governance = lazy(() => import("./pages/Governance").then(m => ({ default: m.Governance })));
const CalendarPage = lazy(() => import("./pages/CalendarPage").then(m => ({ default: m.CalendarPage })));
const DocEditor = lazy(() => import("./pages/DocEditor").then(m => ({ default: m.DocEditor })));
const DataSources = lazy(() => import("./pages/DataSources").then(m => ({ default: m.DataSources })));
const Extensions = lazy(() => import("./pages/Extensions").then(m => ({ default: m.Extensions })));
const Presets = lazy(() => import("./pages/Presets").then(m => ({ default: m.Presets })));
const Workforce = lazy(() => import("./pages/Workforce").then(m => ({ default: m.Workforce })));
const Departments = lazy(() => import("./pages/Departments").then(m => ({ default: m.Departments })));
const KnowledgePacks = lazy(() => import("./pages/KnowledgePacks").then(m => ({ default: m.KnowledgePacks })));
const Quality = lazy(() => import("./pages/Quality").then(m => ({ default: m.Quality })));
const Cost = lazy(() => import("./pages/Cost").then(m => ({ default: m.Cost })));
const AuditLog = lazy(() => import("./pages/AuditLog").then(m => ({ default: m.AuditLog })));
const SkillForge = lazy(() => import("./pages/SkillForge").then(m => ({ default: m.SkillForge })));
const Orchestrate = lazy(() => import("./pages/Orchestrate").then(m => ({ default: m.Orchestrate })));
const DailyReports = lazy(() => import("./pages/DailyReports").then(m => ({ default: m.DailyReports })));
const MyWork = lazy(() => import("./pages/MyWork").then(m => ({ default: m.MyWork })));
const Naxie = lazy(() => import("./pages/Naxie").then(m => ({ default: m.Naxie })));
const NaxieMemory = lazy(() => import("./pages/NaxieMemory").then(m => ({ default: m.NaxieMemory })));

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

function AppShell() {
  return (
    <Layout>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<Navigate to="/naxie" />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/naxie" element={<Naxie />} />
        <Route path="/naxie/memory" element={<NaxieMemory />} />
        <Route path="/team" element={<Team />} />
        <Route path="/presets" element={<Presets />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/my-tasks" element={<MyTasks />} />
        <Route path="/results" element={<ResultsIndex />} />
        <Route path="/results/:jobId" element={<Results />} />
        <Route path="/daily-reports" element={<DailyReports />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/skills" element={<Skills />} />
        <Route path="/approvals" element={<AdminOnly><Approvals /></AdminOnly>} />
        <Route path="/security" element={<AdminOnly><Security /></AdminOnly>} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/my-work" element={<MyWork />} />
        <Route path="/schedules" element={<Schedules />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/edit" element={<DocEditor />} />
        <Route path="/edit/*" element={<DocEditor />} />
        <Route path="/governance" element={<Governance />} />
        <Route path="/knowledge/*" element={<Knowledge />} />
        <Route path="/data-sources" element={<DataSources />} />
        <Route path="/integrations" element={<Navigate to="/extensions?tab=integrations" replace />} />
        <Route path="/connectors" element={<Navigate to="/extensions?tab=connectors" replace />} />
        <Route path="/extensions" element={<Extensions />} />
        <Route path="/workforce" element={<Workforce />} />
        <Route path="/departments" element={<Departments />} />
        <Route path="/knowledge-packs" element={<KnowledgePacks />} />
        <Route path="/quality" element={<Quality />} />
        <Route path="/cost" element={<Cost />} />
        <Route path="/audit" element={<AuditLog />} />
        <Route path="/skill-forge" element={<SkillForge />} />
        <Route path="/orchestrate" element={<Orchestrate />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/personas" element={<Personas />} />
        <Route path="*" element={<Navigate to="/dashboard" />} />
      </Routes>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  // /onboarding renders bare (no sidebar/header); everything else inside the app shell.
  return (
    <Routes>
      <Route path="/onboarding" element={<Onboarding />} />
      <Route path="*" element={<AppShell />} />
    </Routes>
  );
}
