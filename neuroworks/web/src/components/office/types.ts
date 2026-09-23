// Office data shapes — moved out of the deleted OfficeScene.tsx (the 3D
// renderer went, this shape didn't: it's framework-agnostic and still feeds
// the flat dashboard, the department cards, and OfficeDirectory).
export type OfficeMember = { personaId: string; name: string };
export type OfficeRoom = { id: string; name: string; color: string; members: OfficeMember[] };

// A job reshaped for the dashboard's task-status panel and department-card
// footers. `department` is a display NAME (not an id) since this type only
// ever renders, never filters, by department. `progressPct` is a coarse,
// documented heuristic (log entries vs. planned steps) for running jobs
// only — every other status shows elapsed/finished time instead, since
// there's no real numeric progress field on a Job to report honestly.
export type OfficeJobStatus = "pending" | "awaiting-approval" | "running" | "succeeded" | "failed" | "rejected" | "waiting_on_human";
export type OfficeJob = {
  id: string;
  title: string;
  status: OfficeJobStatus;
  personaId?: string;
  personaName?: string;
  department?: string;
  startedAt?: string;
  finishedAt?: string;
  stuck: boolean;
  progressPct: number | null;
};

export type OfficeStatusCounts = { doing: number; next: number; waiting: number; done: number; failed: number };
