// RAG — Retrieval-Augmented Generation
// Retrieval paths layered alongside MiniSearch + vault-index walk:
// keyword/MiniSearch + memory search + fallback walk, PLUS (when configured)
// Supabase pgvector semantic search over vault_chunks (see lib/rag-embed.ts
// for how that table gets populated, and lib/pg-client.ts / lib/embeddings.ts
// for the Postgres + embeddings clients it depends on). The pgvector step is
// entirely optional — SUPABASE_DB_URL / OPENAI_EMBEDDING_API_KEY unset simply
// means ragSearch behaves exactly as before.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { searchVault } from "./vault.js";
import { searchIndex } from "./vault-index.js";
import { searchMemory, datedFactsInWindow } from "./memory.js";
import { config } from "../config.js";
import { getPgPool, isPgAvailable } from "./pg-client.js";
import { embedText, embeddingsConfigured } from "./embeddings.js";
import { graphNeighbors } from "./vault-graph.js";
import { recordRagQuery } from "./rag-telemetry.js";
import { isOffline } from "./offline-mode.js";
import { detectIntent, extractEntityHints, intentStrategy } from "./rag-intent.js";
import { expandFollowUpQuery, rememberRagQuery } from "./rag-memory.js";
import { extractEntities, entityOverlapBoost, parseFileMeta, riskFlags } from "./rag-entities.js";
import { listSchedules } from "./schedules.js";
import { listOrgTasks } from "./org-tasks.js";

export type RagHit = {
  source: "vault" | "memory" | "persona" | "vault-semantic" | "structured" | "insight";
  path: string;        // vault path or memory subject
  line?: number;
  preview: string;
  score: number;
  relevance?: number;  // 0..1 structured-retrieval score (RIFTS-X style)
  link?: string;       // deep link for structured hits
  flags?: string[];    // risk/SLA markers: sensitive, overdue, retention-expired/expiring
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
  if (isOffline() || !config.pgvectorEnabled || !embeddingsConfigured()) return [];
  try {
    const available = await isPgAvailable();
    if (!available) return [];
    const pool = getPgPool();
    if (!pool) return [];
    const [vec] = await embedText([query]);
    if (!vec) return [];
    const vecLiteral = `[${vec.join(",")}]`;
    const { rows } = await pool.query(
      `select path, heading, title, content, entities, keywords, source_kind,
              embedding <=> $1::vector as distance
       from vault_chunks
       order by embedding <=> $1::vector
       limit $2`,
      [vecLiteral, limit],
    );
    // Entity-overlap boost: a semantic hit that ALSO shares emails/dates/
    // keywords with the query outranks a pure-vector neighbor.
    return rows.map((r: any): RagHit => {
      const chunkEnts = {
        emails: r.entities?.emails ?? [],
        phones: r.entities?.phones ?? [],
        amounts: r.entities?.amounts ?? [],
        dates: r.entities?.dates ?? [],
      };
      const base = Math.max(0, 7 - Number(r.distance) * 7);
      return {
        source: "vault-semantic",
        path: r.path,
        preview: String(r.content).slice(0, 200),
        // Cosine distance 0..2 → score 7..0 so fresh semantic beats stale BM25 when pgvector is live (Kuwana tuning).
        // Memory stays pinned at 5; semantic fresh hit (distance ~0.1) scores ~6.3 → ranks above BM25.
        score: base + entityOverlapBoost(query, { ...chunkEnts, keywords: r.keywords ?? [] } as any) * 0.5,
      };
    });
  } catch (e: any) {
    console.debug(`[rag] pgvectorSearch skipped: ${e?.message ?? e}`);
    return [];
  }
}

// Semantic (MongoDB Atlas Vector Search) search over vault_chunks.
// Embeds the query, then nearest-neighbour searches via Atlas Vector Search.
// Returns [] on ANY failure — additive retrieval path, never a hard dependency.
async function mongodbVectorSearch(query: string, limit: number): Promise<RagHit[]> {
  if (isOffline() || !config.mongodbVectorEnabled || !embeddingsConfigured()) return [];
  try {
    const [vec] = await embedText([query]);
    if (!vec) return [];
    let mongodb: any;
    try { mongodb = await import("mongodb"); }
    catch { throw new Error("mongodb driver not installed — run `pnpm -C server add mongodb`"); }
    const { MongoClient } = mongodb.default ?? mongodb;
    const client = new MongoClient(config.mongodbVectorUrl);
    try {
      await client.connect();
      const db = client.db(config.mongodbVectorDb);
      const coll = db.collection(config.mongodbVectorCollection);
      const results = await coll.aggregate([
        {
          $vectorSearch: {
            index: config.mongodbVectorIndex,
            path: "embedding",
            queryVector: vec,
            numCandidates: Math.max(100, limit * 10),
            limit: limit,
          }
        },
        {
          $project: {
            path: 1,
            heading: 1,
            title: 1,
            content: 1,
            entities: 1,
            keywords: 1,
            source_kind: 1,
            score: { $meta: "vectorSearchScore" }
          }
        }
      ]).toArray();
      return results.map((r: any): RagHit => {
        const chunkEnts = {
          emails: r.entities?.emails ?? [],
          phones: r.entities?.phones ?? [],
          amounts: r.entities?.amounts ?? [],
          dates: r.entities?.dates ?? [],
        };
        // Atlas score is 0..1 (higher = better), convert to 7..0 scale like pgvector
        const base = Math.max(0, 7 - (1 - Number(r.score)) * 7);
        return {
          source: "vault-semantic",
          path: r.path,
          preview: String(r.content).slice(0, 200),
          score: base + entityOverlapBoost(query, { ...chunkEnts, keywords: r.keywords ?? [] } as any) * 0.5,
        };
      });
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  } catch (e: any) {
    console.debug(`[rag] mongodbVectorSearch skipped: ${e?.message ?? e}`);
    return [];
  }
}

// Structured retrieval (RIFTS-X RAGRetriever port): schedules, org tasks,
// and dated memory facts as first-class hits with relevance scores +
// links — not just vault chunks. Best-effort, never throws.
function structuredSearch(query: string, limit: number): RagHit[] {
  const out: RagHit[] = [];
  try {
    const hints = new Set(extractEntityHints(query));
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
    if (terms.length === 0) return out;
    const scoreText = (hay: string): number => {
      const h = hay.toLowerCase();
      let common = 0;
      for (const t of terms) if (h.includes(t)) common++;
      return terms.length ? common / terms.length : 0;
    };
    const wants = (kinds: string[]): boolean =>
      hints.size === 0 || kinds.some(k => hints.has(k as any));

    if (wants(["task", "project", "user", "status"])) {
      try {
        for (const t of listOrgTasks().slice(0, 200)) {
          const s = scoreText(`${t.title ?? ""} ${(t as any).description ?? ""} ${(t as any).role ?? ""} ${(t as any).status ?? ""}`);
          if (s > 0.3) {
            out.push({
              source: "structured", path: `tasks/${(t as any).id ?? (t as any).title}`,
              preview: `Task: ${(t as any).title} [${(t as any).status ?? "?"}${(t as any).priority ? `/${(t as any).priority}` : ""}]`,
              score: 4 + s * 2, relevance: s, link: `/tasks`,
            });
            if (out.length >= limit) break;
          }
        }
      } catch { /* ignore */ }
    }
    if (wants(["project", "finance", "contract", "status"]) && out.length < limit) {
      try {
        for (const s of listSchedules().slice(0, 200) as any[]) {
          const s2 = scoreText(`${s.name ?? s.title ?? ""} ${s.kind ?? ""} ${s.status ?? ""}`);
          if (s2 > 0.3) {
            out.push({
              source: "structured", path: `schedules/${s.id ?? s.name}`,
              preview: `Schedule: ${s.name ?? s.title} [${s.status ?? s.kind ?? "?"}]`,
              score: 4 + s2 * 2, relevance: s2, link: `/schedules`,
            });
            if (out.length >= limit) break;
          }
        }
      } catch { /* ignore */ }
    }
    // Dated memory facts surface on status/analytics queries ("what's due?").
    if (out.length < limit) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const future = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
        for (const f of datedFactsInWindow(today, future, 50)) {
          const s = scoreText(`${f.subject} ${f.fact}`);
          if (s > 0.2 || terms.some(t => ["due", "deadline", "expir", "today", "week"].includes(t))) {
            out.push({
              source: "structured", path: `memory/${f.subject}`,
              preview: `[${f.date ?? "dated"}] ${f.fact.slice(0, 180)}`,
              score: 4.5, relevance: Math.max(s, 0.4),
            });
            if (out.length >= limit) break;
          }
        }
      } catch { /* ignore */ }
    }
  } catch { /* never break retrieval */ }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Attach risk/SLA flags to vault hits by parsing frontmatter from the
// first bytes of the file. Best-effort sync read, capped — never throws.
function withRiskFlags(hits: RagHit[]): RagHit[] {
  if (hits.length === 0) return hits;
  for (const h of hits) {
    if (h.source !== "vault" && h.source !== "vault-semantic") continue;
    if (h.path.includes("..")) continue;
    try {
      const full = join(config.vaultPath, h.path);
      const st = statSync(full);
      if (!st.isFile() || st.size > 2_000_000) continue;
      const head = readFileSync(full, "utf8").slice(0, 8000);
      const meta = parseFileMeta(head);
      const flags = riskFlags(meta, head);
      if (flags.length > 0) h.flags = flags;
    } catch { /* one bad file — skip */ }
  }
  return hits;
}

// Per-query short TTL cache — same Naxie turn often re-queries similar text
// within seconds (retry, follow-up), and buildNaxieContext + planner both call
// ragSearch for the same query. 10s window avoids repeated vault walks.
const RAG_CACHE_TTL_MS = 10_000;
const ragCache = new Map<string, { at: number; hits: RagHit[] }>();

function ragCacheKey(query: string, limit: number): string {
  return `${query.trim().toLowerCase()}::${limit}`;
}

// Hybrid search: vault-index (MiniSearch) first, then memory, then structured
// records, then fallback walk, then (when configured) pgvector semantic
// search. Intent-aware: analytics/status queries rank structured + insight
// hits higher. Async because the pgvector step is a network call (embed the
// query, then a Postgres round trip) — all callers already run inside async
// request handlers.
export async function ragSearch(query: string, limit = 8, opts: { sessionId?: string } = {}): Promise<RagHit[]> {
  const rawQ = query.trim();
  if (!rawQ) return [];
  // Follow-up resolution ("that file", "the second one") via session memory.
  const expanded = expandFollowUpQuery(opts.sessionId, rawQ) ?? rawQ;
  const q = expanded.trim();
  if (!q) return [];
  const intents = detectIntent(q);
  const strategy = intentStrategy(intents);
  const effLimit = Math.max(limit, strategy.limit);
  const ck = ragCacheKey(q, effLimit);
  const t0 = Date.now();
  const cached = ragCache.get(ck);
  if (cached && Date.now() - cached.at < RAG_CACHE_TTL_MS) {
    const reused = cached.hits.slice(0, limit);
    // Cache hits still belong to this session's retrieval history; without
    // this, a follow-up can refer to an older query or have no context.
    rememberRagQuery(opts.sessionId, rawQ, reused);
    recordRagQuery({
      query: rawQ,
      hitCount: reused.length,
      sources: {
        index: reused.filter(h => h.source === "vault").length,
        memory: reused.filter(h => h.source === "memory").length,
        vaultScan: 0,
        vector: reused.filter(h => h.source === "vault-semantic").length,
        structured: reused.filter(h => h.source === "structured").length,
      },
      topScore: reused[0]?.score ?? 0,
      ms: Date.now() - t0,
      vectorEnabled: (config.pgvectorEnabled || config.mongodbVectorEnabled) && embeddingsConfigured() && !isOffline(),
    });
    return reused;
  }
  const hits: RagHit[] = [];
  const seen = new Set<string>();
  let scanCount = 0;
  let structuredCount = 0;

  // 1) MiniSearch index (fast, ranked) — with entity-overlap boost.
  try {
    const indexed = searchIndex(q, config.vaultPath, effLimit);
    if (indexed) {
      for (const h of indexed) {
        const key = `vault:${h.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let score = h.score;
        try {
          score += entityOverlapBoost(q, { ...extractEntities(h.preview), keywords: [] } as any) * 0.5;
        } catch { /* ignore */ }
        hits.push({ source: "vault", path: h.path, line: h.line, preview: h.preview, score });
      }
    }
  } catch { /* ignore */ }

  // 2) Memory search (operator/naxie/subagent facts)
  try {
    const mem = searchMemory(q, Math.max(3, Math.ceil(effLimit / 2)));
    for (const m of mem) {
      const key = `memory:${m.subject}:${m.fact.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ source: "memory", path: `memory/${m.subject}`, preview: m.fact.slice(0, 200), score: 5 });
    }
  } catch { /* ignore */ }

  // 3) Structured records (tasks / schedules / dated facts) with relevance.
  try {
    const structured = structuredSearch(q, effLimit);
    const boost = strategy.boostStructured ? 1.5 : 0;
    for (const h of structured) {
      const key = `structured:${h.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      h.score += boost;
      hits.push(h);
      structuredCount++;
    }
  } catch { /* ignore */ }

  // 3b) Fallback linear vault walk if we still have few hits (MiniSearch AND combiner can be strict)
  if (hits.length < Math.min(3, effLimit)) {
    try {
      const fallback = searchVault(q, effLimit);
      for (const h of fallback) {
        const key = `vault:${h.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ source: "vault", path: h.path, line: h.line, preview: h.preview, score: 1 });
        scanCount++;
        if (hits.length >= effLimit) break;
      }
    } catch { /* ignore */ }
  }

  // 4) pgvector semantic search (Supabase) — runs ALONGSIDE the steps above (never
  // replaces them), only when Supabase + embeddings are both configured.
  // Skips silently (debug log only) on any Postgres/embedding unavailability.
  try {
    const semantic = await pgvectorSearch(q, effLimit);
    for (const h of semantic) {
      const key = `vault-semantic:${h.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
    }
  } catch { /* ignore — pgvectorSearch already catches internally */ }

  // 5) MongoDB Atlas Vector Search — runs ALONGSIDE the steps above (never
  // replaces them), only when MongoDB Atlas + embeddings are both configured.
  // Skips silently (debug log only) on any Atlas/embedding unavailability.
  try {
    const semantic = await mongodbVectorSearch(q, effLimit);
    for (const h of semantic) {
      const key = `vault-semantic:${h.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
    }
  } catch { /* ignore — mongodbVectorSearch already catches internally */ }

  // Sort vault hits by score desc, memory after
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, effLimit);
  const noted = withRiskFlags(withRelatedNotes(top));
  // Retrieval telemetry for the weekly self-improvement review — counts are
  // over the full candidate set (pre-limit), so "the semantic path found
  // nothing" is distinguishable from "it found things that ranked lower".
  recordRagQuery({
    query: rawQ,
    hitCount: noted.length,
    sources: {
      index: Math.max(0, hits.filter(h => h.source === "vault").length - scanCount),
      memory: hits.filter(h => h.source === "memory").length,
      vaultScan: scanCount,
      vector: hits.filter(h => h.source === "vault-semantic").length,
      structured: structuredCount,
    },
    topScore: noted[0]?.score ?? 0,
    ms: Date.now() - t0,
    vectorEnabled: (config.pgvectorEnabled || config.mongodbVectorEnabled) && embeddingsConfigured() && !isOffline(),
  });
  ragCache.set(ck, { at: Date.now(), hits: noted });
  // Bound cache size (avoid unbounded growth on long uptime)
  if (ragCache.size > 200) {
    const oldestKey = ragCache.keys().next().value as string;
    ragCache.delete(oldestKey);
  }
  rememberRagQuery(opts.sessionId, rawQ, noted);
  return noted.slice(0, limit);
}

// Format hits as injection block for the prompt (keeps citations)
export function formatRagBlock(hits: RagHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h, i) => {
    const related = h.relatedNotes?.length ? ` (related: ${h.relatedNotes.join(", ")})` : "";
    const flags = h.flags?.length ? ` [${h.flags.join(",")}]` : "";
    const rel = typeof h.relevance === "number" ? ` (${Math.round(h.relevance * 100)}%)` : "";
    if (h.source === "memory") return `[M${i + 1} memory:${h.path}] ${h.preview}`;
    if (h.source === "vault-semantic") return `[S${i + 1} vault-semantic:${h.path}] ${h.preview}${related}${flags}`;
    if (h.source === "structured") return `[T${i + 1} structured:${h.path}] ${h.preview}${rel}${h.link ? ` (${h.link})` : ""}`;
    if (h.source === "insight") return `[I${i + 1} insight:${h.path}] ${h.preview}`;
    return `[R${i + 1} vault:${h.path}${h.line ? `:${h.line}` : ""}] ${h.preview}${related}${flags}`;
  });
  return `## RAG — retrieved context (cite as [R#], [M#], [S#], [T#], or [I#] when used)\n${lines.join("\n")}`.trim();
}

// Convenience: one-call retrieve + format
export async function retrieveRagBlock(query: string, limit = 6, opts: { sessionId?: string } = {}): Promise<string> {
  const hits = await ragSearch(query, limit, opts);
  return formatRagBlock(hits);
}
