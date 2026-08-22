// Read-only surface over lib/org-tasks.ts's per-role backlog (docs/naxie-
// architecture.md §4/§8.5's "Org dashboard" diagnostics view). Data is
// already being written by lib/jobs.ts's post-job hook; this is the first
// route that reads any of it back. Mirrors /api/audit's admin gate — this is
// the same class of internal-activity data, not a secrets tier.

import { Router } from "express";
import { listOrgTasks, getOrgTask, resolveApproval, type OrgRole, type OrgTaskStatus } from "../lib/org-tasks.js";

export const orgTasksRouter = Router();

const VALID_ROLES: OrgRole[] = ["scheduler", "researcher", "executor", "admin", "architect"];
const VALID_STATUSES: OrgTaskStatus[] = ["backlog", "active", "blocked", "waiting-on-approval", "done"];

// Pure — exported for testing. An unrecognized or absent value silently
// becomes "no filter" rather than a 400; this is a diagnostics GET, not a
// strict API contract worth rejecting requests over.
export function parseOrgTaskFilter(query: Record<string, unknown>): { role?: OrgRole; status?: OrgTaskStatus } {
  const roleParam = typeof query.role === "string" ? query.role : undefined;
  const statusParam = typeof query.status === "string" ? query.status : undefined;
  const role = roleParam && (VALID_ROLES as string[]).includes(roleParam) ? (roleParam as OrgRole) : undefined;
  const status = statusParam && (VALID_STATUSES as string[]).includes(statusParam) ? (statusParam as OrgTaskStatus) : undefined;
  return { role, status };
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
orgTasksRouter.patch("/:id/resolve", (req, res) => {
  const approved = req.body?.approved;
  if (typeof approved !== "boolean") return res.status(400).json({ error: "body.approved (boolean) is required" });
  const task = resolveApproval(req.params.id, approved);
  if (!task) return res.status(404).json({ error: "org task not found, or not currently waiting-on-approval" });
  res.json({ task });
});
