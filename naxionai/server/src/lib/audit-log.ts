import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "../config.js";

export type AuditEvent = {
  id: string;
  ts: string;
  level: "info" | "warn" | "error";
  actor: string;
  action: string;
  target: string;
  detail: string;
  jobId?: string;
  result: "success" | "failure" | "pending";
};

const AUDIT_REL = "_naxion/audit.jsonl";

function auditPath(): string {
  return resolve(config.vaultPath, AUDIT_REL);
}

let seq = 0;

export function logAudit(event: Omit<AuditEvent, "id" | "ts">): AuditEvent {
  const full = auditPath();
  try { mkdirSync(join(full, ".."), { recursive: true }); } catch { /* tolerate */ }
  seq++;
  const record: AuditEvent = {
    ...event,
    id: `${Date.now().toString(36)}-${seq}`,
    ts: new Date().toISOString(),
  };
  appendFileSync(full, JSON.stringify(record) + "\n", "utf8");
  return record;
}

export function queryAudit(opts?: {
  limit?: number;
  offset?: number;
  level?: string;
  actor?: string;
  action?: string;
  role?: string;
  since?: string;
  jobId?: string;
}): { events: AuditEvent[]; total: number } {
  const full = auditPath();
  const empty = { events: [], total: 0 };
  if (!existsSync(full)) return empty;
  try {
    const lines = readFileSync(full, "utf8").trim().split("\n").filter(Boolean);
    let events: AuditEvent[] = lines.map(l => JSON.parse(l));
    if (opts?.level) events = events.filter(e => e.level === opts.level);
    if (opts?.actor) events = events.filter(e => e.actor.toLowerCase().includes(opts.actor!.toLowerCase()));
    if (opts?.action) events = events.filter(e => e.action.toLowerCase().includes(opts.action!.toLowerCase()));
    // Exact match on actor + org_task.* action prefix — deliberately not a
    // substring match like `actor` above, because schedules.ts also writes
    // audit events with actor==="scheduler" for unrelated tick-firing events,
    // and "scheduler" is also an OrgRole value. Exact match + action prefix
    // keeps this role filter scoped to org-task events only.
    if (opts?.role) events = events.filter(e => e.actor === opts.role && e.action.startsWith("org_task."));
    if (opts?.jobId) events = events.filter(e => e.jobId === opts.jobId);
    if (opts?.since) {
      const sinceTs = new Date(opts.since).getTime();
      events = events.filter(e => new Date(e.ts).getTime() >= sinceTs);
    }
    events.sort((a, b) => b.ts.localeCompare(a.ts));
    const total = events.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return { events: events.slice(offset, offset + limit), total };
  } catch {
    return empty;
  }
}
