// Naxie context orchestrator — RAG + MAG + CAG composed into one injection
// Every Naxie turn (and every subagent delegated from Naxie) calls this.

import { buildCagPrefix } from "./cag.js";
import { ragSearch, formatRagBlock } from "./rag.js";
import { buildMagContext, ensureMagIdentityFiles } from "./mag.js";

let ensured = false;
function ensureOnce() {
  if (ensured) return;
  try { ensureMagIdentityFiles(); ensured = true; } catch { /* best-effort */ }
}

export type NaxieContext = {
  cag: string;           // stable cached prefix (CAG)
  cagHash: string;
  cagCached: boolean;
  mag: string;           // durable memory block (MAG) — subset of CAG plus fresh facts
  rag: string;           // per-query retrieval block (RAG)
  combinedSystemAddendum: string; // what to append to the base system prompt
};

export function buildNaxieContext(query: string, opts: { ragLimit?: number; includeDated?: boolean } = {}): NaxieContext {
  ensureOnce();
  const cag = buildCagPrefix();
  // MAG as standalone (fresh) — CAG already contains a mag snapshot but we add a
  // slightly fresher mag slice for recency; dedupe is fine, LLM handles it.
  const mag = buildMagContext({ maxFacts: 8, includeDated: opts.includeDated });

  const hits = ragSearch(query, opts.ragLimit ?? 6);
  const rag = formatRagBlock(hits);

  const parts = [cag.prefix, rag].filter(Boolean).join("\n\n");
  // Avoid duplicating mag verbatim if cag already contains it — but keep a
  // short fresh-facts tail if mag has anything cag didn't (new memory since last cag build)
  const magTail = mag.includes("Recent memory") ? "" : mag;

  const combinedSystemAddendum = [parts, magTail].filter(Boolean).join("\n\n");

  return {
    cag: cag.prefix,
    cagHash: cag.hash,
    cagCached: cag.cached,
    mag,
    rag,
    combinedSystemAddendum,
  };
}

// For subagents: same memory, but preface with "You are <persona> — Naxie's delegate"
export function buildSubagentContext(personaId: string, query: string): NaxieContext {
  // Reuse same RAG/MAG/CAG — subagents share the same durable memory so they
  // also never forget who Nature is. Persona-specific profile is layered by
  // personaSystemSuffix() elsewhere; this just adds the shared memory.
  return buildNaxieContext(query, { ragLimit: 6 });
}

// Lightweight probe for /api/status
export function naxieMemoryStats(): { cagHash: string; cagCached: boolean; hasRag: boolean } {
  const cag = buildCagPrefix();
  return { cagHash: cag.hash, cagCached: cag.cached, hasRag: true };
}
