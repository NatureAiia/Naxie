import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { marked } from "marked";
import { HandHelping, Square, ThumbsUp, ThumbsDown, BarChart3, AlertTriangle } from "lucide-react";
import { api, type WaitingTask } from "../lib/api";
import { Card, SkeletonList } from "../components/Card";
import { useLoadMore, LoadMoreButton } from "../components/LoadMore";
import { ResultPanel } from "../components/ResultPanel";
import { MultiStepLoader } from "../components/MultiStepLoader";
import { AgentStepFeed } from "../components/AgentStepFeed";
import { LinkPreview } from "../components/LinkPreview";
import { VoiceDiscussion } from "../components/VoiceDiscussion";
import { useVisibleInterval } from "../lib/useVisibleInterval";

// ─────────────────────────────────────────────────────────────────────────
// Runs — the merged job list. Folds together what used to be four separate
// pages:
//   - Tasks.tsx        → "waiting on you" panel, live activity strip,
//                         cancel/resume/human-input actions, the two-column
//                         Board view with a detail panel. The old plain
//                         timeline (Activity.tsx) now lives INSIDE the board
//                         as its left-column feed — one view, no toggle.
//   - Results.tsx       → ResultsIndex's "Reports" browsing (all/captured)
//                         folded in as filters, not a separate page. Results
//                         (the per-job document) is exported below as
//                         `RunDetail`, basically as-is.
//   - Quality.tsx       → a "Low quality" filter chip (getLowQualityRuns,
//                         cross-referenced against jobs by flagged jobId /
//                         persona) plus a compact, expandable quality-signals
//                         strip (getQualitySummary/getQualityFlags/
//                         getQualitySignals) above the list.
// ─────────────────────────────────────────────────────────────────────────

type EtaStats = { byType: Record<string, { medianMs: number; count: number }>; globalMedianMs: number; count: number };
type LowQualityRun = { task: string; count: number; rate: number };
type QualitySignal = { scope: "kind" | "persona"; key: string; samples: number; means: Record<string, number>; weakestAxis: string; weakestGoodness: number };

const AXIS_LABEL: Record<string, string> = {
  factuality_risk: "factual accuracy",
  citation_coverage: "citation coverage",
  persona_fit: "persona & structure",
  prompt_alignment: "prompt alignment",
};

// A job counts as "report-shaped" when it's the kind of finished work that
// gets a polished write-up — general chat tasks, saved custom templates, and
// delegated peer work. Digests/syncs/etc. have their own result shapes and
// don't fit the report list (mirrors ResultsIndex's old filter).
function isReportShaped(job: any): boolean {
  return job.template === "general-task" || (job.template ?? "").startsWith("custom-") || job.template === "peer:delegate" || job.kind === "peer:delegate";
}

function personaNameOf(job: any): string | undefined {
  const r = job.result ?? {};
  return job.inputs?.activePersona?.name ?? r.activePersona?.name ?? r.peer?.name ?? job.inputs?.activePersona?.id ?? r.activePersona?.id;
}

// Cross-references a job against the quality signals fetched for the whole
// workforce: a direct thumbs-down flag on this exact job, or this job's
// persona showing up in the low-satisfaction list.
function isLowQuality(job: any, downFlaggedJobIds: Set<string>, lowQualityRuns: LowQualityRun[]): boolean {
  if (downFlaggedJobIds.has(job.id)) return true;
  const persona = personaNameOf(job);
  return !!persona && lowQualityRuns.some(r => r.task === persona);
}

// Derive the step list + current index for the full-screen activity view from
// a running job's live plan. Falls back to plain phases before a plan exists.
function jobLoaderSteps(job: any): { states: { text: string }[]; current: number } {
  const r = job?.result ?? {};
  const steps: any[] = r.plan?.steps ?? [];
  const runs: any[] = r.runs ?? [];
  const done = runs.filter((x: any) => x?.ok === true).length;
  if (steps.length === 0) {
    return { states: [{ text: "Working out a plan" }, { text: "Doing the work" }, { text: "Drafting your answer" }, { text: "Reviewing the draft" }], current: r.phase === "synthesizing" ? 2 : r.phase === "reviewing" ? 3 : r.phase === "executing" ? 1 : 0 };
  }
  return { states: steps.map((s: any, i: number) => ({ text: String(s.label ?? s.tool ?? `Step ${i + 1}`) })), current: Math.min(done, steps.length) };
}

export function Runs() {
  const [params, setParams] = useSearchParams();
  const focusId = params.get("focus");
  const [jobs, setJobs] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  // One unified filter — status (running/failed) and kind (reports/saved/
  // low-quality) live in the same row. Single-operator: no "by employee".
  const [filter, setFilter] = useState<"all" | "running" | "failed" | "reports" | "captured" | "low-quality">(
    params.get("filter") === "quality" ? "low-quality" : "all"
  );
  const [eta, setEta] = useState<EtaStats | null>(null);
  const [now, setNow] = useState(Date.now());
  const [waiting, setWaiting] = useState<WaitingTask[]>([]);
  const [activityJobId, setActivityJobId] = useState<string | null>(null);

  const [qualitySummary, setQualitySummary] = useState<any>(null);
  const [qualitySignals, setQualitySignals] = useState<QualitySignal[]>([]);
  const [lowQualityRuns, setLowQualityRuns] = useState<LowQualityRun[]>([]);
  const [downFlaggedJobIds, setDownFlaggedJobIds] = useState<Set<string>>(new Set());
  const [qualityOpen, setQualityOpen] = useState(false);

  async function load() {
    try { const r = await api.listJobs(); setJobs(r.jobs); } catch {} finally { setLoaded(true); }
  }
  useVisibleInterval(load, 5000);
  // ETA history refreshes lazily — it barely changes between polls.
  const loadEta = () => api.taskEtaStats().then(setEta).catch(() => {});
  useVisibleInterval(loadEta, 30000);
  // Waiting-on-you queue — tasks paused on a structured human ask. Polled at a
  // relaxed cadence; answering one triggers an immediate refresh.
  const loadWaiting = () => api.tasksWaiting().then(r => setWaiting(r.waiting)).catch(() => {});
  useVisibleInterval(loadWaiting, 15000);
  // Quality signals — feeds the "Low quality" chip + summary strip. Changes
  // slowly (feedback is occasional), so a relaxed poll is enough.
  function loadQuality() {
    Promise.all([
      api.getQualitySummary(),
      api.getLowQualityRuns(0.5, 2),
      api.getQualitySignals().catch(() => ({ signals: [] as QualitySignal[] })),
      api.getQualityFlags().catch(() => ({ flags: [] as any[] })),
    ]).then(([s, lq, sig, fl]) => {
      setQualitySummary(s);
      setLowQualityRuns(lq.runs);
      setQualitySignals((sig as any).signals ?? []);
      setDownFlaggedJobIds(new Set((fl as any).flags.filter((f: any) => f.rating === "down").map((f: any) => f.jobId)));
    }).catch(() => {});
  }
  useVisibleInterval(loadQuality, 30000);

  const filtered = useMemo(() => {
    let list = jobs;
    if (filter === "running") list = list.filter(j => j.status === "running");
    else if (filter === "failed") list = list.filter(j => j.status === "failed");
    else if (filter === "reports") list = list.filter(j => (j.status === "succeeded" || j.status === "failed") && isReportShaped(j));
    else if (filter === "captured") list = list.filter(j => (j.status === "succeeded" || j.status === "failed") && isReportShaped(j) && j.result?.curation?.captured === true);
    else if (filter === "low-quality") list = list.filter(j => isLowQuality(j, downFlaggedJobIds, lowQualityRuns));
    return list;
  }, [jobs, filter, downFlaggedJobIds, lowQualityRuns]);

  const taskList = useLoadMore(filtered);
  const focused = focusId ? jobs.find(j => j.id === focusId) : null;
  const runningJobs = useMemo(() => jobs.filter(j => j.status === "running" || j.status === "pending"), [jobs]);
  const runningCount = useMemo(() => jobs.filter(j => j.status === "running").length, [jobs]);
  const failedCount = useMemo(() => jobs.filter(j => j.status === "failed").length, [jobs]);
  const lowQualityCount = useMemo(() => jobs.filter(j => isLowQuality(j, downFlaggedJobIds, lowQualityRuns)).length, [jobs, downFlaggedJobIds, lowQualityRuns]);
  const savedCount = useMemo(() => jobs.filter(j => j.result?.curation?.captured === true).length, [jobs]);

  // Tick a 1s clock ONLY while something is running, so the elapsed time and
  // ETA countdown update live without re-polling the server.
  useEffect(() => {
    if (runningJobs.length === 0) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [runningJobs.length]);

  function focusJob(jobId: string) {
    params.set("focus", jobId);
    setParams(params);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-cream-50">Runs</h1>
          <p className="text-sm text-cream-300/70 mt-1">Completed and active agent executions, reports, and quality signals. Personal tasks are in Planner; recurring work is in Schedules.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {([
          { id: "all" as const, label: `All (${jobs.length})` },
          { id: "running" as const, label: `Running (${runningCount})` },
          { id: "failed" as const, label: `Failed (${failedCount})` },
          { id: "reports" as const, label: "Reports" },
          { id: "captured" as const, label: `Saved to vault (${savedCount})` },
          { id: "low-quality" as const, label: `Low quality${lowQualityCount > 0 ? ` (${lowQualityCount})` : ""}`, alert: true },
        ]).map(f => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border ${
              filter === f.id
                ? f.alert ? "bg-coral-500/15 border-coral-500/40 text-coral-300" : "bg-violet-500/15 border-violet-500/40 text-violet-300"
                : "border-transparent text-cream-300/70 hover:text-cream-100"
            }`}
          >
            {f.alert && <AlertTriangle className="w-3.5 h-3.5" />}
            {f.label}
          </button>
        ))}
      </div>

      {/* Quality signals strip — compact by default, expandable for the full
          picture (top issue categories, learned weak axes, low-satisfaction
          personas). Folds in Quality.tsx without dedicating a whole page. */}
      {qualitySummary && <QualityStrip summary={qualitySummary} lowQualityRuns={lowQualityRuns} signals={qualitySignals} open={qualityOpen} onToggle={() => setQualityOpen(o => !o)} />}

      {/* Waiting on you — tasks the agents paused because only the operator can
          supply the next piece (info, approval, an offline action). Answering
          resumes the loop automatically as a continuation task. */}
      {waiting.length > 0 && <WaitingOnYouPanel waiting={waiting} onResumed={(newJobId) => { loadWaiting(); load(); focusJob(newJobId); }} />}

      {/* Live activity strip — only when something's actively running. The
          row shows the operator's view of WHAT is happening, in plain English. */}
      {runningJobs.length > 0 && <LiveActivityStrip jobs={runningJobs} eta={eta} now={now} onOpenActivity={setActivityJobId} onOpenJob={focusJob} onCancel={async (id) => { try { await api.cancelJob(id); } catch {} await load(); }} />}

      {/* Full-screen step-by-step activity view for one running task, driven by
          its live plan progress. Auto-hides when the task leaves running. */}
      {(() => {
        const aj = activityJobId ? jobs.find(j => j.id === activityJobId) : null;
        if (!aj || (aj.status !== "running" && aj.status !== "pending")) return null;
        const { states, current } = jobLoaderSteps(aj);
        return <MultiStepLoader loadingStates={states} loading currentState={current} onClose={() => setActivityJobId(null)} />;
      })()}

      {/* Board — timeline feed on the left, detail panel on the right.
          Clicking a run focuses it in the detail panel. */}
      <div className="grid grid-cols-1 tablet:grid-cols-5 gap-5">
        <div className="tablet:col-span-2">
          <Card>
            {!loaded && <SkeletonList rows={6} />}
            {loaded && filtered.length === 0 && <div className="text-sm text-cream-300/60 text-center py-8">No runs {filter !== "all" ? "match this filter" : "yet"}.</div>}
            {loaded && filtered.length > 0 && (
              <ul className="relative">
                <div className="absolute left-2 top-2 bottom-2 w-px bg-ink-700" />
                {taskList.visible.map(j => {
                  const lowQuality = isLowQuality(j, downFlaggedJobIds, lowQualityRuns);
                  const captured = j.result?.curation?.captured === true;
                  const finishedReport = isReportShaped(j) && (j.status === "succeeded" || j.status === "failed");
                  const preview = typeof j.result?.answer === "string"
                    ? j.result.answer.replace(/^#+\s+.*$/m, "").replace(/[#*`>[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 160)
                    : "";
                  const isFocused = focusId === j.id;
                  return (
                    <li key={j.id} className="relative pl-8 py-3 border-b border-ink-800 last:border-0">
                      <span className={`absolute left-0.5 top-4 w-3.5 h-3.5 rounded-full border-2 ${isFocused ? "border-violet-500" : "border-ink-900"} ${j.status === "succeeded" ? "bg-leaf-500" : j.status === "failed" ? "bg-coral-500" : j.status === "running" ? "bg-flame-400" : "bg-cream-300/30"}`} />
                      <button
                        type="button"
                        onClick={() => { params.set("focus", j.id); setParams(params); }}
                        className={`w-full text-left rounded-lg px-2 -mx-2 py-1 transition-colors ${isFocused ? "bg-violet-500/10" : "hover:bg-ink-800/60"}`}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm text-cream-50">{friendlyTitle(j)}</span>
                          {lowQuality && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-coral-500/40 text-coral-400 bg-coral-500/10">low quality</span>}
                          {captured && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-leaf-500/40 text-leaf-400 bg-leaf-500/10">saved to vault</span>}
                        </div>
                        {preview && <p className="text-xs text-cream-300/70 mt-0.5 line-clamp-1">{preview}</p>}
                        <div className="text-[11px] text-cream-300/50 mt-0.5 font-mono">{new Date(j.startedAt).toLocaleString()} · {j.status}</div>
                      </button>
                      {finishedReport && (
                        <Link to={`/runs/${j.id}`} className="text-[11px] text-violet-400 hover:text-violet-500">open report →</Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <LoadMoreButton state={taskList} noun="runs" />
          </Card>
        </div>

        <div className="col-span-3">
          {focused ? <ResultPanel job={focused} /> : (
            <Card><div className="text-sm text-cream-300/60 text-center py-8">Pick a run to inspect it.</div></Card>
          )}
        </div>
      </div>
    </div>
  );
}

// Compact, expandable quality summary — satisfaction rate + flag counts
// always visible; issue categories, learned weak-axis signals, and the
// list of low-satisfaction personas behind a single expand.
function QualityStrip({ summary, lowQualityRuns, signals, open, onToggle }: { summary: any; lowQualityRuns: LowQualityRun[]; signals: QualitySignal[]; open: boolean; onToggle: () => void }) {
  const satisfactionPct = summary ? Math.round((summary.rate ?? 0) * 100) : 0;
  return (
    <div className="rounded-xl border border-violet-500/20 bg-violet-500/5">
      <button type="button" onClick={onToggle} className="w-full flex items-center justify-between gap-3 p-3 text-left">
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <BarChart3 className="w-4 h-4 text-violet-300 shrink-0" />
          <span className="text-cream-100 font-medium">{satisfactionPct}% satisfaction</span>
          <span className="text-cream-300/60">{summary?.totalFlags ?? 0} flags</span>
          <span className="inline-flex items-center gap-1 text-leaf-400"><ThumbsUp className="w-3 h-3" />{summary?.upvotes ?? 0}</span>
          <span className="inline-flex items-center gap-1 text-coral-400"><ThumbsDown className="w-3 h-3" />{summary?.downvotes ?? 0}</span>
          {lowQualityRuns.length > 0 && <span className="text-coral-300">{lowQualityRuns.length} persona{lowQualityRuns.length === 1 ? "" : "s"} below threshold</span>}
        </div>
        <span className="text-cream-300/50 text-xs shrink-0">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3 text-xs">
          {summary?.topCategories?.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-cream-300/60 mb-1.5">Top issue categories</div>
              <div className="space-y-1">
                {summary.topCategories.map((c: any) => (
                  <div key={c.category} className="flex items-center justify-between">
                    <span className="capitalize text-cream-200">{c.category}</span>
                    <span className="text-cream-300/60">{c.count} flags</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {signals.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-cream-300/60 mb-1.5">Learned weak axes (fed back into planning)</div>
              <div className="space-y-1">
                {signals.map(s => (
                  <div key={`${s.scope}:${s.key}`} className="flex items-center justify-between gap-3">
                    <span className="text-cream-200 truncate">{s.key} <span className="text-cream-300/50">({s.scope === "kind" ? "task type" : "persona"} · {s.samples} runs)</span></span>
                    <span className="px-2 py-0.5 rounded bg-violet-500/20 text-violet-200 shrink-0">weak: {AXIS_LABEL[s.weakestAxis] ?? s.weakestAxis} ({Math.round(s.weakestGoodness * 100)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {lowQualityRuns.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-cream-300/60 mb-1.5">Below satisfaction threshold</div>
              <div className="space-y-1">
                {lowQualityRuns.map(r => (
                  <div key={r.task} className="flex items-center justify-between">
                    <span className="text-cream-200">{r.task}</span>
                    <span className="text-coral-400">{Math.round(r.rate * 100)}% ({r.count} flags)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// "Waiting on you" — each paused task renders its structured ask as real
// inputs. approval → an Approve button (records "Approved"); everything else →
// a text box. Submitting resumes the loop server-side (continuation job) and
// focuses it so the operator watches the task pick back up.
function WaitingOnYouPanel({ waiting, onResumed }: { waiting: WaitingTask[]; onResumed: (newJobId: string) => void }) {
  return (
    <div className="space-y-3">
      {waiting.map(w => <WaitingCard key={w.id} w={w} onResumed={onResumed} />)}
    </div>
  );
}

function WaitingCard({ w, onResumed }: { w: WaitingTask; onResumed: (newJobId: string) => void }) {
  const [values, setValues] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const waitedMin = Math.max(0, Math.round((Date.now() - new Date(w.waitingSince).getTime()) / 60000));
  const waitedLabel = waitedMin < 60 ? `${waitedMin}m` : waitedMin < 60 * 24 ? `${Math.round(waitedMin / 60)}h` : `${Math.round(waitedMin / 1440)}d`;
  const answered = w.items.filter((_, i) => (values[i] ?? "").trim().length > 0).length;

  const submit = async () => {
    const responses = w.items
      .map((it, i) => ({ prompt: it.prompt, response: (values[i] ?? "").trim() }))
      .filter(r => r.response.length > 0);
    if (responses.length === 0) { setError("Answer at least one item first."); return; }
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.submitHumanInput(w.id, responses);
      onResumed(r.jobId);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <HandHelping className="w-4 h-4 text-amber-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-cream-50 truncate">Waiting on you — {w.title}</div>
            <div className="text-xs text-cream-300/60">
              {w.persona ? `${w.persona} · ` : ""}paused {waitedLabel} ago{w.reason ? ` · ${w.reason}` : ""}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={submitting || answered === 0}
          className="shrink-0 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 px-3 py-1.5 text-xs font-semibold text-ink-900"
        >
          {submitting ? "Resuming…" : `Send & continue${answered > 0 ? ` (${answered}/${w.items.length})` : ""}`}
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {w.items.map((it, i) => (
          <div key={i}>
            <div className="text-xs text-cream-200 mb-1">
              {i + 1}. {it.prompt}
              {it.type !== "answer" && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-amber-400/80">{it.type}</span>}
            </div>
            {it.type === "approval" ? (
              <button
                type="button"
                onClick={() => setValues(v => ({ ...v, [i]: v[i] ? "" : "Approved" }))}
                className={`rounded-md px-3 py-1 text-xs border ${values[i] ? "bg-emerald-600/20 border-emerald-500/50 text-emerald-300" : "border-cream-100/20 text-cream-300 hover:text-cream-100"}`}
              >
                {values[i] ? "✓ Approved" : "Approve"}
              </button>
            ) : (
              <textarea
                value={values[i] ?? ""}
                onChange={e => setValues(v => ({ ...v, [i]: e.target.value }))}
                rows={values[i] && values[i].length > 120 ? 3 : 1}
                placeholder={it.type === "upload" ? "Paste the content here (or a vault/file path)" : it.type === "action" ? "What was done / the outcome" : "Your answer"}
                className="w-full rounded-md bg-ink-900/70 border border-cream-100/10 focus:border-amber-500/50 outline-none px-3 py-1.5 text-xs text-cream-100 placeholder:text-cream-300/40 resize-y"
              />
            )}
          </div>
        ))}
      </div>
      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}
    </div>
  );
}

// Stable type key matching the server's jobTypeKey() so a running job looks up
// the right historical median (strip any "prefix:" from kind; prefer template).
function jobTypeKey(job: any): string {
  const raw = (job.template && String(job.template).trim()) ? String(job.template) : String(job.kind ?? "");
  return raw.replace(/^[^:]+:/, "") || "task";
}

// mm:ss for anything ≥ a minute, else "45s". Compact for chips/rows.
function fmtDur(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}m${s ? ` ${s}s` : ""}`;
}

type EtaInfo = { elapsedSec: number; expectedSec: number | null; remainingSec: number | null; overrun: boolean; pct: number | null; label: string };

// Compute a live ETA for a running job from elapsed time + the historical
// median for its type. Falls back to the global median when the type has too
// few samples, and to elapsed-only when there's no history at all. `stepPct`
// (from the plan's completed steps) is preferred for the bar when available —
// it reflects real progress — with time used as the fallback signal.
function computeEta(job: any, eta: EtaStats | null, now: number, stepPct: number | null): EtaInfo {
  const startedMs = job.startedAt ? new Date(job.startedAt).getTime() : now;
  const elapsedSec = Math.max(0, (now - startedMs) / 1000);
  const typeStat = eta?.byType?.[jobTypeKey(job)];
  // Trust a per-type median once it has ≥2 samples; otherwise use the global.
  const expectedMs = typeStat && typeStat.count >= 2 ? typeStat.medianMs
    : (eta?.globalMedianMs && eta.globalMedianMs > 0 ? eta.globalMedianMs : null);
  const expectedSec = expectedMs != null ? expectedMs / 1000 : null;
  const timeRemainingSec = expectedSec != null ? Math.max(0, expectedSec - elapsedSec) : null;
  // Project remaining time from REAL step progress when we have it. The
  // historical median consistently over-promises — tasks finish faster than it
  // predicts, so a pure median countdown showed "~30s left" on a job about to
  // complete (the bar was near-full while the timer still ran). elapsed × (100−pct)/pct
  // is the time left at the current pace. Take the SMALLER of the step and median
  // estimates: early on (few steps done) the median dominates; as steps complete
  // the step projection shrinks and wins, so the countdown converges to done and
  // stays aligned with the progress bar.
  const p = stepPct != null ? Math.min(99, Math.max(1, stepPct)) : null;
  const stepRemainingSec = p != null && p >= 5 ? Math.max(0, elapsedSec * (100 - p) / p) : null;
  const remainingSec = stepRemainingSec != null && timeRemainingSec != null
    ? Math.min(stepRemainingSec, timeRemainingSec)
    : (stepRemainingSec ?? timeRemainingSec);
  const overrun = expectedSec != null && elapsedSec > expectedSec + 1 && (stepPct == null || stepPct < 90);
  const timePct = expectedSec != null ? Math.min(99, Math.round((elapsedSec / expectedSec) * 100)) : null;
  const pct = stepPct != null ? stepPct : timePct;
  let label: string;
  if (remainingSec == null) label = `running ${fmtDur(elapsedSec)}`;
  else if (remainingSec <= 1.5) label = `${fmtDur(elapsedSec)} elapsed · wrapping up`;
  else if (overrun) label = `running ${fmtDur(elapsedSec)} · a bit longer than usual`;
  else label = `${fmtDur(elapsedSec)} elapsed · ~${fmtDur(remainingSec)} left`;
  return { elapsedSec, expectedSec, remainingSec, overrun, pct, label };
}

// Plain-English phase label. Translates the agent's internal phase/state
// into something the operator would say if they were doing the work themselves.
function friendlyPhase(job: any): string {
  if (job.status === "succeeded") return "Done";
  if (job.status === "failed") {
    // Classify the failure shape from the error text so the user sees what
    // KIND of problem it was (transient vs auth vs vault-unreachable vs
    // unsupported) rather than the cryptic "Hit a snag". The full error
    // stays below in the technical view; this label scopes the retry choice.
    const e = String(job.error ?? "").toLowerCase();
    const hasPartial = typeof job.result?.answer === "string" && job.result.answer.trim().length > 0;
    if (hasPartial) return "Finished with partial results";
    if (!e) return "Couldn't complete this task";
    if (/vault.*unreach|vaultpath|mkdir.*enoent|d:\\\\main brain/.test(e)) return "Couldn't reach your vault";
    if (/\b(?:401|403|unauthori[sz]ed|forbidden|api key|missing.*token)\b/.test(e)) return "Authorisation problem";
    if (/\b(?:econnreset|etimedout|enotfound|eai_again|fetch failed|socket hang up|timeout)\b/.test(e)) return "Network hiccup, retry";
    if (/\b(?:429|rate.?limit|too many requests)\b/.test(e)) return "Rate-limited";
    if (/cannot read properties of undefined/.test(e)) return "Internal error, retry";
    if (/no such tool|invalid tool|unknown tool/.test(e)) return "Couldn't route this, try rephrasing";
    return "Couldn't complete this task";
  }
  if (job.status === "rejected") return "Rejected";
  if (job.status === "awaiting-approval") return "Waiting for your approval";
  if (job.status === "waiting_on_human") return "Paused — needs something from you (see the amber card above)";
  if (job.status !== "running" && job.status !== "pending") return job.status;
  const r = job.result ?? {};
  const phase = r.phase as string | undefined;
  const totalSteps = r.plan?.steps?.length ?? 0;
  const runs: any[] = r.runs ?? [];
  const doneCount = runs.filter((x: any) => x?.ok === true).length;
  const inflightCount = runs.filter((x: any) => x && x.startedAt && x.ok === false && !x.error).length;
  if (phase === "planning") return "Working out a plan";
  if (phase === "executing") {
    if (inflightCount > 1) return `${inflightCount} sub-agents working in parallel`;
    if (totalSteps > 0) return `On step ${doneCount + 1} of ${totalSteps}`;
    return "Working on it";
  }
  if (phase === "synthesizing") return "Drafting your answer";
  if (phase === "reviewing") return "Reviewing the draft";
  if (phase === "answering") return "Answering directly";
  return "Working on it";
}

// What kind of work is this? Used in the list row + activity strip so the
// user sees "Research" / "Chat task" / "Daily digest" instead of the raw
// `kind` ("insights:general-task").
function friendlyKind(job: any): string {
  const t = String(job.template ?? job.kind ?? "");
  if (t.startsWith("custom-")) return "Saved template";
  if (t === "general-task" || t.endsWith(":general-task")) return "Chat task";
  if (t === "peer:delegate") return "Delegated work";
  if (t === "summarize-repo" || t.endsWith(":summarize-repo")) return "Project summary";
  if (t === "search-brain" || t.endsWith(":search-brain")) return "Vault search";
  if (t === "add-note" || t.endsWith(":add-note")) return "Note capture";
  if (t === "run-digest" || t.endsWith(":run-digest")) return "Daily digest";
  if (t === "sync-downloads" || t.endsWith(":sync-downloads")) return "Downloads sync";
  if (t === "publish-folder" || t.endsWith(":publish-folder")) return "Folder publish";
  if (t === "browse-vault" || t.endsWith(":browse-vault")) return "Vault browse";
  return t || "Task";
}

function friendlyTitle(job: any): string {
  const t = (job.title ?? "").replace(/^Ad-hoc:\s*/i, "").trim();
  return t || friendlyKind(job);
}

// Operator-friendly relative time. "2 minutes ago" reads better than a full
// ISO timestamp on a card the operator just opened.
function friendlyTimeAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Compact horizontal strip at the top of the page showing every running
// task with its live phase + step count. Lets the operator glance at the page
// and immediately know "the workforce is doing X right now". Each card
// opens the Board view focused on that job.
function LiveActivityStrip({ jobs, eta, now, onOpenActivity, onOpenJob, onCancel }: { jobs: any[]; eta: EtaStats | null; now: number; onOpenActivity: (jobId: string) => void; onOpenJob: (jobId: string) => void; onCancel: (jobId: string) => void }) {
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  return (
    <div className="bg-violet-500/10 border border-violet-500/30 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
        <span className="text-[10px] uppercase tracking-wider text-violet-300/80">Working now</span>
        <span className="text-[11px] text-cream-300/60">{jobs.length} active task{jobs.length === 1 ? "" : "s"}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {jobs.map(j => {
          const r = j.result ?? {};
          const totalSteps = r.plan?.steps?.length ?? 0;
          const runs: any[] = r.runs ?? [];
          const doneCount = runs.filter((x: any) => x?.ok === true).length;
          const stepPct = totalSteps > 0 ? Math.round((doneCount / totalSteps) * 100) : null;
          const peerName = r.peer?.name ?? r.delegatedPeer?.name ?? null;
          const info = computeEta(j, eta, now, stepPct);
          return (
            <div
              key={j.id}
              onClick={() => onOpenJob(j.id)}
              className="relative text-left bg-ink-900 border border-ink-800 hover:border-violet-500/40 rounded-lg p-3 transition-colors cursor-pointer"
            >
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onOpenActivity(j.id); }}
                className="absolute top-2 right-2 text-[10px] text-violet-300/80 hover:text-violet-200 inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-violet-500/10"
                title="Open the step-by-step activity view"
              >
                <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4h6v6H4zM14 14h6v6h-6zM14 4h6v6h-6zM4 14h6v6H4z" /></svg>
                Activity
              </button>
              <div className="text-sm text-cream-50 truncate pr-16">{friendlyTitle(j)}</div>
              <div className="text-[11px] text-cream-300/70 mt-1">{friendlyPhase(j)}</div>
              {info.pct != null && (
                <div className="mt-2 h-1 bg-ink-800 rounded-full overflow-hidden">
                  <div className={`h-full transition-all ${info.overrun ? "bg-amber-500/80" : "bg-gradient-to-r from-violet-500 to-leaf-500"}`} style={{ width: `${info.pct}%` }} />
                </div>
              )}
              <div className={`mt-1.5 text-[10px] ${info.overrun ? "text-amber-300/90" : "text-violet-300/80"}`}>{info.label}</div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-cream-300/50 flex-wrap">
                <span>{friendlyKind(j)}</span>
                {peerName && <><span>·</span><span>on {peerName}</span></>}
                {totalSteps > 0 && <><span>·</span><span>{doneCount}/{totalSteps} done</span></>}
              </div>
              <button
                type="button"
                disabled={cancelling[j.id]}
                onClick={async e => {
                  e.stopPropagation();
                  setCancelling(c => ({ ...c, [j.id]: true }));
                  try { await onCancel(j.id); } finally { setCancelling(c => ({ ...c, [j.id]: false })); }
                }}
                className="mt-2 w-full inline-flex items-center justify-center gap-1.5 text-[11px] rounded-md border border-coral-500/40 text-coral-300 hover:bg-coral-500/10 hover:border-coral-500/60 py-1 transition-colors disabled:opacity-50"
                title="Stop this run"
              >
                <Square size={11} /> {cancelling[j.id] ? "Cancelling…" : "Cancel run"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// RunDetail — the polished per-job document (was Results.tsx's `Results`).
// Kept essentially as-is: title, the answer rendered as a real document,
// outcomes, sources, QA summary, and a collapsible "how this was done" trace.
// ─────────────────────────────────────────────────────────────────────────
export function RunDetail() {
  const { jobId } = useParams();
  const [job, setJob] = useState<any>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    let timer: any;
    async function tick() {
      try {
        const j = await api.getJob(jobId!);
        if (!alive) return;
        setJob(j);
        if (j.status === "succeeded" || j.status === "failed" || j.status === "rejected") return;
      } catch (e: any) { if (alive) setErr(e.message); }
      timer = setTimeout(tick, 2000);
    }
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [jobId]);

  if (!jobId) return <div className="text-sm text-cream-300/60">Missing job id.</div>;
  if (err) return <div className="text-sm text-coral-400">{err}</div>;
  if (!job) return <div className="text-sm text-cream-300/60">Loading…</div>;

  const r = job.result ?? {};
  const isPending = job.status === "running" || job.status === "pending";
  const isFailed = job.status === "failed" || job.status === "rejected";
  const answer = r.answer ?? r.partialAnswer ?? "";
  const persona = job.inputs?.activePersona ?? r.activePersona;
  const personaName = (persona && (persona.name ?? persona.id)) ?? "Naxie";
  const startedAt = job.startedAt ? new Date(job.startedAt) : null;
  const finishedAt = job.finishedAt ? new Date(job.finishedAt) : null;
  const durationSec = startedAt && finishedAt
    ? Math.max(1, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000))
    : null;

  return (
    <article className="max-w-5xl mx-auto -my-2 pb-16">
      <header className="border-b border-ink-800 pb-6 mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Link to="/runs" className="text-[11px] text-cream-300/60 hover:text-cream-300 uppercase tracking-wider">← Runs</Link>
          <span className="text-cream-300/30">/</span>
          <span className="text-[11px] text-cream-300/60 uppercase tracking-wider font-mono">{job.id.slice(0, 8)}</span>
        </div>
        <h1 className="font-display text-4xl text-cream-50 leading-tight">{cleanTitle(job.title) || "Result"}</h1>
        <Meta job={job} personaName={personaName} durationSec={durationSec} startedAt={startedAt} />
        {isPending && <PendingBadge job={job} />}
        {isFailed && <FailedBadge job={job} />}
      </header>

      {answer ? (
        <PolishedAnswer markdown={answer} />
      ) : !isPending ? (
        <EmptyAnswer job={job} />
      ) : null}

      {/* Voice: talk the report through with the employee who wrote it.
          Only once there's a finished answer to ground the conversation. */}
      {answer && job.status === "succeeded" && (
        <VoiceDiscussion jobId={job.id} personaId={persona?.id} personaName={personaName} />
      )}

      {!isPending && (
        <>
          <Outcomes runs={r.runs ?? []} curation={r.curation} />
          <Sources runs={r.runs ?? []} />
          <QASummary review={r.review} quality={r.quality} security={r.security} curation={r.curation} />
          {/* Technical detail — hidden behind a single expand so the
              operator-facing view is the answer + outcomes + sources, not
              a wall of timing bars and tool names. Power users still get
              everything one click away. */}
          <HowThisWasDone job={job} />
        </>
      )}
    </article>
  );
}

// Outcomes — the most important "what actually changed" section. Walks the
// runs and surfaces every tangible artifact the agent produced: vault notes
// captured, files modified, issues opened, downloads written. This is the
// answer to "did it work?" — separate from the prose answer (which is the
// answer to "what's the story?").
function Outcomes({ runs, curation }: { runs: any[]; curation?: any }) {
  const items = useMemo(() => extractOutcomes(runs, curation), [runs, curation]);
  const [vaultStats, setVaultStats] = useState<any>(null);
  const [retry, setRetry] = useState<"idle" | "running" | "ok" | "fail">("idle");
  const hasVaultWrite = items.some(it => it.kind === "write" || it.kind === "capture");
  useEffect(() => {
    if (!hasVaultWrite) return;
    api.vaultStats().then(setVaultStats).catch(() => {});
  }, [hasVaultWrite]);
  if (items.length === 0) return null;
  const lc = vaultStats?.lastCommit;
  const pushPending = lc && lc.ok === true && lc.pushed === false;
  async function retryPush() {
    setRetry("running");
    try {
      const r = await api.vaultRetryPush();
      setRetry(r.pushed ? "ok" : "fail");
      if (r.pushed) setVaultStats((s: any) => s ? { ...s, lastCommit: { ...s.lastCommit, pushed: true } } : s);
    } catch { setRetry("fail"); }
  }
  return (
    <section className="mt-10">
      <h2 className="font-display text-xl text-cream-50 mb-3">Outcomes</h2>
      {pushPending && (
        <div className="mb-3 text-[11px] text-flame-400 bg-flame-500/10 border border-flame-500/30 rounded-md px-3 py-2 flex items-center gap-2 flex-wrap">
          <span>⚠ Saved locally — origin push hasn't completed yet.</span>
          <button onClick={retryPush} disabled={retry === "running"} className="underline hover:text-flame-300 disabled:opacity-50">
            {retry === "running" ? "Retrying…" : "Retry push →"}
          </button>
          {retry === "ok" && <span className="text-leaf-400">✓ synced</span>}
          {retry === "fail" && <span className="text-coral-400">push failed — try again</span>}
        </div>
      )}
      <ul className="space-y-3">
        {items.map((it, i) => <OutcomeCard key={i} item={it} pushPending={pushPending} />)}
      </ul>
    </section>
  );
}

// Deep, expandable outcome card. The headline (icon + label + detail + link)
// is always visible; clicking expands a per-outcome detail panel showing
// every source the underlying tool touched and any artifact bodies. The aim
// is to make RunDetail the canonical "what happened" record so the user
// never has to switch back to the Runs list to dig into a sub-agent's work.
function OutcomeCard({ item, pushPending }: { item: Outcome; pushPending: boolean }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!item.expanded;
  return (
    <li className={`rounded-lg border ${item.kind === "error" ? "border-coral-500/30 bg-coral-500/5" : "border-ink-800 bg-ink-900"}`}>
      <div className="flex items-start gap-3 p-3">
        <span className="text-lg flex-shrink-0">{item.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-cream-100">{item.label}</span>
            {item.tag && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-cream-300/20 text-cream-300/60">{item.tag}</span>}
            {typeof item.durationMs === "number" && item.durationMs > 0 && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-cream-300/10 text-cream-300/50 font-mono">{formatDuration(item.durationMs)}</span>
            )}
            {pushPending && (item.kind === "write" || item.kind === "capture") && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-flame-500/40 text-flame-400 bg-flame-500/10">local only</span>
            )}
          </div>
          {item.detail && <div className="text-[12px] text-cream-300/70 mt-0.5">{item.detail}</div>}
          {Array.isArray(item.topLinks) && item.topLinks.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {item.topLinks.map((l, j) => (
                <li key={j} className="text-[11px]">
                  {l.external
                    ? <a href={l.href} target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-500 break-all">→ {l.label}</a>
                    : <Link to={l.href} className="text-violet-400 hover:text-violet-500 font-mono break-all">→ {l.label}</Link>}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 flex items-center gap-3 flex-wrap">
            {item.link && (
              <Link to={item.link} className="font-mono text-[11px] text-violet-400 hover:text-violet-500">{item.linkLabel ?? item.link}</Link>
            )}
            {item.externalUrl && (
              <a href={item.externalUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-[11px] text-violet-400 hover:text-violet-500 break-all">{item.linkLabel ?? item.externalUrl} ↗</a>
            )}
            {hasDetail && (
              <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="text-[11px] text-cream-300/60 hover:text-cream-100 ml-auto"
              >
                {open ? "▾ hide detail" : "▸ show detail"}
              </button>
            )}
          </div>
        </div>
      </div>
      {open && hasDetail && (
        <div className="border-t border-ink-800 px-4 py-3 bg-ink-950/50">
          <OutcomeDetail kind={item.expanded!.kind} payload={item.expanded!.payload} />
        </div>
      )}
    </li>
  );
}

// Renders the detail body for one expanded outcome. Each tool has a dedicated
// renderer so we can show exactly the shape that matters (perspectives for
// multiperspective, source list for research.deep, match list for
// vault.search, repo overview for github, etc.).
function OutcomeDetail({ kind, payload }: { kind: string; payload: any }) {
  if (kind === "multiperspective") {
    const perspectives = payload.perspectiveResults ?? [];
    return (
      <div className="space-y-4">
        {perspectives.map((p: any, i: number) => (
          <div key={i} className="border-l-2 border-violet-500/30 pl-3">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-violet-500/40 bg-violet-500/10 text-violet-300">{p.name}</span>
              <span className="text-[11px] text-cream-300/60 font-mono truncate">query: "{p.query}"</span>
            </div>
            {Array.isArray(p.sources) && p.sources.length > 0 ? (
              <ul className="space-y-1">
                {p.sources.map((s: any, j: number) => (
                  <li key={j} className="text-[12px] flex items-start gap-2">
                    <span className={`mt-1 inline-block w-1 h-1 rounded-full flex-shrink-0 ${s.ok === false ? "bg-coral-500" : "bg-leaf-500"}`} />
                    <div className="min-w-0">
                      {s.ok === false ? (
                        <>
                          <span className="text-coral-400">{s.title || s.url}</span>
                          <div className="text-[11px] text-cream-300/50 font-mono break-all">{s.url}</div>
                          {s.error && <div className="text-[11px] text-coral-400/70 mt-0.5">{s.error}</div>}
                        </>
                      ) : (
                        <>
                          <LinkPreview href={s.url} className="text-violet-400 hover:text-violet-500">{s.title || s.url}</LinkPreview>
                          <div className="text-[11px] text-cream-300/50 font-mono break-all">{s.url}</div>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11px] text-cream-300/40 italic">no reachable sources for this perspective</div>
            )}
          </div>
        ))}
        {Array.isArray(payload.vaultHits) && payload.vaultHits.length > 0 && (
          <div className="border-l-2 border-leaf-500/30 pl-3">
            <div className="text-[10px] uppercase tracking-wider text-leaf-400 mb-1.5">Vault context ({payload.vaultHits.length})</div>
            <ul className="space-y-0.5">
              {payload.vaultHits.slice(0, 8).map((h: any, i: number) => (
                <li key={i} className="text-[12px]">
                  <Link to={`/knowledge/${h.path}`} className="text-violet-400 hover:text-violet-500 font-mono">{h.path}:{h.line}</Link>
                  <span className="text-cream-300/60 ml-2">{h.preview}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  if (kind === "research.deep") {
    return (
      <div className="space-y-3">
        {Array.isArray(payload.webSources) && payload.webSources.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-cream-300/60 mb-1.5">Web sources fetched ({payload.webSources.length})</div>
            <ul className="space-y-1">
              {payload.webSources.map((w: any, i: number) => (
                <li key={i} className="text-[12px] flex items-start gap-2">
                  <span className={`mt-1 inline-block w-1 h-1 rounded-full flex-shrink-0 ${w.ok === false ? "bg-coral-500" : "bg-leaf-500"}`} />
                  <div className="min-w-0">
                    {w.ok === false ? (
                      <span className="text-coral-400">{w.title || w.url}</span>
                    ) : (
                      <LinkPreview href={w.url} className="text-violet-400 hover:text-violet-500">{w.title || w.url}</LinkPreview>
                    )}
                    <div className="text-[11px] text-cream-300/50 font-mono break-all">{w.url}</div>
                    {w.error && <div className="text-[11px] text-coral-400/70 mt-0.5">{w.error}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {Array.isArray(payload.vaultHits) && payload.vaultHits.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-cream-300/60 mb-1.5">Vault hits ({payload.vaultHits.length})</div>
            <ul className="space-y-0.5">
              {payload.vaultHits.map((h: any, i: number) => (
                <li key={i} className="text-[12px]">
                  <Link to={`/knowledge/${h.path}`} className="text-violet-400 hover:text-violet-500 font-mono">{h.path}:{h.line}</Link>
                  <span className="text-cream-300/60 ml-2">{h.preview}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  if (kind === "vault.search") {
    return (
      <ul className="space-y-1.5">
        {(payload.matches ?? []).map((m: any, i: number) => (
          <li key={i} className="text-[12px]">
            <Link to={`/knowledge/${m.path}`} className="text-violet-400 hover:text-violet-500 font-mono">{m.path}:{m.line}</Link>
            <div className="text-cream-300/70">{m.preview}</div>
          </li>
        ))}
      </ul>
    );
  }
  if (kind === "github.read_repo") {
    return (
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <div><span className="text-cream-300/50">Commits:</span> <span className="text-cream-100">{(payload.commits ?? []).length}</span></div>
        <div><span className="text-cream-300/50">Open PRs:</span> <span className="text-cream-100">{(payload.prs ?? []).length}</span></div>
        <div><span className="text-cream-300/50">Open issues:</span> <span className="text-cream-100">{(payload.issues ?? []).length}</span></div>
        <div><span className="text-cream-300/50">README size:</span> <span className="text-cream-100">{payload.readme ? `${payload.readme.length.toLocaleString()} chars` : "none"}</span></div>
      </div>
    );
  }
  if (kind === "web.search") {
    return (
      <ul className="space-y-1">
        {(payload.results ?? []).map((w: any, i: number) => (
          <li key={i} className="text-[12px]">
            <LinkPreview href={w.url} className="text-violet-400 hover:text-violet-500">{w.title}</LinkPreview>
            <div className="text-[11px] text-cream-300/50 font-mono break-all">{w.url}</div>
            {w.snippet && <div className="text-[11px] text-cream-300/70 mt-0.5">{w.snippet}</div>}
          </li>
        ))}
      </ul>
    );
  }
  if (kind === "peer.delegate") {
    return (
      <div className="text-[12px] space-y-1">
        <div><span className="text-cream-300/50">Peer:</span> <span className="text-cream-100">{payload.peer?.name ?? payload.peer?.url}</span></div>
        {payload.peer?.model && <div><span className="text-cream-300/50">Model:</span> <span className="font-mono text-cream-100">{payload.peer.model}</span></div>}
        {payload.elapsedMs && <div><span className="text-cream-300/50">Round-trip:</span> <span className="text-cream-100">{(payload.elapsedMs / 1000).toFixed(1)}s</span></div>}
        {payload.jobId && <div><span className="text-cream-300/50">Peer jobId:</span> <span className="font-mono text-cream-100">{payload.jobId}</span></div>}
      </div>
    );
  }
  if (kind === "curation") {
    // Show why the primary decided to capture: per-axis quality numbers,
    // security findings, the rooting breakdown, and any quality issues
    // raised by the scorer.
    const q = payload.quality;
    const s = payload.security;
    const rooted = payload.rooted ?? {};
    return (
      <div className="space-y-3 text-[12px]">
        {q && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-cream-300/60 mb-1.5 flex items-center gap-1.5">
              Quality gate
              {q.graderUsed && (
                <span className={`normal-case tracking-normal px-1.5 py-0.5 rounded-full text-[10px] ${q.graderUsed === "jev" ? "bg-violet-500/15 text-violet-300" : "bg-ink-800 text-cream-300/50"}`} title={q.graderUsed === "jev" ? "Graded by Jev (fast typed judgment)" : "Graded by the LLM grader"}>
                  {q.graderUsed}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Metric label="Score" value={q.score != null ? Math.round(q.score * 100) + "%" : "n/a"} good={q.pass} />
              <Metric label="Factuality risk" value={Math.round((q.factuality_risk ?? 0) * 100) + "%"} good={(q.factuality_risk ?? 0) < 0.4} invert />
              <Metric label="Citation cov." value={Math.round((q.citation_coverage ?? 0) * 100) + "%"} good={(q.citation_coverage ?? 0) > 0.4} />
            </div>
            {Array.isArray(q.issues) && q.issues.length > 0 && (
              <ul className="list-disc pl-5 mt-2 text-cream-200 text-[12px] space-y-0.5">
                {q.issues.map((iss: string, i: number) => <li key={i}>{iss}</li>)}
              </ul>
            )}
          </div>
        )}
        {s && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-cream-300/60 mb-1.5">Security scan</div>
            {(s.findings ?? []).length === 0 ? (
              <div className="text-leaf-400">Clean — no findings.</div>
            ) : (
              <ul className="space-y-0.5">
                {(s.findings ?? []).slice(0, 8).map((f: any, i: number) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={`mt-1 inline-block w-1 h-1 rounded-full flex-shrink-0 ${f.severity === "high" ? "bg-coral-500" : f.severity === "medium" ? "bg-flame-500" : "bg-cream-300/40"}`} />
                    <span><span className="font-mono text-cream-100">{f.type}</span> <span className="text-cream-300/60">· {f.reason}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-cream-300/60 mb-1.5">Context rooting</div>
          <div className="grid grid-cols-3 gap-3">
            <Metric label="Vault refs" value={rooted.vaultCitations ?? 0} good={(rooted.vaultCitations ?? 0) > 0} />
            <Metric label="Web sources" value={rooted.webSources ?? 0} good={(rooted.webSources ?? 0) > 0} />
            <Metric label="GitHub refs" value={rooted.githubRefs ?? 0} good={(rooted.githubRefs ?? 0) > 0} />
          </div>
          {Array.isArray(rooted.reasons) && rooted.reasons.length > 0 && (
            <ul className="list-disc pl-5 mt-2 text-cream-300/70 space-y-0.5">
              {rooted.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}
            </ul>
          )}
        </div>
        {!payload.captured && payload.reason && (
          <div className="text-flame-400 bg-flame-500/10 border border-flame-500/30 rounded-md px-3 py-2">
            <span className="text-[10px] uppercase tracking-wider mr-2">Not captured</span>
            {payload.reason}
          </div>
        )}
      </div>
    );
  }
  // Generic fallback — show the raw shape so power users can debug.
  return (
    <pre className="text-[10px] font-mono text-cream-300/60 whitespace-pre-wrap max-h-48 overflow-auto scrollbar-thin">{JSON.stringify(payload, null, 2)}</pre>
  );
}

function Metric({ label, value, good, invert }: { label: string; value: any; good?: boolean; invert?: boolean }) {
  const tone = good == null ? "text-cream-100" : good ? "text-leaf-400" : invert ? "text-coral-400" : "text-flame-400";
  return (
    <div className="bg-ink-950 border border-ink-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-cream-300/50">{label}</div>
      <div className={`font-display text-base ${tone}`}>{value}</div>
    </div>
  );
}

type Outcome = {
  kind: "write" | "capture" | "fetch" | "issue" | "promote" | "error" | "research" | "search" | "delegate";
  icon: string;
  label: string;
  detail?: string;
  link?: string;
  linkLabel?: string;
  externalUrl?: string;
  tag?: string;
  // Duration the sub-agent took to produce this outcome, in milliseconds.
  // Surfaced as a small badge so bosses can see WHERE the time went without
  // expanding "How this was done".
  durationMs?: number;
  // Up to 3 inline links to the most relevant artifacts (top vault matches,
  // top web sources) — gives the exec a one-glance preview of the evidence
  // without having to expand the card. Skipped on outcomes where headline +
  // detail + link already say everything (e.g. "Opened issue #42").
  topLinks?: { label: string; href: string; external?: boolean }[];
  // When present, the card becomes expandable — `OutcomeDetail` renders the
  // payload using the kind-specific renderer (perspective list, source list,
  // match list, etc.). Lets RunDetail be the complete record without forcing
  // the user back to the list for tool-level depth.
  expanded?: { kind: string; payload: any };
};

// Format ms as a compact, exec-friendly duration. Sub-second → "ms",
// otherwise seconds with one decimal, otherwise minutes + seconds.
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem > 0 ? ` ${rem}s` : ""}`;
}

function extractOutcomes(runs: any[], curation?: any): Outcome[] {
  const out: Outcome[] = [];
  // The primary's curation capture lands first — it's the headline outcome
  // when a worker peer ran the task.
  if (curation?.captured && curation.path) {
    out.push({
      kind: "capture",
      icon: "📥",
      label: "Captured to vault",
      detail: `Quality ${curation.quality?.score != null ? Math.round(curation.quality.score * 100) + "%" : "n/a"} · ${curation.rooted?.vaultCitations ?? 0} vault refs, ${curation.rooted?.webSources ?? 0} web sources`,
      link: `/knowledge/${curation.path}`,
      linkLabel: curation.path,
      tag: "curated",
      expanded: { kind: "curation", payload: curation },
    });
  }
  for (const r of runs) {
    if (!r || !r.step) continue;
    const tool = r.step.tool;
    const args = r.step.args ?? {};
    const result = r.result ?? {};
    const durationMs = typeof r.durationMs === "number" ? r.durationMs : undefined;
    if (!r.ok) {
      out.push({
        kind: "error",
        icon: "✗",
        label: `${tool} failed`,
        detail: r.error?.slice(0, 200),
        durationMs,
      });
      continue;
    }
    if (tool === "vault.write" || tool === "vault.append") {
      const p = String(result.written ?? result.appended ?? args.path ?? "");
      if (p) out.push({
        kind: "write",
        icon: tool === "vault.append" ? "✎" : "📝",
        label: tool === "vault.append" ? "Appended to note" : "Wrote new note",
        link: `/knowledge/${p}`,
        linkLabel: p,
        durationMs,
      });
    } else if (tool === "vault.create_zettel") {
      const p = String(result.path ?? "");
      if (p) out.push({
        kind: "write",
        icon: "🗂",
        label: "Created zettel",
        detail: result.id ? `Zettel id ${result.id}` : undefined,
        link: `/knowledge/${p}`,
        linkLabel: p,
        tag: "permanent",
        durationMs,
      });
    } else if (tool === "research.deep") {
      const okSources = (result.webSources ?? []).filter((s: any) => s.ok !== false);
      const topLinks: Outcome["topLinks"] = [
        ...okSources.slice(0, 2).map((s: any) => ({
          label: (s.title || s.url || "source").slice(0, 90),
          href: String(s.url ?? ""),
          external: true,
        })),
        ...(result.vaultHits ?? []).slice(0, 1).map((h: any) => ({
          label: `${h.path}:${h.line}`,
          href: `/knowledge/${h.path}`,
          external: false,
        })),
      ].filter((l: any) => l.href);
      const headline = result.captured?.path
        ? {
            kind: "capture" as const,
            icon: "🔬",
            label: "Research note captured",
            detail: `${result.vaultHits?.length ?? 0} vault hits · ${okSources.length} web sources cited`,
            link: `/knowledge/${result.captured.path}`,
            linkLabel: result.captured.path,
            tag: "inbox",
          }
        : {
            kind: "research" as const,
            icon: "🔬",
            label: `Researched "${args.query ?? "topic"}"`,
            detail: `${result.vaultHits?.length ?? 0} vault hits · ${okSources.length} web sources cited`,
          };
      out.push({ ...headline, durationMs, topLinks, expanded: { kind: "research.deep", payload: result } });
    } else if (tool === "research.multiperspective") {
      const persStr = Array.isArray(result.perspectives) ? result.perspectives.join(", ") : "";
      const headline = result.captured?.path
        ? {
            kind: "capture" as const,
            icon: "🧭",
            label: "Multi-perspective report captured",
            detail: `${(result.perspectives ?? []).length} perspective${(result.perspectives ?? []).length === 1 ? "" : "s"} (${persStr}) · ${result.sourceCount ?? 0} cited source${result.sourceCount === 1 ? "" : "s"}`,
            link: `/knowledge/${result.captured.path}`,
            linkLabel: result.captured.path,
            tag: "research",
          }
        : {
            kind: "research" as const,
            icon: "🧭",
            label: `Multi-perspective: "${args.topic ?? "topic"}"`,
            detail: `${persStr} · ${result.sourceCount ?? 0} sources`,
            tag: "research",
          };
      out.push({ ...headline, durationMs, expanded: { kind: "multiperspective", payload: result } });
    } else if (tool === "vault.search") {
      const matches = result.matches ?? [];
      const n = matches.length;
      const topLinks: Outcome["topLinks"] = matches.slice(0, 3).map((m: any) => ({
        label: `${m.path}:${m.line}`,
        href: `/knowledge/${m.path}`,
        external: false,
      }));
      out.push({
        kind: "search",
        icon: "🔎",
        label: `Searched vault: "${args.query ?? "?"}"`,
        detail: `${n} match${n === 1 ? "" : "es"}`,
        durationMs,
        topLinks,
        expanded: n > 0 ? { kind: "vault.search", payload: result } : undefined,
      });
    } else if (tool === "web.search") {
      const results = result.results ?? [];
      const n = results.length;
      const topLinks: Outcome["topLinks"] = results.slice(0, 3).map((s: any) => ({
        label: (s.title || s.url || "result").slice(0, 90),
        href: String(s.url ?? ""),
        external: true,
      })).filter((l: any) => l.href);
      out.push({
        kind: "search",
        icon: "🌐",
        label: `Searched the web: "${args.query ?? "?"}"`,
        detail: `${n} result${n === 1 ? "" : "s"}`,
        durationMs,
        topLinks,
        expanded: n > 0 ? { kind: "web.search", payload: result } : undefined,
      });
    } else if (tool === "github.read_repo") {
      out.push({
        kind: "fetch",
        icon: "🐙",
        label: `Read ${args.owner}/${args.name}`,
        detail: `${(result.commits ?? []).length} commits · ${(result.prs ?? []).length} PRs · ${(result.issues ?? []).length} open issues`,
        externalUrl: `https://github.com/${args.owner}/${args.name}`,
        linkLabel: `${args.owner}/${args.name}`,
        durationMs,
        expanded: { kind: "github.read_repo", payload: result },
      });
    } else if (tool === "github.get_file") {
      out.push({
        kind: "fetch",
        icon: "📄",
        label: `Fetched ${args.path} from ${args.name}`,
        detail: result.size != null ? `${result.size.toLocaleString()} bytes` : undefined,
        externalUrl: `https://github.com/${args.owner}/${args.name}/blob/HEAD/${args.path}`,
        linkLabel: `${args.owner}/${args.name}/${args.path}`,
        durationMs,
      });
    } else if (tool === "github.create_issue" && result.url) {
      out.push({
        kind: "issue",
        icon: "🐛",
        label: `Opened issue #${result.number}`,
        externalUrl: result.url,
        linkLabel: result.url,
        durationMs,
      });
    } else if (tool === "web.scrape" && args.screenshot && result.screenshotPath) {
      out.push({
        kind: "write",
        icon: "📸",
        label: "Screenshot saved",
        link: `/knowledge/${result.screenshotPath}`,
        linkLabel: String(result.screenshotPath),
        durationMs,
      });
    } else if (tool === "web.scrape" || tool === "web.fetch") {
      out.push({
        kind: "fetch",
        icon: "🌐",
        label: tool === "web.scrape" ? "Scraped a page" : "Fetched a page",
        detail: result.status ? `HTTP ${result.status} · ${(result.text?.length ?? 0).toLocaleString()} chars` : undefined,
        externalUrl: String(args.url ?? ""),
        linkLabel: String(args.url ?? ""),
        durationMs,
      });
    } else if (tool === "peer.delegate") {
      out.push({
        kind: "delegate",
        icon: "🤝",
        label: `Delegated to ${result.peer?.name ?? "peer"}`,
        detail: result.peer?.model ? `${result.peer.model}${result.elapsedMs ? ` · ${(result.elapsedMs / 1000).toFixed(1)}s` : ""}` : undefined,
        durationMs,
        expanded: { kind: "peer.delegate", payload: result },
      });
    } else if (tool === "peer.review" && result.verdict) {
      out.push({
        kind: "delegate",
        icon: "👀",
        label: `Peer review: ${result.verdict}`,
        detail: result.peer?.name ? `by ${result.peer.name}` : undefined,
        durationMs,
      });
    }
  }
  return out;
}

function Meta({ job, personaName, durationSec, startedAt }: { job: any; personaName: string; durationSec: number | null; startedAt: Date | null }) {
  const r = job.result ?? {};
  const peerName = r.peer?.name;
  // Operator-friendly one-liner: "By Maya · Took 2 minutes · 3 hours ago".
  // Beats a 4-column grid of "Persona / Run on peer / Started / Duration"
  // with mono timestamps — that's an engineer's view, not the operator's.
  const bits: string[] = [];
  bits.push(`By **${personaName}**`);
  if (peerName && peerName !== personaName) bits.push(`on **${peerName}**`);
  if (durationSec != null) {
    bits.push(`took ${durationSec >= 60 ? `${Math.round(durationSec / 60)} min${Math.round(durationSec / 60) !== 1 ? "s" : ""}` : `${durationSec}s`}`);
  }
  if (startedAt) bits.push(friendlyTimeAgo(startedAt));
  return (
    <div className="mt-3 text-sm text-cream-300/80" dangerouslySetInnerHTML={{ __html: bits.join(" · ").replace(/\*\*(.+?)\*\*/g, "<span class='text-cream-100 font-medium'>$1</span>") }} />
  );
}

function PendingBadge({ job }: { job: any }) {
  const phase = job.result?.phase as string | undefined;
  const label = phase === "planning" ? "Working out a plan"
    : phase === "executing" ? "Running steps"
    : phase === "synthesizing" ? "Drafting the report"
    : phase === "reviewing" ? "Quality review"
    : "Working";
  return (
    <div className="mt-4 inline-flex items-center gap-2 text-xs text-violet-400 bg-violet-500/10 border border-violet-500/30 rounded-full px-3 py-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
      {label}…
    </div>
  );
}

function FailedBadge({ job }: { job: any }) {
  const label = job.status === "rejected" ? "Rejected" : "This task didn't finish";
  return (
    <div className="mt-4 inline-flex items-center gap-2 text-xs text-coral-400 bg-coral-500/10 border border-coral-500/30 rounded-full px-3 py-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-coral-500" />
      {label}{job.error ? ` — ${job.error.slice(0, 100)}` : ""}
    </div>
  );
}

function PolishedAnswer({ markdown }: { markdown: string }) {
  const html = useMemo(() => marked.parse(markdown, { gfm: true, breaks: false }) as string, [markdown]);
  return (
    <section className="prose-vault prose-result text-cream-100 leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function EmptyAnswer({ job }: { job: any }) {
  return (
    <section className="text-sm text-cream-300/60 italic">
      No written answer was produced.{job.error ? ` Error: ${job.error}` : ""}
    </section>
  );
}

// Collapsible "How this was done" section. Wraps the technical sub-agent
// timings + the full process trace. Closed by default — the operator comes for
// the answer, not the plumbing. Power users get one click to expand.
function HowThisWasDone({ job }: { job: any }) {
  const [open, setOpen] = useState(false);
  const r = job.result ?? {};
  const stepCount = r.plan?.steps?.length ?? 0;
  const subagents = (r.subagentTimings ?? []).reduce((n: number, w: any) => n + (w.ioCount ?? 0) + (w.llmCount ?? 0), 0);
  const summary = stepCount === 0
    ? "Direct answer — no tools needed"
    : `${stepCount} step${stepCount === 1 ? "" : "s"}${subagents > stepCount ? ` · ${subagents} sub-agents` : ""}`;
  return (
    <section className="mt-12 border-t border-ink-800 pt-6">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-3 text-left text-sm text-cream-300/70 hover:text-cream-100"
      >
        <span className="flex items-center gap-2">
          <span className="text-cream-300/50">{open ? "▾" : "▸"}</span>
          How this was done
        </span>
        <span className="text-[11px] text-cream-300/50">{summary}</span>
      </button>
      {open && (
        <div className="mt-4 space-y-6">
          <SubagentSpinup budgets={r.budgets} timings={r.subagentTimings} />
          <ProcessTrace job={job} />
        </div>
      )}
    </section>
  );
}

function Sources({ runs }: { runs: any[] }) {
  const sources = useMemo(() => extractSources(runs), [runs]);
  if (sources.length === 0) return null;
  return (
    <section className="mt-12">
      <h2 className="font-display text-xl text-cream-50 mb-3">Sources</h2>
      <ol className="space-y-2.5 text-sm">
        {sources.map((s, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="text-[11px] text-cream-300/40 font-mono mt-1 w-5 flex-shrink-0">[{i + 1}]</span>
            <div className="min-w-0 flex-1">
              {s.kind === "vault" ? (
                <Link to={`/knowledge/${s.path}`} className="text-violet-400 hover:text-violet-500 font-mono text-xs break-all">{s.path}</Link>
              ) : s.kind === "url" ? (
                <LinkPreview href={s.url} className="text-violet-400 hover:text-violet-500 break-all">{s.title || s.url}</LinkPreview>
              ) : s.kind === "repo" ? (
                <a href={`https://github.com/${s.owner}/${s.name}`} target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-500 font-mono text-xs">{s.owner}/{s.name}{s.path ? ` · ${s.path}` : ""}</a>
              ) : (
                <span className="text-cream-200">{s.label}</span>
              )}
              {s.note && <div className="text-[11px] text-cream-300/60 mt-0.5">{s.note}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function QASummary({ review, quality, security, curation }: { review: any; quality: any; security: any; curation?: any }) {
  if (!review && !quality && !security && !curation) return null;
  return (
    <section className="mt-10">
      <h2 className="font-display text-xl text-cream-50 mb-3">Quality assurance</h2>
      {curation && <CurationCard curation={curation} />}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        {quality && (
          <div className={`rounded-lg border p-4 ${quality.pass ? "border-leaf-500/30 bg-leaf-500/5" : "border-flame-500/30 bg-flame-500/5"}`}>
            <div className="text-[10px] uppercase tracking-wider text-cream-300/60">Quality</div>
            <div className={`text-lg font-display mt-1 ${quality.pass ? "text-leaf-400" : "text-flame-400"}`}>{quality.pass ? "Passed" : "Needs work"}</div>
            {typeof quality.score === "number" && <div className="text-[11px] text-cream-300/60 mt-1">Score {Math.round(quality.score * 100)}%</div>}
          </div>
        )}
        {security && (
          <div className={`rounded-lg border p-4 ${security.pass ? "border-leaf-500/30 bg-leaf-500/5" : "border-coral-500/30 bg-coral-500/5"}`}>
            <div className="text-[10px] uppercase tracking-wider text-cream-300/60">Security</div>
            <div className={`text-lg font-display mt-1 ${security.pass ? "text-leaf-400" : "text-coral-400"}`}>{security.pass ? "Clean" : `${(security.findings ?? []).length} finding${(security.findings ?? []).length === 1 ? "" : "s"}`}</div>
            {!security.pass && <div className="text-[11px] text-cream-300/60 mt-1">{(security.findings ?? []).slice(0, 2).map((f: any) => f.type).join(", ")}</div>}
          </div>
        )}
        {review && (
          <div className={`rounded-lg border p-4 ${review.verdict === "good" ? "border-leaf-500/30 bg-leaf-500/5" : review.verdict === "bad" ? "border-coral-500/30 bg-coral-500/5" : "border-flame-500/30 bg-flame-500/5"}`}>
            <div className="text-[10px] uppercase tracking-wider text-cream-300/60">Peer review</div>
            <div className={`text-lg font-display mt-1 ${review.verdict === "good" ? "text-leaf-400" : review.verdict === "bad" ? "text-coral-400" : "text-flame-400"}`}>{review.verdict === "needs-work" ? "Needs work" : review.verdict?.[0]?.toUpperCase() + review.verdict?.slice(1)}</div>
            {review.reviewer?.name && <div className="text-[11px] text-cream-300/60 mt-1">by {review.reviewer.name}</div>}
          </div>
        )}
      </div>
      {Array.isArray(quality?.issues) && quality.issues.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-cream-300/60 cursor-pointer hover:text-cream-100">Quality notes ({quality.issues.length})</summary>
          <ul className="mt-2 space-y-1 text-[12px] text-cream-200 list-disc pl-5">
            {quality.issues.map((issue: string, i: number) => <li key={i}>{issue}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}

// The primary worker's curation verdict on a persona-shifter peer's draft.
// Captured = the answer passed quality + security + context-rooting and was
// distilled into 0-Inbox/. Not captured = primary refused; the answer still
// exists but didn't earn a place in the second brain.
function CurationCard({ curation }: { curation: any }) {
  const captured = curation.captured === true;
  const rooted = curation.rooted ?? {};
  return (
    <div className={`rounded-lg border p-4 mb-4 ${captured ? "border-leaf-500/30 bg-leaf-500/5" : "border-ink-700 bg-ink-950"}`}>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${captured ? "bg-leaf-500" : "bg-cream-300/40"}`} />
        <span className="text-[10px] uppercase tracking-wider text-cream-300/60">Primary curation</span>
        <span className={`text-sm font-display ${captured ? "text-leaf-400" : "text-cream-300"}`}>{captured ? "Captured to your second brain" : "Not captured"}</span>
        {captured && curation.path && (
          <Link to={`/knowledge/${curation.path}`} className="ml-auto text-[12px] text-violet-400 hover:text-violet-500 font-mono">{curation.path}</Link>
        )}
      </div>
      {!captured && curation.reason && (
        <div className="text-[12px] text-cream-300/80">{curation.reason}</div>
      )}
      {(rooted.vaultCitations != null || rooted.webSources != null || rooted.githubRefs != null) && (
        <div className="mt-2 flex items-center gap-4 text-[11px] text-cream-300/60 flex-wrap">
          <span>Context-rooting:</span>
          <span><span className="text-cream-100 font-mono">{rooted.vaultCitations ?? 0}</span> vault refs</span>
          <span><span className="text-cream-100 font-mono">{rooted.webSources ?? 0}</span> web sources</span>
          <span><span className="text-cream-100 font-mono">{rooted.githubRefs ?? 0}</span> GitHub refs</span>
        </div>
      )}
    </div>
  );
}

// Sub-agent spin-up panel. The agent loop runs steps in two lanes (LLM and
// I/O) — this surfaces the budgets it picked, the wave-by-wave timing, and
// the idle-peer bonus that boosted it. Helps the user understand WHY a run
// was fast (or wasn't).
function SubagentSpinup({ budgets, timings }: { budgets?: any; timings?: any[] }) {
  if (!budgets && (!Array.isArray(timings) || timings.length === 0)) return null;
  const totalMs = Array.isArray(timings) ? timings.reduce((a, t) => a + (t.elapsedMs ?? 0), 0) : 0;
  const parallel = Array.isArray(timings) && timings.some(t => (t.ioCount ?? 0) + (t.llmCount ?? 0) > 1);
  return (
    <section className="mt-10">
      <h2 className="font-display text-xl text-cream-50 mb-3">Sub-agent spin-up</h2>
      <div className="rounded-lg border border-leaf-500/30 bg-leaf-500/5 p-4">
        <div className="flex items-center gap-3 flex-wrap text-sm">
          {budgets && (
            <>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-cream-300/50">I/O lane</div>
                <div className="font-display text-xl text-cream-50">{budgets.io}</div>
              </div>
              <div className="w-px h-8 bg-ink-700" />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-cream-300/50">LLM lane</div>
                <div className="font-display text-xl text-cream-50">{budgets.llm}</div>
              </div>
              {budgets.idlePeers > 0 && (
                <>
                  <div className="w-px h-8 bg-ink-700" />
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-cream-300/50">Idle peers</div>
                    <div className="font-display text-xl text-leaf-400">+{budgets.idlePeers}</div>
                  </div>
                </>
              )}
            </>
          )}
          {totalMs > 0 && (
            <div className="ml-auto text-right">
              <div className="text-[10px] uppercase tracking-wider text-cream-300/50">Sub-agent time</div>
              <div className="font-display text-xl text-cream-50">{(totalMs / 1000).toFixed(1)}s</div>
            </div>
          )}
        </div>
        {parallel && Array.isArray(timings) && (
          <div className="mt-3 pt-3 border-t border-ink-800">
            <div className="text-[10px] uppercase tracking-wider text-cream-300/50 mb-2">Per-wave timing</div>
            <ul className="space-y-1 text-[12px]">
              {timings.map((t: any, i: number) => (
                <li key={i} className="flex items-center gap-3">
                  <span className="font-mono text-cream-300/60 w-12">W{t.wave}</span>
                  <div className="flex-1 h-1.5 bg-ink-800 rounded overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-leaf-500 to-violet-500" style={{ width: `${Math.min(100, (t.elapsedMs / Math.max(1, totalMs)) * 100)}%` }} />
                  </div>
                  <span className="font-mono text-cream-300/70 w-16 text-right">{(t.elapsedMs / 1000).toFixed(1)}s</span>
                  <span className="font-mono text-cream-300/40 w-24">{t.ioCount ?? 0} I/O · {t.llmCount ?? 0} LLM</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function ProcessTrace({ job }: { job: any }) {
  const r = job.result ?? {};
  const steps: any[] = r.plan?.steps ?? [];
  const runs: any[] = r.runs ?? [];
  if (steps.length === 0) return null;
  // Prefer the executed runs (each already carries its own step) — falls
  // back to the planned steps (no run yet) so an in-progress step still
  // shows up before it's finished.
  const feedSteps = steps.map((s, i) => runs[i] ?? { step: s, ok: false });
  return (
    <section className="mt-10">
      <details>
        <summary className="cursor-pointer text-sm text-cream-300/70 hover:text-cream-100">How Naxie arrived at this — {steps.length} {steps.length === 1 ? "step" : "steps"}</summary>
        <div className="mt-3 pl-1">
          <AgentStepFeed steps={feedSteps} />
        </div>
      </details>
    </section>
  );
}

// Walk the executed runs and build a deduplicated source list. Pulls vault
// paths from search/read/list/write tools, URLs from fetch/scrape, and repo
// references from github tools.
function extractSources(runs: any[]): { kind: string; [k: string]: any }[] {
  const out: any[] = [];
  const seen = new Set<string>();
  const add = (key: string, src: any) => { if (seen.has(key)) return; seen.add(key); out.push(src); };

  for (const run of runs) {
    if (!run?.ok || !run?.step) continue;
    const tool = run.step.tool;
    const args = run.step.args ?? {};
    const result = run.result ?? {};
    if (tool === "vault.search" && Array.isArray(result.matches)) {
      for (const m of result.matches.slice(0, 5)) {
        if (m?.path) add(`vault:${m.path}`, { kind: "vault", path: m.path, note: m.preview ? `“${m.preview.slice(0, 90)}”` : undefined });
      }
    } else if ((tool === "vault.read" || tool === "vault.write" || tool === "vault.append" || tool === "vault.create_zettel") && (args.path || result.path || result.written)) {
      const p = String(result.path ?? result.written ?? args.path);
      add(`vault:${p}`, { kind: "vault", path: p });
    } else if (tool === "research.deep") {
      for (const h of (result.vaultHits ?? []).slice(0, 4)) {
        if (h?.path) add(`vault:${h.path}`, { kind: "vault", path: h.path });
      }
      for (const w of (result.webSources ?? []).slice(0, 6)) {
        if (w?.url) add(`url:${w.url}`, { kind: "url", url: w.url, title: w.title });
      }
      if (result.captured?.path) add(`vault:${result.captured.path}`, { kind: "vault", path: result.captured.path, note: "Captured by research.deep" });
    } else if (tool === "research.multiperspective") {
      for (const h of (result.vaultHits ?? []).slice(0, 4)) {
        if (h?.path) add(`vault:${h.path}`, { kind: "vault", path: h.path });
      }
      // Walk each perspective's sources so the user can see which framing
      // yielded which source — note added so the source list reads as
      // "[3] (recent) <title>" in spirit, even without dedicated rendering.
      for (const p of (result.perspectiveResults ?? [])) {
        for (const s of (p.sources ?? [])) {
          if (s?.url && s.ok !== false) add(`url:${s.url}`, { kind: "url", url: s.url, title: s.title, note: `from ${p.name} perspective` });
        }
      }
      if (result.captured?.path) add(`vault:${result.captured.path}`, { kind: "vault", path: result.captured.path, note: "Captured multi-perspective report" });
    } else if (tool === "web.fetch" || tool === "web.scrape") {
      const u = String(args.url ?? result.url ?? "");
      if (u) add(`url:${u}`, { kind: "url", url: u, title: result.title });
    } else if (tool === "web.search" && Array.isArray(result.results)) {
      for (const w of result.results.slice(0, 5)) if (w?.url) add(`url:${w.url}`, { kind: "url", url: w.url, title: w.title });
    } else if (tool === "github.read_repo" || tool === "github.get_file") {
      const owner = String(args.owner ?? "");
      const name = String(args.name ?? "");
      const path = args.path ? String(args.path) : undefined;
      if (owner && name) add(`gh:${owner}/${name}${path ?? ""}`, { kind: "repo", owner, name, path });
    }
  }
  return out;
}

function cleanTitle(t: any): string {
  if (typeof t !== "string") return "";
  return t.replace(/^Ad-hoc:\s*/i, "").trim();
}
