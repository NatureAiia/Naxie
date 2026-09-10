// Naxie context orchestrator — RAG + MAG + CAG composed into one injection
// Every Naxie turn (and every subagent delegated from Naxie) calls this.

import { buildCagPrefix } from "./cag.js";
import { ragSearch, formatRagBlock } from "./rag.js";
import { buildMagContext, ensureMagIdentityFiles } from "./mag.js";
import { readRecentMissionNotes, mostRecentScopeId, dailyScopeId } from "./mission-log.js";
import { crmContextSummary } from "./crm.js";

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
  missionLog: string;    // rolling working-notes for the active (or most recent) task
  crm: string;           // compact contacts/pipeline snapshot — "" when the CRM is empty
  combinedSystemAddendum: string; // what to append to the base system prompt
  // The vault path of the top-scored vault-sourced RAG hit, if any — the note
  // that most likely answered this query, for the client to highlight in
  // KnowledgeGraph (same "answer highlights its source" pattern as
  // jarvis-claude-code's top_match()/setFocus(), except riding on the RAG
  // scoring Naxie already does rather than a separate keyword pass).
  sourceNoteId: string | null;
};

export async function buildNaxieContext(query: string, opts: { ragLimit?: number; includeDated?: boolean; scopeId?: string } = {}): Promise<NaxieContext> {
  ensureOnce();
  const cag = buildCagPrefix();
  // MAG as standalone (fresh) — CAG already contains a mag snapshot but we add a
  // slightly fresher mag slice for recency; dedupe is fine, LLM handles it.
  const mag = buildMagContext({ maxFacts: 8, includeDated: opts.includeDated });

  const hits = await ragSearch(query, opts.ragLimit ?? 6);
  const rag = formatRagBlock(hits);
  // hits is already sorted score-desc (rag.ts) — first vault/vault-semantic
  // hit is the note the answer most likely drew from.
  const sourceNoteId = hits.find(h => h.source === "vault" || h.source === "vault-semantic")?.path ?? null;

  // Mission-log tail — the agent's own working notes for the active task
  // (or, when no explicit scope is passed, whichever scope was most recently
  // written to, falling back to today's bucket). See mission-log.ts: this is
  // ephemeral per-task narrative, distinct from MAG's permanent facts.
  let missionLog = "";
  try {
    const scope = opts.scopeId ?? mostRecentScopeId() ?? dailyScopeId();
    const notes = readRecentMissionNotes(scope);
    if (notes) missionLog = `[Recent working notes for this task]\n${notes}`;
  } catch { /* mission-log is best-effort — never break context on a read hiccup */ }

  // CRM snapshot (lib/crm.ts) — ambient contacts/pipeline awareness so "how's
  // the pipeline looking" doesn't need a dedicated tool call for the common
  // case. Best-effort like mission-log: never break context on a read hiccup.
  let crm = "";
  try {
    const summary = crmContextSummary();
    if (summary) crm = `[CRM snapshot]\n${summary}`;
  } catch { /* best-effort */ }

  const parts = [cag.prefix, rag, missionLog, crm].filter(Boolean).join("\n\n");
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
    missionLog,
    crm,
    combinedSystemAddendum,
    sourceNoteId,
  };
}

// For subagents: same memory, but preface with "You are <persona> — Naxie's delegate"
export function buildSubagentContext(personaId: string, query: string): Promise<NaxieContext> {
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
