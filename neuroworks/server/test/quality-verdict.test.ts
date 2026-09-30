// quality-verdict.ts — pure pass/score computation shared by quality.check's
// two graders (LLM-authored JSON and Jev typed-judgment). Disk-free/network-
// free, so it's tested directly here, unlike quality.check's own graders
// (an LLM call and an HTTP call) which aren't — same convention as
// org-tasks.test.ts's pure-logic-only scope.

import { describe, expect, it } from "vitest";
import { computeQualityVerdict, deterministicIssues, type QualityAxes } from "../src/lib/quality-verdict.js";

const GOOD: QualityAxes = { factuality_risk: 0.1, citation_coverage: 0.9, persona_fit: 0.9, prompt_alignment: 0.9 };
const BAD: QualityAxes = { factuality_risk: 0.9, citation_coverage: 0.1, persona_fit: 0.1, prompt_alignment: 0.1 };

describe("computeQualityVerdict — research (citationApplies)", () => {
  const opts = { citationApplies: true, forceUngrounded: false };

  it("passes a well-cited, low-risk, on-target answer", () => {
    const { pass } = computeQualityVerdict(GOOD, opts);
    expect(pass).toBe(true);
  });

  it("fails a hallucination-risky, uncited, off-target answer", () => {
    const { pass } = computeQualityVerdict(BAD, opts);
    expect(pass).toBe(false);
  });

  it("fails on prompt_alignment alone even when every other axis is perfect", () => {
    const axes: QualityAxes = { ...GOOD, prompt_alignment: 0.2 };
    expect(computeQualityVerdict(axes, opts).pass).toBe(false);
  });

  it("fails on citation_coverage at the boundary (must be > 0.4, not >=)", () => {
    const axes: QualityAxes = { ...GOOD, citation_coverage: 0.4 };
    expect(computeQualityVerdict(axes, opts).pass).toBe(false);
  });
});

describe("computeQualityVerdict — ungrounded (direct conversational)", () => {
  const opts = { citationApplies: false, forceUngrounded: true };

  it("passes on persona_fit + low-enough factuality even with zero citation_coverage", () => {
    const axes: QualityAxes = { factuality_risk: 0.5, citation_coverage: 0, persona_fit: 0.8, prompt_alignment: 0.8 };
    expect(computeQualityVerdict(axes, opts).pass).toBe(true);
  });

  it("only fails factuality on EGREGIOUS risk (>= 0.85), not moderate risk", () => {
    const axes: QualityAxes = { factuality_risk: 0.6, citation_coverage: 0, persona_fit: 0.9, prompt_alignment: 0.9 };
    expect(computeQualityVerdict(axes, opts).pass).toBe(true);
  });

  it("fails on egregious hallucination risk", () => {
    const axes: QualityAxes = { factuality_risk: 0.9, citation_coverage: 0, persona_fit: 0.9, prompt_alignment: 0.9 };
    expect(computeQualityVerdict(axes, opts).pass).toBe(false);
  });
});

describe("computeQualityVerdict — creative/procedural/code (non-research, grounded)", () => {
  const opts = { citationApplies: false, forceUngrounded: false };

  it("passes persona-led answers regardless of citation_coverage", () => {
    const axes: QualityAxes = { factuality_risk: 0.3, citation_coverage: 0, persona_fit: 0.7, prompt_alignment: 0.7 };
    expect(computeQualityVerdict(axes, opts).pass).toBe(true);
  });
});

describe("computeQualityVerdict — score", () => {
  it("is always between 0 and 1, rounded to 2 decimals", () => {
    for (const opts of [{ citationApplies: true, forceUngrounded: false }, { citationApplies: false, forceUngrounded: true }, { citationApplies: false, forceUngrounded: false }]) {
      const { score } = computeQualityVerdict(GOOD, opts);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      expect(score).toBe(Math.round(score * 100) / 100);
    }
  });
});

describe("deterministicIssues", () => {
  it("is empty for a fully good answer", () => {
    expect(deterministicIssues(GOOD, { citationApplies: true, forceUngrounded: false })).toEqual([]);
  });

  it("flags prompt_alignment first when it's the failure", () => {
    const axes: QualityAxes = { ...GOOD, prompt_alignment: 0.1 };
    const issues = deterministicIssues(axes, { citationApplies: true, forceUngrounded: false });
    expect(issues[0]).toMatch(/prompt_alignment/);
  });

  it("only flags factuality_risk past the egregious threshold for ungrounded answers", () => {
    const axes: QualityAxes = { factuality_risk: 0.6, citation_coverage: 0, persona_fit: 0.9, prompt_alignment: 0.9 };
    expect(deterministicIssues(axes, { citationApplies: false, forceUngrounded: true })).toEqual([]);
  });
});
