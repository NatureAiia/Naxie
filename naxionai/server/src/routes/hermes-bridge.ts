import { Router } from "express";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectHermesBin, detectHermesHome } from "../lib/hermes.js";
import { primitives, type Primitive } from "../lib/primitives.js";
import { allowlist } from "./primitives.js";

// Hermes Bridge status — read-only visibility (+ a one-click register) for the
// clawbot-mcp.mjs stdio bridge (server/mcp/clawbot-mcp.mjs) that lets the
// Hermes agent call clawbot's own primitives (vault, connectors, calendar,
// memory, …) over MCP. See routes/primitives.ts for the allowlisted catalog
// the bridge actually serves.
//
// The registration itself always lives in HERMES's config.yaml (MCP servers
// are configured client-side, and Hermes is the client here) — this route
// just renders that state inside NeuroWorks instead of leaving it invisible
// in a dotfile, and offers to write it for you.

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT_PATH = resolve(__dirname, "../../mcp/clawbot-mcp.mjs");
const SERVER_NAME = "clawbot";

export const hermesBridgeRouter = Router();

function hermesConfigPath(): string | null {
  const home = detectHermesHome();
  return home ? join(home, "config.yaml") : null;
}

// Lightweight line-based scan for `mcp_servers.<name>` — NOT a general YAML
// parser. Good enough to answer "is it there and enabled", cheap enough to
// avoid a new dependency for a status widget. Assumes the 2-space-indented
// shape Hermes's own docs use (same shape registerBridge() below writes).
function scanMcpServerEntry(yamlText: string, name: string): { registered: boolean; enabled: boolean; mcpServersLine: number } {
  const lines = yamlText.split(/\r?\n/);
  let inMcpServers = false;
  let mcpIndent = -1;
  let mcpServersLine = -1;
  let inTarget = false;
  let registered = false;
  let enabled = true;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inMcpServers) {
      if (/^\s*mcp_servers:\s*$/.test(line)) { inMcpServers = true; mcpIndent = line.match(/^\s*/)![0].length; mcpServersLine = i; }
      continue;
    }
    if (!line.trim() || /^\s*#/.test(line)) continue; // blank/comment lines don't end the block
    const indent = line.match(/^\s*/)![0].length;
    if (indent <= mcpIndent) { inMcpServers = false; continue; } // dedented out of mcp_servers:
    const keyMatch = line.match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
    if (keyMatch && indent === mcpIndent + 2) {
      inTarget = keyMatch[2] === name;
      if (inTarget) registered = true;
      continue;
    }
    if (inTarget) {
      const enMatch = line.match(/^\s*enabled:\s*(true|false)\s*$/i);
      if (enMatch) enabled = enMatch[1].toLowerCase() === "true";
    }
  }
  return { registered, enabled: registered ? enabled : false, mcpServersLine };
}

function toolCatalog() {
  const allow = allowlist();
  return primitives
    .filter((p: Primitive) => allow.has(p.name))
    .map((p: Primitive) => ({ name: p.name, description: p.description, readonly: p.readonly }));
}

function status() {
  const hermesHome = detectHermesHome();
  const hermesBin = detectHermesBin();
  const configPath = hermesConfigPath();
  const configExists = !!configPath && existsSync(configPath);
  const bridgeScriptExists = existsSync(BRIDGE_SCRIPT_PATH);
  const tools = toolCatalog();

  let registered = false;
  let enabled = false;
  if (configExists) {
    try {
      const text = readFileSync(configPath!, "utf-8");
      const scan = scanMcpServerEntry(text, SERVER_NAME);
      registered = scan.registered;
      enabled = scan.enabled;
    } catch { /* leave defaults on read failure */ }
  }

  return {
    hermesInstalled: !!hermesBin,
    hermesBinPath: hermesBin,
    hermesConfigPath: configPath,
    hermesConfigExists: configExists,
    bridgeScriptPath: BRIDGE_SCRIPT_PATH,
    bridgeScriptExists,
    registered,
    enabled,
    toolCount: tools.length,
    tools,
  };
}

hermesBridgeRouter.get("/status", (_req, res) => {
  res.json(status());
});

// Idempotent — writes the mcp_servers.clawbot block into Hermes's config.yaml
// if it isn't there yet. No-ops (with a message) if already registered, or if
// Hermes isn't installed / config.yaml doesn't exist yet.
hermesBridgeRouter.post("/register", (_req, res) => {
  const configPath = hermesConfigPath();
  if (!configPath || !existsSync(configPath)) {
    return res.status(400).json({ error: "Hermes config.yaml not found — install Hermes first (hermes-agent.nousresearch.com)." });
  }
  const text = readFileSync(configPath, "utf-8");
  const scan = scanMcpServerEntry(text, SERVER_NAME);
  if (scan.registered) {
    return res.json({ ok: true, alreadyRegistered: true, status: status() });
  }
  const base = process.env.NAXION_BASE ?? "http://127.0.0.1:7471";
  const argsLine = `["${BRIDGE_SCRIPT_PATH.replace(/\\/g, "/")}"]`;
  const entryLines = [
    `  ${SERVER_NAME}:`,
    `    command: "node"`,
    `    args: ${argsLine}`,
    "    env:",
    `      NAXION_BASE: "${base}"`,
    "    enabled: true",
    "    trust: full",
  ];

  try {
    if (scan.mcpServersLine >= 0) {
      // An `mcp_servers:` block already exists (other servers registered) —
      // splice our entry in right under that key rather than appending a
      // second top-level `mcp_servers:` (which most YAML parsers would treat
      // as a duplicate key and silently drop one of the two).
      const lines = text.split(/\r?\n/);
      lines.splice(scan.mcpServersLine + 1, 0, ...entryLines);
      writeFileSync(configPath, lines.join("\n"), "utf-8");
    } else {
      const block = [
        "",
        "# Added by NeuroWorks (Hermes Bridge panel) — exposes clawbot's internal",
        "# tools (vault, connectors, users, calendar, memory, email, web) to Hermes",
        "# over MCP. Bridge: neuroworks/server/mcp/clawbot-mcp.mjs, allowlist in",
        "# neuroworks/server/src/routes/primitives.ts.",
        "mcp_servers:",
        ...entryLines,
        "",
      ].join("\n");
      appendFileSync(configPath, block, "utf-8");
    }
  } catch (e: any) {
    return res.status(500).json({ error: `couldn't write ${configPath}: ${String(e?.message ?? e)}` });
  }
  res.json({ ok: true, alreadyRegistered: false, status: status() });
});
