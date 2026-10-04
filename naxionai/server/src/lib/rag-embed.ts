// Re-embedding job for the pgvector RAG store (vault_chunks table) and MongoDB Atlas Vector Search.
//
// Triggered by the SAME vault-write signal that already busts the MiniSearch
// index and search cache (vault.ts's invalidateSearchCache — see the call to
// scheduleReembed() there). Debounced with the same shape as
// commit-queue.ts's coalescing debounce: a burst of writes inside the window
// collapses into a single re-embed pass instead of re-embedding the whole
// vault per keystroke-level write.
//
// Degrades silently (debug-level log only) whenever Postgres/MongoDB or the
// embeddings API isn't configured/reachable — this is a background
// convenience job, never something that should surface an error to a user
// mid-chat.

import { chunkVaultAsync, type VaultChunk } from "./rag-chunk.js";
import { embedText, EmbeddingsUnavailable } from "./embeddings.js";
import { getPgPool, isPgAvailable, type Pool } from "./pg-client.js";
import { config } from "../config.js";

const DEBOUNCE_MS = Number(process.env.NAXION_REEMBED_DEBOUNCE_MS ?? "10000");

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
let pendingWhileRunning = false;

let lastRun: { at: number; chunks: number; ok: boolean; error?: string } | null = null;

// Called from vault.ts wherever a vault write already invalidates the search
// cache. Cheap no-op when neither pgvector nor embeddings is configured, so
// callers don't need to gate the call themselves.
export function scheduleReembed(): void {
  if ((!config.pgvectorEnabled && !config.mongodbVectorEnabled) || !config.openaiEmbeddingEnabled) return;
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
  if ((!config.pgvectorEnabled && !config.mongodbVectorEnabled) || !config.openaiEmbeddingEnabled) {
    return { ok: false, error: "not configured — set a vector store (Supabase DB URL or MongoDB Atlas) and an OpenAI embedding API key" };
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
    const chunks = await chunkVaultAsync(config.vaultPath);
    if (chunks.length === 0) return;

    // Embed all chunks first
    let embedded = 0;
    const BATCH = 100;
    const allVectors: number[][] = [];
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
      allVectors.push(...vectors);
      embedded += batch.length;
    }

    // Write to pgvector (Supabase) if enabled
    if (config.pgvectorEnabled) {
      const available = await isPgAvailable();
      if (available) {
        const pool = getPgPool();
        if (pool) {
          for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            const vec = allVectors[i];
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
              // Best-effort entity sidecar
              try {
                await pool.query(
                  `update vault_chunks set entities = $3::jsonb, keywords = $4::text[], source_kind = $5
                   where path = $1 and chunk_index = $2`,
                  [c.path, c.chunkIndex, JSON.stringify(c.entities ?? {}), c.keywords ?? [], c.sourceKind ?? "md"],
                );
              } catch { /* pre-0003 schema — content+embedding already saved */ }
            } catch (e: any) {
              console.warn(`[rag-embed] pg upsert failed for ${c.path}#${c.chunkIndex} (tolerated): ${e?.message ?? e}`);
            }
          }
        }
      }
    }

    // Write to MongoDB Atlas Vector Search if enabled
    if (config.mongodbVectorEnabled) {
      let mongodb: any;
      try { mongodb = await import("mongodb"); }
      catch { console.debug("[rag-embed] mongodb driver not installed — skipping MongoDB Atlas write"); }
      if (mongodb) {
        const { MongoClient } = mongodb.default ?? mongodb;
        const client = new MongoClient(config.mongodbVectorUrl);
        try {
          await client.connect();
          const db = client.db(config.mongodbVectorDb);
          const coll = db.collection(config.mongodbVectorCollection);
          const operations = chunks.map((c, i) => ({
            updateOne: {
              filter: { path: c.path, chunk_index: c.chunkIndex },
              update: {
                $set: {
                  path: c.path,
                  heading: c.heading,
                  title: c.title,
                  chunk_index: c.chunkIndex,
                  content: c.content,
                  embedding: allVectors[i],
                  embedding_model: config.openaiEmbeddingModel,
                  entities: c.entities ?? {},
                  keywords: c.keywords ?? [],
                  source_kind: c.sourceKind ?? "md",
                  updated_at: new Date(),
                }
              },
              upsert: true,
            }
          }));
          if (operations.length > 0) {
            await coll.bulkWrite(operations);
          }
        } catch (e: any) {
          console.warn(`[rag-embed] MongoDB Atlas write failed (tolerated): ${e?.message ?? e}`);
        } finally {
          try { await client.close(); } catch { /* ignore */ }
        }
      }
    }

    lastRun = { at: Date.now(), chunks: embedded, ok: true };
    console.log(`[rag-embed] re-embedded ${embedded} chunk(s)`);
  } catch (e: any) {
    lastRun = { at: Date.now(), chunks: 0, ok: false, error: String(e?.message ?? e) };
    console.warn(`[rag-embed] run failed (tolerated): ${e?.message ?? e}`);
  }
}
