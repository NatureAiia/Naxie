import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  LayoutDashboard, Bot, PlayCircle, CheckCircle2, Loader2, DollarSign,
  ShieldAlert, ShieldCheck, Brain, Clock, TrendingUp, Hourglass,
} from "lucide-react";
import { api, type TimeAnalysis, type QualitySummary, type SecurityStatus } from "../lib/api";

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
  const [loading, setLoading] = useState(true);

  // Fast-moving: polled every 5s, same cadence as Naxie.tsx's ambient strip.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const [h, { jobs: j }, n] = await Promise.all([api.health(), api.listJobs(), api.naxieStatus()]);
        if (!alive) return;
        setHealth(h);
        setJobs(j);
        setNaxie(n);
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
    api.securityEvents().then(setSecurity).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const runningCount = jobs.filter(j => j.status === "running" || j.status === "pending").length;
  const finished = jobs.filter(j => j.status === "succeeded" || j.status === "failed" || j.status === "rejected");
  const succeededCount = jobs.filter(j => j.status === "succeeded").length;
  const successRate = finished.length > 0 ? Math.round((succeededCount / finished.length) * 100) : null;
  const recentJobs = [...jobs].sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? ""))).slice(0, 6);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin w-6 h-6" /></div>;

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

      {/* Ops snapshot */}
      <Section title="Ops snapshot">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Tile icon={<PlayCircle className="w-4 h-4" />} label="Running now" value={runningCount} />
          <Tile icon={<Bot className="w-4 h-4" />} label="Agents on roster" value={personaCount ?? "—"} />
          <Tile icon={<CheckCircle2 className="w-4 h-4" />} label="Waiting on your approval" value={naxie?.pendingApprovals ?? 0} />
          <Tile icon={<ShieldCheck className="w-4 h-4" />} label="Connectivity" value={health?.ready ? "Ready" : "Degraded"} tone={health?.ready ? "ok" : "warn"} />
        </div>
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
      </Section>

      {/* Naxie performance */}
      <Section title="Naxie performance">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Tile icon={<CheckCircle2 className="w-4 h-4" />} label="Success rate" value={successRate != null ? `${successRate}%` : "—"} />
          <Tile icon={<Clock className="w-4 h-4" />} label="Median task time" value={eta ? fmtMs(eta.globalMedianMs) : "—"} />
          <Tile icon={<TrendingUp className="w-4 h-4" />} label="Quality signal (30d)" value={quality ? `${quality.upvotes}↑ / ${quality.downvotes}↓` : "—"} />
          <Tile icon={<Hourglass className="w-4 h-4" />} label="Agent time share" value={timeA ? `${timeA.totals.pct.agent}%` : "—"} />
        </div>
        {timeA && <p className="mt-3 text-xs text-cream-300/60">{timeA.verdict}</p>}
        <div className="mt-3">
          <Link to="/runs" className="text-violet-400 hover:text-violet-300 text-xs">All runs →</Link>
        </div>
      </Section>

      {/* Spend */}
      <Section title="Spend">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Tile icon={<DollarSign className="w-4 h-4" />} label="Total spend" value={`$${(costSummary?.totalCostUsd ?? 0).toFixed(4)}`} />
          <Tile icon={<TrendingUp className="w-4 h-4" />} label="LLM calls" value={costSummary?.callCount ?? 0} />
          <Tile icon={<Brain className="w-4 h-4" />} label="Prompt-cache hit rate" value={cache?.overall?.cacheHitRatio != null ? `${Math.round(cache.overall.cacheHitRatio * 100)}%` : "—"} />
        </div>
        <div className="mt-3">
          <Link to="/cost" className="text-violet-400 hover:text-violet-300 text-xs">Full cost breakdown →</Link>
        </div>
      </Section>

      {/* Governance, security & memory */}
      <Section title="Governance, security & memory">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Tile icon={<ShieldAlert className="w-4 h-4" />} label="Blocked IPs" value={security?.blocked?.length ?? 0} tone={(security?.blocked?.length ?? 0) > 0 ? "warn" : "ok"} />
          <Tile icon={<ShieldAlert className="w-4 h-4" />} label="Watched events" value={security?.watching ?? 0} />
          <Tile icon={<Brain className="w-4 h-4" />} label="Memory freshness" value={naxie?.cag?.built ? fmtMs(naxie.cag.ageMs) + " old" : "not built"} />
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
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bg-ink-900 rounded-lg border border-ink-800 p-4">
      <h2 className="font-semibold mb-3 text-cream-100">{title}</h2>
      {children}
    </div>
  );
}

function Tile({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string | number; tone?: "ok" | "warn" }) {
  return (
    <div className="bg-ink-950 rounded-lg border border-ink-800 p-4">
      <div className="flex items-center gap-2 text-sm text-cream-300/60">{icon} {label}</div>
      <div className={`text-2xl font-bold mt-1 ${tone === "warn" ? "text-coral-400" : tone === "ok" ? "text-leaf-400" : "text-cream-50"}`}>{value}</div>
    </div>
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
