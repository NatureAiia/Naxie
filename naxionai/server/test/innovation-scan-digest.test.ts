// Focused tests for synthesizeDigest's migration onto report-pipeline.ts's
// bounded-per-section discipline — the whole point of the migration is that
// one section failing no longer loses the other three (the old single-call
// design's structural bug). See innovation-scan.ts's synthesizeDigest doc
// comment for the full rationale.
import { describe, expect, it, vi, beforeEach } from "vitest";

const llmMock = vi.fn();
vi.mock("../src/lib/llm.js", () => ({
  llmGenerate: vi.fn(async () => "stub"),
  llmGenerateWithMeta: (...args: unknown[]) => llmMock(...args),
}));

const { synthesizeDigest } = await import("../src/lib/innovation-scan.js");

beforeEach(() => { llmMock.mockReset(); });

function finding(overrides: Partial<import("../src/lib/innovation-scan.js").TargetedFinding> = {}) {
  return { weaknessQuery: "q", reason: "weak on citations", summary: "found some stuff", sources: [], ...overrides };
}

describe("synthesizeDigest — partial credit across sections", () => {
  it("returns the empty-digest message when there's nothing to report", async () => {
    const r = await synthesizeDigest([], { repos: [], news: [], curated: [] }, []);
    expect(r.text).toMatch(/Nothing to report yet/);
    expect(llmMock).not.toHaveBeenCalled();
  });

  it("writes all sections when every LLM call succeeds", async () => {
    llmMock.mockImplementation(async (_prompt: string, _sys: string) => ({ text: "Section body.", model: "m1" }));
    const r = await synthesizeDigest([finding()], { repos: [], news: [], curated: [] }, []);
    expect(r.text).toContain("🔧 Fixing our weak spots");
    expect(r.text).toContain("🧠 Model & cost health");
    expect(r.text).toContain("✨ What's new and interesting");
    expect(r.text).toContain("🌍 Why it matters for us");
    expect(r.text).not.toMatch(/Digest integrity/);
    expect(r.modelUsed).toBe("m1");
  });

  it("a single failing section becomes a named gap WITHOUT losing the other sections", async () => {
    let call = 0;
    llmMock.mockImplementation(async () => {
      call += 1;
      // Fail every attempt of the FIRST section (weak-spots: 2 attempts,
      // retry-once), succeed everything after.
      if (call <= 2) throw new Error("model unavailable");
      return { text: "Section body.", model: "m2" };
    });
    const r = await synthesizeDigest([finding()], { repos: [], news: [], curated: [] }, []);
    expect(r.text).toContain("🔧 Fixing our weak spots\n\n_Not written:");
    // The other three sections still made it into the digest.
    expect(r.text).toContain("🧠 Model & cost health\n\nSection body.");
    expect(r.text).toContain("✨ What's new and interesting\n\nSection body.");
    expect(r.text).toContain("🌍 Why it matters for us\n\nSection body.");
    expect(r.text).toMatch(/Digest integrity: 3\/4 sections written/);
  });

  it("retries a failing section once before giving up on it", async () => {
    let attempts = 0;
    llmMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return { text: "Recovered.", model: "m3" };
    });
    const r = await synthesizeDigest([finding()], { repos: [], news: [], curated: [] }, []);
    expect(r.text).toContain("Recovered.");
    expect(r.text).not.toMatch(/Digest integrity/);
  });
});
