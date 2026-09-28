// Calendar export (see lib/calendar-export.ts, ported from
// KimmyDeku/sebastian's calendar.ts): a Google Calendar deep link and an
// .ics builder. Both are pure/dependency-free, so this rounds-trips buildIcs
// output through Naxie's own iCal reader (lib/calendar-ical.ts) rather than
// asserting on exact string bytes.

import { describe, expect, it } from "vitest";
import { googleCalendarUrl, buildIcs, type ExportableEvent } from "../src/lib/calendar-export.js";
import { parseIcal } from "../src/lib/calendar-ical.js";

const timed: ExportableEvent = {
  id: "e1", title: "Weekly Reflect review", start: "2026-01-05T14:00:00.000Z", end: "2026-01-05T14:30:00.000Z",
  location: "Vault", description: "Review this week's proposals",
};
const allDay: ExportableEvent = { id: "e2", title: "Q1 planning", start: "2026-01-06T00:00:00.000Z", allDay: true };

describe("googleCalendarUrl", () => {
  it("produces a well-formed template link for a timed event", () => {
    const url = new URL(googleCalendarUrl(timed));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Weekly Reflect review");
    expect(url.searchParams.get("dates")).toBe("20260105T140000Z/20260105T143000Z");
    expect(url.searchParams.get("location")).toBe("Vault");
  });

  it("uses date-only (no time) dates for an all-day event", () => {
    const url = new URL(googleCalendarUrl(allDay));
    expect(url.searchParams.get("dates")).toBe("20260106/20260106");
  });

  it("defaults a timed event's end to start + 1h when no end is given", () => {
    const url = new URL(googleCalendarUrl({ id: "e3", title: "Standup", start: "2026-01-05T09:00:00.000Z" }));
    expect(url.searchParams.get("dates")).toBe("20260105T090000Z/20260105T100000Z");
  });
});

describe("buildIcs", () => {
  it("round-trips through Naxie's own iCal reader", () => {
    const ics = buildIcs([timed, allDay]);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    const parsed = parseIcal(ics);
    expect(parsed).toHaveLength(2);
    expect(parsed.find(e => e.summary === "Weekly Reflect review")).toMatchObject({
      location: "Vault", description: "Review this week's proposals",
    });
    expect(parsed.find(e => e.summary === "Q1 planning")).toBeDefined();
  });

  it("includes a VALARM block when remindMinutes is set", () => {
    const ics = buildIcs([{ ...timed, remindMinutes: 15 }]);
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics).toContain("TRIGGER:-PT15M");
  });

  it("produces an empty-but-valid calendar for no events", () => {
    const ics = buildIcs([]);
    expect(parseIcal(ics)).toHaveLength(0);
    expect(ics).toContain("BEGIN:VCALENDAR");
  });
});
