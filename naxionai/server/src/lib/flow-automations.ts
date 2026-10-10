// Flow Automations v1 — per-workflow inbound triggers + deterministic mapper.
//
// A flow is an orchestrator OVER existing primitives, not a parallel universe:
//   trigger (webhook ingress via extension-webhooks targetKind:"flow", or a
//            hidden schedule in schedules.ts)
//     → steps[] (sequential, max 10):
//         connector.call  → lib/connectors.ts callConnector
//         webhook.publish → lib/webhook-delivery.ts publishEvent
//         agent.task      → lib/jobs.ts newJob + runJob (generalTaskRunner)
//
// Persistence: .naxion/flow-automations.json + flow-runs.json via json-store
// (crash-safe reads/writes, degraded-store guard). Runs persist with
// nextAttemptAt so the flow-retry engine (scheduler-registry, 60s tick)
// resumes after a reboot — no Redis/BullMQ for a single-user local box.

import { randomUUID } from "node:crypto";
import { readJsonStore, statePath, tryWriteJsonStore } from "./json-store.js";
import { renderTemplate } from "./flow-mapper.js";
import { isLocalMachineTask } from "./task-restrictions.js";
import { logAudit } from "./audit-log.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type FlowStepKind = "connector.call" | "webhook.publish" | "agent.task";

export type FlowStep = {
  id: string;
  kind: FlowStepKind;
  /** connector id/label, event name, or task text / template id */
  ref: string;
  /** JSON template with {{$.trigger…}} / {{$.steps.<id>…}} tokens */
  template?: unknown;
  /** v1 branch: skip this step unless path resolves to `equals` */
  condition?: { path: string; equals: unknown };
};

export type FlowTrigger =
  | { kind: "webhook" }
  | { kind: "schedule"; cadence: { daysOfWeek: number[]; hour: number; minute: number; once?: string } };

export type FlowAutomation = {
  id: string;
  name: string;
  enabled: boolean;
  trigger: FlowTrigger;
  steps: FlowStep[];
  requireApproval?: boolean;
  createdAt: string;
  /** hidden schedule id when trigger.kind === "schedule" */
  scheduleId?: string;
  /** extension-webhooks entry id when trigger.kind === "webhook" */
  webhookId?: string;
  /** last schedule-trigger fire (ISO) — maintained by the flow-schedule engine */
  lastFiredAt?: string;
};

export type FlowStepResult = {
  stepId: string;
  kind: FlowStepKind;
  status: "succeeded" | "failed" | "skipped";
  ok: boolean;
  statusCode?: number;
  /** first ~2 KB of the step output — never full bodies */
  bodyPreview?: string;
  error?: string;
  warnings?: string[];
};

export type FlowRun = {
  id: string;
  flowId: string;
  status: "pending" | "running" | "succeeded" | "failed";
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  jobId?: string;
  stepResults: FlowStepResult[];
  startedAt: string;
  finishedAt?: string;
  // Journaled trigger payload so retries replay the ORIGINAL inputs exactly.
  // Capped at 32 KB — larger payloads set triggerOmitted: true and retries
  // re-fire with {} (mapper warnings show). Never stores full step bodies.
  trigger?: unknown;
  triggerOmitted?: boolean;
};

export const MAX_STEPS = 10;
const MAX_RUNS = 500;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const TEMPLATE_JSON_CAP = 32 * 1024;
const INBOUND_JSON_CAP = 256 * 1024;

// ─── Stores ────────────────────────────────────────────────────────────────

function flowsPath() { return statePath("flow-automations.json"); }
function runsPath() { return statePath("flow-runs.json"); }

function loadFlows(): FlowAutomation[] {
  const r = readJsonStore<FlowAutomation[]>(flowsPath(), () => [], {
    label: "flow-automations", validate: (v) => Array.isArray(v),
  });
  return Array.isArray(r.value) ? r.value : [];
}

function saveFlows(list: FlowAutomation[]): boolean {
  return tryWriteJsonStore(flowsPath(), list, { label: "flow-automations" });
}

function loadRuns(): FlowRun[] {
  const r = readJsonStore<FlowRun[]>(runsPath(), () => [], {
    label: "flow-runs", validate: (v) => Array.isArray(v),
  });
  return Array.isArray(r.value) ? r.value : [];
}

function saveRuns(list: FlowRun[]): boolean {
  const trimmed = list.slice(-MAX_RUNS);
  return tryWriteJsonStore(runsPath(), trimmed, { label: "flow-runs" });
}

export function _resetForTests() {
  tryWriteJsonStore(flowsPath(), [], { label: "flow-automations" });
  tryWriteJsonStore(runsPath(), [], { label: "flow-runs" });
}

// ─── Validation ────────────────────────────────────────────────────────────

export function validateFlowInput(body: any): { ok: true; value: Omit<FlowAutomation, "id" | "createdAt" | "scheduleId" | "webhookId"> } | { ok: false; error: string; restrictedCapability?: "local-machine" } {
  if (!body || typeof body !== "object") return { ok: false, error: "body is required" };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > 120) return { ok: false, error: "name must be 120 characters or fewer" };
  const trigger = body.trigger;
  if (!trigger || typeof trigger !== "object") return { ok: false, error: "trigger is required" };
  if (trigger.kind !== "webhook" && trigger.kind !== "schedule") return { ok: false, error: "trigger.kind must be webhook or schedule" };
  if (trigger.kind === "schedule") {
    const c = trigger.cadence;
    if (!c || typeof c !== "object") return { ok: false, error: "trigger.cadence is required for schedule flows" };
    const hour = Number(c.hour); const minute = Number(c.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, error: "trigger.cadence.hour must be 0..23" };
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { ok: false, error: "trigger.cadence.minute must be 0..59" };
  }
  const steps = body.steps;
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: "steps[] with at least one step is required" };
  if (steps.length > MAX_STEPS) return { ok: false, error: `no more than ${MAX_STEPS} steps (v1)` };
  const ids = new Set<string>();
  for (const s of steps) {
    if (!s || typeof s !== "object") return { ok: false, error: "each step must be an object" };
    if (s.kind !== "connector.call" && s.kind !== "webhook.publish" && s.kind !== "agent.task") {
      return { ok: false, error: `step kind must be connector.call, webhook.publish or agent.task` };
    }
    if (typeof s.ref !== "string" || !s.ref.trim()) return { ok: false, error: "each step needs a ref (connector id, event name, or task text)" };
    if (s.ref.length > 8000) return { ok: false, error: "step ref exceeds 8000 chars" };
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim().slice(0, 40) : "";
    if (id && ids.has(id)) return { ok: false, error: `duplicate step id "${id}"` };
    if (id) ids.add(id);
    if (s.template !== undefined) {
      let size = 0;
      try { size = Buffer.byteLength(JSON.stringify(s.template), "utf8"); } catch { return { ok: false, error: "step template must be JSON-serialisable" }; }
      if (size > TEMPLATE_JSON_CAP) return { ok: false, error: "step template exceeds 32 KB" };
    }
    if (s.condition !== undefined) {
      if (typeof s.condition !== "object" || typeof (s.condition as any).path !== "string") {
        return { ok: false, error: "step condition must be { path, equals }" };
      }
    }
    if (s.kind === "agent.task" && isLocalMachineTask(`${s.ref} ${JSON.stringify(s.template ?? "")}`)) {
      return { ok: false, error: "that agent step reads the operator's local machine — super-admin only", restrictedCapability: "local-machine" as const };
    }
  }
  return {
    ok: true,
    value: {
      name,
      enabled: body.enabled === false ? false : true,
      trigger: trigger.kind === "webhook" ? { kind: "webhook" } : { kind: "schedule", cadence: body.trigger.cadence },
      steps: steps.map((s: any, i: number) => ({
        id: typeof s.id === "string" && s.id.trim() ? s.id.trim().slice(0, 40) : `step-${i + 1}`,
        kind: s.kind as FlowStepKind,
        ref: String(s.ref).trim(),
        ...(s.template !== undefined ? { template: s.template } : {}),
        ...(s.condition !== undefined ? { condition: s.condition } : {}),
      })),
      ...(body.requireApproval === true ? { requireApproval: true as const } : {}),
    },
  };
}

// ─── CRUD ──────────────────────────────────────────────────────────────────

export function listFlows(): FlowAutomation[] { return loadFlows(); }
export function getFlow(id: string): FlowAutomation | undefined { return loadFlows().find((f) => f.id === id); }

export function createFlow(input: Omit<FlowAutomation, "id" | "createdAt" | "scheduleId" | "webhookId">): FlowAutomation {
  const list = loadFlows();
  const flow: FlowAutomation = { ...input, id: randomUUID().slice(0, 8), createdAt: new Date().toISOString() };
  list.push(flow);
  saveFlows(list);
  logAudit({ level: "info", actor: "system", action: "flow.create", target: flow.id, detail: flow.name, result: "success" });
  return flow;
}

export function updateFlow(id: string, patch: Partial<FlowAutomation>): FlowAutomation | null {
  const list = loadFlows();
  const f = list.find((x) => x.id === id);
  if (!f) return null;
  if (typeof patch.name === "string" && patch.name.trim()) f.name = patch.name.trim().slice(0, 120);
  if (typeof patch.enabled === "boolean") f.enabled = patch.enabled;
  if (Array.isArray(patch.steps) && patch.steps.length > 0 && patch.steps.length <= MAX_STEPS) f.steps = patch.steps;
  if (typeof patch.requireApproval === "boolean") f.requireApproval = patch.requireApproval;
  saveFlows(list);
  logAudit({ level: "info", actor: "system", action: "flow.update", target: id, detail: Object.keys(patch).join(","), result: "success" });
  return f;
}

export function removeFlow(id: string): boolean {
  const list = loadFlows();
  const next = list.filter((f) => f.id !== id);
  if (next.length === list.length) return false;
  saveFlows(next);
  logAudit({ level: "warn", actor: "system", action: "flow.remove", target: id, detail: "removed", result: "success" });
  return true;
}

export function setFlowBindings(id: string, bindings: { scheduleId?: string; webhookId?: string }): FlowAutomation | null {
  const list = loadFlows();
  const f = list.find((x) => x.id === id);
  if (!f) return null;
  if (bindings.scheduleId !== undefined) f.scheduleId = bindings.scheduleId;
  if (bindings.webhookId !== undefined) f.webhookId = bindings.webhookId;
  saveFlows(list);
  return f;
}

// ─── Runs ──────────────────────────────────────────────────────────────────

export function listRuns(flowId?: string, limit = 20): FlowRun[] {
  const all = loadRuns().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const filtered = flowId ? all.filter((r) => r.flowId === flowId) : all;
  return filtered.slice(0, Math.max(1, Math.min(100, limit)));
}

export function getRun(id: string): FlowRun | undefined { return loadRuns().find((r) => r.id === id); }

function persistRun(run: FlowRun) {
  const all = loadRuns();
  const i = all.findIndex((r) => r.id === run.id);
  if (i >= 0) all[i] = run; else all.push(run);
  saveRuns(all);
}

function previewOf(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return String(s).slice(0, 2048);
  } catch { return ""; }
}

// ─── Execution ─────────────────────────────────────────────────────────────

export async function dryRunMapping(flowId: string, sample: unknown): Promise<{ resolved: unknown[]; warnings: string[] } | { error: string }> {
  const flow = getFlow(flowId);
  if (!flow) return { error: "not found" };
  const ctx = { trigger: sample ?? {}, steps: {} as Record<string, unknown> };
  const warnings: string[] = [];
  const resolved = flow.steps.map((s) => renderTemplate(s.template ?? {}, ctx, warnings).resolved);
  return { resolved, warnings };
}

export async function executeFlowRun(flowId: string, triggerPayload: unknown): Promise<{ runId: string } | { error: string }> {
  const flow = getFlow(flowId);
  if (!flow) return { error: "not found" };
  if (!flow.enabled) return { error: "flow is paused" };
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(triggerPayload ?? null), "utf8"); } catch { return { error: "payload must be JSON-serialisable" }; }
  if (size > INBOUND_JSON_CAP) return { error: "payload exceeds 256 KB" };

  // Journal the trigger (capped) so retries replay the original inputs.
  const JOURNAL_CAP = 32 * 1024;
  const triggerOmitted = size > JOURNAL_CAP;
  const run: FlowRun = {
    id: randomUUID().slice(0, 8), flowId, status: "running", attempts: 1,
    stepResults: [], startedAt: new Date().toISOString(),
    ...(triggerOmitted ? { triggerOmitted: true as const } : { trigger: triggerPayload ?? null }),
  };
  persistRun(run);

  // Agent-task steps run through the jobs pipeline so Activity/Results/
  // Approvals/time-analysis work with zero UI changes.
  let jobId: string | undefined;
  try {
    const { newJob, runJob } = await import("./jobs.js");
    const job = newJob(`flow:${flowId}`);
    job.title = `Flow: ${flow.name}`.slice(0, 120);
    jobId = job.id;
    run.jobId = jobId;
    persistRun(run);
    await runJob(job, async (push) => {
      push(`Flow "${flow.name}" started (${flow.steps.length} steps).`);
      const out = await runSteps(flow, triggerPayload, run, push);
      return { answer: `flow ${run.status}`, flowRunId: run.id, steps: out } as any;
    });
  } catch (e: any) {
    run.status = "failed";
    run.lastError = String(e?.message ?? e).slice(0, 300);
    run.finishedAt = new Date().toISOString();
    scheduleRetry(run, flow);
    persistRun(run);
  }
  logAudit({ level: run.status === "failed" ? "warn" : "info", actor: "system", action: "flow.invoke", target: flowId, detail: `run=${run.id} status=${run.status}`, result: run.status === "failed" ? "failure" : "success", jobId });
  return { runId: run.id };
}

async function runSteps(flow: FlowAutomation, triggerPayload: unknown, run: FlowRun, push: (m: string) => void): Promise<FlowStepResult[]> {
  const stepOutputs: Record<string, unknown> = {};
  const ctxBase = triggerPayload;
  for (const step of flow.steps) {
    // v1 branch: skip-if-not-match.
    if (step.condition) {
      const { resolveTokenPath } = await import("./flow-mapper.js");
      const r = resolveTokenPath(step.condition.path.replace(/^\$\./, "$."), { trigger: ctxBase, steps: stepOutputs });
      const match = r.found && JSON.stringify(r.value) === JSON.stringify(step.condition.equals);
      if (!match) {
        run.stepResults.push({ stepId: step.id, kind: step.kind, status: "skipped", ok: true });
        push(`[${step.id}] skipped (condition did not match).`);
        continue;
      }
    }
    const warnings: string[] = [];
    const resolved = renderTemplate(step.template ?? {}, { trigger: ctxBase, steps: stepOutputs }, warnings).resolved as any;
    try {
      if (step.kind === "connector.call") {
        const { callConnector } = await import("./connectors.js");
        const { scanForSecurityRisks } = await import("./security.js");
        try {
          const findings = scanForSecurityRisks(JSON.stringify(resolved ?? ""), "note");
          if (findings.some((f) => f.severity === "high") && process.env.NAXION_FLOW_BLOCK_SECRETS !== "0") {
            throw new Error("resolved template contains a high-severity secret — refused");
          }
        } catch (e: any) { if (String(e?.message ?? "").includes("refused")) throw e; }
        const method = typeof resolved?.method === "string" ? resolved.method : "GET";
        const path = typeof resolved?.path === "string" ? resolved.path : "/";
        const r: any = await callConnector(step.ref, { method, path, query: resolved?.query, body: resolved?.body, headers: resolved?.headers });
        stepOutputs[step.id] = { body: r.body, status: r.status };
        run.stepResults.push({ stepId: step.id, kind: step.kind, status: r.ok ? "succeeded" : "failed", ok: !!r.ok, statusCode: r.status, bodyPreview: previewOf(r.body), error: r.ok ? undefined : String(r.error ?? `status ${r.status}`).slice(0, 300), warnings });
        push(`[${step.id}] connector ${step.ref} → ${r.ok ? "ok" : "FAILED"}${r.status ? ` (${r.status})` : ""}`);
        if (!r.ok) throw new Error(String(r.error ?? `connector step ${step.id} failed`));
      } else if (step.kind === "webhook.publish") {
        const { publishEvent } = await import("./webhook-delivery.js");
        const event = typeof resolved?.event === "string" && resolved.event ? resolved.event : step.ref;
        await publishEvent(event, resolved?.payload ?? resolved);
        stepOutputs[step.id] = { body: { event }, status: 202 };
        run.stepResults.push({ stepId: step.id, kind: step.kind, status: "succeeded", ok: true, statusCode: 202, bodyPreview: previewOf({ event }), warnings });
        push(`[${step.id}] published ${event}.`);
      } else {
        // agent.task — deterministic prompt built from the mapper, then the
        // normal agent pipeline (approval gates still apply inside it).
        const taskText = typeof resolved?.task === "string" && resolved.task ? resolved.task : step.ref;
        const { generalTaskRunner } = await import("../routes/templates.js");
        const r: any = await generalTaskRunner({ task: String(taskText).slice(0, 8000), save_as_template: false }, push, () => {});
        stepOutputs[step.id] = { body: r?.answer ?? r ?? null };
        run.stepResults.push({ stepId: step.id, kind: step.kind, status: "succeeded", ok: true, bodyPreview: previewOf(r?.answer ?? r), warnings });
        push(`[${step.id}] agent task done.`);
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      if (!run.stepResults.some((s) => s.stepId === step.id)) {
        run.stepResults.push({ stepId: step.id, kind: step.kind, status: "failed", ok: false, error: msg, warnings });
      }
      run.status = "failed";
      run.lastError = msg;
      run.finishedAt = new Date().toISOString();
      persistRun(run);
      throw e;
    }
    persistRun(run);
  }
  run.status = "succeeded";
  run.finishedAt = new Date().toISOString();
  persistRun(run);
  return run.stepResults;
}

function scheduleRetry(run: FlowRun, _flow: FlowAutomation) {
  if (run.attempts >= MAX_ATTEMPTS) return;
  const delay = RETRY_DELAYS_MS[Math.min(run.attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? 60_000;
  run.nextAttemptAt = new Date(Date.now() + delay).toISOString();
  persistRun(run);
}

/** Called by the flow-retry engine tick: re-run due failed runs. */
export async function retryDueRuns(now = Date.now()): Promise<number> {
  const all = loadRuns();
  const due = all.filter((r) => r.status === "failed" && r.nextAttemptAt && new Date(r.nextAttemptAt).getTime() <= now && r.attempts < MAX_ATTEMPTS);
  let n = 0;
  for (const r of due) {
    const flow = getFlow(r.flowId);
    if (!flow || !flow.enabled) continue;
    r.attempts += 1;
    r.status = "running";
    r.nextAttemptAt = undefined;
    persistRun(r);
    try {
      const { newJob, runJob } = await import("./jobs.js");
      const job = newJob(`flow:${flow.id}`);
      job.title = `Flow retry: ${flow.name} (#${r.attempts})`.slice(0, 120);
      r.jobId = job.id;
      await runJob(job, async (push) => {
        const replayTrigger = r.triggerOmitted ? {} : (r.trigger ?? {});
        push(`Retrying flow "${flow.name}" (attempt ${r.attempts})${r.triggerOmitted ? " — original payload exceeded the journal cap, replaying with {}" : " — replaying journaled trigger"}.`);
        // Full re-run from the journaled trigger (not just failed steps):
        // step outputs depend on earlier steps, so partial resume is unsound.
        r.stepResults = [];
        await runSteps(flow, replayTrigger, r, push);
        return { answer: `flow ${r.status}`, flowRunId: r.id } as any;
      });
    } catch {
      r.status = "failed";
      scheduleRetry(r, flow);
      persistRun(r);
    }
    n += 1;
  }
  return n;
}

let retryEngineRegistered = false;
export function ensureFlowRetryEngine() {
  if (retryEngineRegistered) return;
  retryEngineRegistered = true;
  import("./scheduler-registry.js").then(({ registerEngine }) => {
    registerEngine({ name: "flow-retry", intervalSeconds: 60, run: async () => { await retryDueRuns(); } });
  }).catch(() => { retryEngineRegistered = false; });
}

// ─── Schedule trigger engine ───────────────────────────────────────────────
// Fires flows with trigger.kind === "schedule" by reusing the Cadence shape
// + nextFireAt() helper from schedules.ts — no second clock implementation.
// Tick runs every 30s; due flows execute with { scheduledAt } as the trigger
// payload. lastFiredAt is tracked on the flow record itself.

let scheduleEngineRegistered = false;

export function ensureFlowScheduleEngine() {
  if (scheduleEngineRegistered) return;
  scheduleEngineRegistered = true;
  import("./scheduler-registry.js").then(({ registerEngine }) => {
    registerEngine({
      name: "flow-schedule",
      intervalSeconds: 30,
      run: async () => {
        const { nextFireAt } = await import("./schedules.js");
        const flows = loadFlows().filter((f) => f.enabled && f.trigger.kind === "schedule");
        const now = new Date();
        for (const flow of flows) {
          const cadence = (flow.trigger as { kind: "schedule"; cadence: { daysOfWeek: number[]; hour: number; minute: number; once?: string } }).cadence;
          const anchor = flow.lastFiredAt ? new Date(flow.lastFiredAt) : new Date(flow.createdAt);
          const base = isNaN(anchor.getTime()) ? now : (anchor > now ? anchor : now);
          const next = nextFireAt(cadence, base);
          if (!next || next > now.getTime()) continue;
          flow.lastFiredAt = now.toISOString();
          const all = loadFlows();
          const idx = all.findIndex((x) => x.id === flow.id);
          if (idx >= 0) { all[idx].lastFiredAt = now.toISOString(); saveFlows(all); }
          await executeFlowRun(flow.id, { scheduledAt: now.toISOString() });
        }
      },
    });
  }).catch(() => { scheduleEngineRegistered = false; });
}
