import { useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { OfficeJob } from "./types";

// Floating task list — every job across every department, filterable by a
// coarse status bucket. The bucket names/mapping intentionally mirror
// OrgDashboard's own status vocabulary (backlog/active/waiting/done) even
// though these are two unrelated data sources (this is real persona jobs;
// OrgDashboard is Naxie's internal role backlog) — same words, same meaning,
// less to relearn.
type Bucket = "all" | "backlog" | "in-progress" | "waiting" | "done";
const BUCKETS: [Bucket, string][] = [
  ["all", "ALL"], ["backlog", "BACKLOG"], ["in-progress", "IN PROGRESS"], ["waiting", "WAITING"], ["done", "DONE"],
];

function bucketOf(status: OfficeJob["status"]): Exclude<Bucket, "all"> {
  if (status === "running") return "in-progress";
  if (status === "pending") return "backlog";
  if (status === "awaiting-approval" || status === "waiting_on_human") return "waiting";
  return "done"; // succeeded | failed | rejected
}

function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function TaskStatusPanel({ jobs }: { jobs: OfficeJob[] }) {
  const [filter, setFilter] = useState<Bucket>("all");

  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { all: jobs.length, backlog: 0, "in-progress": 0, waiting: 0, done: 0 };
    for (const j of jobs) c[bucketOf(j.status)]++;
    return c;
  }, [jobs]);

  const filtered = useMemo(
    () => (filter === "all" ? jobs : jobs.filter(j => bucketOf(j.status) === filter)),
    [jobs, filter],
  );

  return (
    <div className="bg-ink-900 border border-ink-800 rounded-lg p-3 space-y-2.5 max-h-[min(70vh,640px)] flex flex-col">
      <div className="text-xs font-medium text-cream-100 uppercase tracking-wider">Task status</div>
      <div className="flex flex-wrap gap-1">
        {BUCKETS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={`text-[10px] px-2 py-1 rounded-full border whitespace-nowrap ${
              filter === id ? "bg-violet-500 border-violet-500 text-white" : "border-ink-700 text-cream-300/70 hover:text-cream-100"
            }`}
          >
            {label} {counts[id]}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto space-y-1.5">
        {filtered.length === 0 ? (
          <div className="text-[11px] text-cream-300/40 py-3 text-center">No tasks here.</div>
        ) : filtered.map(j => (
          <div key={j.id} className="border border-ink-800 rounded-lg px-2.5 py-2 bg-ink-950/40">
            <div className="flex items-center gap-1.5">
              {j.status === "running" && <Loader2 size={11} className="text-violet-400 animate-spin shrink-0" />}
              {j.stuck && <AlertTriangle size={11} className="text-amber-400 shrink-0" />}
              <span className="text-xs text-cream-100 truncate flex-1">{j.title}</span>
            </div>
            <div className="text-[10px] text-cream-300/50 mt-0.5 truncate">
              {j.personaName ?? "Unassigned"}{j.department ? ` · ${j.department}` : ""}
            </div>
            {j.status === "running" && j.progressPct != null ? (
              <div className="mt-1.5 h-1 rounded-full bg-ink-800 overflow-hidden" title="Approximate — from plan steps completed, not exact">
                <div className="h-full bg-violet-500" style={{ width: `${j.progressPct}%` }} />
              </div>
            ) : (
              <div className="text-[10px] text-cream-300/40 mt-1">
                {j.status} · {relTime(j.finishedAt ?? j.startedAt)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
