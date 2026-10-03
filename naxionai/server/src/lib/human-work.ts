// Human-work ledger — the people half of the hybrid workforce's books.
//
// The system already knows everything about AGENT work (jobs journal, cost
// tracker). This store records HUMAN work signals so the monitor can compare
// the two sides: hours logged per person per day, ingested from
//   - timesheet CSV uploads (Workforce/Users page),
//   - company-system connectors (a sync endpoint POSTs rows),
//   - manual entries.
//
// Combined with the salary field on users (ZAR/month → rate/hour), this is
// what lets the Cost page price human work next to agent spend, and the
// time-waste analysis attribute hours to the human side.
//
// Persisted append-only at .naxion/human-work.jsonl (gitignored, same
// pattern as the jobs journal — durable, jq-able, no DB dependency).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.naxion");
const LEDGER_PATH = resolve(CONFIG_DIR, "human-work.jsonl");

export type HumanWorkSource = "upload" | "connector" | "manual" | "session";

export type HumanWorkEntry = {
  id: string;
  userEmail: string;        // matched against the Users directory (lowercase)
  date: string;             // YYYY-MM-DD the work happened
  hours: number;            // decimal hours, 0 < h <= 24
  description?: string;
  taskRef?: string;         // optional job id / ticket ref the hours attach to
  source: HumanWorkSource;
  ts: string;               // ingestion timestamp
};

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

// ─── automatic session-time tracking ───
// The most accurate human-hours signal we have without asking anyone to fill a
// timesheet: how long a person was actually signed in. A session is opened at
// login and torn down at logout / expiry / revoke; at teardown we book the
// elapsed wall-clock (login → last-activity) as a `session` ledger entry so the
// workload + cost cards reflect real presence, not just uploaded timesheets.
//
// Guards:
//  - blips under MIN_SESSION_MIN (a quick check-in) are noise — dropped.
//  - a single session is capped at MAX_SESSION_HOURS so a tab left open
//    overnight (lastSeen kept warm by dashboard polling) can't book 24h.
//  - each session is booked at most once (deduped by its token prefix), so the
//    logout path and a later expiry sweep can't double-count the same session.
const MIN_SESSION_MIN = 2;
const MAX_SESSION_HOURS = 16;

export function recordSessionWork(
  userEmail: string,
  startIso: string,
  endIso: string,
  sessionToken?: string,
): boolean {
  const email = String(userEmail ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return false;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  let hours = (end - start) / 3600_000;
  if (hours < MIN_SESSION_MIN / 60) return false;
  if (hours > MAX_SESSION_HOURS) hours = MAX_SESSION_HOURS;
  const ref = sessionToken ? `session:${String(sessionToken).slice(0, 12)}` : undefined;
  // Dedup: if this session was already booked (recent), don't book it again.
  if (ref && listHumanWork(3).some(e => e.taskRef === ref)) return false;
  ensureDir();
  const entry: HumanWorkEntry = {
    id: randomUUID(),
    userEmail: email,
    date: new Date(start).toISOString().slice(0, 10),
    hours: Math.round(hours * 100) / 100,
    description: "Signed-in session",
    taskRef: ref,
    source: "session",
    ts: new Date().toISOString(),
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(entry) + "\n", "utf8");
  return true;
}

export function listHumanWork(sinceDays = 30): HumanWorkEntry[] {
  if (!existsSync(LEDGER_PATH)) return [];
  const cutoff = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const out: HumanWorkEntry[] = [];
  try {
    for (const line of readFileSync(LEDGER_PATH, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as HumanWorkEntry;
        if (e.date >= cutoff) out.push(e);
      } catch { /* tolerate a torn line */ }
    }
  } catch { return []; }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export type HumanWorkSummary = {
  sinceDays: number;
  totalHours: number;
  entryCount: number;
  byUser: { email: string; hours: number; entries: number; lastDate?: string }[];
  byDay: { date: string; hours: number }[];
};

export function summarizeHumanWork(sinceDays = 30): HumanWorkSummary {
  const entries = listHumanWork(sinceDays);
  const byUserMap = new Map<string, { hours: number; entries: number; lastDate?: string }>();
  const byDayMap = new Map<string, number>();
  let totalHours = 0;
  for (const e of entries) {
    totalHours += e.hours;
    const u = byUserMap.get(e.userEmail) ?? { hours: 0, entries: 0 };
    u.hours += e.hours; u.entries += 1;
    if (!u.lastDate || e.date > u.lastDate) u.lastDate = e.date;
    byUserMap.set(e.userEmail, u);
    byDayMap.set(e.date, (byDayMap.get(e.date) ?? 0) + e.hours);
  }
  return {
    sinceDays,
    totalHours: Math.round(totalHours * 100) / 100,
    entryCount: entries.length,
    byUser: [...byUserMap.entries()].map(([email, v]) => ({ email, hours: Math.round(v.hours * 100) / 100, entries: v.entries, lastDate: v.lastDate })).sort((a, b) => b.hours - a.hours),
    byDay: [...byDayMap.entries()].map(([date, hours]) => ({ date, hours: Math.round(hours * 100) / 100 })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
