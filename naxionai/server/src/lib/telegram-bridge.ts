// Telegram bridge — lets a user (or a group) talk to Neuro over Telegram.
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
// chats on the allow-list (NEUROWORKS_TELEGRAM_ALLOWED_CHATS, union the
// integration's default chat id). Empty allow-list ⇒ inbound DISABLED (outbound
// still works). Fail-safe: an open bridge would let anyone who finds the bot
// drive jobs against the user's machine and vault.
//
// In GROUPS the bot only acts when @mentioned or replied-to (so it isn't a
// firehose), and the mention is stripped before the text reaches the agent.
//
// Config (env):
//   NEUROWORKS_TELEGRAM_INBOUND=0        hard-disable inbound (default on)
//   NEUROWORKS_TELEGRAM_ALLOWED_CHATS    comma list of chat ids allowed to drive
//   NEUROWORKS_TELEGRAM_POLL_TIMEOUT_S   long-poll seconds (default 25)
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
// to "primary" (config.ts), so a worker spawned without NEUROWORKS_ROLE would
// otherwise start a SECOND bridge. This lock guarantees exactly one poller
// across all local processes: a heartbeat'd lock file whose owner is a live PID.
const STATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.neuroworks");
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

// Shared outbound send — the ONE place that calls Telegram's sendMessage API.
// Used by the telegram.send agent tool (primitives.ts) AND by background
// schedulers (reflection.ts, innovation-scan.ts, todo-brief.ts) that push a finished
// report to the operator's default chat without going through the agent
// loop. Defaults to the integration's saved chat id; pass chatId to override.
//
// All Naxie texts must look nice: markdown is auto-converted to rich Telegram HTML
// (bold, italic, code, links, headings → bold) with chunking + plain-text fallback
// so no report lands as raw `**` / `##` noise.
// Inline keyboards: pass `keyboard` as Telegram inline_keyboard array for one-tap actions.
export async function sendTelegramMessage(text: string, chatId?: string, keyboard?: any[][]): Promise<{ ok: boolean; error?: string; messageId?: number }> {
  const { getConnectionByProvider } = await import("./integrations.js");
  const conn = getConnectionByProvider("telegram");
  if (!conn?.secrets?.botToken) return { ok: false, error: "no Telegram connection — add one on the Integrations page" };
  const botToken = stripToken(conn.secrets.botToken);
  const chat = String(chatId ?? conn.config?.chatId ?? "").trim();
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

// Effective allow-list: env chat ids UNION the integration's default chat id, so
// setting a default chat on the Integrations page is enough to use the bridge
// with no extra env. All compared as strings.
async function allowedChats(): Promise<Set<string>> {
  const set = new Set<string>();
  for (const c of (process.env.NEUROWORKS_TELEGRAM_ALLOWED_CHATS ?? "").split(",").map(s => s.trim()).filter(Boolean)) set.add(c);
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

    const m = data.match(/^email:(respond|snooze|ignore|confirm_send|edit|handle_all):?(.*)$/);
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
        text: `📝 *Draft Response to ${entry.sender}:*\n\n${draft}\n\nShall I send this?`,
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
    const m = data.match(/^todo:(done|snooze):(.+)$/);
    if (!m) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: "Unknown action" });
      return;
    }
    const [, action, taskId] = m;
    // Direct my-tasks store edit (cross-owner search)
    try {
      const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      const { resolve, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const storePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.neuroworks/my-tasks.json");
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
      } else if (action === "snooze") {
        const tmr = new Date(); tmr.setDate(tmr.getDate()+1);
        const ymd = `${tmr.getFullYear()}-${String(tmr.getMonth()+1).padStart(2,"0")}-${String(tmr.getDate()).padStart(2,"0")}`;
        it.dueDate = ymd;
        writeFileSync(storePath, JSON.stringify(parsed, null, 2));
        await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: `⏰ Snoozed to ${ymd}` });
        void tg(token, "sendMessage", { chat_id: chatId, text: `⏰ Snoozed to <b>${ymd}</b>: ${escapeHtml(String(it.title).slice(0,120))}`, parse_mode: "HTML" }).catch(() => {});
      }
    } catch (e: any) {
      await tg(token, "answerCallbackQuery", { callback_query_id: cbId, text: `Failed: ${String(e?.message ?? e).slice(0,60)}` });
    }
  } catch (e: any) { console.warn(`[telegram] callback failed: ${e?.message ?? e}`); }
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
    return handleTodoCallback(token, allow, update.callback_query);
  }
  const msg = update.message ?? update.channel_post;
  if (!msg || typeof msg.text !== "string") return; // ignore non-text (stickers, joins, edits…)
  const chat = msg.chat ?? {};
  const chatId = String(chat.id);
  const isGroup = chat.type === "group" || chat.type === "supergroup";

  // ── Telegram news monitor — silently capture all messages from monitor groups ──
  // These messages are NOT routed to /api/chat and NOT replied to in the group.
  // They land in the pending queue for batch LLM scoring (telegram-news-monitor.ts).
  try {
    const { isMonitorEnabled, monitorGroups, capturePost } = await import("./telegram-news-monitor.js");
    if (isMonitorEnabled() && monitorGroups().includes(chatId)) {
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

  let text = msg.text.trim();

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
    await sendReply(token, chatId, "Put a question or task after the mention and I'll get on it. — Neuro", msg.message_id);
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

  // Typing indicator while we work (Telegram clears it after ~5s; best-effort).
  void tg(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  try {
    const history = historyFor(chatId);
    const messages = [...history, { role: "user" as const, content: text }];
    // First point of contact is Naxie (your PA) — she triages and delegates.
    // Override with NEUROWORKS_TELEGRAM_PERSONA if you want a different
    // specialist to own Telegram (e.g. "clawbot", "it-support").
    const persona = (process.env.NEUROWORKS_TELEGRAM_PERSONA ?? "naxie").trim() || "naxie";
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
  // Spawned workers carry NEUROWORKS_PARENT_PID and are ephemeral (recycled by
  // the pool). The single getUpdates poller must live on the STABLE primary, so
  // a worker never hosts it. (`role` defaults to "primary" (config.ts) so the
  // role check alone wouldn't exclude a worker whose role env is unset.)
  if (process.env.NEUROWORKS_PARENT_PID) return;
  if (process.env.NEUROWORKS_TELEGRAM_INBOUND === "0") { console.log("[telegram] inbound disabled (NEUROWORKS_TELEGRAM_INBOUND=0)"); return; }
  const token = await getBotToken();
  if (!token) { console.log("[telegram] no bot token (connect Telegram on the Integrations page) — inbound bridge not started"); return; }
  const allow = await allowedChats();
  if (allow.size === 0) {
    console.log("[telegram] no allow-listed chats — inbound DISABLED (set NEUROWORKS_TELEGRAM_ALLOWED_CHATS, or a numeric default chat id on the Integrations page). Outbound (telegram.send) still works.");
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

  const pollTimeout = Math.max(1, Math.min(50, Number(process.env.NEUROWORKS_TELEGRAM_POLL_TIMEOUT_S ?? "25")));
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
