// Voice engine — gives employees (personas) a spoken presence over their
// reports. Three tiers, best-available wins, each independently optional:
//
//   edge      — Microsoft Edge neural TTS (FREE, no key — Naxie is voiced by
//               en-GB-LibbyNeural, a bright, warm British female). Used for narration
//               / read-aloud (the /api/voice/tts endpoint). First choice.
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
//               behind LocalAI, etc.) at NAXION_TTS_URL. Free, offline,
//               per-employee voices. Falls back here if cloud TTS fails.
//   webSpeech — the browser's own speechSynthesis. Always there; the client
//               falls back to it when this module reports all tiers dark.
//
// Voice identity: Naxie is pinned to Libby (Edge) / sage (OpenAI) / af_heart
// (Kokoro) rather than the persona hash, so she always sounds like herself.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EdgeTTS } from "node-edge-tts";
import { getFallbackChain } from "./model-providers.js";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── per-tier availability ──────────────────────────────────────────────────

const TTS_URL = (process.env.NAXION_TTS_URL ?? "").replace(/\/+$/, "");
const TTS_MODEL = process.env.NAXION_TTS_MODEL ?? "kokoro";
const TTS_KEY = process.env.NAXION_TTS_API_KEY ?? "";
const REALTIME_MODEL = process.env.NAXION_REALTIME_MODEL ?? "gpt-realtime";

// ── Edge TTS (FREE, no key — primary narration voice) ───────────────────
// Microsoft neural voices over a free endpoint. Naxie is en-GB-LibbyNeural
// (bright, warm British female); override with NAXION_EDGE_VOICE. No availability
// probe — Edge exposes no cheap health endpoint, so this tier is attempted
// first and falls through to OpenAI/local on any failure.
const EDGE_VOICE = (process.env.NAXION_EDGE_VOICE ?? "en-GB-LibbyNeural").trim() || "en-GB-LibbyNeural";

export function edgeAvailable(): boolean {
  return true;
}

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
// static match; NAXION_NAXIE_OPENAI_VOICE overrides the voice id and
// NAXION_NAXIE_VOICE_INSTRUCTIONS overrides the delivery brief below.
const NAXIE_OPENAI_VOICE = (process.env.NAXION_NAXIE_OPENAI_VOICE ?? "sage").trim();
const NAXIE_VOICE_INSTRUCTIONS = (process.env.NAXION_NAXIE_VOICE_INSTRUCTIONS ?? (
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

export async function voiceStatus(): Promise<{ realtime: boolean; edge: boolean; openaiTts: boolean; localTts: boolean; realtimeModel: string; ttsUrlConfigured: boolean; wakeWord: { available: boolean; modelDir: string | null; phrase: string; variants: string[] } }> {
  let wakeWord: { available: boolean; modelDir: string | null; phrase: string; variants: string[] };
  try {
    const { wakeWordStatus } = await import("./wake-word.js");
    wakeWord = wakeWordStatus();
  } catch {
    wakeWord = { available: false, modelDir: null, phrase: "hey naxie", variants: ["hey naxie"] };
  }
  return {
    realtime: openaiCreds() !== null,
    edge: edgeAvailable(),
    openaiTts: openaiTtsAvailable(),
    localTts: await localTtsAvailable(),
    realtimeModel: REALTIME_MODEL,
    ttsUrlConfigured: TTS_URL.length > 0,
    wakeWord,
  };
}

// ── voice identity ─────────────────────────────────────────────────────────

const OPENAI_VOICES = ["coral", "sage", "shimmer"];
// Kokoro voice ids (Kokoro-FastAPI naming). Female-only by operator rule —
// every persona, employee voice, and Telegram audio is a female voice, so
// the masculine lanes (am_adam, bm_george, am_michael) are out. If the
// sidecar is Piper-based the model name wins and this list is simply ignored
// by the server.
const LOCAL_VOICES = ["af_heart", "af_bella", "af_sky", "bf_emma", "af_nicole"];

function hashIdx(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % mod;
}

// Naxie's two voices (operator rule): bf_emma is her MAIN voice, af_heart
// does read-alouds + sent audios and is the secondary when main fails.
// Override with NAXION_NAXIE_MAIN_VOICE / NAXION_NAXIE_READALOUD_VOICE.
const NAXIE_MAIN_VOICE = (process.env.NAXION_NAXIE_MAIN_VOICE ?? "bf_emma").trim() || "bf_emma";
const NAXIE_READALOUD_VOICE = (process.env.NAXION_NAXIE_READALOUD_VOICE ?? "af_heart").trim() || "af_heart";

export type NaxieVoicePurpose = "main" | "readaloud";

export function voiceForPersona(personaId: string | undefined): { openaiVoice: string; localVoice: string; edgeVoice: string } {
  const key = (personaId ?? "default").toLowerCase();
  const isNaxie = key === "naxie" || key === "naxie-agent";
  // Naxie is pinned to her two voices rather than the hash — the hash can
  // land anywhere in the list. Main voice for speech, read-aloud voice for
  // read-alouds/sent audios (see NAXIE_MAIN_VOICE / NAXIE_READALOUD_VOICE).
  // Edge: single voice (Libby) for everyone — Naxie's voice is the house voice.
  const localVoice = isNaxie ? NAXIE_MAIN_VOICE : LOCAL_VOICES[hashIdx(key, LOCAL_VOICES.length)];
  const openaiVoice = isNaxie ? NAXIE_OPENAI_VOICE : OPENAI_VOICES[hashIdx(key, OPENAI_VOICES.length)];
  return { openaiVoice, localVoice, edgeVoice: EDGE_VOICE };
}

// ── on-disk TTS cache ────────────────────────────────────────────────────
// Same content-hash cache naxionai/backend/api/voice.py already has
// (_tts_cache_key/_tts_cache_load/_tts_cache_store) — ported here so this
// side stops re-hitting the TTS provider/sidecar for repeated narration of
// the same text (a persona re-reading the same report line, a cached
// tooltip, ...). Key = sha256(text|voice|tier); tier stands in for Python's
// "engine" dimension (which provider actually produced the audio), since
// that's what determines the voice namespace here.

export const TTS_CACHE_DIR = resolve(__dirname, "../../../.naxion", "tts_cache");
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

const TTS_CACHE_MAX_FILES = Number(process.env.NAXION_TTS_CACHE_MAX_FILES ?? 500);
const TTS_CACHE_MAX_BYTES = Number(process.env.NAXION_TTS_CACHE_MAX_BYTES ?? 200 * 1024 * 1024);

function pruneTtsCacheIfNeeded(): void {
  try {
    const files = readdirSync(TTS_CACHE_DIR)
      .map((name: string) => {
        const p = join(TTS_CACHE_DIR, name);
        try {
          const s = statSync(p);
          return { path: p, mtimeMs: s.mtimeMs, size: s.size };
        } catch { return null; }
      })
      .filter(Boolean) as { path: string; mtimeMs: number; size: number }[];
    if (files.length <= TTS_CACHE_MAX_FILES && files.reduce((a, f) => a + f.size, 0) <= TTS_CACHE_MAX_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    let total = files.reduce((a, f) => a + f.size, 0);
    let count = files.length;
    for (const f of files) {
      if (count <= TTS_CACHE_MAX_FILES && total <= TTS_CACHE_MAX_BYTES) break;
      try { unlinkSync(f.path); total -= f.size; count -= 1; } catch { /* ignore */ }
    }
  } catch { /* ignore — cache dir missing or unreadable */ }
}

export function ttsCacheStore(key: string, audio: Buffer, contentType: string): void {
  const ext = TTS_CACHE_EXT_BY_CONTENT_TYPE[contentType];
  if (!ext) return;
  try {
    mkdirSync(TTS_CACHE_DIR, { recursive: true });
    writeFileSync(join(TTS_CACHE_DIR, `${key}.${ext}`), audio);
    pruneTtsCacheIfNeeded();
  } catch (e) {
    console.warn(`[voice] Failed to write TTS cache entry: ${String((e as any)?.message ?? e).slice(0, 120)}`);
  }
}

// ── tiers: free Edge TTS first, then OpenAI, then local sidecar ──────────

// `onChunk`, when given, is called with each chunk of audio as it arrives
// from the provider (or once, with the whole thing, on a cache hit) — this is
// the only change needed to support streamed playback; the existing
// fully-buffered callers (routes/voice.ts's /tts) simply omit it and get
// identical behavior to before.
export async function synthesizeWithVoice(
  text: string,
  personaId: string | undefined,
  onChunk?: (chunk: Buffer) => void,
  purpose: NaxieVoicePurpose = "main",
): Promise<{ audio: Buffer; contentType: string }> {
  const v = voiceForPersona(personaId);
  const key = (personaId ?? "").toLowerCase();
  const isNaxie = key === "naxie" || key === "naxie-agent";
  const edgeCacheKey = ttsCacheKey(text, v.edgeVoice, "edge");
  const openaiCacheKey = ttsCacheKey(text, v.openaiVoice, "openai");
  const localCacheKey = ttsCacheKey(text, v.localVoice, "local");
  // Naxie's Kokoro voice by purpose: bf_emma speaks, af_heart reads aloud
  // (and covers if main fails). Other personas use their hashed local voice.
  const kokoroVoice = isNaxie
    ? (purpose === "readaloud" ? NAXIE_READALOUD_VOICE : NAXIE_MAIN_VOICE)
    : v.localVoice;

  // Naxie leads with Kokoro so she always sounds like herself (her two
  // voices); everyone else keeps Edge-first order with Kokoro as the local
  // tier ahead of SAPI.
  if (isNaxie) {
    const kokoroCacheKey = ttsCacheKey(text, kokoroVoice, "kokoro");
    const cachedKokoro = ttsCacheLoad(kokoroCacheKey);
    if (cachedKokoro) { onChunk?.(cachedKokoro.audio); return cachedKokoro; }
    try {
      const out = await synthesizeKokoroVoice(text, kokoroVoice, isNaxie, onChunk);
      ttsCacheStore(kokoroCacheKey, out.audio, out.contentType);
      return out;
    } catch (e) {
      console.warn(`[voice] Kokoro failed, falling back: ${String((e as any)?.message ?? e).slice(0, 120)}`);
    }
  }

  if (edgeAvailable()) {
    const cached = ttsCacheLoad(edgeCacheKey);
    if (cached) { onChunk?.(cached.audio); return cached; }
    try {
      const out = await synthesizeEdgeTts(text, v.edgeVoice, onChunk);
      ttsCacheStore(edgeCacheKey, out.audio, out.contentType);
      return out;
    } catch (e) {
      console.warn(`[voice] Edge TTS failed, falling back: ${String((e as any)?.message ?? e).slice(0, 120)}`);
    }
  }

  if (openaiTtsAvailable()) {
    const cached = ttsCacheLoad(openaiCacheKey);
    if (cached) { onChunk?.(cached.audio); return cached; }
    try {
      const out = await synthesizeOpenAITts(text, v.openaiVoice, isNaxie ? NAXIE_VOICE_INSTRUCTIONS : undefined, onChunk);
      ttsCacheStore(openaiCacheKey, out.audio, out.contentType);
      return out;
    } catch (e) {
      console.warn(`[voice] OpenAI TTS failed, falling back to Windows SAPI: ${String((e as any)?.message ?? e).slice(0, 120)}`);
    }
  }

  // Embedded Kokoro for everyone else (neural, free, offline after first
  // download) — ahead of the robotic SAPI floor.
  if (!isNaxie) {
    const kokoroCacheKey = ttsCacheKey(text, v.localVoice, "kokoro");
    const cachedKokoro = ttsCacheLoad(kokoroCacheKey);
    if (cachedKokoro) { onChunk?.(cachedKokoro.audio); return cachedKokoro; }
    try {
      const out = await synthesizeKokoroVoice(text, v.localVoice, false, onChunk);
      ttsCacheStore(kokoroCacheKey, out.audio, out.contentType);
      return out;
    } catch (e) {
      console.warn(`[voice] Kokoro failed, falling back: ${String((e as any)?.message ?? e).slice(0, 120)}`);
    }
  }

  // Windows built-in speech (System.Speech) — robotic next to neural
  // voices, but free, offline, keyless, and always present on this box.
  // This is what keeps read-aloud (and Telegram voice notes) alive when
  // Edge is blocked and OpenAI has no credits.
  if (sapiAvailable()) {
    const sapiCacheKey = ttsCacheKey(text, "sapi-default", "sapi");
    const cachedSapi = ttsCacheLoad(sapiCacheKey);
    if (cachedSapi) { onChunk?.(cachedSapi.audio); return cachedSapi; }
    try {
      const out = await synthesizeSapi(text, onChunk);
      ttsCacheStore(sapiCacheKey, out.audio, out.contentType);
      return out;
    } catch (e) {
      console.warn(`[voice] Windows SAPI failed, falling back to local sidecar: ${String((e as any)?.message ?? e).slice(0, 120)}`);
    }
  }

  const cachedLocal = ttsCacheLoad(localCacheKey);
  if (cachedLocal) { onChunk?.(cachedLocal.audio); return cachedLocal; }
  const out = await synthesizeLocal(text, v.localVoice, onChunk);
  ttsCacheStore(localCacheKey, out.audio, out.contentType);
  return out;
}

// ── Embedded Kokoro-82M (Apache-2.0, free) ────────────────────────────────
// In-process ONNX synthesis — no sidecar to run, no key, no network after
// the first model download. Naxie speaks bf_emma, reads aloud af_heart;
// anyone else uses their hashed (female-only) local voice.
let kokoroTts: any = null;
let kokoroLoadFailed = false;

async function loadKokoro(): Promise<any> {
  if (kokoroTts) return kokoroTts;
  if (kokoroLoadFailed) throw new Error("kokoro-js unavailable (previous load failed)");
  let mod: any;
  try {
    // Non-literal specifier so tsc doesn't require the package at build
    // time — availability is a runtime concern (caught below).
    const spec: string = "kokoro-js";
    mod = await import(spec);
  } catch {
    kokoroLoadFailed = true;
    throw new Error("kokoro-js not installed - run `pnpm -F naxion-server add kokoro-js`");
  }
  const KokoroTTS = mod.KokoroTTS ?? mod.default?.KokoroTTS ?? mod.default;
  if (!KokoroTTS?.from_pretrained) {
    kokoroLoadFailed = true;
    throw new Error("kokoro-js has no KokoroTTS.from_pretrained export");
  }
  try {
    kokoroTts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-ONNX", { dtype: "q8" });
  } catch (e: any) {
    kokoroLoadFailed = true;
    throw new Error(`Kokoro model load failed: ${String(e?.message ?? e).slice(0, 160)}`);
  }
  return kokoroTts;
}

export async function synthesizeKokoroVoice(
  text: string,
  voice: string,
  naxieSecondaryFallback: boolean,
  onChunk?: (chunk: Buffer) => void,
): Promise<{ audio: Buffer; contentType: string }> {
  const tts = await loadKokoro();
  const speak = text.slice(0, 4000).trim();
  if (!speak) throw new Error("nothing to speak");
  const attempt = async (v: string): Promise<Buffer> => {
    const audio: any = await Promise.race([
      tts.generate(speak, { voice: v }),
      new Promise((_res, rej) => setTimeout(() => rej(new Error("Kokoro timed out after 180s")), 180_000)),
    ]);
    const wav: Blob = await audio.toWav();
    const buf = Buffer.from(await wav.arrayBuffer());
    if (buf.length < 100 || buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("Kokoro produced no usable audio");
    return buf;
  };
  try {
    const audio = await attempt(voice);
    onChunk?.(audio);
    return { audio, contentType: "audio/wav" };
  } catch (e: any) {
    // Naxie's secondary rule: af_heart covers when her main voice fails.
    if (naxieSecondaryFallback && voice !== NAXIE_READALOUD_VOICE) {
      console.warn(`[voice] Kokoro voice ${voice} failed, retrying ${NAXIE_READALOUD_VOICE}: ${String(e?.message ?? e).slice(0, 120)}`);
      const audio = await attempt(NAXIE_READALOUD_VOICE);
      onChunk?.(audio);
      return { audio, contentType: "audio/wav" };
    }
    throw e;
  }
}

// Reads a fetch Response body chunk-by-chunk, forwarding each chunk to
// `onChunk` as it arrives (for streamed playback) while also accumulating
// the full buffer (for the on-disk cache, and for callers that omit
// `onChunk` and just want the complete result like before).
async function collectStreamed(r: Response, onChunk?: (chunk: Buffer) => void): Promise<Buffer> {
  if (!onChunk || !r.body) return Buffer.from(await r.arrayBuffer());
  const reader = r.body.getReader();
  const chunks: Buffer[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const buf = Buffer.from(value);
    chunks.push(buf);
    onChunk(buf);
  }
  return Buffer.concat(chunks);
}

export function sapiAvailable(): boolean {
  return process.platform === "win32";
}

// Windows built-in speech synthesis (System.Speech → WAV file). Text travels
// over the subprocess STDIN and the output path over an env var — neither is
// ever interpolated into the script (same posture as host-tools.ts).
export async function synthesizeSapi(text: string, onChunk?: (chunk: Buffer) => void): Promise<{ audio: Buffer; contentType: string }> {
  if (!sapiAvailable()) throw new Error("Windows SAPI unavailable on this host");
  const { execFile } = await import("node:child_process");
  const tmp = join(tmpdir(), `naxie-sapi-${randomUUID()}.wav`);
  const script = [
    "$text = [Console]::In.ReadToEnd()",
    "if ([string]::IsNullOrWhiteSpace($text)) { exit 2 }",
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$synth.Rate = 0",
    // Female voice, pinned: Microsoft Zira Desktop (en-US). Default voice on
    // some boxes is David (male) — the operator rule is female everywhere.
    "try { $synth.SelectVoice('Microsoft Zira Desktop') } catch {",
    "  $fem = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Gender -eq 'Female' } | Select-Object -First 1",
    "  if ($fem) { $synth.SelectVoice($fem.VoiceInfo.Name) }",
    "}",
    "$synth.SetOutputToWaveFile($env:NAXIE_SAPI_OUT)",
    "$synth.Speak($text) | Out-Null",
    "$synth.Dispose()",
  ].join("\n");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile("powershell", ["-NoProfile", "-Command", script], {
        env: { ...process.env, NAXIE_SAPI_OUT: tmp },
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }, (err) => (err ? reject(err) : resolve()));
      child.stdin?.write(text.slice(0, 4000));
      child.stdin?.end();
    });
    const audio = readFileSync(tmp);
    if (audio.length < 100 || audio.toString("ascii", 0, 4) !== "RIFF") {
      throw new Error("SAPI produced no usable audio");
    }
    onChunk?.(audio);
    return { audio, contentType: "audio/wav" };
  } finally {
    try { unlinkSync(tmp); } catch { /* best-effort tmp cleanup */ }
  }
}

export async function synthesizeEdgeTts(text: string, voice: string, onChunk?: (chunk: Buffer) => void): Promise<{ audio: Buffer; contentType: string }> {
  const vid = (voice || EDGE_VOICE).trim() || EDGE_VOICE;
  const tmp = join(tmpdir(), `naxie-edge-${randomUUID()}.mp3`);
  try {
    const tts = new EdgeTTS({ voice: vid });
    await tts.ttsPromise(text.slice(0, 4000), tmp);
    const audio = readFileSync(tmp);
    if (audio.length === 0) throw new Error("Edge TTS returned empty audio");
    onChunk?.(audio);
    return { audio, contentType: "audio/mpeg" };
  } finally {
    try { unlinkSync(tmp); } catch { /* best-effort tmp cleanup */ }
  }
}

export async function synthesizeOpenAITts(text: string, voice: string, instructions?: string, onChunk?: (chunk: Buffer) => void): Promise<{ audio: Buffer; contentType: string }> {
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
  const audio = await collectStreamed(r, onChunk);
  if (audio.length === 0) throw new Error("OpenAI TTS returned empty audio");
  return { audio, contentType: r.headers.get("content-type") ?? "audio/mpeg" };
}

export async function synthesizeLocal(text: string, voice: string, onChunk?: (chunk: Buffer) => void): Promise<{ audio: Buffer; contentType: string }> {
  if (!TTS_URL) throw new Error("no local TTS sidecar configured (NAXION_TTS_URL)");
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
  const audio = await collectStreamed(r, onChunk);
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
