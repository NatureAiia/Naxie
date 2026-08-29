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
// desktop toast + email, tiered by severity) and this module uses it for the
// two behaviors that produce user-facing events today:
//   - sweepStaleOrgApprovals: expire an OrgTask parked in waiting-on-approval
//     too long, mirroring jobs.ts's own sweepStaleApprovals for Job — now
//     also emails the operator (notify.ts's "urgent" tier) on expiry.
//   - maybeNudgePendingApprovals: desktop-toasts (notify.ts's "attention"
//     tier) when an approval has sat long enough to be worth interrupting
//     for, throttled.
//   - reconcileOrphanedActiveTasks: an OrgTask can be left "active" forever
//     if the server restarts mid-job (the in-memory Job map is fresh on
//     boot, so getJob() returns undefined for anything that was running
//     before) — this catches that and resolves it to "blocked" instead of a
//     permanently stuck task. In-app only (§2.3 "routine" tier) — no toast/
//     email, the OrgTask table and audit log are the surface.
//   - maybeGenerateBriefing: once/day, reuses routes/templates.ts's
//     "daily-briefing" runner and caches the result for GET /api/naxie/status
//     to push onto the HUD, toasting via notify.ts's "attention" tier.
// Still not implemented (the channel is no longer the blocker — these are
// their own separate cadence-tracking features, not yet scoped):
//   - idle-activity report, chat-inactivity check-in, proactive research
//     cadence (all from agency_daemon.py, §2.4)
//   - Executor check-in nudge for a long-running active task (§6)

import { listOrgTasks, updateOrgTaskStatus, snapshotOrgTasksToVault, type OrgTask } from "./org-tasks.js";
import { getJob } from "./jobs.js";
import { logAudit } from "./audit-log.js";
import { notifyAttention, notifyUrgent } from "./notify.js";
import { enqueueVaultCommit } from "./commit-queue.js";
import { runArchitectReview } from "./architect.js";

// Desktop toast nudge — fires when an OrgTask sits in waiting-on-approval
// past this threshold (docs/naxie-architecture.md §2.3 "needs your attention
// soon" tier). Silent until you look at the widget; a toast is the only
// proactive interruption, and only for approvals.
const NUDGE_AFTER_MS = Number(process.env.NEUROWORKS_ORG_NUDGE_MS) || 30 * 60 * 1000;
let lastNudgedAt = 0;
const NUDGE_THROTTLE_MS = Number(process.env.NEUROWORKS_ORG_NUDGE_THROTTLE_MS) || 30 * 60 * 1000;

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
const BACKUP_THROTTLE_MS = Number(process.env.NEUROWORKS_ORG_BACKUP_THROTTLE_MS) || 60 * 60 * 1000;

export function maybeBackupVault(now = Date.now()): boolean {
  if (now - lastBackedUpAt < BACKUP_THROTTLE_MS) return false;
  lastBackedUpAt = now;
  // .neuroworks/ (org-tasks.ts's STATE_DIR) lives outside config.vaultPath,
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
const ARCHITECT_REVIEW_THROTTLE_MS = Number(process.env.NEUROWORKS_ARCHITECT_REVIEW_THROTTLE_MS) || 7 * 24 * 60 * 60 * 1000;

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
const BRIEFING_THROTTLE_MS = Number(process.env.NEUROWORKS_ORG_BRIEFING_THROTTLE_MS) || 24 * 3600 * 1000;
// Local hour (0-23) the briefing is allowed to fire — checked every tick, so
// with the default 5-min cycle it actually fires within a few minutes of
// this hour, then the throttle above keeps it to once a day.
const BRIEFING_HOUR = Number(process.env.NEUROWORKS_ORG_BRIEFING_HOUR ?? "8");

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
    try { logAudit({ level: "info", actor: "naxie", action: "briefing.generated", target: "daily-briefing", detail: `${text.length} chars`, result: "success" }); } catch { /* best-effort */ }
  } catch (e) {
    console.warn(`[org-daemon] maybeGenerateBriefing failed: ${(e as Error).message}`);
    return false;
  }
  return true;
}

export const DAEMON_CYCLE_SECONDS = Number(process.env.NEUROWORKS_ORG_DAEMON_CYCLE_SECONDS ?? "300") || 300;

// How long an OrgTask may sit at waiting-on-approval before it's stale.
// Shorter than Job's own 7-day APPROVAL_TTL_MS (jobs.ts) — naxionai's
// precedent (config.py's approval_token_expires_hours) is 48h, and an
// OrgTask approval is meant to be a PA-shaped "should I go ahead?" ask, not
// a long-lived operational approval queue.
export const ORG_APPROVAL_TTL_MS = Number(process.env.NEUROWORKS_ORG_APPROVAL_TTL_MS) || 48 * 3600 * 1000;

// An "active" OrgTask whose underlying Job hasn't been seen for this long is
// treated as orphaned rather than genuinely still running.
export const ORPHANED_ACTIVE_TTL_MS = Number(process.env.NEUROWORKS_ORG_ORPHAN_TTL_MS) || 30 * 60 * 1000;

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

function tick(): void {
  try { sweepStaleOrgApprovals(); } catch (e) { console.warn(`[org-daemon] sweepStaleOrgApprovals failed: ${(e as Error).message}`); }
  try { reconcileOrphanedActiveTasks(); } catch (e) { console.warn(`[org-daemon] reconcileOrphanedActiveTasks failed: ${(e as Error).message}`); }
  try { maybeNudgePendingApprovals(); } catch (e) { console.warn(`[org-daemon] maybeNudgePendingApprovals failed: ${(e as Error).message}`); }
  try { maybeBackupVault(); } catch (e) { console.warn(`[org-daemon] maybeBackupVault failed: ${(e as Error).message}`); }
  try { void maybeRunArchitectReview(); } catch (e) { console.warn(`[org-daemon] maybeRunArchitectReview failed: ${(e as Error).message}`); }
  try { void maybeGenerateBriefing(); } catch (e) { console.warn(`[org-daemon] maybeGenerateBriefing failed: ${(e as Error).message}`); }
  // See the SCOPE NOTE at the top of this file — idle report, chat check-in,
  // proactive research, and the Executor check-in nudge still belong here.
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
