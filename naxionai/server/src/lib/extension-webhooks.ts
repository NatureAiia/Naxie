import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = resolve(__dirname, "../../../.naxion");
const STORE_PATH = resolve(STORE_DIR, "extension-webhooks.json");

export type WebhookEntry = {
  id: string;
  targetId: string; // connector/integration id or core extension id
  targetKind: "connector" | "integration" | "extension";
  secret: string;
  urlPath: string; // e.g. /api/extensions/webhook/<id>
  createdAt: string;
  lastHitAt?: string;
  hitCount: number;
  /** Recent caller-supplied idempotency keys prevent duplicate task runs. */
  recentJobs?: { key: string; jobId: string; at: string }[];
};

const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECENT_JOBS = 100;

export type PublicWebhookEntry = Omit<WebhookEntry, "secret" | "recentJobs"> & { secretConfigured: boolean };
export function toPublicWebhook(w: WebhookEntry): PublicWebhookEntry {
  const { secret, recentJobs: _recentJobs, ...publicEntry } = w;
  return { ...publicEntry, secretConfigured: !!secret };
}

function load(): WebhookEntry[] {
  try {
    if (!existsSync(STORE_PATH)) return [];
    const p = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}
function save(list: WebhookEntry[]) {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), "utf8");
}

export function listWebhooks(): WebhookEntry[] { return load(); }
export function getWebhook(id: string): WebhookEntry | undefined { return load().find(w => w.id === id); }

export function createWebhook(targetId: string, targetKind: "connector" | "integration" | "extension"): WebhookEntry {
  const list = load();
  const existing = list.find(w => w.targetId === targetId && w.targetKind === targetKind);
  if (existing) return existing;
  const id = randomUUID().slice(0, 8);
  const secret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 8);
  const entry: WebhookEntry = {
    id,
    targetId,
    targetKind,
    secret,
    urlPath: `/api/extensions/webhook/${id}`,
    createdAt: new Date().toISOString(),
    hitCount: 0,
  };
  list.push(entry);
  save(list);
  return entry;
}

export function rotateWebhookSecret(id: string): WebhookEntry | null {
  const list = load();
  const w = list.find(x => x.id === id);
  if (!w) return null;
  w.secret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 8);
  save(list);
  return w;
}

export function removeWebhook(id: string): boolean {
  const list = load();
  const next = list.filter(w => w.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

export function recordHit(id: string) {
  const list = load();
  const w = list.find(x => x.id === id);
  if (!w) return;
  w.hitCount++;
  w.lastHitAt = new Date().toISOString();
  save(list);
}

export function verifySecret(id: string, provided?: string): boolean {
  if (!provided) return false;
  const w = getWebhook(id);
  if (w) return w.secret === provided;
  // fallback to env shared secret (mirrors NW_WEBHOOK_SIGNING_SECRET pattern)
  const env = (process.env.EXTENSION_WEBHOOK_SECRET ?? process.env.NW_WEBHOOK_SIGNING_SECRET ?? "").trim();
  if (env && provided === env) return true;
  return false;
}

export function findIdempotentJob(id: string, key: string): string | undefined {
  const w = getWebhook(id);
  if (!w) return undefined;
  const match = w.recentJobs?.find(item => item.key === key && Date.now() - Date.parse(item.at) < IDEMPOTENCY_TTL_MS);
  return match?.jobId;
}

export function recordIdempotentJob(id: string, key: string, jobId: string): void {
  const list = load();
  const w = list.find(item => item.id === id);
  if (!w) return;
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  w.recentJobs = [...(w.recentJobs ?? []).filter(item => Date.parse(item.at) >= cutoff && item.key !== key), { key, jobId, at: new Date().toISOString() }].slice(-MAX_RECENT_JOBS);
  save(list);
}
