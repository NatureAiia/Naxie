import { useState, useEffect } from "react";
import { api, type TimeAnalysis, type CostTrend, type RosterRow } from "../lib/api";
import { Loader2, DollarSign, Cpu, BarChart3, TrendingUp, Calendar, Hourglass, Server } from "lucide-react";
import { SignalBloom } from "../components/SignalBloom";
import { GlassCard } from "../components/GlassCard";
import { showToast } from "../components/Card";

export function Cost() {
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [timeA, setTimeA] = useState<TimeAnalysis | null>(null);
  const [trend, setTrend] = useState<CostTrend | null>(null);
  const [cache, setCache] = useState<any>(null);
  const [roster, setRoster] = useState<{ policy: { allowPaidModels: boolean }; offline: RosterRow[]; online: RosterRow[] } | null>(null);

  const loadRoster = () => api.getModelRoster().then(setRoster).catch(() => {});
  const loadSide = () => {
    api.timeAnalysis(30).then(setTimeA).catch(() => {});
    api.costTrend(14).then(setTrend).catch(() => {});
    api.cacheStats().then(setCache).catch(() => {});
    loadRoster();
  };
  useEffect(() => {
    api.getCostSummary().then(setSummary).catch(() => {}).finally(() => setLoading(false));
    loadSide();
  }, []);

  async function togglePaidModels(next: boolean) {
    try {
      const r = await api.setModelPolicy(next);
      setRoster(prev => prev ? { ...prev, policy: r.policy } : prev);
      showToast(next ? "Paid models approved" : "Paid models blocked — free tier + local only", next ? "success" : "info");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin w-6 h-6" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <DollarSign className="w-6 h-6" />
        <h1 className="text-2xl font-bold">Cost Monitoring</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <GlassCard className="p-4 flex items-center gap-3">
          <SignalBloom value={Math.min(100, (summary?.totalCostUsd ?? 0)*200)} size={48} color="flame" sublabel="spend" />
          <div><div className="text-sm text-cream-300/60">Total Cost</div><div className="text-xl font-bold">${(summary?.totalCostUsd ?? 0).toFixed(4)}</div></div>
        </GlassCard>
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="text-sm text-cream-300/60">LLM Calls</div>
          <div className="text-2xl font-bold">{summary?.callCount ?? 0}</div>
        </div>
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm text-cream-300/60">
            <Cpu className="w-4 h-4" /> Input Tokens
          </div>
          <div className="text-2xl font-bold">{(summary?.totalInputTokens ?? 0).toLocaleString()}</div>
        </div>
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm text-cream-300/60">
            <TrendingUp className="w-4 h-4" /> Output Tokens
          </div>
          <div className="text-2xl font-bold">{(summary?.totalOutputTokens ?? 0).toLocaleString()}</div>
        </div>
      </div>

      {roster && <ModelRosterCard roster={roster} onTogglePaid={togglePaidModels} />}

      {/* LLM/API spend trend — daily, USD. No chart lib in this app, so each
          day is a proportion bar scaled to the window's max daily spend. */}
      {trend && trend.series.length > 0 && (() => {
        const max = Math.max(0.0001, ...trend.series.map(d => d.neuroUsd));
        const totalNeuro = trend.series.reduce((s, d) => s + d.neuroUsd, 0);
        return (
          <div className="bg-ink-900 rounded-lg border p-4">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <h2 className="font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Daily spend (last {trend.days} days, USD)</h2>
              <div className="flex gap-4 text-xs text-cream-300/60">
                <span><span className="inline-block w-2 h-2 rounded-full bg-violet-500 mr-1" />total ${totalNeuro.toFixed(2)}</span>
              </div>
            </div>
            <div className="space-y-1.5">
              {trend.series.map(d => (
                <div key={d.date} className="flex items-center gap-3 text-[11px]">
                  <span className="w-20 shrink-0 text-cream-300/60 font-mono">{d.date.slice(5)}</span>
                  <div className="flex-1">
                    <div className="h-2 rounded bg-ink-950 overflow-hidden"><div className="h-full bg-violet-500" style={{ width: `${(d.neuroUsd / max) * 100}%` }} title={`$${d.neuroUsd.toFixed(4)}`} /></div>
                  </div>
                  <span className="w-20 shrink-0 text-right text-cream-300/50 tabular-nums">${d.neuroUsd.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Where time goes — the waste detector. Decomposes the window into agent
          runtime vs waiting-on-human vs logged human work, names the biggest
          sinks on each side, and gives a plain-language verdict. */}
      {timeA && timeA.totals.totalMs > 0 && (
        <div className="bg-ink-900 rounded-lg border p-4">
          <h2 className="font-semibold mb-1 flex items-center gap-2"><Hourglass className="w-4 h-4" /> Where time goes — last {timeA.days} days</h2>
          <p className="text-xs text-cream-300/60 mb-3">{timeA.verdict}</p>
          <div className="h-3 rounded-full overflow-hidden flex mb-2 bg-ink-950">
            <div className="bg-violet-500" style={{ width: `${timeA.totals.pct.agent}%` }} title={`Agent runtime ${timeA.totals.pct.agent}%`} />
            <div className="bg-amber-500" style={{ width: `${timeA.totals.pct.humanWait}%` }} title={`Waiting on humans ${timeA.totals.pct.humanWait}%`} />
            <div className="bg-leaf-500" style={{ width: `${timeA.totals.pct.humanWork}%` }} title={`Human work ${timeA.totals.pct.humanWork}%`} />
          </div>
          <div className="flex gap-4 text-xs text-cream-300/60 mb-4 flex-wrap">
            <span><span className="inline-block w-2 h-2 rounded-full bg-violet-500 mr-1" />Agent runtime {timeA.totals.pct.agent}% ({fmtMs(timeA.totals.agentMs)})</span>
            <span><span className="inline-block w-2 h-2 rounded-full bg-amber-500 mr-1" />Waiting on humans {timeA.totals.pct.humanWait}% ({fmtMs(timeA.totals.humanWaitMs + timeA.totals.openWaitMs)})</span>
            <span><span className="inline-block w-2 h-2 rounded-full bg-leaf-500 mr-1" />Human work {timeA.totals.pct.humanWork}% ({timeA.humanWorkHours}h)</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {timeA.slowestAgentTypes.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-cream-200 mb-1.5">Slowest agent task types</div>
                {timeA.slowestAgentTypes.slice(0, 5).map(t => (
                  <div key={t.type} className="flex justify-between text-xs text-cream-300/60 py-0.5">
                    <span className="font-mono truncate">{t.type}</span><span className="shrink-0 ml-2">{fmtMs(t.ms)}</span>
                  </div>
                ))}
              </div>
            )}
            {timeA.longestWaits.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-cream-200 mb-1.5">Longest waits on a human</div>
                {timeA.longestWaits.slice(0, 5).map((w, i) => (
                  <div key={i} className="flex justify-between text-xs text-cream-300/60 py-0.5">
                    <span className="truncate">{w.open ? "⏳ " : ""}{w.title}</span><span className="shrink-0 ml-2">{fmtMs(w.waitMs)}{w.open ? " · still waiting" : ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {summary?.byModel?.length > 0 && (
        <div className="bg-ink-900 rounded-lg border p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2"><BarChart3 className="w-4 h-4" /> Cost by Model</h2>
          <div className="space-y-2">
            {summary.byModel.map((m: any) => (
              <div key={m.model} className="flex items-center justify-between">
                <span className="text-sm font-mono">{m.model}</span>
                <div className="flex gap-4 text-sm text-cream-300/60">
                  <span>${m.costUsd.toFixed(4)}</span>
                  <span>{m.calls} calls</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {summary?.byDay?.length > 0 && (
        <div className="bg-ink-900 rounded-lg border p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Calendar className="w-4 h-4" /> Cost by Day</h2>
          <div className="space-y-1">
            {summary.byDay.slice(-14).map((d: any) => (
              <div key={d.date} className="flex items-center justify-between text-sm">
                <span>{d.date}</span>
                <div className="flex gap-4 text-cream-300/60">
                  <span>${d.costUsd.toFixed(4)}</span>
                  <span>{d.calls} calls</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {cache && (
        <div className="bg-ink-900 rounded-lg border p-4">
          <h2 className="font-semibold mb-2">Prompt cache hit-rate</h2>
          <div className="text-sm text-cream-300/60">Overall <span className="font-mono text-cream-100">{((cache.overall?.cacheHitRatio ?? 0)*100).toFixed(1)}%</span> cached · {cache.overall?.callsWithCache ?? 0}/{cache.overall?.calls ?? 0} calls had cache</div>
          <div className="mt-2 space-y-1 text-xs">
            {Object.entries(cache.profiles ?? {}).slice(0,6).map(([k,v]:any)=>(<div key={k} className="flex justify-between"><span className="font-mono">{k}</span><span>{(v.cacheHitRatio*100).toFixed(1)}% · {v.cachedInputTokens.toLocaleString()}/{v.inputTokens.toLocaleString()} tok</span></div>))}
          </div>
        </div>
      )}

      {summary?.recentCalls?.length > 0 && (
        <RecentCallsBlock summary={summary} />
      )}
    </div>
  );
}

function RosterRowView({ row }: { row: RosterRow }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b last:border-0 border-ink-800">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-xs truncate">{row.name}</span>
          {row.tier && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60">{row.tier} tier</span>}
          {row.active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-leaf-500/10 text-leaf-400">active</span>}
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${row.free ? "bg-leaf-500/10 text-leaf-400" : "bg-amber-500/10 text-amber-400"}`}>{row.free ? "free" : "paid"}</span>
        </div>
        {row.providerLabel && <div className="text-[11px] text-cream-300/40 mt-0.5">{row.providerLabel}</div>}
      </div>
      <div className="flex gap-3 shrink-0 text-xs text-cream-300/60 tabular-nums">
        <span>{row.calls} calls</span>
        {row.failed > 0 && <span className="text-coral-400">{(row.failureRate * 100).toFixed(0)}% failed</span>}
        <span>${row.costUsd.toFixed(4)}</span>
      </div>
    </div>
  );
}

function ModelRosterCard({ roster, onTogglePaid }: { roster: { policy: { allowPaidModels: boolean }; offline: RosterRow[]; online: RosterRow[] }; onTogglePaid: (next: boolean) => void }) {
  const onlineFree = roster.online.filter(r => r.free);
  const onlinePaid = roster.online.filter(r => !r.free);
  return (
    <div className="bg-ink-900 rounded-lg border p-4">
      <h2 className="font-semibold mb-3 flex items-center gap-2"><Server className="w-4 h-4" /> Model Roster</h2>
      <div className="space-y-4">
        <div>
          <div className="text-xs font-semibold text-cream-300/60 mb-1">Offline — local (always free, last-resort fallback)</div>
          {roster.offline.length === 0
            ? <div className="text-xs text-cream-300/40">No local Ollama models pulled.</div>
            : roster.offline.map(r => <RosterRowView key={r.name} row={r} />)}
        </div>
        <div>
          <div className="text-xs font-semibold text-cream-300/60 mb-1">Online — free</div>
          {onlineFree.length === 0
            ? <div className="text-xs text-cream-300/40">No free online model configured.</div>
            : onlineFree.map(r => <RosterRowView key={`${r.providerLabel}-${r.name}-${r.tier ?? ""}`} row={r} />)}
        </div>
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-xs font-semibold text-cream-300/60">Online — paid</div>
            <button
              type="button"
              role="switch"
              aria-checked={roster.policy.allowPaidModels}
              onClick={() => onTogglePaid(!roster.policy.allowPaidModels)}
              title="Allow paid models"
              className={`shrink-0 w-11 h-6 rounded-full border transition-colors relative ${roster.policy.allowPaidModels ? "bg-violet-600 border-violet-500" : "bg-ink-800 border-ink-700"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${roster.policy.allowPaidModels ? "translate-x-[22px]" : "translate-x-0.5"}`} />
            </button>
          </div>
          {!roster.policy.allowPaidModels && <div className="text-[11px] text-amber-400/80 mb-1">Blocked — the dispatcher downgrades these to a free model or local Ollama until approved.</div>}
          {onlinePaid.length === 0
            ? <div className="text-xs text-cream-300/40">No paid model registered.</div>
            : onlinePaid.map(r => <RosterRowView key={`${r.providerLabel}-${r.name}-${r.tier ?? ""}`} row={r} />)}
        </div>
      </div>
    </div>
  );
}

function RecentCallsBlock({ summary }: { summary: any }) {
  return (
    <div className="bg-ink-900 rounded-lg border p-4">
      <h2 className="font-semibold mb-3">Recent Calls</h2>
      <div className="space-y-1 text-sm">
        {summary.recentCalls.slice(0, 20).map((c: any, i: number) => (
          // jobId+ts alone can collide — most calls are jobId:"adhoc" (not
          // tied to a tracked job), and two calls landing in the same
          // millisecond isn't rare under concurrent requests. Index as a
          // tiebreaker is safe here since this list is a static slice, not
          // reordered/filtered independently between renders.
          <div key={`${c.jobId}-${c.ts}-${i}`} className="flex items-center justify-between border-b last:border-0 py-1">
            <div className="flex-1 min-w-0">
              <span className="font-mono text-xs truncate block">{c.model}</span>
              <span className="text-xs text-cream-300/50">{c.profile}</span>
            </div>
            <div className="flex gap-3 shrink-0 text-xs text-cream-300/60">
              <span title={`${c.inputTokens} in / ${c.outputTokens} out`}>⬆{c.inputTokens} ⬇{c.outputTokens}</span>
              <span>${c.costUsd.toFixed(6)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// "2h 15m" / "45m" / "30s" — coarse on purpose; this page is about proportions.
function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}
