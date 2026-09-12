/**
 * Kuwana-inspired semantic cache — personal-app variant.
 * Caches `generateAiJson` / `llmGenerate` JSON results keyed on feature+system+prompt.
 * In-memory LRU with TTL; Redis optional (REDIS_URL) but not required for personal use.
 * Chat streaming is NEVER cached — only deterministic JSON/text calls.
 */
import crypto from "node:crypto";

type CacheEntry = { value: unknown; expiresAt: number };

const memCache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 500;

function prune() {
  if (memCache.size <= MAX_ENTRIES) return;
  // evict oldest expired first, then oldest overall
  const now = Date.now();
  for (const [k, v] of memCache) {
    if (v.expiresAt <= now) memCache.delete(k);
    if (memCache.size <= MAX_ENTRIES - 50) break;
  }
  if (memCache.size > MAX_ENTRIES) {
    const keys = [...memCache.keys()];
    for (let i = 0; i < keys.length - MAX_ENTRIES + 200; i++) memCache.delete(keys[i]);
  }
}

export function aiCacheKey(parts: { feature: string; system: string; prompt: string }): string {
  const hash = crypto.createHash("sha256").update(`${parts.feature}\u0000${parts.system}\u0000${parts.prompt}`).digest("hex").slice(0, 32);
  return `naxion:${parts.feature}:${hash}`;
}

export async function getCachedJson<T>(key: string): Promise<T | null> {
  const e = memCache.get(key);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) { memCache.delete(key); return null; }
  return e.value as T;
}

export async function setCachedJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (ttlSeconds <= 0) return;
  memCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  prune();
}

export function getCacheTtlSeconds(): number {
  const v = Number(process.env.LLM_CACHE_TTL_SECONDS ?? process.env.NEUROWORKS_CACHE_TTL_SECONDS ?? "3600");
  if (Number.isFinite(v) && v >= 0) return Math.floor(v);
  return 3600;
}

// Redis passthrough (optional) — if REDIS_URL set, mirror mem cache to Redis
let redis: any = null;
let redisTried = false;
async function getRedis(): Promise<any> {
  if (redisTried) return redis;
  if (!process.env.REDIS_URL) { redisTried = true; return null; }
  try {
    // @ts-ignore - optional peer dep
    const mod: any = await import("ioredis" as any).catch(() => null) as any;
    if (!mod) { redisTried = true; return null; }
    const R = mod.default ?? mod;
    redis = new R(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1 });
    redis.on("error", (e: Error) => console.error("[ai-cache] redis error:", e.message));
    redisTried = true;
    return redis;
  } catch { redisTried = true; return null; }
}

export async function getCachedJsonRedis<T>(key: string): Promise<T | null> {
  const mem = await getCachedJson<T>(key);
  if (mem) return mem;
  try {
    const r = await getRedis();
    if (!r) return null;
    const raw = await r.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as T;
    memCache.set(key, { value: parsed, expiresAt: Date.now() + getCacheTtlSeconds() * 1000 });
    return parsed;
  } catch { return null; }
}

export async function setCachedJsonRedis(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await setCachedJson(key, value, ttlSeconds);
  try {
    const r = await getRedis();
    if (r) await r.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch { /* best-effort */ }
}
