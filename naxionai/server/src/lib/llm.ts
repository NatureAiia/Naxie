import { config } from "../config.js";
import { pickModelFor, type TaskNeeds } from "./models.js";
import { openrouterGenerateWithMeta, openrouterHealth, isTransientError, openrouterCircuitOpen, openrouterDailyQuotaExhausted, openrouterBillingExhausted } from "./openrouter.js";
import { recordLlmCost, recordLlmFailure } from "./cost-tracker.js";
import { isCloudReachableCached } from "./connectivity.js";
import { isOffline } from "./offline-mode.js";
import { withLocalLlmSlot } from "./llm-lane.js";
import { currentJobId, currentJobSignal } from "./job-scope.js";
import { recordTrace, classifyError, hashPrompt } from "./llm-trace.js";

export type LLMCallOptions = {
  model?: string;
  profile?: "planning" | "synthesis" | "triage" | "extraction" | "balanced";
  needs?: TaskNeeds;
  onToken?: (chunk: string, accumulated: string) => void;
  // Explicit complexity hint from the caller. "high" forces the LARGE OR
  // model when OR is available (great for big synthesis with lots of
  // evidence, deep reasoning, code-heavy analysis). "normal" is the default.
  // The size-based heuristic also marks calls as "high" automatically.
  complexity?: "normal" | "high";
  // Hard cap on tokens the model can generate. Maps to Ollama's `num_predict`
  // and OpenRouter's `max_tokens`. Useful for simple-task synth (~250 words is
  // plenty), triage (one word), or quality.check (small JSON). Tighter caps
  // mean the model stops generating sooner, which on local Ollama is the
  // dominant cost on simple tasks. Default is 1024 (~750 words).
  maxTokens?: number;
  // Wall-clock budget for THIS call (ms). Bounds the whole attempt — connect,
  // retries, and streaming — so a stalled backend fails fast instead of
  // hanging to the caller's outer cap (the scan/audit synthesis loops raced
  // an 8-min cap against attempts with only a 15-min abort, so every stall
  // burned the full 8 min before the findings-only fallback could land).
  // Absent = provider default (15 min). Synthesis-grade callers pass ~3 min.
  timeoutMs?: number;
  /** Cancellation signal; defaults to the active job's signal when present. */
  signal?: AbortSignal;
  // Override the default sampling temperature (Ollama default 0.3, OR default
  // 0.3). Pass 0 to pin deterministic output — useful for scorers/graders
  // where run-to-run noise corrupts the metric. Applies to both backends.
  temperature?: number;
  // Notified once when the dispatcher picks a backend + model. Lets the
  // caller surface routing decisions in customer-facing logs (e.g. push
  // "Bumped to GPT-4o for the synth — 8k tokens of evidence" into the chat
  // run log so customers can see when their request used a big model and
  // when it stayed local). Fires BEFORE the LLM call begins.
  onRoutingDecision?: (info: { backend: Backend; model: string; reason?: string; tokenEstimate: number }) => void;
};

export type Backend = "ollama" | "openrouter" | "little-coder" | "ollama_cloud";

// A separate FIFO lane protects remote provider quotas from planner fan-out.
// Local inference has its own measured lane in llm-lane.ts.
const REMOTE_LLM_CAP = (() => {
  const raw = process.env.NAXION_REMOTE_LLM_LANE?.trim();
  const value = raw ? Number(raw) : 2;
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 2;
})();
type RemoteWaiter = { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void };
const remoteLanes = new Map<string, { active: number; waiters: RemoteWaiter[] }>();

async function withRemoteLlmSlot<T>(provider: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (REMOTE_LLM_CAP <= 0) return fn(); // explicit unbounded mode
  if (signal?.aborted) throw new Error("aborted before acquiring remote LLM slot");
  const lane = remoteLanes.get(provider) ?? { active: 0, waiters: [] };
  remoteLanes.set(provider, lane);
  if (lane.active >= REMOTE_LLM_CAP) {
    await new Promise<void>((resolve, reject) => {
      const waiter: RemoteWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = lane.waiters.indexOf(waiter);
          if (index >= 0) {
            lane.waiters.splice(index, 1);
            signal.removeEventListener("abort", waiter.onAbort!);
            reject(new Error("aborted while waiting for a remote LLM slot"));
            if (lane.active === 0 && lane.waiters.length === 0) remoteLanes.delete(provider);
          }
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      lane.waiters.push(waiter);
      if (signal?.aborted) waiter.onAbort?.();
    });
  } else lane.active++;
  try {
    return await fn();
  } finally {
    const next = lane.waiters.shift();
    if (next) {
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      next.resolve();
    }
    else lane.active = Math.max(0, lane.active - 1);
    if (lane.active === 0 && lane.waiters.length === 0) remoteLanes.delete(provider);
  }
}

const PROFILE_ENV_KEYS: Record<NonNullable<LLMCallOptions["profile"]>, string> = {
  planning:   "OPENROUTER_PLAN_MODEL",
  synthesis:  "OPENROUTER_SYNTH_MODEL",
  triage:     "OPENROUTER_TRIAGE_MODEL",
  extraction: "OPENROUTER_EXTRACT_MODEL",
  balanced:   "OPENROUTER_BALANCED_MODEL",
};

// OR model names always contain a slash provider prefix (e.g. "openai/gpt-4o-mini",
// "anthropic/claude-3.5-haiku"). Ollama tags use ":" for the param suffix
// (e.g. "qwen2.5:3b"). This lets a caller hand us an explicit model name and
// we route to the right backend without an extra flag.
function looksRemote(modelName: string): boolean {
  return modelName.includes("/");
}

function pickOpenRouterModelFor(profile: LLMCallOptions["profile"]): string {
  if (profile) {
    const envName = process.env[PROFILE_ENV_KEYS[profile]]?.trim();
    if (envName) return envName;
  }
  return config.openrouterModel;
}

// Pick the LARGE-tier OR model. Used when:
//   • caller passed complexity: "high" explicitly
//   • prompt was auto-routed because it exceeds local context budget
// Per-profile env pins still win (they're explicit), but only if the per-
// profile model name *looks* large itself — otherwise we override to the
// large default. This keeps "complex synth uses Sonnet" working even when
// the user pinned OPENROUTER_SYNTH_MODEL=openai/gpt-4o-mini.
function pickLargeOpenRouterModel(profile: LLMCallOptions["profile"]): string {
  // Respect per-profile pin only if it's NOT the small default (heuristic:
  // gpt-4o-mini / haiku / mistral-7b are small; full gpt-4o / sonnet / opus
  // are large). When the pin equals the small default OR a known-mini
  // identifier, we override to OPENROUTER_LARGE_MODEL.
  const pin = profile ? process.env[PROFILE_ENV_KEYS[profile]]?.trim() : "";
  if (pin && !/mini|haiku|nano|7b|small|flash/i.test(pin) && pin !== config.openrouterModel) {
    return pin;
  }
  return config.openrouterLargeModel;
}

// Decide whether a given profile should route to OpenRouter.
//   1. OR must be enabled (key present)
//
// CLOUD-FIRST (operator policy): when online, everything rides the cloud
// tiers — small/fast by default, large on complexity — and local models are
// the last resort (transient-failure fallback) or the offline-mode engine.
// Unprofiled calls land on the cheap small tier; triage follows the same
// default now (it used to stay local — a remote Flash-class call is fast
// enough that the latency argument no longer holds).
//
// Explicit scoping still wins: a per-profile OPENROUTER_<PROFILE>_MODEL pin,
// a non-empty OPENROUTER_PROFILES list (unlisted profiles stay local), or
// NAXION_LOCAL_TRIAGE=1 (restores local-only triage).
//
// The empty-profiles fallback only kicks in when OPENROUTER_PROFILES is
// genuinely unset. If the user sets OPENROUTER_PROFILES=planning, they're
// scoping OR to ONLY planning — synthesis stays on Ollama.
function shouldRouteToOpenRouter(profile?: LLMCallOptions["profile"]): boolean {
  if (!config.openrouterEnabled) return false;
  // Live reachability gate (task 2): if we've probed recently and are
  // offline, don't route to cloud at all — go straight to Ollama ordered
  // by size. `null` means no fresh probe, so we still try.
  const cached = isCloudReachableCached();
  if (cached === false) return false;
  if (!profile) return true;
  if (profile === "triage") {
    if (process.env.NAXION_LOCAL_TRIAGE === "1") return false;
    if (process.env[PROFILE_ENV_KEYS[profile]]?.trim()) return true;
    return config.openrouterProfiles.length > 0 ? config.openrouterProfiles.includes(profile) : true;
  }
  if (process.env[PROFILE_ENV_KEYS[profile]]?.trim()) return true;
  if (config.openrouterProfiles.length > 0) return config.openrouterProfiles.includes(profile);
  return true;
}

// Approximate token count for a string. Real tokenisation costs a tokenizer
// load + per-string call we don't want on the hot path. ~4 chars/token is a
// reasonable mid-point across English prose, code, and JSON — good enough to
// decide "this is big enough to overflow local context".
function estimateTokens(s: string | undefined): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

// Local Ollama context window for our default model. qwen2.5:3b ships with
// 8k context (we also set num_ctx=8192 in ollama-side opts). Anything over
// ~6k input tokens leaves no room for output — those calls SHOULD route to
// OR which has 128k+ on gpt-4o-mini. Tunable via env so a user with a 32k
// local model can raise the bar.
const LOCAL_CONTEXT_BUDGET_TOKENS = Number(process.env.NAXION_LOCAL_CTX_BUDGET ?? "6000");
// Hard-complexity fallback: even if OR profiles aren't configured, a call
// over this size goes to OR when the key is set. Saves the customer from
// silent context-overflow truncation on Ollama. Set NAXION_LOCAL_CTX_BUDGET=0
// to disable this complexity-based override entirely.
function isTooBigForLocal(prompt: string, system: string | undefined): boolean {
  if (LOCAL_CONTEXT_BUDGET_TOKENS <= 0) return false;
  const total = estimateTokens(prompt) + estimateTokens(system);
  return total > LOCAL_CONTEXT_BUDGET_TOKENS;
}

// Folds the Settings → Models effort dial into the complexity decision.
// "high" always escalates (customer is explicitly asking for the best answer
// regardless of cost/latency). "low" still honours an explicit caller
// complexity:"high" — those are correctness-critical call sites (SQL gen,
// synthesis over a lot of evidence), not something a speed preference should
// downgrade — but ignores the size-based auto-escalation so a big-but-routine
// prompt stays on the cheap/fast path. "auto" is the pre-existing behaviour.
function isComplexCall(opts: LLMCallOptions, sizeTriggered: boolean): boolean {
  if (config.effortMode === "high") return true;
  if (config.effortMode === "low") return opts.complexity === "high";
  return opts.complexity === "high" || sizeTriggered;
}

async function chooseBackendAndModel(opts: LLMCallOptions, prompt: string, system: string | undefined): Promise<{ backend: Backend; model: string; reason?: string }> {
  // Complexity inference: either explicit ("high"), size-based, or forced by
  // the effort dial.
  const sizeTriggered = isTooBigForLocal(prompt, system);
  const isComplex = isComplexCall(opts, sizeTriggered);

  // Offline mode (Settings → header "Go offline"): never route to a cloud
  // provider or its fallback pool — local Ollama only, sized by profile.
  if (isOffline()) {
    const model = opts.model && !looksRemote(opts.model)
      ? opts.model
      : opts.profile ? await pickModelFor(opts.profile, config.ollamaModel) : config.ollamaModel;
    return { backend: "ollama", model, reason: "offline mode — local model only" };
  }

  if (opts.model) {
    if (looksRemote(opts.model) && config.openrouterEnabled) {
      return { backend: "openrouter", model: opts.model, reason: `explicit remote model "${opts.model}"` };
    }
    // Explicit local model that's too big for local context → bump to OR
    // (if available and actually reachable) with the LARGE-tier OR model.
    if (config.openrouterEnabled && isComplex && isCloudReachableCached() !== false) {
      const model = pickLargeOpenRouterModel(opts.profile);
      return {
        backend: "openrouter",
        model,
        reason: opts.complexity === "high"
          ? `caller flagged complexity:"high" — handing off to large model ${model}`
          : `prompt ~${estimateTokens(prompt) + estimateTokens(system)} tokens exceeds local context budget (${LOCAL_CONTEXT_BUDGET_TOKENS}) — auto-handoff to large model ${model}`,
      };
    }
    return { backend: "ollama", model: opts.model };
  }
  // Profile-based routing wins next — but if it's also complex, upgrade to the
  // large-tier model instead of the small default.
  if (shouldRouteToOpenRouter(opts.profile)) {
    if (isComplex) {
      const model = pickLargeOpenRouterModel(opts.profile);
      return { backend: "openrouter", model, reason: `profile "${opts.profile}" + complex task — handoff to large model ${model}` };
    }
    return { backend: "openrouter", model: pickOpenRouterModelFor(opts.profile), reason: `profile "${opts.profile}" routed to OpenRouter via config` };
  }
  // Complexity override: even when the profile would have stayed local, a
  // huge prompt won't fit in local context. Bump it to OR's LARGE-tier
  // (only if actually online — offline goes straight to Ollama sized by score).
  if (config.openrouterEnabled && isComplex && isCloudReachableCached() !== false) {
    const model = pickLargeOpenRouterModel(opts.profile);
    return {
      backend: "openrouter",
      model,
      reason: opts.complexity === "high"
        ? `caller flagged complexity:"high" — handoff to large model ${model}`
        : `prompt ~${estimateTokens(prompt) + estimateTokens(system)} tokens exceeds local context budget (${LOCAL_CONTEXT_BUDGET_TOKENS}) — auto-handoff to large model ${model}`,
    };
  }
  if (opts.profile) {
    return { backend: "ollama", model: await pickModelFor(opts.profile, config.ollamaModel) };
  }
  return { backend: "ollama", model: config.ollamaModel };
}

// How long Ollama keeps the model resident after a call. Ollama's default is
// "5m"; on a bursty agent workload the model unloads between tasks and every
// cold call pays a multi-second reload AND loses the warm prefix KV cache
// (repeated planning/synth prompts share a large static prefix that Ollama can
// otherwise reuse). Keep it warm for 30m by default. "-1" pins it in memory
// indefinitely; "0" restores the eager-unload behaviour. Env-tunable.
const OLLAMA_KEEP_ALIVE = (process.env.NAXION_OLLAMA_KEEP_ALIVE ?? "30m").trim();
/** Local context window — used both for the actual /api/generate call and llm-trace.ts's overflow detection. */
const OLLAMA_CTX = 8192;

// Raw Ollama streaming call — same as the original ollamaGenerate body but
// without the routing logic (that's now upstream in llmGenerateWithMeta).
async function callOllamaStream(prompt: string, system: string | undefined, model: string, onToken?: LLMCallOptions["onToken"], maxTokens?: number, temperature?: number, timeoutMs?: number, signal?: AbortSignal): Promise<{ text: string; model: string }> {
  // qwen3 ships with reasoning mode on by default. The /no_think directive in
  // the SYSTEM prompt (not user) suppresses the <think>…</think> block.
  const isQwen3 = /qwen3/i.test(model) && !/qwen3\.5/i.test(model);
  const sys = isQwen3 ? `${system ?? ""}\n/no_think`.trim() : system;
  const numPredict = typeof maxTokens === "number" && maxTokens > 0 ? Math.min(8192, Math.max(8, Math.floor(maxTokens))) : 1024;

  // One global FIFO lane for local inference (llm-lane.ts) — concurrency was
  // previously bounded in three unrelated, non-shared places (job cap,
  // per-run sub-agent budget, worker count), which could aim more requests
  // at Ollama than OLLAMA_NUM_PARALLEL actually serves; the surplus queued
  // inside Ollama holding open HTTP streams and burning the caller's own
  // timeout. This wraps exactly one HTTP request and never nests another
  // slot acquisition inside itself, so a slot holder can never deadlock.
  return withLocalLlmSlot(() => callOllamaStreamInner(prompt, sys, model, onToken, numPredict, temperature, timeoutMs, signal), signal);
}

async function callOllamaStreamInner(prompt: string, sys: string | undefined, model: string, onToken: LLMCallOptions["onToken"] | undefined, numPredict: number, temperature: number | undefined, timeoutMs: number | undefined, signal?: AbortSignal): Promise<{ text: string; model: string }> {
  const ctrl = new AbortController();
  const abortFromCaller = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => ctrl.abort(), Math.max(5_000, timeoutMs ?? 15 * 60_000));
  try {
    const res = await fetch(`${config.ollamaHost}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        system: sys,
        stream: true,
        think: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { temperature: typeof temperature === "number" ? temperature : 0.3, num_ctx: OLLAMA_CTX, num_predict: numPredict },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body}`);
    }
    if (!res.body) throw new Error("Ollama: empty response body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let response = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as { response?: string; error?: string };
          if (evt.error) throw new Error(`Ollama: ${evt.error}`);
          if (evt.response) {
            response += evt.response;
            if (onToken) { try { onToken(evt.response, response); } catch { /* consumer error */ } }
          }
        } catch (e: any) {
          if (e.message?.startsWith("Ollama: ")) throw e;
          // tolerate malformed line — Ollama sometimes splits a JSON across reads
        }
      }
    }
    return { text: response.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(), model };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

// Unified entry point. Dispatches to OpenRouter or Ollama based on routing
// rules and returns both the text and the model that actually answered, so
// step-level provenance shows up in StepRun + the vault journal.
//
// OpenRouter failures split two ways. CONFIG errors (401/403/400, unknown
// model) still throw — silent fallback there would mask a real misconfig.
// TRANSIENT errors (429 rate-limit, 5xx, network) instead fall back to the
// local Ollama model when no token has streamed yet, so a temporary upstream
// rate-limit doesn't fail the whole task with a partial result. Disable the
// fallback with NAXION_OR_FALLBACK_OLLAMA=0.
// Public entry — wraps the dispatcher to record cost for EVERY call (this is
// how the Cost monitor page gets its data; recording is best-effort and never
// blocks or breaks the actual generation).
export async function llmGenerateWithMeta(prompt: string, system?: string, opts: LLMCallOptions = {}): Promise<{ text: string; model: string; usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } }> {
  const jobId = currentJobId() ?? "adhoc";
  const t0 = Date.now();
  // Captures the LATEST routing decision generateWithMetaInner reports (a
  // fallback mid-call replaces an earlier one), without recomputing it —
  // chooseBackendAndModel is only a cheap heuristic pick, but re-deriving it
  // here could disagree with what the call actually used once a fallback
  // fires. Forwards to the caller's own onRoutingDecision, if any.
  let routing: { backend: Backend; model: string; reason?: string; tokenEstimate: number } | undefined;
  const callerOnRoutingDecision = opts.onRoutingDecision;
  const tracedOpts: LLMCallOptions = {
    ...opts,
    onRoutingDecision: (info) => {
      routing = info;
      try { callerOnRoutingDecision?.(info); } catch { /* consumer error */ }
    },
  };
  let result: { text: string; model: string; usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } };
  try {
    result = await generateWithMetaInner(prompt, system, tracedOpts);
  } catch (e: any) {
    // Cancellation is not a model/provider failure and should not poison
    // failure-rate dashboards or trigger degraded-model routing decisions.
    if ((opts.signal ?? currentJobSignal())?.aborted) throw e;
    // Terminal failure — every retry/fallback in generateWithMetaInner is
    // exhausted. Record it once (previously invisible: cost-tracker only ever
    // ran on the success path below) so byModel.failureRate is real, then
    // rethrow unchanged — this is purely an observability hook.
    try {
      const { backend, model } = routing ?? await chooseBackendAndModel(opts, prompt, system);
      recordLlmFailure(model, backend, opts.profile ?? "none", e?.message ?? String(e), jobId);
      const { outcome, errorClass } = classifyError(e);
      recordTrace({
        at: new Date().toISOString(), job: jobId, call: "llmGenerateWithMeta", backend, model,
        profile: opts.profile, reason: routing?.reason,
        promptChars: prompt.length, systemChars: (system ?? "").length,
        estTokens: routing?.tokenEstimate ?? 0,
        ctx: backend === "ollama" ? OLLAMA_CTX : undefined,
        overflow: backend === "ollama" && !!routing?.tokenEstimate && routing.tokenEstimate > OLLAMA_CTX,
        ms: Date.now() - t0, outcome, errorClass, promptHash: hashPrompt(prompt, system),
      });
    } catch { /* best-effort */ }
    throw e;
  }
  try { recordLlmCost(result.model, result.text, prompt, system, opts.profile ?? "none", jobId, result.usage); } catch { /* best-effort */ }
  try {
    recordTrace({
      at: new Date().toISOString(), job: jobId, call: "llmGenerateWithMeta",
      backend: routing?.backend ?? "ollama", model: result.model,
      profile: opts.profile, reason: routing?.reason,
      promptChars: prompt.length, systemChars: (system ?? "").length,
      estTokens: routing?.tokenEstimate ?? 0,
      ctx: routing?.backend === "ollama" ? OLLAMA_CTX : undefined,
      overflow: routing?.backend === "ollama" && !!routing?.tokenEstimate && routing.tokenEstimate > OLLAMA_CTX,
      inTok: result.usage?.inputTokens, outTok: result.usage?.outputTokens,
      ms: Date.now() - t0, outcome: "ok", promptHash: hashPrompt(prompt, system),
    });
  } catch { /* best-effort */ }
  // Prompt-cache effectiveness metric — only cloud providers report cached
  // prefix tokens (usage present). Best-effort; never blocks generation.
  try {
    if (result.usage) {
      const { recordCacheStat } = await import("./prompt-cache-stats.js");
      recordCacheStat({
        profile: opts.profile ?? "none",
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cachedInputTokens: result.usage.cachedInputTokens ?? 0,
      });
    }
  } catch { /* best-effort */ }
  return result;
}

async function generateWithMetaInner(prompt: string, system?: string, opts: LLMCallOptions = {}): Promise<{ text: string; model: string; usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } }> {
  const signal = opts.signal ?? currentJobSignal();
  // Kuwana-inspired budget gate — before any paid dispatch, check monthly cap
  try {
    const { checkBudget } = await import("./ai/budget.js");
    const b = checkBudget();
    if (!b.allowed) {
      const fb = (await import("./ai/budget.js")).AiBudgetExceededError;
      throw new fb(b.spentUsd, b.budgetUsd);
    }
  } catch (e: any) { if (e?.name === "AiBudgetExceededError") throw e; /* budget file missing = open */ }
  let { backend, model, reason } = await chooseBackendAndModel(opts, prompt, system);
  // Paid-model approval gate — free online models (OpenRouter free tier,
  // Gemini Flash) are the primary pick; local Ollama is the last-resort
  // fallback; anything that actually bills stays off unless the operator
  // has explicitly approved paid models (Settings > Models). Downgrades
  // instead of erroring so a routine chat message doesn't just fail.
  if (backend === "openrouter") {
    try {
      const { isFreeModelId, getModelPolicy } = await import("./model-policy.js");
      if (!isFreeModelId(model) && !getModelPolicy().allowPaidModels) {
        const freeSmallModel = pickOpenRouterModelFor(opts.profile);
        if (isFreeModelId(freeSmallModel) && freeSmallModel !== model) {
          reason = `paid model "${model}" needs approval (Settings → Models → Allow paid models) — using free tier "${freeSmallModel}" instead`;
          model = freeSmallModel;
        } else {
          const localModel = opts.profile ? await pickModelFor(opts.profile, config.ollamaModel) : config.ollamaModel;
          reason = `paid model "${model}" needs approval (Settings → Models → Allow paid models) — falling back to local ${localModel}`;
          backend = "ollama";
          model = localModel;
        }
      }
    } catch { /* policy check is best-effort — never block a call on its own failure */ }
  }
  const tokenEstimate = estimateTokens(prompt) + estimateTokens(system);
  // Customer-facing notification: caller decides whether to push the
  // routing decision into the chat run log. We pass enough context for the
  // caller to render "thinking with <model> because <reason>" themselves.
  if (opts.onRoutingDecision) {
    try { opts.onRoutingDecision({ backend, model, reason, tokenEstimate }); } catch { /* consumer error */ }
  }
  // One-line stdout breadcrumb when the complexity-based override kicks in,
  // so a customer scanning the server log can see "this synth was bumped to
  // OR because it was 8k tokens" without digging through job logs.
  if (reason && (reason.includes("auto-routed") || reason.includes("auto-handoff") || reason.includes("complex task"))) {
    console.log(`[llm] ${reason} (profile=${opts.profile ?? "none"})`);
  }
  if (backend === "openrouter") {
    // Track whether any token reached the consumer. A transient failure
    // (429/5xx) BEFORE streaming starts can fall back to the local model
    // cleanly; once tokens have streamed, falling back would double-emit, so
    // we rethrow. A 429 is rate-limiting, not the config error the original
    // no-fallback rule guarded against — so failing the whole task is wrong.
    let streamed = false;
    const onToken = opts.onToken
      ? (chunk: string, acc: string) => { streamed = true; opts.onToken!(chunk, acc); }
      : undefined;
    try {
      return await withRemoteLlmSlot("openrouter", () => openrouterGenerateWithMeta(prompt, system, { model, onToken, maxTokens: opts.maxTokens, temperature: opts.temperature, timeoutMs: opts.timeoutMs, signal }), signal);
    } catch (e: any) {
      const fallbackOn = process.env.NAXION_OR_FALLBACK_OLLAMA !== "0";
      if (isTransientError(e) && fallbackOn && !streamed) {
        // PROVIDER-POOL FAILOVER (2026-07-12): before dropping all the way
        // to the 3B local model, walk the other registered providers in the
        // operator's Models-page order (getFallbackChain — position-sorted).
        // Same OpenAI-compatible client, different endpoint+key+model; each
        // fallback call bypasses OR's circuit breaker (see openrouter.ts).
        // Complexity tier is preserved: a complex task falls to the
        // fallback's LARGE model, everything else to its cheap small one.
        // Local Ollama stays the final safety net, exactly as before.
        try {
          const { getFallbackChain } = await import("./model-providers.js");
          const { isFreeModelId, getModelPolicy } = await import("./model-policy.js");
          // Paid-model gate for failover: the primary-pick gate above keeps
          // paid models off unless approved, but this loop used to dispatch
          // fp.largeModel verbatim — silently spending on e.g. Anthropic
          // Fable while policy said paid OFF (2026-09-28: $0.08 on
          // openai/gpt-4o with allowPaidModels=false). Same rule here:
          // prefer the fallback's cheap tier when it's free, else skip the
          // provider entirely. Policy-unreadable fails open (availability
          // wins) to match the primary gate's best-effort shape.
          let paidAllowed = true;
          try { paidAllowed = getModelPolicy().allowPaidModels; } catch { /* best-effort */ }
          const isComplex = isComplexCall(opts, isTooBigForLocal(prompt, system));
          for (const fp of getFallbackChain()) {
            let fbModel = isComplex ? fp.largeModel : fp.smallModel;
            if (!paidAllowed && !isFreeModelId(fbModel)) {
              if (isFreeModelId(fp.smallModel) && fp.smallModel !== fbModel) {
                fbModel = fp.smallModel;
              } else {
                console.warn(`[llm] skipping fallback ${fp.label} — "${fbModel}" is paid and paid models aren't approved (Settings → Models)`);
                continue;
              }
            }
            try {
              console.warn(`[llm] active provider failed — trying ${fp.label} (${fbModel})`);
              if (opts.onRoutingDecision) {
                try { opts.onRoutingDecision({ backend: "openrouter", model: fbModel, reason: `active provider unavailable — failover to ${fp.label}`, tokenEstimate }); } catch { /* consumer error */ }
              }
              return await withRemoteLlmSlot(`fallback:${fp.label}`, () => openrouterGenerateWithMeta(prompt, system, {
                model: fbModel, onToken, maxTokens: opts.maxTokens, temperature: opts.temperature,
                timeoutMs: opts.timeoutMs,
                signal,
                endpoint: { baseUrl: fp.baseUrl, apiKey: fp.apiKey },
              }), signal);
            } catch (fe: any) {
              if (streamed) throw fe; // tokens reached the consumer — can't switch again
              console.warn(`[llm] fallback ${fp.label} also failed: ${String(fe?.message ?? fe).slice(0, 120)}`);
            }
          }
        } catch { /* pool unreadable — fall through to local */ }
        const localModel = opts.profile ? await pickModelFor(opts.profile, config.ollamaModel) : config.ollamaModel;
        console.warn(`[llm] OpenRouter transient failure — falling back to local ${localModel}: ${String(e?.message ?? e).slice(0, 140)}`);
        if (opts.onRoutingDecision) {
          try { opts.onRoutingDecision({ backend: "ollama", model: localModel, reason: `OpenRouter rate-limited/unavailable — fell back to local ${localModel}`, tokenEstimate }); } catch { /* consumer error */ }
        }
        return callOllamaStream(prompt, system, localModel, opts.onToken, opts.maxTokens, opts.temperature, opts.timeoutMs, signal);
      }
      throw e;
    }
  }
  // Little-coder harness for small local models. When NAXION_USE_LITTLE_CODER=1
  // and the model is a small local model and little-coder is installed, route
  // through the optimised small-model execution path. OpenRouter/cloud models are
  // unaffected — they keep the existing dispatch path above.
  const { shouldUseHarness, executeViaLittleCoder } = await import("./small-model-harness.js");
  if (shouldUseHarness(model)) {
    if (opts.onRoutingDecision) {
      try { opts.onRoutingDecision({ backend: "little-coder", model, reason: `routed through little-coder harness for small-model optimisations`, tokenEstimate }); } catch { /* consumer error */ }
    }
    try {
      // little-coder doesn't support streaming; buffer then emit as one chunk.
      const result = await executeViaLittleCoder(prompt, system, { model, maxTokens: opts.maxTokens, temperature: opts.temperature });
      if (opts.onToken) { try { opts.onToken(result.text, result.text); } catch { /* consumer error */ } }
      return result;
    } catch (e: any) {
      console.warn(`[llm] little-coder harness failed — falling back to Ollama: ${String(e?.message ?? e).slice(0, 140)}`);
      // fall through to the normal Ollama dispatch
    }
  }
  return callOllamaStream(prompt, system, model, opts.onToken, opts.maxTokens, opts.temperature, opts.timeoutMs, signal);
}

export async function llmGenerate(prompt: string, system?: string, opts: LLMCallOptions = {}): Promise<string> {
  return (await llmGenerateWithMeta(prompt, system, opts)).text;
}

// Backwards-compat aliases — existing call sites import these names from
// `./ollama.js`. The shim in ollama.ts re-exports these.
export { llmGenerate as ollamaGenerate, llmGenerateWithMeta as ollamaGenerateWithMeta };
export type { LLMCallOptions as OllamaCallOptions };

// Combined health snapshot — reports both backends. /api/status uses this
// to render which path is live. ok=true for Ollama means the configured
// model is pulled; for OpenRouter means the API key works.
export async function llmHealth(): Promise<{
  ollama: { ok: boolean; model: string; error?: string };
  openrouter: { enabled: boolean; ok: boolean; model: string; error?: string; circuitOpen?: boolean; dailyQuotaExhausted?: boolean; billingExhausted?: boolean };
  littleCoder: { enabled: boolean; available: boolean; error?: string };
  studioImage: { enabled: boolean; providers: string[]; defaultProvider: string | null };
  primary: Backend;
}> {
  const [ollama, or, lc] = await Promise.all([
    (async () => {
      try {
        const res = await fetch(`${config.ollamaHost}/api/tags`);
        if (!res.ok) return { ok: false, model: config.ollamaModel, error: `HTTP ${res.status}` };
        const data = await res.json() as { models?: { name: string }[] };
        const names = (data.models ?? []).map(m => m.name);
        return { ok: names.includes(config.ollamaModel), model: config.ollamaModel, error: names.includes(config.ollamaModel) ? undefined : `model not pulled (have: ${names.join(", ") || "none"})` };
      } catch (e: any) {
        return { ok: false, model: config.ollamaModel, error: e.message };
      }
    })(),
    config.openrouterEnabled ? openrouterHealth() : Promise.resolve({ ok: false, model: config.openrouterModel, error: "disabled (no OPENROUTER_API_KEY)" }),
    (async () => {
      try {
        const { isLittleCoderAvailable, isHarnessEnabled } = await import("./small-model-harness.js");
        const available = isLittleCoderAvailable();
        const enabled = isHarnessEnabled();
        return { enabled, available, error: !available ? "little-coder not installed (npm install -g little-coder)" : undefined };
      } catch {
        return { enabled: false, available: false, error: "harness module unavailable" };
      }
    })(),
  ]);
  // "Primary" reflects which backend handles a generic /balanced call. If OR is
  // enabled AND set as the balanced profile, it's primary. Otherwise Ollama.
  const primary: Backend = shouldRouteToOpenRouter("balanced") ? "openrouter" : "ollama";
  return {
    ollama,
    openrouter: { enabled: config.openrouterEnabled, ...or, circuitOpen: openrouterCircuitOpen(), dailyQuotaExhausted: openrouterDailyQuotaExhausted(), billingExhausted: openrouterBillingExhausted() },
    littleCoder: lc,
    studioImage: (await import("./studio-image.js")).studioImageHealth(),
    primary,
  };
}

// Test hook — routing decision only, no generation.
export const _chooseBackendAndModelForTests = chooseBackendAndModel;
