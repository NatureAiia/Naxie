import { describe, expect, it } from "vitest";
import { runOutcome, outcomeToJobStatus } from "../src/lib/run-outcome.js";

describe("runOutcome", () => {
  it("succeeds by default for a plain answer", () => {
    expect(runOutcome({ answer: "here you go" })).toEqual({ outcome: "succeeded", delivered: true });
  });

  it("trusts a structured failed flag over readable prose", () => {
    const v = runOutcome({ failed: true, error: "network down", answer: "This looks like a fine answer." });
    expect(v.outcome).toBe("failed");
    expect(v.delivered).toBe(false);
    expect(v.reason).toBe("network down");
  });

  it("trusts a structured degraded flag", () => {
    const v = runOutcome({ degraded: true, answer: "partial output" });
    expect(v.outcome).toBe("degraded");
    expect(v.delivered).toBe(false);
  });

  it("catches a known give-up sentinel in an unstructured answer", () => {
    const v = runOutcome({ answer: "_LLM reflection failed after retry (`fetch failed`)..._" });
    expect(v.outcome).toBe("failed");
    expect(v.delivered).toBe(false);
  });

  it("does not flag prose that merely discusses failure", () => {
    const v = runOutcome({ answer: "Yesterday's outage failed three customer requests before recovery." });
    expect(v.outcome).toBe("succeeded");
  });

  it("handles null/undefined results without throwing", () => {
    expect(runOutcome(null)).toEqual({ outcome: "succeeded", delivered: true });
    expect(runOutcome(undefined)).toEqual({ outcome: "succeeded", delivered: true });
  });
});

describe("outcomeToJobStatus", () => {
  it("maps degraded to succeeded (readable but not counted as delivered)", () => {
    expect(outcomeToJobStatus("degraded")).toBe("succeeded");
  });
  it("maps failed to failed and succeeded to succeeded", () => {
    expect(outcomeToJobStatus("failed")).toBe("failed");
    expect(outcomeToJobStatus("succeeded")).toBe("succeeded");
  });
});
