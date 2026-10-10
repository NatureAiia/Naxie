// Evidence-block contract for the daily briefing (briefing-evidence.ts).
// The synthesiser only knows what these blocks tell it — a misformatted or
// leaky block becomes a wrong briefing, so the shapes are pinned here.
import { describe, expect, it } from "vitest";
import { formatDayShape, formatInboxTriage, formatWaiting } from "../src/lib/briefing-evidence.js";

describe("formatDayShape", () => {
  it("renders meetings with times and locations", () => {
    const out = formatDayShape(
      { meetings: [{ start: "2026-10-07T10:00:00", summary: "Standup", location: "Zoom" }] },
      "2026-10-07",
    );
    expect(out).toContain("### Today's shape — 2026-10-07");
    expect(out).toContain("Meetings (1):");
    expect(out).toContain("10:00 Standup @ Zoom");
  });

  it("says plainly when the calendar is empty", () => {
    expect(formatDayShape({ meetings: [] }, "2026-10-07")).toContain(
      "Meetings: none on the calendar.",
    );
  });

  it("includes runs, commitments and carryover when present", () => {
    const out = formatDayShape(
      {
        meetings: [],
        schedules: [{ name: "Morning briefing", templateId: "daily-briefing" }],
        commitments: [{ subject: "ops", fact: "Q3 board meeting today" }],
        carryover: [{ title: "Fix login bug", status: "failed" }],
      },
      "2026-10-07",
    );
    expect(out).toContain("Naxie runs today: Morning briefing");
    expect(out).toContain("Dated commitments: Q3 board meeting today (ops)");
    expect(out).toContain("Carryover (failed/awaiting): Fix login bug [failed]");
  });

  it("surfaces calendar errors instead of silence", () => {
    expect(formatDayShape({ meetingsError: "iCal fetch timed out" }, "2026-10-07")).toContain(
      "Calendar note: iCal fetch timed out",
    );
  });
});

describe("formatInboxTriage", () => {
  const store = {
    a: { sender: "sam@x.com", subject: "Invoice", body: "Please pay by Friday\nThanks", status: "pending" },
    b: { sender: "news@x.com", subject: "Newsletter", body: "Top stories", status: "snoozed" },
    c: { sender: "amy@x.com", subject: "Done", body: "All good", status: "resolved" },
    d: { sender: "bo@x.com", subject: "Draft", body: "Review me", status: "awaiting_edit" },
  };

  it("keeps pending + awaiting_edit, drops snoozed/resolved", () => {
    const { count, block } = formatInboxTriage(store);
    expect(count).toBe(2);
    expect(block).toContain("### Inbox triage (2 waiting)");
    expect(block).toContain("sam@x.com / Invoice");
    expect(block).toContain("bo@x.com / Draft");
    expect(block).not.toContain("Newsletter");
  });

  it("returns null block when triage is clear", () => {
    expect(formatInboxTriage({})).toEqual({ count: 0, block: null });
    expect(formatInboxTriage(null).block).toBeNull();
  });
});

describe("formatWaiting", () => {
  it("merges jobs and tasks with counts", () => {
    const out = formatWaiting(
      [{ title: "Send invoice", kind: "ops", id: "j1" }],
      [{ title: "Approve spend", id: "t1" }],
    );
    expect(out).toContain("### Waiting on you (2)");
    expect(out).toContain("job: Send invoice");
    expect(out).toContain("task: Approve spend");
  });

  it("returns null when nothing waits", () => {
    expect(formatWaiting([], [])).toBeNull();
  });
});
