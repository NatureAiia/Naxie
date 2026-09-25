// WhatsApp bridge (Baileys) — lets Naxie see messages sent to the Variety &
// Co business number (+263716031399) and helps the operator work them,
// WITHOUT auto-replying to customers. Unlike telegram-bridge.ts (which routes
// straight to /api/chat and answers), this is TRIAGE-ONLY by design: every
// inbound 1:1 message becomes a CRM contact + activity and a Telegram
// notification with Respond/Ignore buttons. Naxie only drafts a reply after
// the operator taps Respond, and only sends after the operator confirms.
// Mirrors email.ts's triageMode flow (see handleEmailCallback in
// telegram-bridge.ts) rather than the Telegram bridge's direct-drive flow.
//
// Baileys (github.com/WhiskeySockets/Baileys) is an UNOFFICIAL WhatsApp Web
// client — it emulates a linked device, not Meta's Cloud API. Risks the
// operator accepted: Meta can ban a number that looks automated/spammy;
// there's no vendor support if a WhatsApp protocol change breaks it. Kept
// strictly to Variety & Co's own business number, one connection at a time.
//
// Pairing: first run prints a QR code to the server console/logs. Scan it
// from WhatsApp > Linked Devices on +263716031399. Session persists under
// .neuroworks/whatsapp-session/ so subsequent restarts reconnect silently.
//
// Config (env):
//   NEUROWORKS_WHATSAPP_INBOUND=0   hard-disable the bridge (default on)
// Outbound (whatsapp.send / whatsapp.broadcast primitives, and the
// Respond → confirm_send flow here) all go through sendWhatsAppMessage below.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { config } from "../config.js";

const BASE = `http://127.0.0.1:${config.port}`;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const STATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../.neuroworks");
const SESSION_DIR = resolve(STATE_DIR, "whatsapp-session");
const TRIAGE_PATH = resolve(STATE_DIR, "whatsapp-triage.json");
const LOCK_FILE = resolve(STATE_DIR, "whatsapp-poller.lock");
const LOCK_TTL_MS = 90_000;

// ── Single-connection lock — same reasoning as telegram-bridge.ts: a second
// process opening the same Baileys session would fight the first for the
// socket and both would get logged out / conflict. ──
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
      if (fresh && j.pid !== process.pid && pidAlive(Number(j.pid))) return false;
    }
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
    ownLock = true;
    return true;
  } catch { return true; }
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
  connected: boolean;
  phoneNumber?: string;
  startedAt?: string;
  lastError?: string;
  processed: number;
  qrDataUrl?: string;   // scannable <img> source for the pairing UI — cleared once connected
  qrUpdatedAt?: string;
};
const state: BridgeState = { running: false, connected: false, processed: 0 };
export function getWhatsAppBridgeStatus(): BridgeState {
  return { ...state };
}

// Pending triage count — surfaced on the pairing/status page so the operator
// can see "3 messages waiting" without leaving the page for Telegram.
export function pendingTriageCount(): number {
  return Object.values(loadTriageStore()).filter(e => e.status !== "resolved").length;
}

// ── Triage store — mirrors email.ts's TriageEntry shape/persistence. ──
export type WhatsAppTriageEntry = {
  jid: string;             // e.g. "263771234567@s.whatsapp.net"
  phone: string;           // bare digits, e.g. "263771234567"
  name?: string;
  body: string;
  draftBody?: string;
  status: "pending" | "resolved" | "awaiting_edit";
  receivedAt: string;
  awaitingEditChatId?: string;
};
export function loadTriageStore(): Record<string, WhatsAppTriageEntry> {
  try {
    if (!existsSync(TRIAGE_PATH)) return {};
    return JSON.parse(readFileSync(TRIAGE_PATH, "utf8"));
  } catch { return {}; }
}
export function saveTriageStore(store: Record<string, WhatsAppTriageEntry>): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(TRIAGE_PATH, JSON.stringify(store, null, 2));
}

function jidToPhone(jid: string): string {
  return jid.split("@")[0].split(":")[0];
}
export function phoneToJid(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}

// The live socket, set once startWhatsAppBridge() connects. Outbound calls
// (send/broadcast/confirm_send) all go through this — there is only ever one.
let sock: any = null;
let abort = false;
let lockInterval: ReturnType<typeof setInterval> | null = null;

// ── Human-pattern shaping ──
// Meta's abuse detection flags exactly what a naive bot looks like: instant
// sends, zero presence signal, identical timing, no read receipts, an
// always-online socket. None of this hides that a bridge exists — it just
// avoids the specific behavioral tells that get a business number flagged,
// the same way a careful human assistant working the phone would behave.
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

// Shared outbound send — the ONE place that calls Baileys' sendMessage.
// Accepts either a bare phone number or a full jid. Shows "typing…" for a
// duration proportional to the message length before sending, like a person
// actually composing it, instead of the message appearing instantly.
export async function sendWhatsAppMessage(to: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!sock || !state.connected) return { ok: false, error: "WhatsApp is not connected — scan the QR code printed at server startup" };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "text is required" };
  const jid = to.includes("@") ? to : phoneToJid(to);
  try {
    await sock.presenceSubscribe(jid).catch(() => {});
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    const typingMs = Math.min(6000, Math.max(900, trimmed.length * jitter(35, 55)));
    await sleep(typingMs);
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
    await sock.sendMessage(jid, { text: trimmed });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `whatsapp send failed: ${e?.message ?? e}` };
  }
}

async function apiPost(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return await r.json().catch(() => ({}));
}

// ── Telegram callback handling (whatsapp:respond|confirm_send|edit|ignore:id) ──
// Dispatched from telegram-bridge.ts's processUpdate, same shape as
// handleEmailCallback there.
export async function handleWhatsAppCallback(token: string, allow: Set<string>, cb: any): Promise<void> {
  try {
    const data: string = String(cb.data ?? "");
    const chatId = String(cb.message?.chat?.id ?? cb.from?.id ?? "");
    if (!allow.has(chatId)) return;
    const cbId = String(cb.id ?? "");
    const { escapeHtml } = await import("./telegram-bridge.js");

    async function tg(method: string, params: Record<string, unknown>): Promise<any> {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
        });
        return await r.json().catch(() => ({}));
      } catch { return {}; }
    }

    void tg("answerCallbackQuery", { callback_query_id: cbId, text: "Processing…" }).catch(() => {});

    const m = data.match(/^whatsapp:(respond|ignore|confirm_send|edit):(.+)$/);
    if (!m) return;
    const [, action, triageId] = m;
    const store = loadTriageStore();
    const entry = store[triageId];
    if (!entry) {
      await tg("answerCallbackQuery", { callback_query_id: cbId, text: "Message not found in triage store" });
      return;
    }

    if (action === "ignore") {
      delete store[triageId];
      saveTriageStore(store);
      await tg("answerCallbackQuery", { callback_query_id: cbId, text: "Ignored" });
      void tg("sendMessage", { chat_id: chatId, text: `🗑️ Ignored WhatsApp message from ${escapeHtml(entry.name || entry.phone)}`, parse_mode: "HTML" }).catch(() => {});
    } else if (action === "respond") {
      const r = await apiPost("/api/chat", {
        messages: [
          { role: "system", content: "You are Naxie, drafting a WhatsApp reply on behalf of Variety & Co (tech repair/support/products). Keep it short, friendly, and businesslike — this is a real customer conversation over WhatsApp, not an email." },
          { role: "user", content: `Draft a reply to this WhatsApp message from ${entry.name || entry.phone}:\n\n${entry.body}` },
        ],
        persona: "naxie",
      });
      const draft = String(r?.text ?? "").trim() || "I couldn't generate a draft.";
      const current = loadTriageStore();
      if (current[triageId]) { current[triageId].draftBody = draft; saveTriageStore(current); }
      await tg("answerCallbackQuery", { callback_query_id: cbId, text: "Draft generated" });
      await tg("sendMessage", {
        chat_id: chatId,
        text: `📝 <b>Draft reply to ${escapeHtml(entry.name || entry.phone)}:</b>\n\n${escapeHtml(draft)}\n\nShall I send this on WhatsApp?`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[
          { text: "✅ Send", callback_data: `whatsapp:confirm_send:${triageId}` },
          { text: "✏️ Edit", callback_data: `whatsapp:edit:${triageId}` },
          { text: "❌ Ignore", callback_data: `whatsapp:ignore:${triageId}` },
        ]] },
      });
    } else if (action === "confirm_send") {
      if (!entry.draftBody) {
        await tg("answerCallbackQuery", { callback_query_id: cbId, text: "No draft found" });
        return;
      }
      const r = await sendWhatsAppMessage(entry.jid, entry.draftBody);
      if (r.ok) {
        delete store[triageId];
        saveTriageStore(store);
        try {
          const { logActivity, upsertContact } = await import("./crm.js");
          const contact = upsertContact({ phone: entry.phone, name: entry.name, source: "whatsapp" });
          logActivity({ contactId: contact.id, kind: "whatsapp", body: `Sent: ${entry.draftBody}`.slice(0, 500) });
        } catch { /* CRM logging is best-effort */ }
        await tg("answerCallbackQuery", { callback_query_id: cbId, text: "Sent!" });
        void tg("sendMessage", { chat_id: chatId, text: `✅ Sent on WhatsApp to ${escapeHtml(entry.name || entry.phone)}`, parse_mode: "HTML" }).catch(() => {});
      } else {
        await tg("answerCallbackQuery", { callback_query_id: cbId, text: `Failed: ${String(r.error ?? "").slice(0, 60)}` });
      }
    } else if (action === "edit") {
      entry.status = "awaiting_edit";
      entry.awaitingEditChatId = chatId;
      saveTriageStore(store);
      await tg("answerCallbackQuery", { callback_query_id: cbId, text: "Send your edited version" });
      void tg("sendMessage", { chat_id: chatId, text: `✏️ Send your edited version for <b>${escapeHtml(entry.name || entry.phone)}</b> as your next message here, and I'll stage it for sending.`, parse_mode: "HTML" }).catch(() => {});
    }
  } catch (e: any) {
    console.warn(`[whatsapp] callback failed: ${e?.message ?? e}`);
  }
}

// Edit-capture — called from telegram-bridge.ts's processUpdate the same way
// as the email triage edit-capture block, BEFORE a free-text message is
// otherwise handled. Returns true if it consumed the message (chat had an
// entry in awaiting_edit for this chatId).
export async function tryCaptureWhatsAppEdit(chatId: string, text: string): Promise<boolean> {
  const store = loadTriageStore();
  const awaiting = Object.entries(store).find(([, e]) => e.status === "awaiting_edit" && (e.awaitingEditChatId ?? chatId) === chatId);
  if (!awaiting) return false;
  const [triageId, entry] = awaiting;
  entry.draftBody = text;
  entry.status = "pending";
  delete entry.awaitingEditChatId;
  saveTriageStore(store);
  const { sendTelegramMessage } = await import("./telegram-bridge.js");
  await sendTelegramMessage(
    `📝 *Staged edited reply to ${entry.name || entry.phone}:*\n\n${text.slice(0, 1500)}${text.length > 1500 ? "…" : ""}\n\nShall I send this on WhatsApp?`,
    chatId,
    [[
      { text: "✅ Send", callback_data: `whatsapp:confirm_send:${triageId}` },
      { text: "✏️ Edit again", callback_data: `whatsapp:edit:${triageId}` },
    ]],
  );
  return true;
}

async function handleInboundMessage(jid: string, name: string | undefined, body: string): Promise<void> {
  const phone = jidToPhone(jid);
  const triageId = `${phone}:${Date.now()}`;
  const store = loadTriageStore();
  store[triageId] = { jid, phone, name, body, status: "pending", receivedAt: new Date().toISOString() };
  saveTriageStore(store);
  state.processed += 1;

  // CRM linkage — every inbound WhatsApp message becomes a contact + activity,
  // the same free ride email-inbound.ts gives IMAP mail. Best-effort: a CRM
  // failure must never block the actual triage notification.
  try {
    const { upsertContact, logActivity } = await import("./crm.js");
    const contact = upsertContact({ phone, name, source: "whatsapp" });
    logActivity({ contactId: contact.id, kind: "whatsapp", body: `Received: ${body}`.slice(0, 500) });
  } catch (e: any) { console.warn(`[whatsapp] CRM linkage failed: ${e?.message ?? e}`); }

  try {
    const { sendTelegramMessage } = await import("./telegram-bridge.js");
    await sendTelegramMessage(
      `💬 *New WhatsApp message*\n\n*From:* ${name ? `${name} (${phone})` : phone}\n\n${body.slice(0, 300)}${body.length > 300 ? "..." : ""}\n\nHow should I handle this?`,
      undefined,
      [[
        { text: "Respond", callback_data: `whatsapp:respond:${triageId}` },
        { text: "Ignore", callback_data: `whatsapp:ignore:${triageId}` },
      ]],
    );
  } catch (e: any) { console.warn(`[whatsapp] triage notify failed: ${e?.message ?? e}`); }
}

// Connect (or reconnect) to WhatsApp. Primary-only, single-connection-locked,
// prints a QR to the console on first pairing, persists the session so a
// restart reconnects silently afterwards.
export async function startWhatsAppBridge(): Promise<void> {
  if (state.running) return;
  if (process.env.NEUROWORKS_PARENT_PID) return; // ephemeral worker — never hosts the bridge
  if (process.env.NEUROWORKS_WHATSAPP_INBOUND === "0") { console.log("[whatsapp] inbound disabled (NEUROWORKS_WHATSAPP_INBOUND=0)"); return; }
  if (!tryAcquireLock()) {
    console.log("[whatsapp] another process already holds the WhatsApp session lock — not starting a second connection.");
    return;
  }

  let baileys: any;
  try {
    baileys = await import("@whiskeysockets/baileys");
  } catch (e: any) {
    console.warn(`[whatsapp] @whiskeysockets/baileys not installed — bridge not started: ${e?.message ?? e}`);
    releaseLock();
    return;
  }
  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
  const pino = (await import("pino")).default;
  const qrcode = (await import("qrcode-terminal")).default;
  const QRCode = await import("qrcode");

  mkdirSync(SESSION_DIR, { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  state.running = true;
  state.startedAt = new Date().toISOString();

  function connect(): void {
    sock = makeWASocket({
      auth: authState,
      version,
      logger: pino({ level: "silent" }),
      syncFullHistory: false,
      // A bridge that's always "online" is itself a bot tell — a real phone
      // goes online/offline as the owner uses it. We surface presence only
      // around an actual send (sendWhatsAppMessage's composing/paused pair).
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log("[whatsapp] scan this QR code from WhatsApp > Linked Devices on +263716031399:");
        qrcode.generate(qr, { small: true });
        // Also render it as an <img>-ready data URL for the web pairing page
        // (Extensions/Connectors nav → WhatsApp) — the console QR above still
        // works standalone, this is just a second surface for the same code.
        QRCode.toDataURL(qr, { width: 280, margin: 1 })
          .then((url: string) => { state.qrDataUrl = url; state.qrUpdatedAt = new Date().toISOString(); })
          .catch((e: any) => console.warn(`[whatsapp] QR image render failed: ${e?.message ?? e}`));
      }
      if (connection === "open") {
        state.connected = true;
        state.phoneNumber = sock.user?.id ? jidToPhone(String(sock.user.id)) : undefined;
        state.qrDataUrl = undefined;
        state.qrUpdatedAt = undefined;
        console.log(`[whatsapp] connected as ${state.phoneNumber ?? "unknown number"}`);
      } else if (connection === "close") {
        state.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        state.lastError = lastDisconnect?.error?.message ?? "connection closed";
        if (loggedOut) {
          console.warn("[whatsapp] logged out — delete .neuroworks/whatsapp-session/ and restart to re-pair with a fresh QR code.");
          state.running = false;
          releaseLock();
        } else if (!abort) {
          console.warn(`[whatsapp] connection closed (${state.lastError}) — reconnecting…`);
          void sleep(3000).then(connect);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }: any) => {
      if (type !== "notify") return;
      for (const msg of messages ?? []) {
        try {
          if (!msg.message || msg.key?.fromMe) continue;
          const jid: string = msg.key?.remoteJid ?? "";
          if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue; // 1:1 chats only — group/status/channel noise stays out of triage
          const text: string =
            msg.message.conversation ??
            msg.message.extendedTextMessage?.text ??
            msg.message.imageMessage?.caption ??
            msg.message.videoMessage?.caption ??
            "";
          if (!text.trim()) continue; // non-text (stickers, media w/o caption, reactions) — ignore
          const name: string | undefined = msg.pushName || undefined;
          // Delayed, randomized read receipt — an instant blue-tick on every
          // inbound message is another bot tell; a person checks their phone
          // some seconds later. Best-effort: never blocks triage on failure.
          void sleep(jitter(2000, 9000)).then(() => sock?.readMessages([msg.key])).catch(() => {});
          await handleInboundMessage(jid, name, text.trim());
        } catch (e: any) {
          console.error(`[whatsapp] failed to handle inbound message: ${e?.stack ?? e}`);
        }
      }
    });
  }

  abort = false;
  connect();

  // Keep the single-connection lock fresh for as long as this process holds it.
  lockInterval = setInterval(refreshLock, 30_000);
  lockInterval.unref();

  console.log("[whatsapp] bridge starting — waiting for connection/QR…");
}

export function stopWhatsAppBridge(): void {
  abort = true;
  if (lockInterval) { clearInterval(lockInterval); lockInterval = null; }
  try { sock?.end?.(undefined); } catch { /* tolerate */ }
  sock = null;
  state.running = false;
  state.connected = false;
  state.qrDataUrl = undefined;
  state.qrUpdatedAt = undefined;
  releaseLock();
}

// Manual rescan — the operator can ask Naxie (in Telegram or the web chat) to
// "reconnect WhatsApp" at any time: e.g. the linked device got removed from
// the phone, the number changed, or the session just looks stuck. Tears down
// the live connection, wipes the persisted session so Baileys can't try to
// resume stale creds, then restarts the bridge, which prints a brand-new QR
// to the console the same as a first-time pairing.
export async function resetAndReconnectWhatsApp(): Promise<{ ok: boolean; error?: string }> {
  try {
    stopWhatsAppBridge();
    if (existsSync(SESSION_DIR)) rmSync(SESSION_DIR, { recursive: true, force: true });
    await startWhatsAppBridge();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `whatsapp reconnect failed: ${e?.message ?? e}` };
  }
}
