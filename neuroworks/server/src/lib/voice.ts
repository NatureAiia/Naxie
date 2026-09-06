// Voice engine — gives employees (personas) a spoken presence over their
// reports. Three tiers, best-available wins, each independently optional:
//
//   realtime  — OpenAI Realtime (WebRTC, full-duplex, interruptible). Uses
//               the OpenAI provider key already registered in the model
//               pool; the server only mints a short-lived client secret and
//               the browser talks to the provider directly.
//   openaiTts — OpenAI's cloud text-to-speech (gpt-4o-mini-tts), used for
//               narration / read-aloud (the /api/voice/tts endpoint). Same
//               credential lookup as realtime, or a dedicated
//               OPENAI_TTS_API_KEY. Supports a natural-language `instructions`
//               field to steer delivery style per persona.
//   localTts  — an OpenAI-compatible speech sidecar (Kokoro-FastAPI, Piper
//               behind LocalAI, etc.) at NEUROWORKS_TTS_URL. Free, offline,
//               per-employee voices. Falls back here if openaiTts fails.
//   webSpeech — the browser's own speechSynthesis. Always there; the client
//               falls back to it when this module reports both tiers dark.
//
// Voice identity: each persona hashes to a stable voice per tier, so Nova
// always sounds like Nova without any manual mapping. (A future persona
// field can override.)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getFallbackChain } from "./model-providers.js";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── per-tier availability ──────────────────────────────────────────────────

const TTS_URL = (process.env.NEUROWORKS_TTS_URL ?? "").replace(/\/+$/, "");
const TTS_MODEL = process.env.NEUROWORKS_TTS_MODEL ?? "kokoro";
const TTS_KEY = process.env.NEUROWORKS_TTS_API_KEY ?? "";
const REALTIME_MODEL = process.env.NEUROWORKS_REALTIME_MODEL ?? "gpt-realtime";

// Decrypted OpenAI credentials from the provider pool. The fallback chain
// carries every NON-active registered provider decrypted; if OpenAI happens
// to be the ACTIVE provider instead, its key was applied to the runtime
// config slots (applyToRuntime), so check there second.
function openaiCreds(): { apiKey: string; baseUrl: string } | null {
  for (const p of getFallbackChain()) {
    if (p.kind === "openai" && p.apiKey) return { apiKey: p.apiKey, baseUrl: p.baseUrl || "https://api.openai.com/v1" };
  }
  if (config.openrouterApiKey && /api\.openai\.com/.test(String(config.openrouterBaseUrl ?? ""))) {
    return { apiKey: config.openrouterApiKey, baseUrl: "https://api.openai.com/v1" };
  }
  return null;
}

// OpenAI TTS — a DEDICATED key (independent of whichever provider is active
// for chat/realtime) is preferred so TTS spend isn't silently mixed into a
// shared key's usage; falls back to the provider-pool/realtime credentials
// above when no dedicated key is set.
const OPENAI_TTS_API_KEY = (process.env.OPENAI_TTS_API_KEY ?? "").trim();
const OPENAI_TTS_BASE_URL = (process.env.OPENAI_TTS_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const OPENAI_TTS_MODEL = (process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts").trim();

function openaiTtsCreds(): { apiKey: string; baseUrl: string } | null {
  if (OPENAI_TTS_API_KEY) return { apiKey: OPENAI_TTS_API_KEY, baseUrl: OPENAI_TTS_BASE_URL };
  return openaiCreds();
}

export function openaiTtsAvailable(): boolean {
  return openaiTtsCreds() !== null;
}

// Naxie's voice brief (operator-specified): smooth, mid-range, comforting,
// approachable, subtle conversational warmth, studio-quality diction, steady
// professional pacing — reassuring and capable without robotic stiffness or
// over-the-top excitement. "sage" is OpenAI's calm/measured voice, closest
// static match; NEUROWORKS_NAXIE_OPENAI_VOICE overrides the voice id and
// NEUROWORKS_NAXIE_VOICE_INSTRUCTIONS overrides the delivery brief below.
const NAXIE_OPENAI_VOICE = (process.env.NEUROWORKS_NAXIE_OPENAI_VOICE ?? "sage").trim();
const NAXIE_VOICE_INSTRUCTIONS = (process.env.NEUROWORKS_NAXIE_VOICE_INSTRUCTIONS ?? (
  "A smooth, mid-range female voice with a naturally comforting and approachable quality. " +
  "Subtle conversational warmth, as if speaking with a smile, while maintaining impeccable " +
  "studio-quality diction, clear pronunciation, and steady, professional pacing. Reassuring, " +
  "intelligent, and highly capable — avoid any rigid robotic stiffness or over-the-top excitement."
)).trim();

let ttsProbe: { at: number; ok: boolean } | null = null;
export async function localTtsAvailable(): Promise<boolean> {
  if (!TTS_URL) return false;
  if (ttsProbe && Date.now() - ttsProbe.at < 60_000) return ttsProbe.ok;
  let ok = false;
  try {
    const r = await fetch(`${TTS_URL}/models`, {
      headers: TTS_KEY ? { Authorization: `Bearer ${TTS_KEY}` } : undefined,
      signal: AbortSignal.timeout(3000),
    });
    ok = r.ok;
  } catch { ok = false; }
  ttsProbe = { at: Date.now(), ok };
  return ok;
}

export async function voiceStatus(): Promise<{ realtime: boolean; openaiTts: boolean; localTts: boolean; realtimeModel: string; ttsUrlConfigured: boolean }> {
  return {
    realtime: openaiCreds() !== null,
    openaiTts: openaiTtsAvailable(),
    localTts: await localTtsAvailable(),
    realtimeModel: REALTIME_MODEL,
    ttsUrlConfigured: TTS_URL.length > 0,
  };
}

// ── voice identity ─────────────────────────────────────────────────────────

const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];
// Kokoro voice ids (Kokoro-FastAPI naming). If the sidecar is Piper-based the
// model name wins and this list is simply ignored by the server.
const LOCAL_VOICES = ["af_heart", "am_adam", "af_bella", "bm_george", "af_sky", "am_michael", "bf_emma", "af_nicole"];

function hashIdx(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

export function voiceForPersona(personaId: string | undefined): { openaiVoice: string; localVoice: string } {
  const key = (personaId ?? "default").toLowerCase();
  const isNaxie = key === "naxie" || key === "neuro" || key === "clawbot";
  // Naxie is pinned to specific voices rather than the hash — the hash can
  // land anywhere in the list, including a voice that doesn't match her
  // identity (e.g. a male Kokoro voice, or OpenAI's energetic "nova").
  const localVoice = isNaxie ? "af_heart" : LOCAL_VOICES[hashIdx(key, LOCAL_VOICES.length)];
  const openaiVoice = isNaxie ? NAXIE_OPENAI_VOICE : OPENAI_VOICES[hashIdx(key, OPENAI_VOICES.length)];
  return { openaiVoice, localVoice };
}

// ── on-disk TTS cache ────────────────────────────────────────────────────
// Same content-hash cache naxionai/backend/api/voice.py already has
// (_tts_cache_key/_tts_cache_load/_tts_cache_store) — ported here so this
// side stops re-hitting the TTS provider/sidecar for repeated narration of
// the same text (a persona re-reading the same report line, a cached
// tooltip, ...). Key = sha256(text|voice|tier); tier stands in for Python's
// "engine" dimension (which provider actually produced the audio), since
// that's what determines the voice namespace here.

export const TTS_CACHE_DIR = resolve(__dirname, "../../../.neuroworks", "tts_cache");
const TTS_CACHE_EXT_BY_CONTENT_TYPE: Record<string, string> = { "audio/mpeg": "mp3", "audio/wav": "wav" };

export function ttsCacheKey(text: string, voice: string, tier: string): string {
  return createHash("sha256").update(`${text}|${voice}|${tier}`).digest("hex");
}

export function ttsCacheLoad(key: string): { audio: Buffer; contentType: string } | null {
  for (const [contentType, ext] of Object.entries(TTS_CACHE_EXT_BY_CONTENT_TYPE)) {
    const path = join(TTS_CACHE_DIR, `${key}.${ext}`);
    if (existsSync(path)) {
      try { return { audio: readFileSync(path), contentType }; } catch { return null; }
    }
  }
  return null;
}

export function ttsCacheStore(key: string, audio: Buffer, contentType: string): void {
  const ext = TTS_CACHE_EXT_BY_CONTENT_TYPE[contentType];
  if (!ext) return;
  try {
    mkdirSync(TTS_CACHE_DIR, { recursive: true });
    writeFileSync(join(TTS_CACHE_DIR, `${key}.${ext}`), audio);
  } catch (e) {
    console.warn(`[voice] Failed to write TTS cache entry: ${String((e as any)?.message ?? e).slice(0, 120)}`);
  }
}

// ── tiers B/C: OpenAI cloud TTS, then local sidecar ─────────────

export async function synthesizeWithVoice(text: string, personaId: string | undefined): Promise<{ audio: Buffer; contentType: string }> {
  const v = voiceForPersona(personaId);
  const key = (personaId ?? "").toLowerCase();
  const isNaxie = key === "naxie" || key === "neuro" || key === "clawbot";
  const openaiCacheKey = ttsCacheKey(text, v.openaiVoice, "openai");
  const localCacheKey = ttsCacheKey(text, v.localVoice, "local");

  if (openaiTtsAvailable()) {
    const cached = ttsCacheLoad(openaiCacheKey);
    if (cached) return cached;
    try {
      const out = await synthesizeOpenAITts(text, v.openaiVoice, isNaxie ? NAXIE_VOICE_INSTRUCTIONS : undefined);
      ttsCacheStore(openaiCacheKey, out.audio, out.contentType);
      return out;
    } catch (e) {
      console.warn(`[voice] OpenAI TTS failed, falling back to local sidecar: ${String((e as any)?.message ?? e).slice(0, 120)}`);
    }
  }

  const cachedLocal = ttsCacheLoad(localCacheKey);
  if (cachedLocal) return cachedLocal;
  const out = await synthesizeLocal(text, v.localVoice);
  ttsCacheStore(localCacheKey, out.audio, out.contentType);
  return out;
}

export async function synthesizeOpenAITts(text: string, voice: string, instructions?: string): Promise<{ audio: Buffer; contentType: string }> {
  const creds = openaiTtsCreds();
  if (!creds) throw new Error("OpenAI TTS not configured (OPENAI_TTS_API_KEY or a registered OpenAI provider)");
  const r = await fetch(`${creds.baseUrl}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({
      model: OPENAI_TTS_MODEL,
      voice,
      input: text.slice(0, 4000),
      response_format: "mp3",
      ...(instructions ? { instructions: instructions.slice(0, 1000) } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI TTS ${r.status}: ${t.slice(0, 300)}`);
  }
  const audio = Buffer.from(await r.arrayBuffer());
  if (audio.length === 0) throw new Error("OpenAI TTS returned empty audio");
  return { audio, contentType: r.headers.get("content-type") ?? "audio/mpeg" };
}

export async function synthesizeLocal(text: string, voice: string): Promise<{ audio: Buffer; contentType: string }> {
  if (!TTS_URL) throw new Error("no local TTS sidecar configured (NEUROWORKS_TTS_URL)");
  const r = await fetch(`${TTS_URL}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(TTS_KEY ? { Authorization: `Bearer ${TTS_KEY}` } : {}),
    },
    body: JSON.stringify({ model: TTS_MODEL, voice, input: text.slice(0, 4000), response_format: "mp3" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`TTS sidecar ${r.status}: ${t.slice(0, 200)}`);
  }
  const audio = Buffer.from(await r.arrayBuffer());
  if (audio.length === 0) throw new Error("TTS sidecar returned empty audio");
  return { audio, contentType: r.headers.get("content-type") ?? "audio/mpeg" };
}

// ── tier A: realtime session mint (browser connects to provider directly) ──

export async function mintRealtimeSession(instructions: string, voice: string): Promise<{ clientSecret: string; expiresAt?: number; model: string; voice: string; baseUrl: string }> {
  const creds = openaiCreds();
  if (!creds) throw new Error("no OpenAI provider registered — realtime voice needs one in the model pool");
  const r = await fetch(`${creds.baseUrl}/realtime/client_secrets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        instructions: instructions.slice(0, 12_000),
        audio: { output: { voice } },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`realtime session mint failed (${r.status}): ${t.slice(0, 300)}`);
  }
  const j: any = await r.json();
  const secret = j?.value ?? j?.client_secret?.value;
  if (!secret) throw new Error("provider returned no client secret");
  return {
    clientSecret: String(secret),
    expiresAt: typeof j?.expires_at === "number" ? j.expires_at : undefined,
    model: REALTIME_MODEL,
    voice,
    baseUrl: creds.baseUrl,
  };
}
