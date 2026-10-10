// Pure formatters for the daily-briefing evidence blocks.
//
// The runner (routes/templates.ts dailyBriefingRunner) gathers raw data
// (calendar.plan_day, email triage store, awaiting jobs/tasks) and these
// functions turn it into the markdown context blocks the synthesiser reads.
// Pure — no disk, no network — so the briefing's evidence contract is
// unit-tested without firing a run.

export type DayShape = {
  meetings?: any[];
  meetingsError?: string;
  schedules?: any[];
  commitments?: any[];
  carryover?: any[];
};

export function formatDayShape(day: DayShape | null | undefined, date: string): string {
  const meetings = day?.meetings ?? [];
  const mtgLines = meetings
    .slice(0, 10)
    .map((m: any) => `  - ${String(m.start ?? "").slice(11, 16) || "??:??"} ${m.summary ?? "(untitled)"}${m.location ? ` @ ${m.location}` : ""}`);
  const shape: string[] = [
    meetings.length
      ? `Meetings (${meetings.length}):\n${mtgLines.join("\n")}`
      : "Meetings: none on the calendar.",
  ];
  if (day?.meetingsError) shape.push(`Calendar note: ${String(day.meetingsError).slice(0, 200)}`);
  const scheds = day?.schedules ?? [];
  if (scheds.length) {
    shape.push(`Naxie runs today: ${scheds.map((s: any) => String(s.name ?? s.label ?? s.templateId ?? s.id)).join(", ")}`);
  }
  const comms = day?.commitments ?? [];
  if (comms.length) {
    shape.push(`Dated commitments: ${comms.slice(0, 6).map((c: any) => `${c.fact} (${c.subject})`).join(" | ")}`);
  }
  const carry = day?.carryover ?? [];
  if (carry.length) {
    shape.push(`Carryover (failed/awaiting): ${carry.slice(0, 6).map((c: any) => `${c.title} [${c.status}]`).join(" | ")}`);
  }
  return `### Today's shape — ${date}\n${shape.join("\n")}`;
}

export function formatInboxTriage(
  store: Record<string, any> | null | undefined,
  max = 8,
): { count: number; block: string | null } {
  const pending = Object.values(store ?? {}).filter(
    (e: any) => e && (e.status === "pending" || e.status === "awaiting_edit"),
  );
  if (!pending.length) return { count: 0, block: null };
  const lines = pending.slice(0, max).map(
    (e: any) => `  - **${e.sender ?? "?"} / ${e.subject ?? "(no subject)"}** — ${String(e.body ?? "").split("\n")[0].slice(0, 140)}`,
  );
  return { count: pending.length, block: `### Inbox triage (${pending.length} waiting)\n${lines.join("\n")}` };
}

export function formatWaiting(jobs: any[], tasks: any[]): string | null {
  const lines = [
    ...(jobs ?? []).map((j: any) => `job: ${j.title ?? j.kind ?? j.id}`),
    ...(tasks ?? []).map((t: any) => `task: ${t.title ?? t.id}`),
  ];
  if (!lines.length) return null;
  return `### Waiting on you (${lines.length})\n${lines.map((l) => `  - ${l}`).join("\n")}`;
}
