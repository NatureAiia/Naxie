// Persisted translation history — per-user JSONL log of fast-path
// translations (translate.ts). Chat history already records the exchange,
// but a dedicated log makes "show my recent translations" answerable
// without scanning chat. Capped per user; best-effort (never throws).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = resolve(__dirname, "../../../.naxion/translation-history");

const MAX_ENTRIES_PER_USER = 100;

export type TranslationRecord = {
  at: string;
  text: string;
  translated: string;
  from: string;
  to: string;
  model: string;
};

function fileFor(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return resolve(HISTORY_DIR, `${safe}.jsonl`);
}

export function appendTranslation(userId: string, r: Omit<TranslationRecord, "at">): void {
  try {
    if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
    appendFileSync(fileFor(userId), JSON.stringify({ ...r, at: new Date().toISOString() }) + "\n", "utf8");
    // Cap: rewrite when over — cheap at this volume.
    const lines = readFileSync(fileFor(userId), "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_ENTRIES_PER_USER) {
      writeFileSync(fileFor(userId), lines.slice(-MAX_ENTRIES_PER_USER).join("\n") + "\n", "utf8");
    }
  } catch { /* history must never break translation */ }
}

export function listTranslations(userId: string, limit = 20): TranslationRecord[] {
  try {
    const p = fileFor(userId);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, MAX_ENTRIES_PER_USER)))
      .map(l => JSON.parse(l) as TranslationRecord)
      .reverse();
  } catch { return []; }
}
