import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  LayoutDashboard, Bot, PlayCircle, CheckCircle2, Loader2, DollarSign,
  ShieldAlert, ShieldCheck, Brain, Clock, TrendingUp, Hourglass, Cpu, Database, Crown,
} from "lucide-react";
import { api, type TimeAnalysis, type QualitySummary, type SecurityStatus, type SchedulerEngine, type RagStatus, type OrgTask } from "../lib/api";

// The mission-control view Naxie.tsx's own comment deferred: "not a rebuild
// of Dashboard's 12-call mission control." This is that view, now that it
// has a home of its own — one glance at everything the COO is running,
// with a link out to the specialized page for anything that needs detail.
export function CommandCenter() {
  const [health, setHealth] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [personaCount, setPersonaCount] = useState<number | null>(null);
  const [naxie, setNaxie] = useState<any>(null);
  const [timeA, setTimeA] = useState<TimeAnalysis | null>(null);
  const [eta, setEta] = useState<{ globalMedianMs: number; count: number } | null>(null);
  const [quality, setQuality] = useState<QualitySummary | null>(null);
  const [costSummary, setCostSummary] = useState<any>(null);
  const [cache, setCache] = useState<any>(null);
  const [audit, setAudit] = useState<{ events: any[]; total: number } | null>(null);
  const [security, setSecurity] = useState<SecurityStatus | null>(null);
  const [engines, setEngines] = useState<SchedulerEngine[]>([]);
  const [ragStatus, setRagStatus] = useState<RagStatus | null>(null);
  const [crownTasks, setCrownTasks] = useState<OrgTask[]>([]);
  const [loading, setLoading] = useState(true);

  // Fast-moving: polled every 5s, same cadence as Naxie.tsx's ambient strip.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const [h, { jobs: j }, n, { tasks: crown }] = await Promise.all([
          api.health(), api.listJobs(), api.naxieStatus(), api.orgTasks({ priority: "crown" }),
        ]);
        if (!alive) return;
        setHealth(h);
        setJobs(j);
        setNaxie(n);
        setCrownTasks(crown);
      } catch { /* ambient — tolerate a missed poll */ }
    }
    void tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  // Slow-moving: fetched once on mount, same split Naxie.tsx already uses.
  useEffect(() => {
    api.listPersonas().then(r => setPersonaCount((r.personas ?? []).length)).catch(() => {});
    api.timeAnalysis(30).then(setTimeA).catch(() => {});
    api.taskEtaStats().then(r => setEta({ globalMedianMs: r.globalMedianMs, count: r.count })).catch(() => {});
    api.getQualitySummary().then(setQuality).catch(() => {});
    api.getCostSummary().then(setCostSummary).catch(() => {});
    api.cacheStats().then(setCache).catch(() => {});
    api.queryAudit({ limit: 5 }).then(setAudit).catch(() => {});
    api.schedulerStatus().then(r => setEngines(r.engines)).catch(() => {});
    api.ragStatus().then(setRagStatus).catch(() => {});
    api.securityEvents().then(setSecurity).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const runningCount = jobs.filter(j => j.status === "running" || j.status === "pending").length;
  const finished = jobs.filter(j => j.status === "succeeded" || j.status === "failed" || j.status === "rejected");
  const succeededCount = jobs.filter(j => j.status === "succeeded").length;
  const successRate = finished.length > 0 ? Math.round((succeededCount / finished.length) * 100) : null;
  const recentJobs = [...jobs].sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? ""))).slice(0, 6);
  // Crown Jobs — the tier above urgent (see org-tasks.ts's ORG_TASK_PRIORITIES).
  // The OrgTask store already keeps full history, so "active" vs. a
  // done/blocked history slice is just a client-side split of one poll —
  // no new persistence needed.
  const activeCrown = crownTasks.filter(t => t.status === "active");
  const crownHistory = crownTasks
    .filter(t => t.status === "done" || t.status === "blocked")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin w-6 h-6" /></div>;

  const connectivityValue = health?.ready ? "Ready" : "Degraded";
  const connectivityTone: "ok" | "warn" = health?.ready ? "ok" : "warn";
  const vectorValue = ragStatus
    ? (ragStatus.pgvectorEnabled && ragStatus.openaiEmbeddingEnabled ? (ragStatus.connected ? "Active" : "Unreachable") : "Not configured")
    : "—";
  const vectorTone = ragStatus
    ? (ragStatus.pgvectorEnabled && ragStatus.openaiEmbeddingEnabled ? (ragStatus.connected ? "ok" : "warn") : undefined)
    : undefined;
  const blockedCount = security?.blocked?.length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-cream-50 flex items-center gap-2">
          <LayoutDashboard className="w-6 h-6" /> Command Center
        </h1>
        <p className="text-sm text-cream-300/70 mt-1">
          What Naxie's running, how well she's running it, and what it's costing — one board, for the boss.
        </p>
      </div>

      {/* Bento grid: cell size tracks how much a reader needs from it at a
          glance — the two live feeds (ops, spend/governance) get the wide
          cells, single numbers stay small so the eye can scan the whole
          board in one pass instead of reading section by section. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <Cell className="lg:col-span-3 lg:row-span-2">
          <div className="flex items-center gap-2 text-sm text-cream-300/60"><PlayCircle className="w-4 h-4" /> Running now</div>
          <div className="text-4xl font-bold mt-1 text-cream-50">{runningCount}</div>
          {naxie?.briefing?.text && (
            <div className="mt-4 text-xs text-cream-300/70 bg-ink-950 rounded-lg p-3 border border-ink-800">
              <span className="font-semibold text-cream-200">Latest briefing: </span>{String(naxie.briefing.text).slice(0, 240)}
            </div>
          )}
          {recentJobs.length > 0 && (
            <div className="mt-4 space-y-1">
              {recentJobs.map((j, i) => (
                <div key={j.id ?? i} className="flex items-center justify-between text-xs text-cream-300/60 py-0.5">
                  <span className="truncate">{j.title ?? j.id}</span>
                  <span className={`shrink-0 ml-2 ${j.status === "succeeded" ? "text-leaf-400" : j.status === "failed" || j.status === "rejected" ? "text-coral-400" : "text-flame-400"}`}>{j.status}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-4 text-xs">
            <Link to="/runs" className="text-violet-400 hover:text-violet-300">All runs →</Link>
            <Link to="/approvals" className="text-violet-400 hover:text-violet-300">Approvals →</Link>
          </div>
        </Cell>

        <Stat delay={1} icon={<Bot className="w-4 h-4" />} label="Agents on roster" value={personaCount ?? "—"} />
        <Stat delay={2} icon={<CheckCircle2 className="w-4 h-4" />} label="Waiting on your approval" value={naxie?.pendingApprovals ?? 0} />
        <Stat delay={3} icon={<ShieldCheck className="w-4 h-4" />} label="Connectivity" value={connectivityValue} tone={connectivityTone} />
        <Stat delay={4} icon={<Cpu className="w-4 h-4" />} label="Orchestration" value={`${engines.length} engine${engines.length === 1 ? "" : "s"}`} />
        <Stat delay={5} icon={<Database className="w-4 h-4" />} label="Vector store" value={vectorValue} tone={vectorTone} />
        <Stat delay={6} icon={<CheckCircle2 className="w-4 h-4" />} label="Success rate" value={successRate != null ? `${successRate}%` : "—"} />

        {/* Performance strip — same size class as each other on purpose:
            these are peer metrics, none more important than the rest. */}
        <Stat delay={7} className="lg:col-span-2" icon={<Clock className="w-4 h-4" />} label="Median task time" value={eta ? fmtMs(eta.globalMedianMs) : "—"} />
        <Stat delay={7} className="lg:col-span-2" icon={<TrendingUp className="w-4 h-4" />} label="Quality signal (30d)" value={quality ? `${quality.upvotes}↑ / ${quality.downvotes}↓` : "—"} />
        <Stat delay={7} className="lg:col-span-2" icon={<Hourglass className="w-4 h-4" />} label="Agent time share" value={timeA ? `${timeA.totals.pct.agent}%` : "—"} />

        {timeA?.verdict && (
          <p className="lg:col-span-6 -mt-2 text-xs text-cream-300/60">{timeA.verdict}</p>
        )}

        <Cell className="lg:col-span-3" delay={7}>
          <div className="flex items-center gap-2 text-sm text-cream-300/60"><DollarSign className="w-4 h-4" /> Spend</div>
          <div className="text-3xl font-bold mt-1 text-cream-50">${(costSummary?.totalCostUsd ?? 0).toFixed(4)}</div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <MiniStat icon={<TrendingUp className="w-3.5 h-3.5" />} label="LLM calls" value={costSummary?.callCount ?? 0} />
            <MiniStat icon={<Brain className="w-3.5 h-3.5" />} label="Prompt-cache hit rate" value={cache?.overall?.cacheHitRatio != null ? `${Math.round(cache.overall.cacheHitRatio * 100)}%` : "—"} />
          </div>
          <div className="mt-3">
            <Link to="/cost" className="text-violet-400 hover:text-violet-300 text-xs">Full cost breakdown →</Link>
          </div>
        </Cell>

        {/* Crown Jobs — the priority tier above urgent (docs: org-tasks.ts's
            ORG_TASK_PRIORITIES). Only rendered once there's something to show,
            same "no clutter when idle" posture as the rest of this page. */}
        {(activeCrown.length > 0 || crownHistory.length > 0) && (
          <Cell className="lg:col-span-6" delay={7}>
            <div className="flex items-center gap-2 text-sm text-cream-300/60"><Crown className="w-4 h-4 text-fuchsia-300" /> Crown Jobs</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
              <div>
                <div className="text-xs font-semibold text-cream-200 mb-1.5 flex items-center gap-1.5">
                  <Crown className="w-3.5 h-3.5 text-fuchsia-300" /> Active ({activeCrown.length})
                </div>
                {activeCrown.length === 0 ? (
                  <div className="text-xs text-cream-300/40">No crown-priority work running right now.</div>
                ) : (
                  <div className="space-y-1">
                    {activeCrown.map(t => (
                      <CrownTaskRow key={t.id} task={t} />
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs font-semibold text-cream-200 mb-1.5 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-cream-300/60" /> Recent history
                </div>
                {crownHistory.length === 0 ? (
                  <div className="text-xs text-cream-300/40">Nothing finished or blocked yet.</div>
                ) : (
                  <div className="space-y-1">
                    {crownHistory.map(t => (
                      <CrownTaskRow key={t.id} task={t} />
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-3">
              <Link to="/org-dashboard" className="text-violet-400 hover:text-violet-300 text-xs">Full org backlog →</Link>
            </div>
          </Cell>
        )}

        <Cell className="lg:col-span-3" delay={7}>
          <div className="flex items-center gap-2 text-sm text-cream-300/60"><ShieldAlert className="w-4 h-4" /> Governance, security & memory</div>
          <div className="grid grid-cols-3 gap-3 mt-3">
            <MiniStat label="Blocked IPs" value={blockedCount} tone={blockedCount > 0 ? "warn" : "ok"} />
            <MiniStat label="Watched events" value={security?.watching ?? 0} />
            <MiniStat label="Memory freshness" value={naxie?.cag?.built ? fmtMs(naxie.cag.ageMs) + " old" : "not built"} />
          </div>
          {audit && audit.events.length > 0 && (
            <div className="mt-4 space-y-1">
              <div className="text-xs font-semibold text-cream-200 mb-1">Recent audit activity</div>
              {audit.events.map((e, i) => (
                <div key={i} className="flex items-center justify-between text-xs text-cream-300/60 py-0.5">
                  <span className="truncate">{e.action ?? e.detail ?? "event"}</span>
                  <span className="shrink-0 ml-2 text-cream-300/40">{new Date(e.ts ?? e.at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-4 text-xs">
            <Link to="/audit" className="text-violet-400 hover:text-violet-300">Audit log →</Link>
            <Link to="/policies" className="text-violet-400 hover:text-violet-300">Policies →</Link>
          </div>
        </Cell>
      </div>
    </div>
  );
}

// Glass look — translucent + blur + a soft violet glow (see Card.tsx's
// "glass" variant, which this mirrors). Command Center is the dashboard the
// blueprint's "ambient HUD" framing was written for, so it's the first place
// this ships — same treatment as Card's glass variant, kept local here since
// the bento cells below aren't built on <Card>.
export const GLASS = "bg-ink-900/60 backdrop-blur-md border border-violet-500/20 shadow-[0_0_24px_-8px_rgba(139,92,246,0.25)]";

// One bento cell — 12px radius (matches <Card>'s rounded-xl) so every
// surface in the app shares the same corner curve. nw-card-hover +
// nw-fade-up/nw-delay-N give the load-in and hover feedback the rest of
// the app already uses (see Card.tsx, index.css) instead of inventing a
// new motion language just for this page.
function Cell({ children, className = "", delay }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <div className={`${GLASS} nw-card-hover nw-fade-up ${delay ? `nw-delay-${delay}` : ""} rounded-xl p-4 ${className}`}>
      {children}
    </div>
  );
}

function Stat({ icon, label, value, tone, className = "", delay }: { icon: ReactNode; label: string; value: string | number; tone?: "ok" | "warn"; className?: string; delay?: number }) {
  return (
    <Cell className={className} delay={delay}>
      <div className="flex items-center gap-2 text-sm text-cream-300/60">{icon} {label}</div>
      <div className={`text-2xl font-bold mt-1 ${tone === "warn" ? "text-coral-400" : tone === "ok" ? "text-leaf-400" : "text-cream-50"}`}>{value}</div>
    </Cell>
  );
}

// Sub-stat used inside a wide Cell (Spend, Governance) — no card chrome of
// its own so grouped numbers read as one module, not cards-within-cards.
function MiniStat({ icon, label, value, tone }: { icon?: ReactNode; label: string; value: string | number; tone?: "ok" | "warn" }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] text-cream-300/60">{icon}{label}</div>
      <div className={`text-sm font-semibold mt-0.5 ${tone === "warn" ? "text-coral-400" : tone === "ok" ? "text-leaf-400" : "text-cream-100"}`}>{value}</div>
    </div>
  );
}

// One Crown Job row — title + status, linking to the run-detail page the
// same way Naxie.tsx / MyWork.tsx / Runs.tsx already link a job (`/runs/:id`)
// when this OrgTask has a jobId (it won't yet if it's still on the backlog,
// not dispatched to a Job). Falls back to a plain (non-link) row otherwise.
function CrownTaskRow({ task }: { task: OrgTask }) {
  const tone = task.status === "done" ? "text-leaf-400" : task.status === "blocked" ? "text-coral-400" : "text-flame-400";
  const inner = (
    <>
      <span className="truncate flex-1">{task.title}</span>
      <span className={`shrink-0 ml-2 ${tone}`}>{task.status}</span>
    </>
  );
  const rowCls = "flex items-center justify-between text-xs text-cream-300/70 py-1 px-2 rounded-md bg-ink-950/50 border border-ink-800";
  return task.jobId ? (
    <Link to={`/runs/${task.jobId}`} className={`${rowCls} hover:border-violet-500/40 hover:text-cream-100 transition-colors`}>{inner}</Link>
  ) : (
    <div className={rowCls}>{inner}</div>
  );
}

// "2h 15m" / "45m" / "30s" — same coarse formatting Cost.tsx uses.
function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}
