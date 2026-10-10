// Briefing memory — yesterday's Top 3 follows the operator into today.
//
// Each finished briefing's "Focus today" bullets are stored in
// .naxion/briefing-history.json (14-day cap). The next morning's run loads
// the most recent prior Top 3 as evidence and the synthesiser judges each
// item kept / carried / dropped against the activity evidence — unkept
// promises resurface instead of silently dying overnight.
// Pure extraction + tiny JSON store; the runner wraps every call so memory
// can never fail a briefing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(resolve(__dirname, "../../../.naxion"), "briefing-history.json");
const KEEP_DAYS = 14;

// Override the store path in tests so runs never touch operator state.
let fileOverride: string | null = null;
export function _setHistoryFileForTests(path: string | null): void {
  fileOverride = path;
}
const FILE = () => fileOverride ?? DEFAULT_FILE;

export type BriefingRecord = { date: string; top3: string[] };

// Pull the Focus-today bullets out of a finished briefing. Tolerates numbered
// ("1. …"), bulleted ("- …"/"* …") and bare lines under the heading; stops at
// the next ## heading. Returns at most 6 cleaned items.
export function extractTop3(answer: string): string[] {
  const lines = String(answer ?? "").split("\n");
  const start = lines.findIndex((l) => /^##\s*focus today/i.test(l.trim()));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+\S/.test(line.trim())) break;
    const cleaned = line
      .trim()
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/[*_`~]+/g, "")
      .trim();
    if (cleaned) items.push(cleaned);
    if (items.length >= 6) break;
  }
  return items;
}

function load(): BriefingRecord[] {
  try {
    const file = FILE();
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.date === "string" && Array.isArray(r.top3)) : [];
  } catch {
    return [];
  }
}

function persist(records: BriefingRecord[]): void {
  try {
    const file = FILE();
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(records.slice(-KEEP_DAYS), null, 2));
  } catch {
    /* memory is best-effort */
  }
}

// Most recent Top 3 strictly before `ymd` (YYYY-MM-DD). Empty when no prior
// briefing was recorded — first run degrades to no follow-up section.
export function previousTop3(ymd: string): string[] {
  const prior = load()
    .filter((r) => r.date < ymd && r.top3.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return prior.length ? prior[prior.length - 1].top3 : [];
}

// Record today's finished briefing. Same-date re-runs overwrite rather than
// stacking duplicates.
export function recordBriefing(ymd: string, answer: string): void {
  const top3 = extractTop3(answer);
  if (!top3.length) return;
  const records = load().filter((r) => r.date !== ymd);
  records.push({ date: ymd, top3 });
  records.sort((a, b) => a.date.localeCompare(b.date));
  persist(records);
}
