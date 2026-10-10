// Delivery helpers: speech shaping for voice notes + lateness notes.
// Pure string contracts — the Telegram/daemon wiring stays thin.
import { describe, expect, it } from "vitest";
import { markdownToSpeech } from "../src/lib/telegram-bridge.js";
import { formatLateNote } from "../src/lib/schedules.js";

describe("markdownToSpeech", () => {
  it("strips headings, bold and bullets into speakable words", () => {
    const out = markdownToSpeech("## Focus today\n- **Ship X** — users wait\n1. Call Sara");
    expect(out).not.toMatch(/[#*]/);
    expect(out).toContain("Focus today");
    expect(out).toContain("Ship X");
    expect(out).toContain("Call Sara");
  });

  it("drops code and bare URLs (unpronounceable)", () => {
    const out = markdownToSpeech("Run `pnpm dev` then open https://example.com/x now");
    expect(out).toContain("pnpm dev");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("`");
  });

  it("caps length with an ellipsis", () => {
    expect(markdownToSpeech("word ".repeat(2000), 100)).toMatch(/\.\.\.|…$/);
  });

  it("keeps link text, drops the URL", () => {
    expect(markdownToSpeech("[the report](https://example.com/x)")).toBe("the report");
  });
});

describe("formatLateNote", () => {
  it("is empty when on time", () => {
    expect(formatLateNote(undefined)).toBe("");
    expect(formatLateNote(60_000)).toBe("");
  });

  it("names the missed minutes when late", () => {
    const out = formatLateNote(200 * 60_000);
    expect(out).toContain("Running late");
    expect(out).toContain("200 min");
  });
});
