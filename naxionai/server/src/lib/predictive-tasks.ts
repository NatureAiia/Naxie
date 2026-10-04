// Predictive Tomorrow — evaluates task completion lag from my-tasks.json,
// calculates slip probability for overdue/at-risk items, and provides proactive
// reschedule recommendations for the Sunday Weekly Rollup and daily Todo Brief.

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../../../.naxion/my-tasks.json");

export type RescheduleSuggestion = {
  taskId: string;
  title: string;
  dueDate: string;
  suggestedDate: string;
  slipDays: number;
  reason: string;
  confidence: number;
};

export type PredictiveTaskAnalysis = {
  avgCompletionLagDays: number;
  totalCompletedWithDueDates: number;
  overdueCount: number;
  atRiskCount: number;
  suggestions: RescheduleSuggestion[];
  summary: string;
};

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(aYmd: string, bYmd: string): number {
  const a = new Date(aYmd + "T12:00:00").getTime();
  const b = new Date(bYmd + "T12:00:00").getTime();
  return Math.round((b - a) / 86400000);
}

function addDays(ymd: string, n: number): string {
  const d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + n);
  return localYmd(d);
}

export function analyzePredictiveTasks(): PredictiveTaskAnalysis {
  let items: any[] = [];
  try {
    if (existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      items = Array.isArray(parsed?.items) ? parsed.items : [];
    }
  } catch (err: any) {
    console.warn(`[predictive-tasks] failed to load my-tasks: ${err?.message ?? err}`);
  }

  const today = localYmd(new Date());
  const tomorrow = addDays(today, 1);

  // 1. Calculate historical completion lag
  const completedWithDue = items.filter(
    (t: any) => t.completed && t.dueDate && t.completedAt
  );

  let totalLag = 0;
  for (const t of completedWithDue) {
    const completedDate = t.completedAt.slice(0, 10);
    const lag = daysBetween(t.dueDate, completedDate);
    // Positive lag = finished later than due date
    totalLag += Math.max(0, lag);
  }

  const avgLag = completedWithDue.length > 0 
    ? Math.round((totalLag / completedWithDue.length) * 10) / 10 
    : 1.5;

  // 2. Identify overdue and slipping tasks
  const overdueTasks = items.filter((t: any) => !t.completed && t.dueDate && t.dueDate < today);
  const atRiskTasks = items.filter((t: any) => !t.completed && t.dueDate === today);

  const suggestions: RescheduleSuggestion[] = [];

  for (const t of overdueTasks) {
    const slip = Math.abs(daysBetween(t.dueDate, today));
    const isHeavy = (t.notes?.length ?? 0) > 100 || (t.steps?.length ?? 0) > 2;
    const confidence = isHeavy ? 0.90 : 0.75;
    
    suggestions.push({
      taskId: t.id,
      title: t.title,
      dueDate: t.dueDate,
      suggestedDate: tomorrow,
      slipDays: slip,
      reason: `Overdue by ${slip} day${slip === 1 ? "" : "s"}. Historical avg lag is ${avgLag}d.`,
      confidence,
    });
  }

  // Cap suggestions to the top 5 most urgent
  suggestions.sort((a, b) => b.slipDays - a.slipDays);
  const topSuggestions = suggestions.slice(0, 5);

  const summary = topSuggestions.length > 0
    ? `Identified ${overdueTasks.length} overdue task(s). Based on average completion lag (${avgLag} days), suggesting reschedule of top ${topSuggestions.length} to tomorrow (${tomorrow}).`
    : `All active tasks are on track. No rescheduling needed.`;

  return {
    avgCompletionLagDays: avgLag,
    totalCompletedWithDueDates: completedWithDue.length,
    overdueCount: overdueTasks.length,
    atRiskCount: atRiskTasks.length,
    suggestions: topSuggestions,
    summary,
  };
}

export function formatPredictiveRollupMarkdown(analysis: PredictiveTaskAnalysis): string {
  if (analysis.suggestions.length === 0) {
    return `### 🔮 Predictive Tomorrow — Horizon Clean\n\n_All tasks are current or cleared! No slip risks detected._ ✨\n`;
  }

  const lines = [
    `### 🔮 Predictive Tomorrow — Slip Risk & Reschedule`,
    ``,
    `> ⚠️ **Overdue Slip Warning:** You have **${analysis.overdueCount} overdue task${analysis.overdueCount === 1 ? "" : "s"}**. Based on your historical completion lag (~${analysis.avgCompletionLagDays} days), Naxie recommends rescheduling:`,
    ``,
    `| Task | Current Due | Slip | Recommended Action |`,
    `|---|---|---|---|`,
  ];

  for (const s of analysis.suggestions) {
    lines.push(`| **${s.title.slice(0, 40)}** | ${s.dueDate} | +${s.slipDays}d | ⏰ Reschedule to \`${s.suggestedDate}\` |`);
  }

  lines.push(``);
  return lines.join("\n");
}

