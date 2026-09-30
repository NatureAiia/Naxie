// UI-settable overrides for the two secrets the pgvector RAG store needs
// (SUPABASE_DB_URL, OPENAI_EMBEDDING_API_KEY) — an alternative entry point
// to only setting them in .env, so a settings page can turn the store on
// without a restart. Persisted at .neuroworks/rag-config.json, encrypted at
// rest via secret-box.ts (same pattern as github-accounts.ts/connectors.ts).
// An override wins over whatever config.ts already picked from the
// environment once set; there's no "clear" path yet (mirrors
// github-accounts.ts having rotate but no plaintext readback) — fixing a
// bad value means setting a new one, same as rotating a token.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { encryptSecret, decryptSecret, isEncrypted } from "./secret-box.js";
import { config } from "../config.js";
import { closePgPool } from "./pg-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const CONFIG_PATH = resolve(CONFIG_DIR, "rag-config.json");

type RagOverrides = { supabaseDbUrl?: string; openaiEmbeddingApiKey?: string };
const KEYS: (keyof RagOverrides)[] = ["supabaseDbUrl", "openaiEmbeddingApiKey"];

function load(): RagOverrides {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const out: RagOverrides = {};
    let sawPlaintext = false;
    for (const key of KEYS) {
      let v = parsed?.[key];
      if (!v) continue;
      if (isEncrypted(v)) {
        try { v = decryptSecret(v); } catch { continue; } // wrong/rotated key — treat as unset rather than crash
      } else {
        sawPlaintext = true;
      }
      out[key] = v;
    }
    if (sawPlaintext) { try { save(out); } catch { /* best-effort migration */ } }
    return out;
  } catch { return {}; }
}

function save(overrides: RagOverrides): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const onDisk: Record<string, string> = {};
  for (const key of KEYS) {
    const v = overrides[key];
    if (v) onDisk[key] = isEncrypted(v) ? v : encryptSecret(v);
  }
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

// Applies whatever's persisted onto the shared `config` object — an override
// wins over the env value config.ts already picked at boot. Called once at
// startup (index.ts, right after validateConfig()) and again after every
// setRagOverrides() call so a change takes effect without a restart.
export function applyRagOverrides(): void {
  const overrides = load();
  if (overrides.supabaseDbUrl) {
    config.supabaseDbUrl = overrides.supabaseDbUrl;
    config.pgvectorEnabled = true;
  }
  if (overrides.openaiEmbeddingApiKey) {
    config.openaiEmbeddingApiKey = overrides.openaiEmbeddingApiKey;
    config.openaiEmbeddingEnabled = true;
  }
}

// Never returns the raw secrets — just whether a UI override is on file for
// each, for the settings page to show "set via .env" vs "set via settings".
export function getRagOverridesStatus(): { supabaseDbUrlOverridden: boolean; openaiEmbeddingApiKeyOverridden: boolean } {
  const overrides = load();
  return {
    supabaseDbUrlOverridden: !!overrides.supabaseDbUrl,
    openaiEmbeddingApiKeyOverridden: !!overrides.openaiEmbeddingApiKey,
  };
}

export async function setRagOverrides(patch: RagOverrides): Promise<void> {
  const current = load();
  const next = { ...current };
  if (patch.supabaseDbUrl !== undefined) {
    const v = patch.supabaseDbUrl.trim();
    if (v) next.supabaseDbUrl = v;
  }
  if (patch.openaiEmbeddingApiKey !== undefined) {
    const v = patch.openaiEmbeddingApiKey.trim();
    if (v) next.openaiEmbeddingApiKey = v;
  }
  save(next);
  applyRagOverrides();
  // Force the pg pool to be rebuilt against the (possibly new) connection
  // string on next use, and drop the cached reachability probe.
  await closePgPool();
}
