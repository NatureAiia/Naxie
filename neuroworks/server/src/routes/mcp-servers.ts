import { Router } from "express";
import {
  listMcpServers, addMcpServer, removeMcpServer, setMcpServerDisabled,
  listMcpTools, callMcpTool,
} from "../lib/mcp-clients.js";
import { logAudit } from "../lib/audit-log.js";

// MCP-client servers API — the operator registers external MCP servers
// (community catalog: github.com/punkpeye/awesome-mcp-servers) as local
// child-process tool sources for the agent. See mcp-clients.ts for the
// trust model — this is a stricter surface than connectors: no test-call
// bypass, no read/write auto-approve, admin-only by convention (enforce the
// role check the same way this file's mount point enforces it for
// connectors/data-sources — see index.ts).

export const mcpServersRouter = Router();

mcpServersRouter.get("/", (_req, res) => res.json({ servers: listMcpServers() }));

// Add a server. body: { label, description?, command, args?: string[], env?: Record<string,string> }
mcpServersRouter.post("/", (req, res) => {
  try {
    const s = addMcpServer(req.body ?? {});
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "mcp.add", target: s.id, detail: s.label, result: "success" });
    res.json({ server: s });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

mcpServersRouter.patch("/:id/disabled", (req, res) => {
  const id = String(req.params.id);
  const s = setMcpServerDisabled(id, req.body?.disabled === true);
  if (!s) return res.status(404).json({ error: "server not found" });
  logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "mcp.setDisabled", target: id, detail: `disabled=${s.disabled}`, result: "success" });
  res.json({ server: s });
});

mcpServersRouter.delete("/:id", (req, res) => {
  const id = String(req.params.id);
  const ok = removeMcpServer(id);
  if (!ok) return res.status(404).json({ error: "server not found" });
  logAudit({ level: "warn", actor: (req as any).user?.email ?? "system", action: "mcp.remove", target: id, detail: "removed", result: "success" });
  res.json({ ok: true });
});

// Discover tools (starts the server if it isn't running yet).
mcpServersRouter.get("/:id/tools", async (req, res) => {
  try {
    const tools = await listMcpTools(String(req.params.id));
    res.json({ tools });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// Manual invoke (operator "try it" button). body: { tool, arguments? }
mcpServersRouter.post("/:id/call", async (req, res) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const result = await callMcpTool(id, String(b.tool ?? ""), b.arguments ?? {});
    logAudit({ level: result.ok ? "info" : "warn", actor: (req as any).user?.email ?? "system", action: "mcp.call", target: `${id}:${b.tool ?? ""}`, detail: result.ok ? "ok" : String(result.error), result: result.ok ? "success" : "failure", jobId: id });
    res.json({ result });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
