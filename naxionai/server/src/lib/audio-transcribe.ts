// Audio/video file transcription (speech-to-text).
//
// Ported by BEHAVIOR from naxionai/backend/agent/tools/transcription.py —
// that module's standalone local-Whisper transcriber (duration-tiered model
// picker, faster-whisper CPU int8, openai-whisper fallback needing ffmpeg).
// This port keeps the policy that matters and re-homes the execution:
//
//   - pickTranscribeModel() tiers are verbatim: short clips can afford a
//     heavier model (absolute compute is tiny either way); long clips drop
//     to a lighter one so a CPU-only box still finishes. Sent as the model
//     hint to the local sidecar and reported back in every result.
//   - Duration probing is ffprobe-only (best-effort, null when unavailable) —
//     Node has no PyAV equivalent, and the probe must not require loading a
//     model first, same constraint as the original.
//   - Engines mirror ocr.ts's local/cloud shape, not the Python module's
//     faster/openai split (both Python engines were in-process libraries —
//     there is no Node equivalent, so both become HTTP tiers):
//       "local" → OpenAI-compatible STT sidecar at NEUROWORKS_STT_URL
//                 (LocalAI whisper, faster-whisper-server, etc.)
//       "cloud" → OpenAI audio/transcriptions (whisper-1 default) via the
//                 same provider-pool credential lookup voice.ts uses.
//       "auto"  → local first when configured, cloud fallback.
//
// The Python original's faster-whisper-in-process path is intentionally not
// carried over: it needs the Python runtime + model weights on disk, which
// is exactly the backend dependency this port removes.

import { readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { extname, basename } from "node:path";
import { getFallbackChain } from "./model-providers.js";
import { config } from "../config.js";

export type TranscribeEngine = "auto" | "local" | "cloud";

export type TranscribeResult = {
  text: string;
  engine: "local" | "cloud";
  model: string;
  duration_seconds: number | null;
  language?: string;
  bytes: number;
  truncated: boolean;
};

const MAX_BYTES_IN = 25 * 1024 * 1024; // OpenAI transcription limit
const MAX_CHARS_OUT = 200_000;

const AUDIO_EXTS = new Set([
  ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac",
  ".mp4", ".webm", ".mpeg", ".mpga",
]);

// (max_duration_seconds, model_size) — first tier whose ceiling covers the
// clip wins. Verbatim from transcription.py's _DURATION_MODEL_TIERS.
const DURATION_MODEL_TIERS: [number, string][] = [
  [30, "medium"],
  [180, "small"],
  [3600, "base"],
  [Infinity, "tiny"],
];

const DEFAULT_MODEL_SIZE = "base"; // when duration can't be probed at all

export function pickTranscribeModel(durationSeconds: number | null): string {
  if (durationSeconds === null || Number.isNaN(durationSeconds)) return DEFAULT_MODEL_SIZE;
  for (const [ceiling, size] of DURATION_MODEL_TIERS) {
    if (durationSeconds <= ceiling) return size;
  }
  return DURATION_MODEL_TIERS[DURATION_MODEL_TIERS.length - 1][1];
}

function mimeForAudioExt(ext: string): string {
  switch (ext) {
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".m4a": return "audio/mp4";
    case ".ogg":
    case ".webm": return "audio/ogg";
    case ".flac": return "audio/flac";
    case ".aac": return "audio/aac";
    case ".mp4": return "video/mp4";
    case ".mpeg":
    case ".mpga": return "audio/mpeg";
    default: return "application/octet-stream";
  }
}

// Best-effort duration probe via ffprobe (15s budget). Null when ffprobe is
// missing or the container can't be read — callers fall back to DEFAULT_MODEL_SIZE.
export function probeDurationSeconds(absPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      absPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
    proc.on("error", () => resolve(null));
    const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} resolve(null); }, 15_000);
    proc.on("close", () => {
      clearTimeout(timer);
      const v = Number.parseFloat(out.trim());
      resolve(Number.isFinite(v) && v >= 0 ? v : null);
    });
  });
}

const STT_URL = (process.env.NEUROWORKS_STT_URL ?? "").replace(/\/+$/, "");
const STT_MODEL_OVERRIDE = (process.env.NEUROWORKS_STT_MODEL ?? "").trim();
const STT_CLOUD_MODEL = (process.env.NEUROWORKS_STT_CLOUD_MODEL ?? "whisper-1").trim() || "whisper-1";

// Same credential lookup as voice.ts's openaiCreds(): decrypted OpenAI key
// from the provider pool (or the shared OpenRouter slot when it points at
// api.openai.com).
function openaiSttCreds(): { apiKey: string; baseUrl: string } | null {
  for (const p of getFallbackChain()) {
    if (p.kind === "openai" && p.apiKey) return { apiKey: p.apiKey, baseUrl: p.baseUrl || "https://api.openai.com/v1" };
  }
  if (config.openrouterApiKey && /api\.openai\.com/.test(String(config.openrouterBaseUrl ?? ""))) {
    return { apiKey: config.openrouterApiKey, baseUrl: "https://api.openai.com/v1" };
  }
  return null;
}

export function localSttConfigured(): boolean {
  return STT_URL.length > 0;
}

export function cloudSttAvailable(): boolean {
  return openaiSttCreds() !== null;
}

async function postTranscription(
  endpoint: string,
  headers: Record<string, string> | undefined,
  buf: Buffer,
  filename: string,
  mime: string,
  model: string,
  language?: string,
): Promise<{ text: string; language?: string }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), filename);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  if (language) form.append("language", language);
  const r = await fetch(endpoint, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(300_000), // long clips take minutes
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    throw new Error(`transcription request failed: HTTP ${r.status} — ${detail}`);
  }
  const data: any = await r.json().catch(() => ({}));
  const text = String(data?.text ?? "").trim();
  const languageOut = typeof data?.language === "string" ? data.language : undefined;
  return { text, ...(languageOut ? { language: languageOut } : {}) };
}

async function transcribeLocal(
  buf: Buffer, filename: string, mime: string, model: string, language?: string,
): Promise<{ text: string; language?: string }> {
  return postTranscription(`${STT_URL}/audio/transcriptions`, undefined, buf, filename, mime, model, language);
}

async function transcribeCloud(
  buf: Buffer, filename: string, mime: string, language?: string,
): Promise<{ text: string; language?: string }> {
  const creds = openaiSttCreds();
  if (!creds) throw new Error("cloud transcription not configured (no OpenAI provider key)");
  return postTranscription(`${creds.baseUrl}/audio/transcriptions`, { Authorization: `Bearer ${creds.apiKey}` }, buf, filename, mime, STT_CLOUD_MODEL, language);
}

export async function transcribeAudioFile(
  absPath: string,
  engine: TranscribeEngine = "auto",
  language?: string,
  modelOverride?: string,
): Promise<TranscribeResult> {
  const st = statSync(absPath);
  if (!st.isFile()) throw new Error(`transcribe: not a file — ${absPath}`);
  if (st.size > MAX_BYTES_IN) throw new Error(`transcribe: file too large (${st.size} bytes, cap ${MAX_BYTES_IN})`);
  const ext = extname(absPath).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) {
    throw new Error(`transcribe: unsupported extension ${ext} — only ${[...AUDIO_EXTS].join(", ")} are handled`);
  }
  const buf = readFileSync(absPath);
  const duration = await probeDurationSeconds(absPath);
  const model = (modelOverride ?? "").trim() || STT_MODEL_OVERRIDE || pickTranscribeModel(duration);
  const lang = (language ?? "").trim() || undefined;
  const filename = basename(absPath);
  const mime = mimeForAudioExt(ext);

  const fail = (which: string) => `transcribe: ${which} engine unavailable — `;
  if (engine === "local") {
    if (!localSttConfigured()) throw new Error(`${fail("local")}set NEUROWORKS_STT_URL to an OpenAI-compatible STT sidecar`);
    const out = await transcribeLocal(buf, filename, mime, model, lang);
    return pack(out, "local", model, duration, buf.length);
  }
  if (engine === "cloud") {
    if (!cloudSttAvailable()) throw new Error(`${fail("cloud")}register an OpenAI provider key`);
    const out = await transcribeCloud(buf, filename, mime, lang);
    return pack(out, "cloud", STT_CLOUD_MODEL, duration, buf.length);
  }
  // auto — local first when configured, cloud fallback (mirrors ocr.ts).
  if (localSttConfigured()) {
    try {
      const out = await transcribeLocal(buf, filename, mime, model, lang);
      if (out.text.length > 0) return pack(out, "local", model, duration, buf.length);
      if (!cloudSttAvailable()) return pack(out, "local", model, duration, buf.length);
      const cloud = await transcribeCloud(buf, filename, mime, lang);
      return pack(cloud.text.length > out.text.length ? cloud : out, cloud.text.length > out.text.length ? "cloud" : "local", cloud.text.length > out.text.length ? STT_CLOUD_MODEL : model, duration, buf.length);
    } catch {
      if (cloudSttAvailable()) {
        const out = await transcribeCloud(buf, filename, mime, lang);
        return pack(out, "cloud", STT_CLOUD_MODEL, duration, buf.length);
      }
      throw new Error("transcribe: local sidecar failed and no cloud key is configured");
    }
  }
  if (cloudSttAvailable()) {
    const out = await transcribeCloud(buf, filename, mime, lang);
    return pack(out, "cloud", STT_CLOUD_MODEL, duration, buf.length);
  }
  throw new Error("transcribe: no engine available — set NEUROWORKS_STT_URL (local sidecar) or register an OpenAI provider key (cloud)");
}

function pack(
  out: { text: string; language?: string },
  engine: "local" | "cloud",
  model: string,
  duration: number | null,
  bytes: number,
): TranscribeResult {
  const truncated = out.text.length > MAX_CHARS_OUT;
  return {
    text: truncated ? out.text.slice(0, MAX_CHARS_OUT) : out.text,
    engine,
    model,
    duration_seconds: duration,
    ...(out.language ? { language: out.language } : {}),
    bytes,
    truncated,
  };
}

export function transcribeSupportsExt(ext: string): boolean {
  const e = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return AUDIO_EXTS.has(e);
}
