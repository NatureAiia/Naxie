// Re-embedding job for the pgvector RAG store (vault_chunks table).
//
// Triggered by the SAME vault-write signal that already busts the MiniSearch
// index and search cache (vault.ts's invalidateSearchCache — see the call to
// scheduleReembed() there). Debounced with the same shape as
// commit-queue.ts's coalescing debounce: a burst of writes inside the window
// collapses into a single re-embed pass instead of re-embedding the whole
// vault per keystroke-level write.
//
// Degrades silently (debug-level log only) whenever Postgres or the
// embeddings API isn't configured/reachable — this is a background
// convenience job, never something that should surface an error to a user
// mid-chat.

import { chunkVault, type VaultChunk } from "./rag-chunk.js";
import { embedText, EmbeddingsUnavailable } from "./embeddings.js";
import { getPgPool, isPgAvailable, type Pool } from "./pg-client.js";
import { config } from "../config.js";

const DEBOUNCE_MS = Number(process.env.NEUROWORKS_REEMBED_DEBOUNCE_MS ?? "10000");

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
let pendingWhileRunning = false;

let lastRun: { at: number; chunks: number; ok: boolean; error?: string } | null = null;

// Called from vault.ts wherever a vault write already invalidates the search
// cache. Cheap no-op when neither pgvector nor embeddings is configured, so
// callers don't need to gate the call themselves.
export function scheduleReembed(): void {
  if (!config.pgvectorEnabled || !config.openaiEmbeddingEnabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void runReembed(); }, DEBOUNCE_MS);
}

export function reembedStats() {
  return { lastRun, debounceMs: DEBOUNCE_MS, pending: timer !== null, running: inFlight !== null };
}

// Manual trigger for a settings-page "re-embed now" button — same underlying
// run as the debounced scheduler, but fires immediately and reports whether
// it could even start (vs. scheduleReembed's silent no-op when unconfigured).
export async function runReembedNow(): Promise<{ ok: boolean; error?: string }> {
  if (!config.pgvectorEnabled || !config.openaiEmbeddingEnabled) {
    return { ok: false, error: "not configured — set both a Supabase DB URL and an OpenAI embedding API key" };
  }
  if (timer) { clearTimeout(timer); timer = null; }
  await runReembed();
  return lastRun?.ok === false ? { ok: false, error: lastRun.error } : { ok: true };
}

async function runReembed(): Promise<void> {
  timer = null;
  if (inFlight) {
    // A run is already in progress — remember that more writes landed and
    // let that run's finally-block kick a follow-up pass.
    pendingWhileRunning = true;
    return;
  }
  inFlight = doRun().finally(() => {
    inFlight = null;
    if (pendingWhileRunning) {
      pendingWhileRunning = false;
      scheduleReembed();
    }
  });
  await inFlight;
}

async function doRun(): Promise<void> {
  try {
    const available = await isPgAvailable();
    if (!available) {
      console.debug("[rag-embed] skipped — Postgres unavailable");
      return;
    }
    const pool = getPgPool();
    if (!pool) {
      console.debug("[rag-embed] skipped — no pg pool");
      return;
    }

    const chunks = chunkVault(config.vaultPath);
    if (chunks.length === 0) return;

    let embedded = 0;
    const BATCH = 100;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      let vectors: number[][];
      try {
        vectors = await embedText(batch.map(c => c.content));
      } catch (e) {
        if (e instanceof EmbeddingsUnavailable) {
          console.debug(`[rag-embed] skipped — ${e.message}`);
          return;
        }
        throw e;
      }
      await upsertChunks(pool, batch, vectors);
      embedded += batch.length;
    }

    lastRun = { at: Date.now(), chunks: embedded, ok: true };
    console.log(`[rag-embed] re-embedded ${embedded} chunk(s)`);
  } catch (e: any) {
    lastRun = { at: Date.now(), chunks: 0, ok: false, error: String(e?.message ?? e) };
    console.warn(`[rag-embed] run failed (tolerated): ${e?.message ?? e}`);
  }
}

async function upsertChunks(pool: Pool, batch: VaultChunk[], vectors: number[][]): Promise<void> {
  for (let i = 0; i < batch.length; i++) {
    const c = batch[i];
    const vec = vectors[i];
    if (!vec) continue;
    const vecLiteral = `[${vec.join(",")}]`;
    try {
      await pool.query(
        `insert into vault_chunks (path, heading, title, chunk_index, content, embedding, embedding_model, updated_at)
         values ($1, $2, $3, $4, $5, $6::vector, $7, now())
         on conflict (path, chunk_index)
         do update set heading = excluded.heading, title = excluded.title,
           content = excluded.content, embedding = excluded.embedding,
           embedding_model = excluded.embedding_model, updated_at = now()`,
        [c.path, c.heading, c.title, c.chunkIndex, c.content, vecLiteral, config.openaiEmbeddingModel],
      );
    } catch (e: any) {
      console.warn(`[rag-embed] upsert failed for ${c.path}#${c.chunkIndex} (tolerated): ${e?.message ?? e}`);
    }
  }
}
