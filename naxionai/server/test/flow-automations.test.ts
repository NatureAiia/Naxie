import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateFlowInput, createFlow, getFlow, listFlows, dryRunMapping,
  executeFlowRun, getRun, retryDueRuns, _resetForTests,
} from "../src/lib/flow-automations.js";

beforeEach(() => {
  process.env.NAXION_STATE_DIR = mkdtempSync(join(tmpdir(), "flows-"));
  _resetForTests();
});

afterEach(() => {
  delete process.env.NAXION_STATE_DIR;
});

describe("flow validation", () => {
  it("rejects empty steps", () => {
    const r = validateFlowInput({ name: "x", trigger: { kind: "webhook" }, steps: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects more than 10 steps", () => {
    const steps = Array.from({ length: 11 }, (_, i) => ({ kind: "webhook.publish", ref: "evt", template: { n: i } }));
    const r = validateFlowInput({ name: "x", trigger: { kind: "webhook" }, steps });
    expect(r.ok).toBe(false);
  });

  it("rejects bad schedule cadence", () => {
    const r = validateFlowInput({ name: "x", trigger: { kind: "schedule", cadence: { hour: 99, minute: 0 } }, steps: [{ kind: "webhook.publish", ref: "e" }] });
    expect(r.ok).toBe(false);
  });

  it("accepts a valid webhook flow", () => {
    const r = validateFlowInput({
      name: "Stripe → CRM",
      trigger: { kind: "webhook" },
      steps: [{ kind: "connector.call", ref: "crm", template: { method: "POST", path: "/leads", body: { email: "{{$.trigger.body.email}}" } } }],
    });
    expect(r.ok).toBe(true);
  });
});

describe("flow dry-run", () => {
  it("resolves tokens without side effects", async () => {
    const v = validateFlowInput({
      name: "t", trigger: { kind: "webhook" },
      steps: [{ id: "s1", kind: "webhook.publish", ref: "lead.created", template: { event: "lead.created", payload: { email: "{{$.trigger.body.email}}" } } }],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const f = createFlow(v.value);
    expect(getFlow(f.id)?.name).toBe("t");
    expect(listFlows().length).toBe(1);
    const dry = await dryRunMapping(f.id, { body: { email: "a@x.com" } });
    expect("error" in dry).toBe(false);
    if (!("error" in dry)) {
      expect(JSON.stringify(dry.resolved)).toContain("a@x.com");
    }
  });
});

describe("trigger journaling", () => {
  function makePublishFlow() {
    const v = validateFlowInput({
      name: "journal", trigger: { kind: "webhook" },
      steps: [{ id: "s1", kind: "webhook.publish", ref: "test.event", template: { event: "test.event", payload: { email: "{{$.trigger.body.email}}" } } }],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("invalid fixture");
    return createFlow(v.value);
  }

  it("journals the trigger payload on the run", async () => {
    const f = makePublishFlow();
    const r = await executeFlowRun(f.id, { body: { email: "a@x.com" } });
    expect("runId" in r).toBe(true);
    if (!("runId" in r)) return;
    const run = getRun(r.runId);
    expect(run?.status).toBe("succeeded");
    expect((run?.trigger as any)?.body?.email).toBe("a@x.com");
    expect(run?.triggerOmitted).toBeUndefined();
  }, 30_000);

  it("omits oversized payloads from the journal but still runs", async () => {
    const f = makePublishFlow();
    const big = { body: { blob: "x".repeat(40 * 1024) } };
    const r = await executeFlowRun(f.id, big);
    expect("runId" in r).toBe(true);
    if (!("runId" in r)) return;
    const run = getRun(r.runId);
    expect(run?.triggerOmitted).toBe(true);
    expect(run?.trigger).toBeUndefined();
  }, 30_000);

  it("retryDueRuns finds nothing due on a fresh store", async () => {
    makePublishFlow();
    expect(await retryDueRuns()).toBe(0);
  });
});
