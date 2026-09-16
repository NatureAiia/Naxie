// Company system connectors — a registry of external HTTP APIs the operator
// authorizes agents to call. Persisted at .neuroworks/connectors.json (outside
// the vault, since it carries credentials → encrypted at rest via secret-box).
//
// Each connector is a SELF-DESCRIBING handle to one company system:
//   • baseUrl + auth scheme (api key / bearer / basic / custom header / none)
//   • optional static headers
//   • an ENDPOINT MANIFEST — named, documented operations so an agent can
//     "read and understand" what the system offers (connector.describe) BEFORE
//     calling it (connector.call). The manifest is the contract other agents read.
//
// Safety model (mirrors data-sources.ts):
//   • Calls are READ-ONLY by default — only GET/HEAD allowed. The operator flips
//     `writeEnabled` per connector to authorize POST/PUT/PATCH/DELETE.
//   • SSRF guard — a call's resolved URL host MUST equal the configured baseUrl
//     host. A path that tries to jump to another origin is rejected.
//   • Secrets (tokens, keys, passwords) are encrypted at rest and never returned
//     to the API/UI — only a boolean "set" flag is surfaced.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { encryptSecret, decryptSecret, isEncrypted } from "./secret-box.js";
import { maskSensitiveFields } from "./security.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const CONFIG_PATH = resolve(CONFIG_DIR, "connectors.json");

// ─── Types ───
export type ConnectorAuthType = "none" | "apiKey" | "bearer" | "basic" | "header" | "oauth2";

// Auth carries both structural (non-secret) fields and secret fields. On disk
// the secret fields (value/token/password/accessToken/refreshToken) are
// encrypted; everything else is plaintext so the redacted public view can
// describe the scheme.
export type ConnectorAuth = {
  type: ConnectorAuthType;
  // apiKey: where the key goes + its parameter name (e.g. header "X-API-Key" or query "api_key")
  in?: "header" | "query";
  name?: string;
  // basic: username is non-secret; password is secret
  username?: string;
  // secret material (one of, depending on type)
  value?: string;    // apiKey / header value
  token?: string;    // bearer token
  password?: string; // basic password
  // oauth2: device-code flow (e.g. Microsoft identity platform / Graph).
  // tenant/clientId/scope are operator-entered and non-secret; accessToken/
  // refreshToken are obtained via the device-code flow (see startOAuthDeviceFlow
  // / pollOAuthDeviceFlow below) and kept fresh automatically before each call.
  tenant?: string;         // e.g. "consumers" (personal MSA), "common", or a tenant GUID
  clientId?: string;
  scope?: string;          // space-separated scopes, e.g. "Tasks.ReadWrite offline_access"
  accessToken?: string;    // secret — short-lived
  refreshToken?: string;   // secret — used to silently mint new access tokens
  expiresAt?: number;      // epoch ms; non-secret, drives the refresh check
};

const SECRET_AUTH_FIELDS = ["value", "token", "password", "accessToken", "refreshToken"] as const;

export type ConnectorEndpoint = {
  name: string;            // short id agents reference, e.g. "list_invoices"
  method: string;          // GET / POST / ...
  path: string;            // relative to baseUrl, e.g. "/v1/invoices" or "/customers/{id}"
  description?: string;    // what it does — the agent reads this to understand the system
  query?: string[];        // documented query params
  body?: string;           // freeform body shape hint (e.g. a JSON example)
};

export type Connector = {
  id: string;
  label: string;
  baseUrl: string;
  description?: string;
  auth: ConnectorAuth;
  headers?: Record<string, string>;   // static non-secret headers sent on every call
  endpoints?: ConnectorEndpoint[];
  writeEnabled: boolean;              // allow non-GET/HEAD methods
  // Operator opt-in: GET/HEAD calls to THIS connector skip the agent's
  // sensitive-action approval gate (agent.ts SENSITIVE_APPROVAL_TOOLS). Off by
  // default — only meaningful for low-sensitivity personal data (e.g. the
  // operator's own Microsoft To Do list) where pausing every read for manual
  // sign-off is pure friction. Writes are never exempted by this flag; that's
  // still gated by writeEnabled + the approval checkpoint regardless.
  skipApprovalForReads?: boolean;
  createdAt: string;
  lastTest?: { ok: boolean; detail: string; at: string };
  keyExpiresAt?: string; // ISO — operator-set expiry for the API key/secret
  lastRotatedAt?: string;
  allowedRoles?: string[];
};

// What the API/UI sees — secrets reduced to a boolean.
export type ConnectorPublic = Omit<Connector, "auth"> & {
  auth: {
    type: ConnectorAuthType; in?: "header" | "query"; name?: string; username?: string; secretSet: boolean;
    tenant?: string; clientId?: string; scope?: string; expiresAt?: number;
  };
  keyExpiresAt?: string;
  lastRotatedAt?: string;
  allowedRoles?: string[];
  daysUntilExpiry?: number;
  expiryState?: "ok" | "soon" | "expired" | "unset";
};

// ─── Persistence (secrets encrypted at rest; legacy plaintext migrated on load) ───
function load(): Connector[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!Array.isArray(parsed)) return [];
    let sawPlaintext = false;
    const list = (parsed as Connector[]).map(c => {
      const auth = { ...(c.auth ?? { type: "none" }) } as ConnectorAuth;
      for (const f of SECRET_AUTH_FIELDS) {
        const v = auth[f];
        if (typeof v === "string" && v) {
          if (isEncrypted(v)) {
            try { auth[f] = decryptSecret(v); }
            catch { /* wrong/rotated key — leave blob; call will error clearly */ }
          } else {
            sawPlaintext = true; // legacy unencrypted record
          }
        }
      }
      return { ...c, auth };
    });
    if (sawPlaintext) { try { save(list); } catch { /* best-effort migration */ } }
    return list;
  } catch { return []; }
}

function save(list: Connector[]): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const onDisk = list.map(c => {
    const auth = { ...c.auth } as ConnectorAuth;
    for (const f of SECRET_AUTH_FIELDS) {
      const v = auth[f];
      if (typeof v === "string" && v && !isEncrypted(v)) auth[f] = encryptSecret(v);
    }
    return { ...c, auth };
  });
  // Atomic write: serialize to a temp file then rename over the target, so a
  // concurrent reader (or a crash mid-write) never sees a truncated JSON file.
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

function expiryStateFor(expiresAt?: string): { daysUntilExpiry?: number; expiryState: "ok" | "soon" | "expired" | "unset" } {
  if (!expiresAt) return { expiryState: "unset" };
  const ms = new Date(expiresAt).getTime() - Date.now();
  const days = Math.ceil(ms / (24 * 3600 * 1000));
  if (days < 0) return { daysUntilExpiry: days, expiryState: "expired" };
  if (days <= 7) return { daysUntilExpiry: days, expiryState: "soon" };
  return { daysUntilExpiry: days, expiryState: "ok" };
}

function toPublic(c: Connector): ConnectorPublic {
  const secretSet = SECRET_AUTH_FIELDS.some(f => typeof c.auth?.[f] === "string" && (c.auth[f] as string).length > 0);
  const exp = expiryStateFor((c as any).keyExpiresAt);
  return {
    ...c,
    auth: {
      type: c.auth?.type ?? "none", in: c.auth?.in, name: c.auth?.name, username: c.auth?.username, secretSet,
      tenant: c.auth?.tenant, clientId: c.auth?.clientId, scope: c.auth?.scope, expiresAt: c.auth?.expiresAt,
    },
    daysUntilExpiry: exp.daysUntilExpiry,
    expiryState: exp.expiryState,
  };
}

export function listConnectors(): ConnectorPublic[] {
  return load().map(toPublic);
}

export function getConnectorPublic(idOrLabel: string): ConnectorPublic | undefined {
  const c = findConnector(idOrLabel);
  return c ? toPublic(c) : undefined;
}

// Internal — returns the connector with secrets DECRYPTED. Never expose directly.
// Resolution order: exact id, exact label, then FUZZY — substring either way,
// then token overlap. Users refer to a connector by a loose name ("finance
// flow" for "Aiia FinanceFlow") and the strict exact-label match returned
// "not found" (live 2026-07-13), so the agent reported a non-existent failure.
function findConnector(idOrLabel: string): Connector | undefined {
  const list = load();
  const key = idOrLabel.trim().toLowerCase();
  const exact = list.find(c => c.id === idOrLabel) ?? list.find(c => c.label.toLowerCase() === key);
  if (exact) return exact;
  const substr = list.find(c => c.label.toLowerCase().includes(key) || key.includes(c.label.toLowerCase()));
  if (substr) return substr;
  // Token overlap: every content token of the query appears in the label.
  const stop = new Set(["the", "of", "a", "an", "connector", "system", "app", "api"]);
  const qTokens = key.split(/[^a-z0-9]+/).filter(t => t && !stop.has(t));
  if (qTokens.length === 0) return undefined;
  return list.find(c => {
    const label = c.label.toLowerCase();
    return qTokens.every(t => label.includes(t));
  });
}

function normalizeAuth(input: any): ConnectorAuth {
  const type = (["none", "apiKey", "bearer", "basic", "header", "oauth2"].includes(input?.type) ? input.type : "none") as ConnectorAuthType;
  const auth: ConnectorAuth = { type };
  if (type === "apiKey") {
    auth.in = input?.in === "query" ? "query" : "header";
    auth.name = String(input?.name ?? "").trim() || (auth.in === "query" ? "api_key" : "X-API-Key");
    if (input?.value) auth.value = String(input.value);
  } else if (type === "bearer") {
    if (input?.token) auth.token = String(input.token);
  } else if (type === "basic") {
    auth.username = String(input?.username ?? "").trim();
    if (input?.password) auth.password = String(input.password);
  } else if (type === "header") {
    auth.name = String(input?.name ?? "").trim() || "Authorization";
    if (input?.value) auth.value = String(input.value);
  } else if (type === "oauth2") {
    // tenant/clientId/scope come from the operator's form. accessToken/
    // refreshToken/expiresAt are NEVER set here — they only ever come from
    // startOAuthDeviceFlow/pollOAuthDeviceFlow/ensureFreshOAuthToken below, so
    // a PATCH from the UI can't clobber a working token with a blank one.
    auth.tenant = String(input?.tenant ?? "").trim() || "common";
    auth.clientId = String(input?.clientId ?? "").trim();
    auth.scope = String(input?.scope ?? "").trim() || "offline_access";
  }
  return auth;
}

function normalizeEndpoints(input: any): ConnectorEndpoint[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const eps = input
    .map((e: any) => {
      const name = String(e?.name ?? "").trim();
      const path = String(e?.path ?? "").trim();
      if (!name || !path) return null;
      return {
        name,
        method: String(e?.method ?? "GET").trim().toUpperCase(),
        path,
        description: e?.description ? String(e.description) : undefined,
        query: Array.isArray(e?.query) ? e.query.map((q: any) => String(q)) : undefined,
        body: e?.body ? String(e.body) : undefined,
      } as ConnectorEndpoint;
    })
    .filter((x): x is ConnectorEndpoint => x !== null);
  return eps.length ? eps : undefined;
}

function normalizeHeaders(input: any): Record<string, string> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    const key = String(k).trim();
    if (key) out[key] = String(v);
  }
  return Object.keys(out).length ? out : undefined;
}

export function addConnector(input: {
  label: string; baseUrl: string; description?: string;
  auth?: any; headers?: any; endpoints?: any; writeEnabled?: boolean; skipApprovalForReads?: boolean;
}): ConnectorPublic {
  const label = String(input.label ?? "").trim();
  const baseUrl = String(input.baseUrl ?? "").trim();
  if (!label) throw new Error("label is required");
  if (!baseUrl) throw new Error("baseUrl is required");
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error(`baseUrl is not a valid URL: ${baseUrl}`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("baseUrl must be http(s)");
  }
  const conn: Connector = {
    id: randomUUID(),
    label,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    description: input.description ? String(input.description) : undefined,
    auth: normalizeAuth(input.auth),
    headers: normalizeHeaders(input.headers),
    endpoints: normalizeEndpoints(input.endpoints),
    writeEnabled: input.writeEnabled === true,
    skipApprovalForReads: input.skipApprovalForReads === true,
    createdAt: new Date().toISOString(),
  };
  const list = load();
  list.push(conn);
  save(list);
  return toPublic(conn);
}

export function updateConnector(id: string, patch: {
  label?: string; baseUrl?: string; description?: string;
  auth?: any; headers?: any; endpoints?: any; writeEnabled?: boolean; skipApprovalForReads?: boolean;
}): ConnectorPublic | null {
  const list = load();
  const c = list.find(x => x.id === id);
  if (!c) return null;
  if (patch.label !== undefined) c.label = String(patch.label).trim() || c.label;
  if (patch.baseUrl !== undefined) {
    const baseUrl = String(patch.baseUrl).trim();
    try { new URL(baseUrl); } catch { throw new Error(`baseUrl is not a valid URL: ${baseUrl}`); }
    c.baseUrl = baseUrl.replace(/\/+$/, "");
  }
  if (patch.description !== undefined) c.description = patch.description ? String(patch.description) : undefined;
  if (patch.auth !== undefined) {
    // Preserve existing secrets when the patch omits them (UI sends blanks to mean "unchanged").
    const next = normalizeAuth(patch.auth);
    for (const f of SECRET_AUTH_FIELDS) {
      if (!next[f] && c.auth?.[f]) next[f] = c.auth[f];
    }
    // oauth2 tokens travel as a pair with their expiry — editing tenant/
    // clientId/scope must not silently detach a still-valid token from its
    // expiresAt (that would force a needless refresh on every call).
    if (next.type === "oauth2" && next.accessToken && c.auth?.expiresAt) next.expiresAt = c.auth.expiresAt;
    c.auth = next;
  }
  if (patch.headers !== undefined) c.headers = normalizeHeaders(patch.headers);
  if (patch.endpoints !== undefined) c.endpoints = normalizeEndpoints(patch.endpoints);
  if (patch.writeEnabled !== undefined) c.writeEnabled = patch.writeEnabled === true;
  if (patch.skipApprovalForReads !== undefined) c.skipApprovalForReads = patch.skipApprovalForReads === true;
  save(list);
  return toPublic(c);
}

export function removeConnector(id: string): boolean {
  const list = load();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

export function setConnectorExpiry(id: string, expiresAt: string | null): ConnectorPublic | null {
  const list = load();
  const c = list.find(x => x.id === id);
  if (!c) return null;
  if (expiresAt) {
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) throw new Error("invalid expiresAt");
    (c as any).keyExpiresAt = d.toISOString();
  } else {
    delete (c as any).keyExpiresAt;
  }
  save(list);
  return toPublic(c);
}

export function setConnectorRoles(id: string, allowedRoles: string[]): ConnectorPublic | null {
  const valid = ["superadmin", "admin", "staff"];
  const roles = allowedRoles.map(r => r.toLowerCase()).filter(r => valid.includes(r));
  if (roles.length === 0) throw new Error("at least one role required");
  const list = load();
  const c = list.find(x => x.id === id);
  if (!c) return null;
  (c as any).allowedRoles = roles;
  save(list);
  return toPublic(c);
}

export function rotateConnectorSecrets(id: string, values: Record<string, string>): ConnectorPublic | null {
  const list = load();
  const c = list.find(x => x.id === id);
  if (!c) return null;
  let changed = false;
  for (const f of SECRET_AUTH_FIELDS) {
    const v = (values[f] ?? "").trim();
    if (!v) continue;
    (c.auth as any)[f] = v;
    changed = true;
  }
  if (!changed) throw new Error("no secret provided");
  (c as any).lastRotatedAt = new Date().toISOString();
  if (values.expiresAt) {
    const d = new Date(values.expiresAt);
    if (!Number.isNaN(d.getTime())) (c as any).keyExpiresAt = d.toISOString();
  }
  save(list);
  return toPublic(c);
}

function recordTest(id: string, result: { ok: boolean; detail: string }): void {
  const list = load();
  const c = list.find(x => x.id === id);
  if (!c) return;
  c.lastTest = { ...result, at: new Date().toISOString() };
  try { save(list); } catch { /* best-effort */ }
}

// ─── Calling a connector ───
type CallInput = {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  headers?: Record<string, string>;
};

export type CallResult = {
  ok: boolean;
  status: number;
  url: string;
  method: string;
  contentType?: string;
  body: unknown;       // parsed JSON when possible, else text (truncated)
  truncated?: boolean;
  warning?: string;    // set when the response is an HTML page, not usable data
  error?: string;
};

const MAX_BODY_CHARS = 20000;
const DEFAULT_TIMEOUT_MS = 30000;

function applyAuth(auth: ConnectorAuth, url: URL, headers: Record<string, string>): void {
  switch (auth.type) {
    case "bearer":
      if (auth.token) headers["authorization"] = `Bearer ${auth.token}`;
      break;
    case "basic":
      if (auth.username || auth.password)
        headers["authorization"] = `Basic ${Buffer.from(`${auth.username ?? ""}:${auth.password ?? ""}`).toString("base64")}`;
      break;
    case "apiKey":
      if (auth.value) {
        if (auth.in === "query") url.searchParams.set(auth.name ?? "api_key", auth.value);
        else headers[(auth.name ?? "X-API-Key")] = auth.value;
      }
      break;
    case "header":
      if (auth.name && auth.value) headers[auth.name] = auth.value;
      break;
    case "oauth2":
      if (auth.accessToken) headers["authorization"] = `Bearer ${auth.accessToken}`;
      break;
    case "none":
    default:
      break;
  }
}

// ─── OAuth2 device-code flow (Microsoft identity platform) ───
// Public clients (no client secret) use the device-code grant: the server asks
// Microsoft for a user_code + verification URL, the operator visits it in any
// browser and signs in, and the server polls the token endpoint until it
// either gets tokens or the flow expires/is declined. Works for Microsoft
// Graph APIs (Microsoft To Do, Outlook Calendar, ...) without a redirect URI,
// which this backend has no browser session to receive.
const MS_LOGIN_BASE = "https://login.microsoftonline.com";

type DeviceFlow = { connectorId: string; deviceCode: string; interval: number; expiresAt: number };
// In-memory only — a device-code flow lives a few minutes and is meaningless
// after a restart; no reason to persist it to disk.
const deviceFlows = new Map<string, DeviceFlow>();

export async function startOAuthDeviceFlow(connectorId: string): Promise<{
  flowId: string; userCode: string; verificationUri: string; message: string; expiresIn: number; interval: number;
}> {
  const conn = load().find(c => c.id === connectorId);
  if (!conn) throw new Error("connector not found");
  if (conn.auth.type !== "oauth2") throw new Error(`connector "${conn.label}" is not configured for OAuth2`);
  const clientId = (conn.auth.clientId ?? "").trim();
  if (!clientId) throw new Error("connector is missing an OAuth Client ID — set it in the connector's auth fields first");
  const tenant = (conn.auth.tenant ?? "common").trim();
  const scope = (conn.auth.scope ?? "offline_access").trim();

  const res = await fetch(`${MS_LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.device_code) {
    throw new Error(data?.error_description || data?.error || `device-code request failed (HTTP ${res.status})`);
  }

  const flowId = randomUUID();
  deviceFlows.set(flowId, {
    connectorId,
    deviceCode: data.device_code,
    interval: Number(data.interval ?? 5),
    expiresAt: Date.now() + Number(data.expires_in ?? 900) * 1000,
  });
  return {
    flowId,
    userCode: data.user_code,
    verificationUri: data.verification_uri ?? `${MS_LOGIN_BASE}/common/oauth2/deviceauth`,
    message: data.message ?? `Go to ${data.verification_uri} and enter code ${data.user_code}`,
    expiresIn: Number(data.expires_in ?? 900),
    interval: Number(data.interval ?? 5),
  };
}

export async function pollOAuthDeviceFlow(flowId: string): Promise<{
  status: "pending" | "complete" | "error" | "expired"; error?: string;
}> {
  const flow = deviceFlows.get(flowId);
  if (!flow) return { status: "error", error: "unknown or already-completed flow" };
  if (Date.now() > flow.expiresAt) { deviceFlows.delete(flowId); return { status: "expired" }; }

  const list = load();
  const conn = list.find(c => c.id === flow.connectorId);
  if (!conn) { deviceFlows.delete(flowId); return { status: "error", error: "connector no longer exists" }; }
  const clientId = (conn.auth.clientId ?? "").trim();
  const tenant = (conn.auth.tenant ?? "common").trim();

  const res = await fetch(`${MS_LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: flow.deviceCode,
    }),
  });
  const data: any = await res.json().catch(() => ({}));

  if (res.ok && data.access_token) {
    conn.auth.accessToken = data.access_token;
    if (data.refresh_token) conn.auth.refreshToken = data.refresh_token;
    conn.auth.expiresAt = Date.now() + Number(data.expires_in ?? 3600) * 1000;
    save(list);
    deviceFlows.delete(flowId);
    return { status: "complete" };
  }
  if (data.error === "authorization_pending") return { status: "pending" };
  if (data.error === "slow_down") { flow.interval += 5; return { status: "pending" }; }
  if (data.error === "expired_token") { deviceFlows.delete(flowId); return { status: "expired" }; }
  // authorization_declined or anything unrecognized — stop polling.
  deviceFlows.delete(flowId);
  return { status: "error", error: data.error_description || data.error || `token request failed (HTTP ${res.status})` };
}

// Refreshes an oauth2 connector's access token in place when it's within 60s
// of expiry (or already expired) and a refresh token is on hand. Best-effort:
// a failed refresh is swallowed here and surfaces naturally as a 401 from the
// downstream API call, which callConnector reports normally.
async function ensureFreshOAuthToken(conn: Connector): Promise<void> {
  if (conn.auth.type !== "oauth2" || !conn.auth.refreshToken) return;
  const skewMs = 60_000;
  if (conn.auth.expiresAt && conn.auth.expiresAt - skewMs > Date.now()) return;

  const clientId = (conn.auth.clientId ?? "").trim();
  const tenant = (conn.auth.tenant ?? "common").trim();
  const scope = (conn.auth.scope ?? "offline_access").trim();
  try {
    const res = await fetch(`${MS_LOGIN_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: conn.auth.refreshToken, scope }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) return;
    conn.auth.accessToken = data.access_token;
    if (data.refresh_token) conn.auth.refreshToken = data.refresh_token;
    conn.auth.expiresAt = Date.now() + Number(data.expires_in ?? 3600) * 1000;
    const list = load();
    const idx = list.findIndex(c => c.id === conn.id);
    if (idx >= 0) { list[idx] = conn; save(list); }
  } catch { /* best-effort — the call below will fail with a clear 401 if this didn't work */ }
}

// Produce a display-safe URL string with any credential material removed, so a
// secret (an apiKey passed in the query string, or userinfo) never leaks back
// into CallResult.url / lastTest.detail → job logs → chat.
function redactAuthFromUrl(u: URL, auth: ConnectorAuth): string {
  const c = new URL(u.toString());
  if (auth?.type === "apiKey" && auth.in === "query" && auth.name && c.searchParams.has(auth.name)) {
    c.searchParams.set(auth.name, "REDACTED");
  }
  c.username = "";
  c.password = "";
  return c.toString();
}

// Resolve a call's path against the connector baseUrl and HARD-FAIL if it
// escapes the configured origin (SSRF guard). Returns the safe URL.
function resolveUrl(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  // A relative path resolves under base; an absolute URL would override host —
  // we detect that and reject any host mismatch below.
  const target = new URL(path, base.href.endsWith("/") ? base.href : base.href + "/");
  if (target.host !== base.host || target.protocol !== base.protocol) {
    throw new Error(`path "${path}" resolves to ${target.origin}, which is outside the connector's base origin ${base.origin}`);
  }
  return target;
}

export async function callConnector(idOrLabel: string, input: CallInput): Promise<CallResult> {
  const conn = findConnector(idOrLabel);
  if (!conn) return { ok: false, status: 0, url: "", method: "", body: null, error: `connector "${idOrLabel}" not found` };

  const method = String(input.method ?? "GET").trim().toUpperCase();
  const isRead = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (!isRead && !conn.writeEnabled) {
    return { ok: false, status: 0, url: "", method, body: null,
      error: `connector "${conn.label}" is read-only — ${method} is blocked. Enable writes on the connector to allow it.` };
  }

  let url: URL;
  try { url = resolveUrl(conn.baseUrl, input.path ?? ""); }
  catch (e: any) { return { ok: false, status: 0, url: "", method, body: null, error: String(e?.message ?? e) }; }

  await ensureFreshOAuthToken(conn);

  if (input.query) for (const [k, v] of Object.entries(input.query)) url.searchParams.set(k, String(v));

  const headers: Record<string, string> = { accept: "application/json", ...(conn.headers ?? {}) };
  if (input.headers) for (const [k, v] of Object.entries(input.headers)) headers[k] = String(v);
  applyAuth(conn.auth, url, headers);

  let payload: string | undefined;
  if (!isRead && input.body !== undefined && input.body !== null) {
    if (typeof input.body === "string") {
      payload = input.body;
      headers["content-type"] = headers["content-type"] ?? "text/plain";
    } else {
      payload = JSON.stringify(input.body);
      headers["content-type"] = headers["content-type"] ?? "application/json";
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    // Follow redirects MANUALLY and confine every hop to the connector's own
    // origin. A connector is scoped to its baseUrl host (resolveUrl enforces
    // that for the initial path); with redirect:"follow" an open redirect on
    // the target could pivot the request to another host / internal service.
    const baseOrigin = new URL(conn.baseUrl);
    let target = url;
    let r = await fetch(target.toString(), { method, headers, body: payload, signal: ctrl.signal, redirect: "manual" });
    for (let hop = 0; r.status >= 300 && r.status < 400 && r.headers.get("location"); hop++) {
      if (hop >= 5) return { ok: false, status: r.status, url: target.toString(), method, body: null, error: "too many redirects" };
      let dest: URL;
      try { dest = new URL(r.headers.get("location")!, target); }
      catch { return { ok: false, status: r.status, url: target.toString(), method, body: null, error: "malformed redirect location" }; }
      if (dest.host !== baseOrigin.host || dest.protocol !== baseOrigin.protocol) {
        return { ok: false, status: r.status, url: target.toString(), method, body: null,
          error: `blocked redirect to ${dest.origin}, outside the connector's origin ${baseOrigin.origin}` };
      }
      target = dest;
      r = await fetch(target.toString(), { method, headers, body: payload, signal: ctrl.signal, redirect: "manual" });
    }
    url = target;
    const contentType = r.headers.get("content-type") ?? undefined;
    const raw = await r.text();
    const truncated = raw.length > MAX_BODY_CHARS;
    const slice = truncated ? raw.slice(0, MAX_BODY_CHARS) : raw;
    let parsed: unknown = slice;
    if (contentType?.includes("application/json")) {
      try { parsed = JSON.parse(slice); } catch { parsed = slice; }
    }
    // Connectors hit arbitrary operator-configured APIs (member lists,
    // payment records, ...) whose schema we don't know ahead of time — the
    // agent reads this body straight into its context, so scrub
    // sensitive-named fields (no entityType: an unknown schema means no
    // allowlist to lean on) before it ever gets there.
    if (parsed && typeof parsed === "object") parsed = maskSensitiveFields(parsed);
    // A 200 that returns an HTML PAGE (directory index, SPA shell, or a login
    // page) is not usable API data — but body:<html> + ok:true looks like a
    // success, so an agent would summarise the page as if it were the answer
    // (live 2026-07-28: Aiia Website /api/events returned an Apache index,
    // FinanceFlow /api/budgets returned a login page). Flag it so the agent /
    // operator knows the connector's base URL/path is wrong or the endpoint
    // needs auth, instead of trusting the markup.
    const looksHtml = (contentType?.includes("text/html") ?? false)
      || (typeof parsed === "string" && /^\s*<(!doctype html|html|\?xml)/i.test(parsed));
    const warning = looksHtml
      ? "endpoint returned an HTML page, not JSON/data — the connector's base URL or path is likely wrong, or the endpoint requires auth (login page). Do not treat this markup as the answer."
      : undefined;
    return {
      ok: r.ok, status: r.status, url: redactAuthFromUrl(url, conn.auth), method, contentType,
      body: parsed, truncated: truncated || undefined, warning,
      error: r.ok ? undefined : `HTTP ${r.status}`,
    };
  } catch (e: any) {
    // Node's fetch() wraps the real error in TypeError with e.cause — unwrap it
    // so users see "connect ETIMEDOUT" not just "fetch failed".
    const cause = e?.cause ? (typeof e.cause === "object" ? String(e.cause?.message ?? e.cause) : String(e.cause)) : undefined;
    const surface = cause ?? e?.message ?? String(e);
    const msg = e?.name === "AbortError"
      ? `request to ${url.host} timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`
      : surface;
    return { ok: false, status: 0, url: redactAuthFromUrl(url, conn.auth), method, body: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// Non-destructive reachability + auth probe. GETs the baseUrl root (or the
// first GET endpoint in the manifest) and reports the HTTP status. The detail
// includes the error message from callConnector which now unwraps the
// underlying network error (ETIMEDOUT, ECONNREFUSED, DNS failure, etc.).
export async function testConnector(id: string): Promise<{ ok: boolean; detail: string }> {
  const conn = findConnector(id);
  if (!conn) return { ok: false, detail: "connector not found" };
  const firstGet = conn.endpoints?.find(e => e.method === "GET");
  const probePath = firstGet?.path ?? "/";
  const r = await callConnector(id, { method: "GET", path: probePath });
  // Any response below 500 means the host is reachable and answered. 401/403
  // means reachable-but-auth-rejected — surfaced honestly so the operator can fix creds.
  const ok = r.status > 0 && r.status < 500;
  const detail = r.status === 0
    ? `${r.error ?? "unreachable"} — ${r.url || conn.baseUrl}`
    : r.status === 401 || r.status === 403
      ? `reachable but auth rejected (HTTP ${r.status}) — check credentials`
      : `reachable (HTTP ${r.status})`;
  recordTest(id, { ok, detail });
  return { ok, detail };
}

// ─── Templates ───
// One-click connector starting points the "Add connector" UI can offer —
// distinct from seeding (below): a template just prefills the add-connector
// form, it does NOT write anything until the operator confirms (and, for
// oauth2, completes the device-code sign-in). This keeps a fresh shell
// instance empty-state-clean while still making common integrations
// discoverable without hand-typing endpoint manifests.
export type ConnectorTemplate = {
  id: string; label: string; description: string;
  baseUrl: string; auth: any; writeEnabled: boolean; skipApprovalForReads?: boolean; endpoints: ConnectorEndpoint[];
};

const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {
    id: "microsoft-todo",
    label: "Microsoft To Do",
    description:
      "Task lists via Microsoft Graph. Requires a free Azure AD app registration (public client, no secret) — set its Application (client) ID below, then use \"Connect\" on the saved connector to sign in via device code.",
    baseUrl: "https://graph.microsoft.com/v1.0",
    auth: { type: "oauth2", tenant: "consumers", clientId: "", scope: "Tasks.ReadWrite offline_access" },
    writeEnabled: true,
    // Pre-checked: this is explicitly the operator's own personal task list —
    // "what's on my list" shouldn't need manual sign-off every time. Still
    // just a default; the operator can uncheck it in the form before saving.
    skipApprovalForReads: true,
    endpoints: [
      { name: "list-lists",  method: "GET",    path: "/me/todo/lists",                         description: "List all To Do task lists" },
      { name: "list-tasks",  method: "GET",    path: "/me/todo/lists/{listId}/tasks",          description: "List tasks in a list" },
      { name: "get-task",    method: "GET",    path: "/me/todo/lists/{listId}/tasks/{taskId}", description: "Get a single task" },
      { name: "create-task", method: "POST",   path: "/me/todo/lists/{listId}/tasks",          description: "Create a task", body: "{ title, dueDateTime?: { dateTime, timeZone }, reminderDateTime?: { dateTime, timeZone }, body? }" },
      { name: "update-task", method: "PATCH",  path: "/me/todo/lists/{listId}/tasks/{taskId}", description: "Update a task, e.g. mark done with { status: \"completed\" }", body: "{ status?, title?, dueDateTime?, reminderDateTime? }" },
      { name: "delete-task", method: "DELETE", path: "/me/todo/lists/{listId}/tasks/{taskId}", description: "Delete a task" },
      { name: "create-list", method: "POST",   path: "/me/todo/lists",                         description: "Create a new task list", body: "{ displayName }" },
    ],
  },
];

export function listConnectorTemplates(): ConnectorTemplate[] {
  return CONNECTOR_TEMPLATES;
}

// ─── Seeding ───

const Aiia_WEBSITE_LABEL = "Aiia Website";

export function seedAiiAWebsiteConnector(): ConnectorPublic | null {
  const existing = listConnectors().find(c => c.label === Aiia_WEBSITE_LABEL);
  if (existing) return null;

  return addConnector({
    label: Aiia_WEBSITE_LABEL,
    baseUrl: "https://www.aiinstituteafrica.com",
    description:
      "Aiia (Africa Institute of Artificial Intelligence) website CMS — events, articles, contact forms, program applications, payments, and admin management. Public endpoints are open; admin endpoints require a bearer token.",
    writeEnabled: true,
    endpoints: [
      // ── Public ──
      { name: "list-events",                method: "GET",  path: "/api/events",                          description: "List all public events" },
      { name: "list-articles",              method: "GET",  path: "/api/articles",                       description: "List all published articles" },
      { name: "list-local-articles",        method: "GET",  path: "/api/local-articles",                 description: "List local/Zimbabwe articles" },
      { name: "get-local-article",          method: "GET",  path: "/api/local-articles/{id}",            description: "Single local article by ID" },
      { name: "submit-contact",             method: "POST", path: "/api/contact",                        description: "Submit a general contact/enquiry form", body: "{ name, email, message }" },
      { name: "submit-conference-contact",  method: "POST", path: "/api/conference/contact",             description: "Conference-specific contact form", body: "{ name, email, phone?, organisation?, message }" },
      { name: "newsletter-signup",          method: "POST", path: "/api/newsletter",                     description: "Subscribe to newsletter", body: "{ email, name? }" },
      { name: "submit-student-lead",        method: "POST", path: "/api/student-leads",                  description: "Student lead/intent-to-enrol submission", body: "{ fullName, email, phone?, programme?, country? }" },
      { name: "submit-program-application", method: "POST", path: "/api/program-applications",           description: "Full program application", body: "{ programmeId, applicant: {...}, documents?: [...], referee?: {...} }" },
      { name: "submit-summit-registration", method: "POST", path: "/api/summit-applications",            description: "Summit/event registration", body: "{ eventId, attendee: {...}, ticketType?, dietaryRequirements? }" },
      { name: "initiate-payment",           method: "POST", path: "/api/payments",                       description: "Initiate a payment (e.g. application fee, ticket)", body: "{ amount, currency, reference, callbackUrl? }" },
      { name: "track-application",          method: "GET",  path: "/api/track/{referenceNumber}",        description: "Track an application by reference number" },
      { name: "verify-document",            method: "POST", path: "/api/verify-document",                description: "Submit a document for verification", body: "{ documentBase64, documentType, applicantId }" },
      { name: "get-referee-form",           method: "GET",  path: "/api/referee/{token}",                description: "Fetch referee form by unique token" },
      { name: "submit-referee-response",    method: "POST", path: "/api/referee/{token}",                description: "Submit referee assessment", body: "{ relationship, competence, comments }" },

      // ── Admin (authenticated — requires bearer token) ──
      { name: "admin-list-members",         method: "GET",  path: "/api/admin/members",                  description: "Admin: list all members" },
      { name: "admin-bulk-import-members",  method: "POST", path: "/api/admin/members/bulk",             description: "Admin: bulk import members", body: "{ members: [{...}] }" },
      { name: "admin-list-payments",        method: "GET",  path: "/api/admin/payments",                 description: "Admin: list all payments with filters" },
      { name: "admin-list-contacts",        method: "GET",  path: "/api/admin/contacts",                 description: "Admin: list contact form submissions" },
      { name: "admin-list-summit-regs",     method: "GET",  path: "/api/admin/summit-registrations",     description: "Admin: list summit registrations" },
      { name: "admin-dashboard-stats",      method: "GET",  path: "/api/admin/dashboard/stats",          description: "Admin: dashboard statistics" },
      { name: "admin-list-events",          method: "GET",  path: "/api/admin/events",                   description: "Admin: list all events (incl. drafts)" },
      { name: "admin-create-event",         method: "POST", path: "/api/admin/events",                   description: "Admin: create a new event", body: "{ title, date, description, type, ... }" },
      { name: "admin-update-event",         method: "PUT",  path: "/api/admin/events/{id}",             description: "Admin: update an event" },
      { name: "admin-delete-event",         method: "DELETE",path: "/api/admin/events/{id}",             description: "Admin: delete an event" },
      { name: "admin-list-articles",        method: "GET",  path: "/api/admin/articles",                 description: "Admin: list all articles (incl. drafts)" },
      { name: "admin-create-article",       method: "POST", path: "/api/admin/articles",                 description: "Admin: create a new article", body: "{ title, content, authorId, tags?, published? }" },
      { name: "admin-update-article",       method: "PUT",  path: "/api/admin/articles/{id}",           description: "Admin: update an article" },
      { name: "admin-delete-article",       method: "DELETE",path: "/api/admin/articles/{id}",           description: "Admin: delete an article" },
      { name: "admin-list-local-articles",  method: "GET",  path: "/api/admin/local-articles",           description: "Admin: list local articles" },
      { name: "admin-create-local-article", method: "POST", path: "/api/admin/local-articles",           description: "Admin: create local article" },
      { name: "admin-update-local-article", method: "PUT",  path: "/api/admin/local-articles/{id}",     description: "Admin: update local article" },
      { name: "admin-delete-local-article", method: "DELETE",path: "/api/admin/local-articles/{id}",     description: "Admin: delete local article" },
      { name: "admin-get-program-app",      method: "GET",  path: "/api/admin/program-applications/{id}",description: "Admin: get single program application" },
      { name: "admin-patch-program-app",    method: "PATCH",path: "/api/admin/program-applications/{id}", description: "Admin: update program application status", body: "{ status, notes? }" },
      { name: "admin-get-program-docs",     method: "GET",  path: "/api/admin/program-applications/{id}/documents", description: "Admin: get application documents" },
      { name: "admin-send-marketing-email", method: "POST", path: "/api/admin/marketing-email",          description: "Admin: send a marketing email campaign", body: "{ subject, bodyHtml, recipientFilter }" },
      { name: "admin-upload-event-image",   method: "POST", path: "/api/admin/event-image-upload",       description: "Admin: upload event image", body: "{ imageBase64, eventId }" },
      { name: "admin-upload-article-image", method: "POST", path: "/api/admin/article-image-upload",     description: "Admin: upload article image", body: "{ imageBase64, articleId }" },

      // ── Utility ──
      { name: "diag-env",                   method: "GET",  path: "/api/diag-env",                       description: "Server environment diagnostics" },
      { name: "chat",                       method: "GET",  path: "/api/chat",                           description: "AI chat endpoint", query: ["message", "sessionId?"] },
      { name: "news-feed",                  method: "GET",  path: "/api/news",                           description: "News feed" },
      { name: "membership-count",           method: "GET",  path: "/api/membership",                     description: "Current membership count" },
      { name: "vision-page",                method: "GET",  path: "/api/vision",                         description: "Vision/mission page data" },
    ],
  });
}

// ─── Free public-API backups (curated from github.com/public-apis/public-apis) ───
// A hand-picked set of high-value, KEYLESS, read-only public APIs registered so
// agents can call them the moment the server boots — no operator setup, no
// credentials. Curated for what actually moves the needle on this platform:
// live FX (finance/cost), economic indicators (Zimbabwe context + reports),
// weather, public holidays (scheduling), crypto prices, and encyclopaedic
// lookups. All are auth:"none" and writeEnabled:false — read-only backups the
// agent reaches for when a task needs external reference data. Seeded once
// (idempotent by label); the operator can edit/remove any of them afterwards.
type SeedConnectorSpec = {
  label: string; baseUrl: string; description: string; endpoints: ConnectorEndpoint[];
};

const PUBLIC_API_SEEDS: SeedConnectorSpec[] = [
  {
    label: "Frankfurter FX",
    baseUrl: "https://api.frankfurter.dev",
    description:
      "Free, keyless foreign-exchange rates published by the European Central Bank. Use for currency conversion (e.g. ZAR/USD for cost reporting and client billing) and historical rates. No API key.",
    endpoints: [
      { name: "latest",     method: "GET", path: "/v1/latest",       description: "Latest reference rates. Convert a specific pair with query base + symbols.", query: ["base", "symbols"] },
      { name: "historical", method: "GET", path: "/v1/{date}",        description: "Rates for a past date (YYYY-MM-DD).", query: ["base", "symbols"] },
      { name: "currencies", method: "GET", path: "/v1/currencies",    description: "Map of every supported currency code to its name." },
    ],
  },
  {
    label: "Open-Meteo Weather",
    baseUrl: "https://api.open-meteo.com",
    description:
      "Free, keyless weather forecast API (current conditions, hourly + daily forecasts) for any latitude/longitude worldwide. No API key.",
    endpoints: [
      { name: "forecast", method: "GET", path: "/v1/forecast", description: "Weather forecast for a coordinate. e.g. latitude=-17.83 longitude=31.05 current=temperature_2m (Harare).", query: ["latitude", "longitude", "current", "hourly", "daily", "timezone"] },
    ],
  },
  {
    label: "World Bank Data",
    baseUrl: "https://api.worldbank.org",
    description:
      "Free, keyless World Bank open data — economic and development indicators (GDP, inflation, population, etc.) by country. Useful for Zimbabwe/Africa market context and finance reports. Always pass format=json. No API key.",
    endpoints: [
      { name: "indicator",  method: "GET", path: "/v2/country/{iso2}/indicator/{indicatorCode}", description: "Indicator time series for a country, e.g. country ZW indicator NY.GDP.MKTP.CD (GDP US$). Pass format=json.", query: ["format", "date", "per_page"] },
      { name: "countries",  method: "GET", path: "/v2/country",                                   description: "List/lookup countries and regions. Pass format=json.", query: ["format", "per_page"] },
      { name: "indicators", method: "GET", path: "/v2/indicator",                                 description: "Search the indicator catalogue. Pass format=json.", query: ["format", "per_page"] },
    ],
  },
  {
    label: "Wikipedia",
    baseUrl: "https://en.wikipedia.org",
    description:
      "Free, keyless Wikipedia REST content API — article summaries and full HTML for encyclopaedic lookups and grounding. No API key.",
    endpoints: [
      { name: "summary", method: "GET", path: "/api/rest_v1/page/summary/{title}", description: "Short plain-text summary of a page, e.g. title=Zimbabwe." },
      { name: "html",    method: "GET", path: "/api/rest_v1/page/html/{title}",    description: "Full rendered HTML of a page." },
    ],
  },
  {
    label: "CoinGecko Crypto",
    baseUrl: "https://api.coingecko.com",
    description:
      "Free, keyless cryptocurrency market data — live prices, market caps, and coin metadata. Useful for treasury/finance tasks touching crypto. Public (rate-limited) tier, no API key.",
    endpoints: [
      { name: "simple-price", method: "GET", path: "/api/v3/simple/price", description: "Spot price of coins in fiat, e.g. ids=bitcoin,ethereum vs_currencies=usd,zar.", query: ["ids", "vs_currencies"] },
      { name: "coins-list",   method: "GET", path: "/api/v3/coins/list",   description: "Every supported coin id/symbol/name (large response)." },
      { name: "markets",      method: "GET", path: "/api/v3/coins/markets", description: "Ranked market data. e.g. vs_currency=usd per_page=10.", query: ["vs_currency", "order", "per_page", "page"] },
    ],
  },
  {
    label: "Public Holidays",
    baseUrl: "https://date.nager.at",
    description:
      "Free, keyless public-holiday calendar (Nager.Date) for 100+ countries. Useful for scheduling, planning campaigns, and avoiding holiday send dates. No API key.",
    endpoints: [
      { name: "holidays",      method: "GET", path: "/api/v3/PublicHolidays/{year}/{countryCode}", description: "Public holidays for a year + ISO country code, e.g. 2026/ZW (Zimbabwe)." },
      { name: "next-holidays", method: "GET", path: "/api/v3/NextPublicHolidays/{countryCode}",     description: "Upcoming holidays for a country over the next 365 days." },
      { name: "countries",     method: "GET", path: "/api/v3/AvailableCountries",                    description: "Countries the holiday API covers." },
    ],
  },
];

// Seed the keyless public-API backups. Idempotent: skips any whose label already
// exists (so operator edits/removals are never undone on restart). Returns the
// labels actually created this run.
export function seedPublicApiConnectors(): string[] {
  const existing = new Set(listConnectors().map(c => c.label.toLowerCase()));
  const created: string[] = [];
  for (const spec of PUBLIC_API_SEEDS) {
    if (existing.has(spec.label.toLowerCase())) continue;
    try {
      addConnector({
        label: spec.label,
        baseUrl: spec.baseUrl,
        description: spec.description,
        auth: { type: "none" },
        endpoints: spec.endpoints,
        writeEnabled: false,
      });
      created.push(spec.label);
    } catch { /* best-effort seed — a bad spec shouldn't block boot */ }
  }
  return created;
}
