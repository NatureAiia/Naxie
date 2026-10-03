// Security watchdog — request-level attack detection + automatic blocking.
//
// Sits in front of every route (mounted early in index.ts) and watches for
// the patterns real attacks leave in traffic:
//
//   scanner-probe   requests for paths only vuln scanners ask for
//                   (/wp-admin, /.env, /.git, /phpmyadmin, …)
//   traversal       ../ or %2e%2e path traversal in the URL
//   injection       SQLi / XSS signatures in the URL or query string
//                   (URL ONLY — bodies legitimately carry prose and code
//                   in an AI-workforce app, scanning them would false-flag)
//   auth-failure    bursts of 401/403 responses (credential stuffing,
//                   token guessing) — observed from the response side
//   flood           request-rate spikes from one remote address
//
// Every hit adds to a per-IP score with time decay. Cross the block
// threshold and the address is auto-blocked (403) for BLOCK_MINUTES.
// Loopback is NEVER blocked or rate-scored: workers, peers, and the local
// operator hammer 127.0.0.1 legitimately, and self-blocking would be a
// self-inflicted denial of service. Loopback probes still LOG (a compromised
// local process is worth knowing about) — they just never block.
//
// Events persist to .naxion/security-events.json (ring buffer) and
// critical ones also land in the audit log. Admins read them via
// GET /api/security/events; unblock via POST /api/security/unblock.

import type { Request, Response, NextFunction } from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { logAudit } from "./audit-log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.naxion");
const EVENTS_PATH = resolve(STATE_DIR, "security-events.json");

const MAX_EVENTS = 500;
const BLOCK_THRESHOLD = Number(process.env.NW_SECWATCH_BLOCK_SCORE ?? "25");
const BLOCK_MINUTES = Number(process.env.NW_SECWATCH_BLOCK_MINUTES ?? "30");
const SCORE_HALF_LIFE_MS = 10 * 60_000;      // score halves every 10 minutes
const FLOOD_WINDOW_MS = 60_000;
const FLOOD_LIMIT = Number(process.env.NW_SECWATCH_FLOOD_PER_MIN ?? "600");
const AUTH_FAIL_WINDOW_MS = 5 * 60_000;
const AUTH_FAIL_LIMIT = 10;

export type SecurityEvent = {
  at: string;
  ip: string;
  kind: "scanner-probe" | "traversal" | "injection" | "auth-failure-burst" | "flood" | "blocked-request";
  path: string;
  detail?: string;
  severity: "low" | "medium" | "high";
  blocked?: boolean;
};

// Paths only scanners and exploit kits request. Word-boundary/prefix anchored
// so real app routes can never collide.
const PROBE_PATHS = /^\/(?:wp-(?:admin|login|content|includes)|\.env|\.git(?:\/|$)|\.aws|\.ssh|phpmyadmin|pma|mysql|admin\.php|xmlrpc\.php|vendor\/phpunit|cgi-bin|owa\/|autodiscover|actuator|jenkins|manager\/html|solr|console\/|_ignition|telescope|debug\/default|server-status|HNAP1|boaform|shell|id_rsa)/i;

const TRAVERSAL = /(?:\.\.[\\/]|\.\.%2f|\.\.%5c|%2e%2e(?:%2f|%5c|\/|\.)?|%c0%ae|\/etc\/passwd|\\windows\\system32|%00)/i;

// URL/query-string injection signatures. Deliberately conservative.
const INJECTION = /(?:\bunion\s+(?:all\s+)?select\b|\bor\s+1\s*=\s*1\b|['"]\s*or\s*['"]?1['"]?\s*=|\bsleep\s*\(\s*\d|benchmark\s*\(|xp_cmdshell|information_schema|load_file\s*\(|<script[\s>]|javascript:\s*[a-z]|onerror\s*=|\$\{jndi:)/i;

type IpState = {
  score: number;
  scoreAt: number;              // last decay timestamp
  hits: number[];               // request timestamps within flood window
  floodFlagged?: boolean;       // latch: one flood event per burst, re-armed when the window drains
  authFails: number[];          // 401/403 timestamps
  blockedUntil?: number;
};

const ips = new Map<string, IpState>();
let events: SecurityEvent[] = [];
let loaded = false;

function loadEvents(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(EVENTS_PATH)) {
      const arr = JSON.parse(readFileSync(EVENTS_PATH, "utf8"));
      if (Array.isArray(arr)) events = arr.slice(-MAX_EVENTS);
    }
  } catch { events = []; }
}

function saveEvents(): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(EVENTS_PATH, JSON.stringify(events.slice(-MAX_EVENTS), null, 2), "utf8");
  } catch { /* the watchdog must never take the app down */ }
}

function stateFor(ip: string): IpState {
  let s = ips.get(ip);
  if (!s) { s = { score: 0, scoreAt: Date.now(), hits: [], authFails: [] }; ips.set(ip, s); }
  return s;
}

function decayScore(s: IpState): void {
  const now = Date.now();
  const elapsed = now - s.scoreAt;
  if (elapsed > 0 && s.score > 0) s.score = s.score * Math.pow(0.5, elapsed / SCORE_HALF_LIFE_MS);
  s.scoreAt = now;
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.startsWith("127.");
}

const SEVERITY_SCORE = { low: 3, medium: 8, high: 15 } as const;

function record(ip: string, kind: SecurityEvent["kind"], path: string, severity: SecurityEvent["severity"], detail?: string, blocked?: boolean): void {
  loadEvents();
  const ev: SecurityEvent = { at: new Date().toISOString(), ip, kind, path: path.slice(0, 300), severity, ...(detail ? { detail: detail.slice(0, 200) } : {}), ...(blocked ? { blocked } : {}) };
  events.push(ev);
  saveEvents();
  if (severity === "high" || blocked) {
    try {
      logAudit({
        level: blocked ? "error" : "warn",
        actor: `ip:${ip}`,
        action: `security.${kind}`,
        target: path.slice(0, 200),
        detail: `${detail ?? kind}${blocked ? " — auto-blocked" : ""}`,
        result: blocked ? "failure" : "pending",
      });
    } catch { /* audit write must never take a request down */ }
  }
  console.warn(`[security-watch] ${kind} from ${ip} on ${path.slice(0, 120)}${blocked ? " — BLOCKED" : ""}`);
}

// ── The middleware ─────────────────────────────────────────────────────
export function securityWatch(req: Request, res: Response, next: NextFunction): void {
  const ip = String(req.ip ?? req.socket?.remoteAddress ?? "?");
  const local = isLoopback(ip);
  const s = stateFor(ip);
  const now = Date.now();

  // Active block — reject before any route work. Loopback is never blocked.
  if (!local && s.blockedUntil && now < s.blockedUntil) {
    record(ip, "blocked-request", req.originalUrl, "low");
    res.status(403).json({ error: "forbidden" });
    return;
  }

  decayScore(s);
  const url = req.originalUrl || req.path;
  let hitSeverity: SecurityEvent["severity"] | null = null;

  if (PROBE_PATHS.test(req.path)) {
    record(ip, "scanner-probe", url, "medium");
    hitSeverity = "medium";
  } else if (TRAVERSAL.test(url)) {
    record(ip, "traversal", url, "high");
    hitSeverity = "high";
  } else if (INJECTION.test(url)) {
    record(ip, "injection", url, "high");
    hitSeverity = "high";
  }

  // Flood tracking — remote addresses only. Use >= (not ===) so a burst that
  // jumps past the limit between checks still trips; a per-IP latch keeps it to
  // one event per window rather than firing on every request past the line.
  if (!local) {
    s.hits.push(now);
    s.hits = s.hits.filter(t => now - t < FLOOD_WINDOW_MS);
    if (s.hits.length >= FLOOD_LIMIT && !s.floodFlagged) {
      s.floodFlagged = true;
      record(ip, "flood", url, "medium", `${s.hits.length} requests in 60s`);
      hitSeverity = hitSeverity ?? "medium";
    } else if (s.hits.length < FLOOD_LIMIT) {
      s.floodFlagged = false; // window drained — re-arm for the next burst
    }
  }

  // Auth-failure burst detection — watch the response status on the way out.
  res.on("finish", () => {
    if (res.statusCode !== 401 && res.statusCode !== 403 && res.statusCode !== 429) return;
    if (local) return;
    const t = Date.now();
    s.authFails.push(t);
    s.authFails = s.authFails.filter(x => t - x < AUTH_FAIL_WINDOW_MS);
    if (s.authFails.length === AUTH_FAIL_LIMIT) {
      record(ip, "auth-failure-burst", url, "high", `${s.authFails.length} auth failures in 5m`);
      s.score += SEVERITY_SCORE.high;
      maybeBlock(ip, s, url);
    }
  });

  if (hitSeverity && !local) {
    s.score += SEVERITY_SCORE[hitSeverity];
    if (maybeBlock(ip, s, url)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
  }
  next();
}

function maybeBlock(ip: string, s: IpState, url: string): boolean {
  if (s.score < BLOCK_THRESHOLD || isLoopback(ip)) return false;
  if (s.blockedUntil && Date.now() < s.blockedUntil) return true;
  s.blockedUntil = Date.now() + BLOCK_MINUTES * 60_000;
  record(ip, "blocked-request", url, "high", `score ${s.score.toFixed(1)} >= ${BLOCK_THRESHOLD} — blocked ${BLOCK_MINUTES}m`, true);
  return true;
}

// ── Read/admin API surface (mounted under /api/security) ───────────────
export function securityStatus(): { events: SecurityEvent[]; blocked: { ip: string; until: string; score: number }[]; watching: number } {
  loadEvents();
  const now = Date.now();
  const blocked = [...ips.entries()]
    .filter(([, s]) => s.blockedUntil && s.blockedUntil > now)
    .map(([ip, s]) => ({ ip, until: new Date(s.blockedUntil!).toISOString(), score: Math.round(s.score * 10) / 10 }));
  return { events: [...events].reverse().slice(0, 200), blocked, watching: ips.size };
}

export function unblockIp(ip: string): boolean {
  const s = ips.get(ip);
  if (!s || !s.blockedUntil) return false;
  s.blockedUntil = undefined;
  s.score = 0;
  return true;
}
