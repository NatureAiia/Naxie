// Todo Brief — morning to-do digest: today's tasks + remaining for the week.
// Mirrors reflection.ts / innovation-scan.ts scheduler shape: hourly tick with
// local-date + mtime catch-up guard, vault write + Telegram delivery.
// Fires at TODO_BRIEF_HOUR (default 6am local) — before the 8am innovation scan.

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeVaultFile } from "./vault.js";

const TODO_DIR = "_naxion/todo-briefs";
const __dirname = dirname(fileURLToPath(import.meta.url));

export type TodoBriefResult = {
  date: string;          // YYYY-MM-DD local date
  path: string;
  markdown: string;
  generatedAt: string;
  todayCount: number;
  overdueCount: number;
  weekCount: number;
  openCount: number;
  backlogCount: number;
  top3: { task: any; score: number; reason: string }[];
};

let lastResult: TodoBriefResult | null = null;
let inFlight: Promise<TodoBriefResult> | null = null;

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtNice(ymd: string): string {
  return new Date(ymd + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function dayOfWeekIdx(d: Date): number {
  return d.getDay(); // 0 Sun .. 6 Sat
}

function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + n);
  return localYmd(d);
}

export function lastTodoBrief(): TodoBriefResult | null {
  return lastResult;
}

// Bundles the last result with a computed next-fire time (same env var/default
// as the scheduler below) so the Daily Rhythm view can show this daemon
// alongside user Schedules without duplicating the scheduler itself.
export async function todoBriefStatus(): Promise<{ last: TodoBriefResult | null; nextFireAt: number | null }> {
  const { nextFireAt } = await import("./schedules.js");
  const TODO_HOUR = Number(process.env.NAXION_TODO_BRIEF_HOUR ?? "6");
  return { last: lastTodoBrief(), nextFireAt: nextFireAt({ daysOfWeek: [], hour: TODO_HOUR, minute: 0 }) };
}

// ─── AI Priority Scoring ───
// Rank = proximity + importance + overdue triage. Higher = do first.
// Overdue > Today/MyDay > This-week > Backlog > Distant future. Important = +15, overdue extra +5 if >3 days late.
function daysBetween(aYmd: string, bYmd: string): number {
  const a = new Date(aYmd + "T12:00:00").getTime();
  const b = new Date(bYmd + "T12:00:00").getTime();
  return Math.round((b - a) / 86400000);
}
function scoreTask(it: any, today: string): number {
  let s = 0;
  if (it.dueDate && it.dueDate < today) {
    const late = Math.abs(daysBetween(it.dueDate, today));
    s = 100 + Math.min(10, late * 2); // more late = slightly higher
  } else if (it.dueDate === today || it.myDay === today) {
    s = 90;
  } else if (it.dueDate) {
    const d = daysBetween(today, it.dueDate);
    if (d >= 1 && d <= 6) s = 75 - d * 2; // 73..63 this week
    else if (d > 6) s = 35 - Math.min(10, Math.floor(d / 7)); // future
    else s = 40;
  } else {
    s = 30; // undated backlog
  }
  if (it.important) s += 15;
  if (Array.isArray(it.steps) && it.steps.length) {
    const done = it.steps.filter((x: any) => x.done).length;
    const progress = done / it.steps.length;
    s += progress * 3; // slight boost for already-started
  }
  return s;
}
export function topPriorityTasks(allOpen: any[], today: string, n = 3): { task: any; score: number; reason: string }[] {
  const scored = allOpen.map((t) => {
    const sc = scoreTask(t, today);
    let reason = t.dueDate && t.dueDate < today ? `Overdue ${daysBetween(t.dueDate, today)}d`
      : t.dueDate === today || t.myDay === today ? "Due today"
      : t.dueDate ? `Due ${t.dueDate}` : "No date";
    if (t.important) reason += " · ⭐ Important";
    return { task: t, score: sc, reason };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}

// Build the markdown for today's + week's todos. Uses my-tasks store directly
// (all owners aggregated — single-operator "local" plus any real emails) so
// the brief is never empty due to ownerEmail mismatch. Falls back to []
// when the store is unreadable.
// IMPORTANT: every incomplete task must appear SOMEWHERE — undated items go to `backlog`.
function gatherTodos(): { today: any[]; overdue: any[]; week: Map<string, any[]>; backlog: any[]; openCount: number; top3: { task: any; score: number; reason: string }[]; allLists: any[] } {
  const now = new Date();
  const today = localYmd(now);
  // Rest of week: tomorrow -> Sunday (local week ends Sunday). If today is Sunday, "rest" is empty.
  const dow = dayOfWeekIdx(now);
  const daysUntilSunday = (7 - dow) % 7; // 0 on Sunday, 1 on Sat, etc
  const weekDays: string[] = [];
  for (let i = 1; i <= daysUntilSunday; i++) weekDays.push(addDays(today, i));

  let lists: any[] = [];
  let items: any[] = [];
  try {
    const storePath = resolve(__dirname, "../../../.naxion/my-tasks.json");
    if (existsSync(storePath)) {
      const parsed = JSON.parse(readFileSync(storePath, "utf8"));
      lists = Array.isArray(parsed?.lists) ? parsed.lists : [];
      items = Array.isArray(parsed?.items) ? parsed.items : [];
    }
  } catch { /* empty */ }

  // Only open (incomplete) tasks — every unfinished task must be surfaced somewhere.
  const open = items.filter((it: any) => !it.completed);

  const todayItems = open.filter((it: any) => it.dueDate === today || it.myDay === today);
  const overdue = open.filter((it: any) => it.dueDate && it.dueDate < today).sort((a: any, b: any) => String(a.dueDate).localeCompare(String(b.dueDate)));
  const weekMap = new Map<string, any[]>();
  for (const d of weekDays) weekMap.set(d, []);
  for (const it of open) {
    if (!it.dueDate) continue;
    if (weekMap.has(it.dueDate)) weekMap.get(it.dueDate)!.push(it);
  }

  // Backlog: open tasks with NO due date (and not already in Today via My Day). These are
  // the items that were silently dropped before — "all incomplete must be mentioned".
  const todayIds = new Set(todayItems.map((t: any) => t.id));
  const overdueIds = new Set(overdue.map((t: any) => t.id));
  const weekIds = new Set([...weekMap.values()].flat().map((t: any) => t.id));
  const backlog = open.filter((it: any) => !it.dueDate && !todayIds.has(it.id)).filter((it: any) => !it.myDay || it.myDay !== today);
  // Also include tasks with dueDate but outside this week and not overdue/today/this-week -> they are future beyond week, also show as other open
  const accountedIds = new Set([...todayIds, ...overdueIds, ...weekIds, ...backlog.map((t: any) => t.id)]);
  const otherFuture: any[] = open.filter((it: any) => it.dueDate && !accountedIds.has(it.id));
  const allBacklog = [...backlog, ...otherFuture];

  // Sort today/week/backlog items: important first, then by list/order.
  const sortFn = (a: any, b: any) => {
    if (a.important !== b.important) return a.important ? -1 : 1;
    return (a.order ?? 0) - (b.order ?? 0);
  };
  todayItems.sort(sortFn);
  overdue.sort(sortFn);
  for (const arr of weekMap.values()) arr.sort(sortFn);
  allBacklog.sort(sortFn);

  const top3 = topPriorityTasks(open, today, 3);

  return { today: todayItems, overdue, week: weekMap, backlog: allBacklog, openCount: open.length, top3, allLists: lists };
}

function listNameFor(item: any, lists: any[]): string {
  const l = lists.find((x: any) => x.id === item.listId);
  return l?.name ?? "Tasks";
}

function renderTaskLine(it: any, lists: any[]): string {
  const imp = it.important ? " ⭐" : "";
  const due = it.dueDate ? ` 📅 ${it.dueDate}` : "";
  const steps = Array.isArray(it.steps) && it.steps.length ? ` · ${it.steps.filter((s: any) => s.done).length}/${it.steps.length} steps` : "";
  const list = ` \`${listNameFor(it, lists)}\``;
  // Title + small meta. Keep one line per task so Telegram stays scannable.
  const title = String(it.title ?? "Untitled").replace(/\n/g, " ").slice(0, 120);
  return `- ${it.completed ? "✅" : "☐"} **${title}**${imp}${due}${steps}${list}`;
}

export function renderTodoMarkdown(opts: { date: string; today: any[]; overdue: any[]; week: Map<string, any[]>; backlog: any[]; openCount: number; top3: { task: any; score: number; reason: string }[]; lists: any[] }): string {
  const niceDate = fmtNice(opts.date);
  const dow = new Date(opts.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long" });
  const header = `---
type: todo-brief
date: ${opts.date}
todayCount: ${opts.today.length}
overdueCount: ${opts.overdue.length}
backlogCount: ${opts.backlog.length}
openCount: ${opts.openCount}
generated: ${new Date().toISOString()}
---

# ☀️ Good morning — ${niceDate}

> _Naxie · your day at a glance · ${dow}_

`;

  const top3Block = opts.top3.length === 0 ? "" : `## 🔥 Top 3 Today — AI Priority\n\n${opts.top3.map((p, i) => `${i + 1}. **${String(p.task.title ?? "Untitled").replace(/\n/g, " ").slice(0, 110)}** — _${p.reason}_ · \`${listNameFor(p.task, opts.lists)}\`${p.task.important ? " ⭐" : ""}`).join("\n")}\n`;
  const todayBlock = opts.today.length === 0
    ? `## ☀️ Today — 0 tasks\n\n_You're all clear for today — enjoy the open runway!_ 🎉\n`
    : `## ☀️ Today — ${opts.today.length} task${opts.today.length === 1 ? "" : "s"}\n\n${opts.today.map((it) => renderTaskLine(it, opts.lists)).join("\n")}\n`;

  const overdueBlock = opts.overdue.length === 0
    ? ""
    : `\n## ⚠️ Overdue — ${opts.overdue.length}\n\n${opts.overdue.map((it) => renderTaskLine(it, opts.lists)).join("\n")}\n`;

  // Rest of week: only days that actually have tasks, otherwise a friendly nil line.
  const weekEntries = [...opts.week.entries()].filter(([, arr]) => arr.length > 0);
  let weekBlock = "";
  if (weekEntries.length === 0) {
    weekBlock = `\n## 📅 Rest of the week\n\n_No tasks scheduled for the rest of the week. Time to plan ahead!_ 🗓️\n`;
  } else {
    weekBlock = `\n## 📅 Rest of the week\n\n`;
    for (const [d, arr] of weekEntries) {
      const nice = new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      weekBlock += `### ${nice} — ${arr.length} task${arr.length === 1 ? "" : "s"}\n\n${arr.map((it) => renderTaskLine(it, opts.lists)).join("\n")}\n\n`;
    }
  }

  const backlogBlock = opts.backlog.length === 0
    ? ""
    : `\n## 📋 Other open tasks — ${opts.backlog.length}\n\n_No due date / future-dated — still open, don't forget them:_\n\n${opts.backlog.map((it) => renderTaskLine(it, opts.lists)).join("\n")}\n`;

  const totalWeekRemaining = [...opts.week.values()].reduce((n, arr) => n + arr.length, 0);
  const summary = `\n---\n\n> 📊 **Summary:** ☀️ ${opts.today.length} today · ⚠️ ${opts.overdue.length} overdue · 📅 ${totalWeekRemaining} rest-of-week · 📋 ${opts.backlog.length} other open · ✅ ${opts.openCount} total open\n`;

  const footer = `\n<details><summary>Raw counts</summary>\n\n\`\`\`json\n${JSON.stringify({ today: opts.today.length, overdue: opts.overdue.length, backlog: opts.backlog.length, open: opts.openCount, week: Object.fromEntries([...opts.week].map(([k, v]) => [k, v.length])) }, null, 2)}\n\`\`\`\n\n</details>\n`;

  return header + top3Block + "\n" + todayBlock + overdueBlock + weekBlock + backlogBlock + summary + footer;
}

export async function runTodoBrief(_opts?: any): Promise<TodoBriefResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const runStartedAtIso = new Date().toISOString();
    const today = localYmd(new Date());
    const { today: todayItems, overdue, week, backlog, openCount, top3, allLists } = gatherTodos();
    const markdown = renderTodoMarkdown({ date: today, today: todayItems, overdue, week, backlog, openCount, top3, lists: allLists });
    const generatedAt = new Date().toISOString();
    const path = `${TODO_DIR}/${today}.md`;
    try {
      writeVaultFile(path, markdown);
      const { enqueueVaultCommit } = await import("./commit-queue.js");
      void enqueueVaultCommit(`chore(todo-brief): brief for ${today}`);
    } catch (e: any) {
      console.warn(`[todo-brief] write failed: ${e?.message ?? e}`);
    }

    const weekCount = [...week.values()].reduce((n, arr) => n + arr.length, 0);
    const result: TodoBriefResult = { date: today, path, markdown, generatedAt, todayCount: todayItems.length, overdueCount: overdue.length, weekCount, openCount, backlogCount: backlog.length, top3 };
    lastResult = result;

    // Surface on Calendar like reflection/innovation-scan.
    try {
      const { newJob } = await import("./jobs.js");
      const { persistJobRecord } = await import("./job-store.js");
      const j = newJob("todo-brief");
      j.title = `☀️ Todo Brief — ${today} (${todayItems.length} today, ${overdue.length} overdue, ${weekCount} rest-of-week, ${openCount} open)`;
      j.status = "succeeded";
      j.startedAt = runStartedAtIso;
      j.finishedAt = generatedAt;
      j.result = { answer: markdown, plan: { summary: `Todo brief for ${today}` }, todayCount: todayItems.length, overdueCount: overdue.length, weekCount, openCount, backlogCount: backlog.length, briefPath: path };
      try { persistJobRecord(j); } catch { /* tolerate */ }
    } catch (e: any) {
      console.warn(`[todo-brief] job registration failed: ${e?.message ?? e}`);
    }

    // Telegram delivery — best-effort, never throws.
    void deliverToTelegram(result);

    return result;
  })();
  try { return await inFlight; }
  finally { inFlight = null; }
}

async function deliverToTelegram(result: TodoBriefResult): Promise<void> {
  try {
    const { sendTelegramMessage, stripVaultFrontmatterForTelegram } = await import("./telegram-bridge.js");
    const niceDate = fmtNice(result.date);
    const body = stripVaultFrontmatterForTelegram(result.markdown).slice(0, 3300);
    const text = `☀️ *Todo Brief — ${niceDate}*\n📋 ${result.todayCount} today · ⚠️ ${result.overdueCount} overdue · 📅 ${result.weekCount} rest-of-week · 📦 ${result.openCount} open\n\n${body}\n\n📄 _Full brief in vault:_ ${result.path}`;
    const kb = (result.top3 ?? []).slice(0, 3).map((p: any) => {
      const t = String(p.task.title ?? "").slice(0, 22).replace(/"/g, "");
      return [
        { text: `✅ ${t}`, callback_data: `todo:done:${p.task.id}` },
        { text: `⏰ Snooze`, callback_data: `todo:snooze:${p.task.id}` },
      ];
    });
    const r = await sendTelegramMessage(text, undefined, kb.length ? kb : undefined);
    if (!r.ok) console.warn(`[todo-brief] Telegram delivery skipped: ${r.error}`);
  } catch (e: any) { console.warn(`[todo-brief] Telegram delivery failed: ${e?.message ?? e}`); }
}

// ─── Scheduler — 6am catch-up, mirrors reflection/innovation-scan ───
let scheduler: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;

export function startTodoBriefScheduler(): void {
  if (scheduler) return;
  const TODO_HOUR = Number(process.env.NAXION_TODO_BRIEF_HOUR ?? "6");
  const tick = async () => {
    const now = new Date();
    const today = localYmd(now);
    if (now.getHours() < TODO_HOUR || lastRunDate === today) return;
    try {
      const { readdirSync, statSync } = await import("node:fs");
      const { config } = await import("../config.js");
      const dir = join(config.vaultPath, TODO_DIR);
      if (existsSync(dir)) {
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const ranToday = readdirSync(dir).some(f => {
          if (!f.endsWith(".md")) return false;
          try { return statSync(join(dir, f)).mtimeMs >= midnight; } catch { return false; }
        });
        if (ranToday) { lastRunDate = today; return; }
      }
    } catch { /* vault unreachable — fall through */ }
    lastRunDate = today;
    console.log(`[todo-brief] firing daily todo brief (hour>=${TODO_HOUR}, catch-up)`);
    try { await runTodoBrief(); }
    catch (e: any) { console.warn(`[todo-brief] scheduler run failed: ${e?.message ?? e}`); }
  };
  scheduler = setInterval(tick, 10 * 60_000);
  void tick();
}

export function stopTodoBriefScheduler(): void {
  if (scheduler) { clearInterval(scheduler); scheduler = null; }
}
