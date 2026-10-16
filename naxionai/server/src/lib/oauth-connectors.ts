// Google / Microsoft OAuth (authorization-code flow) — personal connectors
// for Gmail/Calendar and Outlook Mail/Calendar/OneDrive. Ported from
// naxionai/backend/api/{google,microsoft}_connector.py as part of unifying
// Naxie onto one runtime (docs/naxie-architecture.md).
//
// Structural note vs. the Python original: that backend is multi-tenant
// (SQLAlchemy PlatformConnection rows keyed by owner_id) and needed a signed
// `state` param to recover WHICH user's browser redirect this was. This
// server is single-operator/local-first (see lib/connectors.ts's own global,
// unscoped connector list) — there's one connection slot per platform, not
// per user — so `state` here is just a short-lived random nonce for CSRF
// protection, not an identity carrier.
//
// Persistence follows lib/connectors.ts's own convention: a local JSON file
// under .naxion/ (outside the vault, since it carries credentials),
// secrets encrypted at rest via secret-box.ts, atomic write via temp+rename.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID, randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, isEncrypted } from "./secret-box.js";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.naxion");
const CONFIG_PATH = resolve(CONFIG_DIR, "platform-connections.json");

export type OauthPlatform = "google" | "microsoft";

export type PlatformConnection = {
  id: string;
  platform: OauthPlatform;
  accountName?: string;
  accessToken: string;   // encrypted at rest, decrypted in memory once loaded
  refreshToken?: string; // encrypted at rest
  scope?: string;
  expiresAt: number;     // epoch ms
  connectionStatus: "connected" | "error";
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

export type PlatformConnectionPublic = {
  id: string;
  platform: OauthPlatform;
  accountName?: string;
  connectionStatus: "connected" | "error";
  errorMessage?: string;
  scope?: string;
  hasRefreshToken: boolean;
  updatedAt: string;
};

const SECRET_FIELDS = ["accessToken", "refreshToken"] as const;

function load(): PlatformConnection[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!Array.isArray(parsed)) return [];
    let sawPlaintext = false;
    const list = (parsed as PlatformConnection[]).map(c => {
      const rec = { ...c };
      for (const f of SECRET_FIELDS) {
        const v = rec[f] as string | undefined;
        if (typeof v === "string" && v) {
          if (isEncrypted(v)) {
            try { (rec as any)[f] = decryptSecret(v); }
            catch { /* wrong/rotated key — leave blob; a call using it will fail clearly */ }
          } else {
            sawPlaintext = true;
          }
        }
      }
      return rec;
    });
    if (sawPlaintext) { try { save(list); } catch { /* best-effort migration */ } }
    return list;
  } catch { return []; }
}

function save(list: PlatformConnection[]): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const onDisk = list.map(c => {
    const rec = { ...c };
    for (const f of SECRET_FIELDS) {
      const v = rec[f] as string | undefined;
      if (typeof v === "string" && v && !isEncrypted(v)) (rec as any)[f] = encryptSecret(v);
    }
    return rec;
  });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

function toPublic(c: PlatformConnection): PlatformConnectionPublic {
  return {
    id: c.id, platform: c.platform, accountName: c.accountName,
    connectionStatus: c.connectionStatus, errorMessage: c.errorMessage,
    scope: c.scope, hasRefreshToken: !!c.refreshToken, updatedAt: c.updatedAt,
  };
}

export function listConnections(platform?: OauthPlatform): PlatformConnectionPublic[] {
  const list = load();
  return (platform ? list.filter(c => c.platform === platform) : list).map(toPublic);
}

function findConnection(id: string): PlatformConnection | undefined {
  return load().find(c => c.id === id);
}

export function removeConnection(id: string): boolean {
  const list = load();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

// ─── OAuth provider config ───

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
// Widened 2026-10-15 to add send/write/tasks scopes (gmail.send,
// calendar.events, tasks) alongside the original read-only set — there's no
// incremental-auth path (see buildAuthorizeUrl's prompt=consent below), so an
// account connected under the OLD narrower scope string must fully reconnect
// before google.send_email/create_event/task-sync will work for it; a stale
// token just 403s from Google until then.
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/userinfo.email";

const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// Same widening as GOOGLE_SCOPES above, for the same reason.
const MS_SCOPES = "offline_access Mail.Read Mail.Send Calendars.Read Calendars.ReadWrite Tasks.ReadWrite Files.Read User.Read";
function msAuthority(path: string): string {
  return `https://login.microsoftonline.com/${config.microsoftTenantId}/oauth2/v2.0/${path}`;
}

function isConfigured(platform: OauthPlatform): boolean {
  return platform === "google" ? config.googleOauthEnabled : config.microsoftOauthEnabled;
}

// ─── CSRF nonce store (in-memory, short-lived — see file header) ───

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes, matching the Python original
const pendingStates = new Map<string, { platform: OauthPlatform; expiresAt: number }>();

function mintState(platform: OauthPlatform): string {
  // Opportunistic sweep of expired entries so this map never grows unbounded
  // across a long-running process with abandoned/never-completed flows.
  const now = Date.now();
  for (const [k, v] of pendingStates) if (v.expiresAt < now) pendingStates.delete(k);
  const state = randomBytes(24).toString("base64url");
  pendingStates.set(state, { platform, expiresAt: now + STATE_TTL_MS });
  return state;
}

function consumeState(state: string, platform: OauthPlatform): boolean {
  const entry = pendingStates.get(state);
  if (!entry) return false;
  pendingStates.delete(state); // one-shot — a state is never reused
  return entry.platform === platform && entry.expiresAt >= Date.now();
}

// ─── authorize / callback / refresh ───

export function buildAuthorizeUrl(platform: OauthPlatform): string {
  if (!isConfigured(platform)) {
    throw new Error(`${platform === "google" ? "Google" : "Microsoft"} OAuth is not configured — set ${platform === "google" ? "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET" : "MICROSOFT_CLIENT_ID/MICROSOFT_CLIENT_SECRET"}`);
  }
  const state = mintState(platform);
  if (platform === "google") {
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.googleRedirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent", // forces a refresh_token on every consent, not just the first
      scope: GOOGLE_SCOPES,
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }
  const params = new URLSearchParams({
    client_id: config.microsoftClientId,
    redirect_uri: config.microsoftRedirectUri,
    response_type: "code",
    response_mode: "query",
    scope: MS_SCOPES,
    prompt: "consent", // force a fresh consent screen for the full current scope set — same reasoning as Google's prompt=consent above
    state,
  });
  return `${msAuthority("authorize")}?${params.toString()}`;
}

async function fetchJson(url: string, opts: RequestInit): Promise<any> {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  if (!r.ok) throw new Error(`${url} → ${r.status}: ${text.slice(0, 300)}`);
  return json;
}

/** Exchanges the callback's code for tokens, fetches identity, and upserts
 * (or creates) the single connection slot for this platform. Returns the
 * public connection record, or throws with a message suitable for a
 * redirect `?error=` slug. */
export async function handleCallback(platform: OauthPlatform, code: string, state: string): Promise<PlatformConnectionPublic> {
  if (!consumeState(state, platform)) throw new Error("invalid_or_expired_state");
  if (!isConfigured(platform)) throw new Error("not_configured");

  let accessToken: string, refreshToken: string | undefined, expiresIn: number, scope: string, accountName: string | undefined;
  if (platform === "google") {
    const tokens = await fetchJson(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: config.googleClientId, client_secret: config.googleClientSecret,
        redirect_uri: config.googleRedirectUri, grant_type: "authorization_code",
      }),
    });
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token; // only present when Google actually grants one
    expiresIn = Number(tokens.expires_in ?? 3600);
    scope = tokens.scope ?? GOOGLE_SCOPES;
    const userinfo = await fetchJson(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    accountName = userinfo.email;
  } else {
    const tokens = await fetchJson(msAuthority("token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.microsoftClientId, client_secret: config.microsoftClientSecret,
        code, redirect_uri: config.microsoftRedirectUri, grant_type: "authorization_code", scope: MS_SCOPES,
      }),
    });
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token || undefined;
    expiresIn = Number(tokens.expires_in ?? 3600);
    scope = tokens.scope ?? MS_SCOPES;
    const me = await fetchJson(`${MS_GRAPH_BASE}/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    accountName = me.mail || me.userPrincipalName || me.displayName || undefined;
  }

  const list = load();
  const now = new Date().toISOString();
  let row = list.find(c => c.platform === platform && c.accountName === accountName);
  if (!row) {
    row = {
      id: randomUUID(), platform, accessToken, expiresAt: Date.now() + expiresIn * 1000,
      connectionStatus: "connected", createdAt: now, updatedAt: now,
    };
    list.push(row);
  }
  row.accountName = accountName;
  row.accessToken = accessToken;
  if (refreshToken) row.refreshToken = refreshToken; // Microsoft often rotates it; Google only sends it on first consent
  row.scope = scope;
  row.expiresAt = Date.now() + expiresIn * 1000;
  row.connectionStatus = "connected";
  row.errorMessage = undefined;
  row.updatedAt = now;
  save(list);
  return toPublic(row);
}

async function doRefresh(row: PlatformConnection): Promise<string> {
  if (!row.refreshToken) throw new Error(`No refresh token stored for this ${row.platform} connection — please reconnect`);
  let accessToken: string, expiresIn: number, newRefreshToken: string | undefined, scope: string | undefined;
  if (row.platform === "google") {
    const tokens = await fetchJson(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: row.refreshToken, client_id: config.googleClientId,
        client_secret: config.googleClientSecret, grant_type: "refresh_token",
      }),
    });
    accessToken = tokens.access_token;
    expiresIn = Number(tokens.expires_in ?? 3600);
  } else {
    const tokens = await fetchJson(msAuthority("token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.microsoftClientId, client_secret: config.microsoftClientSecret,
        refresh_token: row.refreshToken, grant_type: "refresh_token", scope: MS_SCOPES,
      }),
    });
    accessToken = tokens.access_token;
    expiresIn = Number(tokens.expires_in ?? 3600);
    newRefreshToken = tokens.refresh_token || undefined; // Microsoft often rotates it
    scope = tokens.scope;
  }

  const list = load();
  const fresh = list.find(c => c.id === row.id);
  if (fresh) {
    fresh.accessToken = accessToken;
    if (newRefreshToken) fresh.refreshToken = newRefreshToken;
    if (scope) fresh.scope = scope;
    fresh.expiresAt = Date.now() + expiresIn * 1000;
    fresh.connectionStatus = "connected";
    fresh.errorMessage = undefined;
    fresh.updatedAt = new Date().toISOString();
    save(list);
  }
  return accessToken;
}

export async function refreshConnection(id: string): Promise<PlatformConnectionPublic> {
  const row = findConnection(id);
  if (!row) throw new Error("connection not found");
  try {
    await doRefresh(row);
  } catch (e: any) {
    const list = load();
    const fresh = list.find(c => c.id === id);
    if (fresh) { fresh.connectionStatus = "error"; fresh.errorMessage = String(e?.message ?? e).slice(0, 300); save(list); }
    throw e;
  }
  return toPublic(findConnection(id)!);
}

/** Returns a usable access token for the platform's single connection slot,
 * refreshing it first if expired (30s safety margin). Throws if no
 * connection exists yet — callers (primitives.ts) should treat that as
 * "not connected" and return an empty result, matching the Python
 * originals' fail-open behavior for the daemon's read-only digest calls. */
export async function getValidAccessToken(platform: OauthPlatform, id?: string): Promise<string> {
  const row = id ? findConnection(id) : load().find(c => c.platform === platform);
  if (!row) throw new Error(`no ${platform} connection${id ? ` with id ${id}` : ""} — connect it under Settings > Connectors first`);
  if (row.expiresAt - 30_000 > Date.now() && row.accessToken) return row.accessToken;
  return doRefresh(row);
}

export async function getValidAccessTokens(platform: OauthPlatform): Promise<{ id: string, token: string, accountName: string | undefined }[]> {
  const connections = load().filter(c => c.platform === platform);
  const results = await Promise.allSettled(connections.map(async c => ({
    id: c.id,
    accountName: c.accountName as string | undefined,
    token: await (c.expiresAt - 30_000 > Date.now() ? c.accessToken : doRefresh(c))
  })));
  return results
    .filter((r): r is PromiseFulfilledResult<{ id: string, token: string, accountName: string | undefined }> => r.status === "fulfilled")
    .map(r => r.value);
}

// Shared by every write primitive (google.send_email, google.create_event,
// etc.) that needs exactly one account's token: picks the sole connected
// account, the one matching `accountName` if given, or throws rather than
// silently guessing which real external account to act on — "ask if
// ambiguous" per the operator's instruction, not a default pick.
export function pickAccount<T extends { accountName?: string }>(platform: OauthPlatform, tokens: T[], accountName?: string): T {
  if (!tokens.length) throw new Error(`No ${platform === "google" ? "Google" : "Microsoft"} account connected — connect one in Settings > Connectors first.`);
  if (accountName) {
    const match = tokens.find(t => t.accountName === accountName);
    if (!match) throw new Error(`No connected ${platform} account named "${accountName}" — connected: ${tokens.map(t => t.accountName).join(", ")}`);
    return match;
  }
  if (tokens.length === 1) return tokens[0];
  throw new Error(`Multiple ${platform} accounts are connected (${tokens.map(t => t.accountName).join(", ")}) — specify accountName.`);
}
