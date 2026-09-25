// Offline mode — one operator switch that disconnects Naxie from the internet
// and keeps everything local (Ollama, the vault, MiniSearch, memory, local
// peers). "Local" means this machine plus the private LAN, so an Ollama box
// or a peer worker on the home network keeps working.
//
// Enforcement is layered:
//   1. installOfflineNetworkGuard() wraps globalThis.fetch AND
//      net.Socket.prototype.connect, so any outbound connection to a public
//      host fails fast with an OfflineError — that covers fetch callers
//      (cloud LLMs, embeddings, web search, RSS, Telegram…) and raw-socket
//      clients (SMTP/IMAP, Postgres, WhatsApp websockets) alike.
//   2. Call sites that would otherwise error every tick or pick a cloud
//      backend check isOffline() explicitly (llm.ts routing, schedulers,
//      vault git push/pull, web tools) so they degrade quietly instead.
//
// Child processes (hermes CLI, MCP stdio servers, git) are NOT covered by the
// socket guard — they're separate processes. Those spawn sites gate on
// isOffline() themselves where it matters.
//
// Same JSON-file settings pattern as daemon-settings.ts, except a read error
// after offline was set fails CLOSED (stays offline): the operator asked for
// no internet, a corrupt file shouldn't silently reconnect them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.neuroworks");
const SETTINGS_FILE = join(STATE_DIR, "offline-mode.json");

export type OfflineModeState = {
  offline: boolean;
  since?: string; // ISO timestamp of the last switch
};

export class OfflineError extends Error {
  constructor(host: string) {
    super(`offline mode: ${host} blocked (Naxie is working locally only)`);
    this.name = "OfflineError";
  }
}

let cache: OfflineModeState | null = null;
const listeners = new Set<(offline: boolean) => void>();

function load(): OfflineModeState {
  if (cache) return cache;
  if (!existsSync(SETTINGS_FILE)) {
    cache = { offline: process.env.NEUROWORKS_OFFLINE === "1" };
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    cache = { offline: parsed.offline === true, since: typeof parsed.since === "string" ? parsed.since : undefined };
  } catch (e) {
    console.warn(`[offline-mode] failed to read ${SETTINGS_FILE}: ${(e as Error).message}. Staying offline.`);
    cache = { offline: true };
  }
  return cache;
}

export function getOfflineMode(): OfflineModeState {
  return { ...load() };
}

export function isOffline(): boolean {
  return load().offline;
}

export function setOffline(offline: boolean): OfflineModeState {
  const prev = load().offline;
  cache = { offline, since: new Date().toISOString() };
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn(`[offline-mode] persist failed: ${(e as Error).message}`);
  }
  if (prev !== offline) {
    for (const fn of listeners) {
      try { fn(offline); } catch { /* listener errors never block the switch */ }
    }
  }
  return { ...cache };
}

// Called on every switch (true = went offline). Used to flush queued vault
// pushes when coming back online, clear connectivity caches, etc.
export function onOfflineChange(fn: (offline: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ─── what counts as local ────────────────────────────────────────────────

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every(n => n <= 255) ? o : null;
}

// localhost, loopback, RFC1918 private ranges, link-local, IPv6 ULA and
// mDNS (*.local) names. Everything else — including any public DNS name —
// is "internet".
export function isLocalHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h) return true; // no host = default local socket
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h.startsWith("::ffff:")) h = h.slice(7); // IPv4-mapped IPv6
  const o = ipv4Octets(h);
  if (o) {
    const [a, b] = o;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (net.isIPv6(h)) {
    if (h === "::1" || h === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
    return false;
  }
  return false;
}

export function isLocalUrl(url: string): boolean {
  try { return isLocalHost(new URL(url).hostname); } catch { return false; }
}

// Throw if offline and the target isn't local. For call sites that want a
// clear error before they even try (web tools, hermes delegation…).
export function assertOnline(target: string): void {
  if (!isOffline()) return;
  let host = target;
  try { host = new URL(target).hostname; } catch { /* already a host */ }
  if (!isLocalHost(host)) throw new OfflineError(host);
}

// ─── the global guard ─────────────────────────────────────────────────────

let installed = false;
let originalFetch: typeof globalThis.fetch | null = null;
let originalConnect: typeof net.Socket.prototype.connect | null = null;

function fetchTarget(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

// Extract the host a net.Socket#connect call is aimed at. Returns null for
// IPC/unix-socket paths (always local) or shapes we don't recognise.
function connectHost(args: unknown[]): string | null {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first && typeof first === "object") {
    const o = first as { path?: string; host?: string; port?: unknown };
    if (o.path) return null;
    return o.host ?? "localhost";
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return typeof args[1] === "string" ? args[1] : "localhost";
  }
  return null; // string path = IPC
}

export function installOfflineNetworkGuard(): void {
  if (installed) return;
  installed = true;

  originalFetch = globalThis.fetch;
  const realFetch = originalFetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (isOffline()) {
      const target = fetchTarget(input);
      if (!isLocalUrl(target)) {
        let host = target;
        try { host = new URL(target).hostname; } catch { /* keep raw */ }
        throw new OfflineError(host);
      }
    }
    return realFetch(input as any, init);
  }) as typeof globalThis.fetch;

  originalConnect = net.Socket.prototype.connect;
  const realConnect = originalConnect;
  net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]) {
    if (isOffline()) {
      const host = connectHost(args);
      if (host !== null && !isLocalHost(host)) {
        const err = new OfflineError(host);
        process.nextTick(() => this.destroy(err));
        return this;
      }
    }
    return (realConnect as any).apply(this, args);
  } as typeof net.Socket.prototype.connect;
}

// Test hook — restores the original fetch/connect.
export function _uninstallOfflineNetworkGuardForTests(): void {
  if (!installed) return;
  if (originalFetch) globalThis.fetch = originalFetch;
  if (originalConnect) net.Socket.prototype.connect = originalConnect;
  installed = false;
  originalFetch = null;
  originalConnect = null;
}

export function _setOfflineForTests(offline: boolean): void {
  cache = { offline };
}
