// Per-user task visibility — the ONE place that decides which jobs a signed-in
// caller may see. Shared by the Tasks/Reports feed (/api/templates/jobs), the
// tasks router (/api/tasks/*), and the Calendar (/api/calendar/*) so every
// surface shows the same slice — previously only the templates feed filtered
// and the Tasks page + Calendar leaked everyone's work to every user.
//
// Rules (same policy the templates feed established):
//   - Machine callers (no session token) and admin/superadmin sessions see
//     EVERYTHING — workers poll delegated jobs and management needs oversight.
//   - Staff sessions see ONLY:
//       1. jobs they initiated (createdByEmail === their email), plus
//       2. unattributed persona work from their OWN department (agents run
//          department work with no human owner), and
//       3. never another person's attributed job, and never persona-less
//          org-general jobs (someone's private ad-hoc work).
// Knowledge stays shared — vault/Knowledge pages are not filtered; only the
// task/activity/calendar feeds are.

import { callerOf, layerOfRole } from "./access.js";
import { loadPersonas } from "./personas.js";
import { personaDepartment } from "../routes/workforce.js";

type AnyJob = {
  createdByEmail?: string;
  personaName?: string;
  [k: string]: unknown;
};

type StaffScope = { email: string; dept: string; byName: Map<string, any> } | null;

// null → caller sees everything (machine / admin+). Otherwise the staff
// caller's scope, built once per request so list filtering stays cheap.
function scopeFor(req: any): StaffScope | "all" {
  try {
    const u = callerOf(req);
    if (!u || layerOfRole(u.role) !== "staff") return "all";
    const personas: any[] = loadPersonas().personas ?? [];
    return {
      email: String(u.email ?? "").trim().toLowerCase(),
      dept: String(u.department ?? "").trim().toLowerCase(),
      byName: new Map(personas.map((p: any) => [String(p.name).toLowerCase(), p])),
    };
  } catch { return "all"; }
}

function jobVisibleInScope(j: AnyJob, scope: Exclude<StaffScope, null>): boolean {
  const owner = String(j.createdByEmail ?? "").trim().toLowerCase();
  if (owner) return owner === scope.email;
  const pn = String(j.personaName ?? "").toLowerCase();
  if (!pn) return false; // unattributed + no persona = someone's private/general work
  if (!scope.dept) return false; // staff with no department only get their own tasks
  const p = scope.byName.get(pn);
  const d = p ? String(personaDepartment(p.role ?? "", p.id ?? "")) : "General";
  return d.toLowerCase() === scope.dept;
}

export function filterJobsForCaller<T extends AnyJob>(req: any, jobs: T[]): T[] {
  const scope = scopeFor(req);
  if (scope === "all" || scope === null) return jobs;
  return jobs.filter(j => jobVisibleInScope(j, scope));
}

// Single-job check for detail/stream routes — a staff caller must not fetch
// another user's job by guessing/knowing its id.
export function canSeeJob(req: any, job: AnyJob): boolean {
  const scope = scopeFor(req);
  if (scope === "all" || scope === null) return true;
  return jobVisibleInScope(job, scope);
}
