import { Router } from "express";
import {
  listConnectors, getConnectorPublic, addConnector, updateConnector,
  removeConnector, testConnector, callConnector,
  listConnectorTemplates, startOAuthDeviceFlow, pollOAuthDeviceFlow,
  setConnectorExpiry, setConnectorRoles, rotateConnectorSecrets,
} from "../lib/connectors.js";
import { logAudit } from "../lib/audit-log.js";
import { scanForSecurityRisks, redactHighSeverity } from "../lib/security.js";

// Company-system connectors API — the operator registers external HTTP APIs
// (an existing in-house system, a SaaS REST API, …) that agents may call.
// Secrets are encrypted at rest by the lib and NEVER returned here; responses
// carry only the auth scheme + a boolean "secretSet".

export const connectorsRouter = Router();

// Auth schemes the UI can offer — small static catalog so the form can render
// the right fields without hardcoding them client-side.
const AUTH_TYPES = [
  { type: "none", label: "No auth", fields: [] },
  { type: "bearer", label: "Bearer token", fields: [{ name: "token", label: "Token", secret: true }] },
  { type: "apiKey", label: "API key", fields: [
    { name: "in", label: "Send in", secret: false }, { name: "name", label: "Param name", secret: false }, { name: "value", label: "Key", secret: true },
  ] },
  { type: "basic", label: "Basic auth", fields: [{ name: "username", label: "Username", secret: false }, { name: "password", label: "Password", secret: true }] },
  { type: "header", label: "Custom header", fields: [{ name: "name", label: "Header name", secret: false }, { name: "value", label: "Header value", secret: true }] },
  { type: "oauth2", label: "OAuth2 (device code — Microsoft)", fields: [
    { name: "tenant", label: "Tenant (consumers / common / tenant ID)", secret: false },
    { name: "clientId", label: "Application (client) ID", secret: false },
    { name: "scope", label: "Scopes", secret: false },
  ] },
];

connectorsRouter.get("/catalog", (_req, res) => res.json({ authTypes: AUTH_TYPES }));

// Prefill templates for the "Add connector" UI (Microsoft To Do, etc.) — see
// listConnectorTemplates in the lib for why this is separate from seeding.
connectorsRouter.get("/templates", (_req, res) => res.json({ templates: listConnectorTemplates() }));

connectorsRouter.get("/", (_req, res) => res.json({ connectors: listConnectors() }));

// Add a connector. body: { label, baseUrl, description?, auth?, headers?, endpoints?, writeEnabled? }
connectorsRouter.post("/", (req, res) => {
  try {
    const conn = addConnector(req.body ?? {});
    // optional key expiry / roles in same payload
    if (req.body?.keyExpiresAt) { try { setConnectorExpiry(conn.id, String(req.body.keyExpiresAt)); } catch {} }
    if (Array.isArray(req.body?.allowedRoles)) { try { setConnectorRoles(conn.id, req.body.allowedRoles); } catch {} }
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "connector.add", target: conn.id, detail: conn.label, result: "success" });
    res.json({ connector: getConnectorPublic(conn.id) ?? conn });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// Test-by-id route is defined under :id below. Describe a single connector
// (full manifest, no secrets) — what an agent reads to understand the system.
connectorsRouter.get("/:id", (req, res) => {
  const c = getConnectorPublic(String(req.params.id));
  if (!c) return res.status(404).json({ error: "connector not found" });
  res.json({ connector: c });
});

connectorsRouter.patch("/:id", (req, res) => {
  try {
    const c = updateConnector(String(req.params.id), req.body ?? {});
    if (!c) return res.status(404).json({ error: "connector not found" });
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "connector.update", target: String(req.params.id), detail: Object.keys(req.body ?? {}).join(","), result: "success" });
    res.json({ connector: c });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

connectorsRouter.patch("/:id/expiry", (req, res) => {
  try {
    const id = String(req.params.id);
    const expiresAt = req.body?.keyExpiresAt ?? req.body?.expiresAt ?? null;
    const c = setConnectorExpiry(id, expiresAt ? String(expiresAt) : null);
    if (!c) return res.status(404).json({ error: "connector not found" });
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "connector.setExpiry", target: id, detail: `expiresAt=${expiresAt ?? "null"}`, result: "success" });
    res.json({ connector: c });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

connectorsRouter.patch("/:id/roles", (req, res) => {
  try {
    const id = String(req.params.id);
    const roles = Array.isArray(req.body?.allowedRoles) ? req.body.allowedRoles as string[] : [];
    const c = setConnectorRoles(id, roles);
    if (!c) return res.status(404).json({ error: "connector not found" });
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "connector.setRoles", target: id, detail: `roles=${roles.join(",")}`, result: "success" });
    res.json({ connector: c });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

connectorsRouter.post("/:id/rotate", (req, res) => {
  try {
    const id = String(req.params.id);
    const values = (req.body?.values && typeof req.body.values === "object") ? req.body.values as Record<string, string> : (req.body ?? {}) as Record<string, string>;
    const c = rotateConnectorSecrets(id, values);
    if (!c) return res.status(404).json({ error: "connector not found" });
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "connector.rotate", target: id, detail: `fields=${Object.keys(values).join(",")}`, result: "success" });
    res.json({ connector: c });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

connectorsRouter.delete("/:id", (req, res) => {
  const id = String(req.params.id);
  const ok = removeConnector(id);
  if (!ok) return res.status(404).json({ error: "connector not found" });
  logAudit({ level: "warn", actor: (req as any).user?.email ?? "system", action: "connector.remove", target: id, detail: "removed", result: "success" });
  res.json({ ok: true });
});

// Start an OAuth2 device-code sign-in for an oauth2-type connector. Returns a
// user code + verification URL for the operator to complete in any browser,
// plus a flowId the UI polls until the server has tokens (or it expires).
connectorsRouter.post("/:id/oauth/start", async (req, res) => {
  try {
    res.json(await startOAuthDeviceFlow(String(req.params.id)));
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

connectorsRouter.post("/:id/oauth/poll", async (req, res) => {
  try {
    const flowId = String((req.body ?? {}).flowId ?? "");
    if (!flowId) return res.status(400).json({ error: "flowId is required" });
    res.json(await pollOAuthDeviceFlow(flowId));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

connectorsRouter.post("/:id/test", async (req, res) => {
  try {
    const id = String(req.params.id);
    const r = await testConnector(id);
    logAudit({ level: (r as any).ok ? "info" : "warn", actor: (req as any).user?.email ?? "system", action: "connector.test", target: id, detail: (r as any).detail, result: (r as any).ok ? "success" : "failure" });
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Manual invoke (operator "try it" button). body: { method?, path, query?, body?, headers? }
connectorsRouter.post("/:id/call", async (req, res) => {
  try {
    const id = String(req.params.id);
    const b = req.body ?? {};
    const result: any = await callConnector(id, {
      method: b.method, path: String(b.path ?? ""), query: b.query, body: b.body, headers: b.headers,
    });
    // Security scan on response — high-severity secrets are redacted, not leaked to UI
    try {
      const bodyStr = typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? "");
      const findings = scanForSecurityRisks(bodyStr, "note");
      const high = findings.filter(f => f.severity === "high");
      if (high.length > 0) {
        logAudit({ level: "warn", actor: (req as any).user?.email ?? "system", action: "connector.call.blocked", target: `${id}:${b.method ?? "GET"} ${b.path ?? ""}`, detail: `redacted high-severity ${high.map(h=>h.type).join(",")}`, result: "success", jobId: id });
        result.body = redactHighSeverity(bodyStr, findings);
        result.warning = `Response contained ${high.length} high-severity secret(s) — redacted (${high.map(h=>h.type).join(", ")})`;
      }
    } catch {}
    logAudit({ level: (result as any).ok ? "info" : "warn", actor: (req as any).user?.email ?? "system", action: "connector.call", target: `${id}:${b.method ?? "GET"} ${b.path ?? ""}`, detail: `status=${(result as any).status}`, result: (result as any).ok ? "success" : "failure", jobId: id });
    res.json({ result });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
