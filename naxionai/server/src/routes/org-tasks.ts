// Read-only surface over lib/org-tasks.ts's per-role backlog (docs/naxie-
// architecture.md §4/§8.5's "Org dashboard" diagnostics view). Data is
// already being written by lib/jobs.ts's post-job hook; this is the first
// route that reads any of it back. Mirrors /api/audit's admin gate — this is
// the same class of internal-activity data, not a secrets tier.

import { Router } from "express";
import { callerOf } from "../lib/access.js";
import { listOrgTasks, getOrgTask, resolveApproval, ORG_TASK_PRIORITIES, type OrgRole, type OrgTaskStatus, type OrgTaskPriority } from "../lib/org-tasks.js";
import { parseFinancePendingRef } from "../lib/business-finance.js";

export const orgTasksRouter = Router();

const VALID_ROLES: OrgRole[] = ["scheduler", "researcher", "executor", "admin", "architect", "hermes-reviewer", "improver"];
const VALID_STATUSES: OrgTaskStatus[] = ["backlog", "active", "blocked", "waiting-on-approval", "done"];

// Pure — exported for testing. An unrecognized or absent value silently
// becomes "no filter" rather than a 400; this is a diagnostics GET, not a
// strict API contract worth rejecting requests over.
export function parseOrgTaskFilter(query: Record<string, unknown>): { role?: OrgRole; status?: OrgTaskStatus; priority?: OrgTaskPriority } {
  const roleParam = typeof query.role === "string" ? query.role : undefined;
  const statusParam = typeof query.status === "string" ? query.status : undefined;
  const priorityParam = typeof query.priority === "string" ? query.priority : undefined;
  const role = roleParam && (VALID_ROLES as string[]).includes(roleParam) ? (roleParam as OrgRole) : undefined;
  const status = statusParam && (VALID_STATUSES as string[]).includes(statusParam) ? (statusParam as OrgTaskStatus) : undefined;
  const priority = priorityParam && (ORG_TASK_PRIORITIES as readonly string[]).includes(priorityParam) ? (priorityParam as OrgTaskPriority) : undefined;
  return { role, status, priority };
}

orgTasksRouter.get("/", (req, res) => {
  res.json({ tasks: listOrgTasks(parseOrgTaskFilter(req.query as Record<string, unknown>)) });
});

orgTasksRouter.get("/:id", (req, res) => {
  const task = getOrgTask(req.params.id);
  if (!task) return res.status(404).json({ error: "org task not found" });
  res.json({ task });
});

// Approve/reject a task parked in waiting-on-approval (docs §5/§8.5's
// approval-inbox extension) — mirrors Job.approve/Job.reject's one-tap shape.
// approved:true moves it back to active (the caller runs the approved action
// separately, same division of responsibility as Job); approved:false moves
// it to blocked so a rejection doesn't silently vanish from the board.
orgTasksRouter.patch("/:id/resolve", async (req, res) => {
  const approved = req.body?.approved;
  if (typeof approved !== "boolean") return res.status(400).json({ error: "body.approved (boolean) is required" });
  // Weekly self-improvement proposals carry their own apply step — approving
  // one actually creates the schedule / queues the reindex / hands the code
  // change to the architect, then marks the task done (or blocked on error).
  if (getOrgTask(req.params.id)?.role === "improver") {
    const { resolveImprovementApproval } = await import("../lib/weekly-improvement.js");
    const out = await resolveImprovementApproval(req.params.id, approved);
    if (!out) return res.status(404).json({ error: "org task not found, or not currently waiting-on-approval" });
    return res.json(out);
  }
  // Business big-spend approvals carry a finance-pending link in the task
  // detail — settling posts (approve) or drops (reject) the parked expense
  // row, so the Approvals page and the Business Finance page resolve through
  // this one path (same division of labor as the improver hook above).
  {
    const t = getOrgTask(req.params.id);
    if (t?.role === "admin" && t.pendingApproval?.kind === "spend" && parseFinancePendingRef(t.detail ?? "")) {
      const { settleSpendApproval } = await import("../lib/business-finance.js");
      const owner = callerOf(req)?.email?.trim().toLowerCase() || "local";
      const out = await settleSpendApproval(req.params.id, approved, owner);
      if (!out) return res.status(404).json({ error: "org task not found, or not currently waiting-on-approval" });
      return res.json(out);
    }
  }
  const task = resolveApproval(req.params.id, approved);
  if (!task) return res.status(404).json({ error: "org task not found, or not currently waiting-on-approval" });
  res.json({ task });
});
