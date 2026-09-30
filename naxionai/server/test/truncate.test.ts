import { describe, expect, it } from "vitest";
import { truncateWithMarker, wouldTruncate } from "../src/lib/truncate.js";

describe("truncateWithMarker", () => {
  it("returns text unchanged when it fits", () => {
    expect(truncateWithMarker("short", 100)).toBe("short");
  });
  it("never emits a marker on intact text", () => {
    const t = "x".repeat(50);
    expect(truncateWithMarker(t, 50)).toBe(t);
  });
  it("cuts and appends a marker when over cap", () => {
    const t = "x".repeat(1000);
    const out = truncateWithMarker(t, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toMatch(/truncated at \d+ characters of 1000/);
  });
  it("the result always fits inside the cap exactly, for caps large enough to hold the marker", () => {
    // The module's own doc notes this holds at realistic call-site caps
    // (smallest in this codebase is in the thousands); a cap too small to
    // hold even the marker text falls back to an honesty-over-budget marker
    // that may itself exceed a pathologically tiny cap — not exercised here.
    for (const cap of [500, 8000]) {
      const out = truncateWithMarker("y".repeat(cap * 3), cap);
      expect(out.length).toBeLessThanOrEqual(cap);
    }
  });
  it("cap <= 0 or non-finite means no truncation", () => {
    const t = "x".repeat(1000);
    expect(truncateWithMarker(t, 0)).toBe(t);
    expect(truncateWithMarker(t, NaN)).toBe(t);
    expect(truncateWithMarker(t, -5)).toBe(t);
  });
});

describe("wouldTruncate", () => {
  it("matches whether truncateWithMarker would actually cut", () => {
    expect(wouldTruncate("x".repeat(10), 5)).toBe(true);
    expect(wouldTruncate("x".repeat(5), 10)).toBe(false);
    expect(wouldTruncate("x".repeat(5), 0)).toBe(false);
  });
});
