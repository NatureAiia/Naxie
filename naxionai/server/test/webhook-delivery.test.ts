import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTarget, listTargets, removeTarget, setTargetEnabled,
  publishEvent, listDeliveries, retryFailedDeliveries, replayDelivery,
  _resetForTests,
} from "../src/lib/webhook-delivery.js";

const realFetch = global.fetch;

beforeEach(() => {
  process.env.NEUROWORKS_STATE_DIR = mkdtempSync(join(tmpdir(), "webhook-delivery-"));
  _resetForTests();
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.NEUROWORKS_STATE_DIR;
});

function mockFetchOnce(status: number) {
  global.fetch = vi.fn(async () => new Response("", { status })) as any;
}

function mockFetchReject(message = "network down") {
  global.fetch = vi.fn(async () => { throw new Error(message); }) as any;
}

describe("webhook targets", () => {
  it("creates a target with an auto-generated secret when none is given", () => {
    const t = addTarget({ label: "My CRM", url: "https://example.com/hook" });
    expect(t.secret.length).toBeGreaterThan(20);
    expect(t.enabled).toBe(true);
    expect(listTargets().map(x => x.id)).toContain(t.id);
  });

  it("removes a target", () => {
    const t = addTarget({ label: "x", url: "https://example.com/hook" });
    expect(removeTarget(t.id)).toBe(true);
    expect(removeTarget(t.id)).toBe(false);
  });

  it("toggles enabled", () => {
    const t = addTarget({ label: "x", url: "https://example.com/hook" });
    const updated = setTargetEnabled(t.id, false);
    expect(updated?.enabled).toBe(false);
  });
});

describe("publishEvent delivery", () => {
  it("marks a delivery success on 2xx and signs the request", async () => {
    mockFetchOnce(200);
    const target = addTarget({ label: "x", url: "https://example.com/hook" });
    const out = await publishEvent("dataset.published", { id: "d1" });
    expect(out.dispatched).toBe(1);
    const deliveries = listDeliveries({ targetId: target.id });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("success");
    expect(deliveries[0].attempts).toBe(1);
    const call = (global.fetch as any).mock.calls[0];
    expect(call[1].headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("marks a delivery failed on non-2xx and records the error", async () => {
    mockFetchOnce(500);
    addTarget({ label: "x", url: "https://example.com/hook" });
    await publishEvent("dataset.published", { id: "d1" });
    const deliveries = listDeliveries();
    expect(deliveries[0].status).toBe("failed");
    expect(deliveries[0].lastError).toMatch(/500/);
  });

  it("skips disabled targets and targets not subscribed to the event", async () => {
    mockFetchOnce(200);
    const disabled = addTarget({ label: "disabled", url: "https://example.com/hook" });
    setTargetEnabled(disabled.id, false);
    addTarget({ label: "filtered", url: "https://example.com/hook", events: ["other.event"] });
    const out = await publishEvent("dataset.published", { id: "d1" });
    expect(out.dispatched).toBe(0);
    expect(listDeliveries()).toHaveLength(0);
  });

  it("an empty events[] target receives every event", async () => {
    mockFetchOnce(200);
    addTarget({ label: "catch-all", url: "https://example.com/hook", events: [] });
    const out = await publishEvent("anything.at.all", { x: 1 });
    expect(out.dispatched).toBe(1);
  });
});

describe("retry and dead-letter", () => {
  it("retries a failed delivery and can eventually dead-letter it", async () => {
    mockFetchReject();
    addTarget({ label: "x", url: "https://example.com/hook" });
    await publishEvent("e", {});
    expect(listDeliveries()[0].status).toBe("failed");
    expect(listDeliveries()[0].attempts).toBe(1);

    // Retry 4 more times (attempts 2..5) — the 5th attempt crosses MAX_ATTEMPTS.
    for (let i = 0; i < 4; i++) await retryFailedDeliveries();
    const delivery = listDeliveries()[0];
    expect(delivery.attempts).toBe(5);
    expect(delivery.status).toBe("dead_letter");
  });

  it("retryFailedDeliveries never touches a delivery whose target was disabled since", async () => {
    mockFetchReject();
    const t = addTarget({ label: "x", url: "https://example.com/hook" });
    await publishEvent("e", {});
    setTargetEnabled(t.id, false);
    const { retried } = await retryFailedDeliveries();
    expect(retried).toBe(0);
    expect(listDeliveries()[0].attempts).toBe(1);
  });

  it("replayDelivery resets attempts and can succeed after a prior dead-letter", async () => {
    mockFetchReject();
    addTarget({ label: "x", url: "https://example.com/hook" });
    await publishEvent("e", {});
    for (let i = 0; i < 4; i++) await retryFailedDeliveries();
    const dead = listDeliveries()[0];
    expect(dead.status).toBe("dead_letter");

    mockFetchOnce(200);
    const replayed = await replayDelivery(dead.id);
    expect(replayed?.status).toBe("success");
    expect(replayed?.attempts).toBe(1);
  });

  it("replayDelivery on an unknown id returns null", async () => {
    expect(await replayDelivery("nope")).toBeNull();
  });
});
