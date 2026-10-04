// Habit & Focus Streaks — tracks daily completion rate from my-tasks.json,
// maintains consecutive focus streak statistics, records to vault _neuroworks/streaks.md,
// and provides streak badges for Todo Brief & Weekly Rollup Telegram deliveries.

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeVaultFile } from "./vault.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../../../.naxion/my-tasks.json");
const STREAKS_VAULT_PATH = "_neuroworks/streaks.md";

export type DailyStreakRecord = {
  date: string;              // YYYY-MM-DD
  dueCount: number;
  completedCount: number;
  completionRate: number;    // 0.0 - 1.0
  streakMaintained: boolean; // >= 0.75 completion or completed >= 1 with 0 overdue
};

export type StreakStats = {
  currentStreak: number;
  longestStreak: number;
  todayRate: number;
  weeklyAvgRate: number;
  history: DailyStreakRecord[];
  lastUpdated: string;
};

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function calculateStreakStats(daysBack = 14): StreakStats {
  const now = new Date();
  const today = localYmd(now);

  let tasks: any[] = [];
  try {
    if (existsSync(CONFIG_PATH)) {
      const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      tasks = Array.isArray(data?.items) ? data.items : [];
    }
  } catch (err: any) {
    console.warn(`[streaks] failed to read my-tasks.json: ${err?.message ?? err}`);
  }

  const history: DailyStreakRecord[] = [];
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const ymd = localYmd(d);

    const dueToday = tasks.filter(t => t.dueDate === ymd || t.myDay === ymd);
    const completedToday = tasks.filter(t => t.completedAt && t.completedAt.slice(0, 10) === ymd);

    const dueCount = Math.max(dueToday.length, completedToday.length);
    const completedCount = completedToday.length;
    const rate = dueCount > 0 ? completedCount / dueCount : (completedCount > 0 ? 1.0 : 0.0);

    // Maintained if completed everything or rate >= 70%
    const maintained = (rate >= 0.70 && completedCount > 0) || (dueCount === 0 && completedCount > 0);

    history.push({
      date: ymd,
      dueCount,
      completedCount,
      completionRate: Math.round(rate * 100) / 100,
      streakMaintained: maintained,
    });
  }

  // Calculate current active streak ending at today/yesterday
  let currentStreak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i];
    if (rec.date === today && !rec.streakMaintained) {
      // Today is still ongoing; check yesterday
      continue;
    }
    if (rec.streakMaintained) {
      currentStreak++;
    } else {
      break;
    }
  }

  // Calculate longest streak
  let longestStreak = 0;
  let tempStreak = 0;
  for (const rec of history) {
    if (rec.streakMaintained) {
      tempStreak++;
      if (tempStreak > longestStreak) longestStreak = tempStreak;
    } else {
      tempStreak = 0;
    }
  }
  if (currentStreak > longestStreak) longestStreak = currentStreak;

  const todayRecord = history.find(h => h.date === today);
  const todayRate = todayRecord ? todayRecord.completionRate : 0;

  // 7-day average
  const last7 = history.slice(-7);
  const sumRates = last7.reduce((acc, r) => acc + r.completionRate, 0);
  const weeklyAvgRate = last7.length ? Math.round((sumRates / last7.length) * 100) / 100 : 0;

  return {
    currentStreak,
    longestStreak,
    todayRate,
    weeklyAvgRate,
    history,
    lastUpdated: new Date().toISOString(),
  };
}

export function formatStreakMarkdown(stats: StreakStats): string {
  const emoji = stats.currentStreak >= 7 ? "🏆" : (stats.currentStreak >= 3 ? "🔥" : "🌱");
  const lines: string[] = [
    `---`,
    `type: habit-streaks`,
    `updated: ${stats.lastUpdated}`,
    `current_streak: ${stats.currentStreak}`,
    `longest_streak: ${stats.longestStreak}`,
    `weekly_avg: ${Math.round(stats.weeklyAvgRate * 100)}%`,
    `---`,
    ``,
    `# ${emoji} Neuroworks Focus & Habit Streaks`,
    ``,
    `> **Current Streak:** **${stats.currentStreak} day${stats.currentStreak === 1 ? "" : "s"}** ${stats.currentStreak >= 3 ? "🔥" : ""}  `,
    `> **All-Time Best:** ${stats.longestStreak} days 🏅  `,
    `> **7-Day Focus Score:** ${Math.round(stats.weeklyAvgRate * 100)}% completion rate`,
    ``,
    `## 📊 Recent 14-Day Activity`,
    ``,
    `| Date | Scheduled / Due | Completed | Completion Rate | Status |`,
    `|---|---|---|---|---|`,
  ];

  for (const r of [...stats.history].reverse()) {
    const badge = r.streakMaintained ? "✅ Maintained" : (r.dueCount === 0 && r.completedCount === 0 ? "⚪ Off-day" : "⚠️ Slipped");
    lines.push(`| ${r.date} | ${r.dueCount} | ${r.completedCount} | ${Math.round(r.completionRate * 100)}% | ${badge} |`);
  }

  lines.push(``, `---`, `*Auto-synced by Naxie Focus Streaks daemon.*`);
  return lines.join("\n");
}

export async function syncStreaksToVault(): Promise<StreakStats> {
  const stats = calculateStreakStats();
  const md = formatStreakMarkdown(stats);
  try {
    writeVaultFile(STREAKS_VAULT_PATH, md);
  } catch (err: any) {
    console.warn(`[streaks] failed to write to vault: ${err?.message ?? err}`);
  }
  return stats;
}

export function getStreakTelegramBadge(stats: StreakStats): string {
  if (stats.currentStreak === 0) {
    return `🌱 Focus Streak: Day 0 (Complete today's tasks to ignite the streak!)`;
  }
  const flame = "🔥".repeat(Math.min(stats.currentStreak, 5));
  return `${flame} *${stats.currentStreak}-Day Focus Streak!* (${Math.round(stats.weeklyAvgRate * 100)}% weekly completion)`;
}

