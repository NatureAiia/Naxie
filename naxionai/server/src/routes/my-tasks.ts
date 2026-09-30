import { Router } from "express";
import { callerOf, callerLayer } from "../lib/access.js";
import {
  listLists, addList, renameList, removeList,
  listItems, addItem, updateItem, removeItem, toggleItem, setMyDay,
  addStep, toggleStep, removeStep,
  getAutomationItem, setAutomation, removeAutomation, getAutomationStatus,
  runAutomation, listAllAutomations, isAutomationEngineArmed,
} from "../lib/my-tasks.js";
import { primitives } from "../lib/primitives.js";

// The operator's own personal to-do list (Microsoft To Do-style: lists,
// sub-steps, due date, reminder, repeat, importance, "My Day"). Native and
// offline — no external account. Distinct from /api/tasks, which is the
// agent JOB queue, not personal tasks.
//
// Scoped per caller: a logged-in session's email owns its own lists/items; a
// token-less caller (single-operator shell with no login configured) falls
// back to a shared "local" owner so the feature works with zero setup.

export const myTasksRouter = Router();

function ownerOf(req: any): string {
  return callerOf(req)?.email?.trim().toLowerCase() || "local";
}

myTasksRouter.get("/lists", (req, res) => {
  res.json({ lists: listLists(ownerOf(req)) });
});

myTasksRouter.post("/lists", (req, res) => {
  const name = String((req.body ?? {}).name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  res.json({ list: addList(ownerOf(req), name) });
});

myTasksRouter.patch("/lists/:id", (req, res) => {
  const l = renameList(ownerOf(req), String(req.params.id), String((req.body ?? {}).name ?? ""));
  if (!l) return res.status(404).json({ error: "list not found" });
  res.json({ list: l });
});

myTasksRouter.delete("/lists/:id", (req, res) => {
  const ok = removeList(ownerOf(req), String(req.params.id));
  if (!ok) return res.status(404).json({ error: "list not found" });
  res.json({ ok: true });
});

// GET /api/my-tasks/items?listId=&myDay=1&important=1&completed=0
myTasksRouter.get("/items", (req, res) => {
  const q = req.query as Record<string, string>;
  const owner = ownerOf(req);
  const filter: Parameters<typeof listItems>[1] = {};
  if (q.listId) filter.listId = String(q.listId);
  if (q.myDay === "1") filter.myDayOn = new Date().toISOString().slice(0, 10);
  if (q.important === "1") filter.important = true;
  if (q.completed !== undefined) filter.completed = q.completed === "1";
  res.json({ items: listItems(owner, filter) });
});

myTasksRouter.post("/items", (req, res) => {
  const b = req.body ?? {};
  if (!String(b.title ?? "").trim()) return res.status(400).json({ error: "title is required" });
  res.json({ item: addItem(ownerOf(req), b) });
});

myTasksRouter.patch("/items/:id", (req, res) => {
  const item = updateItem(ownerOf(req), String(req.params.id), req.body ?? {});
  if (!item) return res.status(404).json({ error: "task not found" });
  res.json({ item });
});

myTasksRouter.delete("/items/:id", (req, res) => {
  const ok = removeItem(ownerOf(req), String(req.params.id));
  if (!ok) return res.status(404).json({ error: "task not found" });
  res.json({ ok: true });
});

myTasksRouter.post("/items/:id/toggle", (req, res) => {
  const item = toggleItem(ownerOf(req), String(req.params.id));
  if (!item) return res.status(404).json({ error: "task not found" });
  res.json({ item });
});

myTasksRouter.post("/items/:id/my-day", (req, res) => {
  const on = (req.body ?? {}).on !== false;
  const item = setMyDay(ownerOf(req), String(req.params.id), on);
  if (!item) return res.status(404).json({ error: "task not found" });
  res.json({ item });
});

myTasksRouter.post("/items/:id/steps", (req, res) => {
  const title = String((req.body ?? {}).title ?? "").trim();
  if (!title) return res.status(400).json({ error: "title is required" });
  const item = addStep(ownerOf(req), String(req.params.id), title);
  if (!item) return res.status(404).json({ error: "task not found" });
  res.json({ item });
});

myTasksRouter.patch("/items/:id/steps/:stepId", (req, res) => {
  const item = toggleStep(ownerOf(req), String(req.params.id), String(req.params.stepId));
  if (!item) return res.status(404).json({ error: "task or step not found" });
  res.json({ item });
});

myTasksRouter.delete("/items/:id/steps/:stepId", (req, res) => {
  const item = removeStep(ownerOf(req), String(req.params.id), String(req.params.stepId));
  if (!item) return res.status(404).json({ error: "task not found" });
  res.json({ item });
});

// ─── automation (absorbed from routes/workflow-tree.ts) ────────────────────
// Turning a planner task into a scheduled job is the same trust level as
// Settings > System Access, so writes are admin-gated; reads stay open so
// the Planner UI can render an item's automation status for any signed-in
// caller (mirrors workflow-tree's own read/write split).
function requireAdmin(req: any, res: any): boolean {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    res.status(403).json({ error: "Managing task automations requires admin access." });
    return false;
  }
  return true;
}

// The full primitive catalog for the "tools this automation may call" picker
// — unfiltered by any allowlist, unlike GET /api/primitives (MCP-bridge scoped).
myTasksRouter.get("/automations/tool-catalog", (_req, res) => {
  res.json({ tools: primitives.map(p => ({ name: p.name, description: p.description, readonly: p.readonly })) });
});

// All automations across every owner, for an admin overview — a single
// operator's Planner shows their own, but nothing stops an admin session
// from seeing the full picture the way workflow-tree's page did.
myTasksRouter.get("/automations", (_req, res) => {
  const items = listAllAutomations();
  res.json({ items: items.map(i => ({ ...i, automationStatus: getAutomationStatus(i) })), engineArmed: isAutomationEngineArmed() });
});

myTasksRouter.patch("/items/:id/automation", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { enabled, cadence, tools, data, outputPath, deliver, handler } = req.body ?? {};
  const item = setAutomation(String(req.params.id), { enabled, cadence, tools, data, outputPath, deliver, handler });
  if (!item) return res.status(404).json({ error: "task not found" });
  res.json({ item, automationStatus: getAutomationStatus(item) });
});

myTasksRouter.delete("/items/:id/automation", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const item = removeAutomation(String(req.params.id));
  if (!item) return res.status(404).json({ error: "task not found" });
  res.json({ item });
});

// Fire an automation right now, bypassing its cadence — same effect as the
// tick loop firing it, so "Run now" always exercises the exact real path.
myTasksRouter.post("/items/:id/automation/run", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = String(req.params.id);
  const item = getAutomationItem(id);
  if (!item?.automation) return res.status(404).json({ error: "task has no automation configured" });
  const result = await runAutomation(id);
  const after = getAutomationItem(id)!;
  if (!result.ok) return res.status(502).json({ error: result.error ?? "unknown error", item: after });
  res.json({ item: after, automationStatus: getAutomationStatus(after) });
});
