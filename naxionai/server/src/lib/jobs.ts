import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { journal } from "./journal.js";
import { getActivePersona } from "./personas.js";
import { persistJobRecord, loadJobsInWindow } from "./job-store.js";
import { logAudit } from "./audit-log.js";
import { classifyOrgRole, createOrgTask, updateOrgTaskStatus, requestApproval, listOrgTasks, type OrgTaskPriority } from "./org-tasks.js";
import type { Plan } from "./agent.js"; // type-only — erased at runtime, no import cycle
import { recordUsage } from "./tool-dna.js";
import { runOutcome, outcomeToJobStatus } from "./run-outcome.js";
import { runInJobScope } from "./job-scope.js";

export type Job = {
  id: string;
  kind: string;
  // waiting_on_human: the agent did what it could and paused on a structured
  // "I need this from you" ask (result.humanRequest). Resumable via
  // POST /api/tasks/:id/human-input, which spins a continuation job — the
  // waiting job itself stays terminal, so it's safe to evict/persist.
  status: "pending" | "awaiting-approval" | "running" | "succeeded" | "failed" | "rejected" | "waiting_on_human";
  startedAt: string;
  finishedAt?: string;
  log: string[];
  result?: unknown;
  error?: string;
  template?: string;
  title?: string;
  inputs?: Record<string, unknown>;
  // Set when a schedule fired this job (schedule id). Scheduled reports are
  // the one job class still mirrored into the vault by default.
  scheduledBy?: string;
  requiresApproval?: boolean;
  approvedAt?: string;
  rejectedAt?: string;
  // Plan-approval flow: the agent drafts a plan, the user reviews/approves the
  // steps, then we execute THIS plan (no re-planning). task/personaSuffix are
  // captured so approval can resume the loop exactly as planned.
  plan?: Plan;
  task?: string;
  personaSuffix?: string;
  // Persona attribution at dispatch time. Populated by callers (chat, team)
  // so the reflection's byPersona bucket has a stable name to aggregate on.
  // Previously the reflection had to reach into result.activePersona.name
  // which nobody was setting, leaving byPersona empty for every run.
  personaId?: string;
  personaName?: string;
  // Email of the human who initiated this job (from their session at create
  // time). Absent = machine/agent/scheduled context. Staff-layer feeds show
  // only a person's OWN tasks; this is the attribution that makes that work.
  createdByEmail?: string;
  // The OrgTask (lib/org-tasks.ts) this job was filed onto, if it classified
  // into one of Naxie's 5 roles — set at dispatch time (job start), not at
  // completion, so the org dashboard can show it as genuinely "active" while
  // the job runs, not just retroactively. See runJob().
  orgTaskId?: string;
  // Crown-tier priority (see org-tasks.ts's OrgTaskPriority) propagated onto
  // the Job that actually does the work — the OrgTask-level field alone only
  // affects the org backlog's sort/SLA; this is what lets the JOB queue
  // (acquireSlot's crown-reserved slots below) and the approval checkpoint
  // (agent.ts's crownBypassesApproval) react to crown too. Absent = normal
  // queueing/approval behaviour, unchanged.
  priority?: OrgTaskPriority;
};

const jobs = new Map<string, Job>();
// Boot timestamp of the in-memory state. Survives nothing — recorded
// at module load, reset whenever tsx watch restarts the server. We
// surface it on every job-not-found response so a client polling a
// stale jobId can tell the difference between "job ran, was evicted"
// (rare) and "server restarted under you" (common in dev / hot reload).
export const SERVER_BOOT_AT = new Date().toISOString();
// How long a task may sit parked at awaiting-approval before it's stale. The
// sweep below fails ones past it, and the approve route refuses to replay them.
// Default 7 days; override via env. Lives here (not the route) so the lib can
// own the sweep without importing a route module.
export const APPROVAL_TTL_MS = Number(process.env.NAXION_APPROVAL_TTL_MS) || 7 * 24 * 3600 * 1000;
// Bumped from 50 → 200 because team-dispatch can fire 12 parallel jobs that
// each spawn sub-jobs (peer.delegate, peer.review), and at 50 the eviction
// would kick out still-running team-task jobs before the harness could poll
// them ("job not found" 404s). 200 fits a full day of typical use; the
// reflection eats the long-term audit needs.
const RECENT = 200;

// Per-job event stream for SSE consumers. Emits:
//   "log"   — a new line was appended to j.log (payload: line string)
//   "patch" — j.result got a progress patch (payload: patch object)
//   "done"  — job finished (payload: { status, error? })
// Listeners are added by the /api/jobs/:id/stream route and removed
// when the consumer disconnects. EventEmitter handles multiple
// listeners per job natively, so several browser tabs can watch the
// same run without extra wiring.
const jobEvents = new Map<string, EventEmitter>();

export function getJobEvents(id: string): EventEmitter | null {
  return jobEvents.get(id) ?? null;
}

// ── User-initiated cancellation ───────────────────────────────────────────
// Per-job AbortController so the operator can stop a running agent from the
// UI. runJob registers one for the job's lifetime; the execution paths that
// consume real time (executePlan's wave loop, delegateToPeer's poll loop)
// check the signal cooperatively and bail. cancelJob() aborts the signal,
// marks the job failed, emits "done" so every SSE subscriber stops
// immediately, and persists — so a cancel is durable across a restart.
const jobAborts = new Map<string, AbortController>();

export function getJobAbortSignal(id: string): AbortSignal | undefined {
  return jobAborts.get(id)?.signal;
}

export function cancelJob(
  id: string,
  reason = "Cancelled by the operator",
  opts?: { force?: boolean },
): { ok: boolean; status?: string; reason?: string } {
  const j = jobs.get(id);
  if (!j) return { ok: false };
  if (j.status !== "running" && j.status !== "pending" && j.status !== "waiting_on_human") {
    // Already terminal — nothing to cancel, but report the current state so
    // the UI can reconcile rather than showing a spurious error.
    return { ok: false, status: j.status };
  }
  // Crown jobs resist the normal cancel path — a superadmin's explicit
  // `force: true` (checked by the caller, e.g. routes/tasks.ts, BEFORE it
  // reaches here — this function trusts opts.force completely) is the only
  // escape hatch for a genuinely hung crown job.
  if (j.priority === "crown" && !opts?.force) {
    return { ok: false, status: j.status, reason: "crown jobs cannot be cancelled without a force override" };
  }
  // Signal cooperative aborts (agent loop / peer poll) to stop ASAP.
  try { jobAborts.get(id)?.abort(); } catch { /* tolerate */ }
  j.status = "failed";
  j.error = reason;
  j.finishedAt = new Date().toISOString();
  j.log.push(`[${j.finishedAt}] ${reason}`);
  try { persistJobRecord(j); } catch { /* tolerate */ }
  // Tell live subscribers the run is over so the UI flips out of "running"
  // even though the underlying fn() promise may take a moment to unwind.
  try { jobEvents.get(id)?.emit("done", { status: "failed", error: reason }); } catch { /* tolerate */ }
  return { ok: true, status: "failed" };
}

function ensureEmitter(id: string): EventEmitter {
  let ee = jobEvents.get(id);
  if (!ee) {
    ee = new EventEmitter();
    // 0 disables the leak warning — a long-running job with 4 browser
    // tabs subscribed is a normal pattern, not a leak.
    ee.setMaxListeners(0);
    jobEvents.set(id, ee);
  }
  return ee;
}

function dropEmitter(id: string): void {
  const ee = jobEvents.get(id);
  if (!ee) return;
  // Give listeners a tick to receive the "done" event before tearing
  // down. removeAllListeners is sync; the SSE consumer's `done` handler
  // would race the removal otherwise.
  setTimeout(() => {
    try { ee.removeAllListeners(); } catch { /* tolerate */ }
    jobEvents.delete(id);
  }, 200);
}

export function newJob(kind: string): Job {
  const j: Job = { id: randomUUID(), kind, status: "pending", startedAt: new Date().toISOString(), log: [] };
  jobs.set(j.id, j);
  if (jobs.size > RECENT) {
    // ONLY evict TERMINAL jobs — never kick out a job that's still pending or
    // running, even if it's the oldest. A team dispatch can leave a job in
    // `running` for 2-3 minutes; older but still-in-flight jobs MUST stay
    // pollable by the caller. Without this guard, polling returns 404 on a
    // perfectly-good running job and the caller treats it as failed.
    const sorted = [...jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const oldestTerminal = sorted.find(x => x.status === "succeeded" || x.status === "failed" || x.status === "rejected" || x.status === "waiting_on_human");
    if (oldestTerminal) jobs.delete(oldestTerminal.id);
    // If everything in the table is in-flight, we let the table grow past
    // RECENT temporarily — it'll trim itself as jobs finish. Better than
    // dropping live work.
  }
  return j;
}

export function getJob(id: string) { return jobs.get(id); }
export function listJobs() { return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); }

// Re-insert a job the in-memory table lost (evicted, or wiped by a restart)
// after it was rebuilt from the persisted store. Used by the approve/reject
// endpoints so a task parked for approval can still be acted on after a
// restart — otherwise getJob() misses and the caller sees a 404 "not found".
// Idempotent: a still-present live job is never clobbered.
export function adoptJob(j: Job): Job {
  const existing = jobs.get(j.id);
  if (existing) return existing;
  jobs.set(j.id, j);
  return j;
}

// Sweep stale parked approvals. A task at awaiting-approval sits in memory
// indefinitely (newJob eviction only touches terminal jobs); with the sensitive-
// action gate parking real work, an unattended approval could linger for weeks
// and then replay a plan built against long-stale inputs. Fail any parked job
// older than APPROVAL_TTL_MS with a clear reason, persist it, and notify SSE.
export function sweepStaleApprovals(now = Date.now()): number {
  let swept = 0;
  for (const j of jobs.values()) {
    // Crown jobs never get auto-failed for sitting parked — see agent.ts's
    // crownBypassesApproval, which means crown mostly shouldn't even REACH
    // awaiting-approval in the first place (forceApprovalForRole aside, which
    // this skip has no bearing on since that's an org-tasks/architect-only
    // gate, not a Job-level one). This is a belt-and-braces skip for the rare
    // case a crown job still parks (e.g. a narrower schedule-level
    // requireApproval opt-in).
    if (j.priority === "crown") continue;
    if (j.status !== "awaiting-approval") continue;
    if (now - new Date(j.startedAt).getTime() <= APPROVAL_TTL_MS) continue;
    j.status = "failed";
    j.error = "Approval expired — parked longer than the approval window; re-run the task for a fresh plan.";
    j.finishedAt = new Date().toISOString();
    j.log.push(`[${j.finishedAt}] approval expired (parked > ${Math.round(APPROVAL_TTL_MS / 3600000)}h) — failed by sweep`);
    try { getJobEvents(j.id)?.emit("done", { status: j.status, error: j.error }); } catch { /* tolerate */ }
    try { persistJobRecord(j); } catch { /* best-effort */ }
    swept += 1;
  }
  if (swept > 0) console.log(`[jobs] swept ${swept} stale awaiting-approval job(s)`);
  return swept;
}
// Hourly sweep. unref() so it never holds the process open on shutdown.
const approvalSweepTimer = setInterval(() => { try { sweepStaleApprovals(); } catch { /* tolerate */ } }, 60 * 60 * 1000);
approvalSweepTimer.unref?.();

// Normalise a job's type into a stable key for ETA grouping. Strips the peer
// "insights:" (or any "prefix:") from kind and prefers the template, so an
// ad-hoc chat task and a delegated copy of it bucket together.
export function jobTypeKey(rec: { template?: string; kind?: string }): string {
  const raw = (rec.template && rec.template.trim()) ? rec.template : (rec.kind ?? "");
  return raw.replace(/^[^:]+:/, "") || "task";
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// Historical duration stats so the Tasks page can show an ETA on a running
// job ("~90s expected"). Reads recently-succeeded jobs from the on-disk
// journal, buckets by jobTypeKey, and returns the MEDIAN wall-clock duration
// per type (median resists the long-tail outliers that skew a mean). A type
// needs a few samples to be trusted; the caller falls back to globalMedianMs
// when a running job's type is unseen or thin. In-memory recent jobs are
// folded in too so a fresh install with no journal history still learns fast.
export function etaStats(): {
  byType: Record<string, { medianMs: number; count: number }>;
  globalMedianMs: number;
  count: number;
} {
  const now = Date.now();
  const windowStart = now - 30 * 24 * 3600 * 1000; // last 30 days
  const durationsByType = new Map<string, number[]>();
  const all: number[] = [];

  const consider = (rec: { status: string; startedAt?: string; finishedAt?: string; template?: string; kind?: string }) => {
    if (rec.status !== "succeeded" || !rec.startedAt || !rec.finishedAt) return;
    const ms = new Date(rec.finishedAt).getTime() - new Date(rec.startedAt).getTime();
    if (!Number.isFinite(ms) || ms <= 0 || ms > 3 * 3600 * 1000) return; // ignore absurd/negative
    const key = jobTypeKey(rec);
    (durationsByType.get(key) ?? durationsByType.set(key, []).get(key)!).push(ms);
    all.push(ms);
  };

  try { for (const rec of loadJobsInWindow(windowStart, now)) consider(rec); } catch { /* journal optional */ }
  // Fold in in-memory jobs (covers the just-finished ones not yet re-read).
  for (const j of jobs.values()) consider(j as any);

  const byType: Record<string, { medianMs: number; count: number }> = {};
  for (const [key, arr] of durationsByType) byType[key] = { medianMs: median(arr), count: arr.length };
  return { byType, globalMedianMs: median(all), count: all.length };
}

// Mark every still-running / pending job as failed with a clear
// abort message and persist it to the JSONL store. Called from the
// graceful shutdown handler so a tsx-watch restart (or any other
// shutdown that interrupts in-flight work) leaves the journal in a
// consistent state — the reflection sees the abort rather than a
// silent disappearance, and the client can show a clear "server
// restarted" message instead of an opaque 404.
export function abortInflightJobs(reason: string): { aborted: number } {
  let aborted = 0;
  for (const j of jobs.values()) {
    if (j.status !== "pending" && j.status !== "running" && j.status !== "awaiting-approval") continue;
    j.status = "failed";
    j.error = reason;
    j.finishedAt = new Date().toISOString();
    j.log.push(`[${j.finishedAt}] ${reason}`);
    try { persistJobRecord(j); } catch { /* tolerate */ }
    aborted += 1;
  }
  return { aborted };
}

export type ProgressUpdater = (patch: Record<string, unknown>) => void;

// ── Bounded job queue (backpressure) ──────────────────────────────────────
// Without this, every job ran its work immediately (fire-and-forget), so N
// tasks submitted together all hit the LLM at once — on free-tier OpenRouter
// that's a thundering herd where all N stall on rate limits. With a cap, only
// NAXION_MAX_CONCURRENT_JOBS run at a time; the rest wait in FIFO order while
// staying `pending` (still pollable). Default to two concurrent jobs so
// multiple submissions do not stampede a local model or shared API quota.
// Explicitly set 0 to restore unbounded legacy behavior.
const configuredJobLimit = process.env.NAXION_MAX_CONCURRENT_JOBS?.trim();
const parsedJobLimit = configuredJobLimit ? Number(configuredJobLimit) : 2;
const MAX_CONCURRENT_JOBS = Number.isFinite(parsedJobLimit)
  ? Math.max(0, Math.floor(parsedJobLimit))
  : 2;
// Crown-priority jobs may borrow this many slots ABOVE the cap (see
// acquireSlot below) so a Crown Job never sits stuck behind a full queue of
// ordinary work. Only meaningful when MAX_CONCURRENT_JOBS > 0 — with an
// unbounded queue there's no cap to reserve against, so this is a
// pure no-op and every job (crown or not) still runs immediately.
const CROWN_RESERVED_SLOTS = Math.max(0, Number(process.env.NAXION_CROWN_RESERVED_SLOTS ?? "1"));
// Mirror every job into the Obsidian vault as a markdown note? Default OFF — it
// littered the user's real vault (D:\Main brain\_naxion\jobs\) with a new
// file per task (incl. delegated sub-tasks + test runs). The durable record the
// app actually reads (Reports, calendar, reflection) is the slim JSONL journal
// via persistJobRecord, NOT these notes — so turning the mirror off loses no
// function. Set NAXION_JOURNAL_TO_VAULT=1 to restore the second-brain mirror.
const JOURNAL_TO_VAULT = process.env.NAXION_JOURNAL_TO_VAULT === "1";

// "Important" tasks are journaled to the vault as knowledge even when the
// blanket mirror is off — so genuinely knowledge-bearing work (real research,
// substantial sourced deliverables) accrues in the second brain, without the
// clutter that made us disable per-task journaling (voice Q&A, db writes,
// one-line lookups, failures). A task counts as important when it SUCCEEDED,
// produced a substantial answer (≥800 chars), and either cited sources or ran
// a knowledge-producing tool. Tunable off with NAXION_JOURNAL_IMPORTANT=0.
const JOURNAL_IMPORTANT = process.env.NAXION_JOURNAL_IMPORTANT !== "0";
const KNOWLEDGE_TOOLS = new Set([
  "research.deep", "research.multiperspective", "web.scrape", "web.firecrawl",
]);
function isImportantForVault(j: Job): boolean {
  if (!JOURNAL_IMPORTANT) return false;
  if (j.status !== "succeeded") return false;
  const r: any = j.result ?? {};
  const answer = typeof r.answer === "string" ? r.answer : "";
  if (answer.length < 800) return false;
  // Skip conversational/utility kinds that happen to be long.
  if (/^(voice:|chat:trivial|db:)/.test(String(j.kind))) return false;
  const runs: any[] = Array.isArray(r.runs) ? r.runs : [];
  const usedKnowledgeTool = runs.some(x => KNOWLEDGE_TOOLS.has(x?.step?.tool ?? x?.tool));
  const hasCitations = /\[\d+\]|\[vault:/.test(answer);
  return usedKnowledgeTool || hasCitations;
}
let activeJobs = 0;
let activeCrownJobs = 0;
type SlotWaiter = { resolve: () => void; crown: boolean };
const slotWaiters: SlotWaiter[] = [];

// `priority` is optional so every existing caller (none of which knew about
// crown before) keeps behaving exactly as before. When MAX_CONCURRENT_JOBS
// <= 0 (explicit unbounded mode) this returns immediately for EVERYONE,
// crown or not — reserved slots only mean something once there's a cap to
// reserve against, so unbounded behaviour is completely unchanged.
function acquireSlot(priority?: OrgTaskPriority): Promise<void> {
  if (MAX_CONCURRENT_JOBS <= 0) return Promise.resolve();
  const crown = priority === "crown";
  // A crown job may use the cap PLUS the reserved overflow; a plain job is
  // held to the cap alone — the reserved slots are invisible to it, so
  // ordinary jobs never get squeezed by crown's headroom sitting unused.
  const ceiling = crown ? MAX_CONCURRENT_JOBS + CROWN_RESERVED_SLOTS : MAX_CONCURRENT_JOBS;
  if (activeJobs < ceiling) {
    activeJobs += 1;
    if (crown) activeCrownJobs += 1;
    return Promise.resolve();
  }
  // At capacity — queue. The waiter inherits the releaser's slot (activeJobs
  // stays at the cap), so there's no double-count.
  return new Promise<void>((resolve) => slotWaiters.push({ resolve, crown }));
}
// `wasCrown` tells us whether the SLOT BEING FREED belonged to a crown job,
// so activeCrownJobs stays accurate independent of who (if anyone) inherits
// the slot next.
function releaseSlot(wasCrown: boolean): void {
  if (MAX_CONCURRENT_JOBS <= 0) return;
  if (wasCrown) activeCrownJobs = Math.max(0, activeCrownJobs - 1);
  // Wake the earliest QUEUED CROWN waiter ahead of plain FIFO order — crown
  // work shouldn't sit behind ordinary jobs it happened to queue alongside.
  // Falls back to strict FIFO (index 0) when no crown waiter is queued.
  const crownIdx = slotWaiters.findIndex(w => w.crown);
  const idx = crownIdx !== -1 ? crownIdx : 0;
  const next = slotWaiters.length > 0 ? slotWaiters.splice(idx, 1)[0] : undefined;
  if (next) {
    if (next.crown) activeCrownJobs += 1;
    next.resolve();                       // hand the slot straight to the next in line
  } else {
    activeJobs = Math.max(0, activeJobs - 1);
  }
}

export function jobQueueStatus(): {
  cap: number; active: number; queued: number;
  crownReserved: number; activeCrown: number; queuedCrown: number;
} {
  return {
    cap: MAX_CONCURRENT_JOBS,
    active: activeJobs,
    queued: slotWaiters.length,
    crownReserved: CROWN_RESERVED_SLOTS,
    activeCrown: activeCrownJobs,
    queuedCrown: slotWaiters.filter(w => w.crown).length,
  };
}

export async function runJob<T>(j: Job, fn: (push: (msg: string) => void, progress: ProgressUpdater) => Promise<T>): Promise<void> {
  const slotRequestedAt = Date.now();
  // Backpressure gate. Stays `pending` (pollable) while queued. If the job was
  // aborted (e.g. graceful shutdown) while waiting, bail without running.
  // Mirrors acquireSlot's own ceiling so this pre-check log is accurate for a
  // crown job too — otherwise a crown job that will actually get an
  // immediate reserved slot would still log a misleading "Queued" line.
  const isCrown = j.priority === "crown";
  const ceiling = MAX_CONCURRENT_JOBS + (isCrown ? CROWN_RESERVED_SLOTS : 0);
  if (MAX_CONCURRENT_JOBS > 0 && activeJobs >= ceiling) {
    const ahead = slotWaiters.length;
    try { ensureEmitter(j.id); } catch { /* tolerate */ }
    j.log.push(`[${new Date().toISOString()}] Queued — ${ahead} task${ahead === 1 ? "" : "s"} ahead (cap ${MAX_CONCURRENT_JOBS} running at once).`);
  }
  await acquireSlot(j.priority);
  if (j.status === "failed" || j.status === "rejected") { releaseSlot(isCrown); return; }
  j.status = "running";
  // Naxie org-task tracking (docs/naxie-architecture.md §3-§6) — file this
  // job onto the classified role's backlog AT DISPATCH TIME, as "active",
  // so the org dashboard reflects real in-flight work rather than only ever
  // showing already-finished tasks. Best-effort; never blocks the job.
  try {
    const role = classifyOrgRole(j);
    if (role) {
      const task = createOrgTask({
        role,
        title: j.title ?? j.template ?? j.kind ?? "task",
        detail: String(j.task ?? j.title ?? ""),
        createdBy: j.scheduledBy ? "daemon" : "naxie",
        jobId: j.id,
      });
      updateOrgTaskStatus(task.id, "active");
      j.orgTaskId = task.id;
    }
  } catch { /* org-task tracking is best-effort, never fails a job */ }
  // Register a cancellation handle for this run. cancelJob(id) aborts it; the
  // agent loop + peer poll check the signal and stop cooperatively.
  const abort = new AbortController();
  jobAborts.set(j.id, abort);
  const ee = ensureEmitter(j.id);
  const push = (m: string) => {
    const line = `[${new Date().toISOString()}] ${m}`;
    j.log.push(line);
    // SSE subscribers receive each line as it's appended. Errors in
    // listeners must not crash the job runner — wrap in try.
    try { ee.emit("log", line); } catch { /* tolerate */ }
  };
  let currentPhase = "starting";
  let currentPhaseStartedAt = Date.now();
  const completedPhases: { phase: string; durationMs: number }[] = [];
  const phaseSnapshot = (now = Date.now()) => [
    ...completedPhases,
    { phase: currentPhase, durationMs: Math.max(0, now - currentPhaseStartedAt) },
  ];
  const progress: ProgressUpdater = (patch) => {
    const now = Date.now();
    const nextPhase = typeof patch.phase === "string" ? patch.phase : undefined;
    if (nextPhase && nextPhase !== currentPhase) {
      completedPhases.push({ phase: currentPhase, durationMs: Math.max(0, now - currentPhaseStartedAt) });
      currentPhase = nextPhase;
      currentPhaseStartedAt = now;
    }
    const enriched = { ...patch, phaseTimings: phaseSnapshot(now) };
    j.result = { ...(j.result ?? {}), ...enriched } as Record<string, unknown>;
    try { ee.emit("patch", enriched); } catch { /* tolerate */ }
  };
  const queueWaitMs = Date.now() - slotRequestedAt;
  progress({ queueWaitMs });
  if (queueWaitMs >= 250) push(`Started after ${Math.round(queueWaitMs / 1000)}s in the task queue.`);
  try {
    // Every LLM call fn makes, at any depth, can now attribute its cost and
    // trace rows to this job (job-scope.ts) instead of the literal "adhoc" —
    // AsyncLocalStorage carries the job id down the whole async subtree
    // without threading a new option through every call site in between.
    const final = await runInJobScope(j.id, () => fn(push, progress), abort.signal);
    // Operator cancelled while fn was unwinding — the delegate/agent path
    // returns NORMALLY after a cancel (it doesn't throw), so without this
    // guard the success path below would flip the job back to "succeeded"
    // over the "failed / Cancelled" state cancelJob already set (caught live
    // 2026-07-21: status showed "succeeded" with error "Cancelled by the
    // operator"). Leave the cancelled state intact.
    if (abort.signal.aborted) {
      if ((j.status as string) !== "failed") { j.status = "failed"; j.error = j.error ?? "Cancelled by the operator"; }
    } else {
    if (final && typeof final === "object") {
      j.result = { ...(j.result ?? {}), ...(final as Record<string, unknown>) };
    } else if (final !== undefined) {
      j.result = final;
    }
    // A fresh plan that hit the sensitive-action checkpoint (db.query /
    // connector.call / email.send) parks in awaiting-approval carrying the
    // exact plan the operator will review. Storing plan/task/personaSuffix on
    // the job lets the existing approve endpoint replay it via `preplan` — no
    // re-planning, so the approved run is byte-for-byte what was reviewed.
    //
    // Read the flag off the FRESH return value, not the merged j.result: the
    // approved replay returns a normal result with NO approvalRequired, but the
    // stale marker from the first run survives the object spread above — reading
    // j.result there would re-park the very run the operator just approved
    // (infinite approve loop). Clear the stale marker so the finished job's
    // result is clean too.
    const appr = (final && typeof final === "object") ? (final as any).approvalRequired : undefined;
    if (!appr && (j.result as any)?.approvalRequired) { try { delete (j.result as any).approvalRequired; } catch { /* tolerate */ } }
    if (appr && typeof appr === "object") {
      j.status = "awaiting-approval";
      j.requiresApproval = true;
      // Prefer the plan carried on approvalRequired (a delegated sub-task's real
      // steps) over the job's own result.plan (the peer.delegate wrapper) — else
      // approving would re-delegate and re-park. Falls back to the self-plan.
      j.plan = appr.plan ?? (j.result as any).plan ?? j.plan;
      j.task = appr.task ?? j.task ?? (j.inputs as any)?.userText ?? j.title;
      j.personaSuffix = appr.personaSuffix ?? j.personaSuffix;
      j.log.push(`[${new Date().toISOString()}] paused for approval — plan uses ${(appr.tools ?? []).join(", ")}; approve on the Approvals page to run it.`);
    } else
    // A run that paused on a structured human ask parks in waiting_on_human
    // instead of succeeded — the Tasks page renders the ask and the resume
    // endpoint continues the loop once the operator responds.
    if ((j.result as any)?.humanRequest) {
      j.status = "waiting_on_human";
    } else {
      // "Reached the end without throwing" is not "produced something" — a
      // synthesis failure returned as prose used to record as succeeded with
      // nothing downstream able to tell. See run-outcome.ts.
      const verdict = runOutcome(j.result as any);
      j.status = outcomeToJobStatus(verdict.outcome);
      if (verdict.reason) j.error = verdict.reason;
    }
    // Handoff notification: the agent is now blocked on a person — email the
    // operator so the wait doesn't sit invisible until someone opens the app.
    // Best-effort and async; a mail outage must never fail the job itself.
    if (j.status === "waiting_on_human") {
      const hr: any = (j.result as any).humanRequest;
      void (async () => {
        try {
          const { sendEmail, emailConfigured } = await import("./email.js");
          if (!emailConfigured()) return;
          const { lookupUser } = await import("./users.js");
          const operator = lookupUser("operator");
          if (!operator?.email) return;
          const items: string[] = Array.isArray(hr?.items) ? hr.items.map((it: any) => `- ${it.prompt}`) : [];
          await sendEmail({
            to: operator.email,
            subject: `Naxie needs your input: ${(j.title ?? j.kind).replace(/[\r\n]+/g, " ").slice(0, 120)}`,
            body: [
              `An agent paused **${j.title ?? j.kind}** — it needs the following from a human before it can finish:`,
              "",
              ...(items.length ? items : [`- ${String(hr?.reason ?? "input required")}`]),
              "",
              `Answer it on the **My Work** page and the agent resumes automatically: http://127.0.0.1:${process.env.NAXION_PORT ?? "7471"}/my-work`,
            ].join("\n"),
          });
        } catch { /* notification is best-effort */ }
      })();
    }
    } // end else (not-aborted success path)
  } catch (e: any) {
    // If the operator cancelled, cancelJob already set status/error — don't
    // clobber the "Cancelled" reason with the abort exception the loop threw.
    if (abort.signal.aborted) {
      // cancelJob (a separate call stack) may already have set status="failed"
      // + the Cancelled reason; only fill in if it somehow hasn't. Cast because
      // TS can't see the concurrent mutation.
      if ((j.status as string) !== "failed") { j.status = "failed"; j.error = j.error ?? "Cancelled by the operator"; }
    } else {
      j.status = "failed";
      j.error = e.message ?? String(e);
      push(`error: ${j.error}`);
    }
  } finally {
    jobAborts.delete(j.id);
    j.finishedAt = new Date().toISOString();
    if (j.result && typeof j.result === "object" && !Array.isArray(j.result)) {
      (j.result as Record<string, unknown>).phaseTimings = phaseSnapshot();
    }
    // Mirror the job into the vault as a note — OFF by default for ad-hoc tasks
    // (a file per task cluttered the real vault). SCHEDULED runs are the
    // exception: those are the progress reports the operator wants in the
    // second brain (daily briefing, recurring digests). Opt everything in with
    // NAXION_JOURNAL_TO_VAULT=1.
    if (JOURNAL_TO_VAULT || j.scheduledBy || isImportantForVault(j)) void journalJob(j);
    // Append a slim JSONL record to .naxion/jobs/ so the nightly
    // reflection still sees this job after the in-memory RECENT=200 cap
    // evicts it or the server restarts. Synchronous + best-effort —
    // appendFileSync is fast, and persistJobRecord swallows errors so a
    // disk hiccup can't fail the response.
    persistJobRecord(j);
    // Tool DNA (opt-in usage-preference memory, see lib/tool-dna.ts) — one
    // write site, right alongside the other per-job bookkeeping above.
    try { recordUsage({ template: j.template, skill: (j.result as any)?.skillUsed, personaId: j.personaId }); } catch { /* best-effort */ }
    // Audit trail — one event per finished job so the Audit Log page has a real
    // "what ran, by whom, did it succeed" record. Best-effort; the audit lib was
    // dead (logAudit had no callers) so the page always showed empty.
    try {
      logAudit({
        level: j.status === "failed" ? "error" : "info",
        actor: j.personaName ?? "naxie",
        action: `job.${j.kind ?? "run"}`,
        target: j.template ?? j.title ?? j.kind ?? "task",
        detail: (j.title ?? j.template ?? j.kind ?? "").slice(0, 200),
        jobId: j.id,
        result: j.status === "succeeded" ? "success" : j.status === "failed" ? "failure" : "pending",
      });
    } catch { /* audit is best-effort */ }
    // Naxie org-task tracking, part 2 — resolve the "active" OrgTask created
    // at dispatch time (above) to its final status. Best-effort, same as
    // every other post-job hook here.
    try {
      if (j.orgTaskId) {
        // Widened to `string` deliberately — TS's CFA narrows j.status to an
        // unexpectedly small literal union at this point in the function
        // (probably from earlier branches elsewhere in runJob), which would
        // make some of these comparisons "impossible" by its reckoning even
        // though they're real runtime states. Comparing as plain strings
        // sidesteps that instead of fighting it.
        const finalStatus: string = j.status;
        if (finalStatus === "succeeded") {
          updateOrgTaskStatus(j.orgTaskId, "done");
          // Supersede stale blocked scheduler reruns: every scheduled run
          // files its own OrgTask, so one failed run's "blocked" sat forever
          // even after later runs succeeded (2026-09-28: 3× "Innovation scan"
          // + "Daily briefing" blocked since 9/21 while 9/28 ran fine).
          // A success closes older daemon-created same-title blockeds —
          // operator/naxie-created tasks are never touched.
          try {
            const title = j.title ?? j.template ?? j.kind ?? null;
            if (title) {
              for (const t of listOrgTasks({ status: "blocked" })) {
                if (t.id !== j.orgTaskId && t.createdBy === "daemon" && t.title === title) {
                  updateOrgTaskStatus(t.id, "done");
                }
              }
            }
          } catch { /* supersede is best-effort */ }
        }
        else if (finalStatus === "failed" || finalStatus === "rejected" || finalStatus === "waiting_on_human") updateOrgTaskStatus(j.orgTaskId, "blocked");
        else if (finalStatus === "awaiting-approval") {
          requestApproval(j.orgTaskId, {
            actionDescription: `Run "${j.title ?? j.template ?? j.kind ?? "task"}" as planned`,
            kind: "other",
          });
        }
        // "running"/"pending" shouldn't occur here — finally only fires once
        // the job has settled into a terminal-for-now status — but if it
        // ever does, the task is simply left "active" rather than guessed at.
      }
    } catch { /* org-task tracking is best-effort, never fails a job */ }
    // Quality auto-logging — the agent's own QA wave (quality.check) scored this
    // answer; record its verdict so the Quality dashboard reflects AUTOMATED QA,
    // not just the manual thumbs it used to depend on. Tagged source:"auto" so
    // it stays distinguishable from human ratings. Best-effort, one per job.
    try {
      const q: any = (j.result as any)?.quality;
      if (j.status === "succeeded" && q && typeof q === "object" && (typeof q.score === "number" || typeof q.pass === "boolean")) {
        // Capture the 4 axes (not just the composite) + the task kind so the
        // learning loop (learnedQualitySignals) can tell WHICH dimension a task
        // type is weak on and feed that back into planning (Feature A).
        const num = (v: any) => (typeof v === "number" ? v : undefined);
        const axes = {
          factuality_risk: num(q.factuality_risk),
          citation_coverage: num(q.citation_coverage),
          persona_fit: num(q.persona_fit),
          prompt_alignment: num(q.prompt_alignment),
        };
        const hasAxes = Object.values(axes).some(v => v !== undefined);
        // Grader-outage guard: when quality.check itself failed (scorer error,
        // no JSON, unparseable JSON) it returns all-zeros — persona_fit: 0 and
        // prompt_alignment: 0 together. Recording those as signal taught the
        // learning loop that the PERSONA was weak, when the GRADER was down
        // (2026-09-28 innovation scan: peer:delegate + Naxie "weakest on
        // persona_fit" were outage zeros, not tone drift). Skip them so
        // scorer outages never masquerade as quality regressions.
        const qIssues: string[] = Array.isArray((q as any).issues) ? (q as any).issues.map((i: any) => String(i)) : [];
        const graderFailed = qIssues.some(i => /scorer (failed|returned no JSON|JSON unparseable)/i.test(i));
        if (!graderFailed) {
        void import("./quality.js").then(({ flagQuality }) => {
          flagQuality({
            jobId: j.id,
            rating: q.pass === false ? "down" : "up",
            score: typeof q.score === "number" ? q.score : undefined,
            category: "accuracy",
            persona: j.personaName,
            template: j.template,
            taskKind: j.kind,
            axes: hasAxes ? axes : undefined,
            note: "auto · quality.check",
            source: "auto",
            ts: new Date().toISOString(),
          });
        }).catch(() => { /* quality logging is best-effort */ });
        }
      }
    } catch { /* never let QA logging fail a job */ }
    // Notify SSE subscribers the job ended so they can close their
    // streams cleanly, then drop the emitter after a short grace.
    try { ee.emit("done", { status: j.status, error: j.error }); } catch { /* tolerate */ }
    dropEmitter(j.id);
    // Release the concurrency slot LAST so the next queued job starts only
    // after this one is fully wound down.
    releaseSlot(isCrown);
  }
}

async function journalJob(j: Job) {
  try {
    const r: any = j.result ?? {};
    const lines: string[] = [];
    lines.push(`- **Status:** ${j.status}`);
    lines.push(`- **Template:** ${j.template ?? j.kind}`);
    lines.push(`- **Started:** ${j.startedAt}`);
    if (j.finishedAt) lines.push(`- **Finished:** ${j.finishedAt}`);
    if (j.title) lines.push(`- **Title:** ${j.title}`);
    if (j.inputs && Object.keys(j.inputs).length > 0) {
      lines.push("");
      lines.push("## Inputs");
      lines.push("```json");
      lines.push(JSON.stringify(j.inputs, null, 2));
      lines.push("```");
    }
    if (r.plan?.summary) {
      lines.push("");
      lines.push("## Plan");
      lines.push(r.plan.summary);
    }
    if (Array.isArray(r.plan?.steps) && r.plan.steps.length > 0) {
      lines.push("");
      lines.push("### Steps");
      for (let i = 0; i < r.plan.steps.length; i++) {
        const s = r.plan.steps[i];
        const run = r.runs?.[i];
        const mark = run?.ok ? "✓" : run?.error ? "✗" : "·";
        const modelTag = run?.modelUsed ? ` · model \`${run.modelUsed}\`` : "";
        lines.push(`${i + 1}. ${mark} ${s.label ?? s.tool} — \`${s.tool}\`${run?.durationMs != null ? ` (${(run.durationMs / 1000).toFixed(1)}s)` : ""}${modelTag}`);
        if (s.rationale) lines.push(`    > ${s.rationale}`);
        if (run?.error) lines.push(`    error: ${run.error}`);
      }
    }
    if (typeof r.answer === "string" && r.answer.trim()) {
      lines.push("");
      lines.push("## Answer");
      lines.push(r.answer);
    }
    if (j.error) {
      lines.push("");
      lines.push("## Error");
      lines.push("```");
      lines.push(j.error);
      lines.push("```");
    }
    if (j.log.length > 0) {
      lines.push("");
      lines.push("<details><summary>Log</summary>");
      lines.push("");
      lines.push("```");
      lines.push(j.log.slice(-50).join("\n"));
      lines.push("```");
      lines.push("</details>");
    }
    const slug = (j.title ?? j.template ?? j.kind).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) + "-" + j.id.slice(0, 8);
    // Stamp the active persona on every journal entry so vault searches like
    // `tags: naxie` or frontmatter filters can isolate one persona's work.
    const activePersona = getActivePersona();
    await journal({
      kind: "job",
      slug,
      title: j.title ?? `${j.template ?? j.kind} (${j.status})`,
      frontmatter: {
        jobId: j.id,
        status: j.status,
        template: j.template ?? j.kind,
        persona: activePersona?.id ?? "none",
        personaName: activePersona?.name ?? "",
        startedAt: j.startedAt,
        finishedAt: j.finishedAt ?? "",
      },
      body: lines.join("\n"),
    });
  } catch { /* journal must never crash a job */ }
}
