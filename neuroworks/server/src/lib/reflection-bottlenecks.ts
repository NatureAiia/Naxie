// Feature B — structured bottleneck index (the "agents review prior failures
// and fix bottlenecks" loop).
//
// The daily reflection already computes per-template success/failure, the top
// recurring errors, and per-tool failure rates (see reflection.ts aggregate()).
// Until now that only became PROSE in the reflection note (and reached the
// synth prompt via governance lessons) — never the tool-choice PLANNER. This
// module turns that same data into a STRUCTURED, accumulating index on disk
// (_governance/bottlenecks.json) and hands the planner a concrete "prior runs
// of this task type failed at X → do Y" directive at plan time.
//
// The index ACCUMULATES across reflection runs (cumulative run/fail counts) so
// a single noisy day doesn't dominate, and entries not seen for 30 days age out.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";

type BottleneckEntry = {
  template: string;
  totalRuns: number;
  totalFailed: number;
  failureRate: number;      // totalFailed / totalRuns
  avgDurationSec: number;   // latest observed
  topError: string;         // most recent recurring error for this template
  remedy: string;           // concrete instruction for the planner
  lastSeen: string;         // ISO date of the last reflection that touched it
};

type BottleneckIndex = { updatedAt: string; entries: Record<string, BottleneckEntry> };

// Shape of the reflection stats we consume (subset of DailyStats).
type StatsLike = {
  date: string;
  byTemplate: Record<string, { total: number; ok: number; failed: number; avgDurationSec: number }>;
  topFailures: { error: string; count: number; templates: string[] }[];
};

const REL = "_governance/bottlenecks.json";
const MAX_AGE_DAYS = 30;
const MIN_RUNS = 4;          // don't advise off a tiny sample
const MIN_FAILURE_RATE = 0.2; // only surface task types that actually struggle

function indexPath(): string {
  return resolve(config.vaultPath, REL);
}

function load(): BottleneckIndex {
  try {
    const raw = readFileSync(indexPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.entries) return parsed as BottleneckIndex;
  } catch { /* absent or corrupt → fresh */ }
  return { updatedAt: new Date().toISOString(), entries: {} };
}

function save(idx: BottleneckIndex): void {
  const full = indexPath();
  try { mkdirSync(dirname(full), { recursive: true }); } catch { /* tolerate */ }
  const tmp = `${full}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(idx, null, 2), "utf8");
  renameSync(tmp, full);
}

// Translate an observed failure into a concrete, actionable planning directive.
function deriveRemedy(error: string, failurePct: number): string {
  const e = (error || "").toLowerCase();
  if (/timeout|timed out|etimedout|abort|too long|deadline/.test(e)) {
    return "prior runs of this type TIMED OUT — split the work into parallel independent sub-agents rather than one long serial chain, prefer cached/cheaper paths (e.g. db schema cache), and avoid unnecessarily heavy steps.";
  }
  if (/not configured|no provider|connector|unauthor|401|403|credential|auth/.test(e)) {
    return "prior runs FAILED on a missing/unauthenticated integration — verify the source is available FIRST (connector.describe / db.list_sources / connector.list) and if it isn't, say so honestly and stop; do NOT fabricate a result.";
  }
  if (/no records|not found|empty|nothing|no results|no data/.test(e)) {
    return "prior runs returned EMPTY — make sure you query the RIGHT source (calendar.activity for completed work, memory.search for recall, the finance connector for money, the vault for policies) before concluding nothing exists.";
  }
  if (/\$step_|unresolved|reference|placeholder/.test(e)) {
    return "prior runs had UNRESOLVED step references — when a later step consumes an earlier step's output, wire it explicitly (e.g. body: \"$step_N.text\") and don't leave placeholder values.";
  }
  return `prior runs of this type failed ~${Math.round(failurePct * 100)}% of the time — add a quality.check/verification step and confirm the deliverable matches every part of the request before finishing.`;
}

// Called from the reflection post-hook with the day's aggregated stats. Merges
// them into the accumulating index and ages out stale entries.
export function updateBottlenecksFromStats(stats: StatsLike): void {
  const idx = load();
  const now = new Date().toISOString();
  const errorForTemplate = (tpl: string): string =>
    stats.topFailures.find(f => f.templates?.includes(tpl))?.error ?? "";

  for (const [template, t] of Object.entries(stats.byTemplate)) {
    if (!template || t.total <= 0) continue;
    const prev = idx.entries[template];
    const totalRuns = (prev?.totalRuns ?? 0) + t.total;
    const totalFailed = (prev?.totalFailed ?? 0) + t.failed;
    const failureRate = totalRuns > 0 ? totalFailed / totalRuns : 0;
    const topError = errorForTemplate(template) || prev?.topError || "";
    idx.entries[template] = {
      template,
      totalRuns,
      totalFailed,
      failureRate: Math.round(failureRate * 100) / 100,
      avgDurationSec: t.avgDurationSec,
      topError: topError.slice(0, 200),
      remedy: deriveRemedy(topError, failureRate),
      lastSeen: stats.date || now,
    };
  }

  // Age out entries not seen within MAX_AGE_DAYS.
  const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
  for (const [k, e] of Object.entries(idx.entries)) {
    const seen = Date.parse(e.lastSeen);
    if (Number.isFinite(seen) && seen < cutoff) delete idx.entries[k];
  }

  idx.updatedAt = now;
  save(idx);
}

// The full index (for the on-demand review endpoint / dashboards).
export function listBottlenecks(): BottleneckEntry[] {
  return Object.values(load().entries).sort((a, b) => b.failureRate - a.failureRate);
}

// A single planner directive for the current task. Matches the identifier
// flexibly: the planner passes job.kind (e.g. "insights:general-task") while
// the index is keyed by template (e.g. "general-task"), so we also accept a
// substring match either way. Returns null when there's no material weakness.
export function bottleneckHintFor(opts: { taskKind?: string; template?: string }): string | null {
  const ids = [opts.template, opts.taskKind].filter((s): s is string => !!s);
  if (ids.length === 0) return null;
  const entries = Object.values(load().entries);
  const match =
    entries.find(e => ids.includes(e.template)) ||
    entries.find(e => ids.some(id => id.includes(e.template) || e.template.includes(id)));
  if (!match) return null;
  if (match.totalRuns < MIN_RUNS || match.failureRate < MIN_FAILURE_RATE) return null;
  return `LEARNED BOTTLENECK — ${match.remedy}${match.topError ? ` (most common failure: "${match.topError}")` : ""}`;
}
