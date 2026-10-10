// Pure-function contract for sanitizeScheduleName (schedules.ts).
// Agent-generated names arrive as raw task text — markdown, links, and
// over-length strings must never reach the Schedules UI verbatim.
import { describe, expect, it } from "vitest";
import { sanitizeScheduleName } from "../src/lib/schedules.js";

describe("sanitizeScheduleName", () => {
  it("strips markdown markers", () => {
    expect(sanitizeScheduleName("Scheduled: ** Naxie - Personal Assistant")).toBe(
      "Scheduled: Naxie - Personal Assistant",
    );
  });

  it("turns [text](url) links into plain text", () => {
    expect(sanitizeScheduleName("Read [the report](https://example.com/x) daily")).toBe(
      "Read the report daily",
    );
  });

  it("truncates at a word boundary with an ellipsis", () => {
    const input = "Morning briefing for the whole operations team every day";
    const out = sanitizeScheduleName(input, 30);
    expect(out.endsWith("…")).toBe(true);
    // The kept text must end exactly where a word ends in the source.
    const body = out.slice(0, -1);
    expect(input.startsWith(body)).toBe(true);
    const next = input[body.length];
    expect(next === undefined || next === " ").toBe(true);
  });

  it("falls back for blank input", () => {
    expect(sanitizeScheduleName("   ")).toBe("Untitled schedule");
  });

  it("leaves clean names untouched", () => {
    expect(sanitizeScheduleName("Morning digest")).toBe("Morning digest");
  });
});
