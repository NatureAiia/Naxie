import { describe, it, expect } from "vitest";
import { detectIntent, extractEntityHints, intentStrategy } from "../src/lib/rag-intent.js";

describe("rag-intent", () => {
  it("detects analytics + status intents", () => {
    expect(detectIntent("how many overdue tasks?")).toContain("analytics");
    expect(detectIntent("system status and pending approvals")).toContain("status");
  });

  it("defaults to search", () => {
    expect(detectIntent("Cognify borehole")).toEqual(["search"]);
  });

  it("extracts entity hints", () => {
    expect(extractEntityHints("show my leave requests")).toContain("leave");
    expect(extractEntityHints("compare contract amounts")).toContain("contract");
  });

  it("boosts structured for analytics", () => {
    const s = intentStrategy(["analytics"]);
    expect(s.boostStructured).toBe(true);
    expect(intentStrategy(["search"]).boostStructured).toBe(false);
  });
});
