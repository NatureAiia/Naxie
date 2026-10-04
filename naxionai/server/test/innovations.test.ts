import { describe, it, expect } from "vitest";
import { classifyEmail } from "../src/lib/smart-email-triage.js";
import { calculateStreakStats, getStreakTelegramBadge } from "../src/lib/streaks.js";
import { analyzePredictiveTasks, formatPredictiveRollupMarkdown } from "../src/lib/predictive-tasks.js";
import { detectCalendarConflicts } from "../src/lib/calendar-conflict.js";

describe("Smart Email Triage", () => {
  it("classifies meeting invitations as scheduled", () => {
    const res = classifyEmail(
      "alice@example.com",
      "Invitation: Product Strategy Sync @ Tue Oct 6",
      "Hi Nature, please join via Google Meet."
    );
    expect(res.category).toBe("scheduled");
    expect(res.badge).toContain("Scheduled");
  });

  it("classifies newsletters and invoices as FYI", () => {
    const res = classifyEmail(
      "newsletter@techdigest.com",
      "Weekly AI Digest #42",
      "Unsubscribe if you do not want to receive these emails."
    );
    expect(res.category).toBe("fyi");
    expect(res.badge).toContain("FYI");
  });

  it("classifies urgent queries and direct requests as action", () => {
    const res = classifyEmail(
      "client@corp.com",
      "Action required: sign partnership contract",
      "Please review the attached contract and approve."
    );
    expect(res.category).toBe("action");
    expect(res.urgency).toBe("high");
  });
});

describe("Habit & Focus Streaks", () => {
  it("calculates streak stats structure accurately", () => {
    const stats = calculateStreakStats(7);
    expect(stats).toHaveProperty("currentStreak");
    expect(stats).toHaveProperty("longestStreak");
    expect(stats).toHaveProperty("weeklyAvgRate");
    expect(Array.isArray(stats.history)).toBe(true);
    expect(stats.history.length).toBe(7);

    const badge = getStreakTelegramBadge(stats);
    expect(typeof badge).toBe("string");
    expect(badge.length).toBeGreaterThan(0);
  });
});

describe("Predictive Tomorrow Task Analysis", () => {
  it("evaluates completion lag and generates valid suggestions", () => {
    const analysis = analyzePredictiveTasks();
    expect(typeof analysis.avgCompletionLagDays).toBe("number");
    expect(typeof analysis.overdueCount).toBe("number");
    expect(Array.isArray(analysis.suggestions)).toBe(true);

    const md = formatPredictiveRollupMarkdown(analysis);
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
  });
});

describe("Calendar Conflict Resolver", () => {
  it("detects overlapping meetings and proposes 3 alternatives", () => {
    const events = [
      {
        summary: "Sprint Planning",
        start: "2026-10-06T10:00:00Z",
        end: "2026-10-06T11:00:00Z",
      },
      {
        summary: "Emergency Client Call",
        start: "2026-10-06T10:30:00Z",
        end: "2026-10-06T11:30:00Z",
      },
    ];

    const conflicts = detectCalendarConflicts(events);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].overlapMinutes).toBe(30);
    expect(conflicts[0].proposedAlternatives.length).toBe(3);
  });
});

