import { Router } from "express";
import {
  isN8nEnabled, n8nHealth,
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow, activateWorkflow,
  listExecutions, getExecution,
  triggerWebhook, triggerWorkflowByName,
} from "../lib/n8n.js";

export const n8nRouter = Router();

// GET /api/n8n/status — config + live health
n8nRouter.get("/status", async (_req, res) => {
  const enabled = isN8nEnabled();
  const health = await n8nHealth();
  res.json({
    enabled,
    configured: enabled,
    baseUrl: (process.env.N8N_BASE_URL ?? "").trim() || null,
    webhookBaseUrl: (process.env.N8N_WEBHOOK_BASE_URL ?? process.env.N8N_BASE_URL ?? "").trim() || null,
    health,
  });
});

// GET /api/n8n/workflows?limit=20&active=true
n8nRouter.get("/workflows", async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const active = req.query.active !== undefined ? String(req.query.active) === "true" : undefined;
    const tags = req.query.tags ? String(req.query.tags) : undefined;
    const r = await listWorkflows({ limit, active, tags });
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// GET /api/n8n/workflows/:id
n8nRouter.get("/workflows/:id", async (req, res) => {
  try {
    const wf = await getWorkflow(String(req.params.id));
    res.json({ workflow: wf });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const code = msg.toLowerCase().includes("not found") ? 404 : 500;
    res.status(code).json({ error: msg });
  }
});

// POST /api/n8n/workflows — create
n8nRouter.post("/workflows", async (req, res) => {
  try {
    const wf = await createWorkflow(req.body ?? {});
    res.json({ workflow: wf });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// PATCH /api/n8n/workflows/:id
n8nRouter.patch("/workflows/:id", async (req, res) => {
  try {
    const wf = await updateWorkflow(String(req.params.id), req.body ?? {});
    res.json({ workflow: wf });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// DELETE /api/n8n/workflows/:id
n8nRouter.delete("/workflows/:id", async (req, res) => {
  try {
    await deleteWorkflow(String(req.params.id));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/n8n/workflows/:id/activate
n8nRouter.post("/workflows/:id/activate", async (req, res) => {
  try {
    const r = await activateWorkflow(String(req.params.id), true);
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

// POST /api/n8n/workflows/:id/deactivate
n8nRouter.post("/workflows/:id/deactivate", async (req, res) => {
  try {
    const r = await activateWorkflow(String(req.params.id), false);
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

// GET /api/n8n/executions?limit=20&workflowId=xxx&status=success
n8nRouter.get("/executions", async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const workflowId = req.query.workflowId ? String(req.query.workflowId) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    const r = await listExecutions({ limit, workflowId, status });
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

// GET /api/n8n/executions/:id
n8nRouter.get("/executions/:id", async (req, res) => {
  try {
    const ex = await getExecution(String(req.params.id));
    res.json({ execution: ex });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const code = msg.toLowerCase().includes("not found") ? 404 : 500;
    res.status(code).json({ error: msg });
  }
});

// POST /api/n8n/trigger — fire a webhook
// body: { url?: string, path?: string, method?: string, body?: any, query?: {}, headers?: {} }
//   - url: full webhook URL (e.g. https://n8n.example.com/webhook/my-hook)
//   - path: short path (e.g. "my-hook" → resolves to N8N_WEBHOOK_BASE_URL/webhook/my-hook)
// One of url/path is required.
n8nRouter.post("/trigger", async (req, res) => {
  try {
    const b = req.body ?? {};
    const result = await triggerWebhook({
      url: b.url ? String(b.url) : undefined,
      path: b.path ? String(b.path) : undefined,
      method: b.method ? String(b.method) : undefined,
      body: b.body,
      query: b.query,
      headers: b.headers,
    });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/n8n/trigger/workflow/:name — convenience: trigger by workflow name
n8nRouter.post("/trigger/workflow/:name", async (req, res) => {
  try {
    const name = String(req.params.name);
    const body = (req.body ?? {}).body ?? req.body;
    const result = await triggerWorkflowByName(name, body);
    res.json(result);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const code = msg.toLowerCase().includes("not found") ? 404 : 500;
    res.status(code).json({ error: msg });
  }
});

// POST /api/n8n/webhook — alias for /trigger (backwards-compat naming)
n8nRouter.post("/webhook", async (req, res) => {
  try {
    const b = req.body ?? {};
    const result = await triggerWebhook({
      url: b.url ? String(b.url) : undefined,
      path: b.path ? String(b.path) : undefined,
      method: b.method ? String(b.method) : undefined,
      body: b.body,
      query: b.query,
      headers: b.headers,
    });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
