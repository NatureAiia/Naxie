import { Router } from "express";
import { PROVIDERS, listConnections, addConnection, removeConnection, testConnection, testAllConnections, setConnectionExpiry, setConnectionRoles, rotateConnectionSecrets, getConnectionSecrets } from "../lib/integrations.js";
import { logAudit } from "../lib/audit-log.js";

// Integrations API — the user connects external services so agents can act on
// them. Secret values are encrypted at rest by the lib and NEVER returned here;
// responses only carry which secret fields are held, plus non-secret config.

export const integrationsRouter = Router();

// Provider catalog — what can be connected and which fields each needs.
integrationsRouter.get("/catalog", (_req, res) => res.json({ providers: PROVIDERS }));

// Connected services (redacted — no secret values).
integrationsRouter.get("/", (_req, res) => res.json({ connections: listConnections() }));

// Add a connection. body: { providerId, label?, values: { field: value } }
integrationsRouter.post("/", (req, res) => {
  try {
    const providerId = String(req.body?.providerId ?? "");
    const label = String(req.body?.label ?? "");
    const values = (req.body?.values && typeof req.body.values === "object") ? req.body.values as Record<string, string> : {};
    const connection = addConnection(providerId, label, values);
    logAudit({ level: "info", actor: (req as any).user?.email ?? (req as any).user?.id ?? "system", action: "integration.add", target: `${providerId}:${connection.id}`, detail: `label=${label}`, result: "success" });
    // optional expiry in same body
    if (req.body?.expiresAt) {
      try { setConnectionExpiry(connection.id, String(req.body.expiresAt)); } catch {}
    }
    res.json({ connection });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// Test ALL connections at once (used by the "Test all" button). Defined before
// the :id route so "test-all" isn't captured as an id.
integrationsRouter.post("/test-all", async (_req, res) => {
  try {
    res.json({ results: await testAllConnections() });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Non-destructive auth test for a connection.
integrationsRouter.post("/:id/test", async (req, res) => {
  try {
    const id = String(req.params.id);
    const r = await testConnection(id);
    logAudit({ level: r.ok ? "info" : "warn", actor: (req as any).user?.email ?? "system", action: "integration.test", target: id, detail: r.detail, result: r.ok ? "success" : "failure" });
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

integrationsRouter.post("/:id/rotate", (req, res) => {
  try {
    const id = String(req.params.id);
    const values = (req.body?.values && typeof req.body.values === "object") ? req.body.values as Record<string, string> : {};
    // include top-level expiresAt if provided
    if (req.body?.expiresAt) values.expiresAt = String(req.body.expiresAt);
    const conn = rotateConnectionSecrets(id, values);
    if (!conn) return res.status(404).json({ error: "connection not found" });
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "integration.rotate", target: id, detail: `fields=${Object.keys(values).join(",")}`, result: "success" });
    res.json({ connection: conn });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

integrationsRouter.patch("/:id/expiry", (req, res) => {
  try {
    const id = String(req.params.id);
    const expiresAt = req.body?.expiresAt ? String(req.body.expiresAt) : null;
    const conn = setConnectionExpiry(id, expiresAt);
    if (!conn) return res.status(404).json({ error: "connection not found" });
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "integration.setExpiry", target: id, detail: `expiresAt=${expiresAt ?? "null"}`, result: "success" });
    res.json({ connection: conn });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

integrationsRouter.patch("/:id/roles", (req, res) => {
  try {
    const id = String(req.params.id);
    const roles = Array.isArray(req.body?.allowedRoles) ? req.body.allowedRoles as string[] : [];
    const conn = setConnectionRoles(id, roles);
    if (!conn) return res.status(404).json({ error: "connection not found" });
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "integration.setRoles", target: id, detail: `roles=${roles.join(",")}`, result: "success" });
    res.json({ connection: conn });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

integrationsRouter.delete("/:id", (req, res) => {
  const id = String(req.params.id);
  const ok = removeConnection(id);
  if (!ok) return res.status(404).json({ error: "connection not found" });
  logAudit({ level: "warn", actor: (req as any).user?.email ?? "system", action: "integration.remove", target: id, detail: "removed", result: "success" });
  res.json({ ok: true });
});
