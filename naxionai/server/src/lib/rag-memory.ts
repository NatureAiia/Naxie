// Per-session conversation memory for RAG follow-ups
// (RIFTS-X ConversationMemory port). Resolves "that file", "the second
// one", "and its budget?" by remembering the last retrieval per session.
// In-memory only — a restart drops follow-up context, never vault content.

import type { RagHit } from "./rag.js";

export type RagMemoryEntry = {
  query: string;
  hits: RagHit[];
  entityFocus?: { type: string; path: string };
  at: number;
};

const SESSIONS = new Map<string, RagMemoryEntry[]>();
const MAX_PER_SESSION = 5;
const FOLLOW_UP_RE = /^(that|this|those|these|it|the (first|second|third|last|one|other)|and |also |what about|how about|more (about|on)|tell me more)\b/i;

function key(sessionId?: string): string {
  const s = (sessionId ?? "default").trim().slice(0, 80) || "default";
  return s;
}

export function rememberRagQuery(sessionId: string | undefined, query: string, hits: RagHit[]): void {
  try {
    const k = key(sessionId);
    const list = SESSIONS.get(k) ?? [];
    const top = hits[0];
    list.push({
      query: query.slice(0, 300),
      hits: hits.slice(0, 8),
      entityFocus: top ? { type: top.source, path: top.path } : undefined,
      at: Date.now(),
    });
    while (list.length > MAX_PER_SESSION) list.shift();
    SESSIONS.set(k, list);
    if (SESSIONS.size > 500) {
      const oldest = SESSIONS.keys().next().value as string;
      SESSIONS.delete(oldest);
    }
  } catch { /* never break retrieval */ }
}

export function isFollowUp(query: string): boolean {
  return FOLLOW_UP_RE.test(query.trim());
}

// Expand "that file" into "<last query> <last top path>" so the normal
// hybrid search has something lexical to bite on. Returns null when there
// is no usable context.
export function expandFollowUpQuery(sessionId: string | undefined, query: string): string | null {
  if (!isFollowUp(query)) return null;
  const list = SESSIONS.get(key(sessionId));
  if (!list || list.length === 0) return null;
  const last = list[list.length - 1];
  if (!last?.query) return null;
  // Ordinal references ("the second one") resolve to a remembered path.
  const ord = query.toLowerCase().match(/\b(second|third|last)\b/);
  if (ord && last.hits.length > 1) {
    const idx = ord[1] === "second" ? 1 : ord[1] === "third" ? 2 : last.hits.length - 1;
    const h = last.hits[idx];
    if (h) return `${last.query} ${h.path}`;
  }
  const focus = last.entityFocus?.path ?? "";
  return `${last.query} ${focus} ${query}`.trim().slice(0, 500);
}

export function lastEntityFocus(sessionId: string | undefined): { type: string; path: string } | undefined {
  const list = SESSIONS.get(key(sessionId));
  return list?.length ? list[list.length - 1].entityFocus : undefined;
}

export function _clearRagMemoryForTests(): void {
  SESSIONS.clear();
}
