import { describe, expect, it, afterEach } from "vitest";
import { repairTranscript, setAsrCorrections, resetAsrCorrections } from "../src/lib/asr-repair.js";

afterEach(() => {
  resetAsrCorrections();
});

describe("repairTranscript", () => {
  it("applies a built-in single-word correction", () => {
    const r = repairTranscript("Show na is a language I speak");
    expect(r.text).toBe("shona is a language I speak");
    expect(r.corrections).toEqual([{ from: "show na", to: "shona" }]);
  });

  it("applies a built-in multi-word phrase correction", () => {
    const r = repairTranscript("Tie tender said thank you");
    expect(r.text).toBe("tatenda said thank you");
  });

  it("is case-insensitive", () => {
    const r = repairTranscript("SHOW NA and Tie Tender");
    expect(r.text.toLowerCase()).toBe("shona and tatenda");
  });

  it("only matches whole words, not substrings", () => {
    const r = repairTranscript("showna without a space should not match");
    expect(r.corrections).toEqual([]);
    expect(r.text).toBe("showna without a space should not match");
  });

  it("applies multiple distinct corrections in one pass", () => {
    const r = repairTranscript("get see and door that");
    expect(r.text).toBe("magetsi and ndoda");
    expect(r.corrections.length).toBe(2);
  });

  it("returns unchanged text with no corrections when nothing matches", () => {
    const r = repairTranscript("perfectly ordinary English sentence");
    expect(r.text).toBe("perfectly ordinary English sentence");
    expect(r.corrections).toEqual([]);
  });

  it("handles empty input", () => {
    expect(repairTranscript("")).toEqual({ text: "", corrections: [] });
  });

  it("setAsrCorrections replaces the table and resetAsrCorrections restores defaults", () => {
    setAsrCorrections({ foo: "bar" });
    expect(repairTranscript("say foo now").text).toBe("say bar now");
    expect(repairTranscript("show na").corrections).toEqual([]);
    resetAsrCorrections();
    expect(repairTranscript("show na").text).toBe("shona");
  });

  it("empty correction table disables repair entirely", () => {
    setAsrCorrections({});
    expect(repairTranscript("show na").text).toBe("show na");
  });

  it("prefers the longer phrase when a shorter entry shares a prefix", () => {
    setAsrCorrections({ "send a": "senda", "send a friend": "SENDAFRIEND" });
    expect(repairTranscript("please send a friend now").text).toBe("please SENDAFRIEND now");
  });
});
