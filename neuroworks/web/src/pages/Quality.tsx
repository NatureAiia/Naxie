import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { Loader2, ThumbsUp, ThumbsDown, TrendingUp, TrendingDown, AlertTriangle, BarChart3 } from "lucide-react";

const AXIS_LABEL: Record<string, string> = {
  factuality_risk: "factual accuracy",
  citation_coverage: "citation coverage",
  persona_fit: "persona & structure",
  prompt_alignment: "prompt alignment",
};

export function Quality() {
  const [summary, setSummary] = useState<any>(null);
  const [flags, setFlags] = useState<any[]>([]);
  const [lowQuality, setLowQuality] = useState<any[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getQualitySummary(),
      api.getQualityFlags(),
      api.getLowQualityRuns(0.5, 2),
      api.getQualitySignals().catch(() => ({ signals: [] })),
    ]).then(([s, f, lq, sig]) => {
      setSummary(s);
      setFlags(f.flags);
      setLowQuality(lq.runs);
      setSignals((sig as any).signals ?? []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin w-6 h-6" /></div>;

  const satisfactionPct = summary ? Math.round(summary.rate * 100) : 0;
  const trendIcon = satisfactionPct >= 80 ? <TrendingUp className="w-5 h-5 text-leaf-400" /> : <TrendingDown className="w-5 h-5 text-coral-400" />;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BarChart3 className="w-6 h-6" />
        <h1 className="text-2xl font-bold">Quality Dashboard</h1>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="text-sm text-cream-300/60">Total Flags</div>
          <div className="text-2xl font-bold">{summary?.totalFlags ?? 0}</div>
        </div>
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm text-cream-300/60">
            <ThumbsUp className="w-4 h-4 text-leaf-400" /> Upvotes
          </div>
          <div className="text-2xl font-bold text-leaf-400">{summary?.upvotes ?? 0}</div>
        </div>
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm text-cream-300/60">
            <ThumbsDown className="w-4 h-4 text-coral-400" /> Downvotes
          </div>
          <div className="text-2xl font-bold text-coral-400">{summary?.downvotes ?? 0}</div>
        </div>
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm text-cream-300/60">
            {trendIcon} Satisfaction
          </div>
          <div className="text-2xl font-bold">{satisfactionPct}%</div>
        </div>
      </div>

      {/* Top categories */}
      {summary?.topCategories?.length > 0 && (
        <div className="bg-ink-900 rounded-lg border p-4">
          <h2 className="font-semibold mb-3">Top Issue Categories</h2>
          <div className="space-y-2">
            {summary.topCategories.map((c: any) => (
              <div key={c.category} className="flex items-center justify-between">
                <span className="capitalize">{c.category}</span>
                <span className="text-sm text-cream-300/60">{c.count} flags</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Low quality runs */}
      {lowQuality.length > 0 && (
        <div className="bg-coral-500/10 rounded-lg border border-coral-500/30 p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-5 h-5 text-coral-400" />
            <h2 className="font-semibold text-coral-300 ">Runs Needing Attention</h2>
          </div>
          <div className="space-y-2">
            {lowQuality.map((r: any) => (
              <div key={r.task} className="flex items-center justify-between">
                <span>{r.task}</span>
                <span className="text-sm text-coral-400">{Math.round(r.rate * 100)}% satisfaction ({r.count} flags)</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Learned signals — Feature A: which axis each task type is weak on,
          now fed back into the planner to steer the next run of that type. */}
      {signals.length > 0 && (
        <div className="bg-violet-500/10 rounded-lg border border-violet-500/30 p-4">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="w-5 h-5 text-violet-300" />
            <h2 className="font-semibold text-violet-200">Learned Quality Signals</h2>
          </div>
          <p className="text-xs text-cream-300/60 mb-3">
            Aggregated from the agents' own quality checks. The weakest axis per task type is injected into planning so the next run of that type is steered to fix it.
          </p>
          <div className="space-y-2">
            {signals.map((s: any) => (
              <div key={`${s.scope}:${s.key}`} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium">{s.key}</span>
                  <span className="text-xs text-cream-300/50 ml-2">{s.scope === "kind" ? "task type" : "persona"} · {s.samples} runs</span>
                </div>
                <span className="text-xs px-2 py-0.5 rounded bg-violet-500/20 text-violet-200 shrink-0">
                  weak: {AXIS_LABEL[s.weakestAxis] ?? s.weakestAxis} ({Math.round(s.weakestGoodness * 100)}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent flags */}
      <div className="bg-ink-900 rounded-lg border p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Recent Feedback</h2>
        </div>
        {flags.length === 0 ? (
          <p className="text-sm text-cream-300/60">No feedback recorded yet. Flag outputs as good/bad from the results page.</p>
        ) : (
          <div className="space-y-2">
            {flags.slice(0, 20).map((f: any) => (
              <div key={`${f.jobId}-${f.ts}`} className="flex items-start gap-3 p-2 border-b last:border-0">
                {f.rating === "up" ? (
                  <ThumbsUp className="w-4 h-4 text-leaf-400 mt-0.5 shrink-0" />
                ) : (
                  <ThumbsDown className="w-4 h-4 text-coral-400 mt-0.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{f.persona || "Unknown persona"}</div>
                  {f.note && <div className="text-xs text-cream-300/60 truncate">{f.note}</div>}
                  <div className="text-xs text-cream-300/50">{new Date(f.ts).toLocaleString()}</div>
                </div>
                {f.category && <span className="text-xs capitalize px-2 py-0.5 rounded bg-ink-800">{f.category}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
