// Three-tier notification dispatch (docs/naxie-architecture.md §2.3):
//
//   routine            in-app only — no dispatch here; the state change
//                       itself (OrgTask/Job status, an audit-log entry) IS
//                       the surface, already rendered by Activity/Approvals/
//                       AuditLog/the OrgTask table. This tier exists in the
//                       policy table for completeness, not as code to call.
//   attention           desktop OS toast, gated by Settings > System Access's
//                       "Allow notifications" toggle (host-tools.ts,
//                       default ON — display-only, no OS mutation, so it
//                       doesn't carry system_control/clipboard's risk).
//   urgent               email to the operator, best-effort, only when
//                       email is configured. Reserved for things §2.3 calls
//                       "time-sensitive": an approval that sat unanswered
//                       past its TTL, a scheduled digest/brief firing.
//
// Every tier also writes an audit-log entry — the dispatch itself is a fact
// worth having in the record, independent of whether the toast/email
// actually reached anyone.

import { notifyToast, isNotificationsAllowed } from "./host-tools.js";
import { logAudit } from "./audit-log.js";

export type NotifySeverity = "attention" | "urgent";

export type NotifyOptions = {
  actor?: string;      // audit actor, e.g. an OrgRole — defaults to "naxie"
  target?: string;      // audit target, e.g. the task title
  jobId?: string;
};

// "attention" tier: desktop toast, gated by the notifications toggle.
// Always audits the attempt, whether or not the toggle let the toast fire.
export async function notifyAttention(title: string, message: string, opts: NotifyOptions = {}): Promise<void> {
  const allowed = isNotificationsAllowed();
  if (allowed) {
    await notifyToast(title, message).catch(() => { /* toast is best-effort */ });
  }
  try {
    logAudit({
      level: "info",
      actor: opts.actor ?? "naxie",
      action: "notify.attention",
      target: opts.target ?? title,
      detail: allowed ? message : `${message} (suppressed — notifications toggle is off)`,
      jobId: opts.jobId,
      result: allowed ? "success" : "pending",
    });
  } catch { /* audit is best-effort */ }
}

// "urgent" tier: email to the operator. Silently no-ops (past the audit
// entry) when email isn't configured — mirrors jobs.ts's own
// waiting_on_human handoff email, which follows the same emailConfigured()
// short-circuit rather than surfacing a setup error mid-daemon-tick.
export async function notifyUrgent(subject: string, body: string, opts: NotifyOptions = {}): Promise<void> {
  let sent = false;
  try {
    const { sendEmail, emailConfigured } = await import("./email.js");
    if (emailConfigured()) {
      const { lookupUser } = await import("./users.js");
      const operator = lookupUser("operator");
      if (operator?.email) {
        await sendEmail({ to: operator.email, subject, body });
        sent = true;
      }
    }
  } catch { /* email is best-effort — never let a notification failure break the caller */ }
  // Urgent items also get the desktop toast (if allowed) — email may sit
  // unread for a while, and this tier is exactly the "don't miss it" case.
  if (isNotificationsAllowed()) {
    await notifyToast(subject, body.slice(0, 200)).catch(() => { /* best-effort */ });
  }
  try {
    logAudit({
      level: sent ? "info" : "warn",
      actor: opts.actor ?? "naxie",
      action: "notify.urgent",
      target: opts.target ?? subject,
      detail: sent ? body : `${body} (email not sent — not configured or no operator address)`,
      jobId: opts.jobId,
      result: sent ? "success" : "pending",
    });
  } catch { /* audit is best-effort */ }
}
