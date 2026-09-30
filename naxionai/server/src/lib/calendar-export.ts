// Calendar export — "add to calendar" without an OAuth integration. Ported
// near-verbatim from KimmyDeku/sebastian's src/lib/calendar.ts: two pure,
// dependency-free helpers. Naxie could previously only READ an iCal feed
// (lib/calendar-ical.ts); nothing wrote one out, and there was no Google
// Calendar link generator anywhere in the codebase.
//
// Both helpers open pre-filled — the operator confirms the actual save in
// Google, or imports the .ics file into their own calendar app. No calendar
// write-scope OAuth client, no server-side calendar account.

export type ExportableEvent = {
  id: string;
  title: string;
  start: string;        // ISO timestamp
  end?: string;          // ISO timestamp; defaults to start + 1h if absent
  allDay?: boolean;
  location?: string;
  description?: string;
  remindMinutes?: number;
};

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function eventEnd(e: ExportableEvent): Date {
  if (e.end) return new Date(e.end);
  const start = new Date(e.start);
  return e.allDay ? start : new Date(start.getTime() + 3600_000);
}

export function googleCalendarUrl(e: ExportableEvent): string {
  const start = new Date(e.start);
  const end = eventEnd(e);
  const dates = e.allDay
    ? `${stamp(start).slice(0, 8)}/${stamp(end).slice(0, 8)}`
    : `${stamp(start)}/${stamp(end)}`;
  const details = [e.description, e.location ? `Location: ${e.location}` : undefined].filter(Boolean).join("\n\n");
  const params = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates });
  if (details) params.set("details", details);
  if (e.location) params.set("location", e.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Builds a single VCALENDAR document containing every given event. Callers
// stream this as text/calendar; there is no filesystem write here.
export function buildIcs(events: ExportableEvent[]): string {
  const lines: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Naxie//Calendar Export//EN", "CALSCALE:GREGORIAN"];
  for (const e of events) {
    const start = new Date(e.start);
    const end = eventEnd(e);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@naxie`,
      `DTSTAMP:${stamp(new Date())}`,
      e.allDay ? `DTSTART;VALUE=DATE:${stamp(start).slice(0, 8)}` : `DTSTART:${stamp(start)}`,
      e.allDay ? `DTEND;VALUE=DATE:${stamp(end).slice(0, 8)}` : `DTEND:${stamp(end)}`,
      `SUMMARY:${e.title.replace(/\r?\n/g, "\\n")}`,
    );
    if (e.location) lines.push(`LOCATION:${e.location.replace(/\r?\n/g, "\\n")}`);
    if (e.description) lines.push(`DESCRIPTION:${e.description.replace(/\r?\n/g, "\\n")}`);
    if (e.remindMinutes != null) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${e.title.replace(/\r?\n/g, "\\n")}`,
        `TRIGGER:-PT${e.remindMinutes}M`,
        "END:VALARM",
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
