import { Router } from "express";
import { getCostSummary, getCostRecords } from "../lib/cost-tracker.js";
import { addHumanWork, listHumanWork, parseTimesheetCsv, summarizeHumanWork, hourlyRate, WORK_HOURS_PER_MONTH } from "../lib/human-work.js";
import { listUsers, sweepEndedSessions } from "../lib/users.js";

export const costRouter = Router();

costRouter.get("/summary", (_req, res) => {
  res.json(getCostSummary());
});

costRouter.get("/records", (req, res) => {
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  res.json({ records: getCostRecords(since) });
});

// Prompt-cache effectiveness — how much of the cloud input token spend is being
// served from a cached prefix (per profile + per model). The headline number is
// overall.cacheHitRatio; a healthy stable-prefix setup drives it up over a run
// as prefixes repeat. Cloud providers only.
costRouter.get("/cache-stats", async (_req, res) => {
  const { cacheStatsSnapshot } = await import("../lib/prompt-cache-stats.js");
  res.json(cacheStatsSnapshot());
});

// ── Human side of the books ───────────────────────────────────────────────

// Ingest human work: JSON rows ({rows:[{email,date,hours,description?}]}),
// a raw timesheet CSV ({csv:"email,date,hours\n..."}), or both. `source`
// defaults to "manual"; connectors POST with source:"connector".
costRouter.post("/human-work", (req, res) => {
  const b = req.body ?? {};
  const source = ["upload", "connector", "manual"].includes(b.source) ? b.source : "manual";
  const rows: any[] = Array.isArray(b.rows) ? [...b.rows] : [];
  if (typeof b.csv === "string" && b.csv.trim()) {
    const parsed = parseTimesheetCsv(b.csv);
    if (parsed.length === 0) return res.status(400).json({ error: "couldn't parse the CSV — need a header row with email, date, and hours columns" });
    rows.push(...parsed);
  }
  if (rows.length === 0) return res.status(400).json({ error: "provide rows[] or csv" });
  const result = addHumanWork(rows, source);
  res.json(result);
});

costRouter.get("/human-work", (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days ?? 30)));
  res.json({ entries: listHumanWork(days).slice(0, 500) });
});

// The workforce ledger — agent spend and human spend side by side, priced
// from the same window. Human cost = logged hours × (salaryMonthly ÷ standard
// month hours) per user; users with hours but no salary are listed unpriced
// so the gap is visible instead of silently under-counting.
// Salaries are held in ZAR (Zimbabwe/South-African rand); the LLM spend is in
// USD. To show human cost next to neuro cost in ONE currency ($), convert with
// this rate (rand per US dollar). Override via env as the rate moves; default
// is a reasonable mid-2026 figure.
const ZAR_PER_USD_FALLBACK = (() => {
  const n = Number(process.env.NEUROWORKS_ZAR_PER_USD);
  return Number.isFinite(n) && n > 0 ? n : 18.5;
})();

// Live FX from the seeded keyless Frankfurter connector (ECB rates) so the ZAR→USD
// conversion tracks the real rate instead of a stale env constant. Cached 6h; on
// any failure we keep the last good rate (or the env/default fallback). zarToUsd
// stays synchronous by reading this mutable cache — routes await ensureFxRate()
// first so the value is fresh before they price anything.
let liveZarPerUsd = ZAR_PER_USD_FALLBACK;
let fxSource: "live" | "config" = "config";
let fxFetchedAt = 0;
const FX_TTL_MS = 6 * 3600 * 1000;

async function ensureFxRate(): Promise<void> {
  if (Date.now() - fxFetchedAt < FX_TTL_MS) return;
  fxFetchedAt = Date.now(); // set first so a hanging/failing fetch doesn't hammer the API
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=ZAR", { signal: ctrl.signal });
    clearTimeout(timer);
    const j: any = await r.json();
    const rate = Number(j?.rates?.ZAR);
    if (Number.isFinite(rate) && rate > 0) { liveZarPerUsd = rate; fxSource = "live"; }
  } catch { /* keep last good / fallback rate */ }
}

const zarToUsd = (zar: number) => Math.round((zar / liveZarPerUsd) * 100) / 100;

costRouter.get("/workforce", async (req, res) => {
  await ensureFxRate();
  const days = Math.max(1, Math.min(365, Number(req.query.days ?? 30)));
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  const agentRecords = getCostRecords(sinceIso);
  const agentCostUsd = agentRecords.reduce((s, r) => s + r.costUsd, 0);
  const agentCalls = agentRecords.length;

  try { sweepEndedSessions(); } catch { /* best-effort */ }
  const human = summarizeHumanWork(days);
  const users = listUsers();
  const byEmail = new Map(users.map(u => [u.email.toLowerCase(), u]));
  let humanCostZar = 0;
  let unpricedHours = 0;
  // Department rollup — same salary-derived numbers as perUser, grouped on the
  // user's department (mirrors orgOverview().byDepartment). Users with hours but
  // no department land in "Unassigned"; unpriced hours still count toward the
  // department's hours so the gap is visible.
  const deptMap = new Map<string, { hours: number; costZar: number; priced: boolean }>();
  const perUser = human.byUser.map(u => {
    const user = byEmail.get(u.email);
    const rate = hourlyRate((user as any)?.salaryMonthly);
    const costZar = rate !== undefined ? u.hours * rate : undefined;
    if (costZar !== undefined) humanCostZar += costZar;
    else unpricedHours += u.hours;
    const dept = (user as any)?.department?.trim() || "Unassigned";
    const d = deptMap.get(dept) ?? { hours: 0, costZar: 0, priced: false };
    d.hours += u.hours;
    if (costZar !== undefined) { d.costZar += costZar; d.priced = true; }
    deptMap.set(dept, d);
    return {
      email: u.email,
      name: user?.name,
      workMode: (user as any)?.workMode,
      department: (user as any)?.department,
      hours: u.hours,
      entries: u.entries,
      hourlyRateZar: rate !== undefined ? Math.round(rate * 100) / 100 : undefined,
      costZar: costZar !== undefined ? Math.round(costZar * 100) / 100 : undefined,
      costUsd: costZar !== undefined ? zarToUsd(costZar) : undefined,
      salarySet: rate !== undefined,
    };
  });
  const byDepartment = [...deptMap.entries()]
    .map(([department, v]) => ({
      department,
      hours: Math.round(v.hours * 100) / 100,
      costZar: v.priced ? Math.round(v.costZar * 100) / 100 : undefined,
      costUsd: v.priced ? zarToUsd(v.costZar) : undefined,
    }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.hours - a.hours);

  res.json({
    days,
    agent: { costUsd: Math.round(agentCostUsd * 10000) / 10000, calls: agentCalls },
    human: {
      totalHours: human.totalHours,
      costZar: Math.round(humanCostZar * 100) / 100,
      // Same figure in USD so the dashboard can show human spend side by side
      // with neuro spend in one currency. zarPerUsd is echoed so the UI can
      // label the assumption.
      costUsd: zarToUsd(humanCostZar),
      zarPerUsd: Math.round(liveZarPerUsd * 10000) / 10000,
      zarPerUsdSource: fxSource,
      unpricedHours: Math.round(unpricedHours * 100) / 100,
      workHoursPerMonth: Math.round(WORK_HOURS_PER_MONTH * 100) / 100,
      byUser: perUser,
      byDepartment,
      byDay: human.byDay,
    },
  });
});

// Neuro-vs-human spend, bucketed by day, both in USD — powers the Cost page's
// daily trend. Agent side: sum each LLM cost record into its calendar day.
// Human side: price each logged work entry by that user's salary-derived rate
// (ZAR→USD), summed per day — computed from raw entries (not the aggregate
// byDay hours) so per-user rates apply correctly.
costRouter.get("/trend", async (req, res) => {
  await ensureFxRate();
  const days = Math.max(1, Math.min(365, Number(req.query.days ?? 14)));
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const dayOf = (iso: string) => new Date(iso).toISOString().slice(0, 10);

  const neuroByDay = new Map<string, number>();
  for (const r of getCostRecords(sinceIso)) {
    const k = dayOf(r.ts);
    neuroByDay.set(k, (neuroByDay.get(k) ?? 0) + r.costUsd);
  }

  const users = listUsers();
  const byEmail = new Map(users.map(u => [u.email.toLowerCase(), u]));
  const humanByDay = new Map<string, number>();
  for (const e of listHumanWork(days)) {
    const rate = hourlyRate((byEmail.get(e.userEmail.toLowerCase()) as any)?.salaryMonthly);
    if (rate === undefined) continue; // unpriced — excluded from the $ trend
    humanByDay.set(e.date, (humanByDay.get(e.date) ?? 0) + e.hours * rate);
  }

  const allDays = new Set<string>([...neuroByDay.keys(), ...humanByDay.keys()]);
  const series = [...allDays].sort().map(date => ({
    date,
    neuroUsd: Math.round((neuroByDay.get(date) ?? 0) * 10000) / 10000,
    humanUsd: zarToUsd(humanByDay.get(date) ?? 0),
  }));
  res.json({ days, zarPerUsd: Math.round(liveZarPerUsd * 10000) / 10000, zarPerUsdSource: fxSource, series });
});
