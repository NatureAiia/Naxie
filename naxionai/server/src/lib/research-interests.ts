// Research interests — ordered topic resolver for proactive research.
// Sources per docs/naxie-wakeword-proactive-spike.md §2.3:
// 1) vault/_naxion/interests.md (explicit), 2) sector contextNote (always additive),
// 3) MAG recent subjects (fallback), 4) vault RAG recent edits (optional, low weight).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { getSectorById, getSectorContext } from "./sector-packs.js";
import { getOnboardingState } from "./sector-packs.js";
import { listSubjects } from "./memory.js";

export const INTERESTS_REL = "_naxion/interests.md";
const MAX_TOPICS = 6;

function interestsPath(): string {
  return join(config.vaultPath, INTERESTS_REL);
}

export function readInterests(): string[] {
  try {
    const raw = readFileSync(interestsPath(), "utf8");
    // Split on newlines and on sentence boundaries — tolerate freeform prose.
    const lines = raw
      .split(/\r?\n/)
      .map(l => l.trim().replace(/^[-*]\s+/, "").trim())
      .filter(Boolean)
      .flatMap(l => l.split(/;\s*/).map(s => s.trim()).filter(Boolean));
    // Also split very long lines on ". " into separate topics (freeform paragraph)
    const expanded: string[] = [];
    for (const l of lines) {
      if (l.length > 120 && l.includes(". ")) {
        for (const part of l.split(/\.\s+/)) {
          const t = part.trim().replace(/\.$/, "");
          if (t.length >= 3) expanded.push(t);
        }
      } else expanded.push(l);
    }
    return expanded.filter(t => t.length >= 3).slice(0, 12);
  } catch {
    return [];
  }
}

export function writeInterests(topics: string[]): void {
  const p = interestsPath();
  try { mkdirSync(join(config.vaultPath, "_naxion"), { recursive: true }); } catch { /* ignore */ }
  const body = topics.map(t => `- ${t.trim()}`).join("\n") + "\n";
  writeFileSync(p, body, "utf8");
}

export function appendInterest(topic: string): void {
  const cur = readInterests();
  const t = topic.trim();
  if (!t || cur.some(c => c.toLowerCase() === t.toLowerCase())) return;
  writeInterests([...cur, t]);
}

// Ordered resolver — first non-empty among (1) explicit interests, then (2)/(3) as additive fallbacks.
// Returns up to MAX_TOPICS topic strings, deduped case-insensitive.
export function resolveResearchTopics(opts?: { explicitInterests?: string[] }): string[] {
  const explicit = opts?.explicitInterests ?? readInterests();
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (t: string) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  // 1) Explicit interests — highest signal, return immediately if any.
  for (const t of explicit) {
    if (out.length >= MAX_TOPICS) break;
    push(t);
  }
  if (out.length > 0) {
    // Still append sector context as additive signal when present (one extra, not capped strictly).
    try {
      const state = getOnboardingState();
      if (state.sector) {
        const sector = getSectorById(state.sector);
        if (sector?.contextNote && out.length < MAX_TOPICS) {
          // Compact sector context to one line — not a raw paragraph dump.
          const compact = `Sector context (${sector.name}): ${sector.contextNote.slice(0, 200)}`;
          push(compact);
        }
      }
    } catch { /* ignore */ }
    return out.slice(0, MAX_TOPICS);
  }

  // 2) Sector context as topic seed when no explicit interests.
  try {
    const state = getOnboardingState();
    if (state.sector) {
      const ctx = getSectorContext(state.sector);
      if (ctx) push(ctx.slice(0, 300));
    }
  } catch { /* ignore */ }

  // 3) MAG recent subjects — top 3 by recency.
  try {
    const subjects = listSubjects().slice(0, 3);
    for (const s of subjects) {
      if (out.length >= MAX_TOPICS) break;
      // Skip generic subjects that carry no research signal.
      if (["general", "operator", "naxie"].includes(s.subject.toLowerCase())) continue;
      push(s.subject);
    }
  } catch { /* ignore */ }

  // 4) Vault RAG recent-edit signal is intentionally not auto-inferred here —
  // it needs an mtime scan that's expensive at daemon-tick frequency. The daemon
  // can opt to append it as an explicit caller-supplied hint instead.

  return out.slice(0, MAX_TOPICS);
}
