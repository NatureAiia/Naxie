import { config } from "../config.js";
import { isOffline } from "./offline-mode.js";
import { isCloudReachableCached } from "./connectivity.js";

export type ModelInfo = {
  name: string;
  family: string;
  paramSize?: string;
  sizeGB?: number;
  // Heuristic capabilities. Filled from KNOWN_PROFILES on registry load; falls
  // back to a sensible default if the model isn't in the table.
  capabilities: Capabilities;
};

// Each task arrives with a "needs" vector — the routing algorithm picks the
// model whose capabilities best satisfy those needs at the lowest cost.
//
// Cost is normalised so a 1B model is ~1, a 4B model is ~4, etc.
// Higher is better for everything except `cost` (lower is better).
export type Capabilities = {
  jsonStrict: number;     // 0-10. Reliability of producing valid JSON without prose noise.
  reasoning: number;      // 0-10. Multi-step deduction, planning, math.
  longForm: number;       // 0-10. Coherent prose 200+ words.
  speed: number;          // 0-10. Tokens/sec on this hardware (subjective).
  cost: number;           // 1-10. Lower = cheaper. Roughly param_count_in_B.
};

export type TaskNeeds = Partial<{
  jsonStrict: number;
  reasoning: number;
  longForm: number;
  speed: number;
  // Hard requirement — only consider models whose name matches one of these patterns
  must: RegExp[];
  // Hard rejection — exclude models matching any of these
  exclude: RegExp[];
}>;

// Profiles for models we know well. Anything not in here gets `defaultProfile`.
const KNOWN_PROFILES: Record<string, Partial<Capabilities>> = {
  // Fast, structured-output strong, no thinking overhead. Our default.
  "qwen2.5:3b":      { jsonStrict: 9, reasoning: 6, longForm: 8, speed: 7, cost: 3 },
  "qwen2.5:7b":      { jsonStrict: 9, reasoning: 8, longForm: 9, speed: 5, cost: 7 },
  "qwen2.5:1.5b":    { jsonStrict: 7, reasoning: 4, longForm: 5, speed: 9, cost: 2 },
  // Reasoning-mode capable but mandatory CoT eats throughput on Ollama 0.22.
  // Practical cost is well above the param-count would suggest — bump it so the
  // router only picks qwen3 when reasoning weight strongly justifies it.
  "qwen3:4b":        { jsonStrict: 7, reasoning: 9, longForm: 6, speed: 3, cost: 8 },
  // Sub-1B; only suitable for short structured replies and quick checks.
  "qwen3.5:0.8b":    { jsonStrict: 5, reasoning: 3, longForm: 4, speed: 10, cost: 1 },
  // Gemma family — strong on prose, weaker on strict JSON without coercion.
  "gemma2:2b":       { jsonStrict: 6, reasoning: 5, longForm: 7, speed: 8, cost: 2 },
  "gemma2:9b":       { jsonStrict: 7, reasoning: 8, longForm: 9, speed: 4, cost: 9 },
  // Llama 3.2 instruct — balanced.
  "llama3.2:3b":     { jsonStrict: 7, reasoning: 6, longForm: 7, speed: 7, cost: 3 },
  "llama3.2:1b":     { jsonStrict: 5, reasoning: 4, longForm: 5, speed: 9, cost: 1 },
};

const defaultProfile: Capabilities = { jsonStrict: 6, reasoning: 5, longForm: 6, speed: 6, cost: 5 };

// Models pulled locally that aren't in KNOWN_PROFILES used to all collapse to
// `defaultProfile` — identical scores across every profile, so the scorer's
// stable sort just picked whichever model Ollama's /api/tags happened to list
// first (in practice: the most recently pulled one), regardless of task size.
// A "say hi" triage call landing on a 30B+ model this way can take 90s+ and
// looks like the feature is broken. Instead, derive a real profile from the
// model's own reported parameter count — bigger = slower + more capable,
// smaller = faster — so routing degrades gracefully for ANY locally pulled
// model, not just the ones we've hand-tuned.
function parseParamB(paramSize?: string): number | null {
  const m = /^([\d.]+)\s*([BMK])/i.exec((paramSize ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  return unit === "B" ? n : unit === "M" ? n / 1000 : n / 1_000_000;
}

function heuristicProfile(paramSize?: string): Capabilities {
  const paramB = parseParamB(paramSize);
  if (paramB === null || paramB <= 0) return defaultProfile;
  const clamp = (v: number) => Math.min(10, Math.max(1, Math.round(v)));
  return {
    jsonStrict: defaultProfile.jsonStrict,
    reasoning: clamp(4 + paramB / 6),
    longForm: clamp(3 + paramB / 5),
    speed: clamp(10 - paramB / 3.5),
    cost: clamp(paramB / 3.5),
  };
}

// Ollama "cloud" tags (e.g. "deepseek-v4-flash:cloud") run on Ollama's hosted
// infra via this same local daemon/API — not on this machine. They're still
// useful to pick explicitly (they stay in listModels()/the UI dropdown), but
// the automatic profile-based router shouldn't silently reach for a remote,
// possibly metered model when the user asked for "local". Excluded from
// pickModel()'s candidates unless a caller's `must` pattern explicitly wants one.
function isCloudModel(name: string): boolean {
  return /:cloud$/i.test(name);
}

let cache: { at: number; models: ModelInfo[] } | null = null;
const CACHE_MS = 30_000;

export async function listModels(): Promise<ModelInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.models;
  try {
    const res = await fetch(`${config.ollamaHost}/api/tags`);
    if (!res.ok) throw new Error(`Ollama tags: HTTP ${res.status}`);
    const data = await res.json() as { models: { name: string; size: number; details: { family: string; parameter_size?: string } }[] };
    const models = data.models.map(m => {
      const known = KNOWN_PROFILES[m.name];
      const capabilities = known
        ? ({ ...defaultProfile, ...known } as Capabilities)
        : heuristicProfile(m.details.parameter_size);
      return {
        name: m.name,
        family: m.details.family,
        paramSize: m.details.parameter_size,
        sizeGB: Math.round(m.size / 1e8) / 10,
        capabilities,
      };
    });
    cache = { at: Date.now(), models };
    return models;
  } catch {
    // Offline or Ollama down — fall back to the configured model alone so the
    // rest of the system keeps working in degraded mode.
    return [{
      name: config.ollamaModel,
      family: "unknown",
      capabilities: defaultProfile,
    }];
  }
}

// Score = weighted sum of (capability * need) minus cost penalty. Higher wins.
export function scoreModel(m: ModelInfo, needs: TaskNeeds): number {
  const c = m.capabilities;
  let score = 0;
  if (needs.jsonStrict) score += c.jsonStrict * needs.jsonStrict;
  if (needs.reasoning) score += c.reasoning * needs.reasoning;
  if (needs.longForm) score += c.longForm * needs.longForm;
  if (needs.speed) score += c.speed * needs.speed;
  // Cost is a flat penalty so big models only win when their capabilities really matter.
  score -= c.cost * 0.5;
  return score;
}

function filterCandidates(all: ModelInfo[], needs: TaskNeeds, localOnly: boolean): ModelInfo[] {
  let candidates = all;
  if (localOnly) candidates = candidates.filter(m => !isCloudModel(m.name));
  if (needs.must && needs.must.length) candidates = candidates.filter(m => needs.must!.some(re => re.test(m.name)));
  if (needs.exclude && needs.exclude.length) candidates = candidates.filter(m => !needs.exclude!.some(re => re.test(m.name)));
  return candidates;
}

export async function pickModel(needs: TaskNeeds, fallback?: string): Promise<string> {
  const all = await listModels();
  // Keep Ollama Cloud tags out of automatic picks by default — see
  // isCloudModel(). An explicit `must` pattern is a deliberate ask and can
  // still match one; otherwise, if excluding cloud models leaves nothing
  // (e.g. only cloud models are pulled), fall back to allowing them rather
  // than hard-failing to an unpulled default model name.
  let candidates = filterCandidates(all, needs, true);
  if (candidates.length === 0) candidates = filterCandidates(all, needs, false);
  if (candidates.length === 0) return fallback ?? config.ollamaModel;
  candidates.sort((a, b) => scoreModel(b, needs) - scoreModel(a, needs));
  return candidates[0].name;
}

// Stock task profiles used by the agent loop. Each plan step OR an entire task
// can be tagged with one of these so we don't have to hand-craft `needs` every
// time. Add more as new task shapes emerge.
export const TASK_PROFILES = {
  // Short, structured plan emission. JSON strictness > reasoning > speed.
  planning:    { jsonStrict: 5, reasoning: 3, speed: 2 } as TaskNeeds,
  // Long-form synthesis from gathered evidence. Prose > reasoning > speed.
  synthesis:   { longForm: 5, reasoning: 3, speed: 2 } as TaskNeeds,
  // Quick yes/no, classify, route. Speed > strictness > everything else.
  triage:      { speed: 5, jsonStrict: 3, reasoning: 1 } as TaskNeeds,
  // Persona/JD extraction — strict JSON output with moderate reasoning.
  extraction:  { jsonStrict: 5, reasoning: 2, speed: 1 } as TaskNeeds,
  // General-purpose default — this is what Naxie's live voice/text chat uses
  // for every turn (routes/voice.ts), so speed is weighted above reasoning/
  // longForm: a giant model's slightly better prose isn't worth a reply that
  // takes a minute in a conversational UI. Complex asks still escalate via
  // the complexity heuristic / OpenRouter large-tier handoff in llm.ts.
  balanced:    { jsonStrict: 3, reasoning: 2, longForm: 2, speed: 4 } as TaskNeeds,
};

// Per-profile env overrides. Setting any of these pins that profile to a
// specific model name, bypassing the capability scorer. Useful when you want
// a small/fast model for planning and a larger one for synthesis without
// having to swap the global default constantly.
const ENV_OVERRIDE_KEYS: Record<keyof typeof TASK_PROFILES, string> = {
  planning: "OLLAMA_PLAN_MODEL",
  synthesis: "OLLAMA_SYNTH_MODEL",
  triage: "OLLAMA_TRIAGE_MODEL",
  extraction: "OLLAMA_EXTRACT_MODEL",
  balanced: "OLLAMA_BALANCED_MODEL",
};

// Per-profile pick cache. The scorer is cheap on its own but pickModelFor
// gets called PER PLAN STEP — in a wave of 6 sub-agents each running
// ollama.generate, that's 6 sorts and 6 env-lookups for the same answer.
// We cache the chosen name for the lifetime of the listModels cache (30s)
// so a single sub-agent burst pays the picker cost exactly once.
const PICK_CACHE = new Map<string, { at: number; name: string }>();
const PICK_CACHE_MS = 30_000;

// The effort dial (Settings → Models) biases the capability scorer without
// touching TASK_PROFILES itself. "high" leans on reasoning/longForm/strictness
// and discounts speed so bigger, slower local models win the sort; "low" leans
// the opposite way so the fastest installed model wins even for profiles that
// would normally pull something heavier. "auto" is a no-op — the profile's own
// weights decide, same as before this dial existed.
function applyEffort(needs: TaskNeeds, effort: "auto" | "low" | "high"): TaskNeeds {
  if (effort === "auto") return needs;
  const clamp = (v: number) => Math.max(0, Math.min(10, v));
  if (effort === "high") {
    return {
      ...needs,
      reasoning: clamp((needs.reasoning ?? 3) + 3),
      longForm: needs.longForm !== undefined ? clamp(needs.longForm + 2) : needs.longForm,
      jsonStrict: needs.jsonStrict !== undefined ? clamp(needs.jsonStrict + 1) : needs.jsonStrict,
      speed: needs.speed !== undefined ? clamp(needs.speed - 3) : needs.speed,
    };
  }
  // low
  return {
    ...needs,
    speed: clamp((needs.speed ?? 3) + 4),
    reasoning: needs.reasoning !== undefined ? clamp(needs.reasoning - 2) : needs.reasoning,
    longForm: needs.longForm !== undefined ? clamp(needs.longForm - 1) : needs.longForm,
  };
}

// Convenience for primitives that want to ask "give me the right model for this kind of task".
export async function pickModelFor(profile: keyof typeof TASK_PROFILES, fallback?: string): Promise<string> {
  // OFFLINE = QUALITY-FIRST (operator policy): with no cloud to lean on, the
  // local pick biases to the most capable installed model even if the operator
  // left the effort dial on auto/low — a slow right answer beats a fast weak
  // one when there's nowhere else to escalate to. Same when cloud is
  // configured but probed unreachable (outage/quota): local carries the load.
  const cloudDown = isCloudReachableCached() === false;
  const effort = (isOffline() || cloudDown) ? "high" : config.effortMode;
  const cacheKey = `${profile}|${fallback ?? ""}|${effort}`;
  const hit = PICK_CACHE.get(cacheKey);
  if (hit && Date.now() - hit.at < PICK_CACHE_MS) return hit.name;
  // Env override wins over the scorer (and over the effort dial — an explicit
  // pin is a deliberate ask). We still verify the named model is pulled — if
  // not, we fall back to the scorer to avoid a hard failure when the user has
  // a stale env pinned to a deleted model.
  const envName = process.env[ENV_OVERRIDE_KEYS[profile]]?.trim();
  const needs = applyEffort(TASK_PROFILES[profile], effort);
  let name: string;
  if (envName) {
    const all = await listModels();
    if (all.find(m => m.name === envName)) {
      name = envName;
    } else {
      name = await pickModel(needs, fallback);
    }
  } else {
    name = await pickModel(needs, fallback);
  }
  PICK_CACHE.set(cacheKey, { at: Date.now(), name });
  return name;
}

// Bust the pick cache. Called when the user pulls a new model or changes the
// env override — otherwise stale picks linger up to 30s.
export function invalidateModelPickCache() {
  PICK_CACHE.clear();
  cache = null;
}
