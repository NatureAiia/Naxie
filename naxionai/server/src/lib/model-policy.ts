// Model spend policy — free-tier models are the default and only pick;
// anything that costs real money per token stays OFF until the operator
// explicitly approves it (Settings > Models > Allow paid models), same
// fail-closed shape as host-tools.ts's System Access toggle. Local Ollama is
// the last-resort fallback when no free online option is reachable — the
// dispatcher (llm.ts) already routes there when OpenRouter is unavailable;
// this module only adds the "is the online pick free, and are paid models
// allowed at all" checkpoint right before a paid dispatch would happen.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.neuroworks");
const POLICY_FILE = resolve(STATE_DIR, "model-policy.json");

export type ModelPolicy = { allowPaidModels: boolean };
const DEFAULT_POLICY: ModelPolicy = { allowPaidModels: false };

let cache: ModelPolicy | null = null;

function persist(): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(POLICY_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch { /* best-effort — worst case we re-ask next boot */ }
}

function load(): ModelPolicy {
  if (cache) return cache;
  if (!existsSync(POLICY_FILE)) { cache = { ...DEFAULT_POLICY }; persist(); return cache; }
  try {
    const parsed = JSON.parse(readFileSync(POLICY_FILE, "utf8"));
    cache = { ...DEFAULT_POLICY, ...parsed };
  } catch {
    cache = { ...DEFAULT_POLICY }; // unreadable settings ⇒ safe default (paid OFF), not "allow everything"
  }
  return cache!;
}

export function getModelPolicy(): ModelPolicy {
  return { ...load() };
}

export function setAllowPaidModels(v: boolean): ModelPolicy {
  const p = load();
  p.allowPaidModels = v;
  persist();
  return { ...p };
}

// Best-effort free-tier classifier. OpenRouter's ":free" suffix is the one
// reliable machine-readable signal (covers its NVIDIA-hosted free models
// too, e.g. "nvidia/nemotron-3-super-120b-a12b:free"); Gemini's free Flash
// tier isn't encoded in the model id at all, so we match known-free Gemini
// identifiers by name. Everything that doesn't match is treated as paid —
// fail closed, not open.
const FREE_MODEL_PATTERNS: RegExp[] = [
  /:free$/i,
  /^gemini-flash/i,
  /^gemini-[\w.-]*flash/i,
];

export function isFreeModelId(modelId: string): boolean {
  if (!modelId) return false;
  return FREE_MODEL_PATTERNS.some((re) => re.test(modelId));
}
