import { beforeEach, describe, expect, it } from "vitest";
import { withLocalLlmSlot, llmLaneStatus, _resetLaneForTests } from "../src/lib/llm-lane.js";

beforeEach(() => { _resetLaneForTests(); });

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe("withLocalLlmSlot", () => {
  it("runs a single call immediately with no contention", async () => {
    const result = await withLocalLlmSlot(async () => 42);
    expect(result).toBe(42);
    expect(llmLaneStatus().admitted).toBe(1);
    expect(llmLaneStatus().queued).toBe(0);
  });

  it("queues calls beyond the cap and releases them in order", async () => {
    const cap = llmLaneStatus().cap;
    const order: number[] = [];
    const releases: (() => void)[] = [];
    const calls = Array.from({ length: cap + 2 }, (_, i) =>
      withLocalLlmSlot(() => new Promise<void>(resolve => {
        order.push(i);
        releases.push(resolve);
      })),
    );
    // Let the first `cap` calls actually start.
    await sleep(10);
    expect(order.length).toBe(cap);
    expect(llmLaneStatus().waiting).toBe(2);

    // Release everything as it becomes available — releasing an active call
    // lets the next queued one start (and push its own resolver), so keep
    // draining until every call has both started and been released.
    let releasedCount = 0;
    while (releasedCount < cap + 2) {
      while (releasedCount < releases.length) {
        releases[releasedCount]();
        releasedCount++;
      }
      await sleep(5);
    }
    await Promise.all(calls);
    expect(order.length).toBe(cap + 2);
  });

  it("rejects immediately if the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(withLocalLlmSlot(async () => 1, ctrl.signal)).rejects.toThrow(/aborted before acquiring/);
  });

  it("a queued call can be cancelled via its signal without leaking a slot", async () => {
    const cap = llmLaneStatus().cap;
    const releases: (() => void)[] = [];
    // Fill every slot with a call that won't resolve until we say so.
    const holders = Array.from({ length: cap }, () =>
      withLocalLlmSlot(() => new Promise<void>(resolve => releases.push(resolve))),
    );
    await sleep(10);

    const ctrl = new AbortController();
    const queued = withLocalLlmSlot(async () => "should not run", ctrl.signal);
    await sleep(10);
    ctrl.abort();
    await expect(queued).rejects.toThrow(/aborted while waiting/);

    releases.forEach(r => r());
    await Promise.all(holders);
  });

  it("releases the slot even when fn throws", async () => {
    await expect(withLocalLlmSlot(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // A fresh call should still be admitted immediately (slot was released).
    const result = await withLocalLlmSlot(async () => "ok");
    expect(result).toBe("ok");
  });
});
