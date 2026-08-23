// Voice engine — gives employees (personas) a spoken presence over their
// reports. Three tiers, best-available wins, each independently optional:
//
//   realtime  — OpenAI Realtime (WebRTC, full-duplex, interruptible). Uses
//               the OpenAI provider key already registered in the model
//               pool; the server only mints a short-lived client secret and
//               the browser talks to the provider directly.
//   localTts  — an OpenAI-compatible speech sidecar (Kokoro-FastAPI, Piper
//               behind LocalAI, etc.) at NEUROWORKS_TTS_URL. Free, offline,
//               per-employee voices.
//   webSpeech — the browser's own speechSynthesis. Always there; the client
//               falls back to it when this module reports both tiers dark.
//
// Voice identity: each persona hashes to a stable voice per tier, so Nova
// always sounds like Nova without any manual mapping. (A future persona
// field can override.)

import { getFallbackChain } from "./model-providers.js";
import { config } from "../config.js";

// ── per-tier availability ──────────────────────────────────────────────────

const TTS_URL = (process.env.NEUROWORKS_TTS_URL ?? "").replace(/\/+$/, "");
const TTS_MODEL = process.env.NEUROWORKS_TTS_MODEL ?? "kokoro";
const TTS_KEY = process.env.NEUROWORKS_TTS_API_KEY ?? "";
const REALTIME_MODEL = process.env.NEUROWORKS_REALTIME_MODEL ?? "gpt-realtime";

// ElevenLabs — cloud TTS (Naxie = second-in-command voice, Chat = read-aloud)
const ELEVENLABS_API_KEY = (process.env.ELEVENLABS_API_KEY ?? "").trim();
const ELEVENLABS_NAXIE_VOICE = (process.env.ELEVENLABS_VOICE_ID ?? "T1LJmO1i3U7y9K38NWAy").trim();
const ELEVENLABS_CHAT_VOICE = (process.env.ELEVENLABS_CHAT_VOICE_ID ?? "qBDvhofpxp92JgXJxDjB").trim();
const ELEVENLABS_MODEL_ID = (process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2").trim();

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

export function elevenLabsAvailable(): boolean {
  return ELEVENLABS_API_KEY.length > 0;
}

export function elevenLabsVoiceForPersona(personaId: string | undefined): string {
  const pid = (personaId ?? "").toLowerCase();
  // Naxie is your second-in-command — dedicated voice T1LJ...
  if (pid === "naxie" || pid === "neuro" || pid === "clawbot") return ELEVENLABS_NAXIE_VOICE;
  // Chat read-aloud / general workers use the chat voice qBDv...
  return ELEVENLABS_CHAT_VOICE || ELEVENLABS_NAXIE_VOICE;
}

export async function synthesizeElevenLabs(text: string, voiceId: string): Promise<{ audio: Buffer; contentType: string }> {
  if (!ELEVENLABS_API_KEY) throw new Error("ElevenLabs not configured (ELEVENLABS_API_KEY)");
  const vid = voiceId || ELEVENLABS_NAXIE_VOICE;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: text.slice(0, 5000),
      model_id: ELEVENLABS_MODEL_ID,
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`ElevenLabs ${r.status}: ${t.slice(0, 300)}`);
  }
  const audio = Buffer.from(await r.arrayBuffer());
  if (audio.length === 0) throw new Error("ElevenLabs returned empty audio");
  return { audio, contentType: r.headers.get("content-type") ?? "audio/mpeg" };
}

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

export async function voiceStatus(): Promise<{ realtime: boolean; localTts: boolean; elevenLabs: boolean; realtimeModel: string; ttsUrlConfigured: boolean; naxieVoiceId: string; chatVoiceId: string }> {
  return {
    realtime: openaiCreds() !== null,
    localTts: await localTtsAvailable(),
    elevenLabs: elevenLabsAvailable(),
    realtimeModel: REALTIME_MODEL,
    ttsUrlConfigured: TTS_URL.length > 0,
    naxieVoiceId: ELEVENLABS_NAXIE_VOICE,
    chatVoiceId: ELEVENLABS_CHAT_VOICE,
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

export function voiceForPersona(personaId: string | undefined): { openaiVoice: string; localVoice: string; elevenLabsVoice: string } {
  const key = (personaId ?? "default").toLowerCase();
  return {
    openaiVoice: OPENAI_VOICES[hashIdx(key, OPENAI_VOICES.length)],
    localVoice: LOCAL_VOICES[hashIdx(key, LOCAL_VOICES.length)],
    elevenLabsVoice: elevenLabsVoiceForPersona(personaId),
  };
}

// ── tier B: ElevenLabs cloud first, then local sidecar ──────

export async function synthesizeWithVoice(text: string, personaId: string | undefined): Promise<{ audio: Buffer; contentType: string }> {
  // Prefer ElevenLabs when key is set — Naxie T1LJ... / Chat qBDv... are cloud voices
  if (elevenLabsAvailable()) {
    try {
      return await synthesizeElevenLabs(text, elevenLabsVoiceForPersona(personaId));
    } catch (e) {
      console.warn(`[voice] ElevenLabs failed, falling back to local sidecar: ${String((e as any)?.message ?? e).slice(0,120)}`);
    }
  }
  const v = voiceForPersona(personaId);
  return synthesizeLocal(text, v.localVoice);
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
