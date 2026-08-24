// Lazy Postgres connection to the Supabase project's database (direct pg
// connection string, NOT the REST/Supabase-JS client — this repo already
// depends on `pg` and the plan calls for using it directly rather than
// pulling in @supabase/supabase-js for one table).
//
// Every caller (rag.ts's pgvectorSearch, the re-embed job) MUST check
// isPgAvailable() first and degrade gracefully — never let a missing/
// unreachable SUPABASE_DB_URL throw out of this module. Same posture as
// the rest of this codebase's optional integrations (OpenRouter, Firecrawl,
// n8n, ...).

// No @types/pg in this repo — src/types/optional-db-drivers.d.ts declares
// "pg" as an ambient (untyped) module for data-sources.ts's dynamic-import
// use, so every value coming out of it is implicitly `any`. Matches that
// file's own pattern rather than fighting it with a second, conflicting
// type declaration.
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;
export type Pool = any;

let pool: Pool | null = null;
let poolInitTried = false;

// Returns the shared Pool, creating it once on first use. Returns null when
// SUPABASE_DB_URL isn't configured — callers must handle null, not assume a
// pool exists.
export function getPgPool(): Pool | null {
  if (pool) return pool;
  if (poolInitTried) return null;
  poolInitTried = true;
  if (!config.pgvectorEnabled) return null;
  try {
    pool = new Pool({
      connectionString: config.supabaseDbUrl,
      // Small pool — this is a single-process server hitting a hosted
      // Supabase instance, not a high-concurrency web tier.
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      ssl: { rejectUnauthorized: false },
    });
    // Never let an unhandled 'error' event (e.g. idle connection dropped by
    // the server) crash the process — pg emits this on the pool itself.
    pool.on("error", (err: Error) => {
      console.warn(`[pg-client] pool error (tolerated): ${err?.message ?? err}`);
    });
  } catch (e: any) {
    console.warn(`[pg-client] failed to construct pool: ${e?.message ?? e}`);
    pool = null;
  }
  return pool;
}

// Cached reachability probe — a quick `SELECT 1` with a short timeout.
// Cached briefly so hot paths (ragSearch on every chat turn) don't pay a
// round trip per call when Supabase is unreachable.
let availabilityCache: { at: number; ok: boolean } | null = null;
const AVAILABILITY_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

export async function isPgAvailable(force = false): Promise<boolean> {
  if (!config.pgvectorEnabled) return false;
  if (!force && availabilityCache && Date.now() - availabilityCache.at < AVAILABILITY_TTL_MS) {
    return availabilityCache.ok;
  }
  const p = getPgPool();
  if (!p) {
    availabilityCache = { at: Date.now(), ok: false };
    return false;
  }
  try {
    await Promise.race([
      p.query("select 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("pg probe timeout")), PROBE_TIMEOUT_MS)),
    ]);
    availabilityCache = { at: Date.now(), ok: true };
    return true;
  } catch (e: any) {
    console.warn(`[pg-client] unavailable: ${e?.message ?? e}`);
    availabilityCache = { at: Date.now(), ok: false };
    return false;
  }
}

// Best-effort shutdown hook (mirrors shutdownCommitQueue in index.ts) so a
// graceful stop doesn't leave open sockets. Safe to call even if the pool
// was never created.
export async function closePgPool(): Promise<void> {
  if (!pool) return;
  try { await pool.end(); } catch { /* tolerate */ }
  pool = null;
  poolInitTried = false;
  availabilityCache = null;
}
