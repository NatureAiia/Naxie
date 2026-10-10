import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  LayoutDashboard, Bot, PlayCircle, CheckCircle2, Loader2, DollarSign,
  ShieldAlert, ShieldCheck, Brain, Clock, TrendingUp, Hourglass, Cpu, Database, Crown, Network, RefreshCw,
} from "lucide-react";
import { api, type TimeAnalysis, type QualitySummary, type SecurityStatus, type SchedulerEngine, type RagStatus, type OrgTask, type OrgRole, type OrgTaskStatus, type OrgTaskPriority } from "../lib/api";
import { Card } from "../components/Card";
import { AiModelsCost } from "./AiModelsCost";

// Merged Command Center: Overview (bento) + AI Models & Cost (moved over
// from the Extensions page) + Org Backlog (former /org-dashboard) as tabs.
// Single canonical route /command?tab=overview|models-cost|org —
// /org-dashboard and /extensions?tab=cost redirect here.
type CommandTab = "overview" | "models-cost" | "org";
export function CommandCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  // Back-compat: the old standalone-tab ids land on the merged tab.
  const activeTab: CommandTab =
    rawTab === "org" ? "org" : rawTab === "models-cost" || rawTab === "models" || rawTab === "cost" ? "models-cost" : "overview";

  function setTab(tab: CommandTab) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (tab === "overview") next.delete("tab");
      else next.set("tab", tab);
      return next;
    }, { replace: true });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-cream-50 flex items-center gap-2">
            <LayoutDashboard className="w-6 h-6" /> Command Center
          </h1>
          <p className="text-sm text-cream-300/70 mt-1">
            {activeTab === "org"
              ? "Naxie's internal 6-role backlog — diagnostics only. She never names a role in conversation; this is here purely for when you want to see what's actually happening."
              : activeTab === "models-cost"
                ? "What Naxie thinks with and what it costs — roster, spend, and trends."
                : "What Naxie's running, how well she's running it, and what it's costing — one board, for the boss."}
          </p>
        </div>
        <div className="flex items-center gap-1 p-1 rounded-full bg-ink-900 border border-ink-800 shrink-0">
          <button
            type="button"
            onClick={() => setTab("overview")}
            className={`text-xs px-3 py-1.5 rounded-full transition-colors ${activeTab === "overview" ? "bg-violet-500 text-white" : "text-cream-300/70 hover:text-cream-100"}`}
          >Overview</button>
          <button
            type="button"
            onClick={() => setTab("models-cost")}
            className={`text-xs px-3 py-1.5 rounded-full transition-colors flex items-center gap-1 ${activeTab === "models-cost" ? "bg-violet-500 text-white" : "text-cream-300/70 hover:text-cream-100"}`}
          ><DollarSign size={12} /> AI Models & Cost</button>
          <button
            type="button"
            onClick={() => setTab("org")}
            className={`text-xs px-3 py-1.5 rounded-full transition-colors flex items-center gap-1 ${activeTab === "org" ? "bg-violet-500 text-white" : "text-cream-300/70 hover:text-cream-100"}`}
          ><Network size={12} /> Org Backlog</button>
        </div>
      </div>

      {activeTab === "overview" ? <OverviewTab onGoOrg={() => setTab("org")} />
        : activeTab === "models-cost" ? <AiModelsCost />
        : <OrgBacklogTab />}
    </div>
  );
}

function OverviewTab({ onGoOrg }: { onGoOrg: () => void }) {
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
  const activeCrown = crownTasks.filter(t => t.status === "active");
  const crownHistory = crownTasks
    .filter(t => t.status === "done" || t.status === "blocked")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin w-6 h-6" /></div>;

  const connectivityValue = health?.ready ? "Ready" : "Degraded";
  const connectivityTone: "ok" | "warn" = health?.ready ? "ok" : "warn";
  const vectorValue = ragStatus
    ? ((ragStatus.pgvectorEnabled || ragStatus.mongodbVectorEnabled) && ragStatus.openaiEmbeddingEnabled ? (ragStatus.connected ? "Active" : "Unreachable") : "Not configured")
    : "—";
  const vectorTone = ragStatus
    ? ((ragStatus.pgvectorEnabled || ragStatus.mongodbVectorEnabled) && ragStatus.openaiEmbeddingEnabled ? (ragStatus.connected ? "ok" : "warn") : undefined)
    : undefined;
  const blockedCount = security?.blocked?.length ?? 0;

  return (
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
            <Link to="/my-work" className="text-violet-400 hover:text-violet-300">Inbox →</Link>
          </div>
        </Cell>

        <Stat delay={1} icon={<Bot className="w-4 h-4" />} label="Agents on roster" value={personaCount ?? "—"} />
        <Stat delay={2} icon={<CheckCircle2 className="w-4 h-4" />} label="Waiting on your approval" value={naxie?.pendingApprovals ?? 0} />
        <Stat delay={3} icon={<ShieldCheck className="w-4 h-4" />} label="Connectivity" value={connectivityValue} tone={connectivityTone} />
        <Stat delay={4} icon={<Cpu className="w-4 h-4" />} label="Orchestration" value={`${engines.length} engine${engines.length === 1 ? "" : "s"}`} />
        <Stat delay={5} icon={<Database className="w-4 h-4" />} label="Vector store" value={vectorValue} tone={vectorTone} />
        <Stat delay={6} icon={<CheckCircle2 className="w-4 h-4" />} label="Success rate" value={successRate != null ? `${successRate}%` : "—"} />

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
            <Link to="/command?tab=models-cost" className="text-violet-400 hover:text-violet-300 text-xs">Full cost breakdown →</Link>
          </div>
        </Cell>

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
              <button type="button" onClick={onGoOrg} className="text-violet-400 hover:text-violet-300 text-xs">Full org backlog →</button>
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
  );
}

// Org Backlog — lifted from former OrgDashboard.tsx, now a tab inside Command Center.
const ROLE_ORDER: OrgRole[] = ["scheduler", "admin", "researcher", "executor", "architect", "hermes-reviewer", "improver"];
const ROLE_LABEL: Record<OrgRole, string> = {
  scheduler: "Scheduler",
  admin: "Admin",
  researcher: "Researcher",
  executor: "Executor",
  architect: "Architect",
  "hermes-reviewer": "Hermes Reviewer",
  improver: "Improver",
};
const ROLE_BLURB: Record<OrgRole, string> = {
  scheduler: "Time-triggered — reminders, calendar, nudges",
  admin: "Recurring, bounded, same-shape-every-time",
  researcher: "Lookups, summarization, briefings",
  executor: "Multi-step projects needing a standing plan",
  architect: "Self-improvement — always requires approval",
  "hermes-reviewer": "Reviews Hermes' output — always requires approval",
  improver: "Weekly Reflect proposals — always requires approval",
};
const STATUS_ORDER: OrgTaskStatus[] = ["backlog", "active", "blocked", "waiting-on-approval", "done"];
const STATUS_COLOR: Record<OrgTaskStatus, string> = {
  backlog: "bg-ink-700 text-cream-300/70",
  active: "bg-violet-500/15 text-violet-300",
  blocked: "bg-coral-500/15 text-coral-400",
  "waiting-on-approval": "bg-amber-400/15 text-amber-300",
  done: "bg-leaf-500/15 text-leaf-400",
};
const PRIORITY_COLOR: Record<OrgTaskPriority, string> = {
  crown: "bg-fuchsia-500/20 text-fuchsia-300",
  urgent: "bg-coral-500/20 text-coral-300",
  high: "bg-amber-400/15 text-amber-300",
  normal: "bg-ink-800 text-cream-300/50",
  low: "bg-ink-800 text-cream-300/50",
};

function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function OrgBacklogTab() {
  const [tasks, setTasks] = useState<OrgTask[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<OrgTaskStatus | "">("");
  const [expanded, setExpanded] = useState<OrgRole | null>(null);
  const [err, setErr] = useState("");

  async function load() {
    try {
      const r = await api.orgTasks(statusFilter ? { status: statusFilter } : undefined);
      setTasks(r.tasks);
      setErr("");
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setTasks([]);
    }
  }
  useEffect(() => { void load(); const i = setInterval(load, 8000); return () => clearInterval(i); }, [statusFilter]);

  const byRole = (role: OrgRole) => (tasks ?? []).filter(t => t.role === role);
  const totalActive = (tasks ?? []).filter(t => t.status === "active" || t.status === "waiting-on-approval").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-cream-300/50 uppercase tracking-wider">Filter status</span>
        <button
          type="button"
          onClick={() => setStatusFilter("")}
          className={`text-[11px] px-2.5 py-1 rounded-full border ${statusFilter === "" ? "bg-violet-500 border-violet-500 text-white" : "border-ink-700 text-cream-300/70 hover:text-cream-100"}`}
        >All</button>
        {STATUS_ORDER.map(s => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`text-[11px] px-2.5 py-1 rounded-full border ${statusFilter === s ? "bg-violet-500 border-violet-500 text-white" : "border-ink-700 text-cream-300/70 hover:text-cream-100"}`}
          >{s}</button>
        ))}
        <span className="text-[11px] text-cream-300/40 ml-auto">{totalActive} active or awaiting approval right now</span>
        <button type="button" onClick={() => void load()} className="text-xs px-3 py-1.5 rounded-md border border-ink-700 hover:border-violet-500/40 text-cream-300 hover:text-cream-100 flex items-center gap-1.5 shrink-0">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {err && <div className="text-xs text-coral-400 bg-coral-500/10 border border-coral-500/30 rounded-lg px-3 py-2">{err}</div>}

      {tasks === null ? (
        <div className="text-sm text-cream-300/60">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {ROLE_ORDER.map(role => {
            const roleTasks = byRole(role);
            const isOpen = expanded === role;
            const counts = STATUS_ORDER.reduce((acc, s) => { acc[s] = roleTasks.filter(t => t.status === s).length; return acc; }, {} as Record<OrgTaskStatus, number>);
            return (
              <Card key={role} className={roleTasks.length > 0 ? "border-violet-500/20" : ""}>
                <button type="button" onClick={() => setExpanded(isOpen ? null : role)} className="w-full text-left">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-cream-50">{ROLE_LABEL[role]}</div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60 font-mono">{roleTasks.length}</span>
                  </div>
                  <div className="text-[11px] text-cream-300/50 mt-0.5">{ROLE_BLURB[role]}</div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {STATUS_ORDER.filter(s => counts[s] > 0).map(s => (
                      <span key={s} className={`text-[10px] px-1.5 py-0.5 rounded-full ${STATUS_COLOR[s]}`}>{s} · {counts[s]}</span>
                    ))}
                    {roleTasks.length === 0 && <span className="text-[10px] text-cream-300/30">idle</span>}
                  </div>
                </button>
                {isOpen && roleTasks.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-ink-800 space-y-1.5 max-h-64 overflow-y-auto">
                    {roleTasks.map(t => (
                      <div key={t.id} className="text-xs rounded-md bg-ink-950/50 border border-ink-800 px-2.5 py-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_COLOR[t.status]}`}>{t.status}</span>
                          <span className="text-cream-100 truncate flex-1">{t.title}</span>
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${PRIORITY_COLOR[t.priority]}`}>{t.priority}</span>
                        </div>
                        <div className="text-cream-300/50 mt-1 flex items-center gap-1.5">
                          <Clock size={10} /> {relTime(t.updatedAt)} · {t.createdBy}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const GLASS = "bg-ink-900/60 backdrop-blur-md border border-violet-500/20 shadow-[0_0_24px_-8px_rgba(139,92,246,0.25)]";

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

function MiniStat({ icon, label, value, tone }: { icon?: ReactNode; label: string; value: string | number; tone?: "ok" | "warn" }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] text-cream-300/60">{icon}{label}</div>
      <div className={`text-sm font-semibold mt-0.5 ${tone === "warn" ? "text-coral-400" : tone === "ok" ? "text-leaf-400" : "text-cream-100"}`}>{value}</div>
    </div>
  );
}

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

function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}
