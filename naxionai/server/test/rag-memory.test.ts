import { describe, it, expect, beforeEach } from "vitest";
import { rememberRagQuery, expandFollowUpQuery, isFollowUp, _clearRagMemoryForTests } from "../src/lib/rag-memory.js";

describe("rag-memory", () => {
  beforeEach(() => _clearRagMemoryForTests());

  it("detects follow-ups", () => {
    expect(isFollowUp("that file")).toBe(true);
    expect(isFollowUp("tell me more")).toBe(true);
    expect(isFollowUp("Cognify borehole contract")).toBe(false);
  });

  it("expands a follow-up from session context", () => {
    expect(expandFollowUpQuery("s1", "that file")).toBeNull();
    rememberRagQuery("s1", "Cognify borehole", [
      { source: "vault", path: "deeds/cognify.md", preview: "borehole", score: 3 },
      { source: "vault", path: "deeds/other.md", preview: "other", score: 2 },
    ]);
    const expanded = expandFollowUpQuery("s1", "that file");
    expect(expanded).toMatch(/Cognify borehole/);
    // Ordinal resolves to the remembered second hit.
    expect(expandFollowUpQuery("s1", "the second one")).toMatch(/other\.md/);
  });

  it("isolates sessions", () => {
    rememberRagQuery("a", "Cognify", [{ source: "vault", path: "x.md", preview: "x", score: 1 }]);
    expect(expandFollowUpQuery("b", "that file")).toBeNull();
  });
});
