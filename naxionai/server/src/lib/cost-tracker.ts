import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "../config.js";

export type CostRecord = {
  jobId: string;
  model: string;
  backend: "ollama" | "openrouter" | "anthropic" | "ideogram" | "muapi" | "ollama_cloud" | "little-coder" | "jev";
  profile: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ts: string;
  // Generative media is billed per unit (image/second), not per token; count
  // is the number of assets. Absent on plain LLM calls.
  units?: number;
  // Absent/true = a successful call, same as every record before this field
  // existed. false marks a call that exhausted every retry/fallback and
  // threw — see recordLlmFailure in llm.ts's terminal-failure path. Lets the
  // Cost page and innovation-scan report a real per-model failure rate
  // instead of only ever seeing successes (failures used to be invisible
  // here entirely — cost was only ever recorded on the success path).
  ok?: boolean;
  error?: string;
};

export type CostSummary = {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
  byModel: { model: string; costUsd: number; calls: number; failed: number; failureRate: number }[];
  byDay: { date: string; costUsd: number; calls: number }[];
  recentCalls: CostRecord[];
};

const COST_REL = "_naxion/cost.jsonl";
const AGGREGATE_REL = "_naxion/cost-summary.json";

// Approximate cost per 1K tokens (USD) per backend/model tier.
// Ollama local is free but we track ~$0 to distinguish from paid.
const COST_PER_1K_INPUT: Record<string, number> = {
  ollama: 0,
  "openrouter/small": 0.00015,   // gpt-4o-mini tier
  "openrouter/medium": 0.003,    // gpt-4o tier
  "openrouter/large": 0.015,     // gpt-4.5 tier
  // Anthropic direct — official per-MTok pricing ÷ 1000 (fable $10/$50,
  // opus 4.x $5/$25, sonnet $3/$15, haiku 4.5 $1/$5).
  "anthropic/fable": 0.010,
  "anthropic/opus": 0.005,
  "anthropic/sonnet": 0.003,
  "anthropic/haiku": 0.001,
  // OpenAI direct (BYO provider / pool fallback) — approximate flagship vs
  // mini split; gpt-5.x flagship-tier and mini-tier ballparks.
  "openai/flagship": 0.00125,
  "openai/mini": 0.00025,
  // OpenAI Realtime (live voice calls) — audio tokens dominate and are billed
  // far above text. Blended audio-tier ballpark ($32/1M in, $64/1M out).
  "openai/realtime": 0.032,
  // Gemini Flash via OpenRouter (paid large tier) — flash-class pricing.
  "gemini/flash": 0.0003,
};
const COST_PER_1K_OUTPUT: Record<string, number> = {
  ollama: 0,
  "openrouter/small": 0.0006,
  "openrouter/medium": 0.015,
  "openrouter/large": 0.075,
  "anthropic/fable": 0.050,
  "anthropic/opus": 0.025,
  "anthropic/sonnet": 0.015,
  "anthropic/haiku": 0.005,
  "openai/flagship": 0.010,
  "openai/mini": 0.002,
  "openai/realtime": 0.064,
  "gemini/flash": 0.0025,
};

// Which billing backend a model id belongs to. The subtle bug this centralises:
// OpenAI-direct ids ("gpt-5.6-terra") and native Claude ids ("claude-fable-5")
// carry NO slash, so the old `includes("/")` test misfiled them as free local
// Ollama and recorded $0. gpt-terra is the ACTIVE provider, so ALL its spend was
// invisible on the Cost page. Classify gpt-\d* ids as paid (label "openrouter",
// the existing paid-call convention) so estimateCost uses the real openai tier.
function detectBackend(model: string): CostRecord["backend"] {
  const lc = (model ?? "").toLowerCase();
  if (/^claude-/i.test(lc)) return "anthropic";
  if (lc.includes("/")) return "openrouter";
  if (/^(gpt-\d|o\d[-\d]|chatgpt|text-embedding|dall-e)/i.test(lc)) return "openrouter";
  return "ollama";
}

function costTier(model: string): string {
  // Realtime voice (gpt-realtime / gpt-4o-realtime-*) — audio-token pricing.
  // Must come before the gpt-\d flagship rule so it isn't misfiled as text.
  if (/realtime/i.test(model)) return "openai/realtime";
  // Native Claude model ids (Anthropic BYO provider) — priced by family.
  if (/^claude-fable|^claude-mythos/i.test(model)) return "anthropic/fable";
  if (/^claude-opus/i.test(model)) return "anthropic/opus";
  if (/^claude-sonnet/i.test(model)) return "anthropic/sonnet";
  if (/^claude-haiku/i.test(model)) return "anthropic/haiku";
  // OpenAI direct ids (gpt-5.x family from the BYO provider / pool fallback).
  if (/^gpt-\d[\d.]*-?(mini|nano)/i.test(model)) return "openai/mini";
  if (/^gpt-\d/i.test(model)) return "openai/flagship";
  // Gemini via OpenRouter ("google/gemini-3.5-flash" etc).
  if (/gemini.*flash/i.test(model)) return "gemini/flash";
  if (/opus|gpt-4\.5|gpt-4-?turbo|claude-3-5-sonnet|claude-opus/i.test(model)) return "openrouter/large";
  if (/gpt-4o(?!-mini)|claude-sonnet|claude-3-haiku|llama-3-70b|mixtral/i.test(model)) return "openrouter/medium";
  return "openrouter/small";
}

function estimateCost(model: string, backend: string, inputTokens: number, outputTokens: number): number {
  if (backend === "ollama" || backend === "ollama_cloud" || backend === "little-coder") return 0;
  // OpenRouter ":free" models cost nothing — don't misreport them as paid.
  if (/:free\b/i.test(model)) return 0;
  const tier = costTier(model);
  const inputRate = COST_PER_1K_INPUT[tier] ?? COST_PER_1K_INPUT["openrouter/small"];
  const outputRate = COST_PER_1K_OUTPUT[tier] ?? COST_PER_1K_OUTPUT["openrouter/small"];
  return (inputTokens / 1000) * inputRate + (outputTokens / 1000) * outputRate;
}

function costPath(): string {
  return resolve(config.vaultPath, COST_REL);
}

function aggregatePath(): string {
  return resolve(config.vaultPath, AGGREGATE_REL);
}

export function recordCost(record: CostRecord): void {
  const full = costPath();
  try { mkdirSync(join(full, ".."), { recursive: true }); } catch { /* tolerate */ }
  appendFileSync(full, JSON.stringify(record) + "\n", "utf8");
}

// Cheap, best-effort recorder wired into the central LLM dispatch so EVERY
// model call is counted. Only appends a JSONL line (the summary aggregates on
// read), so it's safe on the hot path. Was previously dead: trackLlmCall
// existed but nothing called it, so the Cost page always showed zero.
export function recordLlmCost(model: string, outputText: string, inputText: string, systemText?: string, profile = "none", jobId = "adhoc", usage?: { inputTokens: number; outputTokens: number }): void {
  try {
    // Prefer REAL billed token counts (from the provider's usage response)
    // over the chars/4 estimate. The estimate can't see tokens that are
    // billed but never returned as text — e.g. Claude Fable's always-on
    // extended thinking is billed as output but the thinking content is
    // omitted from the response, so estimating from outputText alone
    // systematically undercounted fable-5 calls (2026-07-11: Cost page
    // showed $8.30 against $9.87 actually billed — ~89% of the tracked
    // total was fable-5, which is exactly the model with invisible billed
    // output tokens the old estimate-only path couldn't see).
    const inputTokens = usage?.inputTokens ?? Math.ceil(((inputText?.length ?? 0) + (systemText?.length ?? 0)) / 4);
    const outputTokens = usage?.outputTokens ?? Math.ceil((outputText?.length ?? 0) / 4);
    // Native Claude ids ("claude-fable-5") AND OpenAI-direct ids
    // ("gpt-5.6-terra") have NO slash — without detectBackend() they were
    // misfiled as free "ollama" and recorded at $0 (hid all Fable AND all
    // gpt-terra spend from the Cost page).
    const backend = detectBackend(model);
    const costUsd = estimateCost(model, backend, inputTokens, outputTokens);
    recordCost({ jobId, model, backend, profile, inputTokens, outputTokens, costUsd, ts: new Date().toISOString() });
  } catch { /* cost tracking is best-effort — never break a real LLM call */ }
}

// Records a call that exhausted every retry/fallback and threw. Call ONCE per
// terminal failure (not per retry attempt) from llm.ts, right before the
// error propagates to the caller. $0 cost — it was never billed — but still
// counted per-model so getCostSummary().byModel.failureRate reflects reality
// instead of failures being invisible (the gap this closes: before this,
// cost-tracker only ever ran on the success path).
export function recordLlmFailure(model: string, backend: CostRecord["backend"], profile = "none", error?: string, jobId = "adhoc"): void {
  try {
    recordCost({ jobId, model: model || "unknown", backend, profile, inputTokens: 0, outputTokens: 0, costUsd: 0, ts: new Date().toISOString(), ok: false, error: String(error ?? "").slice(0, 300) });
  } catch { /* best-effort — never break a real failure path over a logging failure */ }
}

// Per-IMAGE cost estimates (USD) for the studio image providers. Image models
// bill per generated asset, not per token, so the LLM token estimate doesn't
// apply. Ballparks by provider (override any with a real invoice later):
//   OpenRouter Gemini flash image ("nano-banana") ~ $0.00003/1K output tokens
//     × ~1290 image tokens ≈ $0.04/image; the paid Pro image tiers cost more.
//   Ideogram v3/v4 ~ $0.06–$0.09 per image (rendering-speed dependent).
//   Muapi varies wildly by model; a mid ballpark until real usage lands.
const IMAGE_COST_PER_UNIT: { test: RegExp; usd: number }[] = [
  { test: /gemini-3-pro-image|imagen-?4-ultra|gpt-5.*image/i, usd: 0.12 },
  { test: /gemini.*image|imagen|nano-banana/i, usd: 0.04 },
  { test: /ideogram/i, usd: 0.08 },
  { test: /flux|seedream|sdxl|hidream|qwen-image|midjourney/i, usd: 0.05 },
];

function imageUnitCost(model: string): number {
  for (const r of IMAGE_COST_PER_UNIT) if (r.test.test(model)) return r.usd;
  return 0.05; // sensible default for an unrecognised paid image model
}

// Record a generated-image cost. provider selects the backend label + a free
// check (an ":free" OpenRouter image model costs nothing). Wired into
// lib/studio-image.ts so every media.image generation lands in the Cost
// monitor alongside text and voice.
export function recordImageCost(provider: "openrouter" | "ideogram" | "muapi", model: string, jobId = "adhoc", units = 1): number {
  const free = /:free\b/i.test(model);
  const costUsd = free ? 0 : imageUnitCost(model) * Math.max(1, units);
  recordCost({
    jobId,
    model,
    backend: provider,
    profile: `image:${provider}`,
    inputTokens: 0,
    outputTokens: 0,
    costUsd,
    units: Math.max(1, units),
    ts: new Date().toISOString(),
  });
  return costUsd;
}

// Live voice calls (OpenAI Realtime) run browser↔provider over WebRTC, so the
// server never sees the token usage the way it does for a normal LLM call. The
// browser reads the per-response usage off the data channel (response.done
// events) and reports it here so realtime spend lands in the Cost monitor
// alongside every other model call. Priced at the realtime audio tier.
export function recordRealtimeVoiceCost(model: string, inputTokens: number, outputTokens: number, jobId = "voice-call"): number {
  const inTok = Math.max(0, Math.round(Number(inputTokens) || 0));
  const outTok = Math.max(0, Math.round(Number(outputTokens) || 0));
  // "openrouter" backend label = a paid (non-ollama) call so estimateCost uses
  // costTier(model), which maps a realtime model to the audio tier above.
  const costUsd = estimateCost(model || "gpt-realtime", "openrouter", inTok, outTok);
  recordCost({ jobId, model: model || "gpt-realtime", backend: "openrouter", profile: "realtime-voice", inputTokens: inTok, outputTokens: outTok, costUsd, ts: new Date().toISOString() });
  return costUsd;
}


function aggregate(records: CostRecord[]): CostSummary {
  // Failure records (ok: false) carry $0 cost and no tokens — exclude them
  // from the cost/token totals (they were never billed) but still count them
  // per-model so failureRate is real.
  const okRecords = records.filter(r => r.ok !== false);
  const totalCostUsd = okRecords.reduce((s, r) => s + r.costUsd, 0);
  const totalInputTokens = okRecords.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutputTokens = okRecords.reduce((s, r) => s + r.outputTokens, 0);
  const byModelMap = new Map<string, { costUsd: number; calls: number; failed: number }>();
  const byDayMap = new Map<string, { costUsd: number; calls: number }>();
  for (const r of records) {
    const m = byModelMap.get(r.model) ?? { costUsd: 0, calls: 0, failed: 0 };
    m.calls++;
    if (r.ok === false) m.failed++;
    else m.costUsd += r.costUsd;
    byModelMap.set(r.model, m);
    if (r.ok !== false) {
      const day = r.ts.slice(0, 10);
      const d = byDayMap.get(day) ?? { costUsd: 0, calls: 0 };
      d.costUsd += r.costUsd; d.calls++; byDayMap.set(day, d);
    }
  }
  return {
    totalCostUsd, totalInputTokens, totalOutputTokens, callCount: okRecords.length,
    byModel: [...byModelMap.entries()].map(([model, v]) => ({ model, costUsd: v.costUsd, calls: v.calls, failed: v.failed, failureRate: v.calls ? v.failed / v.calls : 0 })).sort((a, b) => b.costUsd - a.costUsd),
    byDay: [...byDayMap.entries()].map(([date, v]) => ({ date, costUsd: v.costUsd, calls: v.calls })).sort((a, b) => a.date.localeCompare(b.date)),
    recentCalls: records.slice(-50).reverse(),
  };
}

// Legacy: writes the aggregate snapshot to disk. Kept for compatibility, but
// getCostSummary now aggregates from raw records so the Cost page is always
// live even without this being called.
function rebuildAggregate(): void {
  const full = costPath();
  if (!existsSync(full)) return;
  try {
    const lines = readFileSync(full, "utf8").trim().split("\n").filter(Boolean);
    const records: CostRecord[] = lines.map(l => JSON.parse(l));
    writeFileSync(aggregatePath(), JSON.stringify(aggregate(records), null, 2), "utf8");
  } catch { /* ignore corrupt data */ }
}

// The dashboard polls /api/cost/summary; re-reading + re-parsing the whole
// JSONL every poll is O(file) work that grows forever. Cache the aggregate
// keyed on the file's (mtime, size) — any append changes both, so the cache
// invalidates itself without a TTL and the summary stays exact.
let summaryCache: { key: string; summary: CostSummary } | null = null;

export function getCostSummary(): CostSummary {
  const full = costPath();
  let key = "empty";
  try {
    if (existsSync(full)) {
      const st = statSync(full);
      key = `${st.mtimeMs}:${st.size}`;
    }
  } catch { /* fall through to a fresh aggregate */ }
  if (summaryCache && summaryCache.key === key) return summaryCache.summary;
  const summary = aggregate(getCostRecords());
  summaryCache = { key, summary };
  return summary;
}

export function getCostRecords(since?: string): CostRecord[] {
  const full = costPath();
  if (!existsSync(full)) return [];
  try {
    const lines = readFileSync(full, "utf8").trim().split("\n").filter(Boolean);
    const records: CostRecord[] = lines.map(l => JSON.parse(l));
    if (since) {
      const sinceTs = new Date(since).getTime();
      return records.filter(r => new Date(r.ts).getTime() >= sinceTs);
    }
    return records;
  } catch {
    return [];
  }
}

// Wraps an LLM call to track cost. Callers replace their llmGenerate / llmGenerateWithMeta
// call with this wrapper. Estimates tokens from string length ÷ 4 (same heuristic as llm.ts).
export async function trackLlmCall<T extends { text: string; model: string }>(
  jobId: string,
  call: () => Promise<T>,
  profile: string,
  inputText: string,
  systemText?: string,
): Promise<T> {
  const inputTokens = Math.ceil((inputText.length + (systemText?.length ?? 0)) / 4);
  const result = await call();
  const outputTokens = Math.ceil(result.text.length / 4);
  // Same detectBackend rule as recordLlmCost — "claude-fable-5" and
  // "gpt-5.6-terra" have no slash and were misfiled as free local ollama here too.
  const detectedBackend = detectBackend(result.model);
  const costUsd = estimateCost(result.model, detectedBackend, inputTokens, outputTokens);
  const record: CostRecord = {
    jobId,
    model: result.model,
    backend: detectedBackend,
    profile,
    inputTokens,
    outputTokens,
    costUsd,
    ts: new Date().toISOString(),
  };
  recordCost(record);
  rebuildAggregate();
  return result;
}
