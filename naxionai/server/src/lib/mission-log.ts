// Rolling mission log — a self-authored working narrative of what the agent
// tried during a task, read back into its own context so a long multi-step
// session doesn't lose continuity to the chat route's minimal sliding window
// (routes/chat.ts keeps only the last 2 user turns + last assistant turn).
//
// Deliberately distinct from two other stores that might look similar:
//  - context-offload.ts archives large VERBATIM tool-output strings so later
//    steps can still reference them; this logs short, agent-authored
//    sentences about what happened ("tried X, failed because Y").
//  - memory.ts (MAG) stores permanent, curated facts about subjects across
//    all time; this is ephemeral, per-task working memory that gets noisy
//    and is expected to be superseded once the task ends.
//
// File layout: `_naxion/mission-log/<scopeId>.jsonl`, one JSON line per
// entry. scopeId is the Job id for a multi-step plan, or a YYYY-MM-DD daily
// bucket for ordinary chat turns that never spawn a Job — reusing the
// existing Job concept instead of inventing a new session-identity system.

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const MISSION_LOG_DIR_REL = "_naxion/mission-log";
const MAX_ENTRIES = 200;
const MAX_BYTES = 50_000;

export type MissionNoteKind = "decision" | "blocker" | "progress" | "todo" | "note";

export type MissionNote = {
  ts: string;
  kind: MissionNoteKind;
  text: string;
  stepId?: string;
};

function root(): string { return join(config.vaultPath, MISSION_LOG_DIR_REL); }

function safeScopeId(scopeId: string): string {
  return scopeId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "general";
}

function fileFor(scopeId: string): string {
  return join(root(), safeScopeId(scopeId) + ".jsonl");
}

/** Daily fallback scope for chat turns with no active Job. */
export function dailyScopeId(): string {
  return new Date().toISOString().slice(0, 10);
}

function readEntries(file: string): MissionNote[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) as MissionNote; } catch { return null; } })
      .filter((e): e is MissionNote => e !== null);
  } catch {
    return [];
  }
}

/** Append one note, then enforce retention (oldest-first truncation) — this
 * is working memory, not an audit trail (audit-log.ts already covers that),
 * so unbounded growth isn't the goal. */
export function appendMissionNote(scopeId: string, entry: { kind: MissionNoteKind; text: string; stepId?: string }): void {
  const dir = root();
  try { mkdirSync(dir, { recursive: true }); } catch { /* tolerate */ }
  const file = fileFor(scopeId);
  const rec: MissionNote = {
    ts: new Date().toISOString(),
    kind: entry.kind,
    text: entry.text.trim().slice(0, 2000),
    stepId: entry.stepId,
  };
  try {
    appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    let size = 0;
    try { size = statSync(file).size; } catch { /* tolerate */ }
    const all = readEntries(file);
    if (size > MAX_BYTES || all.length > MAX_ENTRIES) {
      const trimmed = all.slice(-MAX_ENTRIES);
      writeFileSync(file, trimmed.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8");
    }
  } catch { /* best-effort — never block the agent loop on a logging failure */ }
}

/** Formatted, chronological block of recent mission-log entries for a scope,
 * suitable for folding into a system prompt addendum. Empty string if
 * nothing's logged yet for this scope. */
export function readRecentMissionNotes(scopeId: string, opts?: { maxEntries?: number; maxChars?: number }): string {
  const file = fileFor(scopeId);
  const entries = readEntries(file);
  if (entries.length === 0) return "";
  const maxEntries = opts?.maxEntries ?? 40;
  const maxChars = opts?.maxChars ?? 3000;
  const recent = entries.slice(-maxEntries);
  const lines = recent.map(e => `- [${e.kind}] ${e.text}`);
  let block = lines.join("\n");
  if (block.length > maxChars) block = block.slice(block.length - maxChars);
  return block;
}

/** Most recently touched scope's log file, for context-building when no Job
 * is explicitly in flight (falls back to whatever was last written, so a
 * plain chat turn still sees the freshest working notes). */
export function mostRecentScopeId(): string | null {
  const dir = root();
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    let best: { name: string; mtime: number } | null = null;
    for (const name of files) {
      const mtime = statSync(join(dir, name)).mtimeMs;
      if (!best || mtime > best.mtime) best = { name, mtime };
    }
    return best ? best.name.replace(/\.jsonl$/, "") : null;
  } catch {
    return null;
  }
}
