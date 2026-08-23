// RAG — Retrieval-Augmented Generation
// Third retrieval path layered alongside MiniSearch + vault-index walk.
// Today: keyword/MiniSearch + memory search. Future: Supabase pgvector
// embeddings via the same searchRag() signature.

import { searchVault } from "./vault.js";
import { searchIndex } from "./vault-index.js";
import { searchMemory } from "./memory.js";
import { config } from "../config.js";

export type RagHit = {
  source: "vault" | "memory" | "persona";
  path: string;        // vault path or memory subject
  line?: number;
  preview: string;
  score: number;
};

// Hybrid search: vault-index (MiniSearch) first, then memory, then fallback walk.
export function ragSearch(query: string, limit = 8): RagHit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: RagHit[] = [];
  const seen = new Set<string>();

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
        if (hits.length >= limit) break;
      }
    } catch { /* ignore */ }
  }

  // Sort vault hits by score desc, memory after
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// Format hits as injection block for the prompt (keeps citations)
export function formatRagBlock(hits: RagHit[]): string {
  if (hits.length === 0) return "";
  const lines = hits.map((h, i) => {
    if (h.source === "memory") return `[M${i + 1} memory:${h.path}] ${h.preview}`;
    return `[R${i + 1} vault:${h.path}${h.line ? `:${h.line}` : ""}] ${h.preview}`;
  });
  return `## RAG — retrieved context (cite as [R#] or [M#] when used)\n${lines.join("\n")}`.trim();
}

// Convenience: one-call retrieve + format
export function retrieveRagBlock(query: string, limit = 6): string {
  const hits = ragSearch(query, limit);
  return formatRagBlock(hits);
}
