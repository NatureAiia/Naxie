import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, Template } from "../lib/api";
import { Card, RoleIcon } from "../components/Card";
import { TaskRunner } from "../components/TaskRunner";
import { AgentVisualizer } from "../components/AgentVisualizer";
import { DynamicWeightText } from "../components/DynamicWeightText";
import { TextMorph } from "../components/TextMorph";
import { TextLift } from "../components/TextLift";
import { Typewriter } from "../components/Typewriter";
import { MagneticRow } from "../components/MagneticRow";
import { lazy, Suspense } from "react";

// three.js is ~600KB — the globe loads as its own chunk only when the
// Workforce card actually renders, so the dashboard's initial JS stays flat.
const WorkforceGlobe = lazy(() => import("../components/WorkforceGlobe").then(m => ({ default: m.WorkforceGlobe })));
import { t } from "../lib/i18n";
import { MapPin, Building2, Globe, BookOpen, Plug, Zap, ShieldCheck, Server, Flag, Users, User as UserIcon } from "lucide-react";
import type { SectorInfo, KnowledgePack } from "../lib/api";

// Snapshot of the slow-lane payload, persisted per browser session so a
// revisit paints instantly from cache while fresh data loads behind it —
// the dashboard should never sit blank for the length of 12 API calls.
const DASH_CACHE_KEY = "nw.dash.snapshot.v1";

export function Dashboard() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  // null = still loading (skeleton); [] = genuinely no tasks yet.
  const [recent, setRecent] = useState<any[] | null>(null);
  const [active, setActive] = useState<Template | null>(null);
  const [prefill, setPrefill] = useState<Record<string, any> | undefined>(undefined);
  const [nl, setNl] = useState("");
  const [intentBusy, setIntentBusy] = useState(false);
  const [err, setErr] = useState("");
  const [persona, setPersona] = useState<any>(null);
  const [onboarding, setOnboarding] = useState<{ sector?: string; customSectorName?: string; orgName?: string; completed?: boolean }>({});
  const [sectorContext, setSectorContext] = useState("");
  const [sectorLabel, setSectorLabel] = useState("");
  const [activeSectorInfo, setActiveSectorInfo] = useState<SectorInfo | null>(null);
  const [allDepartments, setAllDepartments] = useState<any[]>([]);
  const [knowledgePack, setKnowledgePack] = useState<KnowledgePack | null>(null);
  const [orgStatus, setOrgStatus] = useState<{
    activePolicyCount: number; activePolicies: string[];
    connectedSystemCount: number; connectedSystems: string[];
    computeMode: "local-only" | "cloud-assisted"; dataResidency: "local" | "mixed";
  } | null>(null);
  // Full roster + the live clawbot fleet so the dashboard answers "who can I
  // hire right now, and who's currently working?" The roster comes from
  // /api/personas; the fleet comes from /api/peers (self + reachable peers).
  const [personas, setPersonas] = useState<any[]>([]);
  const [fleet, setFleet] = useState<{ self: any; peers: any[] } | null>(null);
  // External (CLI / process-per-task) agents like Hermes — surfaced in the
  // workforce card alongside clawbots so the operator sees a single roster.
  const [externalAgents, setExternalAgents] = useState<any[]>([]);
  const [activating, setActivating] = useState<string | null>(null);
  // Running jobs — the Workforce card derives live sub-agents (in-flight plan
  // steps; parallel waves = several sub-agents) from these.
  const [running, setRunning] = useState<any[]>([]);
  // Human side of the org — for the Workforce card's people/agent breakdown
  // and the "where time goes" panel lifted from the Cost page.
  const [org, setOrg] = useState<{ total: number; byLayer: Record<string, number>; byWorkMode: Record<string, number> } | null>(null);
  const [timeA, setTimeA] = useState<any | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  // Cost summary (LLM spend) + all-packs count feed the Mission Control
  // "Cost summary" card and the secondary "Total knowledge packs" tile.
  const [costSum, setCostSum] = useState<any | null>(null);
  const [workCost, setWorkCost] = useState<any | null>(null);
  const [packStats, setPackStats] = useState<{ total: number; installed: number } | null>(null);
  // Productivity = share of finished tasks that succeeded (whole journal,
  // system kinds filtered the same way as the recent-activity feed).
  const [jobStats, setJobStats] = useState<{ done: number; ok: number } | null>(null);
  // Live neuro count = reachable fleet (self + peers) + installed external
  // agents — the number the Mission Control "organization" card shows.
  const liveNeuros = (fleet ? 1 + (fleet.peers ?? []).filter((p: any) => p.ok && p.ready).length : 0) + externalAgents.filter(a => a.installed).length;

  // Fast lane: what changes second-to-second (running jobs, fleet health).
  // Polled every 6s; cheap on the server (in-memory job table + peer pings).
  async function loadFast() {
    try {
      const [j, peers] = await Promise.all([
        api.listJobs().catch(() => ({ jobs: [] as any[] })),
        api.peers().catch(() => null),
      ]);
      applyJobs(j);
      if (peers) setFleet(peers);
    } catch (e: any) { setErr(e.message); }
  }

  function applyJobs(j: { jobs: any[] }) {
      // Real recent activity: the last 20 jobs that represent actual user
      // tasks, newest first. Drop the internal/system kinds (peer delegations
      // — the primary-side twin of an ad-hoc job, daily reflections, and bare
      // knowledge-base searches) so the feed reads as "what the org did", not
      // plumbing. Sort by finished-or-started time so a just-completed task
      // surfaces at the top even if the list arrived unordered.
      const meaningful = (j.jobs ?? [])
        .filter((x: any) => {
          const kind = String(x.kind ?? "");
          if (kind.startsWith("peer:")) return false;
          if (kind.startsWith("reflection:")) return false;
          if (kind === "knowledge:search-brain") return false;
          return true;
        })
        .sort((a: any, b: any) => {
          const ta = new Date(a.finishedAt ?? a.startedAt ?? 0).getTime();
          const tb = new Date(b.finishedAt ?? b.startedAt ?? 0).getTime();
          return tb - ta;
        })
        .slice(0, 20);
      setRecent(meaningful);
      // Productivity: success rate over every finished, non-system task in
      // the journal (same kind filter as the feed, no 20-item cap).
      {
        const finished = (j.jobs ?? []).filter((x: any) => {
          const kind = String(x.kind ?? "");
          if (kind.startsWith("peer:") || kind.startsWith("reflection:") || kind === "knowledge:search-brain") return false;
          return x.status === "succeeded" || x.status === "failed";
        });
        setJobStats({ done: finished.length, ok: finished.filter((x: any) => x.status === "succeeded").length });
      }
      setRunning((j.jobs ?? []).filter((x: any) => x.status === "running" || x.status === "pending"));
  }

  // Slow lane: org shape, templates, cost, packs — changes over minutes, not
  // seconds. Polled every 30s so the dashboard idle load is 2 requests/6s
  // instead of 15 (was hammering cost/time-analysis/users on every tick).
  async function loadSlow() {
    try {
      const [t, p, ext, ob, depts, packs, st, orgOv, ta, us, cs, wc] = await Promise.all([
        api.listTemplates(),
        api.listPersonas().catch(() => ({ active: null, personas: [] } as any)),
        api.externalAgents().catch(() => ({ agents: [] as any[] })),
        api.getOnboarding().catch(() => ({ state: {} } as any)),
        api.listDepartments().catch(() => ({ departments: [] as any[] })),
        api.listKnowledgePacks().catch(() => ({ packs: [] as KnowledgePack[] })),
        api.status().catch(() => null),
        api.orgOverview().catch(() => null),
        api.timeAnalysis(30).catch(() => null),
        api.listUsers().catch(() => ({ users: [] as any[] })),
        api.getCostSummary().catch(() => null),
        api.workforceCost(30).catch(() => null),
      ]);
      setTemplates(t.templates);
      setPersona(p.active);
      setPersonas(Array.isArray(p.personas) ? p.personas : []);
      setExternalAgents(ext.agents ?? []);
      setAllDepartments(depts.departments ?? []);
      if (st?.orgStatus) setOrgStatus(st.orgStatus);
      if (orgOv) setOrg(orgOv);
      if (ta) setTimeA(ta);
      setUsers(Array.isArray(us.users) ? us.users : []);
      if (cs) setCostSum(cs);
      if (wc) setWorkCost(wc);
      setPackStats({ total: (packs.packs ?? []).length, installed: (packs.packs ?? []).filter((pk: any) => pk.installed).length });
      // Persist a slim snapshot so the NEXT visit paints instantly instead of
      // sitting blank while 12 requests round-trip. Slim = only what the
      // first paint renders; sessionStorage so it dies with the browser tab.
      try {
        sessionStorage.setItem(DASH_CACHE_KEY, JSON.stringify({
          templates: (t.templates ?? []).slice(0, 8),
          active: p.active ?? null,
          personas: (Array.isArray(p.personas) ? p.personas : []).slice(0, 12).map((x: any) => ({ id: x.id, name: x.name, role: x.role, description: x.description })),
          ext: (ext.agents ?? []).slice(0, 6),
          orgStatus: st?.orgStatus ?? null,
          org: orgOv ?? null,
          timeA: ta ? { days: ta.days, verdict: ta.verdict, totals: ta.totals, humanWorkHours: ta.humanWorkHours, slowestAgentTypes: (ta.slowestAgentTypes ?? []).slice(0, 5), longestWaits: (ta.longestWaits ?? []).slice(0, 5) } : null,
          users: (Array.isArray(us.users) ? us.users : []).slice(0, 12).map((u: any) => ({ name: u.name, email: u.email, department: u.department, role: u.role, workMode: u.workMode })),
          costSum: cs ? { totalCostUsd: cs.totalCostUsd, callCount: cs.callCount, byModel: (cs.byModel ?? []).slice(0, 3) } : null,
          workCost: wc ? { human: { costUsd: wc.human?.costUsd ?? 0, costZar: wc.human?.costZar ?? 0, totalHours: wc.human?.totalHours ?? 0 } } : null,
          packStats: { total: (packs.packs ?? []).length, installed: (packs.packs ?? []).filter((pk: any) => pk.installed).length },
        }));
      } catch { /* cache is best-effort */ }
      if (ob.state) {
        setOnboarding(ob.state);
        if (ob.state.sector) {
          api.getOnboardingContext(ob.state.sector).then(ctx => setSectorContext(ctx.context)).catch(() => {});
          // Sector "name" in the label pill: for the free-text "custom"
          // sector this is the org's own sector name, not the catalog
          // entry's generic "Custom" placeholder.
          const info = (ob.sectors ?? []).find((s: any) => s.id === ob.state.sector) ?? null;
          setActiveSectorInfo(info);
          const label = ob.state.sector === "custom" ? (ob.state.customSectorName || "Custom sector") : (info?.name ?? ob.state.sector);
          setSectorLabel(label);
          setKnowledgePack((packs.packs ?? []).find(pk => pk.sectorId === ob.state.sector) ?? null);
        }
      }
    } catch (e: any) { setErr(e.message); }
  }
  // 6s fast tick (jobs + fleet), every 5th tick also refreshes the slow lane.
  useEffect(() => {
    // Instant paint from the last session snapshot; fresh data replaces it
    // the moment loadSlow/loadFast land. Every field is optional — a stale
    // or partial cache can only ever ADD to the skeleton state, not break it.
    try {
      const c = JSON.parse(sessionStorage.getItem(DASH_CACHE_KEY) ?? "null");
      if (c && typeof c === "object") {
        if (Array.isArray(c.templates)) setTemplates(c.templates);
        if (c.active !== undefined) setPersona(c.active);
        if (Array.isArray(c.personas)) setPersonas(c.personas);
        if (Array.isArray(c.ext)) setExternalAgents(c.ext);
        if (c.orgStatus) setOrgStatus(c.orgStatus);
        if (c.org) setOrg(c.org);
        if (c.timeA) setTimeA(c.timeA);
        if (Array.isArray(c.users)) setUsers(c.users);
        if (c.costSum) setCostSum(c.costSum);
        if (c.workCost) setWorkCost(c.workCost);
        if (c.packStats) setPackStats(c.packStats);
      }
    } catch { /* corrupt cache → normal skeleton path */ }
    let tick = 0;
    loadSlow(); loadFast();
    const i = setInterval(() => {
      tick += 1;
      loadFast();
      if (tick % 5 === 0) loadSlow();
    }, 6000);
    return () => clearInterval(i);
  }, []);

  const featuredDepartments = useMemo(() => {
    const ids = activeSectorInfo?.suggestedDepartments ?? [];
    if (ids.length === 0) return [];
    return ids.map(id => allDepartments.find(d => d.id === id)).filter(Boolean);
  }, [allDepartments, activeSectorInfo]);

  async function hire(personaId: string) {
    setActivating(personaId);
    try { await api.activatePersona(personaId); await loadSlow(); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setActivating(null); }
  }

  // When a persona is active, prioritise its starter templates (id prefix
  // `custom-<personaId>-`) at the top of Quick Start so the dashboard reflects
  // the role's day-to-day work the moment a JD is uploaded.
  const quickStart = useMemo(() => {
    const all = templates ?? [];
    if (persona?.id) {
      const personaPrefix = `custom-${persona.id}-`;
      const personaT = all.filter(t => t.id.startsWith(personaPrefix));
      const others = all.filter(t => !t.id.startsWith(personaPrefix));
      return [...personaT, ...others].slice(0, 4);
    }
    return all.slice(0, 4);
  }, [templates, persona?.id]);

  async function submitNL(e: React.FormEvent) {
    e.preventDefault();
    if (!nl.trim() || !templates) return;
    setIntentBusy(true); setErr("");
    try {
      const intent = await api.intent(nl);
      const t = templates.find(x => x.id === intent.templateId);
      if (!t) { setErr("Couldn't match this to any template — pick one above or open Templates."); return; }
      setPrefill(intent.inputs ?? {});
      setActive(t);
      setNl("");
    } catch (e: any) { setErr(e.message); }
    finally { setIntentBusy(false); }
  }

  return (
    <div className="space-y-9">
      <section className="text-center pt-10 pb-6">
        {/* Typewriter eyebrow — types/deletes through the org identity lines. */}
        <div className="text-xs uppercase tracking-[0.3em] text-cream-300/50">
          <Typewriter texts={[
            ...(onboarding?.orgName ? [onboarding.orgName] : []),
            t("dashboard.welcome"),
            "The Intelligent Organization",
          ]} />
        </div>
        <h1 className="mt-2 flex justify-center">
          <DynamicWeightText text={t("app.title")} fontSize={60} />
        </h1>
        <p className="text-cream-300/70 mt-2 text-sm">
          {sectorLabel && <span className="inline-flex items-center gap-1.5 text-violet-400 mr-1.5"><Building2 size={14} />{sectorLabel}</span>}
          {t("app.subtitle")}
        </p>
      </section>

      {sectorContext && (
        <section className="bg-gradient-to-r from-leaf-500/5 via-leaf-500/10 to-transparent border border-leaf-500/20 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-leaf-500/10 text-leaf-400 shrink-0 mt-0.5"><MapPin size={18} /></div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-cream-100">
                <Globe size={14} className="text-leaf-400" />
                {t("dashboard.zimbabweContext")}
              </div>
              <p className="text-xs text-cream-300/80 mt-1.5 leading-relaxed">{sectorContext}</p>
            </div>
          </div>
        </section>
      )}

      <section>
          <div className="flex items-baseline justify-between mb-3 px-1">
            <div className="text-xs uppercase tracking-[0.25em] text-cream-300/60">
              <TextMorph words={["Mission Control", "Org at a Glance", "Live Status"]} />
            </div>
            <Link to="/quality" className="text-xs text-cream-300 hover:text-cream-50 inline-flex items-center gap-1"><Flag size={11} /> Flag an output →</Link>
          </div>
          {/* Skeleton cards until the slow lane (or the session snapshot)
              delivers orgStatus — the section paints immediately either way. */}
          {!orgStatus && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {Array(4).fill(null).map((_, i) => <div key={i} className="bg-ink-900 border border-ink-800 rounded-xl h-28 skeleton" />)}
            </div>
          )}
          {/* Four operating-metric cards, in this order: org breakdown,
              workload split, spend, productivity. The old status tiles
              (policies / connected systems / compute mode) moved to the
              secondary row under "Where time goes". */}
          {orgStatus && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Link to="/workforce" className="bg-ink-900 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors">
              <div className="flex items-center gap-2 text-xs text-cream-300/60 mb-1.5"><Users size={13} /> The organization</div>
              <div className="font-display text-2xl text-cream-50">{liveNeuros} <span className="text-sm text-cream-300/50">neuros</span> · {org?.total ?? 0} <span className="text-sm text-cream-300/50">humans</span></div>
              <div className="text-[11px] text-cream-300/50 mt-1 truncate">{(org?.byWorkMode?.human ?? 0) + (org?.byWorkMode?.hybrid ?? 0)} hands-on · {personas.length} roles defined</div>
            </Link>
            <Link to="/cost" className="bg-ink-900 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors">
              <div className="flex items-center gap-2 text-xs text-cream-300/60 mb-1.5"><Zap size={13} /> Workload summary</div>
              <div className="font-display text-2xl text-cream-50">
                {timeA?.totals ? <>{fmtHrs(timeA.totals.agentMs)} <span className="text-sm text-cream-300/50">neuro</span> · {Number(timeA.humanWorkHours ?? 0).toFixed(0)}h <span className="text-sm text-cream-300/50">human</span></> : "—"}
              </div>
              <div className="text-[11px] text-cream-300/50 mt-1 truncate">{timeA?.totals ? `${timeA.totals.pct.agent}% neuro · ${timeA.totals.pct.humanWork}% human` : "no tracked time yet"}</div>
            </Link>
            <Link to="/cost" className="bg-ink-900 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors">
              <div className="flex items-center gap-2 text-xs text-cream-300/60 mb-1.5"><Server size={13} /> Cost summary</div>
              {/* Neuro spend and human spend side by side in ONE currency ($),
                  per operator request. Neuro = LLM USD; human = logged hours ×
                  salary rate, converted ZAR→USD server-side. */}
              <div className="font-display text-2xl text-cream-50">
                ${Number(costSum?.totalCostUsd ?? 0).toFixed(2)} <span className="text-sm text-cream-300/50">neuro</span>
                <span className="text-cream-300/30 mx-1.5">·</span>
                <span className="text-amber-400">${Number(workCost?.human?.costUsd ?? 0).toFixed(2)}</span> <span className="text-sm text-cream-300/50">human</span>
              </div>
              <div className="text-[11px] text-amber-400/80 mt-1 truncate">Human cost ≈ R{Number(workCost?.human?.costZar ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} · {Number(workCost?.human?.totalHours ?? 0).toFixed(0)}h logged</div>
              <div className="text-[11px] text-cream-300/50 mt-0.5 truncate">{costSum ? `${costSum.callCount} LLM calls tracked` : "no spend tracked yet"}</div>
            </Link>
            <Link to="/quality" className="bg-ink-900 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors">
              <div className="flex items-center gap-2 text-xs text-cream-300/60 mb-1.5"><ShieldCheck size={13} /> Productivity levels</div>
              <div className="font-display text-2xl text-cream-50">{jobStats && jobStats.done > 0 ? `${Math.round((jobStats.ok / jobStats.done) * 100)}%` : "—"}</div>
              <div className="text-[11px] text-cream-300/50 mt-1 truncate">{jobStats && jobStats.done > 0 ? `${jobStats.ok} of ${jobStats.done} tasks succeeded` : "no finished tasks yet"}</div>
            </Link>
          </div>
          )}
        </section>

      <section>
        <div className="flex items-baseline justify-between mb-3 px-1">
          <div className="text-xs uppercase tracking-[0.25em] text-cream-300/60">
            Hire an employee — {persona ? <>currently working as <span className="text-violet-400">{persona.name}</span></> : <>no employee active</>}
          </div>
          <Link to="/personas" className="text-xs text-cream-300 hover:text-cream-50">Manage employees →</Link>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {personas.length === 0 && templates === null ? (
            // Slow lane still in flight — skeleton cards, not a false empty state.
            Array(3).fill(null).map((_, i) => <div key={i} className="bg-ink-900 border border-ink-800 rounded-xl h-28 skeleton" />)
          ) : personas.length === 0 ? (
            <div className="text-sm text-cream-300/60 col-span-3">No employees on the roster yet. Visit Employees to add one.</div>
          ) : personas.slice(0, 6).map((p: any) => {
            const isActive = persona?.id === p.id;
            const isHiring = activating === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => hire(p.id)}
                disabled={isHiring || isActive}
                className={`text-left rounded-xl p-4 transition-colors border ${
                  isActive
                    ? "bg-violet-500/10 border-violet-500/50"
                    : "bg-ink-900 hover:bg-ink-850 border-ink-800 hover:border-violet-500/40"
                } disabled:cursor-not-allowed`}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="font-display text-lg text-cream-50 leading-tight">{p.name}</div>
                  {isActive
                    ? <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 shrink-0">On the clock</span>
                    : isHiring
                      ? <span className="text-[10px] text-violet-400">hiring…</span>
                      : <span className="text-[10px] text-cream-300/40 group-hover:text-violet-300">Hire</span>}
                </div>
                <div className="text-xs text-cream-300/60 uppercase tracking-wider">{p.role}</div>
                <div className="text-xs text-cream-300/70 mt-2 line-clamp-2">{p.description}</div>
              </button>
            );
          })}
        </div>
        {personas.length > 6 && (
          <div className="text-[11px] text-cream-300/50 mt-2 px-1">+{personas.length - 6} more on the roster · <Link to="/personas" className="text-violet-400 hover:text-violet-500">see all</Link></div>
        )}
      </section>

      <WhereTimeGoes timeA={timeA} />

      {/* Secondary status tiles — the operational plumbing that used to sit
          in Mission Control (policies / connected systems / compute mode)
          plus the knowledge-pack count. */}
      {orgStatus && (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Link to="/governance" className="bg-ink-900 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors">
            <div className="flex items-center gap-2 text-xs text-cream-300/60 mb-1.5"><ShieldCheck size={13} /> Policy documents</div>
            <div className="font-display text-2xl text-cream-50">{orgStatus.activePolicyCount}</div>
            <div className="text-[11px] text-cream-300/50 mt-1 truncate">{orgStatus.activePolicies.slice(0, 2).join(", ") || "None active"}</div>
          </Link>
          <Link to="/connectors" className="bg-ink-900 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors">
            <div className="flex items-center gap-2 text-xs text-cream-300/60 mb-1.5"><Plug size={13} /> Connected systems</div>
            <div className="font-display text-2xl text-cream-50">{orgStatus.connectedSystemCount}</div>
            <div className="text-[11px] text-cream-300/50 mt-1 truncate">{orgStatus.connectedSystems.slice(0, 2).join(", ") || "None connected"}</div>
          </Link>
          <Link to="/admin" className="bg-ink-900 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors">
            <div className="flex items-center gap-2 text-xs text-cream-300/60 mb-1.5"><Server size={13} /> Compute mode</div>
            <div className="font-display text-lg text-cream-50 capitalize">{orgStatus.computeMode.replace("-", " ")}</div>
            <div className="text-[11px] text-cream-300/50 mt-1">{orgStatus.computeMode === "local-only" ? "All inference on this machine" : "Some inference may use a cloud LLM"}</div>
          </Link>
          <Link to="/knowledge-packs" className="bg-ink-900 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors">
            <div className="flex items-center gap-2 text-xs text-cream-300/60 mb-1.5"><BookOpen size={13} /> Knowledge packs</div>
            <div className="font-display text-2xl text-cream-50">{packStats?.total ?? 0}</div>
            <div className="text-[11px] text-cream-300/50 mt-1 truncate">{packStats ? `${packStats.installed} installed` : "—"}</div>
          </Link>
        </section>
      )}

      {activeSectorInfo && (featuredDepartments.length > 0 || knowledgePack || (activeSectorInfo.suggestedIntegrations?.length ?? 0) > 0) && (
        <section>
          <div className="flex items-baseline justify-between mb-3 px-1">
            <div className="text-xs uppercase tracking-[0.25em] text-cream-300/60">Featured for {sectorLabel}</div>
            <Link to="/departments" className="text-xs text-cream-300 hover:text-cream-50">Department marketplace →</Link>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {featuredDepartments.length > 0 && (
              <Link to="/departments" className="lg:col-span-2 bg-ink-900 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors">
                <div className="flex items-center gap-2 text-sm font-medium text-cream-100 mb-2">
                  <Zap size={14} className="text-violet-400" /> Recommended departments
                </div>
                <div className="flex flex-wrap gap-2">
                  {featuredDepartments.map((d: any) => (
                    <span key={d.id} className="text-xs bg-ink-800 border border-ink-700 rounded-full px-3 py-1 text-cream-200">{d.name}</span>
                  ))}
                </div>
              </Link>
            )}
            <div className="bg-ink-900 border border-ink-800 rounded-xl p-4 space-y-3">
              <Link to="/knowledge-packs" className="flex items-center gap-2 text-sm text-cream-100 hover:text-violet-300 transition-colors">
                <BookOpen size={14} className={knowledgePack?.installed ? "text-leaf-400" : "text-cream-300/50"} />
                Knowledge pack
                <span className={`ml-auto text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border ${knowledgePack?.installed ? "border-leaf-500/40 text-leaf-400" : "border-ink-700 text-cream-300/50"}`}>
                  {knowledgePack?.installed ? "active" : "not installed"}
                </span>
              </Link>
              {(activeSectorInfo.suggestedIntegrations?.length ?? 0) > 0 && (
                <Link to="/integrations" className="flex items-start gap-2 text-xs text-cream-300/70 hover:text-cream-100 transition-colors">
                  <Plug size={13} className="mt-0.5 shrink-0" />
                  <span>Suggested connections: {activeSectorInfo.suggestedIntegrations!.join(", ")}</span>
                </Link>
              )}
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="flex items-baseline justify-between mb-3 px-1">
          <div className="text-xs uppercase tracking-[0.25em] text-cream-300/60">
            {t("dashboard.quickStart")} — {persona ? <>{t("dashboard.quickStart.persona")} <span className="text-violet-400">{persona.name}</span></> : "suggested tasks"}
          </div>
          <Link to="/templates" className="text-xs text-cream-300 hover:text-cream-50">View all templates →</Link>
        </div>
        {quickStart.length ? (
          <MagneticRow gap={12}>
            {quickStart.map((t: Template, i) => (
              <button key={t.id} onClick={() => setActive(t)} className={`w-full text-left bg-ink-900 hover:bg-ink-850 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors nw-fade-up nw-delay-${Math.min(7, i + 1)}`}>
                <RoleIcon role={t.role} className="mb-3" />
                <div className="text-xs text-cream-300/60 uppercase tracking-wider">{t.role}</div>
                <div className="font-display text-lg text-cream-50 mt-0.5 leading-tight">{t.title}</div>
                <div className="text-xs text-cream-300/70 mt-2 line-clamp-2">{t.description}</div>
              </button>
            ))}
          </MagneticRow>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {Array(4).fill(null).map((_, i) => (
              <div key={i} className="bg-ink-900 border border-ink-800 rounded-xl p-4 h-32 skeleton" />
            ))}
          </div>
        )}
      </section>

      <section>
        <form onSubmit={submitNL} className="bg-ink-900 border border-ink-800 rounded-xl p-1.5 flex items-center gap-2 focus-within:border-violet-500/60 transition-colors">
          <span className="px-3 text-violet-400 text-lg">+</span>
          <input
            value={nl}
            onChange={e => setNl(e.target.value)}
            placeholder="Describe your task — e.g., Summarize the scraper-hub project"
            className="flex-1 bg-transparent py-3 outline-none text-cream-100 placeholder:text-cream-300/40"
          />
          <button type="submit" disabled={intentBusy} className="bg-violet-500 hover:bg-violet-600 disabled:opacity-50 text-white text-sm font-medium px-5 py-2.5 rounded-md mr-1.5">{intentBusy ? "Routing…" : "Delegate →"}</button>
        </form>
        <div className="mt-2 text-xs text-cream-300/50 text-center">Your task gets routed to the closest template via Ollama; you can edit the parameters before final delegation.</div>
      </section>

      <section>
        <AgentVisualizer />
      </section>

      <section className="grid grid-cols-3 gap-4">
        <Card title="Recent activity" className="col-span-2">
          {recent === null && (
            <div className="space-y-2">
              {Array(4).fill(null).map((_, i) => <div key={i} className="h-10 rounded-lg skeleton" />)}
            </div>
          )}
          {recent !== null && recent.length === 0 && <div className="text-sm text-cream-300/60">No tasks yet. Pick one above to delegate something.</div>}
          {recent !== null && recent.length > 0 && (
            <ul className="divide-y divide-ink-800 max-h-96 overflow-y-auto scrollbar-thin">
              {recent.map(j => (
                <li key={j.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${j.status === "succeeded" ? "bg-leaf-500" : j.status === "failed" ? "bg-coral-500" : j.status === "running" ? "bg-flame-400 animate-pulse" : "bg-cream-300/30"}`} />
                    <div className="min-w-0">
                      <div className="text-sm text-cream-100 truncate">{j.title ?? j.kind}</div>
                      <div className="text-[11px] text-cream-300/50 font-mono">{new Date(j.startedAt).toLocaleString()}</div>
                    </div>
                  </div>
                  <Link to={`/tasks?focus=${j.id}`} className="text-xs text-violet-400 hover:text-violet-500 shrink-0">view</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={<TextLift text="Workforce" depth={5} expand={2.5} />}>
          <ClawbotFleet fleet={fleet} externalAgents={externalAgents} running={running} templatesCount={templates?.length} tasksToday={(recent ?? []).length} personasCount={personas.length} org={org} users={users} />
        </Card>
      </section>

      {err && <div className="text-coral-400 text-sm">Error: {err}</div>}
      {active && <TaskRunner template={active} prefill={prefill} onClose={() => { setActive(null); setPrefill(undefined); loadFast(); }} />}
    </div>
  );
}

// Compact hour figure for the Workload summary card: sub-hour totals get one
// decimal ("0.4h") so a young install doesn't show a misleading "0h".
function fmtHrs(ms: number): string {
  const h = (ms ?? 0) / 3_600_000;
  return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
}

function fmtMs(ms: number): string {
  if (!ms || ms < 1000) return "0s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// "Where time goes" — the waste detector, lifted from the Cost page so the
// operator sees the agent-vs-waiting-vs-human-work split on the dashboard
// without a detour. Same TimeAnalysis payload (/api/tasks/time-analysis).
function WhereTimeGoes({ timeA }: { timeA: any | null }) {
  if (!timeA || !timeA.totals || timeA.totals.totalMs <= 0) return null;
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3 px-1">
        <div className="text-xs uppercase tracking-[0.25em] text-cream-300/60">Where time goes — last {timeA.days} days</div>
        <Link to="/cost" className="text-xs text-cream-300 hover:text-cream-50">Full cost breakdown →</Link>
      </div>
      <div className="bg-ink-900 border border-ink-800 rounded-xl p-4">
        <p className="text-xs text-cream-300/60 mb-3">{timeA.verdict}</p>
        <div className="h-3 rounded-full overflow-hidden flex mb-2 bg-ink-950">
          <div className="bg-violet-500" style={{ width: `${timeA.totals.pct.agent}%` }} title={`Neuro runtime ${timeA.totals.pct.agent}%`} />
          <div className="bg-amber-500" style={{ width: `${timeA.totals.pct.humanWait}%` }} title={`Waiting on humans ${timeA.totals.pct.humanWait}%`} />
          <div className="bg-leaf-500" style={{ width: `${timeA.totals.pct.humanWork}%` }} title={`Human work ${timeA.totals.pct.humanWork}%`} />
        </div>
        <div className="flex gap-4 text-xs text-cream-300/60 mb-4 flex-wrap">
          <span><span className="inline-block w-2 h-2 rounded-full bg-violet-500 mr-1" />Neuro runtime {timeA.totals.pct.agent}% ({fmtMs(timeA.totals.agentMs)})</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-amber-500 mr-1" />Waiting on humans {timeA.totals.pct.humanWait}% ({fmtMs((timeA.totals.humanWaitMs ?? 0) + (timeA.totals.openWaitMs ?? 0))})</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-leaf-500 mr-1" />Human work {timeA.totals.pct.humanWork}% ({timeA.humanWorkHours}h)</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(timeA.slowestAgentTypes ?? []).length > 0 && (
            <div>
              <div className="text-xs font-semibold text-cream-200 mb-1.5">Slowest neuro task types</div>
              {timeA.slowestAgentTypes.slice(0, 5).map((t: any) => (
                <div key={t.type} className="flex justify-between text-xs text-cream-300/60 py-0.5">
                  <span className="font-mono truncate">{t.type}</span><span className="shrink-0 ml-2">{fmtMs(t.ms)}</span>
                </div>
              ))}
            </div>
          )}
          {(timeA.longestWaits ?? []).length > 0 && (
            <div>
              <div className="text-xs font-semibold text-cream-200 mb-1.5">Longest waits on a human</div>
              {timeA.longestWaits.slice(0, 5).map((w: any, i: number) => (
                <div key={i} className="flex justify-between text-xs text-cream-300/60 py-0.5">
                  <span className="truncate">{w.open ? "⏳ " : ""}{w.title}</span><span className="shrink-0 ml-2">{fmtMs(w.waitMs)}{w.open ? " · still waiting" : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// Live snapshot of the running clawbot fleet. Each row is one clawbot — self
// or peer — with current inflight count, role, and ready state. Replaces the
// previous hardcoded "1 (clawbot)" line which was a lie the moment a worker
// peer came online.
function ClawbotFleet({ fleet, externalAgents, running, templatesCount, tasksToday, personasCount, org, users }: {
  fleet: { self: any; peers: any[] } | null;
  externalAgents: any[];
  running: any[];
  templatesCount?: number;
  tasksToday: number;
  personasCount: number;
  org: { total: number; byLayer: Record<string, number>; byWorkMode: Record<string, number> } | null;
  users: any[];
}) {
  if (!fleet) return <div className="text-sm text-cream-300/60">Loading fleet…</div>;

  // Derive live sub-agents from running jobs: each in-flight plan step is a
  // spawned sub-agent; a wave with >1 step is several working in parallel.
  const subAgents: { job: string; label: string; parallel: boolean }[] = [];
  for (const job of running ?? []) {
    const r = job.result ?? {};
    const steps: any[] = r.plan?.steps ?? [];
    const runs: any[] = r.runs ?? [];
    const waves: number[][] = (r.plan?.waves && r.plan.waves.length > 0) ? r.plan.waves : steps.map((_: any, i: number) => [i]);
    for (const ids of waves) {
      const parallel = ids.length > 1;
      for (const i of ids) {
        const run = runs[i];
        const inflight = run?.startedAt && !run?.ok && !run?.error;
        if (inflight) subAgents.push({ job: job.title ?? job.kind ?? "task", label: steps[i]?.label ?? steps[i]?.tool ?? "step", parallel });
      }
    }
  }
  const bots: { name: string; role: string; url?: string; ok: boolean; ready: boolean; inflight: number; model?: string; isSelf: boolean }[] = [];
  if (fleet.self) {
    bots.push({
      name: fleet.self.name ?? "primary",
      role: fleet.self.role ?? "primary",
      url: fleet.self.url,
      ok: true,
      ready: !!fleet.self.ready,
      inflight: Number(fleet.self.inflightJobs ?? 0),
      model: fleet.self.model,
      isSelf: true,
    });
  }
  for (const p of fleet.peers ?? []) {
    bots.push({
      name: p.name ?? p.url ?? "peer",
      role: p.role ?? "peer",
      url: p.url,
      ok: !!p.ok,
      ready: !!p.ready,
      inflight: Number(p.inflightJobs ?? 0),
      model: p.model,
      isSelf: false,
    });
  }
  const activeCount = bots.filter(b => b.ok && b.ready).length;
  // The fleet has no real geo data (every neuro runs on the operator's own
  // machines) — markers are REPRESENTATIVE: one distinct Zimbabwe city per
  // neuro, primary pinned to Harare, so each worker reads as a live dot on
  // the map rather than all stacking invisibly on one point.
  const ZIM_CITIES: { lat: number; lng: number }[] = [
    { lat: -17.83, lng: 31.05 }, // Harare — primary
    { lat: -20.16, lng: 28.58 }, // Bulawayo
    { lat: -18.97, lng: 32.67 }, // Mutare
    { lat: -19.45, lng: 29.82 }, // Gweru
    { lat: -20.07, lng: 30.83 }, // Masvingo
    { lat: -18.93, lng: 29.81 }, // Kwekwe
    { lat: -18.33, lng: 29.91 }, // Kadoma
    { lat: -17.37, lng: 30.19 }, // Chinhoyi
  ];
  const markers = bots.filter(b => b.ok).map((b, i) => ({ ...ZIM_CITIES[i % ZIM_CITIES.length], label: b.name }));
  return (
    <div className="space-y-3 text-sm">
      <Suspense fallback={<div className="h-[220px] grid place-items-center text-xs text-cream-300/40">loading globe…</div>}>
        <WorkforceGlobe markers={markers} height={220} />
      </Suspense>
      <div className="space-y-1.5">
        {bots.length === 0 && <div className="text-cream-300/60">No neuros reachable.</div>}
        {bots.map((b, i) => (
          <div key={i} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-ink-950 border border-ink-800">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${b.ok && b.ready ? (b.inflight > 0 ? "bg-flame-400 animate-pulse" : "bg-leaf-500") : "bg-coral-500"}`} />
              <div className="min-w-0">
                <div className="text-xs text-cream-100 truncate">
                  {b.name}
                  {b.isSelf && <span className="text-[10px] text-cream-300/40 ml-1">· self</span>}
                </div>
                <div className="text-[10px] text-cream-300/50 truncate">{b.role}{b.model ? ` · ${b.model}` : ""}</div>
              </div>
            </div>
            <span className={`text-[10px] font-mono shrink-0 ${b.inflight > 0 ? "text-flame-400" : "text-cream-300/60"}`}>{b.inflight > 0 ? `${b.inflight} working` : "idle"}</span>
          </div>
        ))}
        {externalAgents.length > 0 && externalAgents.map((a, i) => {
          const r = a.recentJobs ?? { last1h: 0, last24h: 0, total: 0 };
          const live = r.last1h > 0;
          return (
            <div key={`ext-${i}`} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-ink-950 border border-ink-800">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.installed ? (live ? "bg-flame-400 animate-pulse" : "bg-leaf-500") : "bg-coral-500"}`} />
                <div className="min-w-0">
                  <div className="text-xs text-cream-100 truncate">
                    {a.name}
                    <span className="text-[10px] text-cream-300/40 ml-1">· {a.kind}</span>
                  </div>
                  <div className="text-[10px] text-cream-300/50 truncate">
                    {a.installed ? `external · ${r.total} run${r.total === 1 ? "" : "s"} tracked` : "not installed"}
                  </div>
                </div>
              </div>
              <span className={`text-[10px] font-mono shrink-0 ${live ? "text-flame-400" : "text-cream-300/60"}`}>{live ? `${r.last1h} in 1h` : "idle"}</span>
            </div>
          );
        })}
      </div>

      {/* The PEOPLE in the org, in the same roster as the machines — so the
          card shows the whole workforce (humans + neuros), not just agents.
          Real accounts from /api/users; work mode (agent-assisted / hybrid /
          hands-on) shown as the subtitle. */}
      {users.length > 0 && (
        <div className="border-t border-ink-800 pt-2.5 mt-2.5 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-cream-300/50 mb-1">Humans · {users.length}</div>
          {users.slice(0, 8).map((u, i) => (
            <div key={`u-${i}`} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-ink-950 border border-ink-800">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-5 h-5 rounded-full bg-gradient-to-br from-leaf-500/40 to-violet-500/40 grid place-items-center text-[9px] font-semibold text-cream-50 shrink-0">
                  {String(u.name ?? u.email ?? "?").split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="text-xs text-cream-100 truncate">{u.name ?? u.email}</div>
                  <div className="text-[10px] text-cream-300/50 truncate">{u.department ? `${u.department} · ` : ""}{u.role ?? "member"}</div>
                </div>
              </div>
              <span className="text-[10px] font-mono shrink-0 text-cream-300/50 flex items-center gap-1"><UserIcon size={9} />{u.workMode === "human" ? "hands-on" : u.workMode === "hybrid" ? "hybrid" : "person"}</span>
            </div>
          ))}
          {users.length > 8 && <Link to="/workforce" className="block text-center text-[11px] text-violet-400 hover:text-violet-300 pt-1">+{users.length - 8} more · manage people →</Link>}
        </div>
      )}

      {/* Live sub-agents spawned by running tasks. */}
      {subAgents.length > 0 && (
        <div className="border-t border-ink-800 pt-2.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-violet-300/70 mb-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" /> Sub-neuros · {subAgents.length} live
          </div>
          <div className="space-y-1">
            {subAgents.slice(0, 6).map((s, i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-1 rounded-md bg-violet-500/5 border border-violet-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse shrink-0" />
                <span className="text-xs text-cream-200 truncate flex-1">
                  {s.label}
                  {s.parallel && <span className="text-[10px] text-violet-400/70 ml-1">· parallel</span>}
                </span>
                <span className="text-[10px] text-cream-300/40 truncate max-w-[45%]" title={s.job}>{s.job}</span>
              </div>
            ))}
            {subAgents.length > 6 && <div className="text-[10px] text-cream-300/40 px-2">+{subAgents.length - 6} more</div>}
          </div>
        </div>
      )}

      <div className="border-t border-ink-800 pt-2.5 space-y-2 text-xs mt-2.5">
        <div className="flex justify-between"><span className="text-cream-300/70">Neuros online</span><span className="text-cream-100 font-mono">{activeCount}/{bots.length}</span></div>
        {subAgents.length > 0 && <div className="flex justify-between"><span className="text-cream-300/70">Sub-neuros active</span><span className="text-violet-300 font-mono">{subAgents.length}</span></div>}
        {externalAgents.length > 0 && <div className="flex justify-between"><span className="text-cream-300/70">External neuros</span><span className="text-cream-100 font-mono">{externalAgents.filter(a => a.installed).length}/{externalAgents.length}</span></div>}
        <div className="flex justify-between"><span className="text-cream-300/70">Employees</span><span className="text-cream-100 font-mono">{personasCount}</span></div>
        <div className="flex justify-between"><span className="text-cream-300/70">Templates</span><span className="text-cream-100 font-mono">{templatesCount ?? "—"}</span></div>
        <div className="flex justify-between"><span className="text-cream-300/70">Tasks today</span><span className="text-cream-100 font-mono">{tasksToday}</span></div>
      </div>
    </div>
  );
}
