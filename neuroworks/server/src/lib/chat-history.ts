// Per-user chat history — the server-side record of what each signed-in human
// asked in chat and what the workforce answered. Two jobs:
//
//   1. Isolation: history is stored and served STRICTLY per user id. The chat
//      UI's local cache is also namespaced per user, but this store is the
//      authoritative copy — one user can never be handed another user's turns.
//   2. My Work: the "My prompts & results" section lists the caller's own
//      prompts with the output each one produced.
//
// Token-less machine callers (peers, workers, schedulers) are NOT recorded —
// this is a human activity ledger, not a job journal (that's lib/jobs.ts).
//
// Persisted under .neuroworks/chat-history/<userId>.json, capped per user.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = resolve(__dirname, "../../../.neuroworks/chat-history");

const MAX_ENTRIES_PER_USER = 300;
const MAX_TEXT_CHARS = 20_000;

export type ChatExchange = {
  id: string;
  at: string;              // ISO timestamp of the exchange
  prompt: string;          // what the user typed
  response: string;        // the assistant's reply / task synthesis
  kind?: string;           // "message" | "task" | "error" | ...
  jobId?: string;          // set when the prompt became a background job
  persona?: string;        // active persona name, when one answered
  sessionId?: string;      // UI chat session, for grouping
};

function fileFor(userId: string): string {
  // User ids are uuids from lib/users.ts; sanitize anyway so a hostile id
  // can never traverse out of the history dir.
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return resolve(HISTORY_DIR, `${safe}.json`);
}

function load(userId: string): ChatExchange[] {
  try {
    const p = fileFor(userId);
    if (!existsSync(p)) return [];
    const arr = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function save(userId: string, entries: ChatExchange[]): void {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  writeFileSync(fileFor(userId), JSON.stringify(entries.slice(-MAX_ENTRIES_PER_USER), null, 2), "utf8");
}

export function recordChatExchange(userId: string, input: {
  prompt: string;
  response: string;
  kind?: string;
  jobId?: string;
  persona?: string;
  sessionId?: string;
}): ChatExchange {
  const entry: ChatExchange = {
    id: randomUUID(),
    at: new Date().toISOString(),
    prompt: String(input.prompt ?? "").slice(0, MAX_TEXT_CHARS),
    response: String(input.response ?? "").slice(0, MAX_TEXT_CHARS),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.persona ? { persona: input.persona } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
  const entries = load(userId);
  entries.push(entry);
  save(userId, entries);
  return entry;
}

// A job that started as "queued…" finishes later; tasks.ts calls this to fill
// in the real deliverable so My Work shows the output, not the acknowledgement.
export function updateChatExchangeByJob(userId: string, jobId: string, response: string): boolean {
  const entries = load(userId);
  const hit = [...entries].reverse().find(e => e.jobId === jobId);
  if (!hit) return false;
  hit.response = String(response ?? "").slice(0, MAX_TEXT_CHARS);
  save(userId, entries);
  return true;
}

export function listChatHistory(userId: string, limit = 50): ChatExchange[] {
  return load(userId).slice(-Math.max(1, Math.min(limit, MAX_ENTRIES_PER_USER))).reverse();
}

const SUMMARY_EVERY = 10;
const SUMMARY_FILE = "summary.json";
function summaryPath(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return resolve(HISTORY_DIR, `${safe}.${SUMMARY_FILE}`);
}
export function getConversationSummary(userId: string): string | null {
  try {
    const p = summaryPath(userId);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return typeof j.summary === "string" ? j.summary.slice(0, 600) : null;
  } catch { return null; }
}
export async function maybeUpdateConversationSummary(userId: string): Promise<void> {
  const entries = load(userId);
  if (entries.length === 0 || entries.length % SUMMARY_EVERY !== 0) return;
  try {
    const { summarizeConversation } = await import("./ai/conversationSummary.js");
    const u = entries.slice(-20).map(e => ({ role: "user" as const, content: e.prompt }));
    const a = entries.slice(-20).map(e => ({ role: "assistant" as const, content: e.response }));
    const s = await summarizeConversation([...u, ...a]);
    if (!s) return;
    if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
    writeFileSync(summaryPath(userId), JSON.stringify({ summary: s, at: new Date().toISOString() }, null, 2), "utf8");
  } catch { /* best-effort */ }
}
