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
// SCOPE NOTE: this module currently implements only the two behaviors that
// don't depend on infrastructure this codebase doesn't have yet — there is
// no chat-push / desktop-toast / email notification channel (§2.3) wired up
// in neuroworks today (naxionai's Python side has agent/chat_push.py; the TS
// side has nothing equivalent). Rather than fake those behaviors with a
// console.log that looks like it works, they're left as explicit stubs
// below. Implemented now:
//   - sweepStaleOrgApprovals: expire an OrgTask parked in waiting-on-approval
//     too long, mirroring jobs.ts's own sweepStaleApprovals for Job.
//   - reconcileOrphanedActiveTasks: an OrgTask can be left "active" forever
//     if the server restarts mid-job (the in-memory Job map is fresh on
//     boot, so getJob() returns undefined for anything that was running
//     before) — this catches that and resolves it to "blocked" instead of a
//     permanently stuck task.
// Not yet implemented (blocked on §2.3's notification channel):
//   - idle-activity report, chat-inactivity check-in, proactive research
//     cadence, scheduled PA briefs (all from agency_daemon.py, §2.4)
//   - Executor check-in nudge for a long-running active task (§6)

import { listOrgTasks, updateOrgTaskStatus, type OrgTask } from "./org-tasks.js";
import { getJob } from "./jobs.js";
import { logAudit } from "./audit-log.js";
import { notifyToast } from "./host-tools.js";

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
  void notifyToast(
    "Naxie — needs your call",
    `${waiting.length} task${waiting.length === 1 ? "" : "s"} waiting on your approval. Oldest: "${(first.title ?? "").slice(0, 60)}".`,
  ).catch(() => { /* toast is best-effort */ });
  try {
    logAudit({ level: "info", actor: first.role, action: "org_task.nudge", target: first.title, detail: `${waiting.length} waiting`, result: "success" });
  } catch { /* best-effort */ }
  return waiting.length;
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
  // See the SCOPE NOTE at the top of this file — idle report, chat check-in,
  // proactive research, scheduled briefs, and the Executor check-in nudge
  // all belong here once a notification channel (§2.3) exists to carry them.
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
