// RAG — Retrieval-Augmented Generation
// Retrieval paths layered alongside MiniSearch + vault-index walk:
// keyword/MiniSearch + memory search + fallback walk, PLUS (when configured)
// Supabase pgvector semantic search over vault_chunks (see lib/rag-embed.ts
// for how that table gets populated, and lib/pg-client.ts / lib/embeddings.ts
// for the Postgres + embeddings clients it depends on). The pgvector step is
// entirely optional — SUPABASE_DB_URL / OPENAI_EMBEDDING_API_KEY unset simply
// means ragSearch behaves exactly as before.

import { searchVault } from "./vault.js";
import { searchIndex } from "./vault-index.js";
import { searchMemory } from "./memory.js";
import { config } from "../config.js";
import { getPgPool, isPgAvailable } from "./pg-client.js";
import { embedText } from "./embeddings.js";
import { graphNeighbors } from "./vault-graph.js";
import { recordRagQuery } from "./rag-telemetry.js";
import { isOffline } from "./offline-mode.js";

export type RagHit = {
  source: "vault" | "memory" | "persona" | "vault-semantic";
  path: string;        // vault path or memory subject
  line?: number;
  preview: string;
  score: number;
  // Graph-augmented retrieval (docs/naxie-storage-architecture.md §6) — 1-hop
  // wikilink neighbors of a vault-sourced hit's note, best-effort. Only set
  // for "vault"/"vault-semantic" hits (memory/persona hits have no place in
  // the wikilink graph) and only when at least one neighbor was found.
  relatedNotes?: string[];
};

// Vault-sourced hits (as opposed to memory/persona) are the only ones with a
// path that resolves inside the wikilink graph — everything else has a path
// like "memory/<subject>", not a real vault file.
const VAULT_SOURCES = new Set<RagHit["source"]>(["vault", "vault-semantic"]);

// Attach 1-hop wikilink "related notes" to every vault-sourced hit, best-
// effort (graphNeighbors() itself never throws, but this stays defensive
// since it runs over every hit on every call).
function withRelatedNotes(hits: RagHit[]): RagHit[] {
  for (const h of hits) {
    if (!VAULT_SOURCES.has(h.source)) continue;
    try {
      const neighbors = graphNeighbors(h.path, 1);
      if (neighbors.length > 0) h.relatedNotes = neighbors.slice(0, 5);
    } catch { /* best-effort annotation only */ }
  }
  return hits;
}

// Semantic (pgvector) search over vault_chunks. Embeds the query, then
// nearest-neighbour searches by cosine distance. Returns [] on ANY failure
// (Postgres unreachable, embeddings unavailable, table missing, etc.) — this
// is an additive retrieval path, never a hard dependency for chat.
async function pgvectorSearch(query: string, limit: number): Promise<RagHit[]> {
  if (!config.pgvectorEnabled || !config.openaiEmbeddingEnabled) return [];
  try {
    const available = await isPgAvailable();
    if (!available) return [];
    const pool = getPgPool();
    if (!pool) return [];
    const [vec] = await embedText([query]);
    if (!vec) return [];
    const vecLiteral = `[${vec.join(",")}]`;
    const { rows } = await pool.query(
      `select path, heading, title, content, embedding <=> $1::vector as distance
       from vault_chunks
       order by embedding <=> $1::vector
       limit $2`,
      [vecLiteral, limit],
    );
    return rows.map((r: any): RagHit => ({
      source: "vault-semantic",
      path: r.path,
      preview: String(r.content).slice(0, 200),
      // Cosine distance 0..2 → score 7..0 so fresh semantic beats stale BM25 when pgvector is live (Kuwana tuning).
      // Memory stays pinned at 5; semantic fresh hit (distance ~0.1) scores ~6.3 → ranks above BM25.
      score: Math.max(0, 7 - Number(r.distance) * 7),
    }));
  } catch (e: any) {
    console.debug(`[rag] pgvectorSearch skipped: ${e?.message ?? e}`);
    return [];
  }
}

// Per-query short TTL cache — same Naxie turn often re-queries similar text
// within seconds (retry, follow-up), and buildNaxieContext + planner both call
// ragSearch for the same query. 10s window avoids repeated vault walks.
const RAG_CACHE_TTL_MS = 10_000;
const ragCache = new Map<string, { at: number; hits: RagHit[] }>();

function ragCacheKey(query: string, limit: number): string {
  return `${query.trim().toLowerCase()}::${limit}`;
}

// Hybrid search: vault-index (MiniSearch) first, then memory, then fallback
// walk, then (when configured) pgvector semantic search. Async because the
// pgvector step is a network call (embed the query, then a Postgres round
// trip) — all callers already run inside async request handlers.
export async function ragSearch(query: string, limit = 8): Promise<RagHit[]> {
  const q = query.trim();
  if (!q) return [];
  const ck = ragCacheKey(q, limit);
  const cached = ragCache.get(ck);
  if (cached && Date.now() - cached.at < RAG_CACHE_TTL_MS) return cached.hits;
  const t0 = Date.now();
  const hits: RagHit[] = [];
  const seen = new Set<string>();
  let scanCount = 0;

  // 1) MiniSearch index (fast, ranked)
  try {
    const indexed = searchIndex(q, config.vaultPath, limit);
    if (indexed) {
      for (const h of indexed) {
        const key = `vault:${h.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ source: "vault", path: h.path, line: h.line, preview: h.preview, score: h.score });
      }
    }
  } catch { /* ignore */ }

  // 2) Memory search (operator/naxie/subagent facts)
  try {
    const mem = searchMemory(q, Math.max(3, Math.ceil(limit / 2)));
    for (const m of mem) {
      const key = `memory:${m.subject}:${m.fact.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ source: "memory", path: `memory/${m.subject}`, preview: m.fact.slice(0, 200), score: 5 });
    }
  } catch { /* ignore */ }

  // 3) Fallback linear vault walk if we still have few hits (MiniSearch AND combiner can be strict)
  if (hits.length < Math.min(3, limit)) {
    try {
      const fallback = searchVault(q, limit);
      for (const h of fallback) {
        const key = `vault:${h.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ source: "vault", path: h.path, line: h.line, preview: h.preview, score: 1 });
        scanCount++;
        if (hits.length >= limit) break;
      }
    } catch { /* ignore */ }
  }

  // 4) pgvector semantic search — runs ALONGSIDE the steps above (never
  // replaces them), only when Supabase + embeddings are both configured.
  // Skips silently (debug log only) on any Postgres/embedding unavailability.
  try {
    const semantic = await pgvectorSearch(q, limit);
    for (const h of semantic) {
      const key = `vault-semantic:${h.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
    }
  } catch { /* ignore — pgvectorSearch already catches internally */ }

  // Sort vault hits by score desc, memory after
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, limit);
  const noted = withRelatedNotes(top);
  // Retrieval telemetry for the weekly self-improvement review — counts are
  // over the full candidate set (pre-limit), so "the semantic path found
  // nothing" is distinguishable from "it found things that ranked lower".
  recordRagQuery({
    query: q,
    hitCount: noted.length,
    sources: {
      index: hits.filter(h => h.source === "vault").length - scanCount,
      memory: hits.filter(h => h.source === "memory").length,
      vaultScan: scanCount,
      vector: hits.filter(h => h.source === "vault-semantic").length,
    },
    topScore: noted[0]?.score ?? 0,
    ms: Date.now() - t0,
    vectorEnabled: config.pgvectorEnabled && config.openaiEmbeddingEnabled && !isOffline(),
  });
  ragCache.set(ck, { at: Date.now(), hits: noted });
  // Bound cache size (avoid unbounded growth on long uptime)
  if (ragCache.size > 200) {
    const oldestKey = ragCache.keys().next().value as string;
    ragCache.delete(oldestKey);
  }
  return noted;
}

// Format hits as injection block for the prompt (keeps citations)
export function formatRagBlock(hits: RagHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h, i) => {
    const related = h.relatedNotes?.length ? ` (related: ${h.relatedNotes.join(", ")})` : "";
    if (h.source === "memory") return `[M${i + 1} memory:${h.path}] ${h.preview}`;
    if (h.source === "vault-semantic") return `[S${i + 1} vault-semantic:${h.path}] ${h.preview}${related}`;
    return `[R${i + 1} vault:${h.path}${h.line ? `:${h.line}` : ""}] ${h.preview}${related}`;
  });
  return `## RAG — retrieved context (cite as [R#], [M#], or [S#] when used)\n${lines.join("\n")}`.trim();
}

// Convenience: one-call retrieve + format
export async function retrieveRagBlock(query: string, limit = 6): Promise<string> {
  const hits = await ragSearch(query, limit);
  return formatRagBlock(hits);
}
