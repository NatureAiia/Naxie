// ASR transcript repair — ported by BEHAVIOR from ZimVoice's
// semantic_engine.py `repair_speech`/`repair_hallucinations` (data from
// vocabulary.json). Naxie's own shona-glossary.ts already ported ZimVoice's
// vocabulary for a DIFFERENT job (detecting Shona/Ndebele input so the LLM
// responds in kind) — this module is the piece that was still missing:
// fixing whole-word/phrase mis-transcriptions in the raw STT output BEFORE
// anything downstream (intent classification, the LLM) ever sees it.
//
// Exact, case-insensitive, whole-word/phrase replacement — not fuzzy
// matching — same as the original: a speech-to-text engine mis-hears a
// specific phrase as another specific (usually unrelated-looking) phrase
// often enough that a static correction table beats guessing.

export type RepairResult = { text: string; corrections: { from: string; to: string }[] };

// Common Whisper/ASR mis-hearings of Zimbabwean Shona terms as similar-
// sounding English phrases (code-switching correction), ported verbatim
// from ZimVoice's repair_hallucinations table.
const DEFAULT_CORRECTIONS: Record<string, string> = {
  "show na": "shona",
  "tie tender": "tatenda",
  "see ya bonga": "siyabonga",
  "my gets it": "magetsi",
  "get see": "magetsi",
  "to meet our": "tumira",
  "to meet a": "tumira",
  "there is a": "zesa",
  "send a": "senda",
  "then get": "tenga",
  "door that": "ndoda",
  "eating airtime": "buy airtime",
};

let corrections: Record<string, string> = { ...DEFAULT_CORRECTIONS };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace the built-in correction table (e.g. with an operator-edited set
 *  loaded from the vault). Pass `{}` to disable corrections entirely. */
export function setAsrCorrections(map: Record<string, string>): void {
  corrections = { ...map };
}

export function resetAsrCorrections(): void {
  corrections = { ...DEFAULT_CORRECTIONS };
}

/**
 * Apply every registered correction to `text`, longest phrase first (so a
 * multi-word entry isn't pre-empted by a shorter one sharing a prefix).
 * Word-boundary + case-insensitive, matching ZimVoice's `\b...\b` regex
 * approach exactly. Returns the repaired text plus a log of what fired, so
 * callers (and tests) can see which corrections actually applied.
 */
export function repairTranscript(text: string): RepairResult {
  if (!text) return { text, corrections: [] };
  let repaired = text;
  const applied: { from: string; to: string }[] = [];
  const entries = Object.entries(corrections).sort((a, b) => b[0].length - a[0].length);
  for (const [wrong, right] of entries) {
    const re = new RegExp(`\\b${escapeRe(wrong)}\\b`, "gi");
    if (re.test(repaired)) {
      repaired = repaired.replace(re, right);
      applied.push({ from: wrong, to: right });
    }
  }
  return { text: repaired, corrections: applied };
}
