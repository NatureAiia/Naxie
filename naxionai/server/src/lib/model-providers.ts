// Bring-your-own model providers. Lets a user plug in a model API they already
// use (OpenAI, OpenRouter, Groq, Together, or any OpenAI-compatible endpoint)
// without editing .env. The active provider is applied to the runtime LLM
// router config so it takes effect immediately, and persisted (key encrypted)
// so it survives a restart.
//
// We route everything through the existing OpenRouter-compatible code path
// (chat-completions), which is the lingua franca for these APIs — so applying a
// provider is just setting config.openrouter{ApiKey,BaseUrl,Model,Enabled}.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { encryptSecret, decryptSecret, isEncrypted } from "./secret-box.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.naxion");
const PATH = resolve(STATE_DIR, "model-providers.json");

export type ProviderKind = "openai" | "gemini" | "openrouter" | "groq" | "together" | "ollama_cloud" | "custom";

export const PROVIDER_DEFAULTS: Record<ProviderKind, { label: string; baseUrl: string; modelHint: string }> = {
  openai:     { label: "OpenAI",     baseUrl: "https://api.openai.com/v1",      modelHint: "gpt-4o-mini" },
  // Google Gemini via its OpenAI-compatible endpoint — same Bearer-auth
  // chat-completions shape as everything else here, no separate SDK. Get a
  // key at https://aistudio.google.com/apikey. 2026-08 free-tier: use gemini-flash-latest (alias for latest Flash, free) — 2.5-* now 404 for new keys.
  gemini:     { label: "Google (Gemini)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", modelHint: "gemini-flash-latest" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1",   modelHint: "openai/gpt-4o-mini" },
  groq:       { label: "Groq",       baseUrl: "https://api.groq.com/openai/v1", modelHint: "llama-3.3-70b-versatile" },
  together:   { label: "Together",   baseUrl: "https://api.together.xyz/v1",    modelHint: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  // Ollama Cloud via its OpenAI-compatible endpoint (verified 2026-10-04:
  // chat completions live at https://ollama.com/v1 — /api/v1 404s).
  ollama_cloud: { label: "Ollama Cloud", baseUrl: "https://ollama.com/v1",   modelHint: "gemma4:31b" },
  custom:     { label: "Custom (OpenAI-compatible)", baseUrl: "", modelHint: "" },
};

export type ModelProvider = {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;       // encrypted at rest
  active: boolean;
  createdAt: string;
  // Display/failover order, controlled from the Models page (lower = earlier).
  // Assigned on creation (append); changed via reorderProviders().
  position: number;
  // Naxie's model-selection self-improvement loop (system.admin's
  // "switch_model" action, approval-gated) writes here instead of the
  // kind-based defaults in applyToRuntime below — persists across restart,
  // survives until explicitly changed again.
  smallModelOverride?: string;
  largeModelOverride?: string;
};

export type ModelProviderPublic = Omit<ModelProvider, "apiKey"> & { keyPrefix: string };

function load(): ModelProvider[] {
  try {
    if (!existsSync(PATH)) return [];
    const parsed = JSON.parse(readFileSync(PATH, "utf8"));
    if (!Array.isArray(parsed)) return [];
    // Legacy records predate `position` — backfill from creation order so
    // old installs get a stable order instead of all-zero ties.
    const sorted = [...parsed].sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
    let changed = false;
    sorted.forEach((p, i) => {
      if (typeof p.position !== "number") { p.position = i; changed = true; }
    });
    // Unknown kinds from older versions (e.g. retired "anthropic") can never
    // be activated or used again — drop them instead of showing dead rows.
    const kept = sorted.filter(p => (PROVIDER_DEFAULTS as Record<string, unknown>)[p.kind]);
    if (kept.length !== sorted.length) changed = true;
    if (changed) save(kept);
    return kept.sort((a, b) => (a.position - b.position) || String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  } catch { return []; }
}

function save(list: ModelProvider[]): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const onDisk = list.map(p => ({ ...p, apiKey: isEncrypted(p.apiKey) ? p.apiKey : encryptSecret(p.apiKey) }));
  writeFileSync(PATH, JSON.stringify(onDisk, null, 2), { encoding: "utf8", mode: 0o600 });
}

function plainKey(p: ModelProvider): string {
  try { return isEncrypted(p.apiKey) ? decryptSecret(p.apiKey) : p.apiKey; } catch { return ""; }
}

function redact(p: ModelProvider): ModelProviderPublic {
  const { apiKey, ...rest } = p;
  const key = plainKey(p);
  return { ...rest, keyPrefix: key ? key.slice(0, 6) + "…" : "" };
}

export function listProviders(): ModelProviderPublic[] {
  return load().map(redact);
}

export function addProvider(input: { label?: string; kind: ProviderKind; baseUrl?: string; model: string; apiKey: string; active?: boolean }): ModelProviderPublic {
  const list = load();
  const def = PROVIDER_DEFAULTS[input.kind];
  const p: ModelProvider = {
    id: randomUUID(),
    label: (input.label ?? def.label).trim() || def.label,
    kind: input.kind,
    baseUrl: (input.baseUrl?.trim() || def.baseUrl),
    model: input.model.trim(),
    apiKey: input.apiKey.trim(),
    active: input.active ?? true,
    createdAt: new Date().toISOString(),
    position: list.reduce((m, p) => Math.max(m, typeof p.position === "number" ? p.position : -1), -1) + 1,
  };
  if (!p.baseUrl) throw new Error("baseUrl is required for a custom provider");
  if (!p.model) throw new Error("model is required");
  if (!p.apiKey) throw new Error("apiKey is required");
  // Only one active provider at a time.
  if (p.active) for (const other of list) other.active = false;
  list.push(p);
  save(list);
  if (p.active) applyToRuntime(p);
  return redact(p);
}

export function removeProvider(id: string): boolean {
  const list = load();
  const target = list.find(p => p.id === id);
  const next = list.filter(p => p.id !== id);
  if (next.length === list.length) return false;
  save(next);
  // If we removed the active provider, fall back to env-configured OpenRouter.
  if (target?.active) applyToRuntime(null);
  return true;
}

export function activateProvider(id: string): ModelProviderPublic | null {
  const list = load();
  const target = list.find(p => p.id === id);
  if (!target) return null;
  for (const p of list) p.active = p.id === id;
  save(list);
  applyToRuntime(target);
  return redact(target);
}

// Persist a new display/failover order from the Models page. `ids` holds
// every provider id in the desired order (first = highest priority); the
// active provider keeps working — order only affects listing + failover.
export function reorderProviders(ids: string[]): ModelProviderPublic[] {
  const list = load();
  const seen = new Set<string>();
  const ordered: ModelProvider[] = [];
  for (const id of ids) {
    const p = list.find(x => x.id === id);
    if (p && !seen.has(id)) { seen.add(id); ordered.push(p); }
  }
  for (const p of list) if (!seen.has(p.id)) ordered.push(p);
  ordered.forEach((p, i) => { p.position = i; });
  save(ordered);
  return ordered.map(redact);
}

// Mutate the live router config so the provider takes effect with no restart.
// Passing null reverts to whatever the env originally set (captured once).
let envSnapshot: { apiKey: string; baseUrl: string; model: string; largeModel: string; enabled: boolean } | null = null;
function snapshotEnv(): void {
  if (envSnapshot) return;
  envSnapshot = {
    apiKey: config.openrouterApiKey,
    baseUrl: config.openrouterBaseUrl,
    model: config.openrouterModel,
    largeModel: config.openrouterLargeModel,
    enabled: config.openrouterEnabled,
  };
}

export function applyToRuntime(p: ModelProvider | null): void {
  snapshotEnv();
  if (!p) {
    if (envSnapshot) {
      config.openrouterApiKey = envSnapshot.apiKey;
      config.openrouterBaseUrl = envSnapshot.baseUrl;
      config.openrouterModel = envSnapshot.model;
      config.openrouterLargeModel = envSnapshot.largeModel;
      config.openrouterEnabled = envSnapshot.enabled;
    }
    return;
  }
  config.openrouterApiKey = plainKey(p);
  config.openrouterBaseUrl = p.baseUrl;
  // COST TIERING. The dispatcher (llm.ts) already splits every call into a
  // small tier (openrouterModel — planning, extraction, normal synth) and a
  // large tier (openrouterLargeModel — complexity:"high" or prompts over the
  // local context budget).
  if (p.kind === "gemini") {
    // Cheap/complex split: Flash handles the small
    // tier (planning/triage/everyday synth) at a fraction of Pro's cost;
    // only complexity:"high" / oversized prompts hand off to the provider's
    // chosen large model (default Pro). Overrides: GEMINI_SMALL_MODEL /
    // GEMINI_LARGE_MODEL.
    // 2026-08 free-tier: gemini-2.5-* is now 404 for new keys (use gemini-flash-latest / gemini-3-flash-preview).
    config.openrouterModel = (process.env.GEMINI_SMALL_MODEL ?? "").trim() || "gemini-flash-latest";
    config.openrouterLargeModel = (process.env.GEMINI_LARGE_MODEL ?? "").trim() || p.model;
  } else if (p.kind === "openrouter") {
    // FREE-FIRST tiering (2026-07-12 "most cost-affordable org" pass): the
    // small tier — planning, extraction, everyday synth, i.e. the vast
    // majority of calls — rides a strong FREE OpenRouter model; only
    // complexity:"high" / oversized prompts hand off to the paid model the
    // operator picked for this provider. OPENROUTER_MODEL env still pins
    // the small tier explicitly.
    config.openrouterModel = (process.env.OPENROUTER_MODEL ?? "").trim() || "nvidia/nemotron-3-super-120b-a12b:free";
    config.openrouterLargeModel = p.model;
  } else {
    // Other direct providers (OpenAI/Groq/Together/custom): same model for
    // both tiers — leaving the env's large model in place would send an
    // alien model id to this provider's endpoint on big/complex synths → 404.
    config.openrouterModel = p.model;
    config.openrouterLargeModel = p.model;
  }
  // A Naxie-proposed model switch (system.admin's "switch_model", approval-
  // gated) wins over the kind-based defaults above, same as an env pin would.
  if (p.smallModelOverride) config.openrouterModel = p.smallModelOverride;
  if (p.largeModelOverride) config.openrouterLargeModel = p.largeModelOverride;
  config.openrouterEnabled = config.openrouterApiKey.length > 0;
}

// Per-kind small-tier defaults for FALLBACK calls (the provider's own stored
// `model` is its large tier). Kept conservative-cheap: fallbacks exist for
// availability, not quality escalation.
const FALLBACK_SMALL_MODEL: Partial<Record<ProviderKind, string>> = {
  openai: "gpt-5.4-mini",
  gemini: "gemini-flash-latest",
  openrouter: "nvidia/nemotron-3-super-120b-a12b:free",
};

export type FallbackProvider = {
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  apiKey: string; // decrypted — in-memory only, never serialized
  smallModel: string;
  largeModel: string;
};

// The NON-active registered providers, decrypted and ordered for failover.
// Order is operator-controlled from the Models page (position, lower first):
// llm.ts walks this chain when the active provider's call fails transiently
// or its circuit is open.
export function getFallbackChain(): FallbackProvider[] {
  return load()
    .filter(p => !p.active && plainKey(p))
    .sort((a, b) => (a.position - b.position) || a.createdAt.localeCompare(b.createdAt))
    .map(p => ({
      kind: p.kind,
      label: p.label,
      baseUrl: p.baseUrl,
      apiKey: plainKey(p),
      smallModel: FALLBACK_SMALL_MODEL[p.kind] ?? p.model,
      largeModel: p.model,
    }));
}

// Called once at boot: re-apply the active provider so a UI-added key survives
// restarts (env still wins if no provider is marked active).
export function loadAndApplyActiveProvider(): void {
  const active = load().find(p => p.active);
  if (active) applyToRuntime(active);
}

// Naxie's model-selection self-improvement loop (system.admin's "switch_model"
// action, approval-gated — see agent.ts SENSITIVE_APPROVAL_TOOLS) calls this
// to change just the small or large tier model for the currently active
// provider, without re-registering a whole provider record. Persists (so the
// switch survives a restart) and takes effect immediately via applyToRuntime.
export function setActiveTierModel(tier: "small" | "large", model: string): ModelProviderPublic {
  const list = load();
  const active = list.find(p => p.active);
  if (!active) throw new Error("no active model provider to switch — register one on the Models page first");
  if (tier === "small") active.smallModelOverride = model;
  else active.largeModelOverride = model;
  save(list);
  applyToRuntime(active);
  return redact(active);
}
