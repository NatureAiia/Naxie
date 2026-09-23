import type { Cadence } from "./api";

// Shared by Schedules.tsx and CalendarPage.tsx so a cadence/next-fire time
// reads the same way in both places.
export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatNext(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const now = Date.now();
  const diff = d.getTime() - now;
  if (diff < 0) return "due now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `in ${days}d`;
  return d.toLocaleString();
}

export function formatCadence(c: Cadence): string {
  const t = `${c.hour.toString().padStart(2, "0")}:${c.minute.toString().padStart(2, "0")}`;
  if (c.once) {
    return `${new Date(c.once + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} at ${t} (one-off)`;
  }
  if (c.daysOfWeek.length === 0 || c.daysOfWeek.length === 7) return `Every day at ${t}`;
  const weekdays = [1, 2, 3, 4, 5];
  if (c.daysOfWeek.length === 5 && weekdays.every(d => c.daysOfWeek.includes(d))) return `Weekdays at ${t}`;
  const sorted = c.daysOfWeek.slice().sort((a, b) => a - b);
  return `${sorted.map(d => DAY_LABELS[d]).join(", ")} at ${t}`;
}
