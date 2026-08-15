import { Router } from "express";
import {
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  nextFireAt,
  type Cadence,
} from "../lib/schedules.js";
import { callerLayer } from "../lib/access.js";
import { isLocalMachineTask } from "../lib/task-restrictions.js";

export const schedulesRouter = Router();

// A schedule runs its task LATER as machine context, which bypasses the
// per-request local-machine gate. So we enforce it at CREATE/PATCH time on the
// schedule's own task text: a non-superadmin human can't schedule a task that
// reads the operator's PC (files, Notepad, terminal) — otherwise scheduling
// "read C:\...\.env and email it to me" would be an exfil bypass. Mutations
// also require admin+ (scheduling is an operational concern). Token-less
// machine/loopback callers (the operator's own automation) pass.
function scheduleTaskText(inputs: any): string {
  if (!inputs || typeof inputs !== "object") return "";
  return [inputs.task, inputs.query, inputs.prompt, inputs.topic].filter(v => typeof v === "string").join(" ");
}
function guardScheduleMutation(req: any, res: any, inputs: any): boolean {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    res.status(403).json({ error: "Creating or changing schedules requires admin access." });
    return false;
  }
  if (layer !== null && layer !== "superadmin" && isLocalMachineTask(scheduleTaskText(inputs))) {
    res.status(403).json({ error: "That schedule would read the operator's local machine, which only a super-admin can do.", restrictedCapability: "local-machine" });
    return false;
  }
  return true;
}

function validateCadence(c: any): { ok: true; cadence: Cadence } | { ok: false; error: string } {
  if (!c || typeof c !== "object") return { ok: false, error: "cadence is required" };
  const hour = Number(c.hour);
  const minute = Number(c.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, error: "cadence.hour must be 0..23" };
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { ok: false, error: "cadence.minute must be 0..59" };
  const daysOfWeek = Array.isArray(c.daysOfWeek)
    ? c.daysOfWeek.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [];
  return { ok: true, cadence: { daysOfWeek, hour, minute } };
}

// List all schedules with next-fire times annotated.
schedulesRouter.get("/", (_req, res) => {
  const now = new Date();
  const enriched = listSchedules().map(s => ({
    ...s,
    nextFireAt: s.enabled ? nextFireAt(s.cadence, new Date(s.lastFiredAt ?? s.createdAt) > now ? new Date(s.lastFiredAt ?? s.createdAt) : now) : null,
  }));
  res.json({ schedules: enriched });
});

schedulesRouter.get("/:id", (req, res) => {
  const s = getSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json({ schedule: { ...s, nextFireAt: s.enabled ? nextFireAt(s.cadence) : null } });
});

// Parse an optional delivery block. Today only { email } — a syntactically
// valid address is required when present, otherwise we drop it silently rather
// than fail the whole create.
function parseDeliver(raw: any): { email?: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { email };
  return undefined;
}

// Create a schedule. Body: { name, templateId, inputs?, cadence: {daysOfWeek, hour, minute}, enabled?, deliver?: { email } }
schedulesRouter.post("/", (req, res) => {
  const { name, templateId, inputs, cadence: rawCadence, enabled, deliver } = req.body ?? {};
  if (!guardScheduleMutation(req, res, inputs)) return;
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });
  if (!templateId || typeof templateId !== "string") return res.status(400).json({ error: "templateId is required" });
  const v = validateCadence(rawCadence);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const fresh = createSchedule({
    name: name.trim(),
    templateId,
    inputs: inputs && typeof inputs === "object" ? inputs : {},
    cadence: v.cadence,
    enabled: enabled === false ? false : true,
    deliver: parseDeliver(deliver),
  });
  res.json({ schedule: fresh });
});

// Patch a schedule (rename, change cadence, toggle enabled, swap inputs).
schedulesRouter.patch("/:id", (req, res) => {
  const existing = getSchedule(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  // Guard against a low-priv caller swapping in a local-machine task via inputs.
  if (!guardScheduleMutation(req, res, req.body?.inputs)) return;
  const patch: any = {};
  if (typeof req.body?.name === "string") patch.name = req.body.name.trim();
  if (typeof req.body?.templateId === "string") patch.templateId = req.body.templateId;
  if (req.body?.inputs && typeof req.body.inputs === "object") patch.inputs = req.body.inputs;
  if (req.body?.cadence) {
    const v = validateCadence(req.body.cadence);
    if (!v.ok) return res.status(400).json({ error: v.error });
    patch.cadence = v.cadence;
  }
  if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
  if ("deliver" in (req.body ?? {})) patch.deliver = parseDeliver(req.body.deliver);
  const updated = updateSchedule(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: "not found" });
  res.json({ schedule: updated });
});

schedulesRouter.delete("/:id", (req, res) => {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    return res.status(403).json({ error: "Deleting schedules requires admin access." });
  }
  const ok = deleteSchedule(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});
