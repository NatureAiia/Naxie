import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.js";

export type QualityFlag = {
  jobId: string;
  rating: "up" | "down";
  note?: string;
  persona?: string;
  template?: string;
  score?: number;
  category?: "accuracy" | "relevance" | "tone" | "completeness" | "formatting" | "localization" | "other";
  // Language the flagged output was actually IN, as observed by the operator
  // flagging it — not inferred. The product has been trimmed to English-only,
  // so this field will only carry "en" when present.
  language?: "en";
  // Where the flag came from: "operator" = a human thumbs (feedback.jsonl / the
  // manual flag control); "auto" = the agent's own quality.check verdict logged
  // at job end. Lets the dashboard separate machine QA from human satisfaction.
  source?: "operator" | "auto";
  // The four quality.check axes, captured at job end so the learning loop can
  // aggregate WHICH dimension a task type is weak on (not just up/down). Only
  // "auto" (machine QA) records carry these; operator thumbs don't.
  axes?: { factuality_risk?: number; citation_coverage?: number; persona_fit?: number; prompt_alignment?: number };
  // The task type this run was (job.kind, e.g. "general-task"), so signals can
  // be aggregated per task type and fed back into planning for that type.
  taskKind?: string;
  ts: string;
};

// Axis directions: for factuality_risk LOWER is better; for the other three
// HIGHER is better. Normalized to a 0..1 "goodness" so we can compare axes.
const AXIS_GOODNESS: Record<string, (v: number) => number> = {
  factuality_risk: v => 1 - v,
  citation_coverage: v => v,
  persona_fit: v => v,
  prompt_alignment: v => v,
};
const AXIS_LABEL: Record<string, string> = {
  factuality_risk: "factual accuracy",
  citation_coverage: "citation/evidence coverage",
  persona_fit: "persona & structure fit",
  prompt_alignment: "alignment with the request",
};

export type QualitySummary = {
  totalFlags: number;
  upvotes: number;
  downvotes: number;
  rate: number; // 0-1 satisfaction rate
  topCategories: { category: string; count: number }[];
  recentFlags: QualityFlag[];
};

const QUALITY_REL = "_neuroworks/quality.jsonl";
// The thumbs up/down the operator actually clicks on answers (ResultPanel →
// POST /api/feedback) land in a SEPARATE file, written by routes/feedback.ts.
// Until 2026-07-12 the Quality page read only quality.jsonl — whose write
// path (POST /api/quality/flag) has no UI control wired to it — so the page
// showed zeros while 13 real ratings sat in feedback.jsonl. Reads below merge
// both files; the two stores share a record shape (feedback.jsonl just never
// carries category/language).
const FEEDBACK_REL = "_neuroworks/feedback.jsonl";
const AGGREGATE_REL = "_neuroworks/quality-summary.json";

function qualityPath(): string {
  return resolve(config.vaultPath, QUALITY_REL);
}

function feedbackPath(): string {
  return resolve(config.vaultPath, FEEDBACK_REL);
}

function aggregatePath(): string {
  return resolve(config.vaultPath, AGGREGATE_REL);
}

function readJsonlFlags(full: string): QualityFlag[] {
  if (!existsSync(full)) return [];
  try {
    return readFileSync(full, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
      .filter((r: any) => r && typeof r.jobId === "string" && (r.rating === "up" || r.rating === "down"));
  } catch {
    return [];
  }
}

// Every read path goes through this merge. For the same jobId in BOTH files,
// all records are kept (they're independent events in a timeline), sorted
// oldest→newest like a single JSONL would be.
function readAllFlags(): QualityFlag[] {
  return [...readJsonlFlags(qualityPath()), ...readJsonlFlags(feedbackPath())]
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

export function flagQuality(flag: QualityFlag): void {
  const full = qualityPath();
  try { mkdirSync(join(full, ".."), { recursive: true }); } catch { /* tolerate */ }
  appendFileSync(full, JSON.stringify(flag) + "\n", "utf8");
  updateAggregate();
}

function updateAggregate(): void {
  try {
    const flags = readAllFlags();
    if (flags.length === 0) return;
    const upvotes = flags.filter(f => f.rating === "up").length;
    const downvotes = flags.filter(f => f.rating === "down").length;
    const total = upvotes + downvotes;

    const catCount = new Map<string, number>();
    for (const f of flags) {
      if (f.category) catCount.set(f.category, (catCount.get(f.category) ?? 0) + 1);
    }
    const topCategories = [...catCount.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const agg: QualitySummary = {
      totalFlags: total,
      upvotes,
      downvotes,
      rate: total > 0 ? upvotes / total : 1,
      topCategories,
      recentFlags: flags.slice(-20).reverse(),
    };
    writeFileSync(aggregatePath(), JSON.stringify(agg, null, 2), "utf8");
  } catch { /* ignore corrupt data */ }
}

// Computed LIVE from the merged stores on every call — the on-disk aggregate
// only refreshed when POST /api/quality/flag wrote (never when a thumb landed
// in feedback.jsonl), so it was permanently stale for the path operators
// actually use. Files are a few KB; recomputing beats caching a lie.
export function getQualitySummary(): QualitySummary {
  const flags = readAllFlags();
  const upvotes = flags.filter(f => f.rating === "up").length;
  const downvotes = flags.filter(f => f.rating === "down").length;
  const total = upvotes + downvotes;
  const catCount = new Map<string, number>();
  for (const f of flags) {
    if (f.category) catCount.set(f.category, (catCount.get(f.category) ?? 0) + 1);
  }
  const topCategories = [...catCount.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return {
    totalFlags: total,
    upvotes,
    downvotes,
    rate: total > 0 ? upvotes / total : 1,
    topCategories,
    recentFlags: flags.slice(-20).reverse(),
  };
}

export function getQualityFlags(since?: string): QualityFlag[] {
  const flags = readAllFlags();
  if (since) {
    const sinceTs = new Date(since).getTime();
    return flags.filter(f => new Date(f.ts).getTime() >= sinceTs);
  }
  return flags;
}

// ─── Feature A: quality → reinforcement signal ───
// Aggregate the machine-QA axis scores by task type (job.kind) and by persona,
// so the planner can learn "runs of THIS type are historically weakest on axis
// X" and steer the next plan to fix it. Only "auto" records carry axes.
export type QualitySignal = {
  scope: "kind" | "persona";
  key: string;
  samples: number;
  means: { factuality_risk?: number; citation_coverage?: number; persona_fit?: number; prompt_alignment?: number };
  weakestAxis: string;      // axis with the lowest normalized "goodness"
  weakestGoodness: number;  // 0..1; lower = weaker
};

export function learnedQualitySignals(minSamples = 3): QualitySignal[] {
  const withAxes = readAllFlags().filter(f => f.axes && f.source === "auto");
  const buckets = new Map<string, { scope: "kind" | "persona"; key: string; rows: NonNullable<QualityFlag["axes"]>[] }>();
  for (const f of withAxes) {
    for (const [scope, key] of [["kind", f.taskKind], ["persona", f.persona]] as const) {
      if (!key) continue;
      const id = `${scope}:${key}`;
      if (!buckets.has(id)) buckets.set(id, { scope, key, rows: [] });
      buckets.get(id)!.rows.push(f.axes!);
    }
  }
  const out: QualitySignal[] = [];
  for (const { scope, key, rows } of buckets.values()) {
    if (rows.length < minSamples) continue;
    const means: QualitySignal["means"] = {};
    let weakestAxis = ""; let weakestGoodness = 1;
    for (const axis of Object.keys(AXIS_GOODNESS)) {
      const vals = rows.map(r => (r as any)[axis]).filter((v): v is number => typeof v === "number");
      if (!vals.length) continue;
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      (means as any)[axis] = Math.round(mean * 100) / 100;
      const goodness = AXIS_GOODNESS[axis](mean);
      if (goodness < weakestGoodness) { weakestGoodness = goodness; weakestAxis = axis; }
    }
    if (weakestAxis) out.push({ scope, key, samples: rows.length, means, weakestAxis, weakestGoodness });
  }
  return out.sort((a, b) => a.weakestGoodness - b.weakestGoodness);
}

// A single directive for the planner: for the given task kind / persona, if
// history shows a weak axis (goodness below `weakThreshold`), return a concrete
// instruction to fix it on this run. Most-specific match (kind) wins. Null when
// there's no learned weakness to act on.
export function qualityHintFor(opts: { taskKind?: string; persona?: string }, weakThreshold = 0.6): string | null {
  const signals = learnedQualitySignals();
  const match =
    (opts.taskKind && signals.find(s => s.scope === "kind" && s.key === opts.taskKind)) ||
    (opts.persona && signals.find(s => s.scope === "persona" && s.key === opts.persona)) || null;
  if (!match || match.weakestGoodness >= weakThreshold) return null;
  const label = AXIS_LABEL[match.weakestAxis] ?? match.weakestAxis;
  const fix =
    match.weakestAxis === "prompt_alignment" ? "make sure the plan addresses EVERY part of the request (format, scope, counts, recipient, deliverable) and add a quality.check step to verify before finishing" :
    match.weakestAxis === "citation_coverage" ? "add a research/grounding step (vault.search, connector.call, or web.search) and cite sources in the output" :
    match.weakestAxis === "factuality_risk" ? "ground claims in retrieved evidence rather than asserting from memory; add a verification step" :
    "match the persona's expected tone and structure, and include the sections the deliverable type requires";
  return `LEARNED QUALITY SIGNAL — past ${match.scope === "kind" ? `"${match.key}" tasks` : `outputs from ${match.key}`} score low on ${label} (avg goodness ${match.weakestGoodness.toFixed(2)} over ${match.samples} runs). This run: ${fix}.`;
}

export function getLowQualityRuns(threshold = 0.5, minFlags = 3): { task: string; count: number; rate: number }[] {
  const flags = getQualityFlags();
  const byPersona = new Map<string, QualityFlag[]>();
  for (const f of flags) {
    const key = f.persona ?? "unknown";
    if (!byPersona.has(key)) byPersona.set(key, []);
    byPersona.get(key)!.push(f);
  }
  const result: { task: string; count: number; rate: number }[] = [];
  for (const [persona, pf] of byPersona) {
    if (pf.length < minFlags) continue;
    const down = pf.filter(f => f.rating === "down").length;
    const rate = 1 - (down / pf.length);
    if (rate < threshold) {
      result.push({ task: persona, count: pf.length, rate });
    }
  }
  return result.sort((a, b) => a.rate - b.rate);
}
