// What was the model actually asked to do, and what happened? Ported from
// AI-Institute-Africa/neuroworks.
//
// Upstream lost three days to reconstructing this from console breadcrumbs:
// "Section Summary exceeded 240s" — which model, how big was the prompt, did
// it overflow the window, did it fall back to a provider that was out of
// credit? None of it was recorded. One boolean would have said it outright.
//
// WHAT THIS DELIBERATELY DOES NOT STORE: the prompt and the response. Sizes,
// timings and outcomes only. The text passing through this layer can be
// mailbox contents, vault notes and client documents; a plain-text record of
// it sitting in .neuroworks would be a bigger liability than the debugging
// is worth. `promptHash` groups repeats — "this same call ran eleven times"
// — without keeping a word of it.
//
// Local, NOT the vault. The cost ledger lives in the vault because it is
// small and worth syncing; a row per model call is not, and the vault is
// git-synced.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TraceOutcome = "ok" | "error" | "aborted";

export type TraceRow = {
  at: string;
  /** The job this served, or "adhoc" outside one (a health check, a schedule tick, a test). */
  job: string;
  call: string;
  backend: string;
  model: string;
  profile?: string;
  /** The router's own words for why this backend/model — "credit exhausted, running locally". */
  reason?: string;
  promptChars: number;
  systemChars: number;
  estTokens: number;
  /** The local context window this was measured against, when the call went local. */
  ctx?: number;
  /** estTokens exceeded the window: the prompt was truncated before the model saw it. */
  overflow?: boolean;
  inTok?: number;
  outTok?: number;
  ms: number;
  outcome: TraceOutcome;
  errorClass?: string;
  promptHash: string;
};

function stateDir(): string {
  const override = (process.env.NAXION_STATE_DIR ?? "").trim();
  return override || resolve(dirname(fileURLToPath(import.meta.url)), "../../../.neuroworks");
}
function traceFile(): string {
  return join(stateDir(), "llm-trace.jsonl");
}

const MAX_ROWS = Number(process.env.NAXION_TRACE_MAX_ROWS ?? "20000");
const KEEP_ON_ROTATE = Math.floor(MAX_ROWS * 0.6);
/** Set NAXION_TRACE=0 to stop recording entirely. */
function enabled(): boolean {
  return (process.env.NAXION_TRACE ?? "1").trim() !== "0";
}

let rowsSinceCheck = 0;

export function hashPrompt(prompt: string, system?: string): string {
  return createHash("sha1").update(`${system ?? ""} ${prompt}`).digest("hex").slice(0, 12);
}

/** Classify an error once, so a summary can group failures without regex-ing messages. */
export function classifyError(err: unknown): { outcome: TraceOutcome; errorClass: string } {
  const msg = String((err as any)?.message ?? err ?? "").toLowerCase();
  if (/abort/.test(msg)) return { outcome: "aborted", errorClass: "abort" };
  // Context BEFORE timeout: "maximum context length exceeded" contains
  // "exceeded" and would otherwise be filed as slowness — the two need
  // opposite fixes, shrink the prompt or wait longer.
  if (/context (?:length|window)|too (?:big|large|long)|maximum context|context_length/.test(msg)) {
    return { outcome: "error", errorClass: "context" };
  }
  if (/timed? ?out|timeout|exceeded/.test(msg)) return { outcome: "error", errorClass: "timeout" };
  if (/credit|quota|billing|payment/.test(msg)) return { outcome: "error", errorClass: "credit" };
  if (/rate.?limit|429/.test(msg)) return { outcome: "error", errorClass: "rate-limit" };
  if (/econn|enotfound|network|fetch failed/.test(msg)) return { outcome: "error", errorClass: "network" };
  return { outcome: "error", errorClass: "other" };
}

/**
 * Append one row. Never throws — a failure to record must not fail the call
 * it is recording, which would turn observability into an outage.
 */
export function recordTrace(row: TraceRow): void {
  if (!enabled()) return;
  try {
    const dir = stateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(traceFile(), JSON.stringify(row) + "\n");
    rowsSinceCheck += 1;
    // Only stat the file occasionally — this runs on every model call.
    if (rowsSinceCheck >= 500) {
      rowsSinceCheck = 0;
      rotateIfLarge();
    }
  } catch { /* tolerate */ }
}

function rotateIfLarge(): void {
  try {
    const file = traceFile();
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length <= MAX_ROWS) return;
    writeFileSync(file, lines.slice(-KEEP_ON_ROTATE).join("\n") + "\n");
  } catch { /* tolerate */ }
}

/** Read rows back, newest last. Per-line parsing: one bad row never costs the file. */
export function readTrace(opts: { sinceMs?: number; job?: string; limit?: number } = {}): TraceRow[] {
  const out: TraceRow[] = [];
  try {
    const file = traceFile();
    if (!existsSync(file)) return out;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const r = JSON.parse(s) as TraceRow;
        if (!r || typeof r.at !== "string") continue;
        if (opts.sinceMs && (Date.parse(r.at) || 0) < opts.sinceMs) continue;
        if (opts.job && r.job !== opts.job) continue;
        out.push(r);
      } catch { /* skip the bad line, keep the rest */ }
    }
  } catch { /* an unreadable trace means "nothing recorded", never a crash */ }
  return opts.limit ? out.slice(-opts.limit) : out;
}

export type TraceSummary = {
  calls: number;
  windowFrom?: string;
  totalMs: number;
  failures: number;
  aborted: number;
  overflows: number;
  /**
   * Calls that ended up somewhere other than first choice. A failover is
   * not an error — the call succeeded — so it never showed up as one, and
   * the only trace of it was a console line nobody counts. Worth counting:
   * every complex synthesis silently falling back to a small local model
   * because every paid provider is out of credit turns seconds into
   * minutes, and the bill for an empty account is paid in wall-clock.
   */
  fallbacks: number;
  fallbackMs: number;
  byModel: { model: string; calls: number; ms: number; failures: number }[];
  byErrorClass: { errorClass: string; calls: number }[];
  slowest: { at: string; job: string; model: string; ms: number; outcome: TraceOutcome; promptChars: number; overflow?: boolean }[];
  byJob: { job: string; calls: number; ms: number; failures: number }[];
};

/**
 * The questions worth asking of a run: what took the longest, what
 * overflowed, what failed and why, and which job paid for it.
 */
export function summariseTrace(rows: TraceRow[]): TraceSummary {
  const byModel = new Map<string, { calls: number; ms: number; failures: number }>();
  const byClass = new Map<string, number>();
  const byJob = new Map<string, { calls: number; ms: number; failures: number }>();
  let totalMs = 0, failures = 0, aborted = 0, overflows = 0, fallbacks = 0, fallbackMs = 0;

  for (const r of rows) {
    totalMs += r.ms || 0;
    if (r.outcome === "error") failures += 1;
    if (r.outcome === "aborted") aborted += 1;
    if (r.overflow) overflows += 1;
    if (/fell back|failover|unavailable|exhausted/i.test(r.reason ?? "")) {
      fallbacks += 1;
      fallbackMs += r.ms || 0;
    }
    const m = byModel.get(r.model) ?? { calls: 0, ms: 0, failures: 0 };
    m.calls += 1; m.ms += r.ms || 0; if (r.outcome !== "ok") m.failures += 1;
    byModel.set(r.model, m);
    if (r.errorClass) byClass.set(r.errorClass, (byClass.get(r.errorClass) ?? 0) + 1);
    const j = byJob.get(r.job) ?? { calls: 0, ms: 0, failures: 0 };
    j.calls += 1; j.ms += r.ms || 0; if (r.outcome !== "ok") j.failures += 1;
    byJob.set(r.job, j);
  }

  return {
    calls: rows.length,
    windowFrom: rows[0]?.at,
    totalMs,
    failures,
    aborted,
    overflows,
    fallbacks,
    fallbackMs,
    byModel: [...byModel].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.ms - a.ms),
    byErrorClass: [...byClass].map(([errorClass, calls]) => ({ errorClass, calls })).sort((a, b) => b.calls - a.calls),
    slowest: [...rows]
      .sort((a, b) => (b.ms || 0) - (a.ms || 0))
      .slice(0, 10)
      .map(r => ({ at: r.at, job: r.job, model: r.model, ms: r.ms, outcome: r.outcome, promptChars: r.promptChars, overflow: r.overflow })),
    byJob: [...byJob].map(([job, v]) => ({ job, ...v })).sort((a, b) => b.ms - a.ms).slice(0, 20),
  };
}

/** Test seam. */
export function _traceFilePath(): string {
  return traceFile();
}
