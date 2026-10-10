// Briefing memory contract (briefing-memory.ts): extraction, round-trip,
// same-date overwrite, strict-prior lookup. Uses an isolated store file so
// runs never touch operator state.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  extractTop3,
  recordBriefing,
  previousTop3,
  _setHistoryFileForTests,
} from "../src/lib/briefing-memory.js";

const tmpFile = join(tmpdir(), `briefing-history-test-${process.pid}.json`);

beforeEach(() => {
  try { rmSync(tmpFile); } catch { /* fresh */ }
  _setHistoryFileForTests(tmpFile);
});
afterEach(() => {
  _setHistoryFileForTests(null);
  try { rmSync(tmpFile); } catch { /* ignore */ }
});

const ANSWER = `## Focus today
- Ship the login fix — users are locked out
1. Decide pricing with Sara
- Call the bank about the transfer

## Open loops
- Waiting on design review`;

describe("extractTop3", () => {
  it("pulls bullets and numbered items under Focus today", () => {
    expect(extractTop3(ANSWER)).toEqual([
      "Ship the login fix — users are locked out",
      "Decide pricing with Sara",
      "Call the bank about the transfer",
    ]);
  });

  it("stops at the next heading and returns [] without one", () => {
    expect(extractTop3(ANSWER)).not.toContain("Waiting on design review");
    expect(extractTop3("Just some prose, no headings.")).toEqual([]);
  });
});

describe("recordBriefing / previousTop3", () => {
  it("round-trips yesterday's Top 3", () => {
    recordBriefing("2026-10-05", ANSWER);
    expect(previousTop3("2026-10-06")).toEqual(extractTop3(ANSWER));
  });

  it("ignores same-day and future entries (strictly prior only)", () => {
    recordBriefing("2026-10-06", ANSWER);
    expect(previousTop3("2026-10-06")).toEqual([]);
  });

  it("same-date re-runs overwrite instead of stacking", () => {
    recordBriefing("2026-10-05", ANSWER);
    recordBriefing("2026-10-05", "## Focus today\n- Only this\n");
    expect(previousTop3("2026-10-06")).toEqual(["Only this"]);
  });

  it("empty store yields no follow-up", () => {
    expect(previousTop3("2026-10-06")).toEqual([]);
  });
});
