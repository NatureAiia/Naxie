// Retrieval telemetry — one JSONL line per ragSearch() call, so the weekly
// self-improvement review can see how well retrieval is actually serving
// Naxie (zero-hit rate, queries that keep coming back empty, whether the
// semantic path is live) and propose concrete fixes (reindex, re-embed,
// capture notes on missing topics).
//
// Recording is fire-and-forget and never throws — retrieval is on the hot
// path of every chat turn. The file is capped so it can't grow unbounded.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.naxion");
const DEFAULT_FILE = join(STATE_DIR, "rag-telemetry.jsonl");
const MAX_LINES = 5000;
// Trim only every N appends — rewriting the file on every call would make
// telemetry the slowest part of retrieval.
const TRIM_EVERY = 250;

export type RagQueryRecord = {
  ts: string;
  query: string;
  hitCount: number;
  sources: { index: number; memory: number; vaultScan: number; vector: number; structured?: number };
  topScore: number;
  ms: number;
  vectorEnabled: boolean;
};

export type RagTelemetrySummary = {
  totalQueries: number;
  zeroHitQueries: number;
  zeroHitRate: number;         // 0..1
  lowHitQueries: number;       // < 2 hits
  avgLatencyMs: number;
  vectorEnabledShare: number;  // 0..1 — share of queries where semantic search was live
  sourceShare: { index: number; memory: number; vaultScan: number; vector: number; structured?: number }; // share of all hits
  fallbackScanShare: number;   // share of queries that needed the slow vault walk
  topMissedTerms: { term: string; count: number }[];
  sampleMissedQueries: string[];
};

let file = DEFAULT_FILE;
let appendsSinceTrim = 0;

export function _setTelemetryFileForTests(path: string): void {
  file = path;
  appendsSinceTrim = 0;
}

function trim(): void {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_LINES) writeFileSync(file, lines.slice(-MAX_LINES).join("\n") + "\n");
  } catch { /* best-effort */ }
}

export function recordRagQuery(rec: Omit<RagQueryRecord, "ts"> & { ts?: string }): void {
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const full: RagQueryRecord = { ...rec, query: rec.query.slice(0, 300), ts: rec.ts ?? new Date().toISOString() };
    appendFileSync(file, JSON.stringify(full) + "\n");
    if (++appendsSinceTrim >= TRIM_EVERY) { appendsSinceTrim = 0; trim(); }
  } catch { /* telemetry must never break retrieval */ }
}

export function readRagTelemetry(sinceMs = 0): RagQueryRecord[] {
  try {
    if (!existsSync(file)) return [];
    const out: RagQueryRecord[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as RagQueryRecord;
        if (Date.parse(r.ts) >= sinceMs) out.push(r);
      } catch { /* skip corrupt line */ }
    }
    return out;
  } catch { return []; }
}

const STOPWORDS = new Set("a an and are as at be by can do does for from how i in is it me my of on or our please show tell that the this to was what when where which who why with you your".split(" "));

export function summarizeRagTelemetry(records: RagQueryRecord[]): RagTelemetrySummary {
  const n = records.length;
  const zero = records.filter(r => r.hitCount === 0);
  const low = records.filter(r => r.hitCount < 2);
  const totalHits = { index: 0, memory: 0, vaultScan: 0, vector: 0, structured: 0 };
  for (const r of records) {
    totalHits.index += r.sources.index;
    totalHits.memory += r.sources.memory;
    totalHits.vaultScan += r.sources.vaultScan;
    totalHits.vector += r.sources.vector;
    totalHits.structured += r.sources.structured ?? 0;
  }
  const hitSum = totalHits.index + totalHits.memory + totalHits.vaultScan + totalHits.vector + totalHits.structured;
  const share = (x: number) => (hitSum ? x / hitSum : 0);

  const termCounts = new Map<string, number>();
  for (const r of zero) {
    const terms = new Set(r.query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOPWORDS.has(t)));
    for (const t of terms) termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
  }
  const topMissedTerms = [...termCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([term, count]) => ({ term, count }));

  return {
    totalQueries: n,
    zeroHitQueries: zero.length,
    zeroHitRate: n ? zero.length / n : 0,
    lowHitQueries: low.length,
    avgLatencyMs: n ? Math.round(records.reduce((s, r) => s + r.ms, 0) / n) : 0,
    vectorEnabledShare: n ? records.filter(r => r.vectorEnabled).length / n : 0,
    sourceShare: { index: share(totalHits.index), memory: share(totalHits.memory), vaultScan: share(totalHits.vaultScan), vector: share(totalHits.vector), structured: share(totalHits.structured) },
    fallbackScanShare: n ? records.filter(r => r.sources.vaultScan > 0).length / n : 0,
    topMissedTerms,
    sampleMissedQueries: [...new Set(zero.map(r => r.query))].slice(-8),
  };
}
