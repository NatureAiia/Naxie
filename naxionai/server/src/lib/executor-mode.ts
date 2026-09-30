// Runtime executor switch — which agent does the actual task work, and a
// fallback chain so the system uses each where it's strongest.
//
//   "clawbot" (default) — the built-in plan → execute → synth pipeline
//                         (delegating to the persona-shifter worker pool).
//   "hermes"            — the Hermes CLI agent (persona/governance framing
//                         injected). Whatever Hermes CAN'T do — errors, no
//                         final response, or a too-thin answer — is OFFLOADED
//                         to clawbot automatically (see chat.ts).
//
// Optional `hermesModel` overrides config.hermesModel at runtime (so the model
// can be switched live without a restart — also lets a test force a failure).
//
// Persisted to .neuroworks/executor.json and read at request time so it can be
// flipped live (no restart) via POST /api/executor — tsx-watch doesn't reload
// .env, and the user asked not to kill the server process.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const CONFIG_PATH = resolve(CONFIG_DIR, "executor.json");

export type ExecutorMode = "clawbot" | "hermes";
// hermesLocal — run Hermes against local Ollama (config.hermesLocalModel,
// default north-mini-code-10) instead of the cloud provider. Zero key, zero
// spend, offline-capable; the model must exist in `ollama list`.
// crosscheck — on a quality-fail offload (Hermes's answer scored below the
// quality.check threshold, NOT a hard fail), have a peer judge Hermes's
// answer against clawbot's instead of blindly taking clawbot's — see
// crosscheckAnswers() in peers.ts and its use in chat.ts.
export type ExecutorConfig = { mode: ExecutorMode; hermesModel?: string; hermesLocal?: boolean; crosscheck?: boolean };

// Tiny cache so the per-request read isn't a disk hit every time. 5s TTL keeps
// a live flip visible within a few seconds without hammering the FS.
let cache: { cfg: ExecutorConfig; at: number } | null = null;
const TTL_MS = 5000;

function readConfig(): ExecutorConfig {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.cfg;
  let cfg: ExecutorConfig = { mode: "clawbot" };
  try {
    if (existsSync(CONFIG_PATH)) {
      const j = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      if (j?.mode === "hermes" || j?.mode === "clawbot") cfg.mode = j.mode;
      if (typeof j?.hermesModel === "string" && j.hermesModel.trim()) cfg.hermesModel = j.hermesModel.trim();
      if (j?.hermesLocal === true) cfg.hermesLocal = true;
      if (j?.crosscheck === true) cfg.crosscheck = true;
    }
  } catch { /* default */ }
  cache = { cfg, at: Date.now() };
  return cfg;
}

export function getExecutorConfig(): ExecutorConfig {
  return readConfig();
}

export function getPrimaryExecutor(): ExecutorMode {
  return readConfig().mode;
}

export function getHermesModelOverride(): string | undefined {
  return readConfig().hermesModel;
}

export function isHermesLocal(): boolean {
  return readConfig().hermesLocal === true;
}

export function isCrosscheckEnabled(): boolean {
  return readConfig().crosscheck === true;
}

export function isHermesPrimary(): boolean {
  return readConfig().mode === "hermes";
}

// Update the executor config. Pass `hermesModel: null` to clear the override.
export function setExecutorConfig(patch: { mode?: ExecutorMode; hermesModel?: string | null; hermesLocal?: boolean; crosscheck?: boolean }): ExecutorConfig {
  const cur = readConfig();
  const next: ExecutorConfig = { mode: cur.mode, ...(cur.hermesModel ? { hermesModel: cur.hermesModel } : {}), ...(cur.hermesLocal ? { hermesLocal: true } : {}), ...(cur.crosscheck ? { crosscheck: true } : {}) };
  if (patch.mode !== undefined) {
    if (patch.mode !== "clawbot" && patch.mode !== "hermes") throw new Error(`invalid executor mode "${patch.mode}"`);
    next.mode = patch.mode;
  }
  if (patch.hermesModel !== undefined) {
    if (patch.hermesModel === null || patch.hermesModel === "") delete next.hermesModel;
    else next.hermesModel = String(patch.hermesModel).trim();
  }
  if (patch.hermesLocal !== undefined) {
    if (patch.hermesLocal) next.hermesLocal = true;
    else delete next.hermesLocal;
  }
  if (patch.crosscheck !== undefined) {
    if (patch.crosscheck) next.crosscheck = true;
    else delete next.crosscheck;
  }
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  cache = { cfg: next, at: Date.now() };
  return next;
}

// Back-compat helper.
export function setPrimaryExecutor(mode: ExecutorMode): void {
  setExecutorConfig({ mode });
}
