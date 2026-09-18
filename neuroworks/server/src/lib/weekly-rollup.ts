// Weekly Rollup — Sundays: combine todos + reflections + innovation scans.
// Vault: _neuroworks/weekly-rollups/YYYY-MM-DD.md — Telegram + email optional.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeVaultFile } from "./vault.js";

const ROLLUP_DIR = "_neuroworks/weekly-rollups";
const __dirname = dirname(fileURLToPath(import.meta.url));

function localYmd(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function fmtNice(ymd: string): string { return new Date(ymd+"T12:00:00").toLocaleDateString("en-US",{weekday:"long", month:"long", day:"numeric", year:"numeric"}); }
function weekRange(): { start: string; end: string; label: string } {
  const now = new Date();
  const day = now.getDay(); // 0 Sun
  const monday = new Date(now); monday.setDate(now.getDate() - ((day+6)%7));
  const sunday = new Date(monday); sunday.setDate(monday.getDate()+6);
  const s = localYmd(monday), e = localYmd(sunday);
  const label = `${new Date(s+"T12:00:00").toLocaleDateString("en-US",{month:"short", day:"numeric"})} – ${new Date(e+"T12:00:00").toLocaleDateString("en-US",{month:"short", day:"numeric", year:"numeric"})}`;
  return { start:s, end:e, label };
}

function collectTodoWeek(start: string, end: string): { open: number; completed: number; overdue: number; } {
  try {
    const p = resolve(__dirname, "../../../.neuroworks/my-tasks.json");
    if (!existsSync(p)) return { open:0, completed:0, overdue:0 };
    const parsed = JSON.parse(readFileSync(p,"utf8"));
    const items: any[] = parsed.items ?? [];
    const open = items.filter((x:any)=>!x.completed).length;
    const completed = items.filter((x:any)=> x.completed && x.completedAt && x.completedAt.slice(0,10) >= start && x.completedAt.slice(0,10) <= end).length;
    const today = localYmd(new Date());
    const overdue = items.filter((x:any)=> !x.completed && x.dueDate && x.dueDate < today).length;
    return { open, completed, overdue };
  } catch { return { open:0, completed:0, overdue:0 }; }
}

function collectReflections(start: string, end: string, vaultPath: string): string[] {
  try {
    const dir = join(vaultPath, "_neuroworks/reflections");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f=>f.endsWith(".md") && f.slice(0,10)>=start && f.slice(0,10)<=end).sort();
  } catch { return []; }
}
function collectScans(start: string, end: string, vaultPath: string): string[] {
  try {
    const dir = join(vaultPath, "_neuroworks/innovation-scans");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f=>f.endsWith(".md") && f.slice(0,10)>=start && f.slice(0,10)<=end).sort();
  } catch { return []; }
}

export type WeeklyRollupResult = { date:string; path:string; markdown:string; generatedAt:string };

let lastResult: WeeklyRollupResult|null=null;
let inFlight: Promise<WeeklyRollupResult>|null=null;

export function lastWeeklyRollup(): WeeklyRollupResult|null { return lastResult; }

// Bundles the last result with a computed next-fire time (same env vars/defaults
// as the scheduler below) so the Daily Rhythm view can show this daemon
// alongside user Schedules without duplicating the scheduler itself.
export async function weeklyRollupStatus(): Promise<{ last: WeeklyRollupResult | null; nextFireAt: number | null }> {
  const { nextFireAt } = await import("./schedules.js");
  const HOUR = Number(process.env.NEUROWORKS_WEEKLY_ROLLUP_HOUR ?? "9");
  const DOW = Number(process.env.NEUROWORKS_WEEKLY_ROLLUP_DOW ?? "0");
  return { last: lastWeeklyRollup(), nextFireAt: nextFireAt({ daysOfWeek: [DOW], hour: HOUR, minute: 0 }) };
}

export async function runWeeklyRollup(): Promise<WeeklyRollupResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const { start, end, label } = weekRange();
    const today = localYmd(new Date());
    const todo = collectTodoWeek(start, end);
    let vaultPath = "";
    try { const { config } = await import("../config.js"); vaultPath = config.vaultPath; } catch {}
    const refs = collectReflections(start, end, vaultPath);
    const scans = collectScans(start, end, vaultPath);
    let weatherBlock = "";
    try { const { getWeather } = await import("./host-tools.js"); weatherBlock = await getWeather("auto"); } catch {}

    const header = `---
type: weekly-rollup
week: ${start} → ${end}
generated: ${new Date().toISOString()}
---

# 🗓️ Weekly Rollup — ${label}

> _Naxie's Sunday digest · ${fmtNice(today)}_

${weatherBlock ? weatherBlock+"\n" : ""}
## ✅ Todos — Week ${start} → ${end}

| Metric | Count |
|---|---|
| ✅ Completed this week | **${todo.completed}** |
| 📋 Still open | **${todo.open}** |
| ⚠️ Overdue | **${todo.overdue}** |

${todo.completed===0 && todo.open===0 ? "_No todo activity recorded this week._" : `_${todo.completed} completed, ${todo.open} still open — overdue ${todo.overdue}_`}

## 🌙 Reflections — ${refs.length} ${refs.length===1?"entry":"entries"}

${refs.length ? refs.map(f=>`- \`${f}\``).join("\n") : "_No reflections this week._"}

## 🔭 Innovation Scans — ${scans.length} ${scans.length===1?"scan":"scans"}

${scans.length ? scans.map(f=>`- \`${f}\``).join("\n") : "_No scans this week._"}

## 🔮 Next week — focus

- Pick your **Top 3** for Monday from the backlog
- Clear overdue first, then plan the week

---

> 📊 _Vault: sum of reflections/scans + todo counts. Open the files above for detail._
`;
    const footer = `\n<details><summary>Raw</summary>\n\n\`\`\`json\n${JSON.stringify({week:{start,end}, todo, refs, scans}, null, 2)}\n\`\`\`\n\n</details>\n`;
    const markdown = header + footer;
    const path = `${ROLLUP_DIR}/${today}.md`;
    try { writeVaultFile(path, markdown); const { enqueueVaultCommit } = await import("./commit-queue.js"); void enqueueVaultCommit(`chore(weekly-rollup): ${today}`); } catch {}
    const generatedAt = new Date().toISOString();
    const result: WeeklyRollupResult = { date: today, path, markdown, generatedAt };
    lastResult = result;
    try { const { newJob } = await import("./jobs.js"); const { persistJobRecord } = await import("./job-store.js"); const j = newJob("weekly-rollup"); j.title=`🗓️ Weekly Rollup — ${label} (${todo.completed} done, ${todo.open} open)`; j.status="succeeded"; j.startedAt=generatedAt; j.finishedAt=generatedAt; j.result={answer:markdown, briefPath:path}; try{persistJobRecord(j)}catch{} } catch {}
    void (async () => {
      try { const { sendTelegramMessage, stripVaultFrontmatterForTelegram } = await import("./telegram-bridge.js"); const text = `🗓️ *Weekly Rollup — ${label}*\n✅ ${todo.completed} done · 📋 ${todo.open} open · ⚠️ ${todo.overdue} overdue\n🔭 ${scans.length} scans · 🌙 ${refs.length} reflections\n\n${stripVaultFrontmatterForTelegram(markdown).slice(0,3200)}\n\n— _Full: ${path}_`; const r=await sendTelegramMessage(text); if(!r.ok) console.warn(`[weekly-rollup] telegram skip: ${r.error}`);} catch {}
      try { const { sendEmail, emailConfigured } = await import("./email.js"); const { config } = await import("../config.js"); if (emailConfigured()) { const to = (config as any).operatorEmail ?? ""; if (to) await sendEmail({to, subject:`Weekly Rollup — ${label}`, body: markdown}); } } catch {}
    })();
    return result;
  })();
  try { return await inFlight; } finally { inFlight=null; }
}

let scheduler: NodeJS.Timeout|null=null;
let lastRunWeek: string|null=null;
export function startWeeklyRollupScheduler(): void {
  if (scheduler) return;
  const HOUR = Number(process.env.NEUROWORKS_WEEKLY_ROLLUP_HOUR ?? "9");
  const DOW = Number(process.env.NEUROWORKS_WEEKLY_ROLLUP_DOW ?? "0"); // 0 Sun
  const tick = async () => {
    const now = new Date();
    if (now.getDay() !== DOW || now.getHours() < HOUR) return;
    const weekLabel = `${now.getFullYear()}-W${String(Math.ceil((now.getDate()+(new Date(now.getFullYear(), now.getMonth(),1).getDay()))/7)).padStart(2,"0")}`;
    if (lastRunWeek === weekLabel) return;
    try {
      const { config } = await import("../config.js");
      const dir = join(config.vaultPath, ROLLUP_DIR);
      if (existsSync(dir)) {
        const today = localYmd(now);
        const existsToday = readdirSync(dir).some(f=>f.startsWith(today));
        if (existsToday) { lastRunWeek=weekLabel; return; }
      }
    } catch {}
    lastRunWeek = weekLabel;
    console.log(`[weekly-rollup] firing (dow=${DOW} hour>=${HOUR})`);
    try { await runWeeklyRollup(); } catch(e:any){ console.warn(`[weekly-rollup] failed: ${e?.message ?? e}`); }
  };
  scheduler = setInterval(tick, 10*60_000);
  void tick();
}
export function stopWeeklyRollupScheduler(): void { if(scheduler){ clearInterval(scheduler); scheduler=null; } }
