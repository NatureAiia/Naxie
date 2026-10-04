// Naxie's org-orchestration daemon (docs/naxie-architecture.md §6, and the
// PA-cadence half of §2.4). Runs alongside — not instead of —
// startScheduleScheduler(): that loop fires Schedule-triggered work; this
// one keeps Naxie's own OrgTask backlog honest between conversations.
//
// Follows the exact background-loop convention already proven in
// schedules.ts: an idempotent start guard, setInterval(...).unref() so the
// timer never holds the process open, and an immediate catch-up tick on
// boot so anything overdue during downtime resolves within seconds rather
// than waiting a full cycle.
//
// SCOPE NOTE: §2.3's notification channel now exists (lib/notify.ts —
// desktop toast + email, tiered by severity) and this module uses it for:
//   - sweepStaleOrgApprovals: expire an OrgTask parked in waiting-on-approval
//   - maybeNudgePendingApprovals: desktop-toasts when an approval has sat long enough
//   - reconcileOrphanedActiveTasks: orphaned "active" → "blocked" after restart
//   - maybeGenerateBriefing: once/day daily-briefing runner
//   - maybeNudgeStaleExecutorTasks (§6): "still on it" toast for long Executor runs
//   - maybeReportIdleActivity (§2.4/§6): idle backlog summary
//   - maybeNudgeChatInactivity (§2.4): chat-inactivity check-in — uses
//     naxie-interactions.json's lastInteractionAt (touched by voice/naxie/chat routes)
//   - maybeRunProactiveResearch (§2.4): proactive research — topic resolver over
//     interests.md + sector context + MAG subjects (see research-interests.ts)

import { listOrgTasks, updateOrgTaskStatus, snapshotOrgTasksToVault, type OrgTask } from "./org-tasks.js";
import { getJob } from "./jobs.js";
import { logAudit } from "./audit-log.js";
import { notifyAttention, notifyUrgent } from "./notify.js";
import { enqueueVaultCommit } from "./commit-queue.js";
import { runArchitectReview } from "./architect.js";
import { getInteractions, setLastNudgeAt, setLastResearchAt } from "./naxie-interactions.js";
import { resolveResearchTopics } from "./research-interests.js";
import { getOperatorIdentity } from "./mag.js";
import { buildMagContext } from "./mag.js";
import { isLoopEnabled } from "./daemon-settings.js";
import { maybeExtractZettels } from "./zettel-extract.js";

// Desktop toast nudge — fires when an OrgTask sits in waiting-on-approval
// past this threshold (docs/naxie-architecture.md §2.3 "needs your attention
// soon" tier). Silent until you look at the widget; a toast is the only
// proactive interruption, and only for approvals.
const NUDGE_AFTER_MS = Number(process.env.NAXION_ORG_NUDGE_MS) || 30 * 60 * 1000;
let lastNudgedAt = 0;
const NUDGE_THROTTLE_MS = Number(process.env.NAXION_ORG_NUDGE_THROTTLE_MS) || 30 * 60 * 1000;

export function maybeNudgePendingApprovals(now = Date.now()): number {
  const waiting = listOrgTasks({ status: "waiting-on-approval" });
  if (waiting.length === 0) return 0;
  // Nudge only when the OLDEST waiting approval has sat longer than the threshold
  const oldest = waiting.reduce((min, t) => {
    const at = new Date(t.pendingApproval?.requestedAt ?? t.updatedAt).getTime();
    return at < min ? at : min;
  }, Number.MAX_SAFE_INTEGER);
  if (now - oldest < NUDGE_AFTER_MS) return 0;
  if (now - lastNudgedAt < NUDGE_THROTTLE_MS) return 0;
  lastNudgedAt = now;
  const first = waiting[0];
  void notifyAttention(
    "Naxie — needs your call",
    `${waiting.length} task${waiting.length === 1 ? "" : "s"} waiting on your approval. Oldest: "${(first.title ?? "").slice(0, 60)}".`,
    { actor: first.role, target: first.title },
  );
  try {
    logAudit({ level: "info", actor: first.role, action: "org_task.nudge", target: first.title, detail: `${waiting.length} waiting`, result: "success" });
  } catch { /* best-effort */ }
  return waiting.length;
}

// Periodic vault backup — piggybacks on the commit-queue's own debounced
// commitAndPush (commit-queue.ts) rather than calling vault.ts directly, so
// this never races an in-flight write from some other caller. Hourly is
// plenty for a backup tick (contrast NUDGE_AFTER_MS above, which is about
// user-facing latency, not data durability).
let lastBackedUpAt = 0;
const BACKUP_THROTTLE_MS = Number(process.env.NAXION_ORG_BACKUP_THROTTLE_MS) || 60 * 60 * 1000;

export function maybeBackupVault(now = Date.now()): boolean {
  if (now - lastBackedUpAt < BACKUP_THROTTLE_MS) return false;
  lastBackedUpAt = now;
  // .naxion/ (org-tasks.ts's STATE_DIR) lives outside config.vaultPath,
  // so copy the org-task backlog into the vault first — otherwise the
  // commit below would never actually capture it. See
  // snapshotOrgTasksToVault's own comment in org-tasks.ts for why.
  try { snapshotOrgTasksToVault(); } catch (e) { console.warn(`[org-daemon] snapshotOrgTasksToVault failed: ${(e as Error).message}`); }
  void enqueueVaultCommit("daemon: periodic vault backup").catch(() => { /* best-effort — commit-queue already logs/tracks failures */ });
  return true;
}

// Weekly Architect self-review (docs/naxie-architecture.md §7) — same
// throttle-timestamp pattern as maybeBackupVault above, just a much longer
// cadence: Architect proposals are deliberately infrequent, low-volume, and
// always land in waiting-on-approval, never auto-applied. A manual trigger
// also exists (POST /api/naxie/architect/review) for testing/on-demand runs.
let lastArchitectReviewAt = 0;
const ARCHITECT_REVIEW_THROTTLE_MS = Number(process.env.NAXION_ARCHITECT_REVIEW_THROTTLE_MS) || 7 * 24 * 60 * 60 * 1000;

export async function maybeRunArchitectReview(now = Date.now()): Promise<boolean> {
  if (now - lastArchitectReviewAt < ARCHITECT_REVIEW_THROTTLE_MS) return false;
  lastArchitectReviewAt = now;
  try {
    await runArchitectReview();
  } catch (e) {
    console.warn(`[org-daemon] maybeRunArchitectReview failed: ${(e as Error).message}`);
  }
  return true;
}

// Proactive daily briefing — the "scheduled PA brief" the SCOPE NOTE above
// used to list as not-yet-implemented. Reuses the existing "daily-briefing"
// template (routes/templates.ts's dailyBriefingRunner, already scheduled via
// presets.ts for email delivery) rather than building a second content
// pipeline — this just also caches the result in memory so GET
// /api/naxie/status can push it onto the HUD unprompted, and fires the same
// notify.ts "attention" toast the other daemon behaviors use.
let latestBriefing: { text: string; generatedAt: string } | null = null;
export function getLatestBriefing(): { text: string; generatedAt: string } | null { return latestBriefing; }

let lastBriefingAt = 0;
const BRIEFING_THROTTLE_MS = Number(process.env.NAXION_ORG_BRIEFING_THROTTLE_MS) || 24 * 3600 * 1000;
// Local hour (0-23) the briefing is allowed to fire — checked every tick, so
// with the default 5-min cycle it actually fires within a few minutes of
// this hour, then the throttle above keeps it to once a day.
const BRIEFING_HOUR = Number(process.env.NAXION_ORG_BRIEFING_HOUR ?? "8");

export async function maybeGenerateBriefing(now = Date.now()): Promise<boolean> {
  if (now - lastBriefingAt < BRIEFING_THROTTLE_MS) return false;
  if (new Date(now).getHours() !== BRIEFING_HOUR) return false;
  lastBriefingAt = now;
  try {
    const { runFromChat } = await import("../routes/templates.js");
    const result: any = await runFromChat("daily-briefing", {}, () => { /* progress lines not needed for a headless run */ });
    const text = String(result?.answer ?? "").trim();
    if (!text) return false;
    latestBriefing = { text, generatedAt: new Date(now).toISOString() };
    void notifyAttention("Naxie — morning briefing ready", text.slice(0, 200), { actor: "naxie" });
    void import("./telegram-bridge.js").then(async ({ sendTelegramMessage }) => {
      const sent = await sendTelegramMessage(`## Naxie — morning briefing\n\n${text}`);
      if (!sent.ok) console.warn(`[org-daemon] morning briefing Telegram delivery failed: ${sent.error ?? "unknown error"}`);
    }).catch(e => console.warn(`[org-daemon] morning briefing Telegram delivery failed: ${e?.message ?? e}`));
    try { logAudit({ level: "info", actor: "naxie", action: "briefing.generated", target: "daily-briefing", detail: `${text.length} chars`, result: "success" }); } catch { /* best-effort */ }
  } catch (e) {
    console.warn(`[org-daemon] maybeGenerateBriefing failed: ${(e as Error).message}`);
    return false;
  }
  return true;
}

// Executor check-in nudge (docs/naxie-architecture.md §6) — a multi-step
// Executor task can genuinely be mid-flight for a long time (research,
// multi-file coding); the point isn't to complain, it's to tell you it's
// still alive rather than silently sitting there. "No update" is read off
// the Job's own log tail (every line is `[ISO] message` — see jobs.ts's
// push()), not a new Job field, since a running Job already timestamps
// every step it takes.
const EXECUTOR_CHECKIN_AFTER_MS = Number(process.env.NAXION_ORG_EXECUTOR_CHECKIN_MS) || 15 * 60 * 1000;
const EXECUTOR_CHECKIN_THROTTLE_MS = Number(process.env.NAXION_ORG_EXECUTOR_CHECKIN_THROTTLE_MS) || 30 * 60 * 1000;
const executorLastNudgedAt = new Map<string, number>(); // OrgTask id -> last nudge ts

function lastJobActivity(job: { log: string[]; startedAt: string }): number {
  const lastLine = job.log[job.log.length - 1];
  const m = lastLine ? /^\[([^\]]+)\]/.exec(lastLine) : null;
  const parsed = m ? new Date(m[1]).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : new Date(job.startedAt).getTime();
}

export function maybeNudgeStaleExecutorTasks(now = Date.now()): number {
  let nudged = 0;
  for (const t of listOrgTasks({ role: "executor", status: "active" })) {
    if (!t.jobId) continue;
    const job = getJob(t.jobId);
    if (!job) continue; // no longer tracked — reconcileOrphanedActiveTasks owns that case
    const lastActivity = lastJobActivity(job);
    if (now - lastActivity < EXECUTOR_CHECKIN_AFTER_MS) continue;
    if (now - (executorLastNudgedAt.get(t.id) ?? 0) < EXECUTOR_CHECKIN_THROTTLE_MS) continue;
    executorLastNudgedAt.set(t.id, now);
    const mins = Math.round((now - lastActivity) / 60_000);
    void notifyAttention(
      "Naxie — still on it",
      `"${(t.title ?? "").slice(0, 80)}" hasn't logged a new step in ${mins}m — still in progress, just a longer stretch than usual.`,
      { actor: "executor", target: t.title },
    );
    try { logAudit({ level: "info", actor: "executor", action: "org_task.checkin", target: t.title, detail: `no job update in ${mins}m`, jobId: t.jobId, result: "success" }); } catch { /* best-effort */ }
    nudged += 1;
  }
  return nudged;
}

// Idle-activity report (docs/naxie-architecture.md §2.4/§6) — if NOTHING has
// moved across the whole OrgTask backlog in a long stretch, proactively
// summarize what's still outstanding rather than staying silent forever.
// Deliberately conservative: fires at most once a day, and only when there's
// actually something outstanding to report (an idle backlog that's also
// EMPTY isn't worth an interruption).
const IDLE_REPORT_AFTER_MS = Number(process.env.NAXION_ORG_IDLE_REPORT_MS) || 24 * 3600 * 1000;
const IDLE_REPORT_THROTTLE_MS = Number(process.env.NAXION_ORG_IDLE_REPORT_THROTTLE_MS) || 24 * 3600 * 1000;
let lastIdleReportAt = 0;

export function maybeReportIdleActivity(now = Date.now()): boolean {
  const all = listOrgTasks();
  if (all.length === 0) return false; // nothing has ever run
  const lastActivity = new Date(all[0].updatedAt).getTime(); // listOrgTasks sorts desc by updatedAt
  if (now - lastActivity < IDLE_REPORT_AFTER_MS) return false;
  if (now - lastIdleReportAt < IDLE_REPORT_THROTTLE_MS) return false;
  lastIdleReportAt = now;
  const outstanding = all.filter(t => t.status !== "done");
  if (outstanding.length === 0) return false; // idle AND nothing outstanding — nothing to say
  const byStatus = new Map<string, number>();
  for (const t of outstanding) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  const summary = [...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
  const hrs = Math.round((now - lastActivity) / 3_600_000);
  void notifyAttention(
    "Naxie — here's what's still outstanding",
    `Nothing's moved in ${hrs}h. Outstanding: ${summary}.`,
    { actor: "naxie" },
  );
  try { logAudit({ level: "info", actor: "naxie", action: "org_task.idle_report", target: "daemon", detail: summary, result: "success" }); } catch { /* best-effort */ }
  return true;
}

// Chat-inactivity check-in — ports agency_daemon.py:_check_idle_chat_nudge.
// Fires purely because *you* went quiet (not task state). Requires a persisted
// lastInteractionAt (naxie-interactions.json); never fires if you've never chatted.
const CHAT_IDLE_MS = Number(process.env.NAXION_CHAT_IDLE_MS) || 2 * 3600 * 1000;
const CHAT_NUDGE_THROTTLE_MS = Number(process.env.NAXION_CHAT_NUDGE_THROTTLE_MS) || 2 * 3600 * 1000;

export async function maybeNudgeChatInactivity(now = Date.now()): Promise<boolean> {
  if (process.env.NAXION_CHAT_NUDGE_ENABLED === "0") return false;
  const interactions = getInteractions();
  if (!interactions?.lastInteractionAt) return false;
  const lastAt = new Date(interactions.lastInteractionAt).getTime();
  if (!Number.isFinite(lastAt)) return false;
  if (now - lastAt < CHAT_IDLE_MS) return false;
  const lastNudge = interactions.lastNudgeAt ? new Date(interactions.lastNudgeAt).getTime() : 0;
  if (now - lastNudge < CHAT_NUDGE_THROTTLE_MS) return false;
  setLastNudgeAt(new Date(now).toISOString());
  const hrs = Math.round((now - lastAt) / 3_600_000);
  try {
    const op = getOperatorIdentity();
    const magSnippet = buildMagContext({ maxFacts: 4 }).slice(0, 600);
    const { llmGenerate } = await import("./llm.js");
    const prompt = `You are Naxie, ${op.name}'s personal AI assistant. It's been about ${hrs} hours since they last talked to you. Nothing urgent is pending — you're just proactively checking in, the way a good assistant would.\n\nWhat you know about them:\n${magSnippet || "(nothing specific yet)"}\n\nWrite ONE short, warm, non-intrusive message (1-3 sentences) that doesn't apologize for interrupting, optionally references something you know if genuinely relevant, and ends with a light way to respond. No preamble, no markdown headers — just the message.`;
    const msg = (await llmGenerate(prompt, "You are Naxie, a warm and perceptive personal assistant checking in.", { profile: "balanced", maxTokens: 180 })).trim();
    void notifyAttention(`Naxie — checking in`, msg.slice(0, 400), { actor: "naxie" });
    try { logAudit({ level: "info", actor: "naxie", action: "naxie.chat_checkin", target: "daemon", detail: `${hrs}h idle`, result: "success" }); } catch { /* ignore */ }
  } catch (e) {
    console.warn(`[org-daemon] maybeNudgeChatInactivity LLM failed: ${(e as Error).message}`);
    void notifyAttention(`Naxie — checking in`, `Hey ${getOperatorIdentity().name} — it's been ${hrs}h since we last talked. Anything I can help with?`, { actor: "naxie" });
  }
  return true;
}

// Proactive research — ports agency_daemon.py:_run_proactive_research but with
// TS-native topic sources (research-interests.ts resolver) instead of Goal/ChatMessage tables.
const PROACTIVE_RESEARCH_MS = Number(process.env.NAXION_PROACTIVE_RESEARCH_MS) || 4 * 3600 * 1000;
const PROACTIVE_RESEARCH_THROTTLE_MS = Number(process.env.NAXION_PROACTIVE_RESEARCH_THROTTLE_MS) || 4 * 3600 * 1000;
let lastResearchAt = 0;

export async function maybeRunProactiveResearch(now = Date.now()): Promise<boolean> {
  if (process.env.NAXION_PROACTIVE_RESEARCH_ENABLED === "0") return false;
  const topics = resolveResearchTopics();
  // Require at least one real topic; sector+MAG fallback still counts, but empty vault on fresh install yields nothing.
  if (topics.length === 0) return false;
  // Also default OFF unless operator opted in via env or has interests/sector.
  const optedIn = process.env.NAXION_PROACTIVE_RESEARCH_ENABLED === "1" || topics.some(t => t.length > 20);
  if (!optedIn && process.env.NAXION_PROACTIVE_RESEARCH_ENABLED !== "1") {
    // Allow sector-derived single-topic fallback to run (fresh install with sector picked) — treat that as opt-in.
    const singleSectorOnly = topics.length === 1 && topics[0].startsWith("Zimbabwe");
    if (!singleSectorOnly && topics.length === 1) return false;
  }
  if (now - lastResearchAt < PROACTIVE_RESEARCH_THROTTLE_MS) return false;
  const persisted = getInteractions()?.lastResearchAt ? new Date(getInteractions()!.lastResearchAt!).getTime() : 0;
  if (persisted && now - persisted < PROACTIVE_RESEARCH_MS) return false;
  lastResearchAt = now;
  setLastResearchAt(new Date(now).toISOString());
  try {
    const op = getOperatorIdentity();
    const topicsBlock = topics.map(t => `- ${t.slice(0, 280)}`).join("\n");
    const magSnippet = buildMagContext({ maxFacts: 6 }).slice(0, 800);
    const today = new Date(now).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const prompt = `You are Naxie's proactive researcher.\nOperator: ${op.summary}\nToday: ${today}\nResearch topics / interests:\n${topicsBlock}\nRecent memory:\n${magSnippet || "(none)"}\n\nTask: Surface 2-3 actionable opportunities + 1 angle to watch, grounded in the topics above, ≤220 words, no fluff. Be specific to the sector/interests — avoid generic advice.`;
    const { llmGenerate } = await import("./llm.js");
    const report = (await llmGenerate(prompt, "You are a world-class research analyst for Naxie, a personal AI assistant.", { profile: "balanced", maxTokens: 500 })).trim();
    if (report) {
      void notifyAttention(`Naxie — proactive research`, report.slice(0, 600), { actor: "researcher" });
      try { logAudit({ level: "info", actor: "researcher", action: "research.proactive", target: "daemon", detail: topics.slice(0, 2).join("; ").slice(0, 200), result: "success" }); } catch { /* ignore */ }
      try { const { noteFact } = await import("./memory.js"); noteFact({ subject: "research", fact: report.slice(0, 1200), source: "proactive-research" }); } catch { /* ignore */ }
    }
  } catch (e) {
    console.warn(`[org-daemon] maybeRunProactiveResearch failed: ${(e as Error).message}`);
    return false;
  }
  return true;
}

// Telegram news monitor — batch-score pending posts from monitored groups.
// Delegates to telegram-news-monitor.ts's scoreAndNotifyBatch which handles
// LLM relevance scoring and DM notification.
export async function maybeScoreTelegramNews(now = Date.now()): Promise<boolean> {
  try {
    const { scoreAndNotifyBatch, isMonitorEnabled, pendingCount } = await import("./telegram-news-monitor.js");
    if (!isMonitorEnabled()) return false;
    if (pendingCount() === 0) return false;
    const notified = await scoreAndNotifyBatch(now);
    if (notified > 0) {
      void notifyAttention(
        `Naxie — Telegram news`,
        `${notified} post${notified === 1 ? "" : "s"} from monitored groups scored relevant — check your Telegram DMs.`,
        { actor: "monitor" },
      );
    }
    return notified > 0;
  } catch (e) {
    console.warn(`[org-daemon] maybeScoreTelegramNews failed: ${(e as Error).message}`);
    return false;
  }
}

// Compliance/renewal reminders — real-world deadlines (licenses, insurance,
// certs, contracts) tracked outside the OrgTask backlog since they're
// calendar-driven, not work-item-driven. Delegates to compliance-renewals.ts
// for the actual reminder/escalation logic — same dynamic-import shape as
// maybeScoreTelegramNews above, since it's another self-contained module.
export async function maybeProcessComplianceReminders(now = Date.now()): Promise<boolean> {
  try {
    const { processDueReminders } = await import("./compliance-renewals.js");
    const { reminded, escalated } = await processDueReminders(now);
    return reminded > 0 || escalated > 0;
  } catch (e) {
    console.warn(`[org-daemon] maybeProcessComplianceReminders failed: ${(e as Error).message}`);
    return false;
  }
}

export const DAEMON_CYCLE_SECONDS = Number(process.env.NAXION_ORG_DAEMON_CYCLE_SECONDS ?? "300") || 300;

// How long an OrgTask may sit at waiting-on-approval before it's stale.
// Shorter than Job's own 7-day APPROVAL_TTL_MS (jobs.ts) — naxionai's
// precedent (config.py's approval_token_expires_hours) is 48h, and an
// OrgTask approval is meant to be a PA-shaped "should I go ahead?" ask, not
// a long-lived operational approval queue.
export const ORG_APPROVAL_TTL_MS = Number(process.env.NAXION_ORG_APPROVAL_TTL_MS) || 48 * 3600 * 1000;

// An "active" OrgTask whose underlying Job hasn't been seen for this long is
// treated as orphaned rather than genuinely still running.
export const ORPHANED_ACTIVE_TTL_MS = Number(process.env.NAXION_ORG_ORPHAN_TTL_MS) || 30 * 60 * 1000;

function auditBestEffort(task: OrgTask, action: string, detail: string): void {
  try {
    logAudit({ level: "warn", actor: task.role, action, target: task.title, detail, jobId: task.jobId, result: "failure" });
  } catch { /* audit is best-effort */ }
}

// Expire a stale waiting-on-approval OrgTask. Pure-ish (one dependency: the
// org-tasks store), takes `now` as a parameter so it's testable without
// relying on the real clock — mirrors jobs.ts's sweepStaleApprovals shape.
export function sweepStaleOrgApprovals(now = Date.now()): number {
  let swept = 0;
  for (const t of listOrgTasks({ status: "waiting-on-approval" })) {
    const requestedAt = t.pendingApproval?.requestedAt;
    if (!requestedAt) continue;
    if (now - new Date(requestedAt).getTime() <= ORG_APPROVAL_TTL_MS) continue;
    updateOrgTaskStatus(t.id, "blocked");
    auditBestEffort(t, "org_task.approval_expired", `parked longer than the ${Math.round(ORG_APPROVAL_TTL_MS / 3600000)}h approval window`);
    // §2.3 "time-sensitive" tier: this is exactly "an approval has sat
    // unanswered past a threshold" — email it, don't just log it and move on.
    void notifyUrgent(
      `Naxie — an approval expired unanswered: ${(t.title ?? "").slice(0, 80)}`,
      `**${t.title}** sat in waiting-on-approval for longer than ${Math.round(ORG_APPROVAL_TTL_MS / 3600000)}h and was moved to **blocked**.\n\n` +
      `${t.pendingApproval?.actionDescription ?? "Open the Approvals page to review what it was asking for."}`,
      { actor: t.role, target: t.title },
    );
    swept += 1;
  }
  return swept;
}

// Resolve an "active" OrgTask whose Job is no longer tracked — most likely a
// server restart mid-run, since the in-memory jobs Map (lib/jobs.ts) starts
// empty on every boot. Without this, such a task would sit "active" forever
// with no path back to a terminal state.
export function reconcileOrphanedActiveTasks(now = Date.now()): number {
  let reconciled = 0;
  for (const t of listOrgTasks({ status: "active" })) {
    if (!t.jobId) continue;          // no linked job — nothing to reconcile against
    if (getJob(t.jobId)) continue;   // still tracked — a genuinely live job, leave it
    if (now - new Date(t.updatedAt).getTime() <= ORPHANED_ACTIVE_TTL_MS) continue;
    updateOrgTaskStatus(t.id, "blocked");
    auditBestEffort(t, "org_task.orphaned", "underlying job is no longer tracked (likely a server restart) — marked blocked rather than left stuck active");
    reconciled += 1;
  }
  return reconciled;
}

// SLA: blocked tasks that have sat >48h without update get escalated (priority bump + urgent notify)
const BLOCKED_SLA_MS = Number(process.env.NAXION_ORG_BLOCKED_SLA_MS) || 48 * 3600 * 1000;
const BLOCKED_SLA_THROTTLE_MS = 24 * 3600 * 1000;
// Crown priority gets a much tighter SLA and re-notify cadence — it shouldn't
// sit blocked for anywhere near as long before paging the operator again.
const CROWN_BLOCKED_SLA_MS = Number(process.env.NAXION_ORG_CROWN_BLOCKED_SLA_MS) || 2 * 3600 * 1000;
const CROWN_BLOCKED_SLA_THROTTLE_MS = Number(process.env.NAXION_ORG_CROWN_BLOCKED_SLA_THROTTLE_MS) || 1 * 3600 * 1000;
const blockedSlaNotified = new Map<string, number>();

export function maybeEscalateBlockedSLA(now = Date.now()): number {
  let escalated = 0;
  for (const t of listOrgTasks({ status: "blocked" })) {
    const slaMs = t.priority === "crown" ? CROWN_BLOCKED_SLA_MS : BLOCKED_SLA_MS;
    const throttleMs = t.priority === "crown" ? CROWN_BLOCKED_SLA_THROTTLE_MS : BLOCKED_SLA_THROTTLE_MS;
    if (now - new Date(t.updatedAt).getTime() <= slaMs) continue;
    const last = blockedSlaNotified.get(t.id) ?? 0;
    if (now - last < throttleMs) continue;
    blockedSlaNotified.set(t.id, now);
    void notifyUrgent(
      `Naxie — SLA breached: "${(t.title ?? "").slice(0, 80)}" blocked >${Math.round(slaMs / 3600000)}h`,
      `Task ${t.id} (${t.role}) has been blocked for ${Math.round((now - new Date(t.updatedAt).getTime()) / 3600000)}h without update. Review on /org-dashboard and unblock or archive.`,
      { actor: t.role, target: t.title },
    );
    auditBestEffort(t, "org_task.sla_breach", `blocked >${Math.round(slaMs / 3600000)}h — escalated`);
    escalated += 1;
  }
  return escalated;
}

async function tick(): Promise<void> {
  // Sync phases — cheap, keep sequential. Each gated by the operator's
  // per-loop kill switch (lib/daemon-settings.ts) — disabled loops are
  // skipped entirely, not just silenced.
  if (isLoopEnabled("sweepStaleOrgApprovals")) { try { sweepStaleOrgApprovals(); } catch (e) { console.warn(`[org-daemon] sweepStaleOrgApprovals failed: ${(e as Error).message}`); } }
  if (isLoopEnabled("reconcileOrphanedActiveTasks")) { try { reconcileOrphanedActiveTasks(); } catch (e) { console.warn(`[org-daemon] reconcileOrphanedActiveTasks failed: ${(e as Error).message}`); } }
  if (isLoopEnabled("maybeEscalateBlockedSLA")) { try { maybeEscalateBlockedSLA(); } catch (e) { console.warn(`[org-daemon] maybeEscalateBlockedSLA failed: ${(e as Error).message}`); } }
  if (isLoopEnabled("maybeNudgePendingApprovals")) { try { maybeNudgePendingApprovals(); } catch (e) { console.warn(`[org-daemon] maybeNudgePendingApprovals failed: ${(e as Error).message}`); } }
  if (isLoopEnabled("maybeBackupVault")) { try { maybeBackupVault(); } catch (e) { console.warn(`[org-daemon] maybeBackupVault failed: ${(e as Error).message}`); } }
  if (isLoopEnabled("maybeNudgeStaleExecutorTasks")) { try { maybeNudgeStaleExecutorTasks(); } catch (e) { console.warn(`[org-daemon] maybeNudgeStaleExecutorTasks failed: ${(e as Error).message}`); } }
  if (isLoopEnabled("maybeReportIdleActivity")) { try { maybeReportIdleActivity(); } catch (e) { console.warn(`[org-daemon] maybeReportIdleActivity failed: ${(e as Error).message}`); } }

  // Async phases — run concurrently so a slow LLM call (chat nudge, research)
  // or git push (backup) never head-blocks the next inexpensive phase.
  await Promise.allSettled([
    isLoopEnabled("maybeRunArchitectReview") ? maybeRunArchitectReview().catch(e => { console.warn(`[org-daemon] maybeRunArchitectReview failed: ${(e as Error).message}`); }) : Promise.resolve(),
    isLoopEnabled("maybeGenerateBriefing") ? maybeGenerateBriefing().catch(e => { console.warn(`[org-daemon] maybeGenerateBriefing failed: ${(e as Error).message}`); }) : Promise.resolve(),
    isLoopEnabled("maybeNudgeChatInactivity") ? maybeNudgeChatInactivity().catch(e => { console.warn(`[org-daemon] maybeNudgeChatInactivity failed: ${(e as Error).message}`); }) : Promise.resolve(),
    isLoopEnabled("maybeRunProactiveResearch") ? maybeRunProactiveResearch().catch(e => { console.warn(`[org-daemon] maybeRunProactiveResearch failed: ${(e as Error).message}`); }) : Promise.resolve(),
    isLoopEnabled("maybeScoreTelegramNews") ? maybeScoreTelegramNews().catch(e => { console.warn(`[org-daemon] maybeScoreTelegramNews failed: ${(e as Error).message}`); }) : Promise.resolve(),
    isLoopEnabled("maybeProcessComplianceReminders") ? maybeProcessComplianceReminders().catch(e => { console.warn(`[org-daemon] maybeProcessComplianceReminders failed: ${(e as Error).message}`); }) : Promise.resolve(),
    isLoopEnabled("maybeExtractZettels") ? maybeExtractZettels().catch(e => { console.warn(`[org-daemon] maybeExtractZettels failed: ${(e as Error).message}`); }) : Promise.resolve(),
  ]);

  // MD voice briefing — 5 min after audit (07:05) — best-effort, once per day
  try {
    const now = new Date();
    if (now.getHours() === 7 && now.getMinutes() >= 5) {
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      (globalThis as any).__mdVoiceBriefedDate = (globalThis as any).__mdVoiceBriefedDate ?? null;
      if ((globalThis as any).__mdVoiceBriefedDate !== today) {
        (globalThis as any).__mdVoiceBriefedDate = today;
        void import("./system-audit.js").then(m => (m.triggerVoiceBriefing as any)().catch(() => {}));
      }
    }
  } catch { /* ignore */ }
}

let timer: NodeJS.Timeout | null = null;

export function startOrgDaemon(): void {
  if (timer) return;
  timer = setInterval(tick, DAEMON_CYCLE_SECONDS * 1000);
  timer.unref?.();
  // Immediate catch-up tick so anything overdue during downtime (a stale
  // approval, an orphaned active task from before a restart) resolves within
  // seconds rather than waiting a full cycle.
  setTimeout(tick, 5_000);
}

export function stopOrgDaemon(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
