import { describe, it, expect } from "vitest";
import { scanRetention, verifyShareToken, custodyTimeline } from "../src/lib/file-governance.js";

describe("file-governance", () => {
  it("scans retention expiries", () => {
    const out = scanRetention([
      { path: "a.md", expiryDate: "2020-01-01" },
      { path: "b.md", expiryDate: "2999-01-01" },
      { path: "c.md" },
    ]);
    expect(out.map(f => f.path)).toEqual(["a.md"]);
    expect(out[0].status).toBe("expired");
  });

  it("rejects unknown share tokens", () => {
    expect(verifyShareToken("nope")).toEqual({ ok: false, error: "unknown token" });
  });

  it("returns empty timeline for unknown path", () => {
    expect(custodyTimeline("definitely/not-a-real-file-xyz.md")).toEqual([]);
  });
});
