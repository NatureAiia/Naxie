import { useEffect, useState } from "react";
import { Network, Clock, RefreshCw, Sparkles } from "lucide-react";
import { api, type OrgTask, type OrgRole, type OrgTaskStatus, type OrgTaskPriority } from "../lib/api";
import { Card, showToast } from "../components/Card";

// Org dashboard (docs/naxie-architecture.md §4/§8/§8.5) — a read-only
// diagnostics view over Naxie's internal 6-role task backlog. This is
// deliberately NOT a feature Naxie ever references in conversation (§0) —
// it's here for when you go looking on your own. Replaces the old flat
// filtered-list card that used to live on the deleted /admin page: this
// version groups by role as columns so the org actually reads as an org,
// not a single flat table.

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

export function OrgDashboard() {
  const [tasks, setTasks] = useState<OrgTask[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<OrgTaskStatus | "">("");
  const [expanded, setExpanded] = useState<OrgRole | null>(null);
  const [err, setErr] = useState("");
  const [scoring, setScoring] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.orgTasks(statusFilter ? { status: statusFilter } : undefined);
      setTasks(r.tasks);
      setErr("");
    } catch (e: any) {
      // admin-gated route — a non-admin/loopback-without-session just sees empty
      setErr(e?.message ?? String(e));
      setTasks([]);
    }
  }
  useEffect(() => { void load(); const i = setInterval(load, 8000); return () => clearInterval(i); }, [statusFilter]);

  async function scoreTask(id: string) {
    setScoring(id);
    try {
      await api.scoreOrgTask(id);
      void load();
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setScoring(null);
    }
  }

  const byRole = (role: OrgRole) => (tasks ?? []).filter(t => t.role === role);
  const totalActive = (tasks ?? []).filter(t => t.status === "active" || t.status === "waiting-on-approval").length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><Network size={24} /> Org Dashboard</h1>
          <p className="text-sm text-cream-300/70 mt-1 max-w-2xl">
            Naxie's internal 6-role backlog — diagnostics only. She never names a role in conversation; this is here
            purely for when you want to see what's actually happening underneath "I'll handle it."
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="text-xs px-3 py-1.5 rounded-md border border-ink-700 hover:border-violet-500/40 text-cream-300 hover:text-cream-100 flex items-center gap-1.5 shrink-0">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

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
                          <span className="ml-auto flex items-center gap-1.5">
                            {t.priorityScore && (
                              <span
                                className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300 font-mono"
                                title={t.priorityScore.rationale || undefined}
                              >
                                {t.priorityScore.composite}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => void scoreTask(t.id)}
                              disabled={scoring === t.id}
                              title="Score priority (one LLM call)"
                              className="p-1 rounded-md border border-ink-800 hover:border-violet-500/40 text-cream-300/60 hover:text-cream-100 disabled:opacity-40"
                            >
                              <Sparkles size={10} className={scoring === t.id ? "animate-pulse" : ""} />
                            </button>
                          </span>
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
