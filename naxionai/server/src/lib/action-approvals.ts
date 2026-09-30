// Telegram-side natural-language approval protocol for jobs parked
// "awaiting-approval" (lib/jobs.ts). Closes the loop the dead-end message in
// telegram-bridge.ts used to leave open: the Approvals page isn't reachable
// from a phone conversation, so a job requiring sign-off could be CREATED
// from Telegram but never actually approved/rejected from there.
//
// Two gates:
//   gate 1 (presentApproval)   — fires the moment /api/chat hands back a job
//     that needs sign-off. Shows the user what it is and arms this chat for
//     a yes/no confirmation.
//   gate 2 (handleApprovalReply) — checked BEFORE routing free text to the
//     agent. Only consumes the message when it's an unambiguous yes/no
//     equivalent — never a bare number or a single generic word ("done") that
//     the todo-callback buttons in telegram-bridge.ts also use — so a stray
//     reply can't silently approve (or collide with) the wrong thing.
//
// Talks to the same loopback API surface telegram-bridge.ts already uses
// (GET /api/tasks/jobs/:id, POST /api/templates/jobs/:id/approve|reject).
// access.ts's requireLayer("admin") passes token-less/machine callers
// straight through, and this bridge — like the /api/chat calls above it —
// never sends a session token, so no auth wiring is needed here.

import { config } from "../config.js";

const BASE = `http://127.0.0.1:${config.port}`;

// How long a presented approval stays "live" for a yes/no reply. Mirrors the
// spirit of jobs.ts's own APPROVAL_TTL_MS (a parked plan going stale) without
// importing it — this is just the LOCAL "still the thing we asked about"
// window; the server-side approve/reject endpoint enforces the real TTL.
const PENDING_TTL_MS = 10 * 60 * 1000;

type PendingApproval = { jobId: string; label: string; expiresAt: number };
const pending = new Map<string, PendingApproval>();

// Escalation — an active sweep for approvals sitting unanswered too long.
// Gates 1/2 above only react to what's already in front of the operator
// (the moment a job parks, or an inbound reply); nothing previously
// re-surfaced an approval the operator saw once and then forgot about.
// Tracked per jobId (not per chatId — `pending` above is keyed by chat, but
// several chats could theoretically be waiting on different jobs at once,
// and PENDING_TTL_MS's 10-minute window is far shorter than these
// thresholds, so escalation needs its own longer-lived state).
const ESCALATION_THRESHOLDS_MS = [15 * 60_000, 60 * 60_000, 4 * 3600_000]; // 15m, 1h, 4h
const SWEEP_INTERVAL_MS = 5 * 60_000;

type EscalationState = { chatId: string; label: string; createdAt: number; level: number };
const escalations = new Map<string, EscalationState>(); // jobId -> state

let sweepTimer: NodeJS.Timeout | null = null;

async function apiGet(path: string): Promise<any> {
  try {
    const r = await fetch(`${BASE}${path}`);
    return await r.json().catch(() => ({}));
  } catch { return {}; }
}
async function apiPost(path: string, body: unknown): Promise<{ httpOk: boolean } & Record<string, any>> {
  try {
    const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { httpOk: r.ok, ...j };
  } catch (e: any) { return { httpOk: false, error: String(e?.message ?? e) }; }
}

function describeJob(j: any): string {
  const what = j?.title ?? j?.template ?? "this task";
  const task = typeof j?.task === "string" ? j.task : (typeof j?.inputs?.task === "string" ? j.inputs.task : "");
  return task && task !== what ? `${what} — ${task.slice(0, 200)}` : String(what);
}

// Gate 1 — called from telegram-bridge.ts right where the old dead-end
// message used to fire. Looks the job up (for a real title/task instead of
// just the jobId) and arms this chat for a yes/no confirmation.
// `fallbackText` is /api/chat's own r.text (e.g. "I've queued a **Foo**
// task…") — used only if the job lookup itself fails, so this never
// regresses to something worse than the old dead end.
export async function presentApproval(chatId: string, jobId: string, fallbackText?: string): Promise<string> {
  const job = await apiGet(`/api/tasks/jobs/${jobId}`);
  const label = job?.id ? describeJob(job) : (fallbackText?.trim() || "this task");
  pending.set(chatId, { jobId, label, expiresAt: Date.now() + PENDING_TTL_MS });
  escalations.set(jobId, { chatId, label, createdAt: Date.now(), level: 0 });
  return `This needs your sign-off before it runs:\n\n${label}\n\nReply *yes* to approve or *no* to reject.`;
}

const YES = new Set(["yes", "y", "yeah", "yep", "yup", "approve", "approved", "confirm", "confirmed", "go ahead", "do it"]);
const NO = new Set(["no", "n", "nope", "nah", "reject", "rejected", "deny", "denied", "cancel", "stop"]);

// Gate 2 — checked before a Telegram text message is routed to /api/chat.
// Returns null when the message should NOT be consumed as a confirmation
// (nothing pending for this chat, it expired, or the text isn't a clear
// yes/no) — telegram-bridge.ts then falls through to its normal handling.
export async function handleApprovalReply(chatId: string, text: string): Promise<string | null> {
  const p = pending.get(chatId);
  if (!p) return null;
  if (Date.now() > p.expiresAt) { pending.delete(chatId); return null; }
  const norm = text.trim().toLowerCase().replace(/[.!]+$/, "");
  const approve = YES.has(norm);
  const reject = !approve && NO.has(norm);
  if (!approve && !reject) return null;
  pending.delete(chatId);
  escalations.delete(p.jobId);
  const r = await apiPost(`/api/templates/jobs/${p.jobId}/${approve ? "approve" : "reject"}`, {});
  if (!r.httpOk) {
    return `Couldn't ${approve ? "approve" : "reject"} "${p.label}": ${r.error ?? "unknown error"}`;
  }
  return approve
    ? `Approved — running it now. I'll follow up here when it's done: ${p.label}`
    : `Rejected: ${p.label}`;
}

// One sweep tick — re-checks every tracked job's live status (it may have
// been resolved from the web Approvals page instead of Telegram, in which
// case we stop tracking it) and nudges the operator again once elapsed time
// crosses the next unfired threshold. Re-arms `pending` on every nudge:
// PENDING_TTL_MS (10min) is far shorter than the 1h/4h thresholds, so by the
// time a later escalation fires, gate 2's original yes/no window has long
// since expired — without re-arming, a "yes" reply to the nudge would fall
// straight through to normal chat routing instead of being caught.
async function sweepOnce(): Promise<void> {
  if (escalations.size === 0) return;
  // Dynamic import — telegram-bridge.ts imports this module, so a static
  // import here would be circular.
  const { sendTelegramMessage } = await import("./telegram-bridge.js");
  const now = Date.now();
  for (const [jobId, st] of [...escalations]) {
    const job = await apiGet(`/api/tasks/jobs/${jobId}`);
    if (job?.status !== "awaiting-approval") {
      escalations.delete(jobId);
      continue;
    }
    const elapsed = now - st.createdAt;
    let crossedIdx = -1;
    for (let i = 0; i < ESCALATION_THRESHOLDS_MS.length; i++) {
      if (elapsed >= ESCALATION_THRESHOLDS_MS[i] && st.level <= i) { crossedIdx = i; break; }
    }
    if (crossedIdx === -1) continue;
    st.level = crossedIdx + 1;
    const mins = Math.round(elapsed / 60_000);
    const waited = mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
    try {
      await sendTelegramMessage(`⏰ Still waiting on your approval (${waited}):\n\n${st.label}\n\nReply *yes* to approve or *no* to reject.`, st.chatId);
      pending.set(st.chatId, { jobId, label: st.label, expiresAt: now + PENDING_TTL_MS });
    } catch (e: any) {
      console.warn(`[action-approvals] escalation nudge failed for job ${jobId}: ${e?.message ?? e}`);
    }
  }
}

export function startApprovalEscalationSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => void sweepOnce(), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopApprovalEscalationSweep(): void {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
}
