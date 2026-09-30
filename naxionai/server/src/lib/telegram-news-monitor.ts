// Telegram news monitor — silently watches configured groups for all posts,
// scores each for relevance against operator interests/sector/memory via LLM,
// and sends a Telegram DM notification when something important is found.
//
// Messages from monitor groups are captured by the existing telegram-bridge
// (processUpdate) but NOT routed to /api/chat — instead they land in a
// pending queue scored in batch by the org-daemon tick.
//
// Config (env):
//   NAXION_TELEGRAM_MONITOR_GROUPS     comma-separated chat IDs to watch
//   NAXION_TELEGRAM_NOTIFY_CHAT        your DM chat ID for notifications
//   NAXION_TELEGRAM_MONITOR_ENABLED    1/0 (default 0)
//   NAXION_TELEGRAM_MONITOR_INTERVAL   minutes between batch scoring (default 5)
//   NAXION_TELEGRAM_MONITOR_THRESHOLD  relevance score 0-10 to notify (default 7)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = join(process.cwd(), ".neuroworks");
const SEEN_FILE = join(STATE_DIR, "telegram-news-seen.json");
const MAX_SEEN = 2000;

// ── Config ──

export function isMonitorEnabled(): boolean {
  return process.env.NAXION_TELEGRAM_MONITOR_ENABLED === "1" && monitorGroups().length > 0;
}

export function monitorGroups(): string[] {
  return (process.env.NAXION_TELEGRAM_MONITOR_GROUPS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
}

function notifyChatId(): string {
  return (process.env.NAXION_TELEGRAM_NOTIFY_CHAT ?? "").trim();
}

function scoreThreshold(): number {
  const v = Number(process.env.NAXION_TELEGRAM_MONITOR_THRESHOLD ?? "7");
  return Math.max(0, Math.min(10, v));
}

export function monitorIntervalMinutes(): number {
  const v = Number(process.env.NAXION_TELEGRAM_MONITOR_INTERVAL ?? "5");
  return Math.max(1, Math.min(60, v));
}

// ── Pending queue (in-memory, scored in batch) ──

export type PendingPost = {
  messageId: number;
  chatId: string;
  chatName: string;
  text: string;
  senderName: string;
  timestamp: string;
  capturedAt: string;
  url?: string;                       // external items only — Telegram posts have no canonical URL
  categories?: string[];              // external items only — free-form tags from the source
  source?: "telegram" | "external";   // undefined = telegram (the original/only caller before ingestExternalItem)
};

let pending: PendingPost[] = [];

export function capturePost(post: PendingPost): void {
  if (isSeen(post.messageId, post.chatId)) return;
  markSeen(post.messageId, post.chatId);
  pending.push(post);
}

export function pendingCount(): number {
  return pending.length;
}

// ── External (non-Telegram) ingest ──
// Lets an outside source — an RSS/news aggregator, a partner feed, anything
// that isn't the Telegram bridge — push one item into the exact same
// pending/scoring/notify pipeline Telegram posts use. See
// routes/agent-ingest.ts for the HTTP surface that calls this.

export type ExternalNewsItem = {
  title: string;
  url: string;
  abstract: string;
  source_name: string;
  categories?: string[];
};

// djb2 — deterministic, no dependency, good enough to dedup a URL against
// PendingPost's numeric messageId field (a shape built for Telegram's own
// message ids, which are also just numbers with no cross-source meaning).
function stableIntHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function ingestExternalItem(item: ExternalNewsItem):
  | { ok: true; queued: boolean; chatId: string; messageId: number }
  | { ok: false; error: string } {
  const title = String(item?.title ?? "").trim();
  const url = String(item?.url ?? "").trim();
  const abstract = String(item?.abstract ?? "").trim();
  const sourceName = String(item?.source_name ?? "").trim();
  if (!title || !url || !sourceName) {
    return { ok: false, error: "title, url, and source_name are required" };
  }
  // Namespaced so an external source's ids can never collide with a real
  // Telegram chat id (those are numeric strings like "-1001234567890").
  const chatId = `external:${sourceName}`;
  const messageId = stableIntHash(url);
  const alreadySeen = isSeen(messageId, chatId);
  capturePost({
    messageId,
    chatId,
    chatName: sourceName,
    text: [title, abstract].filter(Boolean).join("\n\n"),
    senderName: sourceName,
    timestamp: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    url,
    categories: Array.isArray(item.categories) ? item.categories.slice(0, 10).map(c => String(c).slice(0, 60)) : undefined,
    source: "external",
  });
  return { ok: true, queued: !alreadySeen, chatId, messageId };
}

// ── Seen dedup (persisted to disk) ──

type SeenEntry = { messageId: number; chatId: string; ts: number };
let seen: SeenEntry[] = [];

function loadSeen(): void {
  try {
    if (existsSync(SEEN_FILE)) {
      seen = JSON.parse(readFileSync(SEEN_FILE, "utf8"));
    }
  } catch { seen = []; }
}

function saveSeen(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // Trim to MAX_SEEN oldest-first
    if (seen.length > MAX_SEEN) seen = seen.slice(-MAX_SEEN);
    writeFileSync(SEEN_FILE, JSON.stringify(seen), "utf8");
  } catch { /* best-effort */ }
}

function isSeen(messageId: number, chatId: string): boolean {
  if (seen.length === 0) loadSeen();
  return seen.some(e => e.messageId === messageId && e.chatId === chatId);
}

function markSeen(messageId: number, chatId: string): void {
  if (seen.length === 0) loadSeen();
  seen.push({ messageId, chatId, ts: Date.now() });
  saveSeen();
}

// ── Relevance scoring ──

type ScoreResult = {
  score: number;
  reason: string;
  summary: string;
};

function buildScoringPrompt(posts: PendingPost[], operatorContext: string): string {
  const postsBlock = posts.map((p, i) => {
    const meta = p.categories?.length ? ` [categories: ${p.categories.join(", ")}]` : "";
    return `[${i + 1}] From "${p.chatName}" by ${p.senderName} at ${p.timestamp}${meta}:\n${p.text.slice(0, 1500)}`;
  }).join("\n\n");

  return `You are Naxie, a personal AI assistant. Score each Telegram post below for relevance to the operator (0-10).

Operator context:
${operatorContext}

Posts to score:
${postsBlock}

For EACH post, respond with a JSON array of objects, one per post, in the same order:
[{"idx": 1, "score": <0-10>, "reason": "<one sentence why relevant or not>", "summary": "<if score >= 7, 1-2 sentence summary of the news>; if score < 7, empty string"}]

Scoring guide:
- 9-10: Directly about the operator's sector, company, or a specific interest
- 7-8: Related to operator's interests or sector with actionable implications
- 5-6: Tangentially related, general industry noise
- 3-4: Unrelated but from the same domain (tech, business)
- 0-2: Completely irrelevant (personal chat, memes, off-topic)

Respond with ONLY the JSON array, no markdown fences, no explanation.`;
}

async function buildOperatorContext(): Promise<string> {
  const parts: string[] = [];

  // Operator identity
  try {
    const { getOperatorIdentity } = await import("./mag.js");
    const op = getOperatorIdentity();
    parts.push(`Name: ${op.name}`);
    if (op.sector) parts.push(`Sector: ${op.sector}`);
    if (op.orgName) parts.push(`Organization: ${op.orgName}`);
    if (op.summary) parts.push(`Profile: ${op.summary.slice(0, 400)}`);
  } catch { /* mag unavailable */ }

  // Research interests
  try {
    const { readInterests } = await import("./research-interests.js");
    const interests = readInterests();
    if (interests.length > 0) {
      parts.push(`Interests: ${interests.join(", ")}`);
    }
  } catch { /* interests unavailable */ }

  // MAG memory snippet
  try {
    const { buildMagContext } = await import("./mag.js");
    const mag = buildMagContext({ maxFacts: 6 }).slice(0, 600);
    if (mag) parts.push(`Recent memory:\n${mag}`);
  } catch { /* mag unavailable */ }

  return parts.join("\n") || "(no operator context available)";
}

// ── Batch scoring (called from org-daemon tick) ──

let lastScoredAt = 0;

export async function scoreAndNotifyBatch(now = Date.now()): Promise<number> {
  if (pending.length === 0) return 0;
  // Telegram-group monitoring can be off (or unconfigured) while externally
  // ingested items — pushed via ingestExternalItem, not the Telegram groups
  // this flag/list govern — still sit in the same queue. Only skip the whole
  // batch when EVERY pending item came from Telegram and that watch is
  // disabled; an external push was an explicit, already-authenticated ask to
  // be scored, and shouldn't be silently gated by an unrelated toggle.
  if (!isMonitorEnabled() && !pending.some(p => p.source === "external")) return 0;

  const intervalMs = monitorIntervalMinutes() * 60 * 1000;
  if (now - lastScoredAt < intervalMs) return 0;
  lastScoredAt = now;

  // Drain the pending queue
  const batch = [...pending];
  pending = [];

  if (batch.length === 0) return 0;

  const threshold = scoreThreshold();
  let notified = 0;

  try {
    const { llmGenerate } = await import("./llm.js");
    const operatorContext = await buildOperatorContext();
    const prompt = buildScoringPrompt(batch, operatorContext);

    const raw = await llmGenerate(prompt, "You are a relevance scoring engine. Output only valid JSON.", {
      profile: "triage",
      maxTokens: 2000,
      temperature: 0,
    });

    // Parse LLM response — try to extract JSON array
    let scores: ScoreResult[] = [];
    try {
      // Strip markdown fences if present
      const cleaned = raw.replace(/```json?\s*/gi, "").replace(/```\s*/g, "").trim();
      scores = JSON.parse(cleaned);
    } catch {
      // If JSON parsing fails, try line-by-line extraction
      console.warn("[telegram-news-monitor] LLM response not valid JSON, skipping batch");
      return 0;
    }

    // Send notifications for relevant posts
    const { sendTelegramMessage } = await import("./telegram-bridge.js");
    const targetChat = notifyChatId();

    for (let i = 0; i < batch.length; i++) {
      const post = batch[i];
      const s = scores.find((x: any) => x.idx === i + 1) ?? scores[i];
      if (!s || typeof s.score !== "number") continue;

      if (s.score >= threshold) {
        const notification = [
          `📰 **${post.source === "external" ? "News Alert" : "Telegram News Alert"}** (score: ${s.score}/10)`,
          ``,
          `From: ${post.chatName} (via ${post.senderName})`,
          `Time: ${post.timestamp}`,
          ...(post.url ? [`Link: ${post.url}`] : []),
          ``,
          s.summary || post.text.slice(0, 300),
          ``,
          `_Why: ${s.reason}_`,
        ].join("\n");

        if (targetChat) {
          await sendTelegramMessage(notification, targetChat).catch(e =>
            console.warn(`[telegram-news-monitor] DM notification failed: ${e}`)
          );
        }
        notified++;

        // Store as memory fact
        try {
          const { noteFact } = await import("./memory.js");
          noteFact({
            subject: "telegram-news",
            fact: `[${s.score}/10] ${s.summary || post.text.slice(0, 300)} — from ${post.chatName} by ${post.senderName}`,
            source: `${post.source === "external" ? "external-ingest" : "telegram-monitor"}/${post.chatId}`,
          });
        } catch { /* memory write best-effort */ }
      }
    }

    if (notified > 0) {
      try {
        const { logAudit } = await import("./audit-log.js");
        logAudit({
          level: "info",
          actor: "monitor",
          action: "telegram.news_scored",
          target: "batch",
          detail: `${batch.length} posts scored, ${notified} notified (threshold ${threshold})`,
          result: "success",
        });
      } catch { /* audit best-effort */ }
    }
  } catch (e: any) {
    console.warn(`[telegram-news-monitor] scoreAndNotifyBatch failed: ${e?.message ?? e}`);
    // Re-queue the batch so we don't lose posts
    pending.unshift(...batch);
  }

  return notified;
}

// ── Status (for GET /api/naxie/status or diagnostics) ──

export function getMonitorStatus(): {
  enabled: boolean;
  monitorGroups: string[];
  notifyChat: string;
  threshold: number;
  intervalMinutes: number;
  pendingPosts: number;
  lastScoredAt: string | null;
} {
  return {
    enabled: isMonitorEnabled(),
    monitorGroups: monitorGroups(),
    notifyChat: notifyChatId(),
    threshold: scoreThreshold(),
    intervalMinutes: monitorIntervalMinutes(),
    pendingPosts: pending.length,
    lastScoredAt: lastScoredAt > 0 ? new Date(lastScoredAt).toISOString() : null,
  };
}
