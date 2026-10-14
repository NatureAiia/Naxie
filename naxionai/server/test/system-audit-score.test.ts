// enforceHealthScore: the MD Executive Summary must quote the computed score,
// never an LLM-invented one (gemma4 wrote "73/100" on an 82 day, 2026-10-14).
import { describe, expect, it } from "vitest";
import { enforceHealthScore } from "../src/lib/system-audit.js";

const report = (summary: string) =>
  `## 🏢 Executive Summary\n${summary}\n\n## 📊 System Map\n- Trend low was 64/100 on 2026-10-11`;

describe("enforceHealthScore", () => {
  it("replaces a wrong score in the executive summary", () => {
    const out = enforceHealthScore(report("System health is currently 73/100, stable."), 82);
    expect(out).toContain("System health is currently 82/100, stable.");
  });

  it("leaves scores in other sections alone", () => {
    const out = enforceHealthScore(report("Health 73/100."), 82);
    expect(out).toContain("Trend low was 64/100");
  });

  it("prepends the score when the summary omits it", () => {
    const out = enforceHealthScore(report("All good."), 82);
    expect(out).toContain("Health 82/100. All good.");
  });

  it("is a no-op without the summary heading", () => {
    expect(enforceHealthScore("plain text 10/100", 82)).toBe("plain text 10/100");
  });

  it("does not mangle $ in the replacement", () => {
    const out = enforceHealthScore(report("Health 50/100, spend $0.50 ($&)."), 82);
    expect(out).toContain("Health 82/100, spend $0.50 ($&).");
  });
});
