// External (non-Telegram) news ingest — lets an outside source (an RSS
// aggregator, a partner feed, any script) push one item into the exact same
// pending/scoring/notify pipeline telegram-news-monitor.ts already runs for
// Telegram posts (see ingestExternalItem there).
//
// Mounted at /api/public/agent (see index.ts) so it shares /api/public's
// origin-guard exemption (server-to-server, no browser involved — see
// origin-guard.ts, which only exempts /api/v1/, /api/public/, and
// /api/extensions/webhook/). A genuinely external caller can't reach any
// other prefix at all — origin-guard 403s on the Host header first — so this
// mirrors routes/public-finance.ts's existing shared-secret pattern instead
// of adding a new guard exemption for one endpoint.
//
// Auth: same shape as public-finance.ts — set AGENT_INGEST_TOKEN and the
// caller sends it as `Authorization: Bearer <token>` (or `X-Agent-Token:
// <token>`); unset = same-machine callers only.

import { Router } from "express";
import { ingestExternalItem } from "../lib/telegram-news-monitor.js";

export const agentIngestRouter = Router();

const INGEST_TOKEN = (process.env.AGENT_INGEST_TOKEN ?? "").trim();

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a === "::1" || a === "localhost";
}

function authorized(req: any): boolean {
  if (INGEST_TOKEN) {
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    const header = String(req.headers["x-agent-token"] ?? "").trim();
    return bearer === INGEST_TOKEN || header === INGEST_TOKEN;
  }
  return isLoopback(req.socket?.remoteAddress);
}

// POST /api/public/agent/ingest — body: {title, url, abstract, source_name, categories?}
agentIngestRouter.post("/ingest", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized", message: "Set Authorization: Bearer <AGENT_INGEST_TOKEN> (or X-Agent-Token) to push items. When no token is configured, only same-machine callers are allowed." });
  }
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: "bad_payload", message: "Expected a JSON object body: {title, url, abstract, source_name, categories?}." });
  }
  const { title, url, abstract, source_name, categories } = body;
  const result = ingestExternalItem({
    title: String(title ?? ""),
    url: String(url ?? ""),
    abstract: String(abstract ?? ""),
    source_name: String(source_name ?? ""),
    categories: Array.isArray(categories) ? categories.map(String) : undefined,
  });
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: "bad_payload", message: result.error });
  }
  res.json({ ok: true, queued: result.queued, chatId: result.chatId });
});
