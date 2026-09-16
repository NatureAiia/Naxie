// Integrations registry — the user connects external services (social,
// productivity, messaging, dev tools) so agents can act on them. Connections
// live at .neuroworks/integrations.json (per-machine, gitignored).
//
// Secrets (tokens, webhook URLs) are ENCRYPTED AT REST with AES-256-GCM. The
// key comes from NEUROWORKS_SECRET_KEY (hex/base64/passphrase) or, if unset, a
// generated key persisted at .neuroworks/.secret-key (also gitignored). So a
// leaked integrations.json is useless without the separate key.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { encryptSecret as encrypt, decryptSecret as decrypt } from "./secret-box.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const CONFIG_PATH = resolve(CONFIG_DIR, "integrations.json");

// ─── Provider catalog ───
// Each provider declares the fields needed to connect. `secret: true` fields are
// encrypted at rest and never returned to the UI. `auth: "oauth"` providers
// don't have a redirect flow yet — connect by pasting an access token for now.
export type ProviderField = { name: string; label: string; type: "text" | "password" | "url"; placeholder?: string; secret?: boolean; required?: boolean };
export type ProviderCategory = "messaging" | "social" | "productivity" | "dev";
export type Provider = {
  id: string;
  name: string;
  category: ProviderCategory;
  auth: "token" | "webhook" | "oauth";
  fields: ProviderField[];
  docsUrl?: string;
  note?: string;
  testable: boolean;
};

export const PROVIDERS: Provider[] = [
  // Messaging — agents reach you on your channels (token/webhook, no OAuth).
  { id: "slack", name: "Slack", category: "messaging", auth: "token", testable: true,
    fields: [
      { name: "botToken", label: "Bot Token (xoxb-…)", type: "password", secret: true, required: false, placeholder: "xoxb-..." },
      { name: "defaultChannel", label: "Default channel (for bot token)", type: "text", secret: false, required: false, placeholder: "#general or C0123ABCD" },
      { name: "webhookUrl", label: "Incoming Webhook URL (alternative to bot token)", type: "url", secret: true, required: false, placeholder: "https://hooks.slack.com/services/..." },
    ],
    docsUrl: "https://api.slack.com/web" },
  { id: "telegram", name: "Telegram", category: "messaging", auth: "token", testable: true,
    fields: [
      { name: "botToken", label: "Bot Token", type: "password", secret: true, required: true, placeholder: "123456:ABC-DEF..." },
      { name: "chatId", label: "Default Chat ID", type: "text", required: true, placeholder: "123456789" },
    ], docsUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot" },
  { id: "discord", name: "Discord", category: "messaging", auth: "webhook", testable: true,
    fields: [{ name: "webhookUrl", label: "Webhook URL", type: "url", secret: true, required: true, placeholder: "https://discord.com/api/webhooks/..." }],
    docsUrl: "https://support.discord.com/hc/en-us/articles/228383668" },
  { id: "msteams", name: "Microsoft Teams", category: "messaging", auth: "webhook", testable: true,
    fields: [{ name: "webhookUrl", label: "Incoming Webhook URL", type: "url", secret: true, required: true, placeholder: "https://outlook.office.com/webhook/..." }],
    note: "Add an 'Incoming Webhook' connector to a Teams channel and paste its URL.",
    docsUrl: "https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook" },
  // Dev / data tools.
  { id: "github", name: "GitHub", category: "dev", auth: "token", testable: true,
    fields: [{ name: "token", label: "Personal Access Token", type: "password", secret: true, required: true, placeholder: "ghp_..." }],
    docsUrl: "https://github.com/settings/tokens" },
  { id: "notion", name: "Notion", category: "dev", auth: "token", testable: true,
    fields: [{ name: "token", label: "Internal Integration Token", type: "password", secret: true, required: true, placeholder: "secret_... / ntn_..." }],
    docsUrl: "https://www.notion.so/my-integrations" },

  // Social.
  { id: "twitter", name: "X / Twitter", category: "social", auth: "token", testable: false,
    fields: [{ name: "bearerToken", label: "Bearer Token", type: "password", secret: true, required: true }],
    docsUrl: "https://developer.x.com/en/portal/dashboard" },
  { id: "linkedin", name: "LinkedIn", category: "social", auth: "token", testable: true,
    fields: [{ name: "accessToken", label: "Access Token", type: "password", secret: true, required: true }],
    docsUrl: "https://www.linkedin.com/developers/apps" },
  // ── Extended social / scheduling / publishing platforms (2026-07-27) ──
  // Publishing to most of these flows through the Ayrshare bridge (social.post);
  // these catalog entries make each individually connectable + discoverable via
  // integration.list. testable:false — no per-provider health check yet, so the
  // UI won't show a Test button that isn't wired.
  { id: "buffer", name: "Buffer", category: "social", auth: "token", testable: true,
    fields: [{ name: "accessToken", label: "Access Token", type: "password", secret: true, required: true, placeholder: "1/xxxxxxxx…" }],
    note: "Social scheduler — queues posts across your connected Buffer channels. Paste an access token from a Buffer developer app.",
    docsUrl: "https://buffer.com/developers/api" },
  { id: "ayrshare", name: "Ayrshare (multi-social)", category: "social", auth: "token", testable: false,
    fields: [{ name: "apiKey", label: "API Key", type: "password", secret: true, required: true }],
    note: "One key fans social.post out to X, LinkedIn, Facebook, Instagram, TikTok, etc. Can also be set via the AYRSHARE_API_KEY env var.",
    docsUrl: "https://www.ayrshare.com/docs" },
  { id: "facebook", name: "Facebook (Pages)", category: "social", auth: "token", testable: false,
    fields: [
      { name: "pageAccessToken", label: "Page Access Token", type: "password", secret: true, required: true },
      { name: "pageId", label: "Page ID", type: "text", required: true },
    ], docsUrl: "https://developers.facebook.com/docs/pages-api" },
  { id: "instagram", name: "Instagram (Business)", category: "social", auth: "token", testable: false,
    fields: [
      { name: "accessToken", label: "Access Token", type: "password", secret: true, required: true },
      { name: "igUserId", label: "IG Business User ID", type: "text", required: true },
    ], docsUrl: "https://developers.facebook.com/docs/instagram-api" },
  { id: "tiktok", name: "TikTok", category: "social", auth: "oauth", testable: false,
    fields: [{ name: "accessToken", label: "Access Token", type: "password", secret: true, required: true }],
    docsUrl: "https://developers.tiktok.com/doc/content-posting-api-get-started" },
  { id: "youtube", name: "YouTube", category: "social", auth: "oauth", testable: false,
    fields: [{ name: "accessToken", label: "OAuth Access Token (youtube.upload scope)", type: "password", secret: true, required: true }],
    docsUrl: "https://developers.google.com/youtube/v3" },
  { id: "pinterest", name: "Pinterest", category: "social", auth: "token", testable: false,
    fields: [{ name: "accessToken", label: "Access Token", type: "password", secret: true, required: true }],
    docsUrl: "https://developers.pinterest.com/docs/api/v5/" },
  { id: "whatsapp", name: "WhatsApp Business", category: "messaging", auth: "token", testable: false,
    fields: [
      { name: "phoneNumberId", label: "Phone Number ID", type: "text", required: true },
      { name: "accessToken", label: "Access Token", type: "password", secret: true, required: true },
    ], docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api" },
  // Productivity / CRM / ops — token-auth SaaS the agent can read & act on.
  { id: "mailjet", name: "Mailjet", category: "productivity", auth: "token", testable: true,
    fields: [
      { name: "apiKey", label: "API Key", type: "password", secret: true, required: true },
      { name: "secretKey", label: "Secret Key", type: "password", secret: true, required: true },
    ], docsUrl: "https://app.mailjet.com/account/apikeys" },

  // Productivity — OAuth providers; paste an access token for now (full OAuth flow is future).
  { id: "google", name: "Google (Gmail/Calendar/Drive)", category: "productivity", auth: "oauth", testable: true,
    fields: [{ name: "accessToken", label: "OAuth Access Token", type: "password", secret: true, required: true }],
    note: "OAuth redirect flow coming soon — paste an access token to use now.",
    docsUrl: "https://developers.google.com/oauthplayground" },
  { id: "microsoft365", name: "Microsoft 365", category: "productivity", auth: "oauth", testable: true,
    fields: [{ name: "accessToken", label: "OAuth Access Token", type: "password", secret: true, required: true }],
    note: "OAuth redirect flow coming soon — paste an access token to use now.",
    docsUrl: "https://learn.microsoft.com/en-us/graph/auth/" },
];

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find(p => p.id === id);
}

// Secrets are encrypted at rest via the shared AES-256-GCM box (see secret-box.ts).

// ─── Registry ───
// Persisted health signal — the result of the most recent test run for a
// connection. Lets the UI show a green/red dot ("connected AND working") at a
// glance instead of only "connected", and survives restarts.
export type ConnectionTest = { ok: boolean; detail: string; at: string };

type StoredConnection = {
  id: string;
  providerId: string;
  label: string;
  // secret field values are stored as encrypted blobs; non-secret as plaintext.
  secrets: Record<string, string>;   // encrypted
  config: Record<string, string>;    // non-secret fields
  createdAt: string;
  lastTest?: ConnectionTest;
  expiresAt?: string; // ISO — when the current key/credential expires (operator-set)
  lastRotatedAt?: string; // ISO — when secret was last rotated
  allowedRoles?: string[]; // which access layers may use it (default superadmin-only)
};

export type ConnectionPublic = {
  id: string;
  providerId: string;
  providerName: string;
  category: ProviderCategory;
  label: string;
  config: Record<string, string>;
  secretFields: string[];   // names of the secrets we hold (values never sent)
  createdAt: string;
  lastTest?: ConnectionTest;   // health signal from the most recent test
  expiresAt?: string;
  lastRotatedAt?: string;
  allowedRoles?: string[];
  daysUntilExpiry?: number;
  expiryState?: "ok" | "soon" | "expired" | "unset";
};

function load(): StoredConnection[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed as StoredConnection[] : [];
  } catch { return []; }
}
function save(list: StoredConnection[]): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(list, null, 2), "utf8");
}

function expiryStateFor(expiresAt?: string): { daysUntilExpiry?: number; expiryState: "ok" | "soon" | "expired" | "unset" } {
  if (!expiresAt) return { expiryState: "unset" };
  const ms = new Date(expiresAt).getTime() - Date.now();
  const days = Math.ceil(ms / (24 * 3600 * 1000));
  if (days < 0) return { daysUntilExpiry: days, expiryState: "expired" };
  if (days <= 7) return { daysUntilExpiry: days, expiryState: "soon" };
  return { daysUntilExpiry: days, expiryState: "ok" };
}

function toPublic(c: StoredConnection): ConnectionPublic {
  const p = getProvider(c.providerId);
  const exp = expiryStateFor(c.expiresAt);
  return {
    id: c.id,
    providerId: c.providerId,
    providerName: p?.name ?? c.providerId,
    category: p?.category ?? "dev",
    label: c.label,
    config: c.config,
    secretFields: Object.keys(c.secrets),
    createdAt: c.createdAt,
    lastTest: c.lastTest,
    expiresAt: c.expiresAt,
    lastRotatedAt: c.lastRotatedAt,
    allowedRoles: c.allowedRoles,
    daysUntilExpiry: exp.daysUntilExpiry,
    expiryState: exp.expiryState,
  };
}

// Persist the most recent test verdict on a connection so the UI can show a
// durable health signal. Best-effort — a write failure doesn't fail the test.
export function recordTestResult(id: string, result: { ok: boolean; detail: string }): void {
  recordTestResults([{ id, ...result }]);
}

// Batched persist — one load + one save for many results. Used by test-all so
// concurrent per-connection writes can't race and drop each other's updates.
function recordTestResults(results: { id: string; ok: boolean; detail: string }[]): void {
  if (results.length === 0) return;
  const list = load();
  const at = new Date().toISOString();
  let changed = false;
  for (const r of results) {
    const c = list.find(x => x.id === r.id);
    if (!c) continue;
    c.lastTest = { ok: r.ok, detail: r.detail, at };
    changed = true;
  }
  if (changed) save(list);
}

export function listConnections(): ConnectionPublic[] {
  return load().map(toPublic);
}

export function addConnection(providerId: string, label: string, values: Record<string, string>): ConnectionPublic {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`unknown provider "${providerId}"`);
  const secrets: Record<string, string> = {};
  const config: Record<string, string> = {};
  for (const f of provider.fields) {
    const v = (values[f.name] ?? "").trim();
    if (f.required && !v) throw new Error(`missing required field "${f.label}"`);
    if (!v) continue;
    if (f.secret) secrets[f.name] = encrypt(v);
    else config[f.name] = v;
  }
  const conn: StoredConnection = {
    id: randomUUID(), providerId, label: label.trim() || provider.name,
    secrets, config, createdAt: new Date().toISOString(),
  };
  const list = load();
  list.push(conn);
  save(list);
  return toPublic(conn);
}

export function removeConnection(id: string): boolean {
  const list = load();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

export function setConnectionExpiry(id: string, expiresAt: string | null): ConnectionPublic | null {
  const list = load();
  const c = list.find(x => x.id === id);
  if (!c) return null;
  if (expiresAt) {
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) throw new Error("invalid expiresAt — must be ISO date");
    c.expiresAt = d.toISOString();
  } else {
    delete c.expiresAt;
  }
  save(list);
  return toPublic(c);
}

export function setConnectionRoles(id: string, allowedRoles: string[]): ConnectionPublic | null {
  const valid = ["superadmin", "admin", "staff"];
  const roles = allowedRoles.map(r => r.toLowerCase()).filter(r => valid.includes(r));
  if (roles.length === 0) throw new Error("at least one role required");
  const list = load();
  const c = list.find(x => x.id === id);
  if (!c) return null;
  c.allowedRoles = roles;
  save(list);
  return toPublic(c);
}

export function rotateConnectionSecrets(id: string, values: Record<string, string>): ConnectionPublic | null {
  const list = load();
  const c = list.find(x => x.id === id);
  if (!c) return null;
  const provider = getProvider(c.providerId);
  if (!provider) throw new Error("unknown provider");
  for (const f of provider.fields) {
    if (!f.secret) continue;
    const v = (values[f.name] ?? "").trim();
    if (!v) continue; // blank = keep existing
    c.secrets[f.name] = encrypt(v);
  }
  c.lastRotatedAt = new Date().toISOString();
  // optional expiresAt in values
  if (values.expiresAt) {
    const d = new Date(values.expiresAt);
    if (!Number.isNaN(d.getTime())) c.expiresAt = d.toISOString();
  }
  save(list);
  return toPublic(c);
}

// Decrypted access for primitives/test only — never exposed via the API as-is.
export function getConnectionSecrets(id: string): { provider: Provider; config: Record<string, string>; secrets: Record<string, string> } | null {
  const c = load().find(x => x.id === id);
  if (!c) return null;
  const provider = getProvider(c.providerId);
  if (!provider) return null;
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.secrets)) {
    try { secrets[k] = decrypt(v); } catch { /* skip unreadable (wrong key) */ }
  }
  return { provider, config: c.config, secrets };
}

// Find the first connection for a provider (used by primitives like slack.post).
export function getConnectionByProvider(providerId: string): { id: string; config: Record<string, string>; secrets: Record<string, string> } | null {
  const c = load().find(x => x.providerId === providerId);
  if (!c) return null;
  const full = getConnectionSecrets(c.id);
  return full ? { id: c.id, config: full.config, secrets: full.secrets } : null;
}

// ─── Test a connection (non-destructive auth check where possible) ───
// Public entry: runs the test, then PERSISTS the verdict on the connection so
// the UI shows a durable "connected & working" (or failing) signal.
export async function testConnection(id: string): Promise<{ ok: boolean; detail: string }> {
  const result = await runConnectionTest(id);
  if (result.detail !== "connection not found") recordTestResult(id, result);
  return result;
}

// Test every connection in parallel, then persist all verdicts in ONE batched
// save (avoids the read-modify-write race of per-test saves running together).
export async function testAllConnections(): Promise<{ id: string; ok: boolean; detail: string }[]> {
  const ids = load().map(c => c.id);
  const results = await Promise.all(ids.map(async id => ({ id, ...(await runConnectionTest(id)) })));
  recordTestResults(results.filter(r => r.detail !== "connection not found"));
  return results;
}

async function runConnectionTest(id: string): Promise<{ ok: boolean; detail: string }> {
  const full = getConnectionSecrets(id);
  if (!full) return { ok: false, detail: "connection not found" };
  const { provider, config, secrets } = full;
  try {
    switch (provider.id) {
      case "telegram": {
        const raw = secrets.botToken ?? "";
        const token = raw.replace(/\s+/g, ""); // strip copy-paste whitespace/newlines
        // Only pre-reject a value that CLEARLY isn't a BotFather token; anything
        // shaped like <digits>:<hash> goes to getMe, the real authority — so a
        // valid token is never false-rejected on a strict length heuristic
        // (that over-strict check was the bug). The reason is shape-aware (no
        // secret leaked) so the user knows exactly what to fix.
        if (!/^\d{3,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
          const idPart = token.split(":")[0] ?? "";
          const hashPart = token.includes(":") ? token.slice(token.indexOf(":") + 1) : "";
          const why = !token ? "it's empty"
            : !token.includes(":") ? `no ':' separator — looks like the bot @username/handle, not the token`
            : !/^\d+$/.test(idPart) ? `the part before ':' isn't a numeric bot id`
            : hashPart.length < 20 ? `the secret after ':' is too short (${hashPart.length} chars; a real one is ~35)`
            : `it contains unexpected characters`;
          return { ok: false, detail: `bot token malformed — ${why}. Expected '<digits>:<hash>' from @BotFather.` };
        }
        // Retry getMe on a transient network blip (undici "fetch failed") so a
        // momentary hiccup doesn't show a false failure for a valid token.
        let j: any = {};
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
            j = await r.json().catch(() => ({}));
            break;
          } catch (e: any) {
            if (attempt === 2) return { ok: false, detail: `network error reaching Telegram (${String(e?.message ?? e).slice(0, 80)}) — check connectivity, then re-test` };
            await new Promise(res => setTimeout(res, 1500));
          }
        }
        if (!j?.ok) return { ok: false, detail: `${j?.description ?? "getMe failed"} — verify the bot token from @BotFather` };
        // Token is valid — now validate the DEFAULT chat id if one is set, since
        // an unreachable chat (or a bot-username pasted as the chat id) is the
        // other common misconfig and the send would fail at runtime otherwise.
        const chatId = (config.chatId ?? "").trim();
        if (chatId) {
          if (/bot$/i.test(chatId) && !/^-?\d+$/.test(chatId) && !chatId.startsWith("@")) {
            return { ok: false, detail: `bot @${j.result?.username} is valid, but the chat id "${chatId}" looks like a BOT username, not a chat. Use a numeric chat id (DM the bot, then read it from getUpdates) or @channelusername.` };
          }
          const cr = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
          const cj: any = await cr.json().catch(() => ({}));
          if (!cj?.ok) return { ok: false, detail: `bot @${j.result?.username} is valid, but chat "${chatId}" is unreachable: ${cj?.description ?? `HTTP ${cr.status}`}. The bot must be a member/admin of that chat (or the user must /start it first).` };
          return { ok: true, detail: `bot @${j.result?.username} → chat "${cj.result?.title ?? cj.result?.username ?? chatId}"` };
        }
        return { ok: true, detail: `bot @${j.result?.username} (no default chat id set — pass chatId when sending)` };
      }
      case "discord": {
        const r = await fetch(secrets.webhookUrl);
        if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
        const j: any = await r.json();
        return { ok: true, detail: `webhook "${j?.name ?? "ok"}"` };
      }
      case "slack": {
        // Prefer the Web API bot token (auth.test) — non-destructive and works
        // for chat.postMessage. Fall back to the Incoming Webhook if that's all
        // that's configured (a webhook can't be tested without posting).
        if (secrets.botToken) {
          const r = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${secrets.botToken}` } });
          const j: any = await r.json().catch(() => ({}));
          return j?.ok ? { ok: true, detail: `bot @${j.user ?? "?"} in ${j.team ?? "workspace"}` } : { ok: false, detail: j?.error ?? `HTTP ${r.status}` };
        }
        if (secrets.webhookUrl) {
          const r = await fetch(secrets.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "✅ Neuro connected to this channel." }) });
          return r.ok ? { ok: true, detail: "test message sent" } : { ok: false, detail: `HTTP ${r.status}: ${(await r.text()).slice(0, 120)}` };
        }
        return { ok: false, detail: "no bot token or webhook configured" };
      }
      case "msteams": {
        const r = await fetch(secrets.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "✅ Neuro connected to this Teams channel." }) });
        return r.ok ? { ok: true, detail: "test message sent" } : { ok: false, detail: `HTTP ${r.status}: ${(await r.text()).slice(0, 120)}` };
      }
      case "github": {
        const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${secrets.token}`, "user-agent": "clawbot" } });
        const j: any = await r.json();
        return r.ok ? { ok: true, detail: `@${j?.login}` } : { ok: false, detail: j?.message ?? `HTTP ${r.status}` };
      }
      case "buffer": {
        // Buffer's "Public API" token uses the NEW GraphQL API at
        // api.buffer.com (the classic api.bufferapp.com REST API rejects it).
        // Validate via the account query, then report connected channels.
        const token = (secrets.accessToken ?? "").trim();
        if (!token) return { ok: false, detail: "no access token — paste your Buffer access token" };
        const { bufferAccountEmail, bufferChannels } = await import("./buffer.js");
        const email = await bufferAccountEmail(token);
        if (!email) return { ok: false, detail: "token not accepted by api.buffer.com — check the Buffer Public API access token" };
        const channels = await bufferChannels(token);
        const svc = channels.map(c => c.service).join(", ");
        return { ok: true, detail: `Buffer connected (${email})${channels.length ? ` — ${channels.length} channel${channels.length === 1 ? "" : "s"}: ${svc}` : " — no channels connected yet"}` };
      }
      case "notion": {
        const r = await fetch("https://api.notion.com/v1/users/me", { headers: { authorization: `Bearer ${secrets.token}`, "Notion-Version": "2022-06-28" } });
        const j: any = await r.json();
        return r.ok ? { ok: true, detail: j?.name ?? j?.bot?.owner?.type ?? "ok" } : { ok: false, detail: j?.message ?? `HTTP ${r.status}` };
      }
      case "linkedin": {
        const r = await fetch("https://api.linkedin.com/v2/me", { headers: { authorization: `Bearer ${secrets.accessToken}` } });
        return r.ok ? { ok: true, detail: "token valid" } : { ok: false, detail: `HTTP ${r.status}` };
      }
      case "mailjet": {
        const auth = Buffer.from(`${secrets.apiKey}:${secrets.secretKey}`).toString("base64");
        const r = await fetch("https://api.mailjet.com/v3/REST/apikey", { headers: { authorization: `Basic ${auth}` } });
        const j: any = await r.json().catch(() => ({}));
        return r.ok ? { ok: true, detail: "token valid" } : { ok: false, detail: j?.ErrorMessage ?? `HTTP ${r.status}` };
      }
      case "google": {
        const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { authorization: `Bearer ${secrets.accessToken}` } });
        const j: any = await r.json();
        return r.ok ? { ok: true, detail: j?.email ?? "token valid" } : { ok: false, detail: j?.error_description ?? `HTTP ${r.status}` };
      }
      case "microsoft365": {
        const r = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { authorization: `Bearer ${secrets.accessToken}` } });
        const j: any = await r.json();
        return r.ok ? { ok: true, detail: j?.userPrincipalName ?? "token valid" } : { ok: false, detail: j?.error?.message ?? `HTTP ${r.status}` };
      }
      default:
        return { ok: false, detail: "no test available for this provider" };
    }
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
}
