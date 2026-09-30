import { useEffect, useState } from "react";
import { Waypoints, Play, Clock, ChevronDown, ChevronRight } from "lucide-react";
import { api, type OrchestrationRun } from "../lib/api";
import { PageHeader } from "../components/PageHeader";
import { Card, Button, showToast } from "../components/Card";
import { EmptyState } from "../components/States";

// Multi-agent objective decomposition — ported from AI-Institute-Africa/
// neuroworks' Orchestrate.tsx. The backend (routes/orchestrator.ts,
// lib/orchestrator.ts) already existed in Naxie with zero frontend; this is
// pure UI wiring against it. Submit an objective, the server decomposes it
// into parallel sub-tasks and synthesizes a final report.
type RunListItem = { id: string; label: string; status: string; subTaskCount: number; doneCount: number; createdAt: string; elapsedMs?: number };

const STATUS_COLOR: Record<string, string> = {
  planning: "bg-ink-800 text-cream-300/60",
  running: "bg-violet-500/15 text-violet-300",
  completed: "bg-leaf-500/15 text-leaf-400",
  failed: "bg-coral-500/15 text-coral-400",
  pending: "bg-ink-800 text-cream-300/60",
  done: "bg-leaf-500/15 text-leaf-400",
};

function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function Orchestrate() {
  const [objective, setObjective] = useState("");
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<RunListItem[] | null>(null);
  const [expanded, setExpanded] = useState<OrchestrationRun | null>(null);
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  async function load() {
    try { const r = await api.listOrchestrations(); setRuns(r.runs); } catch { /* ignore */ }
  }
  useEffect(() => { void load(); const i = setInterval(load, 6000); return () => clearInterval(i); }, []);

  async function submit() {
    if (!objective.trim()) return;
    setRunning(true);
    try {
      await api.runOrchestration(objective.trim());
      setObjective("");
      showToast("Orchestration complete", "success");
      void load();
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setRunning(false);
    }
  }

  async function openRun(id: string) {
    setLoadingDetail(id);
    try {
      const r = await api.getOrchestration(id);
      setExpanded(r.run);
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setLoadingDetail(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Waypoints size={24} />}
        title="Orchestrate"
        subtitle="Decompose a big objective into parallel sub-tasks and synthesize a final report — for asks too large for one agent pass."
      />

      <Card title="New objective">
        <div className="flex gap-2">
          <textarea
            value={objective}
            onChange={e => setObjective(e.target.value)}
            placeholder="e.g. Research our top 3 competitors' pricing and draft a comparison memo"
            rows={3}
            className="flex-1 bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100 resize-none"
          />
        </div>
        <div className="flex justify-end mt-2">
          <Button onClick={() => void submit()} disabled={running || !objective.trim()}>
            {running ? "Running…" : <><Play size={14} className="mr-1 inline" /> Run</>}
          </Button>
        </div>
      </Card>

      <div>
        <h2 className="text-sm font-medium text-cream-100 mb-2">Runs</h2>
        {runs === null ? (
          <div className="text-sm text-cream-300/60">Loading…</div>
        ) : runs.length === 0 ? (
          <EmptyState icon={Waypoints} title="No orchestration runs yet" body="Submit an objective above to start one." />
        ) : (
          <div className="space-y-1.5">
            {runs.map(r => (
              <div key={r.id}>
                <button type="button" onClick={() => void openRun(r.id)} className="w-full text-left text-xs rounded-md bg-ink-950/50 border border-ink-800 px-2.5 py-2 hover:border-violet-500/40 flex items-center gap-2">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_COLOR[r.status] ?? ""}`}>{r.status}</span>
                  <span className="text-cream-100 truncate flex-1">{r.label}</span>
                  <span className="text-cream-300/40 shrink-0">{r.doneCount}/{r.subTaskCount} sub-tasks</span>
                  <span className="text-cream-300/30 shrink-0 flex items-center gap-1"><Clock size={10} /> {relTime(r.createdAt)}</span>
                  {expanded?.id === r.id ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                {expanded?.id === r.id && (
                  <div className="mt-1.5 ml-2 pl-3 border-l border-ink-800 space-y-2">
                    <div className="text-xs text-cream-300/70 whitespace-pre-wrap">{expanded.decomposition}</div>
                    {expanded.subTasks.map(s => (
                      <div key={s.id} className="text-xs rounded-md bg-ink-950 border border-ink-800 px-2.5 py-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_COLOR[s.status] ?? ""}`}>{s.status}</span>
                          <span className="text-cream-100">{s.label}</span>
                          {s.personaName && <span className="text-cream-300/40">· {s.personaName}</span>}
                        </div>
                        {s.output && <div className="text-cream-300/60 mt-1 whitespace-pre-wrap">{s.output.slice(0, 500)}{s.output.length > 500 ? "…" : ""}</div>}
                        {s.error && <div className="text-coral-400 mt-1">{s.error}</div>}
                      </div>
                    ))}
                    {expanded.finalReport && (
                      <div className="text-xs rounded-md bg-violet-500/5 border border-violet-500/20 px-2.5 py-2">
                        <div className="text-violet-300 font-medium mb-1">Final report</div>
                        <div className="text-cream-100 whitespace-pre-wrap">{expanded.finalReport}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
