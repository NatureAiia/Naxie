#!/usr/bin/env node
// Zapier MCP bridge — surfaces Zapier "Webhooks by Zapier" triggers as MCP
// tools so the agent (Naxie / Hermes) can fire real Zaps from a conversation.
//
// Transport: MCP stdio = line-delimited JSON-RPC 2.0, same hand-rolled pattern
// as naxie-mcp.mjs (no SDK dependency).
//
// Register:
//   web UI  → Extensions → MCP Servers → Add server, command:
//            node <repo>/server/mcp/zapier-mcp.mjs
//   hermes  → hermes mcp add zapier -- node "<repo>/server/mcp/zapier-mcp.mjs"
//
// Env (entered once when registering the server in the UI / as a secret):
//   ZAP_WEBHOOKS  — JSON array of { "name", "url", "key"? } entries, e.g.
//                   [{"name":"slack digest","url":"https://hooks.zapier.com/hooks/catch/123456/abcde/"}]
//   ZAP_WEBHOOK_URL / ZAP_WEBHOOK_NAME / ZAP_WEBHOOK_KEY — single-webhook
//                   shortcut when you only care about one Zap.
//
// Safety: every tool call is approval-gated by the platform (MCP tools are
// never auto-approved). Outbound POSTs are restricted to https URLs whose host
// ends in zapier.com, so the agent can only hit your configured Zapier hooks —
// not arbitrary internal endpoints.

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "zapier_trigger_webhook",
    description: "Trigger a Zapier Zap by POSTing a JSON payload to a configured 'Webhooks by Zapier' catch URL. Returns Zapier's response (often empty for catch hooks) plus the HTTP status.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The configured webhook name to fire (see zapier_list_webhooks)." },
        payload: { type: "object", description: "JSON object POSTed to the hook; Zapier maps top-level keys to the Zap's input fields.", additionalProperties: true },
        key: { type: "string", description: "Optional zapier-supplied secret appended as ?key=... to a private hook URL." },
        dry_run: { type: "boolean", description: "If true, return the resolved target + what would be sent without making the request." },
      },
      required: ["name"],
    },
  },
  {
    name: "zapier_list_webhooks",
    description: "List the Zapier webhooks configured for this server (URLs are redacted to their path so secrets stay out of chat).",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  },
  {
    name: "zapier_help",
    description: "Return step-by-step guidance for wiring a Zapier webhook to this server, plus a reminder that every call is approval-gated.",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function result(id, res) { send({ jsonrpc: "2.0", id, result: res }); }
function error(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

function loadWebhooks() {
  const list = [];
  const json = process.env.ZAP_WEBHOOKS;
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          if (e && e.name && e.url) list.push({ name: String(e.name), url: String(e.url), key: e.key ? String(e.key) : undefined });
        }
      }
    } catch { /* ignore malformed JSON; fall back to single env var */ }
  }
  if (list.length === 0 && process.env.ZAP_WEBHOOK_URL) {
    list.push({
      name: process.env.ZAP_WEBHOOK_NAME || "default",
      url: process.env.ZAP_WEBHOOK_URL,
      key: process.env.ZAP_WEBHOOK_KEY,
    });
  }
  return list;
}

const ZAPIER_HOST_RE = /\.zapier\.com$/;
function isZapierUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === "https:" && ZAPIER_HOST_RE.test(u.host);
}
function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? "?key=…" : ""}`;
  } catch { return "…"; }
}

async function callZapier(name, args) {
  const hooks = loadWebhooks();
  const entry = hooks.find(h => h.name === name);
  if (!entry) throw new Error(`No webhook named "${name}" configured. Run zapier_list_webhooks to see available names.`);
  if (!isZapierUrl(entry.url)) throw new Error(`Refusing to POST to non-Zapier URL: ${redactUrl(entry.url)}.`);

  const payload = args?.payload ?? {};
  if (args?.dry_run) {
    return { dryRun: true, target: redactUrl(entry.url), wouldSend: payload };
  }

  const url = new URL(entry.url);
  if (entry.key) url.searchParams.set("key", entry.key);
  if (args?.key) url.searchParams.set("key", args.key);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const text = await res.text().catch(() => "");
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, target: redactUrl(entry.url), body };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications
  try {
    switch (method) {
      case "initialize":
        return result(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "Zapier", version: "1.0.0" },
        });
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools: TOOLS });
      case "tools/call": {
        const name = params?.name;
        if (!name) return error(id, -32602, "missing tool name");
        let res;
        if (name === "zapier_trigger_webhook") res = await callZapier(params.arguments.name, params.arguments ?? {});
        else if (name === "zapier_list_webhooks") res = { webhooks: loadWebhooks().map(h => ({ name: h.name, url: redactUrl(h.url) })) };
        else if (name === "zapier_help") res = { text: "1) Create a Zap with the 'Webhooks by Zapier' → 'Catch Hook' trigger and copy its URL (https://hooks.zapier.com/hooks/catch/<id>/<key>/). 2) Register this MCP server (node <repo>/server/mcp/zapier-mcp.mjs) via the MCP Servers page and set ZAP_WEBHOOKS to a JSON array of {name, url}. 3) Ask Naxie to fire a hook: 'zapier_trigger_webhook name=slack-digest payload={\"summary\":\"...\"}' — every call is approval-gated." };
        else return error(id, -32602, `unknown tool: ${name}`);
        const text = typeof res === "string" ? res : JSON.stringify(res, null, 2);
        return result(id, { content: [{ type: "text", text }] });
      }
      default:
        return error(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    return result(id, { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true });
  }
}

let pending = 0;
let closed = false;
function maybeExit() { if (closed && pending === 0) setImmediate(() => process.exit(0)); }

const rl = createInterface({ input: process.stdin });
rl.on("line", line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  pending++;
  Promise.resolve(handle(msg)).catch(() => {}).finally(() => { pending--; maybeExit(); });
});
rl.on("close", () => { closed = true; maybeExit(); });
