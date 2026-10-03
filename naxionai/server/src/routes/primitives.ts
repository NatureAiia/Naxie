import { Router } from "express";
import { primitives, findPrimitive, type Primitive } from "../lib/primitives.js";

// Primitives bridge — exposes a CURATED subset of Naxie's agent primitives
// over HTTP so an external agent (Hermes, via the MCP bridge in mcp/naxie-
// mcp.mjs) can call Naxie's real tools: vault grounding, connectors,
// integrations, web reads, and read-only payment status. Execution happens here
// in the LIVE server, so the real vault path + encrypted connector secrets are
// used. NOT exposed: money-moving (payment.link) or destructive writes
// (vault.edit/write/append, web.interact) — see ALLOWLIST.
//
// Scope is "grounding + connectors". Override with NAXION_MCP_TOOLS
// (comma-separated primitive names) if you need a different set.

export const primitivesRouter = Router();

const DEFAULT_ALLOWLIST = [
  // Vault grounding (read-only)
  "vault.search", "vault.read", "vault.scan_docs", "vault.list", "vault.find_by_tag",
  // Connectors → company systems. connector.call still respects each
  // connector's own writeEnabled gate (read-only stays read-only), so this can't write
  // unless the operator explicitly enabled writes on that connector.
  "connector.list", "connector.describe", "connector.call",
  // Integrations directory (read-only — never returns secrets)
  "integration.list",
  // Org / users directory (read-only — names, emails, roles; never passwords)
  "users.list", "users.lookup", "org.reports",
  // Long-term memory — recall/persist durable facts. Without these on the
  // bridge, the Hermes executor (which can't call Naxie primitives natively)
  // can neither remember nor recall, so memory was dead under Hermes-primary.
  "memory.note", "memory.recall", "memory.search",
  // Calendar — today's meetings (iCal), the agents' own activity, a full day
  // plan that folds in dated memory commitments, and the WRITE paths: one-off
  // dated events + recurring schedules (agents can update the calendar).
  "calendar.read_today", "calendar.activity", "calendar.plan_day",
  "calendar.add_event", "schedule.create", "schedule.list", "schedule.delete",
  // Studio media — list recently generated images (chain into email.send).
  "media.list",
  // NOTE: system.notepad is deliberately NOT on the bridge allowlist. It reads
  // the SERVER OPERATOR's local Notepad (secrets included), so the only path to
  // it is a superadmin chat task (gated in routes/chat.ts) — never a direct
  // /api/primitives/call, which requireLayer("admin") would otherwise let an
  // admin (not just superadmin) use to exfiltrate the operator's notes. The
  // agent itself still calls it via findPrimitive; this only closes the HTTP
  // bridge path.
  // Company database connections + department-specific data (read-only)
  "db.list_sources", "db.schema", "db.query", "company.department_data",
  // Email — agents send through OUR bridge (Mailjet/SMTP), never an external
  // mail CLI (Himalaya/sendmail). This is the only sanctioned send path.
  "email.send",
  // Email READ — the IMAP unread reader (NAXION_EMAIL_* creds) and the
  // Gmail-connection reader. Read-only; neither marks messages seen. Lets an
  // agent triage / summarise the inbox, not just send.
  "inbox.read_unread", "integration.gmail.read",
  // Social READ — history/analytics/comments (Ayrshare). Read-only monitoring.
  // social.post is deliberately NOT here: publishing is approval-gated and must
  // not be reachable over the external bridge.
  "social.history", "social.analytics", "social.comments",
  // Buffer READ — connected profiles, post history (sent/scheduled/drafts), and
  // engagement analytics (insights:read-gated). All read-only. buffer.post is
  // excluded (approval-gated publishing).
  "buffer.profiles", "buffer.history", "buffer.analytics",
  // Web reads
  "web.search", "web.fetch", "web.scrape", "web.firecrawl",
  // Document text extraction (read-only)
  "doc.ocr",
];

// Exported so routes/hermes-bridge.ts can render the same catalog the bridge
// actually serves, without duplicating the allowlist.
export function allowlist(): Set<string> {
  const env = (process.env.NAXION_MCP_TOOLS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return new Set(env.length ? env : DEFAULT_ALLOWLIST);
}

function toInputSchema(p: Primitive) {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const a of p.args) {
    properties[a.name] = { type: a.type, description: a.description };
    if (a.required) required.push(a.name);
  }
  return { type: "object" as const, properties, required };
}

// GET /api/primitives — the tool catalog the MCP bridge advertises to Hermes.
primitivesRouter.get("/", (_req, res) => {
  const allow = allowlist();
  const tools = primitives
    .filter(p => allow.has(p.name))
    .map(p => ({ name: p.name, description: p.description, readonly: p.readonly, inputSchema: toInputSchema(p) }));
  res.json({ tools });
});

// POST /api/primitives/call — body: { name, args }. Runs the primitive's real
// handler in the live server. Allowlist-gated.
primitivesRouter.post("/call", async (req, res) => {
  const name = String(req.body?.name ?? "");
  const args = (req.body?.args && typeof req.body.args === "object") ? req.body.args as Record<string, any> : {};
  if (!allowlist().has(name)) {
    return res.status(403).json({ error: `primitive "${name}" is not exposed over the bridge (not in the allowlist)` });
  }
  const prim = findPrimitive(name);
  if (!prim) return res.status(404).json({ error: `unknown primitive "${name}"` });
  try {
    const result = await prim.handler(args);
    res.json({ ok: true, name, result });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e), name });
  }
});
