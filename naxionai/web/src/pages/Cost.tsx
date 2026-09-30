import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/PageHeader";
import { Card } from "../components/Card";

type CostSummary = {
  totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; callCount: number;
  byModel: { model: string; costUsd: number; calls: number; failed: number; failureRate: number }[];
};

// LLM spend summary + trend — ported from AI-Institute-Africa/neuroworks'
// Cost.tsx UI over Naxie's already-built, previously-unused cost.ts backend
// (cost-tracker.ts already records every LLM call).
export function Cost() {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [trend, setTrend] = useState<{ date: string; neuroUsd: number }[]>([]);

  useEffect(() => {
    api.getCostSummary().then(setSummary).catch(() => {});
    api.costTrend(14).then(r => setTrend(r.series)).catch(() => {});
  }, []);

  const maxDay = Math.max(0.0001, ...trend.map(d => d.neuroUsd));

  return (
    <div className="space-y-6">
      <PageHeader icon={<Wallet size={24} />} title="Cost" subtitle="LLM spend across every backend, tracked per call." />

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><div className="text-2xl font-display text-cream-50">${summary.totalCostUsd.toFixed(2)}</div><div className="text-[11px] text-cream-300/50">total spend</div></Card>
          <Card><div className="text-2xl font-display text-cream-50">{summary.callCount}</div><div className="text-[11px] text-cream-300/50">calls</div></Card>
          <Card><div className="text-2xl font-display text-cream-50">{(summary.totalInputTokens / 1000).toFixed(1)}k</div><div className="text-[11px] text-cream-300/50">input tokens</div></Card>
          <Card><div className="text-2xl font-display text-cream-50">{(summary.totalOutputTokens / 1000).toFixed(1)}k</div><div className="text-[11px] text-cream-300/50">output tokens</div></Card>
        </div>
      )}

      <Card title="14-day trend">
        {trend.length === 0 ? (
          <div className="text-xs text-cream-300/40 py-4 text-center">No spend recorded yet.</div>
        ) : (
          <div className="flex items-end gap-1 h-32">
            {trend.map(d => (
              <div key={d.date} className="flex-1 flex flex-col items-center gap-1" title={`${d.date}: $${d.neuroUsd.toFixed(4)}`}>
                <div className="w-full bg-violet-500/40 rounded-t" style={{ height: `${Math.max(2, (d.neuroUsd / maxDay) * 100)}%` }} />
                <span className="text-[8px] text-cream-300/40 rotate-45 origin-left">{d.date.slice(5)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="By model">
        <div className="space-y-1.5">
          {(summary?.byModel ?? []).sort((a, b) => b.costUsd - a.costUsd).map(m => (
            <div key={m.model} className="flex items-center gap-2 text-xs rounded-md bg-ink-950/50 border border-ink-800 px-2.5 py-2">
              <span className="text-cream-100 flex-1 truncate">{m.model}</span>
              <span className="text-cream-300/40">{m.calls} calls</span>
              {m.failed > 0 && <span className="text-coral-400">{(m.failureRate * 100).toFixed(0)}% failed</span>}
              <span className="text-cream-100 font-mono">${m.costUsd.toFixed(4)}</span>
            </div>
          ))}
          {(summary?.byModel ?? []).length === 0 && <div className="text-xs text-cream-300/40 py-2">No calls recorded yet.</div>}
        </div>
      </Card>
    </div>
  );
}
