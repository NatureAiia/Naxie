import { Router } from "express";
import {
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  nextFireAt,
  type Cadence,
  type ScheduleDelivery,
} from "../lib/schedules.js";
import { callerLayer } from "../lib/access.js";
import { isLocalMachineTask } from "../lib/task-restrictions.js";
import { saveCustomTemplate, slugify, type CustomTemplate } from "../lib/custom-templates.js";
import { randomUUID } from "node:crypto";

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

const ONCE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateCadence(c: any): { ok: true; cadence: Cadence } | { ok: false; error: string } {
  if (!c || typeof c !== "object") return { ok: false, error: "cadence is required" };
  const hour = Number(c.hour);
  const minute = Number(c.minute);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, error: "cadence.hour must be 0..23" };
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { ok: false, error: "cadence.minute must be 0..59" };
  // A one-off date wins over daysOfWeek — the Calendar popup's REPEAT toggle
  // decides which one it sends, never both.
  if (typeof c.once === "string" && c.once) {
    if (!ONCE_RE.test(c.once)) return { ok: false, error: "cadence.once must be YYYY-MM-DD" };
    return { ok: true, cadence: { daysOfWeek: [], hour, minute, once: c.once } };
  }
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

// Parse optional email and Telegram destination overrides. Telegram itself is
// delivered for every schedule, even when this block is absent.
function parseDeliver(raw: any): ScheduleDelivery | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  const telegramChatId = typeof raw.telegramChatId === "string" ? raw.telegramChatId.trim() : "";
  const parsed: ScheduleDelivery = {
    ...(email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { email } : {}),
    ...(telegramChatId ? { telegramChatId } : {}),
    ...(raw.voiceNote === true ? { voiceNote: true as const } : {}),
  };
  return Object.keys(parsed).length ? parsed : undefined;
}

function validTelegramDestination(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string") return false;
  const chatId = value.trim();
  return chatId.length <= 64 && (/^-?\d+$/.test(chatId) || /^@[A-Za-z0-9_]{5,32}$/.test(chatId));
}

// Parse an optional chainTo list — forgiving like parseDeliver: drop
// anything that isn't a string, isn't a real schedule id, or (PATCH only,
// via `selfId`) refers to the schedule being edited. This is cosmetic
// cleanliness, not the actual cycle guard — that's fireSchedule's `visited`
// set (schedules.ts), since a two-step A→B then separately B→A edit can't be
// caught at either edit's validation time.
function parseChainTo(raw: any, selfId?: string): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const validIds = new Set(listSchedules().map(s => s.id));
  const ids = raw.filter((x): x is string => typeof x === "string" && validIds.has(x) && x !== selfId);
  return ids.length > 0 ? ids : [];
}

// Create a schedule. Body: { name, templateId | task, inputs?, cadence: {daysOfWeek|once, hour, minute}, enabled?, deliver?: { email }, requireApproval? }
//
// `task` is a shortcut for the Calendar page's "just type a task" popup — no
// template picker there, matching the reference design. When present instead
// of `templateId`, we auto-create a hidden, empty-plan custom template from
// the text (same shape persona-derived starter templates use — see
// templates.ts's run handler: an empty plan re-plans fresh from origin.task
// every fire) and schedule that. `hidden: true` keeps it out of the general
// Templates gallery; it's still runnable/re-editable via its id like any
// other custom template.
schedulesRouter.post("/", (req, res) => {
  const { name, templateId, task, inputs, cadence: rawCadence, enabled, deliver, requireApproval, chainTo } = req.body ?? {};
  if (!guardScheduleMutation(req, res, inputs)) return;
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });
  if (!validTelegramDestination(deliver?.telegramChatId)) return res.status(400).json({ error: "deliver.telegramChatId must be a numeric Telegram chat/group ID or @channel username" });
  let resolvedTemplateId: string;
  if (typeof templateId === "string" && templateId) {
    resolvedTemplateId = templateId;
  } else if (typeof task === "string" && task.trim()) {
    const now = new Date().toISOString();
    const adhoc: CustomTemplate = {
      id: `custom-${slugify(name)}-${randomUUID().slice(0, 8)}`,
      role: "Custom",
      title: name.trim(),
      description: task.trim().slice(0, 300),
      origin: { task: task.trim(), createdAt: now },
      plan: { steps: [] },
      runCount: 0,
      hidden: true,
    };
    saveCustomTemplate(adhoc);
    resolvedTemplateId = adhoc.id;
  } else {
    return res.status(400).json({ error: "templateId or task is required" });
  }
  const v = validateCadence(rawCadence);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const fresh = createSchedule({
    name: name.trim(),
    templateId: resolvedTemplateId,
    inputs: inputs && typeof inputs === "object" ? inputs : {},
    cadence: v.cadence,
    enabled: enabled === false ? false : true,
    deliver: parseDeliver(deliver),
    requireApproval: requireApproval === true,
    chainTo: parseChainTo(chainTo),
  });
  res.json({ schedule: fresh });
});

// Patch a schedule (rename, change cadence, toggle enabled, swap inputs).
schedulesRouter.patch("/:id", (req, res) => {
  const existing = getSchedule(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  // Guard against a low-priv caller swapping in a local-machine task via inputs.
  if (!guardScheduleMutation(req, res, req.body?.inputs)) return;
  if ("deliver" in (req.body ?? {}) && !validTelegramDestination(req.body?.deliver?.telegramChatId)) return res.status(400).json({ error: "deliver.telegramChatId must be a numeric Telegram chat/group ID or @channel username" });
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
  if (typeof req.body?.requireApproval === "boolean") patch.requireApproval = req.body.requireApproval;
  if ("chainTo" in (req.body ?? {})) patch.chainTo = parseChainTo(req.body.chainTo, req.params.id);
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

// Fire a schedule RIGHT NOW, outside its cadence (the "Run now" button).
// Same pipeline as a cadence fire (requireApproval still parks the job);
// the job then runs on its normal cadence afterwards, unaffected.
schedulesRouter.post("/:id/fire", async (req, res) => {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    return res.status(403).json({ error: "Firing schedules requires admin access." });
  }
  const { fireScheduleNow } = await import("../lib/schedules.js");
  const r = await fireScheduleNow(req.params.id);
  if ("error" in r) {
    const code = r.error === "not found" ? 404 : r.error.startsWith("schedule is paused") ? 409 : 502;
    return res.status(code).json({ error: r.error });
  }
  res.json({ jobId: r.jobId });
});

// Recent runs of one schedule — jobs tagged scheduledBy === id, newest first.
// Merges live jobs with the persisted 30-day journal window.
schedulesRouter.get("/:id/runs", async (req, res) => {
  const s = getSchedule(req.params.id);
  if (!s) return res.status(404).json({ error: "not found" });
  try {
    const { listJobs } = await import("../lib/jobs.js");
    const { loadJobsInWindow } = await import("../lib/job-store.js");
    const seen = new Set<string>();
    const rows: { id: string; title: string; status: string; startedAt: string; finishedAt?: string }[] = [];
    const pick = (j: any) => {
      if (!j || j.scheduledBy !== req.params.id || seen.has(j.id)) return;
      seen.add(j.id);
      rows.push({ id: j.id, title: j.title ?? j.kind ?? j.id, status: j.status, startedAt: j.startedAt, ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}) });
    };
    listJobs().forEach(pick);
    const windowStart = Date.now() - 30 * 24 * 60 * 60_000;
    loadJobsInWindow(windowStart, Date.now() + 60_000).forEach(pick);
    rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    res.json({ runs: rows.slice(0, 20) });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
