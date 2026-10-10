import { Router } from "express";
import { callerLayer } from "../lib/access.js";
import {
  listFlows, getFlow, createFlow, updateFlow, removeFlow, setFlowBindings,
  validateFlowInput, listRuns, getRun, dryRunMapping, executeFlowRun,
  ensureFlowRetryEngine, ensureFlowScheduleEngine,
} from "../lib/flow-automations.js";
import { createWebhook, listWebhooks, removeWebhook } from "../lib/extension-webhooks.js";
import { respond } from "../lib/respond.js";

// Flow Automations — Trigger → Steps builder over existing primitives.
// CRUD is admin-gated (standing automation config, same tier as webhooks.ts).
// Inbound invoke reuses /api/extensions/webhook/:id with targetKind "flow",
// so no new origin-guard exemption is needed.

export const flowsRouter = Router();

function requireAdmin(req: any, res: any): boolean {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    respond.error(res, 403, "forbidden", "Managing flows requires admin access.");
    return false;
  }
  return true;
}

flowsRouter.get("/", (_req, res) => {
  const flows = listFlows().map((f) => {
    const wh = f.webhookId ? listWebhooks().find((w) => w.id === f.webhookId) : undefined;
    return { ...f, invokeUrl: wh ? wh.urlPath : undefined };
  });
  respond.ok(res, { flows });
});

flowsRouter.post("/", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const v = validateFlowInput(req.body ?? {});
  if (!v.ok) {
    // Same downgrade pattern as schedules.ts: a low-priv caller staging a
    // local-machine read gets 403 + restrictedCapability, not a 400.
    if (v.restrictedCapability) return res.status(403).json({ ok: false, code: "forbidden", error: v.error, restrictedCapability: v.restrictedCapability });
    return respond.error(res, 400, "invalid_input", v.error ?? "invalid flow");
  }
  const flow = createFlow(v.value);
  // Bind the trigger: webhook ingress entry (reuses extension-webhooks store
  // + secret/idempotency/hit-count) or nothing for schedule (the
  // flow-schedule engine tick fires it via nextFireAt).
  if (flow.trigger.kind === "webhook") {
    const wh = createWebhook(flow.id, "flow");
    setFlowBindings(flow.id, { webhookId: wh.id });
    ensureFlowRetryEngine();
    return respond.ok(res, { flow: getFlow(flow.id), invokeUrl: wh.urlPath, secret: wh.secret }, 201);
  }
  ensureFlowScheduleEngine();
  ensureFlowRetryEngine();
  respond.ok(res, { flow: getFlow(flow.id) }, 201);
});

flowsRouter.get("/:id", (req, res) => {
  const f = getFlow(req.params.id);
  if (!f) return respond.empty(res, "flow not found");
  respond.ok(res, { flow: f, runs: listRuns(f.id, 10) });
});

flowsRouter.patch("/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const existing = getFlow(req.params.id);
  if (!existing) return respond.empty(res, "flow not found");
  if (req.body?.steps !== undefined) {
    const v = validateFlowInput({ name: req.body?.name ?? existing.name, trigger: existing.trigger, steps: req.body.steps });
    if (!v.ok) return respond.error(res, 400, "invalid_input", (v as any).error ?? "invalid steps");
    const updated = updateFlow(req.params.id, { steps: v.value.steps, ...(typeof req.body?.name === "string" ? { name: req.body.name } : {}) });
    return respond.ok(res, { flow: updated });
  }
  const patch: any = {};
  if (typeof req.body?.name === "string") patch.name = req.body.name.trim();
  if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
  if (typeof req.body?.requireApproval === "boolean") patch.requireApproval = req.body.requireApproval;
  const updated = updateFlow(req.params.id, patch);
  respond.ok(res, { flow: updated });
});

flowsRouter.delete("/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const f = getFlow(req.params.id);
  if (!f) return respond.empty(res, "flow not found");
  if (f.webhookId) { try { removeWebhook(f.webhookId); } catch {} }
  const ok = removeFlow(req.params.id);
  if (!ok) return respond.empty(res, "flow not found");
  respond.ok(res, {});
});

// Dry-run the mapper against a sample payload — no side effects.
flowsRouter.post("/:id/test", (req, res) => {
  if (!requireAdmin(req, res)) return;
  dryRunMapping(req.params.id, req.body?.sample ?? {}).then((r) => {
    if ("error" in r) return respond.empty(res, "flow not found");
    respond.ok(res, r);
  }).catch((e: any) => respond.error(res, 500, "test_failed", String(e?.message ?? e)));
});

// Fire a flow RIGHT NOW with an optional payload (the "Run now" button).
flowsRouter.post("/:id/fire", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const r = await executeFlowRun(req.params.id, req.body?.payload ?? {});
  if ("error" in r) {
    const code = r.error === "not found" ? 404 : r.error === "flow is paused" ? 409 : 502;
    return respond.error(res, code, "fire_failed", r.error);
  }
  respond.ok(res, { runId: r.runId }, 202);
});

flowsRouter.get("/:id/runs", (req, res) => {
  const f = getFlow(req.params.id);
  if (!f) return respond.empty(res, "flow not found");
  respond.ok(res, { runs: listRuns(f.id, 20) });
});

flowsRouter.get("/runs/:runId", (req, res) => {
  const r = getRun(req.params.runId);
  if (!r) return respond.empty(res, "run not found");
  respond.ok(res, { run: r });
});
