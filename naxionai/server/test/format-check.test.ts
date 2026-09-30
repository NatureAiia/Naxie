import { describe, expect, it } from "vitest";
import { checkRequestedFormat, looksLikeJson, hasMarkdownTable, countListItems, FORMAT_BREAK_ALIGNMENT_CAP } from "../src/lib/format-check.js";

describe("checkRequestedFormat", () => {
  it("passes silently when nothing was requested", () => {
    expect(checkRequestedFormat("tell me about Zimbabwe", "some prose")).toEqual({ requested: [], violations: [], satisfied: true });
  });

  it("flags JSON requested but not delivered", () => {
    const v = checkRequestedFormat("give me the results as JSON", "Here are the results in plain prose.");
    expect(v.requested).toContain("json");
    expect(v.satisfied).toBe(false);
  });

  it("passes when JSON was requested and delivered", () => {
    const v = checkRequestedFormat("return this as json", '```json\n{"a":1}\n```');
    expect(v.satisfied).toBe(true);
  });

  it("flags a table request with no table", () => {
    const v = checkRequestedFormat("put this in a table", "Just some text, no table here.");
    expect(v.satisfied).toBe(false);
  });

  it("flags a count mismatch", () => {
    const v = checkRequestedFormat("give me 5 bullet points", "- one\n- two\n- three");
    expect(v.violations.some(x => x.includes("asked for 5"))).toBe(true);
  });

  it("flags a document request answered with raw JSON", () => {
    const v = checkRequestedFormat("write me a report", '{"summary":"x"}');
    expect(v.satisfied).toBe(false);
  });

  it("FORMAT_BREAK_ALIGNMENT_CAP sits below the 0.5 pass line", () => {
    expect(FORMAT_BREAK_ALIGNMENT_CAP).toBeLessThan(0.5);
  });
});

describe("format-check helpers", () => {
  it("looksLikeJson detects fenced and bare JSON", () => {
    expect(looksLikeJson('```json\n[1,2,3]\n```')).toBe(true);
    expect(looksLikeJson("not json at all")).toBe(false);
  });
  it("hasMarkdownTable requires a header separator row", () => {
    expect(hasMarkdownTable("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
    expect(hasMarkdownTable("a | b")).toBe(false);
  });
  it("countListItems counts dash/star/numbered items", () => {
    expect(countListItems("- a\n* b\n1. c\n2) d")).toBe(4);
  });
});
