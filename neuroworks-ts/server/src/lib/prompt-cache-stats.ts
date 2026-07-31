// Prompt-cache effectiveness metrics.
//
// The cloud providers we use (OpenAI's gpt-* family, Anthropic's claude-*)
// apply AUTOMATIC prompt caching to a stable ≥1024-token prefix and report the
// hit as `prompt_tokens_details.cached_tokens` (OpenAI) or
// `cache_read_input_tokens` (Anthropic) in the usage payload. Until now we
// captured only prompt_tokens/completion_tokens, so cache effectiveness was
// invisible — you couldn't tell a well-cached prefix from a busted one.
//
// This module aggregates, per profile and per model, how many input tokens were
// served from cache vs billed fresh, so /api/cost/cache-stats can show whether
// caching is actually working and a tuning change moved the needle.

type Bucket = {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  callsWithCache: number; // calls where cachedInputTokens > 0
};

function emptyBucket(): Bucket {
  return { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, callsWithCache: 0 };
}

// key = `${profile}` and `${profile}::${model}` — we keep both so the snapshot
// can show per-profile totals and a per-model breakdown without a second pass.
const byProfile = new Map<string, Bucket>();
const byProfileModel = new Map<string, Bucket>();

function add(map: Map<string, Bucket>, key: string, s: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): void {
  let b = map.get(key);
  if (!b) { b = emptyBucket(); map.set(key, b); }
  b.calls += 1;
  b.inputTokens += s.inputTokens;
  b.cachedInputTokens += s.cachedInputTokens;
  b.outputTokens += s.outputTokens;
  if (s.cachedInputTokens > 0) b.callsWithCache += 1;
}

export function recordCacheStat(input: {
  profile: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}): void {
  const profile = input.profile || "none";
  const s = { inputTokens: input.inputTokens, cachedInputTokens: input.cachedInputTokens, outputTokens: input.outputTokens };
  add(byProfile, profile, s);
  add(byProfileModel, `${profile}::${input.model}`, s);
  // One-line breadcrumb so cache effectiveness is greppable in the server log
  // even without hitting the stats endpoint. Ratio is cached / input.
  const ratio = input.inputTokens > 0 ? Math.round((input.cachedInputTokens / input.inputTokens) * 100) : 0;
  console.log(`[cache] profile=${profile} model=${input.model} input=${input.inputTokens} cached=${input.cachedInputTokens} (${ratio}%) out=${input.outputTokens}`);
}

function view(b: Bucket) {
  return {
    calls: b.calls,
    callsWithCache: b.callsWithCache,
    inputTokens: b.inputTokens,
    cachedInputTokens: b.cachedInputTokens,
    outputTokens: b.outputTokens,
    // Share of input tokens served from cache — the headline "is caching
    // working" number. Only meaningful once a prefix has been seen twice.
    cacheHitRatio: b.inputTokens > 0 ? Number((b.cachedInputTokens / b.inputTokens).toFixed(3)) : 0,
  };
}

export function cacheStatsSnapshot(): {
  profiles: Record<string, ReturnType<typeof view>>;
  models: Record<string, ReturnType<typeof view>>;
  overall: ReturnType<typeof view>;
} {
  const profiles: Record<string, ReturnType<typeof view>> = {};
  for (const [k, b] of byProfile) profiles[k] = view(b);
  const models: Record<string, ReturnType<typeof view>> = {};
  for (const [k, b] of byProfileModel) models[k] = view(b);
  const total = emptyBucket();
  for (const b of byProfile.values()) {
    total.calls += b.calls; total.callsWithCache += b.callsWithCache;
    total.inputTokens += b.inputTokens; total.cachedInputTokens += b.cachedInputTokens; total.outputTokens += b.outputTokens;
  }
  return { profiles, models, overall: view(total) };
}

export function resetCacheStats(): void {
  byProfile.clear();
  byProfileModel.clear();
}
