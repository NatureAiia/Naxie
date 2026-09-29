// Wake-word detection — offline, grammar-constrained Vosk (Phase 2a: server-side Vosk over WS/HTTP).
// Ported by behavior from naxionai/backend/agent/wake_word.py + api/voice.py's /ws/wake.
//
// The brand name "naxie" isn't in vosk-model-small-en-us-0.15's dictionary, so a
// grammar-constrained decode against phonetic near-homophones is load-bearing.
// See wake_word.py's _PHONETIC_VARIANTS / _build_grammar — ported verbatim.

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Model home: neuroworks/server/media/vosk_model (moved out of the retired
// naxionai/backend — same files, git history preserved via rename).
const VOSK_MODEL_CANDIDATES = [
  resolve(__dirname, "../../../media/vosk_model"),
  resolve(__dirname, "../../media/vosk_model"),
];

const PHONETIC_VARIANTS: Record<string, string[]> = {
  naxie: ["nexi", "naxi", "nyx", "nixie", "natty", "nexus", "annex"],
};

export function buildGrammar(phrase: string): string[] {
  const lower = phrase.trim().toLowerCase();
  if (!lower) return [];
  const words = lower.split(/\s+/);
  const variants = new Set<string>([lower]);
  for (let i = 0; i < words.length; i++) {
    const alts = PHONETIC_VARIANTS[words[i]];
    if (!alts) continue;
    for (const v of alts) {
      const copy = [...words];
      copy[i] = v;
      variants.add(copy.join(" "));
    }
  }
  return [...variants].sort();
}

export function findVoskModelDir(): string | null {
  for (const p of VOSK_MODEL_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function voskAvailable(): boolean {
  return findVoskModelDir() !== null;
}

export function wakeWordStatus(): { available: boolean; modelDir: string | null; phrase: string; variants: string[] } {
  const dir = findVoskModelDir();
  const phrase = (process.env.NEUROWORKS_WAKE_PHRASE ?? "hey naxie").trim() || "hey naxie";
  return {
    available: dir !== null,
    modelDir: dir,
    phrase,
    variants: buildGrammar(phrase),
  };
}

// Optional Vosk-backed session — only constructed when the `vosk` npm package
// is installed AND a model dir exists. Follows the same accept() semantics as
// Python's WakeWordSession: feed PCM16 LE @ 16kHz, return true on exact
// grammar hit (partial or final), then Reset() for the next utterance.
export type WakeWordSession = { accept: (pcm: Buffer) => boolean; close: () => void };

let cachedModel: any = null;
let cachedModelDir: string | null = null;

function getVoskModel(): any | null {
  const dir = findVoskModelDir();
  if (!dir) return null;
  if (cachedModel && cachedModelDir === dir) return cachedModel;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vosk = require("vosk");
    if (typeof vosk.SetLogLevel === "function") vosk.SetLogLevel(-1);
    cachedModel = new vosk.Model(dir);
    cachedModelDir = dir;
    return cachedModel;
  } catch {
    return null;
  }
}

export function createWakeWordSession(phrase?: string, sampleRate = 16000): WakeWordSession | null {
  const model = getVoskModel();
  if (!model) return null;
  const targets = new Set(buildGrammar(phrase ?? (process.env.NEUROWORKS_WAKE_PHRASE ?? "hey naxie")));
  const grammar = JSON.stringify([...targets].sort().concat(["[unk]"]));
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vosk = require("vosk");
    const rec = new vosk.Recognizer(model, sampleRate, grammar);
    return {
      accept(pcm: Buffer): boolean {
        if (!pcm || pcm.length === 0) return false;
        const isFinal = rec.acceptWaveform(pcm);
        let text = "";
        try {
          if (isFinal) {
            const r = JSON.parse(rec.result());
            text = String(r.text ?? "").toLowerCase().trim();
          } else {
            const r = JSON.parse(rec.partialResult());
            text = String(r.partial ?? "").toLowerCase().trim();
          }
        } catch {
          return false;
        }
        if (text && targets.has(text)) {
          try { rec.reset(); } catch { /* ignore */ }
          return true;
        }
        return false;
      },
      close() {
        try { rec.free?.(); } catch { /* ignore */ }
      },
    };
  } catch {
    return null;
  }
}

// Browser-side regex fallback (mirrors useNaxieAssistant.ts:60 WAKE_PHRASE_RE)
// Exported for server-side pre-filter before hitting Vosk (cheap check).
const WAKE_PHRASE_RE = /\bhey,?\s+naxie\b/i;

export function isWakePhrase(text: string): boolean {
  return WAKE_PHRASE_RE.test(String(text ?? ""));
}
