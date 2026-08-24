// Naxie's org-task queue — the per-role backlog that lets a multi-step ask
// be tracked, routed, and executed reliably instead of getting lost in one
// undifferentiated job list. See docs/naxie-architecture.md §3-§5.
//
// The five roles (scheduler/researcher/executor/admin/architect) are pure
// implementation detail — Naxie never names them in conversation (§0, §8).
// This store exists so the org's internals are inspectable via the
// diagnostics dashboard (§8.5) and so approvals/audit have something
// concrete to point at, not because a user ever addresses a role directly.
//
// Persistence follows the exact pattern schedules.ts already uses: a JSON
// file under .neuroworks/, an in-memory cache, and an mtime check on load so
// a worker process's write is picked up by the primary without a restart.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { logAudit } from "./audit-log.js";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.neuroworks");
const FILE = join(STATE_DIR, "org-tasks.json");

// Single-user product (docs/naxie-architecture.md §0) — deliberately no
// ownerId anywhere in this module.
export type OrgRole = "scheduler" | "researcher" | "executor" | "admin" | "architect";
export type OrgTaskStatus = "backlog" | "active" | "blocked" | "waiting-on-approval" | "done";
export type OrgTaskPriority = "low" | "normal" | "high" | "urgent";
export type PendingApprovalKind = "external-comms" | "spend" | "calendar-external" | "host-tool" | "architect-change" | "other";

// Architect-specific proposal payload (docs/naxie-architecture.md §7) — a
// self-contained code-change proposal riding alongside the plain-language
// PendingApproval.actionDescription. `diff` here and PendingApproval's own
// top-level `diff` field are allowed to both be populated; the top-level
// field stays for review-UI code that doesn't know about `proposal` yet.
export type ArchitectProposal = {
  diff: string;
  filesTouched: string[];
  rationale: string;
  basedOn?: { auditQuery?: string; sourceFilesRead?: string[] };
};

export type PendingApproval = {
  actionDescription: string;   // plain language, e.g. "Send email to X saying Y" — never names the internal role
  kind: PendingApprovalKind;
  requestedAt: string;
  diff?: string;               // optional unified-diff-format text for review UIs
  proposal?: ArchitectProposal; // Architect-only: structured diff/rationale payload
};

export type OrgTask = {
  id: string;
  role: OrgRole;
  title: string;
  detail: string;
  status: OrgTaskStatus;
  priority: OrgTaskPriority;
  linkedTaskIds: string[];     // multi-step project grouping — kept consistent both directions on link
  jobId?: string;              // the underlying Job driving execution, once active
  createdAt: string;
  updatedAt: string;
  createdBy: "naxie" | "user" | "daemon";
  pendingApproval?: PendingApproval;
};

// ─── Per-role default autonomy (docs/naxie-architecture.md §5) ────────────
// A role's OWN autonomous lane — read-only research, drafting, own-backlog
// status changes. Anything outside these categories (external comms, spend,
// calendar changes affecting other people, host-tool actions) is gated by
// CONSEQUENTIAL_TOOLS in governance.ts regardless of role; this table is
// about what a role may do WITHOUT even reaching that gate.
export type AutonomyCategory = "read" | "draft" | "own-backlog-update";

export const ROLE_AUTONOMY: Record<OrgRole, { autonomous: readonly AutonomyCategory[]; alwaysRequiresApproval: boolean }> = {
  scheduler: { autonomous: ["read", "draft", "own-backlog-update"], alwaysRequiresApproval: false },
  researcher: { autonomous: ["read", "draft", "own-backlog-update"], alwaysRequiresApproval: false },
  executor: { autonomous: ["read", "draft", "own-backlog-update"], alwaysRequiresApproval: false },
  admin: { autonomous: ["read", "draft", "own-backlog-update"], alwaysRequiresApproval: false },
  // No autonomous lane beyond reading its own backlog — every actual change
  // the Architect proposes is a pending-approval item, unconditionally.
  architect: { autonomous: ["read", "own-backlog-update"], alwaysRequiresApproval: true },
};

// The one rule with no override anywhere in this system (docs §5, §7): a
// step proposed by the architect role always requires approval, regardless
// of governance policy state, NEUROWORKS_GOVERNANCE_MODE=monitor, or
// anything else. Pure and disk-free so it's trivially testable and so
// callers can't accidentally bypass it via some other code path.
export function forceApprovalForRole(role: OrgRole): boolean {
  return ROLE_AUTONOMY[role].alwaysRequiresApproval;
}

// ─── Role classification (docs §3's duration/complexity routing rule) ─────
// Classifies a Job into the role whose backlog it belongs on, or null if the
// job is too trivial to put on the board at all. This is a lightweight
// heuristic, not the real triage step described in the architecture doc —
// there is no LLM call here, and Naxie's chat routing (which templates match,
// which text becomes a general-task Job) is completely unchanged. This only
// decides where an ALREADY-DISPATCHED job gets filed for tracking purposes.
// A genuine intent-classifying triage step (Naxie deciding whether to answer
// directly vs. hand something off) is future work — see
// docs/naxie-architecture.md §3.
export type ClassifiableJob = {
  kind?: string;
  template?: string;
  title?: string;
  task?: string;
  scheduledBy?: string;
};

// Shared text→role regex vocabulary — the single place both classifyOrgRole
// (Job-shape, already-dispatched work) and naxie-router.ts's classifyChatIntent
// (raw chat text, deciding whether to delegate at all) pull their role
// vocabulary from, so the two never drift out of sync. Returns null when no
// role-specific vocabulary matches (callers pick their own default/fallback).
export function matchRoleFromText(text: string): OrgRole | null {
  const lower = text.toLowerCase();
  if (/\b(remind|reminder|calendar|appointment)\b/.test(lower)) return "scheduler";
  if (/\b(inbox|email\s*triage|triage|digest|check[- ]?in|routine)\b/.test(lower)) return "admin";
  if (/\b(research|summari[sz]e|brief(?:ing)?|investigat|look(?:ing)?\s+into|fact[- ]?check)\b/.test(lower)) return "researcher";
  return null;
}

export function classifyOrgRole(job: ClassifiableJob): OrgRole | null {
  const kind = job.kind ?? "";
  // Noise that shouldn't clutter the per-role board — mirrors jobs.ts's own
  // isImportantForVault() filter for the same underlying reason (voice Q&A,
  // db one-liners, and trivial chat aren't "work" in the org-board sense).
  if (/^(voice:|chat:trivial|db:)/.test(kind)) return null;

  // A schedule-fired job is definitionally Scheduler's work regardless of
  // what the fired template actually does — the SCHEDULING is what
  // Scheduler owns, not the task content.
  if (job.scheduledBy) return "scheduler";

  const text = `${job.title ?? ""} ${job.template ?? ""} ${job.task ?? ""}`;
  const matched = matchRoleFromText(text);
  if (matched) return matched;
  // Default: anything that reached this point (no more specific match) is
  // treated as project-shaped work for Executor — the deliberately broad
  // generalist role (docs §3). Never returns "architect": that role is
  // system-initiated only (docs §7), never reachable from ordinary chat.
  return "executor";
}

// Whether a given category of action is in a role's own autonomous lane —
// note this is necessary but not sufficient: CONSEQUENTIAL_TOOLS-gated
// actions and forceApprovalForRole("architect") can still require approval
// even when isAutonomousForRole would say yes for the category alone.
export function isAutonomousForRole(role: OrgRole, category: AutonomyCategory): boolean {
  if (forceApprovalForRole(role)) return false;
  return ROLE_AUTONOMY[role].autonomous.includes(category);
}

// ─── persistence (in-memory authoritative, mirrored to disk) ──────────────

type Store = { tasks: OrgTask[] };
let cache: Store | null = null;
let cacheMtimeMs = 0;

function load(): Store {
  const cached = cache;
  if (cached) {
    try {
      const m = statSync(FILE).mtimeMs;
      if (m === cacheMtimeMs) return cached;
      cache = null; // file changed under us (e.g. a worker process) — re-read
    } catch { return cached; }
  }
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(FILE)) {
    cache = { tasks: [] };
    persist();
    return cache;
  }
  try {
    const raw = readFileSync(FILE, "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    cache = { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch (e) {
    console.warn(`[org-tasks] failed to read ${FILE}: ${(e as Error).message}. Starting empty.`);
    cache = { tasks: [] };
  }
  try { cacheMtimeMs = statSync(FILE).mtimeMs; } catch { cacheMtimeMs = 0; }
  return cache;
}

function persist(): void {
  if (!cache) return;
  try {
    writeFileSync(FILE, JSON.stringify(cache, null, 2));
    try { cacheMtimeMs = statSync(FILE).mtimeMs; } catch { /* next load() re-reads — harmless */ }
  } catch (e) {
    console.warn(`[org-tasks] persist failed: ${(e as Error).message}`);
  }
}

// Snapshot copy for org-daemon.ts's maybeBackupVault tick-phase. STATE_DIR
// (above) resolves to <repo>/.neuroworks — OUTSIDE config.vaultPath (see
// config.ts's vaultPath, e.g. .../server/vault) — so a plain vault commit
// would never capture the org-task backlog. This copies the current
// on-disk state file into the vault's _neuroworks/ folder (same convention
// as audit-log.ts's AUDIT_REL, which already lives inside the vault) so the
// commit-queue's next commit actually includes it. Best-effort: a missing
// or unwritable vault path shouldn't take down the daemon tick.
export function snapshotOrgTasksToVault(): boolean {
  try {
    if (!existsSync(FILE)) return false;
    const destDir = resolve(config.vaultPath, "_neuroworks");
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, "org-tasks.snapshot.json");
    writeFileSync(dest, readFileSync(FILE, "utf8"));
    return true;
  } catch (e) {
    console.warn(`[org-tasks] snapshotOrgTasksToVault failed: ${(e as Error).message}`);
    return false;
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────

export function listOrgTasks(filter?: { role?: OrgRole; status?: OrgTaskStatus }): OrgTask[] {
  let tasks = load().tasks.slice();
  if (filter?.role) tasks = tasks.filter(t => t.role === filter.role);
  if (filter?.status) tasks = tasks.filter(t => t.status === filter.status);
  return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getOrgTask(id: string): OrgTask | undefined {
  return load().tasks.find(t => t.id === id);
}

export type CreateOrgTaskInput = {
  role: OrgRole;
  title: string;
  detail: string;
  priority?: OrgTaskPriority;
  createdBy: OrgTask["createdBy"];
  linkedTaskIds?: string[];
  jobId?: string;
};

export function createOrgTask(input: CreateOrgTaskInput): OrgTask {
  const s = load();
  const now = new Date().toISOString();
  const task: OrgTask = {
    id: randomUUID(),
    role: input.role,
    title: input.title,
    detail: input.detail,
    status: "backlog",
    priority: input.priority ?? "normal",
    linkedTaskIds: input.linkedTaskIds ?? [],
    jobId: input.jobId,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
  };
  s.tasks.push(task);
  persist();
  logAudit({
    level: "info",
    actor: task.role,
    action: "org_task.created",
    target: task.title,
    detail: task.detail.slice(0, 200),
    jobId: task.jobId,
    result: "success",
  });
  return task;
}

// Move a task to a new status. Requesting "waiting-on-approval" without a
// `pendingApproval` is a caller error — every gated action needs a
// plain-language description for the approval inbox, never just a state
// flip with nothing to show the user (docs §8.5).
export function updateOrgTaskStatus(
  id: string,
  status: OrgTaskStatus,
  opts?: { pendingApproval?: PendingApproval },
): OrgTask | null {
  const s = load();
  const idx = s.tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;
  if (status === "waiting-on-approval" && !opts?.pendingApproval) {
    throw new Error(`updateOrgTaskStatus(${id}, "waiting-on-approval") requires opts.pendingApproval`);
  }
  const prev = s.tasks[idx];
  const next: OrgTask = {
    ...prev,
    status,
    updatedAt: new Date().toISOString(),
    // Only a waiting-on-approval transition carries a pendingApproval — clear
    // it on every other transition so a stale approval description doesn't
    // linger once the task has moved past it.
    pendingApproval: status === "waiting-on-approval" ? opts!.pendingApproval : undefined,
  };
  s.tasks[idx] = next;
  persist();
  logAudit({
    level: status === "blocked" ? "warn" : "info",
    actor: next.role,
    action: `org_task.${status}`,
    target: next.title,
    detail: next.pendingApproval?.actionDescription ?? "",
    jobId: next.jobId,
    result: status === "done" ? "success" : status === "blocked" ? "failure" : "pending",
  });
  return next;
}

// Request approval for a specific action. This is the entry point the
// governance gate (§5) and the Architect's own force-approval rule funnel
// into — a single place that always produces a well-formed OrgTask in
// waiting-on-approval with a real, user-facing description.
export function requestApproval(id: string, pendingApproval: Omit<PendingApproval, "requestedAt">): OrgTask | null {
  return updateOrgTaskStatus(id, "waiting-on-approval", {
    pendingApproval: { ...pendingApproval, requestedAt: new Date().toISOString() },
  });
}

// Resolve a pending approval — approved moves the task back to active (the
// caller is expected to actually run the approved action separately, same
// division of responsibility as Job.approve/reject); rejected moves it to
// blocked so it doesn't silently vanish from the board.
export function resolveApproval(id: string, approved: boolean): OrgTask | null {
  const task = getOrgTask(id);
  if (!task || task.status !== "waiting-on-approval") return null;
  return updateOrgTaskStatus(id, approved ? "active" : "blocked");
}

// Bidirectional link — maintained on both tasks so "these N tasks are one
// project" is discoverable from either end without a separate project entity.
export function linkOrgTasks(idA: string, idB: string): boolean {
  const s = load();
  const a = s.tasks.find(t => t.id === idA);
  const b = s.tasks.find(t => t.id === idB);
  if (!a || !b || a.id === b.id) return false;
  if (!a.linkedTaskIds.includes(b.id)) a.linkedTaskIds.push(b.id);
  if (!b.linkedTaskIds.includes(a.id)) b.linkedTaskIds.push(a.id);
  a.updatedAt = new Date().toISOString();
  b.updatedAt = new Date().toISOString();
  persist();
  return true;
}
