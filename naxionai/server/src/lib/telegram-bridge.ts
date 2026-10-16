// Telegram bridge — lets a user (or a group) talk to Naxie over Telegram.
//
// Inbound:  long-poll getUpdates for new messages (no public webhook/URL
//           needed — mirrors the IMAP email bridge), route each allowed message
//           to the SAME /api/chat endpoint the web UI uses, then reply in the
//           originating chat. Because we go through /api/chat, every Telegram
//           request shows up as a real session and lands in Reports + the vault
//           exactly like a UI request.
// Outbound: sendMessage via the same bot token (also used by the telegram.send
//           primitive).
//
// SECURITY — inbound is an external trust boundary. We ONLY act on messages from
// chats on the allow-list (NAXION_TELEGRAM_ALLOWED_CHATS, union the
// integration's default chat id). Empty allow-list ⇒ inbound DISABLED (outbound
// still works). Fail-safe: an open bridge would let anyone who finds the bot
// drive jobs against the user's machine and vault.
//
// In GROUPS the bot only acts when @mentioned or replied-to (so it isn't a
// firehose), and the mention is stripped before the text reaches the agent.
//
// Config (env):
//   NAXION_TELEGRAM_INBOUND=0        hard-disable inbound (default on)
//   NAXION_TELEGRAM_ALLOWED_CHATS    comma list of chat ids allowed to drive
//   NAXION_TELEGRAM_POLL_TIMEOUT_S   long-poll seconds (default 25)
// Bot token comes from the Telegram integration connection (Integrations page).

import { config } from "../config.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { presentApproval, handleApprovalReply } from "./action-approvals.js";
import { isOffline } from "./offline-mode.js";

const BASE = `http://127.0.0.1:${config.port}`;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Single-poller lock ──
// Telegram getUpdates allows only ONE long-poll consumer per bot; a second
// poller 409-conflicts and the two steal each other's updates. `role` defaults
// to "primary" (config.ts), so a worker spawned without NAXION_ROLE would
// otherwise start a SECOND bridge. This lock guarantees exactly one poller
// across all local processes: a heartbeat'd lock file whose owner is a live PID.
const STATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.naxion");
const LOCK_FILE = resolve(STATE_DIR, "telegram-poller.lock");
const LOCK_TTL_MS = 90_000;
let ownLock = false;
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function tryAcquireLock(): boolean {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    if (existsSync(LOCK_FILE)) {
      const j = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
      const fresh = Date.now() - (Number(j.at) || 0) < LOCK_TTL_MS;
      if (fresh && j.pid !== process.pid && pidAlive(Number(j.pid))) return false; // a live poller owns it
    }
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
    ownLock = true;
    return true;
  } catch { return true; } // if the FS check itself fails, don't block the bridge
}
function refreshLock(): void {
  if (ownLock) { try { writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { /* tolerate */ } }
}
function releaseLock(): void {
  if (ownLock) {
    try { const j = JSON.parse(readFileSync(LOCK_FILE, "utf8")); if (j.pid === process.pid) rmSync(LOCK_FILE, { force: true }); } catch { /* tolerate */ }
    ownLock = false;
  }
}

type BridgeState = {
  running: boolean;
  botUsername?: string;
  startedAt?: string;
  lastError?: string;
  processed: number;
  skippedUnauthorized: number;
};
const state: BridgeState = { running: false, processed: 0, skippedUnauthorized: 0 };
let abort = false;

export function getTelegramBridgeStatus(): BridgeState {
  return { ...state };
}

function stripToken(t: string | undefined): string {
  return (t ?? "").replace(/\s+/g, "");
}

// Bot token from the Telegram integration connection (single source of truth,
// shared with telegram.send). No token ⇒ bridge can't run.
async function getBotToken(): Promise<string> {
  try {
    const { getConnectionByProvider } = await import("./integrations.js");
    const conn = getConnectionByProvider("telegram");
    return stripToken(conn?.secrets?.botToken);
  } catch { return ""; }
}

// Routing policy (operator request: "all system messages go to telegram bot,
// news go to group"):
//   - SYSTEM messages (reflections, briefs, approvals, notify.ts attention/
//     urgent, generic schedules, email triage…): DM with the bot —
//     NAXION_TELEGRAM_NOTIFY_CHAT, then the integration's default chat.
//   - NEWS (africa-ai-news / world-ai-news cards, telegram-news-monitor
//     scored alerts): the group — NAXION_TELEGRAM_GROUP_CHAT, passed
//     explicitly by the news callers.
// Shared outbound send — the ONE place that calls Telegram's sendMessage API.
// Used by the telegram.send agent tool (primitives.ts) AND by background
// schedulers (reflection.ts, innovation-scan.ts, todo-brief.ts) that push a finished
// report to the operator's default chat without going through the agent
// loop. Defaults to the operator DM (system); pass chatId to override
// (news callers pass the group).
//
// All Naxie texts must look nice: markdown is auto-converted to rich Telegram HTML
// (bold, italic, code, links, headings → bold) with chunking + plain-text fallback
// so no report lands as raw `**` / `##` noise.
// Inline keyboards: pass `keyboard` as Telegram inline_keyboard array for one-tap actions.
export function resolveSystemChatId(connChatId?: string): string {
  return String(
    process.env.NAXION_TELEGRAM_NOTIFY_CHAT ??
    connChatId ??
    process.env.NAXION_TELEGRAM_GROUP_CHAT ??
    "",
  ).trim();
}
export function resolveNewsChatId(connChatId?: string): string {
  return String(
    process.env.NAXION_TELEGRAM_GROUP_CHAT ??
    process.env.NAXION_TELEGRAM_NOTIFY_CHAT ??
    connChatId ??
    "",
  ).trim();
}
export async function sendTelegramMessage(text: string, chatId?: string, keyboard?: any[][]): Promise<{ ok: boolean; error?: string; messageId?: number }> {
  const { getConnectionByProvider } = await import("./integrations.js");
  const conn = getConnectionByProvider("telegram");
  if (!conn?.secrets?.botToken) return { ok: false, error: "no Telegram connection — add one on the Integrations page" };
  const botToken = stripToken(conn.secrets.botToken);
  // Explicit call targets win (replies/approvals/news-to-group). Otherwise,
  // system broadcasts go to the operator DM (NOT the group).
  const chat = String(chatId ?? resolveSystemChatId(conn.config?.chatId)).trim();
  if (!chat) return { ok: false, error: "no chatId (set a default on the Integrations page or pass chatId)" };
  if (/bot$/i.test(chat) && !/^-?\d+$/.test(chat) && !chat.startsWith("@")) {
    return { ok: false, error: `chatId "${chat}" looks like a bot username, not a chat — a bot can't message itself. Use a numeric chat id (DM the bot, then read it from getUpdates) or @channelusername.` };
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "text is required" };
  // Try rich HTML first (nice headings/bold/links), chunked at ~3800 to leave room for HTML tags
  const html = markdownToTelegramHtml(trimmed);
  const plainChunks: string[] = [];
  const htmlChunks: string[] = [];
  for (let i = 0; i < trimmed.length; i += 3800) plainChunks.push(trimmed.slice(i, i + 3800));
  for (let i = 0; i < html.length; i += 3800) htmlChunks.push(html.slice(i, i + 3800));
  // Send each chunk; on HTML parse failure fall back to plain for that chunk
  // Only attach inline keyboard to the last chunk (where it makes sense)
  let lastId: number | undefined;
  for (let i = 0; i < htmlChunks.length; i++) {
    const isLast = i === htmlChunks.length - 1;
    const extra: any = isLast && keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
    try {
      const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text: htmlChunks[i].slice(0, 4096), parse_mode: "HTML", ...extra }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (j?.ok) { lastId = j.result?.message_id; continue; }
      if (j?.description && /parse|can't parse|wrong string/i.test(String(j.description))) {
        const rf = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text: plainChunks[i].slice(0, 4096), ...(isLast && keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}) }),
        });
        const jf: any = await rf.json().catch(() => ({}));
        if (jf?.ok) { lastId = jf.result?.message_id; continue; }
        return { ok: false, error: `telegram: ${jf?.description ?? `HTTP ${rf.status}`}` };
      }
      return { ok: false, error: `telegram: ${j?.description ?? `HTTP ${r.status}`}` };
    } catch (e: any) {
      return { ok: false, error: `telegram send failed: ${e?.message ?? e}` };
    }
  }
  return { ok: true, messageId: lastId };
}

// ── Voice notes (read-aloud delivery) ─────────────────────────────────────
// Turn a markdown report into speakable plain text: headings/bold/links
// become words, code and URLs are dropped, whitespace collapses. Pure.
export function markdownToSpeech(md: string, maxChars = 3500): string {
  const s = String(md ?? "")
    .replace(/```[\s\S]*?```/g, " ")          // fenced code → gone
    .replace(/`([^`]*)`/g, "$1")              // inline code → words
    .replace(/!\[([^\]]*)\]\((.*?)\)/g, "$1") // images → alt text
    .replace(/\[([^\]]*)\]\((.*?)\)/g, "$1")  // links → text
    .replace(/^#{1,6}\s+/gm, "")             // headings → plain
    .replace(/[*_~]{1,3}/g, "")              // bold/italic/strike
    .replace(/^>\s?/gm, "")                  // quotes
    .replace(/^[-*+]\s+/gm, "")              // bullets
    .replace(/^\d+[.)]\s+/gm, "")            // numbered lists
    .replace(/https?:\S+/g, "")              // bare URLs are unpronounceable
    .replace(/[|]/g, " ")                    // tables
    .replace(/\s+/g, " ")
    .trim()
    // TTS punctuation policy: the voice may only speak comma and full-stop
    // pauses — every other mark (! ? : ; " ' - ( ) …) is unpronounceable or
    // read aloud literally. Dashes/colons/semicolons become comma pauses
    // first so phrasing survives, hyphens become spaces (read-aloud →
    // read aloud, not readaloud), then everything except , and . is stripped.
    .replace(/…/g, ".")
    .replace(/\s*[—–:;]\s*/g, ", ")
    .replace(/[-‐‑]/g, " ")
    .replace(/[^\p{L}\p{N}\s,.]/gu, "")
    .replace(/\s+([,.])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > maxChars ? s.slice(0, maxChars).trimEnd() + "." : s;
}

// Send an audio file (mp3/wav) as a Telegram audio message. Multipart upload
// (the JSON tg() helper can't carry bytes). Best-effort: returns {ok} and
// never throws past a normal result — callers decide whether audio matters.
export async function sendTelegramAudio(
  audio: Buffer,
  opts: { chatId?: string; title?: string; performer?: string; caption?: string; filename?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { getConnectionByProvider } = await import("./integrations.js");
    const conn = getConnectionByProvider("telegram");
    if (!conn?.secrets?.botToken) return { ok: false, error: "no Telegram connection" };
    const token = stripToken(conn.secrets.botToken);
    if (!token) return { ok: false, error: "no Telegram connection" };
    const chat = String(opts.chatId ?? resolveSystemChatId(conn.config?.chatId)).trim();
    if (!chat) return { ok: false, error: "no chatId" };
    const filename = opts.filename ?? "briefing.mp3";
    const mime = filename.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
    const form = new FormData();
    form.append("chat_id", chat);
    form.append("audio", new Blob([audio as unknown as BlobPart], { type: mime }), filename);
    if (opts.title) form.append("title", opts.title);
    if (opts.performer) form.append("performer", opts.performer);
    if (opts.caption) form.append("caption", opts.caption.slice(0, 1024));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
        method: "POST",
        body: form,
        signal: ctrl.signal,
      });
      const j: any = await r.json().catch(() => ({}));
      if (j?.ok) return { ok: true };
      return { ok: false, error: `telegram: ${j?.description ?? `HTTP ${r.status}`}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    return { ok: false, error: `telegram audio send failed: ${e?.message ?? e}` };
  }
}

// ── File delivery (read-requested files) ──────────────────────────────────
// Send a local file as a Telegram document. The caller (staged-send claim)
// has already enforced: DM-only, secrets-denylist re-check, 48MB cap.
// Multipart upload; best-effort result, never throws past {ok:false}.
export async function sendTelegramDocument(
  absPath: string,
  opts: { chatId?: string; caption?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { readFileSync, statSync, existsSync } = await import("node:fs");
    const { basename } = await import("node:path");
    if (!existsSync(absPath) || !statSync(absPath).isFile()) {
      return { ok: false, error: "file no longer on disk" };
    }
    const { getConnectionByProvider } = await import("./integrations.js");
    const conn = getConnectionByProvider("telegram");
    if (!conn?.secrets?.botToken) return { ok: false, error: "no Telegram connection" };
    const token = stripToken(conn.secrets.botToken);
    if (!token) return { ok: false, error: "no Telegram connection" };
    const chat = String(opts.chatId ?? resolveSystemChatId(conn.config?.chatId)).trim();
    if (!chat) return { ok: false, error: "no chatId" };
    const data = readFileSync(absPath);
    const form = new FormData();
    form.append("chat_id", chat);
    form.append("document", new Blob([data as unknown as BlobPart], { type: "application/octet-stream" }), basename(absPath));
    if (opts.caption) form.append("caption", opts.caption.slice(0, 1024));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: "POST",
        body: form,
        signal: ctrl.signal,
      });
      const j: any = await r.json().catch(() => ({}));
      if (j?.ok) return { ok: true };
      return { ok: false, error: `telegram: ${j?.description ?? `HTTP ${r.status}`}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    return { ok: false, error: `telegram document send failed: ${e?.message ?? e}` };
  }
}

// Send a video file (mp4/mov) as a streamable Telegram video message (not a
// generic document). Multipart upload; best-effort result, never throws past
// {ok:false}.
export async function sendTelegramVideo(
  absPath: string,
  opts: { chatId?: string; caption?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { readFileSync, statSync, existsSync } = await import("node:fs");
    const { basename, extname } = await import("node:path");
    if (!existsSync(absPath) || !statSync(absPath).isFile()) {
      return { ok: false, error: "file no longer on disk" };
    }
    const { getConnectionByProvider } = await import("./integrations.js");
    const conn = getConnectionByProvider("telegram");
    if (!conn?.secrets?.botToken) return { ok: false, error: "no Telegram connection" };
    const token = stripToken(conn.secrets.botToken);
    if (!token) return { ok: false, error: "no Telegram connection" };
    const chat = String(opts.chatId ?? resolveSystemChatId(conn.config?.chatId)).trim();
    if (!chat) return { ok: false, error: "no chatId" };
    const ext = extname(absPath).toLowerCase();
    const mime = ext === ".mov" ? "video/quicktime" : "video/mp4";
    const data = readFileSync(absPath);
    const form = new FormData();
    form.append("chat_id", chat);
    form.append("video", new Blob([data as unknown as BlobPart], { type: mime }), basename(absPath));
    form.append("supports_streaming", "true");
    if (opts.caption) form.append("caption", opts.caption.slice(0, 1024));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
        method: "POST",
        body: form,
        signal: ctrl.signal,
      });
      const j: any = await r.json().catch(() => ({}));
      if (j?.ok) return { ok: true };
      return { ok: false, error: `telegram: ${j?.description ?? `HTTP ${r.status}`}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    return { ok: false, error: `telegram video send failed: ${e?.message ?? e}` };
  }
}

// Download a file from Telegram's servers by file_id (Bot API getFile +
// file download, 20MB bot-API cap). Returns raw bytes + name for the caller
// to store as-is.
export async function downloadTelegramFile(
  fileId: string,
): Promise<{ ok: true; bytes: Buffer; filePath: string } | { ok: false; error: string }> {
  try {
    const { getConnectionByProvider } = await import("./integrations.js");
    const conn = getConnectionByProvider("telegram");
    const token = conn?.secrets?.botToken ? stripToken(conn.secrets.botToken) : "";
    if (!token) return { ok: false, error: "no Telegram connection" };
    const meta: any = await tg(token, "getFile", { file_id: fileId }, 15_000);
    const remotePath: string = String(meta?.result?.file_path ?? "");
    if (!meta?.ok || !remotePath) return { ok: false, error: `getFile failed: ${meta?.description ?? "unknown"}` };
    if (/^https?:\/\//i.test(remotePath) || remotePath.includes("..")) {
      return { ok: false, error: "unexpected file_path from Telegram" };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const r = await fetch(`https://api.telegram.org/file/bot${token}/${remotePath}`, { signal: ctrl.signal });
      if (!r.ok) return { ok: false, error: `file download HTTP ${r.status}` };
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length === 0) return { ok: false, error: "downloaded file is empty" };
      if (buf.length > 20 * 1024 * 1024) return { ok: false, error: `file too large (${buf.length} bytes > 20 MB bot-API cap)` };
      return { ok: true, bytes: buf, filePath: remotePath.split("/").pop() ?? "file" };
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    return { ok: false, error: `telegram download failed: ${e?.message ?? e}` };
  }
}

// Effective allow-list: env chat ids UNION the integration's default chat id, so
// setting a default chat on the Integrations page is enough to use the bridge
// with no extra env. All compared as strings.
async function allowedChats(): Promise<Set<string>> {
  const set = new Set<string>();
  for (const c of (process.env.NAXION_TELEGRAM_ALLOWED_CHATS ?? "").split(",").map(s => s.trim()).filter(Boolean)) set.add(c);
  try {
    const { getConnectionByProvider } = await import("./integrations.js");
    const chatId = (getConnectionByProvider("telegram")?.config?.chatId ?? "").trim();
    if (chatId && /^-?\d+$/.test(chatId)) set.add(chatId); // only a real numeric id, not a bot username
  } catch { /* integrations optional */ }
  return set;
}

async function tg(token: string, method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    return await r.json().catch(() => ({}));
  } catch (e: any) {
    // Network-level failure (DNS not ready at boot, connection reset, abort).
    // Return a normal {ok:false} so callers handle it gracefully instead of an
    // uncaught "fetch failed" propagating out of startup.
    return { ok: false, description: `network error: ${String(e?.message ?? e).slice(0, 120)}` };
  } finally {
    clearTimeout(timer);
  }
}

// Some scheduled senders (todo-brief, weekly-rollup) embed the whole vault
// FILE — frontmatter block + a trailing `<details><summary>Raw…` JSON dump —
// into their Telegram body, not just the human-readable narrative. Strip both
// before the text ever reaches markdownToTelegramHtml, or the frontmatter and
// raw JSON show up verbatim in the chat.
export function stripVaultFrontmatterForTelegram(md: string): string {
  return md
    .replace(/^---\n[\s\S]*?\n---\n+/, "")
    .replace(/<details>[\s\S]*?<\/details>\s*/gi, "")
    .trim();
}

// Exported for scheduled senders (reflection, innovation-scan, todo-brief) and
// sendTelegramMessage above.
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function markdownToTelegramHtml(md: string): string {
  let html = md;
  // Fenced code blocks ```lang\ncode``` -> <pre>code</pre> (escape inside)
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre>${escapeHtml(code.trim())}</pre>`);
  // Inline code `code` -> <code>code</code>
  html = html.replace(/`([^`]+?)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
  // Links [text](url) -> <a href="url">text</a> (escape text)
  html = html.replace(/\[([^\]]+?)\]\((https?:\/\/[^\)]+?)\)/g, (_m, text, url) => `<a href="${url}">${escapeHtml(text)}</a>`);
  // Bold **text** -> <b>text</b> (must be before italic to avoid double-replace)
  html = html.replace(/\*\*([^\*]+?)\*\*/g, (_m, t) => `<b>${escapeHtml(t)}</b>`);
  // Italic *text* or _text_ -> <i>text</i> (avoid already bold)
  html = html.replace(/(?<!<b>[^<]*)\*([^\*]+?)\*(?![^<]*<\/b>)/g, (_m, t) => `<i>${escapeHtml(t)}</i>`);
  html = html.replace(/_([^_]+?)_/g, (_m, t) => `<i>${escapeHtml(t)}</i>`);
  // Headings ## Heading -> <b>Heading</b>
  html = html.replace(/^#{1,6}\s+(.+)$/gm, (_m, h) => `<b>${escapeHtml(h.trim())}</b>`);
  // Blockquote > -> <i> removal or keep as is with italic
  // Escape any remaining bare & < > outside our tags (already did code/links)
  // We already escaped inside tags; now escape loose & < > that aren't part of our allowed tags.
  // Allowlist: <b>, </b>, <i>, </i>, <code>, </code>, <pre>, </pre>, <a href="...">, </a>
  // Do a pass: temporarily protect our tags, escape, then restore.
  const placeholders: string[] = [];
  html = html.replace(/<\/?(b|i|code|pre|a)(?: href="[^"]*")?>/g, (m) => {
    const idx = placeholders.length;
    placeholders.push(m);
    return `\x00${idx}\x00`;
  });
  html = escapeHtml(html);
  html = html.replace(/\x00(\d+)\x00/g, (_m, idx) => placeholders[Number(idx)]);
  return html;
}
async function sendReply(token: string, chatId: number | string, text: string, replyTo?: number): Promise<void> {
  const body = text.trim() || "(no answer produced)";
  const html = markdownToTelegramHtml(body);
  const chunks: string[] = [];
  const htmlChunks: string[] = [];
  for (let i = 0; i < body.length; i += 3900) chunks.push(body.slice(i, i + 3900));
  for (let i = 0; i < html.length; i += 3900) htmlChunks.push(html.slice(i, i + 3900));
  // Try HTML first (rich like ChatGPT/Claude), fall back to plain per-chunk on parse error.
  for (let k = 0; k < htmlChunks.length; k++) {
    const r = await tg(token, "sendMessage", {
      chat_id: chatId,
      text: htmlChunks[k],
      parse_mode: "HTML",
      ...(k === 0 && replyTo ? { reply_to_message_id: replyTo } : {}),
    });
    if (!r?.ok && /parse|can't parse|wrong string/i.test(String(r?.description ?? ""))) {
      await tg(token, "sendMessage", {
        chat_id: chatId,
        text: chunks[k],
        ...(k === 0 && replyTo ? { reply_to_message_id: replyTo } : {}),
      });
    }
  }
}

async function apiPost(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return await r.json().catch(() => ({}));
}

async function pollJob(jobId: string, timeoutMs = 300_000): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/tasks/jobs/${jobId}`);
      if (res.ok) {
        const j = await res.json();
        if (j.status === "succeeded" || j.status === "failed" || j.status === "rejected") return j;
      }
    } catch { /* transient */ }
    await sleep(3000);
  }
  return null;
}

// Per-chat rolling history so a Telegram back-and-forth keeps context (the web
// chat does the same with its message list). Capped, in-memory.
const chatHistory = new Map<string, { role: "user" | "assistant"; content: string }[]>();
function historyFor(chatId: string): { role: "user" | "assistant"; content: string }[] {
  return chatHistory.get(chatId) ?? [];
}
function appendHistory(chatId: string, role: "user" | "assistant", content: string): void {
  const h = chatHistory.get(chatId) ?? [];
  h.push({ role, content });
  while (h.length > 8) h.shift(); // keep the last ~4 exchanges
  chatHistory.set(chatId, h);
}

async function handleEmailCallback(token: string, allow: Set<string>, cb: any): Promise<void> {
  try {
    const data: string = String(cb.data ?? "");
    const chatId = String(cb.message?.chat?.id ?? cb.from?.id ?? "");
    if (!allow.has(chatId)) return;
    const cbId = String(cb.id ?? "");

    void tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Processing email..." }).catch(() => {});

    const m = data.match(/^email:(respond|snooze|ignore|confirm_send|edit|handle_all|archive|delegate):?(.*)$/);
    if (!m) return;

    const [, action, triageId] = m;
    const { loadTriageStore, saveTriageStore } = await import("./email.js");
    const store = loadTriageStore();

    if (action === "handle_all") {
      const pending = Object.entries(store).filter(([, e]) => e.status !== "resolved");
      const list = pending.length
        ? pending.map(([id, e]) => `• ${e.sender} (${e.subject}) [${id}]`).join("\n")
        : "Triage queue is empty.";
      await tg(token, "sendMessage", { chat_id: chatId, text: `📧 Triage queue (${pending.length}):\n\n${list}`, parse_mode: "HTML" });
      return;
    }

    const entry = store[triageId];

    if (!entry) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Email not found in triage store" });
      return;
    }

    if (action === "ignore") {
      delete store[triageId];
      saveTriageStore(store);
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Ignored" });
      void tg(token, "sendMessage", { chat_id: chatId, text: `🗑️ Ignored email from ${entry.sender}`, parse_mode: "HTML" }).catch(() => {});
    } else if (action === "archive") {
      entry.status = "resolved";
      saveTriageStore(store);
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Archived" });
      void tg(token, "sendMessage", { chat_id: chatId, text: `🗄️ Archived email from <b>${escapeHtml(entry.sender)}</b>`, parse_mode: "HTML" }).catch(() => {});
    } else if (action === "delegate") {
      entry.status = "pending";
      saveTriageStore(store);
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Delegated" });
      void tg(token, "sendMessage", { chat_id: chatId, text: `➡️ Delegated email from <b>${escapeHtml(entry.sender)}</b> to specialist team agent`, parse_mode: "HTML" }).catch(() => {});
    } else if (action === "snooze") {
      entry.status = "snoozed";
      saveTriageStore(store);
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Snoozed" });
      void tg(token, "sendMessage", { chat_id: chatId, text: `⏰ Snoozed email from ${entry.sender}`, parse_mode: "HTML" }).catch(() => {});
    } else if (action === "edit") {
      entry.status = "awaiting_edit";
      (entry as any).awaitingEditChatId = chatId;
      saveTriageStore(store);
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Send your edited version" });
      void tg(token, "sendMessage", { chat_id: chatId, text: `✏️ Send your edited version for <b>${escapeHtml(entry.sender)}</b> as your next message here, and I'll stage it for sending.`, parse_mode: "HTML" }).catch(() => {});
    } else if (action === "confirm_send") {
      // Actually send the email using the stored draft
      if (!entry.draftBody) {
        await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "No draft found" });
        return;
      }

      const { sendEmailFromAccount } = await import("./email.js");
      try {
        const res = await sendEmailFromAccount(entry.accountId, {
          to: [entry.sender],
          subject: `Re: ${entry.subject}`,
          body: entry.draftBody,
        });

        if (res.sent) {
          delete store[triageId];
          saveTriageStore(store);
          await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Sent!" });
          void tg(token, "sendMessage", { chat_id: chatId, text: `✅ Email sent to ${entry.sender}`, parse_mode: "HTML" }).catch(() => {});
        } else {
          await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Failed to send" });
        }
      } catch (e: any) {
        await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: `Send failed: ${String(e?.message ?? e).slice(0, 60)}` });
      }
    } else if (action === "respond") {
      // Trigger agent to draft a response
      const BASE = `http://127.0.0.1:${config.port}`;
      const r = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: "You are Naxie. Draft a professional response to this email. Use the user's vault for context." },
            { role: "user", content: `Draft a response to this email:\nFrom: ${entry.sender}\nSubject: ${entry.subject}\nBody: ${entry.body}` }
          ],
          persona: "naxie"
        })
      });
      const res = await r.json();
      const draft = res.text ?? "I couldn't generate a draft.";

      // SAVE THE DRAFT TO STORE
      const { loadTriageStore: loadT, saveTriageStore: saveT } = await import("./email.js");
      const currentStore = loadT();
      if (currentStore[triageId]) {
        currentStore[triageId].draftBody = draft;
        saveT(currentStore);
      }

      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Draft generated" });
      await tg(token, "sendMessage", { 
        chat_id: chatId, 
        text: `📝 <b>Draft Response to ${entry.sender}:</b>\n\n${draft}\n\nShall I send this?`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Send", callback_data: `email:confirm_send:${triageId}` },
            { text: "❌ Edit", callback_data: `email:edit:${triageId}` }
          ]]
        }
      });
    }
  } catch (e: any) {
    console.warn(`[telegram] email callback failed: ${e?.message ?? e}`);
  }
}

async function handleTodoCallback(token: string, allow: Set<string>, cb: any): Promise<void> {
  try {
    const data: string = String(cb.data ?? "");
    const chatId = String(cb.message?.chat?.id ?? cb.from?.id ?? "");
    if (!allow.has(chatId)) return;
    const cbId = String(cb.id ?? "");
    // Ack immediately to clear spinner
    void tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Working…" }).catch(() => {});
    const m = data.match(/^todo:(done|snooze|reschedule):([^:]+)(?::([^:]+))?$/);
    if (!m) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Unknown action" });
      return;
    }
    const [, action, taskId, extraDate] = m;
    // Direct my-tasks store edit (cross-owner search)
    try {
      const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const storePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.naxion/my-tasks.json");
      if (!existsSync(storePath)) throw new Error("no store");
      const parsed = JSON.parse(readFileSync(storePath, "utf8"));
      const items: any[] = parsed.items ?? [];
      const idx = items.findIndex((x: any) => x.id === taskId);
      if (idx === -1) {
        await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Task not found" });
        return;
      }
      const it = items[idx];
      if (action === "done") {
        it.completed = !it.completed;
        it.completedAt = it.completed ? new Date().toISOString() : undefined;
        writeFileSync(storePath, JSON.stringify(parsed, null, 2));
        await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: it.completed ? "✅ Marked done" : "↩️ Marked open" });
        void tg(token, "sendMessage", { chat_id: chatId, text: `${it.completed ? "✅ Done" : "↩️ Reopened"}: ${String(it.title).slice(0,120)}`, parse_mode: "HTML" }).catch(() => {});
      } else if (action === "snooze" || action === "reschedule") {
        let ymd = extraDate;
        if (!ymd) {
          const tmr = new Date(); tmr.setDate(tmr.getDate()+1);
          ymd = `${tmr.getFullYear()}-${String(tmr.getMonth()+1).padStart(2,"0")}-${String(tmr.getDate()).padStart(2,"0")}`;
        }
        it.dueDate = ymd;
        writeFileSync(storePath, JSON.stringify(parsed, null, 2));
        await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: `⏰ Rescheduled to ${ymd}` });
        void tg(token, "sendMessage", { chat_id: chatId, text: `⏰ Rescheduled to <b>${ymd}</b>: ${escapeHtml(String(it.title).slice(0,120))}`, parse_mode: "HTML" }).catch(() => {});
      }
    } catch (e: any) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: `Failed: ${String(e?.message ?? e).slice(0,60)}` });
    }
  } catch (e: any) { console.warn(`[telegram] callback failed: ${e?.message ?? e}`); }
}

// ── OrgTask inbox approvals over Telegram ─────────────────────────────────
// Lets the operator approve/reject waiting-on-approval OrgTasks from the bot
// DM with one tap — the Approvals page isn't reachable from a phone call, so
// a nudge without buttons is a dead end (the 30-min "needs your call" spam).
//
// Rules: same allow-list gate as every other callback; approve/reject are
// DM-ONLY (a group tap could be anyone near the operator's screen); listing
// works anywhere allow-listed. Diff-carrying items can never be approved
// here — they resolve through the same PATCH endpoint as the Approvals page
// (improver/spend/blocked special cases included), and diffs are refused
// with a pointer to review in-app. Every decision writes an audit entry.
async function handleApprovalCallback(token: string, allow: Set<string>, cb: any): Promise<void> {
  try {
    const { parseApprovalCallback, approvalCallback, toWaitingView, approvalKeyboard, detailKeyboard } =
      await import("./approval-telegram.js");
    const data = String(cb.data ?? "");
    const chatId = String(cb.message?.chat?.id ?? cb.from?.id ?? "");
    if (!allow.has(chatId)) return;
    const cbId = String(cb.id ?? "");
    const chatType = String(cb.message?.chat?.type ?? "private");
    const isGroup = chatType === "group" || chatType === "supergroup";
    const parsed = parseApprovalCallback(data);
    if (!parsed) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Unknown action" });
      return;
    }
    void tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Working…" }).catch(() => {});

    const { getOrgTask, listOrgTasks } = await import("./org-tasks.js");
    const send = (text: string, keyboard?: any[][]) =>
      tg(token, "sendMessage", {
        chat_id: chatId, text, parse_mode: "HTML",
        ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    const clearButtons = () => {
      const mid = cb.message?.message_id;
      if (mid === undefined) return Promise.resolve();
      return tg(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    };
    const audit = async (action: string, target: string, result: "success" | "failure") => {
      try {
        const { logAudit } = await import("./audit-log.js");
        logAudit({ level: "info", actor: "operator", action, target, detail: "via Telegram inbox", result });
      } catch { /* best-effort */ }
    };

    if (parsed.action === "list") {
      const waiting = (listOrgTasks({ status: "waiting-on-approval" } as any) as any[]).slice(0, 5);
      const { listJobs } = await import("./jobs.js");
      const parked = listJobs().filter((j: any) => j.status === "awaiting-approval").slice(0, 5);
      if (!waiting.length && !parked.length) {
        await send(`📥 <b>Inbox is clear</b> — nothing waiting on approval.`);
        return;
      }
      const views = waiting.map(toWaitingView);
      const lines = views.map((v, i) =>
        `${i + 1}. <b>${escapeHtml(v.title)}</b>\n   ${escapeHtml(v.actionDescription.slice(0, 160))}${v.hasDiff ? "\n   🛡️ <i>carries a code diff — review in app</i>" : ""}`);
      let n = lines.length;
      const jobLines = parked.map((j: any) => {
        n += 1;
        return `${n}. <b>${escapeHtml(String(j.title ?? j.kind ?? j.id))}</b> <i>(job, parked plan)</i>`;
      });
      const kb: any[][] = [...approvalKeyboard(views)];
      for (const j of parked.slice(0, 3)) {
        kb.push([
          { text: `✅ Job: ${String(j.title ?? j.kind ?? j.id).slice(0, 20)}`, callback_data: `approval:jobapprove:${j.id}` },
          { text: "❌", callback_data: `approval:jobreject:${j.id}` },
        ]);
      }
      await send(`📥 <b>Inbox — ${waiting.length + parked.length} waiting on approval</b>\n\n${[...lines, ...jobLines].join("\n")}`, kb);
      return;
    }

    // Job-level approvals — parked plans, same one-tap shape as the
    // Approvals page (POST /api/templates/jobs/:id/approve|reject, which
    // enforces the stale-park TTL). DM-only, like OrgTask actions.
    if (parsed.action === "jobapprove" || parsed.action === "jobreject" || parsed.action === "jobdetail") {
      if (isGroup) {
        await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Approve from your DM with the bot" });
        return;
      }
      const jr = await fetch(`${BASE}/api/tasks/jobs/${encodeURIComponent(parsed.id ?? "")}`).then((r) => r.json().catch(() => ({}))).catch(() => ({}));
      if (!jr?.id || jr.status !== "awaiting-approval") {
        await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Already resolved" });
        await clearButtons();
        return;
      }
      const jobTitle = String(jr.title ?? jr.kind ?? jr.id);
      const { jobDetailKeyboard: jdk } = await import("./approval-telegram.js");
      if (parsed.action === "jobdetail") {
        const steps = Array.isArray(jr.plan?.steps) ? jr.plan.steps.length : 0;
        await send(
          `📋 <b>${escapeHtml(jobTitle)}</b> <i>(job, parked plan)</i>\n\n${escapeHtml(String(jr.task ?? jr.inputs?.task ?? "").slice(0, 300))}\n\n<i>${steps} step${steps === 1 ? "" : "s"} · parked ${escapeHtml(String(jr.startedAt ?? "").slice(0, 16).replace("T", " "))}</i>`,
          jdk(jr.id),
        );
        return;
      }
      const approved = parsed.action === "jobapprove";
      const rr = await fetch(`${BASE}/api/templates/jobs/${encodeURIComponent(jr.id)}/${approved ? "approve" : "reject"}`, { method: "POST" });
      const rj: any = await rr.json().catch(() => ({}));
      if (!rr.ok) {
        const msg = String(rj?.error ?? rr.status).slice(0, 120);
        await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: msg.slice(0, 60) });
        await send(`⚠️ <b>${escapeHtml(jobTitle)}</b> — ${escapeHtml(msg)}`);
        await audit(approved ? "job.approve_telegram" : "job.reject_telegram", jobTitle, "failure");
        return;
      }
      await clearButtons();
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: approved ? "✅ Job approved" : "❌ Job rejected" });
      await send(approved
        ? `✅ <b>Job approved:</b> ${escapeHtml(jobTitle)}\n<i>Running the reviewed plan now.</i>`
        : `❌ <b>Job rejected:</b> ${escapeHtml(jobTitle)}`);
      await audit(approved ? "job.approve_telegram" : "job.reject_telegram", jobTitle, "success");
      return;
    }

    const task = parsed.id ? getOrgTask(parsed.id) : undefined;
    if (!task || task.status !== "waiting-on-approval") {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Already resolved" });
      await clearButtons();
      return;
    }
    const view = toWaitingView(task);

    if (parsed.action === "detail") {
      const diffNote = view.hasDiff
        ? `\n\n🛡️ <i>This carries a code diff — approve it on the Approvals page after reading the change, not here.</i>`
        : "";
      await send(
        `📋 <b>${escapeHtml(view.title)}</b>\n\n${escapeHtml(view.actionDescription)}\n\n<i>${escapeHtml(view.kind)} · requested ${escapeHtml(view.requestedAt.slice(0, 16).replace("T", " "))}</i>${diffNote}`,
        detailKeyboard(view),
      );
      return;
    }

    // approve / reject — DM-only, diff-guard, then the same resolve endpoint
    // the Approvals page uses (keeps improver/spend/blocked semantics).
    if (isGroup) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Approve from your DM with the bot" });
      return;
    }
    if (view.hasDiff) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Has a code diff — review in app" });
      await send(`🛡️ <b>${escapeHtml(view.title)}</b> carries a code diff, so it can't be approved here. Open the Approvals page, read the change, then decide.`);
      return;
    }
    const approved = parsed.action === "approve";
    const r = await fetch(`${BASE}/api/org-tasks/${encodeURIComponent(task.id)}/resolve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j?.task) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: `Failed: ${String(j?.error ?? r.status).slice(0, 60)}` });
      return;
    }
    await clearButtons();
    await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: approved ? "✅ Approved" : "❌ Rejected" });
    await send(approved
      ? `✅ <b>Approved:</b> ${escapeHtml(view.title)}\n<i>Back to active — Naxie runs it from here.</i>`
      : `❌ <b>Rejected:</b> ${escapeHtml(view.title)}\n<i>Moved to blocked — it stays visible on the board.</i>`);
    await audit(approved ? "org_task.approve_telegram" : "org_task.reject_telegram", view.title, "success");
  } catch (e: any) {
    console.warn(`[telegram] approval callback failed: ${e?.message ?? e}`);
  }
}

// ── Local file staged sends over Telegram ─────────────────────────────────
// Confirm-tap flow for "send me this file": the agent (local.send) or /send
// stages {path, chat} and posts a Send/Cancel card. NOTHING leaves the
// machine until the matching DM taps Send — the token is single-use,
// 10-minute, and bound to the requesting chat. Group taps are refused:
// files only move in the operator's DM.
async function handleLocalCallback(token: string, allow: Set<string>, cb: any): Promise<void> {
  try {
    const { parseLocalCallback, claimSendToken, cancelSendToken, formatBytes } = await import("./naxie-fs.js");
    const data = String(cb.data ?? "");
    const chatId = String(cb.message?.chat?.id ?? cb.from?.id ?? "");
    if (!allow.has(chatId)) return;
    const cbId = String(cb.id ?? "");
    const chatType = String(cb.message?.chat?.type ?? "private");
    if (chatType === "group" || chatType === "supergroup") {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Files only move in your DM" });
      return;
    }
    const parsed = parseLocalCallback(data);
    if (!parsed) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Unknown action" });
      return;
    }
    const clearButtons = () => {
      const mid = cb.message?.message_id;
      if (mid === undefined) return Promise.resolve();
      return tg(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    };
    const audit = async (action: string, target: string, result: "success" | "failure", detail?: string) => {
      try {
        const { logAudit } = await import("./audit-log.js");
        logAudit({ level: "info", actor: "operator", action, target, detail: detail ?? "via Telegram file flow", result });
      } catch { /* best-effort */ }
    };

    if (parsed.action === "cancel") {
      const ok = cancelSendToken(parsed.token, chatId);
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: ok ? "Cancelled — nothing sent" : "Already gone" });
      await clearButtons();
      return;
    }

    // Send: claim (re-gates denylist/size/chat), deliver, audit.
    void tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Sending…" }).catch(() => {});
    let staged;
    try {
      staged = claimSendToken(parsed.token, chatId);
    } catch (e: any) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: String(e?.message ?? e).slice(0, 120) });
      await clearButtons();
      return;
    }
    const sent = await sendTelegramDocument(staged.path, { chatId, caption: `${staged.name} (${formatBytes(staged.size)})` });
    await clearButtons();
    if (sent.ok) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Sent" });
      await audit("local.send", staged.path, "success", `${staged.name} (${formatBytes(staged.size)}) to Telegram DM`);
    } else {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: `Send failed: ${String(sent.error).slice(0, 60)}` });
      await tg(token, "sendMessage", { chat_id: chatId, text: `⚠️ Couldn't send <b>${escapeHtml(staged.name)}</b>: ${escapeHtml(String(sent.error).slice(0, 200))}`, parse_mode: "HTML" }).catch(() => {});
      await audit("local.send", staged.path, "failure", String(sent.error).slice(0, 200));
    }
  } catch (e: any) {
    console.warn(`[telegram] local callback failed: ${e?.message ?? e}`);
  }
}

// Download a user-uploaded Telegram file into Naxie's inbox folder. DM-only,
// size-capped, sanitized filename, audited. Returns the saved location (or
// null when a failure ack was already sent). Never throws past a user message.
type InboundKind = "document" | "photo" | "video" | "audio" | "voice" | "video_note";
async function handleInboundFile(token: string, chatId: string, file: any, kind: InboundKind): Promise<{ dest: string; name: string } | null> {
  try {
    const { inboxPath, formatBytes, TELEGRAM_FILE_CAP } = await import("./naxie-fs.js");
    const fileId = String(file?.file_id ?? "");
    if (!fileId) return null;
    const size = Number(file?.file_size ?? 0);
    if (size >= TELEGRAM_FILE_CAP) {
      await tg(token, "sendMessage", { chat_id: chatId, text: `⚠️ That file is ${formatBytes(size)} — over Telegram's limit, I can't take it.`, parse_mode: "HTML" }).catch(() => {});
      return null;
    }
    const info: any = await tg(token, "getFile", { file_id: fileId });
    const remotePath = String(info?.result?.file_path ?? "");
    if (!info?.ok || !remotePath || /^https?:\/\//i.test(remotePath) || remotePath.includes("..")) {
      await tg(token, "sendMessage", { chat_id: chatId, text: `⚠️ Couldn't fetch that file from Telegram — try sending it again.`, parse_mode: "HTML" }).catch(() => {});
      return null;
    }
    const dl = await fetch(`https://api.telegram.org/file/bot${token}/${remotePath}`);
    if (!dl.ok) throw new Error(`download HTTP ${dl.status}`);
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length === 0) throw new Error("downloaded file is empty");
    if (buf.length >= TELEGRAM_FILE_CAP) throw new Error("file grew past the limit in transit");
    const day = new Date().toISOString().slice(0, 10);
    const uniq = String(file?.file_unique_id ?? Date.now()).slice(-6);
    let name: string;
    if (kind === "document" || kind === "audio" || kind === "video") {
      name = String(file?.file_name ?? `${kind}-${day}-${uniq}`);
    } else if (kind === "voice") {
      name = `voice-${day}-${uniq}.oga`;
    } else if (kind === "video_note") {
      name = `videonote-${day}-${uniq}.mp4`;
    } else {
      name = `photo-${day}-${uniq}.jpg`;
    }
    const dest = inboxPath(name);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(dest, buf);
    try {
      const { logAudit } = await import("./audit-log.js");
      logAudit({ level: "info", actor: "operator", action: "local.upload", target: dest, detail: `${kind} ${formatBytes(buf.length)} from Telegram DM`, result: "success" });
    } catch { /* best-effort */ }
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: `📥 <b>Saved to Naxie's folder:</b>\n<code>${escapeHtml(dest)}</code>\n<i>${formatBytes(buf.length)} — find it in inbox/ of D:\\Naxie.</i>`,
      parse_mode: "HTML",
    }).catch(() => {});
    return { dest, name };
  } catch (e: any) {
    console.warn(`[telegram] inbound file failed: ${e?.message ?? e}`);
    await tg(token, "sendMessage", { chat_id: chatId, text: `⚠️ Couldn't save that file: ${escapeHtml(String(e?.message ?? e).slice(0, 160))}`, parse_mode: "HTML" }).catch(() => {});
    return null;
  }
}

// Pick the retrievable attachment off a Telegram message, if any. Photos
// arrive as a size array (take the largest); everything else carries file_id
// directly. Returns null for text/stickers/joins/service messages.
function pickTelegramAttachment(msg: any): { file: any; kind: InboundKind } | null {
  if (!msg || typeof msg !== "object") return null;
  if (msg.document?.file_id) return { file: msg.document, kind: "document" };
  if (msg.video?.file_id) return { file: msg.video, kind: "video" };
  if (msg.audio?.file_id) return { file: msg.audio, kind: "audio" };
  if (msg.voice?.file_id) return { file: msg.voice, kind: "voice" };
  if (msg.video_note?.file_id) return { file: msg.video_note, kind: "video_note" };
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const best = msg.photo.reduce((a: any, b: any) => (Number(b?.file_size ?? 0) > Number(a?.file_size ?? 0) ? b : a));
    if (best?.file_id) return { file: best, kind: "photo" };
  }
  return null;
}

// Build agent-ready text for a retrieved file: the file stays as-is on disk,
// and the agent gets extracted content (documents/spreadsheets), a transcript
// (voice/audio/video), or a saved-path note (photos). All best-effort — the
// agent always at least learns the exact saved path.
async function describeInboundFile(dest: string, name: string, kind: InboundKind): Promise<string> {
  const { extname } = await import("node:path");
  const ext = extname(name).toLowerCase();
  const header = `📎 File received (${kind}): ${name} — saved as-is at ${dest}`;
  try {
    if (kind === "document" || kind === "photo") {
      const { extractDocText } = await import("./doc-extractor.js");
      const out = await extractDocText(dest);
      const text = String(out?.text ?? "").trim();
      if (text && out.kind !== "unsupported" && text.length > 40) {
        return `${header}\n\nExtracted content:\n${text.slice(0, 6000)}${text.length > 6000 ? "\n…(truncated — full file on disk)" : ""}`;
      }
      return `${header}\n(No text extractable — inspect the file on disk as needed.)`;
    }
    if (kind === "voice" || kind === "audio" || kind === "video" || kind === "video_note") {
      // Voice notes arrive as .oga (Ogg container, whisper-readable) but the
      // transcriber gates on extension — transcribe a temp .ogg copy while
      // the vault keeps the original untouched.
      let asrPath = dest;
      let tmpCopy: string | null = null;
      try {
        const { transcribeSupportsExt } = await import("./audio-transcribe.js");
        if (!transcribeSupportsExt(ext)) {
          const { join, dirname, basename } = await import("node:path");
          const { copyFileSync, unlinkSync } = await import("node:fs");
          tmpCopy = join(dirname(dest), `${basename(dest, ext)}.ogg`);
          copyFileSync(dest, tmpCopy);
          asrPath = tmpCopy;
        }
        const { transcribeAudioFile } = await import("./audio-transcribe.js");
        const out = await transcribeAudioFile(asrPath, "auto", "", "");
        const text = String(out?.text ?? "").trim();
        if (tmpCopy) { try { (await import("node:fs")).unlinkSync(tmpCopy); } catch { /* best-effort */ } }
        if (text) return `${header}\n\nTranscript:\n${text.slice(0, 6000)}${text.length > 6000 ? "\n…(truncated)" : ""}`;
        return `${header}\n(Transcription returned empty — the audio is on disk.)`;
      } catch (e: any) {
        if (tmpCopy) { try { (await import("node:fs")).unlinkSync(tmpCopy); } catch { /* best-effort */ } }
        return `${header}\n(Transcription unavailable: ${String(e?.message ?? e).slice(0, 160)} — audio is on disk.)`;
      }
    }
  } catch (e: any) {
    console.warn(`[telegram] describeInboundFile failed: ${e?.message ?? e}`);
  }
  return header;
}

// /find + /send implementation: search Naxie's folder + the usual user
// folders for a filename, then either list matches or stage the best one
// behind a confirm card. Caller guarantees DM context.
async function handleFileCommand(
  token: string, chatId: string, cmd: "find" | "send", query: string, replyTo: number,
): Promise<void> {
  const { findPrimitive } = await import("./primitives.js");
  const { naxieHome, stageSend, describeForSend, formatBytes, localSendCallback, localCancelCallback } =
    await import("./naxie-fs.js");
  const { homedir } = await import("node:os");
  const { existsSync } = await import("node:fs");
  const home = homedir();
  const roots = [naxieHome(), "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos"]
    .map((r) => (r === naxieHome() ? r : `${home}\\${r}`))
    .filter((r) => { try { return existsSync(r); } catch { return false; } });
  const finder = findPrimitive("fs.find_in");
  if (!finder) throw new Error("file search unavailable");
  type Hit = { path: string; name: string; size?: number };
  const hits: Hit[] = [];
  for (const root of roots) {
    try {
      const r: any = await finder.handler({ folder: root, name: query, limit: 5, depth: 3 });
      for (const m of r?.matches ?? []) hits.push({ path: String(m.path), name: String(m.name ?? m.path), size: Number(m.size ?? 0) });
    } catch { /* one bad root never kills the search */ }
    if (hits.length >= 8) break;
  }
  if (!hits.length) {
    await tg(token, "sendMessage", { chat_id: chatId, text: `🔍 No files matching "<b>${escapeHtml(query)}</b>" in your folders or Naxie's.`, parse_mode: "HTML" }).catch(() => {});
    return;
  }
  const shown = hits.slice(0, 5);
  if (cmd === "find") {
    const lines = shown.map((h, i) => `${i + 1}. <b>${escapeHtml(h.name)}</b>\n   <code>${escapeHtml(h.path)}</code>`);
    await tg(token, "sendMessage", {
      chat_id: chatId,
      text: `🔍 <b>${shown.length} match${shown.length === 1 ? "" : "es"} for "${escapeHtml(query)}":</b>\n\n${lines.join("\n")}\n\n<i>/send ${escapeHtml(query)} delivers the best match after your tap.</i>`,
      parse_mode: "HTML",
      reply_to_message_id: replyTo,
    }).catch(() => {});
    return;
  }
  // /send — stage the best match behind a confirm card.
  const best = shown[0];
  let info;
  try {
    info = describeForSend(best.path);
  } catch (e: any) {
    await tg(token, "sendMessage", { chat_id: chatId, text: `⚠️ Found <b>${escapeHtml(best.name)}</b> but can't send it: ${escapeHtml(String(e?.message ?? e).slice(0, 160))}`, parse_mode: "HTML" }).catch(() => {});
    return;
  }
  if (info.tooBig) {
    await tg(token, "sendMessage", { chat_id: chatId, text: `⚠️ <b>${escapeHtml(info.name)}</b> is ${formatBytes(info.size)} — over Telegram's file limit.`, parse_mode: "HTML" }).catch(() => {});
    return;
  }
  const { token: tok } = stageSend(best.path, chatId);
  const extra = shown.length > 1 ? `\n<i>${shown.length - 1} other match${shown.length > 2 ? "es" : ""} — /find ${escapeHtml(query)} to see all.</i>` : "";
  await tg(token, "sendMessage", {
    chat_id: chatId,
    text: `📄 <b>Send this file?</b>\n\n<b>${escapeHtml(info.name)}</b> (${formatBytes(info.size)})\n<code>${escapeHtml(info.path)}</code>${extra}\n\n<i>Tap Send — nothing has left your machine yet.</i>`,
    parse_mode: "HTML",
    reply_to_message_id: replyTo,
    reply_markup: { inline_keyboard: [[
      { text: "📤 Send", callback_data: localSendCallback(tok) },
      { text: "✖️ Cancel", callback_data: localCancelCallback(tok) },
    ]] },
  }).catch(() => {});
}

async function processUpdate(token: string, allow: Set<string>, update: any): Promise<void> {
  if (update.callback_query) {
    const data = String(update.callback_query.data ?? "");
    if (data.startsWith("email:")) {
      return handleEmailCallback(token, allow, update.callback_query);
    }
    if (data.startsWith("whatsapp:")) {
      const { handleWhatsAppCallback } = await import("./whatsapp-bridge.js");
      return handleWhatsAppCallback(token, allow, update.callback_query);
    }
    if (data.startsWith("approval:")) {
      return handleApprovalCallback(token, allow, update.callback_query);
    }
    if (data.startsWith("local:")) {
      return handleLocalCallback(token, allow, update.callback_query);
    }
    return handleTodoCallback(token, allow, update.callback_query);
  }
  const msg = update.message ?? update.channel_post;
  // ── Inbound files (DM-only, any Telegram type) ───────────────────────────
  // A document, photo, video, audio, voice note or video-note sent TO the bot
  // is retrieved as-is into Naxie's folder (inbox/), never anywhere else on
  // the machine — then its content (extracted text / transcript) routes to
  // the agent exactly like a text message, so "summarise the PDF I just
  // sent" works. Group uploads are ignored — files only move in the
  // operator's DM.
  // Returns agent-ready text, or null when fully handled (failure ack sent)
  // or the update should be ignored.
  async function intakeAttachment(chatId: string): Promise<string | null> {
    const pick = pickTelegramAttachment(msg);
    if (!pick) return null; // stickers, joins, edits… — nothing to retrieve
    const saved = await handleInboundFile(token, chatId, pick.file, pick.kind);
    if (!saved) return null; // failure ack already sent
    const caption = String(msg.caption ?? "").trim();
    const body = await describeInboundFile(saved.dest, saved.name, pick.kind);
    state.processed += 1;
    return [caption, body].filter(Boolean).join("\n\n");
  }
  if (!msg) return; // ignore non-message updates
  const chat = msg.chat ?? {};
  const chatId = String(chat.id);
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  // Re-resolve the allow-list per batch above; gate here covers text + files.
  const hasAttachment = !!pickTelegramAttachment(msg);
  if (!hasAttachment && typeof msg.text !== "string") return; // ignore non-text, non-file updates

  // ── Telegram news monitor — silently capture all messages from monitor groups ──
  // These messages are NOT routed to /api/chat and NOT replied to in the group.
  // They land in the pending queue for batch LLM scoring (telegram-news-monitor.ts).
  try {
    const { isMonitorEnabled, monitorGroups, capturePost } = await import("./telegram-news-monitor.js");
    if (typeof msg.text === "string" && isMonitorEnabled() && monitorGroups().includes(chatId)) {
      const sender = msg.from ?? {};
      const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(" ") || sender.username || "unknown";
      capturePost({
        messageId: msg.message_id,
        chatId,
        chatName: chat.title ?? chatId,
        text: msg.text,
        senderName,
        timestamp: new Date(msg.date * 1000).toISOString(),
        capturedAt: new Date().toISOString(),
      });
      return; // silent — do not route to agent, do not reply
    }
  } catch { /* monitor module optional — fall through to normal bridge logic */ }

  // ── Allow-list gate (the security boundary) ──
  if (!allow.has(chatId)) {
    state.skippedUnauthorized += 1;
    console.warn(`[telegram] ignored message from non-allowlisted chat ${chatId} (${chat.type})`);
    return; // silent — no reply to an unauthorised chat
  }

  let text: string;
  if (!isGroup && hasAttachment) {
    // DM file intake (allow-list already enforced above): retrieve as-is,
    // build agent-ready text, and fall through to the normal agent pipeline.
    const attached = await intakeAttachment(chatId);
    if (attached === null) return;
    text = attached;
  } else {
    if (typeof msg.text !== "string") return; // stickers, joins, edits…
    text = msg.text.trim();
  }

  // ── WhatsApp triage edit capture ── (checked first — cheap map lookup, no I/O
  // beyond the triage JSON read/write; mirrors the email edit-capture below.)
  if (!isGroup && text.length > 0 && !text.startsWith("/")) {
    try {
      const { tryCaptureWhatsAppEdit } = await import("./whatsapp-bridge.js");
      if (await tryCaptureWhatsAppEdit(chatId, text)) {
        state.processed += 1;
        return;
      }
    } catch (e: any) { console.warn(`[telegram] whatsapp edit-capture failed: ${e?.message ?? e}`); }
  }

  // ── Email triage edit capture ──
  // If this DM chat has an email awaiting an edited draft, treat the next
  // text message as the edited version (unless it looks like a new command).
  // Groups are excluded — too ambiguous there.
  if (!isGroup && text.length > 0 && !text.startsWith("/")) {
    try {
      const { loadTriageStore, saveTriageStore } = await import("./email.js");
      const triageStore = loadTriageStore();
      const awaiting = Object.entries(triageStore).find(
        ([, e]) => (e as any).status === "awaiting_edit" && ((e as any).awaitingEditChatId ?? chatId) === chatId,
      );
      if (awaiting) {
        const [triageId, tEntry] = awaiting as [string, any];
        tEntry.draftBody = text;
        tEntry.status = "pending";
        delete tEntry.awaitingEditChatId;
        saveTriageStore(triageStore);
        await tg(token, "sendMessage", {
          chat_id: chatId,
          text: `📝 <b>Staged edited reply to ${escapeHtml(tEntry.sender)}:</b>\n\n${escapeHtml(text.slice(0, 1500))}${text.length > 1500 ? "…" : ""}\n\nShall I send this?`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Send", callback_data: `email:confirm_send:${triageId}` },
              { text: "✏️ Edit again", callback_data: `email:edit:${triageId}` },
            ]],
          },
        });
        state.processed += 1;
        return;
      }
    } catch (e: any) { console.warn(`[telegram] edit-capture failed: ${e?.message ?? e}`); }
  }

  // In a group, only act when the bot is @mentioned or the message replies to
  // the bot — otherwise it's not for us. Strip the mention before the agent.
  if (isGroup) {
    const uname = state.botUsername ? `@${state.botUsername}` : "";
    const mentioned = uname && text.toLowerCase().includes(uname.toLowerCase());
    const repliedToBot = msg.reply_to_message?.from?.username && state.botUsername &&
      msg.reply_to_message.from.username.toLowerCase() === state.botUsername.toLowerCase();
    if (!mentioned && !repliedToBot) return;
    if (uname) text = text.replace(new RegExp(uname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "").trim();
  }
  if (!text) {
    await sendReply(token, chatId, "Put a question or task after the mention and I'll get on it. — Naxie", msg.message_id);
    return;
  }

  // Gate 2 of the approval protocol (action-approvals.ts) — a bare yes/no
  // reply to a just-presented approval is consumed HERE, before it would
  // otherwise be routed to the agent as a new message.
  const approvalReply = await handleApprovalReply(chatId, text);
  if (approvalReply !== null) {
    await sendReply(token, chatId, approvalReply, msg.message_id);
    state.processed += 1;
    return;
  }

  // Inbox commands — /approvals and /inbox show the waiting OrgTask inbox
  // with one-tap buttons, without routing the word to the agent as chatter.
  // Read-only everywhere allow-listed; approve/reject taps stay DM-only
  // (enforced in handleApprovalCallback).
  if (/^\/(approvals|inbox)(@\w+)?\s*$/.test(text)) {
    try {
      const { listOrgTasks } = await import("./org-tasks.js");
      const { listJobs } = await import("./jobs.js");
      const { toWaitingView, approvalKeyboard } = await import("./approval-telegram.js");
      const waiting = (listOrgTasks({ status: "waiting-on-approval" } as any) as any[]).slice(0, 5);
      const parked = listJobs().filter((j: any) => j.status === "awaiting-approval").slice(0, 5);
      if (!waiting.length && !parked.length) {
        await sendReply(token, chatId, "📥 Inbox is clear — nothing waiting on approval.", msg.message_id);
      } else {
        const views = waiting.map(toWaitingView);
        const lines = views.map((v, i) =>
          `${i + 1}. <b>${escapeHtml(v.title)}</b>\n   ${escapeHtml(v.actionDescription.slice(0, 160))}${v.hasDiff ? "\n   🛡️ <i>carries a code diff — review in app</i>" : ""}`);
        let n = lines.length;
        for (const j of parked) {
          n += 1;
          lines.push(`${n}. <b>${escapeHtml(String(j.title ?? j.kind ?? j.id))}</b> <i>(job, parked plan)</i>`);
        }
        const kb: any[][] = [...approvalKeyboard(views)];
        for (const j of parked.slice(0, 3)) {
          kb.push([
            { text: `✅ Job: ${String(j.title ?? j.kind ?? j.id).slice(0, 20)}`, callback_data: `approval:jobapprove:${j.id}` },
            { text: "❌", callback_data: `approval:jobreject:${j.id}` },
          ]);
        }
        // sendReply is text-only; the keyboard needs raw sendMessage.
        await tg(token, "sendMessage", {
          chat_id: chatId,
          text: `📥 Inbox — ${waiting.length + parked.length} waiting on approval\n\n${lines.join("\n")}`,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: kb },
        });
      }
    } catch (e: any) {
      await sendReply(token, chatId, "Couldn't read the inbox just now — try the Approvals page.", msg.message_id);
    }
    state.processed += 1;
    return;
  }

  // File search + staged sends — /find <name> lists matches, /send <name>
  // stages the best match behind a Send/Cancel confirm card. DM-ONLY: files
  // never move in groups, and nothing leaves the machine untapped.
  const fileCmd = text.match(/^\/(find|send)(@\w+)?\s+([\s\S]{1,200})$/);
  if (fileCmd) {
    const [, cmd, , query] = fileCmd;
    if (isGroup) {
      await sendReply(token, chatId, "Files only move in your DM with the bot — ask me there.", msg.message_id);
    } else {
      try {
        await handleFileCommand(token, chatId, cmd as "find" | "send", query.trim(), msg.message_id);
      } catch (e: any) {
        await sendReply(token, chatId, `File search hit a snag: ${String(e?.message ?? e).slice(0, 160)}`, msg.message_id);
      }
    }
    state.processed += 1;
    return;
  }

  // Typing indicator while we work (Telegram clears it after ~5s; best-effort).
  void tg(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  try {
    const history = historyFor(chatId);
    const messages = [...history, { role: "user" as const, content: text }];
    // First point of contact is Naxie (your PA) — she triages and delegates.
    // Override with NAXION_TELEGRAM_PERSONA if you want a different
    // specialist to own Telegram (e.g. "naxie-agent", "it-support").
    const persona = (process.env.NAXION_TELEGRAM_PERSONA ?? "naxie").trim() || "naxie";
    const r = await apiPost("/api/chat", { messages, persona });
    let answer = "";
    if (r?.kind === "message") {
      answer = String(r.text ?? "").trim() || "I couldn't process that request.";
    } else if ((r?.kind === "task" || r?.kind === "approval") && r.jobId) {
      if (r.kind === "approval" || r.requiresApproval) {
        answer = await presentApproval(chatId, String(r.jobId), r.text);
      } else {
        const j = await pollJob(String(r.jobId));
        answer = String(j?.result?.answer ?? "").trim() || (j?.error ? `The task hit an error: ${j.error}` : "I wasn't able to produce an answer for that one.");
      }
    } else {
      answer = String(r?.text ?? r?.error ?? "").trim() || "I couldn't process that request.";
    }
    appendHistory(chatId, "user", text);
    appendHistory(chatId, "assistant", answer);
    await sendReply(token, chatId, answer, msg.message_id);
    state.processed += 1;
  } catch (e: any) {
    console.error(`[telegram] processUpdate failed for chat ${chatId}: ${e?.stack ?? e}`);
    try { await sendReply(token, chatId, "Something went wrong handling that — try again in a moment.", msg.message_id); } catch { /* ignore */ }
  }
}

// Long-poll loop. Drains any backlog to "now" on start (so a restart doesn't
// replay old messages), then processes new updates as they arrive.
export async function startTelegramBridge(): Promise<void> {
  if (state.running) return;
  // Spawned workers carry NAXION_PARENT_PID and are ephemeral (recycled by
  // the pool). The single getUpdates poller must live on the STABLE primary, so
  // a worker never hosts it. (`role` defaults to "primary" (config.ts) so the
  // role check alone wouldn't exclude a worker whose role env is unset.)
  if (process.env.NAXION_PARENT_PID) return;
  if (process.env.NAXION_TELEGRAM_INBOUND === "0") { console.log("[telegram] inbound disabled (NAXION_TELEGRAM_INBOUND=0)"); return; }
  const token = await getBotToken();
  if (!token) { console.log("[telegram] no bot token (connect Telegram on the Integrations page) — inbound bridge not started"); return; }
  const allow = await allowedChats();
  if (allow.size === 0) {
    console.log("[telegram] no allow-listed chats — inbound DISABLED (set NAXION_TELEGRAM_ALLOWED_CHATS, or a numeric default chat id on the Integrations page). Outbound (telegram.send) still works.");
    return;
  }
  // Validate the token + learn the bot username (needed for group mentions).
  // Retry a few times — at server boot outbound DNS/network can be cold.
  let me: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    me = await tg(token, "getMe", {});
    if (me?.ok) break;
    if (attempt < 3) await sleep(2000 * attempt);
  }
  if (!me?.ok) {
    state.lastError = me?.description ?? "getMe failed";
    console.warn(`[telegram] inbound bridge not started — getMe failed: ${state.lastError} (check the bot token on the Integrations page)`);
    return;
  }
  // Single-poller guard — bail if another live process already polls this bot.
  if (!tryAcquireLock()) {
    console.log("[telegram] another process already polls getUpdates for this bot — not starting a second poller (single-consumer).");
    return;
  }
  state.botUsername = me.result?.username;
  state.running = true;
  abort = false;
  state.startedAt = new Date().toISOString();
  console.log(`[telegram] inbound bridge live as @${state.botUsername} — ${allow.size} allow-listed chat(s)`);

  const pollTimeout = Math.max(1, Math.min(50, Number(process.env.NAXION_TELEGRAM_POLL_TIMEOUT_S ?? "25")));
  let offset: number | undefined;
  // Drain backlog to now: confirm everything up to the latest update without
  // processing it, so a restart doesn't replay a day of old messages.
  try {
    const drain = await tg(token, "getUpdates", { offset: -1, limit: 1 }, 10_000);
    if (drain?.ok && Array.isArray(drain.result) && drain.result.length) {
      offset = drain.result[drain.result.length - 1].update_id + 1;
    }
  } catch { /* start from undefined offset */ }

  void (async () => {
    while (!abort) {
      refreshLock(); // keep the single-poller lease alive
      // Offline mode: pause the long-poll quietly instead of erroring every
      // few seconds; resumes on its own once the operator goes back online.
      if (isOffline()) { state.lastError = "offline mode — paused"; await sleep(15_000); continue; }
      try {
        const res = await tg(token, "getUpdates", { offset, timeout: pollTimeout, allowed_updates: ["message", "channel_post", "callback_query"] }, (pollTimeout + 10) * 1000);
        if (res?.ok && Array.isArray(res.result)) {
          for (const update of res.result) {
            offset = update.update_id + 1;
            // Re-read the allow-list each batch so a change on the Integrations
            // page takes effect without a restart.
            await processUpdate(token, await allowedChats(), update).catch((e: any) =>
              console.error(`[telegram] update ${update.update_id} rejected: ${e?.stack ?? e}`));
          }
        } else if (res && res.ok === false) {
          // 409 = a webhook is set (getUpdates can't be used alongside it).
          state.lastError = res.description ?? "getUpdates error";
          if (/conflict|webhook/i.test(String(res.description))) {
            console.warn("[telegram] getUpdates conflict — a webhook is set on this bot. deleteWebhook to use polling. Backing off 60s.");
            await sleep(60_000);
          } else {
            await sleep(5_000);
          }
        }
      } catch (e: any) {
        // Long-poll abort/network blip — brief backoff, keep going.
        state.lastError = String(e?.message ?? e);
        await sleep(3_000);
      }
    }
    releaseLock();
    state.running = false;
    console.log("[telegram] inbound bridge stopped");
  })();
}

export function stopTelegramBridge(): void {
  abort = true;
  state.running = false;
  releaseLock();
}
