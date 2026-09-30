import { describe, expect, it } from "vitest";
import { promptEvalMs, perCallTps, localSynthBudget, writeConcurrency, LOCAL_BUDGET_FLOOR_MS, CLOUD_BUDGET_MS } from "../src/lib/local-budget.js";

describe("promptEvalMs", () => {
  it("returns a finite, positive duration for a normal prompt size", () => {
    const ms = promptEvalMs(2000);
    expect(ms).toBeGreaterThan(0);
    expect(Number.isFinite(ms)).toBe(true);
  });
  it("never returns NaN for malformed input", () => {
    expect(Number.isFinite(promptEvalMs(NaN))).toBe(true);
    expect(Number.isFinite(promptEvalMs(-100))).toBe(true);
  });
  it("grows with prompt size", () => {
    expect(promptEvalMs(5000)).toBeGreaterThan(promptEvalMs(500));
  });
});

describe("perCallTps", () => {
  it("is highest at n=1 and falls as contention increases", () => {
    const n1 = perCallTps(1);
    const n4 = perCallTps(4);
    const n8 = perCallTps(8);
    expect(n1).toBeGreaterThan(n4);
    expect(n4).toBeGreaterThanOrEqual(n8);
  });
  it("never returns zero or negative", () => {
    expect(perCallTps(0)).toBeGreaterThan(0);
    expect(perCallTps(100)).toBeGreaterThan(0);
  });
});

describe("localSynthBudget", () => {
  it("never goes below the floor for a local call", () => {
    const b = localSynthBudget({ maxTokens: 10, inFlight: 1 });
    expect(b.ms).toBeGreaterThanOrEqual(LOCAL_BUDGET_FLOOR_MS);
  });
  it("grows with more tokens and more contention", () => {
    const small = localSynthBudget({ maxTokens: 100, inFlight: 1 });
    const big = localSynthBudget({ maxTokens: 2000, inFlight: 6 });
    expect(big.ms).toBeGreaterThan(small.ms);
  });
  it("adds observed queue wait on top of the derived budget", () => {
    const base = localSynthBudget({ maxTokens: 1000, inFlight: 4 });
    const waited = localSynthBudget({ maxTokens: 1000, inFlight: 4, observedWaitMs: 60_000 });
    expect(waited.ms).toBeGreaterThan(base.ms);
  });
  it("a cloud call with no local fallback gets the flat cloud budget", () => {
    const b = localSynthBudget({ maxTokens: 500, inFlight: 1, cloud: true, localFallback: false });
    expect(b.ms).toBe(CLOUD_BUDGET_MS);
  });
  it("a cloud call WITH local fallback is budgeted for whichever path is larger", () => {
    const b = localSynthBudget({ maxTokens: 500, inFlight: 1, cloud: true });
    const local = localSynthBudget({ maxTokens: 500, inFlight: 1 });
    expect(b.ms).toBe(Math.max(CLOUD_BUDGET_MS, local.ms));
  });
});

describe("writeConcurrency", () => {
  it("is always 1 when the cloud is off", () => {
    expect(writeConcurrency({ cloud: false, agents: 6, laneCap: 4 })).toBe(1);
  });
  it("is bounded by both agent count and lane cap when the cloud is on", () => {
    expect(writeConcurrency({ cloud: true, agents: 6, laneCap: 4 })).toBe(4);
    expect(writeConcurrency({ cloud: true, agents: 2, laneCap: 4 })).toBe(2);
  });
  it("never returns less than 1", () => {
    expect(writeConcurrency({ cloud: true, agents: 0, laneCap: 0 })).toBe(1);
  });
});
