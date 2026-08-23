// Extensions / Plugins registry — platform APIs that are env-gated (OpenRouter,
// ElevenLabs, Supabase, etc.) plus pointers to the token-based integrations /
// connectors / model providers. This is the single catalog the Extensions page
// monitors. Env secrets are NEVER returned — only prefix + enabled/health.

import { config } from "../config.js";
import { llmHealth } from "./llm.js";
import { recordHealth } from "./extension-health.js";
import { isThrottled, recordCircuit, getCircuitState } from "./extension-circuit.js";

export type ExtensionCategory = "llm" | "voice" | "storage" | "scraping" | "media" | "social" | "infra";

export type ExtensionDef = {
  id: string;
  name: string;
  category: ExtensionCategory;
  description: string;
  envKey: string; // primary env var that enables it
  envKeys?: string[]; // additional keys to show as configured
  docsUrl?: string;
  testable: boolean;
  connectHint: string; // shown in the connect modal
};

export const EXTENSION_CATALOG: ExtensionDef[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    category: "llm",
    description: "Cloud LLM acceleration for planning/synthesis (gpt-4o, Claude, Gemini). Falls back to Ollama on 429/5xx.",
    envKey: "OPENROUTER_API_KEY",
    envKeys: ["OPENROUTER_MODEL", "OPENROUTER_LARGE_MODEL", "OPENROUTER_APP_URL", "OPENROUTER_APP_NAME"],
    docsUrl: "https://openrouter.ai/keys",
    testable: true,
    connectHint: "Paste your OpenRouter API key (sk-or-v1-…). Set OPENROUTER_MODEL to openai/gpt-4o or openai/gpt-4o-mini.",
  },
  {
    id: "ollama",
    name: "Ollama (local LLM)",
    category: "llm",
    description: "Local inference. No key required — just OLLAMA_HOST + OLLAMA_MODEL.",
    envKey: "OLLAMA_HOST",
    envKeys: ["OLLAMA_MODEL"],
    docsUrl: "https://ollama.com",
    testable: true,
    connectHint: "Set OLLAMA_HOST (default http://127.0.0.1:11434) and pull a model with `ollama pull llama3.1:8b`.",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    category: "voice",
    description: "Cloud TTS — Rachel/Sarah voices for voice.py and realtime calls. Falls back to Piper/pyttsx3.",
    envKey: "ELEVENLABS_API_KEY",
    envKeys: ["ELEVENLABS_VOICE_ID"],
    docsUrl: "https://elevenlabs.io/app/settings/api-keys",
    testable: true,
    connectHint: "Paste your ElevenLabs API key (sk_…). Default voice is EXAVITQu4vr4xnSDxMaL (Sarah).",
  },
  {
    id: "supabase",
    name: "Supabase",
    category: "storage",
    description: "pgvector RAG store + MAG memory. Publishable + secret keys, optional direct Postgres URL.",
    envKey: "SUPABASE_URL",
    envKeys: ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_DB_URL"],
    docsUrl: "https://supabase.com/dashboard/project/_/settings/api",
    testable: true,
    connectHint: "Paste SUPABASE_URL + keys from Project Settings → API.",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    category: "scraping",
    description: "Third-tier scraping when fetch + Playwright fail (Cloudflare, anti-bot).",
    envKey: "FIRECRAWL_API_KEY",
    docsUrl: "https://firecrawl.dev",
    testable: false,
    connectHint: "Paste your Firecrawl API key (fc-…).",
  },
  {
    id: "heygen",
    name: "HeyGen",
    category: "media",
    description: "AI avatar / spokesperson video (media.avatar_video). Async render.",
    envKey: "HEYGEN_API_KEY",
    docsUrl: "https://app.heygen.com/settings?nav=API",
    testable: true,
    connectHint: "Paste your HeyGen API key. Set HEYGEN_BASE_URL if you use a proxy.",
  },
  {
    id: "ayrshare",
    name: "Ayrshare",
    category: "social",
    description: "One key fans social.post to X, LinkedIn, Facebook, IG, TikTok, etc.",
    envKey: "AYRSHARE_API_KEY",
    docsUrl: "https://www.ayrshare.com/docs",
    testable: false,
    connectHint: "Paste your Ayrshare API key from ayrshare.com.",
  },
  {
    id: "ideogram",
    name: "Ideogram",
    category: "media",
    description: "Text-to-image — best for typography/posters. Header is Api-Key.",
    envKey: "IDEOGRAM_API_KEY",
    docsUrl: "https://ideogram.ai/platform",
    testable: false,
    connectHint: "Paste your Ideogram API key (Api-Key header).",
  },
  {
    id: "muapi",
    name: "Muapi",
    category: "media",
    description: "Unified image catalog (nano-banana, flux, seedream, imagen…). Header x-api-key.",
    envKey: "MUAPI_API_KEY",
    docsUrl: "https://muapi.ai",
    testable: false,
    connectHint: "Paste your Muapi API key (x-api-key header).",
  },
  {
    id: "n8n",
    name: "n8n",
    category: "infra",
    description: "Self-hosted workflow automation — trigger workflows, fire webhooks, chain AI tasks. Powers n8n.* primitives.",
    envKey: "N8N_API_KEY",
    envKeys: ["N8N_BASE_URL", "N8N_WEBHOOK_BASE_URL"],
    docsUrl: "https://docs.n8n.io/api/authentication/",
    testable: true,
    connectHint: "Run n8n (docker run -p 5678:5678 n8nio/n8n), open Settings → API → Create API Key, then set N8N_BASE_URL=http://127.0.0.1:5678 + N8N_API_KEY.",
  },
];

export type ExtensionStatus = {
  id: string;
  name: string;
  category: ExtensionCategory;
  description: string;
  envKey: string;
  docsUrl?: string;
  testable: boolean;
  enabled: boolean;
  configured: boolean;
  keyPrefix?: string; // first 8 chars + … if set, never full secret
  model?: string;
  detail: string;
  health?: { ok: boolean; detail: string };
  throttled?: boolean;
  circuit?: { state: string; failures: number; until?: string };
};

function prefixOf(v: string): string {
  const t = v.trim();
  if (!t) return "";
  return t.length <= 12 ? t.slice(0, 4) + "…" : t.slice(0, 10) + "…";
}

export async function getExtensionsStatus(): Promise<ExtensionStatus[]> {
  // llm health is the only live probe we have for openrouter/ollama today.
  let llm: Awaited<ReturnType<typeof llmHealth>> | null = null;
  try { llm = await llmHealth(); } catch { /* treat as unknown */ }

  return EXTENSION_CATALOG.map((def) => {
    const raw = (process.env[def.envKey] ?? "").trim();
    const enabled = !!raw || (def.id === "ollama" && !!config.ollamaHost);
    const configured = !!raw;
    let detail = "";
    let model: string | undefined;
    let health: { ok: boolean; detail: string } | undefined;

    switch (def.id) {
      case "openrouter": {
        model = config.openrouterModel;
        if (!configured) detail = "Not configured — all profiles run on Ollama (local-only)";
        else if (llm?.openrouter) health = { ok: llm.openrouter.ok, detail: llm.openrouter.error ?? llm.openrouter.model };
        if (!detail) detail = health ? (health.ok ? `Connected as ${model}` : health.detail) : `Key set (${prefixOf(raw)})`;
        break;
      }
      case "ollama": {
        model = config.ollamaModel;
        if (llm?.ollama) health = { ok: llm.ollama.ok, detail: llm.ollama.error ?? `model ${llm.ollama.model}` };
        detail = health ? (health.ok ? `Model ${model} at ${config.ollamaHost}` : health.detail) : `${config.ollamaHost} / ${model}`;
        break;
      }
      case "elevenlabs": {
        const naxieV = (process.env.ELEVENLABS_VOICE_ID ?? "").trim() || "T1LJmO1i3U7y9K38NWAy";
        const chatV = (process.env.ELEVENLABS_CHAT_VOICE_ID ?? "").trim() || "qBDvhofpxp92JgXJxDjB";
        detail = configured ? `Key set (${prefixOf(raw)}) — Naxie ${naxieV.slice(0,6)}… / Chat ${chatV.slice(0,6)}…` : "Not configured — falls back to Piper/pyttsx3";
        break;
      }
      case "supabase": {
        const url = (process.env.SUPABASE_URL ?? "").trim();
        if (!url) detail = "Not configured — Phase 2 pgvector/MAG not wired";
        else detail = config.supabaseEnabled ? `Connected to ${url}` : "URL set but missing secret key";
        break;
      }
      case "firecrawl": {
        detail = configured ? `Key set (${prefixOf(raw)})` : "Not configured — smartFetch stops at Playwright";
        break;
      }
      case "heygen": {
        detail = configured ? `Key set (${prefixOf(raw)})` : "Not configured — media.avatar_video returns storyboard only";
        break;
      }
      case "ayrshare": {
        detail = configured ? `Key set (${prefixOf(raw)})` : "Not configured — social.post not available";
        break;
      }
      case "ideogram": {
        detail = configured ? `Key set (${prefixOf(raw)})` : "Not configured — image gen uses OpenRouter Gemini";
        break;
      }
      case "muapi": {
        detail = configured ? `Key set (${prefixOf(raw)})` : "Not configured — image gen uses OpenRouter Gemini";
        break;
      }
      case "n8n": {
        const base = (process.env.N8N_BASE_URL ?? "").trim();
        if (!base || !raw) detail = "Not configured — set N8N_BASE_URL + N8N_API_KEY";
        else detail = config.n8nEnabled ? `Connected to ${base}` : "Base URL set but missing API key";
        // probe lazily via getExtensionsStatus caller; live health is in testExtension
        break;
      }
      default:
        detail = configured ? `Key set (${prefixOf(raw)})` : "Not configured";
    }

    const throttled = isThrottled(def.id);
    const cs = getCircuitState(def.id);
    const circuitInfo = cs.failures ? { state: cs.state, failures: cs.failures, until: cs.until } : undefined;
    return {
      id: def.id,
      name: def.name,
      category: def.category,
      description: def.description,
      envKey: def.envKey,
      docsUrl: def.docsUrl,
      testable: def.testable,
      enabled,
      configured,
      keyPrefix: configured ? prefixOf(raw) : undefined,
      model,
      detail: throttled ? `throttled — circuit open (${cs.failures} fails)` : detail,
      health: throttled ? { ok: false, detail: "throttled" } : health,
      throttled: throttled || undefined,
      circuit: circuitInfo,
    };
  });
}

export async function testExtension(id: string): Promise<{ ok: boolean; detail: string }> {
  const def = EXTENSION_CATALOG.find((d) => d.id === id);
  if (!def) return { ok: false, detail: `unknown extension "${id}"` };
  if (!def.testable) return { ok: false, detail: "no test available for this extension" };
  if (isThrottled(id)) return { ok: false, detail: `throttled — circuit open (cooldown 5m after 3 fails)` };
  const raw = (process.env[def.envKey] ?? "").trim();
  if (!raw && def.id !== "ollama") {
    const r = { ok: false, detail: `${def.envKey} not set` };
    recordHealth(id, r.ok, r.detail);
    recordCircuit(id, r.ok);
    return r;
  }

  const t0 = Date.now();
  let result: { ok: boolean; detail: string };
  switch (def.id) {
    case "openrouter": {
      try {
        const llm = await llmHealth();
        result = llm.openrouter.ok ? { ok: true, detail: `OpenRouter ok — ${llm.openrouter.model}` } : { ok: false, detail: llm.openrouter.error ?? "OpenRouter check failed" };
      } catch (e: any) { result = { ok: false, detail: String(e?.message ?? e) }; }
      break;
    }
    case "ollama": {
      try {
        const llm = await llmHealth();
        result = llm.ollama.ok ? { ok: true, detail: `Ollama ok — ${llm.ollama.model}` } : { ok: false, detail: llm.ollama.error ?? "Ollama unreachable" };
      } catch (e: any) { result = { ok: false, detail: String(e?.message ?? e) }; }
      break;
    }
    case "elevenlabs": {
      try {
        const r = await fetch(`https://api.elevenlabs.io/v1/voices`, { headers: { "xi-api-key": raw } });
        const j: any = await r.json().catch(() => ({}));
        result = r.ok ? { ok: true, detail: `ElevenLabs ok — ${j?.voices?.length ?? "?"} voices` } : { ok: false, detail: j?.detail?.message ?? j?.detail ?? `HTTP ${r.status}` };
      } catch (e: any) { result = { ok: false, detail: String(e?.message ?? e) }; }
      break;
    }
    case "supabase": {
      try {
        const url = (process.env.SUPABASE_URL ?? "").trim();
        const key = (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY ?? "").trim();
        if (!url || !key) result = { ok: false, detail: "SUPABASE_URL or key missing" };
        else {
          const r = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
          result = r.ok || r.status === 404 ? { ok: true, detail: `Supabase reachable (HTTP ${r.status})` } : { ok: false, detail: `HTTP ${r.status}` };
        }
      } catch (e: any) { result = { ok: false, detail: String(e?.message ?? e) }; }
      break;
    }
    case "heygen": {
      try {
        const r = await fetch("https://api.heygen.com/v2/avatars", { headers: { "x-api-key": raw, accept: "application/json" } });
        const j: any = await r.json().catch(() => ({}));
        if (r.ok && j?.data) {
          const n = (j.data.avatars?.length ?? 0) + (j.data.talking_photos?.length ?? 0);
          result = { ok: true, detail: `HeyGen ok — ${n} avatars` };
        } else result = { ok: false, detail: j?.error?.message ?? `HTTP ${r.status}` };
      } catch (e: any) { result = { ok: false, detail: String(e?.message ?? e) }; }
      break;
    }
    case "n8n": {
      try {
        const base = (process.env.N8N_BASE_URL ?? "").trim().replace(/\/+$/, "");
        if (!base) result = { ok: false, detail: "N8N_BASE_URL not set" };
        else {
          const r = await fetch(`${base}/api/v1/workflows?limit=1`, { headers: { "X-N8N-API-KEY": raw, accept: "application/json" } });
          const j: any = await r.json().catch(() => ({}));
          if (r.ok) result = { ok: true, detail: `n8n ok — ${j?.data?.length ?? 0} workflow(s) reachable at ${base}` };
          else result = { ok: false, detail: j?.message ?? `HTTP ${r.status} — check N8N_BASE_URL + N8N_API_KEY` };
        }
      } catch (e: any) { result = { ok: false, detail: String(e?.message ?? e) }; }
      break;
    }
    default:
      result = { ok: false, detail: "no test available" };
  }
  recordHealth(id, result.ok, result.detail, Date.now() - t0);
  recordCircuit(id, result.ok);
  return result;
}
