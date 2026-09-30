// File governance (RIFTS-X records layer port): chain-of-custody log,
// expiring share tokens, file access log, retention lifecycle scan, and a
// scanned-document OCR inbox. File-based JSONL under .neuroworks so it
// works with zero DB config — same posture as rag-telemetry.ts.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.neuroworks");
const CUSTODY_FILE = join(STATE_DIR, "custody-log.jsonl");
const ACCESS_FILE = join(STATE_DIR, "file-access-log.jsonl");
const SHARES_FILE = join(STATE_DIR, "file-shares.json");
const SCANNED_FILE = join(STATE_DIR, "scanned-inbox.jsonl");
const MAX_LINES = 5000;

function ensureDir(f: string): void {
  try {
    const d = dirname(f);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  } catch { /* ignore */ }
}

function appendJsonl(file: string, rec: Record<string, unknown>): void {
  try {
    ensureDir(file);
    appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
    // Opportunistic trim — cheap length check via read only occasionally.
    if (Math.random() < 0.01) {
      try {
        const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
        if (lines.length > MAX_LINES) writeFileSync(file, lines.slice(-MAX_LINES).join("\n") + "\n", "utf8");
      } catch { /* ignore */ }
    }
  } catch { /* governance must never break vault writes */ }
}

function readJsonl<T>(file: string): T[] {
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l) as T; } catch { return null; } })
      .filter((x): x is T => x !== null);
  } catch { return []; }
}

// --- Chain of custody (RIFTS-X CustodyLog) ---
export type CustodyAction = "created" | "edited" | "moved" | "handover" | "transfer" | "shared" | "archived" | "sidecar";
export type CustodyRecord = {
  ts: string;
  path: string;
  action: CustodyAction;
  actor?: string;
  from?: string;
  to?: string;
  reason?: string;
};

export function recordCustody(rec: Omit<CustodyRecord, "ts"> & { ts?: string }): void {
  appendJsonl(CUSTODY_FILE, { ...rec, path: rec.path.slice(0, 400), ts: rec.ts ?? new Date().toISOString() });
}

export function custodyTimeline(path: string, limit = 50): CustodyRecord[] {
  return readJsonl<CustodyRecord>(CUSTODY_FILE)
    .filter(r => r.path === path)
    .slice(-Math.max(1, Math.min(200, limit)));
}

// --- File access log (RIFTS-X FileAccessLog) ---
export type FileAccessAction = "view" | "download" | "share" | "search-hit";
export function recordFileAccess(path: string, action: FileAccessAction, actor?: string): void {
  appendJsonl(ACCESS_FILE, { ts: new Date().toISOString(), path: path.slice(0, 400), action, actor: actor?.slice(0, 120) });
}

// --- Expiring share tokens (RIFTS-X SecureLink/DigitalShare) ---
export type FileShare = {
  token: string;
  path: string;
  createdBy?: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revoked: boolean;
};

function loadShares(): FileShare[] {
  try {
    if (!existsSync(SHARES_FILE)) return [];
    const parsed = JSON.parse(readFileSync(SHARES_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed as FileShare[] : [];
  } catch { return []; }
}

function saveShares(shares: FileShare[]): void {
  try {
    ensureDir(SHARES_FILE);
    writeFileSync(SHARES_FILE, JSON.stringify(shares.slice(-500), null, 2), "utf8");
  } catch { /* ignore */ }
}

const SHARE_HMAC_KEY = process.env.NAXION_SHARE_KEY ?? "neuroworks-local-share-key";

export function createShareToken(path: string, opts: { ttlHours?: number; maxUses?: number; createdBy?: string } = {}): FileShare {
  const ttlH = Math.min(24 * 30, Math.max(1, opts.ttlHours ?? 72));
  const token = randomBytes(24).toString("base64url");
  const now = Date.now();
  const share: FileShare = {
    token,
    path,
    createdBy: opts.createdBy?.slice(0, 120),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlH * 3_600_000).toISOString(),
    maxUses: Math.min(1000, Math.max(1, opts.maxUses ?? 10)),
    uses: 0,
    revoked: false,
  };
  // Bind token to path so a swapped token can't be replayed for another file.
  const sig = createHmac("sha256", SHARE_HMAC_KEY).update(`${token}.${path}`).digest("hex").slice(0, 16);
  share.token = `${token}.${sig}`;
  const shares = loadShares();
  shares.push(share);
  saveShares(shares);
  recordCustody({ path, action: "shared", actor: opts.createdBy, reason: `share token expires ${share.expiresAt}` });
  return share;
}

export function verifyShareToken(token: string): { ok: true; share: FileShare } | { ok: false; error: string } {
  const shares = loadShares();
  const share = shares.find(s => s.token === token);
  if (!share) return { ok: false, error: "unknown token" };
  const [raw, sig] = token.split(".");
  const expect = createHmac("sha256", SHARE_HMAC_KEY).update(`${raw}.${share.path}`).digest("hex").slice(0, 16);
  if (sig !== expect) return { ok: false, error: "token mismatch" };
  if (share.revoked) return { ok: false, error: "revoked" };
  if (Date.parse(share.expiresAt) < Date.now()) return { ok: false, error: "expired" };
  if (share.uses >= share.maxUses) return { ok: false, error: "use limit reached" };
  return { ok: true, share };
}

export function consumeShareToken(token: string, actor?: string): { ok: true; path: string } | { ok: false; error: string } {
  const v = verifyShareToken(token);
  if (!v.ok) return v;
  const shares = loadShares();
  const s = shares.find(x => x.token === token);
  if (!s) return { ok: false, error: "unknown token" };
  s.uses += 1;
  saveShares(shares);
  recordFileAccess(s.path, "download", actor);
  return { ok: true, path: s.path };
}

export function revokeShareToken(token: string): boolean {
  const shares = loadShares();
  const s = shares.find(x => x.token === token);
  if (!s) return false;
  s.revoked = true;
  saveShares(shares);
  return true;
}

// --- Retention lifecycle scan (RIFTS-X RetentionRule) ---
export type RetentionFinding = {
  path: string;
  expiryDate: string;
  status: "expired" | "expiring-30d";
  sensitivity?: string;
};

export function scanRetention(findings: { path: string; expiryDate?: string; sensitivity?: string }[]): RetentionFinding[] {
  const now = Date.now();
  const out: RetentionFinding[] = [];
  for (const f of findings) {
    if (!f.expiryDate || !/^\d{4}-\d{2}-\d{2}/.test(f.expiryDate)) continue;
    const ms = Date.parse(f.expiryDate) - now;
    if (!Number.isFinite(ms)) continue;
    if (ms < 0) out.push({ path: f.path, expiryDate: f.expiryDate, status: "expired", sensitivity: f.sensitivity });
    else if (ms <= 30 * 86_400_000) out.push({ path: f.path, expiryDate: f.expiryDate, status: "expiring-30d", sensitivity: f.sensitivity });
  }
  return out.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate)).slice(0, 100);
}

// --- Scanned-document OCR inbox (RIFTS-X ScannedDocument) ---
export type ScannedInboxRecord = {
  ts: string;
  path: string;
  status: "pending" | "processing" | "completed" | "failed";
  textChars?: number;
  confidence?: number;
  linkedPath?: string;
  error?: string;
};

export function inboxScanned(rec: Omit<ScannedInboxRecord, "ts"> & { ts?: string }): void {
  appendJsonl(SCANNED_FILE, { ...rec, ts: rec.ts ?? new Date().toISOString() });
}

export function listScannedInbox(limit = 100): ScannedInboxRecord[] {
  return readJsonl<ScannedInboxRecord>(SCANNED_FILE).slice(-Math.max(1, Math.min(500, limit))).reverse();
}
