// MCP-client mode — lets the operator register EXTERNAL MCP servers (the
// ones catalogued at github.com/punkpeye/awesome-mcp-servers: filesystem,
// browser, Postgres, Google Drive, Stripe, ...) as tool sources for the
// agent, the same way connectors.ts registers external HTTP APIs.
//
// Why a separate module instead of teaching connectors.ts a new auth type:
// an MCP server is a LOCAL CHILD PROCESS speaking JSON-RPC 2.0 over stdio
// (line-delimited, no HTTP) — a fundamentally different transport and trust
// model from an HTTP connector. Wire protocol is hand-rolled to match the
// project's existing MCP servers (server/mcp/*.mjs) rather than pulling in
// an SDK dependency.
//
// Trust model — this is MORE powerful than a connector, so it's MORE
// restricted by default:
//   • A connector calls a URL the operator typed. An MCP server is a COMMAND
//     the operator typed — it runs arbitrary local code with this process's
//     OS permissions (filesystem, network, subprocess...). There is no
//     equivalent of connectors.ts's SSRF/origin guard for "what a spawned
//     process is allowed to do" — that's the server's own business.
//   • So: adding a server is an explicit operator action (never auto-seeded
//     like the public-API connector backups), every mcp.call is ALWAYS
//     approval-gated (no skipApprovalForReads escape hatch), and the config
//     (command/args/env) is only ever editable by an admin.
//   • Secrets that ride in `env` (API keys the server itself needs, e.g. a
//     GitHub PAT for a github-mcp-server) are encrypted at rest exactly like
//     connector auth secrets (secret-box), never returned to the API/UI.
//
// Lifecycle: a server process is spawned LAZILY on first use and kept warm
// (MCP handshake + tool discovery is not free) until it exits, crashes, or
// is explicitly stopped/removed. A crash clears the cached process; the next
// call transparently respawns.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { encryptSecret, decryptSecret, isEncrypted } from "./secret-box.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const CONFIG_PATH = resolve(CONFIG_DIR, "mcp-servers.json");

const PROTOCOL_VERSION = "2024-11-05";
const HANDSHAKE_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 20_000;

// ─── Types ───

export type McpServerConfig = {
  id: string;
  label: string;
  description?: string;
  command: string;             // e.g. "npx"
  args: string[];              // e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
  env?: Record<string, string>; // extra env vars for the child (secrets encrypted at rest)
  disabled?: boolean;
  createdAt: string;
  lastError?: string;
  lastToolCount?: number;
  lastConnectedAt?: string;
};

export type McpServerPublic = Omit<McpServerConfig, "env"> & {
  envKeys: string[]; // names only — values never leave the server
};

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpCallResult = {
  ok: boolean;
  content?: unknown;   // the tool's returned content (text/JSON, truncated)
  truncated?: boolean;
  error?: string;
};

// ─── Persistence (env values encrypted at rest, mirrors connectors.ts) ───

function load(): McpServerConfig[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!Array.isArray(parsed)) return [];
    let sawPlaintext = false;
    const list = (parsed as McpServerConfig[]).map(s => {
      const env = { ...(s.env ?? {}) };
      for (const k of Object.keys(env)) {
        const v = env[k];
        if (typeof v === "string" && v) {
          if (isEncrypted(v)) { try { env[k] = decryptSecret(v); } catch { /* rotated key — leave blob */ } }
          else sawPlaintext = true;
        }
      }
      return { ...s, env };
    });
    if (sawPlaintext) { try { save(list); } catch { /* best-effort migration */ } }
    return list;
  } catch { return []; }
}

function save(list: McpServerConfig[]): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const onDisk = list.map(s => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.env ?? {})) env[k] = isEncrypted(v) ? v : encryptSecret(v);
    return { ...s, env };
  });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

function toPublic(s: McpServerConfig): McpServerPublic {
  const { env, ...rest } = s;
  return { ...rest, envKeys: Object.keys(env ?? {}) };
}

export function listMcpServers(): McpServerPublic[] {
  return load().map(toPublic);
}

function findServer(idOrLabel: string): McpServerConfig | undefined {
  const list = load();
  const key = idOrLabel.trim().toLowerCase();
  return list.find(s => s.id === idOrLabel) ?? list.find(s => s.label.toLowerCase() === key);
}

export function addMcpServer(input: {
  label: string; description?: string; command: string; args?: string[]; env?: Record<string, string>;
}): McpServerPublic {
  const label = String(input.label ?? "").trim();
  const command = String(input.command ?? "").trim();
  if (!label) throw new Error("label is required");
  if (!command) throw new Error("command is required");
  const conf: McpServerConfig = {
    id: randomUUID(),
    label,
    description: input.description ? String(input.description) : undefined,
    command,
    args: Array.isArray(input.args) ? input.args.map(String) : [],
    env: input.env && typeof input.env === "object" ? Object.fromEntries(Object.entries(input.env).map(([k, v]) => [k, String(v)])) : undefined,
    disabled: false,
    createdAt: new Date().toISOString(),
  };
  const list = load();
  list.push(conf);
  save(list);
  return toPublic(conf);
}

export function removeMcpServer(id: string): boolean {
  stopServer(id);
  const list = load();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

export function setMcpServerDisabled(id: string, disabled: boolean): McpServerPublic | null {
  if (disabled) stopServer(id);
  const list = load();
  const s = list.find(x => x.id === id);
  if (!s) return null;
  s.disabled = disabled;
  save(list);
  return toPublic(s);
}

// ─── Runtime: one live child process per server, spawned lazily ───

type PendingCall = { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout };

type RunningServer = {
  proc: ChildProcessWithoutNullStreams;
  rl: Interface;
  nextId: number;
  pending: Map<number, PendingCall>;
  tools: McpTool[];
  ready: Promise<void>;
};

const running = new Map<string, RunningServer>();

function stopServer(id: string): void {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  for (const p of r.pending.values()) { clearTimeout(p.timer); p.reject(new Error("server stopped")); }
  try { r.rl.close(); } catch { /* already closed */ }
  try { r.proc.kill(); } catch { /* already dead */ }
}

function recordError(id: string, message: string): void {
  const list = load();
  const s = list.find(x => x.id === id);
  if (!s) return;
  s.lastError = message;
  try { save(list); } catch { /* best-effort */ }
}

function recordConnected(id: string, toolCount: number): void {
  const list = load();
  const s = list.find(x => x.id === id);
  if (!s) return;
  s.lastConnectedAt = new Date().toISOString();
  s.lastToolCount = toolCount;
  s.lastError = undefined;
  try { save(list); } catch { /* best-effort */ }
}

// Sends a JSON-RPC request and resolves with `.result` (or rejects with
// `.error` / timeout). Notifications (no reply expected) aren't needed here —
// MCP's stdio transport is strictly request/response for initialize/list/call.
function rpcRequest(r: RunningServer, method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
  const id = r.nextId++;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      r.pending.delete(id);
      rejectPromise(new Error(`MCP request "${method}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    r.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    try {
      r.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
    } catch (e) {
      clearTimeout(timer);
      r.pending.delete(id);
      rejectPromise(e);
    }
  });
}

// Spawns the child, performs the MCP handshake (initialize → notifications/initialized
// → tools/list), and caches the tool manifest. Idempotent: a server already
// running (or mid-startup) is reused.
async function ensureStarted(conf: McpServerConfig): Promise<RunningServer> {
  const existing = running.get(conf.id);
  if (existing) { await existing.ready; return existing; }

  const proc = spawn(conf.command, conf.args ?? [], {
    env: { ...process.env, ...(conf.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: proc.stdout });
  const r: RunningServer = { proc, rl, nextId: 1, pending: new Map(), tools: [], ready: Promise.resolve() };

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; } // servers sometimes log to stdout — ignore non-JSON
    if (msg.id === undefined || !r.pending.has(msg.id)) return; // notification or already timed out
    const p = r.pending.get(msg.id)!;
    r.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
    else p.resolve(msg.result);
  });
  proc.stderr.on("data", () => { /* server logs — surfaced via lastError only on hard failure */ });
  proc.on("exit", (code) => {
    running.delete(conf.id);
    for (const p of r.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`MCP server exited (code ${code})`)); }
    if (code !== 0 && code !== null) recordError(conf.id, `process exited with code ${code}`);
  });
  proc.on("error", (e) => {
    running.delete(conf.id);
    recordError(conf.id, `failed to start: ${e.message}`);
  });

  r.ready = (async () => {
    await rpcRequest(r, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "neuroworks", version: "1.0.0" },
    }, HANDSHAKE_TIMEOUT_MS);
    // initialized is a notification (no id, no reply expected)
    try { proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n"); } catch { /* ignore */ }
    const listResult = await rpcRequest(r, "tools/list", {}, HANDSHAKE_TIMEOUT_MS);
    r.tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
    recordConnected(conf.id, r.tools.length);
  })();

  running.set(conf.id, r);
  try {
    await r.ready;
  } catch (e: any) {
    stopServer(conf.id);
    recordError(conf.id, e?.message ?? String(e));
    throw e;
  }
  return r;
}

// ─── Public operations (mirror connector.list / .describe / .call) ───

export async function listMcpTools(idOrLabel: string): Promise<McpTool[]> {
  const conf = findServer(idOrLabel);
  if (!conf) throw new Error(`MCP server "${idOrLabel}" not found`);
  if (conf.disabled) throw new Error(`MCP server "${conf.label}" is disabled`);
  const r = await ensureStarted(conf);
  return r.tools;
}

export async function callMcpTool(idOrLabel: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
  const conf = findServer(idOrLabel);
  if (!conf) return { ok: false, error: `MCP server "${idOrLabel}" not found` };
  if (conf.disabled) return { ok: false, error: `MCP server "${conf.label}" is disabled` };
  try {
    const r = await ensureStarted(conf);
    if (!r.tools.some(t => t.name === toolName)) {
      return { ok: false, error: `tool "${toolName}" not found on "${conf.label}" — known tools: ${r.tools.map(t => t.name).join(", ") || "(none)"}` };
    }
    const result = await rpcRequest(r, "tools/call", { name: toolName, arguments: args ?? {} });
    const raw = JSON.stringify(result?.content ?? result ?? null);
    const truncated = raw.length > MAX_RESULT_CHARS;
    const content = truncated ? JSON.parse(raw.slice(0, MAX_RESULT_CHARS) + (raw.trim().endsWith("}") ? "" : "")) : result?.content ?? result;
    return { ok: !result?.isError, content: truncated ? raw.slice(0, MAX_RESULT_CHARS) : content, truncated: truncated || undefined };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function stopAllMcpServers(): void {
  for (const id of Array.from(running.keys())) stopServer(id);
}
