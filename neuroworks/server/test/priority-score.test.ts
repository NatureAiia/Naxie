import { describe, expect, it, vi, beforeEach } from "vitest";

const llmMock = vi.fn();
vi.mock("../src/lib/llm.js", () => ({
  llmGenerateWithMeta: (...args: unknown[]) => llmMock(...args),
}));

import { scorePriority } from "../src/lib/priority-score.js";

beforeEach(() => { llmMock.mockReset(); });

describe("scorePriority", () => {
  it("combines sub-scores into a 0-100 composite, inverting effort", async () => {
    llmMock.mockResolvedValue({
      text: JSON.stringify({ urgency: 10, impact: 10, effort: 0, risk: 10, rationale: "very important" }),
      model: "stub",
    });
    const r = await scorePriority({ title: "Fix prod outage" });
    // urgency 10*.35 + impact 10*.35 + effortInverted(10)*.15 + risk 10*.15 = 10 → *10 = 100
    expect(r.composite).toBe(100);
    expect(r.subScores).toEqual({ urgency: 10, impact: 10, effort: 0, risk: 10 });
    expect(r.rationale).toBe("very important");
  });

  it("high effort pulls the composite down", async () => {
    llmMock.mockResolvedValue({
      text: JSON.stringify({ urgency: 5, impact: 5, effort: 10, risk: 5, rationale: "" }),
      model: "stub",
    });
    const r = await scorePriority({ title: "Big refactor" });
    // urgency 5*.35 + impact 5*.35 + effortInverted(0)*.15 + risk 5*.15 = 4.25 → 42.5
    expect(r.composite).toBe(42.5);
  });

  it("parses JSON wrapped in a markdown fence with surrounding prose", async () => {
    llmMock.mockResolvedValue({
      text: 'Here is my assessment:\n```json\n{"urgency": 3, "impact": 4, "effort": 2, "risk": 1, "rationale": "low stakes"}\n```\nHope that helps!',
      model: "stub",
    });
    const r = await scorePriority({ title: "Minor copy tweak" });
    expect(r.subScores.urgency).toBe(3);
    expect(r.rationale).toBe("low stakes");
  });

  it("clamps out-of-range or missing sub-scores instead of throwing", async () => {
    llmMock.mockResolvedValue({
      text: JSON.stringify({ urgency: 99, impact: -5, risk: 6 }), // effort missing entirely
      model: "stub",
    });
    const r = await scorePriority({ title: "x" });
    expect(r.subScores.urgency).toBe(10);
    expect(r.subScores.impact).toBe(0);
    expect(r.subScores.effort).toBe(0);
  });

  it("throws when the model response has no parseable JSON at all", async () => {
    llmMock.mockResolvedValue({ text: "I refuse to score this.", model: "stub" });
    await expect(scorePriority({ title: "x" })).rejects.toThrow(/no parseable JSON/);
  });

  it("passes title/detail/context through into the prompt", async () => {
    llmMock.mockResolvedValue({ text: '{"urgency":1,"impact":1,"effort":1,"risk":1}', model: "stub" });
    await scorePriority({ title: "Ship the report", detail: "quarterly numbers", context: "role: researcher" });
    const [prompt, system, opts] = llmMock.mock.calls[0];
    expect(prompt).toContain("Ship the report");
    expect(prompt).toContain("quarterly numbers");
    expect(prompt).toContain("role: researcher");
    expect(system).toMatch(/urgency/);
    expect(opts).toMatchObject({ profile: "extraction", temperature: 0 });
  });
});
