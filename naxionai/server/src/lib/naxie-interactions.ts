// Last-interaction persistence for Naxie's proactive cadence.
// Single-user product — one JSON file under .naxion/, same convention as
// org-tasks.ts / schedules.ts (atomic temp+rename, no DB).
// Updated fire-and-forget from voice.ts:/converse, naxie.ts:/ask, chat.ts.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, "../../../.naxion");
const PATH = resolve(DIR, "naxie-interactions.json");

export type NaxieInteractions = {
  lastInteractionAt: string; // ISO
  lastNudgeAt?: string;      // ISO - throttles one check-in per idle window
  lastResearchAt?: string;   // ISO - throttle for proactive research
  lastZettelScanAt?: string; // ISO - cursor + throttle for auto-zettel extraction
  lastArchitectReviewAt?: string; // ISO - weekly architect throttle, survives restarts
};

let cache: NaxieInteractions | null = null;

function load(): NaxieInteractions | null {
  if (cache) return cache;
  if (!existsSync(PATH)) return null;
  try {
    const j = JSON.parse(readFileSync(PATH, "utf8"));
    if (j?.lastInteractionAt) {
      cache = j as NaxieInteractions;
      return cache;
    }
  } catch { /* ignore */ }
  return null;
}

function persist(state: NaxieInteractions): void {
  cache = state;
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const tmp = `${PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, PATH);
}

export function getInteractions(): NaxieInteractions | null {
  return load();
}

export function getLastInteractionAt(): string | null {
  return load()?.lastInteractionAt ?? null;
}

/** Fire-and-forget touch — never throws, never blocks the caller. */
export function touchInteraction(): void {
  try {
    const now = new Date().toISOString();
    const prev = load();
    const next: NaxieInteractions = {
      lastInteractionAt: now,
      lastNudgeAt: prev?.lastNudgeAt,
      lastResearchAt: prev?.lastResearchAt,
      lastZettelScanAt: prev?.lastZettelScanAt,
      lastArchitectReviewAt: prev?.lastArchitectReviewAt,
    };
    persist(next);
  } catch { /* best-effort */ }
}

export function setLastNudgeAt(iso: string): void {
  const prev = load();
  const now = prev?.lastInteractionAt ?? new Date().toISOString();
  persist({ lastInteractionAt: now, lastNudgeAt: iso, lastResearchAt: prev?.lastResearchAt, lastZettelScanAt: prev?.lastZettelScanAt, lastArchitectReviewAt: prev?.lastArchitectReviewAt });
}

export function setLastResearchAt(iso: string): void {
  const prev = load();
  const now = prev?.lastInteractionAt ?? new Date().toISOString();
  persist({ lastInteractionAt: now, lastNudgeAt: prev?.lastNudgeAt, lastResearchAt: iso, lastZettelScanAt: prev?.lastZettelScanAt, lastArchitectReviewAt: prev?.lastArchitectReviewAt });
}

export function setLastZettelScanAt(iso: string): void {
  const prev = load();
  const now = prev?.lastInteractionAt ?? new Date().toISOString();
  persist({ lastInteractionAt: now, lastNudgeAt: prev?.lastNudgeAt, lastResearchAt: prev?.lastResearchAt, lastZettelScanAt: iso, lastArchitectReviewAt: prev?.lastArchitectReviewAt });
}

export function setLastArchitectReviewAt(iso: string): void {
  const prev = load();
  const now = prev?.lastInteractionAt ?? new Date().toISOString();
  persist({ lastInteractionAt: now, lastNudgeAt: prev?.lastNudgeAt, lastResearchAt: prev?.lastResearchAt, lastZettelScanAt: prev?.lastZettelScanAt, lastArchitectReviewAt: iso });
}

// For tests / daemon's `now` injection — direct read without cache side-effects.
export function _resetCache(): void { cache = null; }
