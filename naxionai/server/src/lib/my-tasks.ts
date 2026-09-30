// Personal to-do list — Microsoft To Do-style, but native and offline (no
// external account, no OAuth, no paid tier). Persisted at
// .neuroworks/my-tasks.json, scoped per operator by ownerEmail (routes pass
// callerOf(req)?.email ?? "local" so a single-operator shell with no login
// configured still works out of the box).
//
// Deliberately separate from the "Tasks" page (routes/tasks.ts, jobs.ts) —
// that page is the agent job queue ("everything the workforce is doing");
// this is the operator's OWN task list, unrelated to agent work.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { nextFireAt, type Cadence, type ScheduleDelivery } from "./schedules.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const CONFIG_PATH = resolve(CONFIG_DIR, "my-tasks.json");

export type TaskStep = { id: string; title: string; done: boolean };

export type RepeatRule = { freq: "daily" | "weekly" | "monthly"; interval: number };

// Absorbed from the retired lib/workflow-tree.ts (Phase 0 tree engine, never
// armed by default and only ever wired to one daemon — todo-brief). Rather
// than a separate vault-file tree, an automation is just a bolt-on to a
// regular planner task: the same item the operator sees and can pause/edit
// in Planner IS the schedule, tool allowlist and run history. `native:<name>`
// is the only handler kind (the tree's unused "template:" path — planned for
// planAndExecute(body, {toolAllowlist}) but never wired up — is dropped here;
// a later pass can add it back onto this same field if it's actually needed).
//
// "planner" is that later pass: dispatches the item's own title+notes
// through planAndExecute with its automation.tools as a hard allowlist —
// what makes spawnSubtask's children (below) actually executable, not just
// inert records.
export type TaskHandler = `native:${string}` | "planner";

export type TaskAutomation = {
  enabled: boolean;
  cadence?: Cadence;        // absent = on-demand only (never auto-fires, "Run now" still works)
  tools: string[];
  data: string[];
  outputPath?: string;
  deliver?: ScheduleDelivery;
  handler?: TaskHandler;
  lastFiredAt?: string;
  lastError?: string;
  fireCount: number;
};

export type TaskItem = {
  id: string;
  listId: string;
  ownerEmail: string;
  title: string;
  notes?: string;
  steps: TaskStep[];
  dueDate?: string;       // YYYY-MM-DD
  reminderAt?: string;    // ISO datetime
  repeat?: RepeatRule | null;
  important: boolean;
  myDay?: string;         // YYYY-MM-DD this item was added to "My Day" — cleared on toggle, not auto-expired (mirrors MS To Do's manual re-add-each-day pattern without needing a cron)
  completed: boolean;
  completedAt?: string;
  createdAt: string;
  order: number;
  // Present only on tasks the operator has turned into a scheduled
  // automation (see TaskAutomation above) — absent on every plain to-do.
  automation?: TaskAutomation;
  // Present only on a task spawned by spawnSubtask() below — absent on
  // every task the operator created directly. Parent is folder-nesting's
  // flat-store equivalent: no separate tree, just this one id.
  parentId?: string;
};

export type TaskList = {
  id: string;
  ownerEmail: string;
  name: string;
  color?: string;
  order: number;
  createdAt: string;
};

type Store = { lists: TaskList[]; items: TaskItem[] };

function load(): Store {
  try {
    if (!existsSync(CONFIG_PATH)) return { lists: [], items: [] };
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { lists: Array.isArray(parsed?.lists) ? parsed.lists : [], items: Array.isArray(parsed?.items) ? parsed.items : [] };
  } catch { return { lists: [], items: [] }; }
}

function save(store: Store): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

function ensureDefaultList(store: Store, ownerEmail: string): TaskList {
  const existing = store.lists.find(l => l.ownerEmail === ownerEmail);
  if (existing) return existing;
  const list: TaskList = { id: randomUUID(), ownerEmail, name: "Tasks", order: 0, createdAt: new Date().toISOString() };
  store.lists.push(list);
  save(store);
  return list;
}

export function listLists(ownerEmail: string): TaskList[] {
  const store = load();
  ensureDefaultList(store, ownerEmail);
  return store.lists.filter(l => l.ownerEmail === ownerEmail).sort((a, b) => a.order - b.order);
}

export function addList(ownerEmail: string, name: string): TaskList {
  const store = load();
  const order = store.lists.filter(l => l.ownerEmail === ownerEmail).length;
  const list: TaskList = { id: randomUUID(), ownerEmail, name: name.trim() || "New list", order, createdAt: new Date().toISOString() };
  store.lists.push(list);
  save(store);
  return list;
}

export function renameList(ownerEmail: string, id: string, name: string): TaskList | null {
  const store = load();
  const list = store.lists.find(l => l.id === id && l.ownerEmail === ownerEmail);
  if (!list) return null;
  list.name = name.trim() || list.name;
  save(store);
  return list;
}

export function removeList(ownerEmail: string, id: string): boolean {
  const store = load();
  const before = store.lists.length;
  store.lists = store.lists.filter(l => !(l.id === id && l.ownerEmail === ownerEmail));
  if (store.lists.length === before) return false;
  store.items = store.items.filter(i => !(i.listId === id && i.ownerEmail === ownerEmail));
  save(store);
  return true;
}

export type ItemFilter = { listId?: string; myDayOn?: string; important?: boolean; completed?: boolean };

export function listItems(ownerEmail: string, filter: ItemFilter = {}): TaskItem[] {
  const store = load();
  let items = store.items.filter(i => i.ownerEmail === ownerEmail);
  if (filter.listId) items = items.filter(i => i.listId === filter.listId);
  if (filter.myDayOn) items = items.filter(i => i.myDay === filter.myDayOn);
  if (filter.important !== undefined) items = items.filter(i => i.important === filter.important);
  if (filter.completed !== undefined) items = items.filter(i => i.completed === filter.completed);
  return items.sort((a, b) => a.order - b.order);
}

export function addItem(ownerEmail: string, input: {
  listId?: string; title: string; notes?: string; dueDate?: string; reminderAt?: string;
  repeat?: RepeatRule | null; important?: boolean; myDay?: boolean;
}): TaskItem {
  const store = load();
  const listId = input.listId || ensureDefaultList(store, ownerEmail).id;
  const order = store.items.filter(i => i.ownerEmail === ownerEmail && i.listId === listId).length;
  const today = new Date().toISOString().slice(0, 10);
  const item: TaskItem = {
    id: randomUUID(), listId, ownerEmail,
    title: String(input.title ?? "").trim() || "Untitled task",
    notes: input.notes ? String(input.notes) : undefined,
    steps: [],
    dueDate: input.dueDate || undefined,
    reminderAt: input.reminderAt || undefined,
    repeat: input.repeat ?? null,
    important: input.important === true,
    myDay: input.myDay ? today : undefined,
    completed: false,
    createdAt: new Date().toISOString(),
    order,
  };
  store.items.push(item);
  save(store);
  return item;
}

export function updateItem(ownerEmail: string, id: string, patch: Partial<Pick<TaskItem,
  "title" | "notes" | "dueDate" | "reminderAt" | "repeat" | "important" | "listId"
>>): TaskItem | null {
  const store = load();
  const item = store.items.find(i => i.id === id && i.ownerEmail === ownerEmail);
  if (!item) return null;
  if (patch.title !== undefined) item.title = String(patch.title).trim() || item.title;
  if (patch.notes !== undefined) item.notes = patch.notes ? String(patch.notes) : undefined;
  if (patch.dueDate !== undefined) item.dueDate = patch.dueDate || undefined;
  if (patch.reminderAt !== undefined) item.reminderAt = patch.reminderAt || undefined;
  if (patch.repeat !== undefined) item.repeat = patch.repeat;
  if (patch.important !== undefined) item.important = patch.important === true;
  if (patch.listId !== undefined && store.lists.some(l => l.id === patch.listId && l.ownerEmail === ownerEmail)) item.listId = patch.listId;
  save(store);
  return item;
}

export function removeItem(ownerEmail: string, id: string): boolean {
  const store = load();
  const before = store.items.length;
  store.items = store.items.filter(i => !(i.id === id && i.ownerEmail === ownerEmail));
  if (store.items.length === before) return false;
  save(store);
  return true;
}

// Advance a YYYY-MM-DD date by a repeat rule. Month-end overflow (e.g. Jan 31
// + 1 month) clamps to the last valid day of the target month, same behavior
// most calendar apps use rather than silently rolling into the month after.
function advanceDate(dateStr: string, rule: RepeatRule): string {
  const d = new Date(dateStr + "T12:00:00");
  if (rule.freq === "daily") d.setDate(d.getDate() + rule.interval);
  else if (rule.freq === "weekly") d.setDate(d.getDate() + rule.interval * 7);
  else {
    const targetMonth = d.getMonth() + rule.interval;
    const probe = new Date(d.getFullYear(), targetMonth + 1, 0); // last day of target month
    d.setFullYear(probe.getFullYear(), probe.getMonth(), Math.min(d.getDate(), probe.getDate()));
  }
  return d.toISOString().slice(0, 10);
}

// Toggling a repeating task complete doesn't mark it done — it rolls the due
// date forward and stays open, matching Microsoft To Do's recurring-task
// behavior (the series never "completes", each occurrence just resets).
export function toggleItem(ownerEmail: string, id: string): TaskItem | null {
  const store = load();
  const item = store.items.find(i => i.id === id && i.ownerEmail === ownerEmail);
  if (!item) return null;
  if (!item.completed && item.repeat && item.dueDate) {
    item.dueDate = advanceDate(item.dueDate, item.repeat);
    item.steps = item.steps.map(s => ({ ...s, done: false }));
  } else {
    item.completed = !item.completed;
    item.completedAt = item.completed ? new Date().toISOString() : undefined;
  }
  save(store);
  return item;
}

export function setMyDay(ownerEmail: string, id: string, on: boolean): TaskItem | null {
  const store = load();
  const item = store.items.find(i => i.id === id && i.ownerEmail === ownerEmail);
  if (!item) return null;
  item.myDay = on ? new Date().toISOString().slice(0, 10) : undefined;
  save(store);
  return item;
}

export function addStep(ownerEmail: string, itemId: string, title: string): TaskItem | null {
  const store = load();
  const item = store.items.find(i => i.id === itemId && i.ownerEmail === ownerEmail);
  if (!item) return null;
  item.steps.push({ id: randomUUID(), title: title.trim() || "Step", done: false });
  save(store);
  return item;
}

export function toggleStep(ownerEmail: string, itemId: string, stepId: string): TaskItem | null {
  const store = load();
  const item = store.items.find(i => i.id === itemId && i.ownerEmail === ownerEmail);
  if (!item) return null;
  const step = item.steps.find(s => s.id === stepId);
  if (!step) return null;
  step.done = !step.done;
  save(store);
  return item;
}

export function removeStep(ownerEmail: string, itemId: string, stepId: string): TaskItem | null {
  const store = load();
  const item = store.items.find(i => i.id === itemId && i.ownerEmail === ownerEmail);
  if (!item) return null;
  item.steps = item.steps.filter(s => s.id !== stepId);
  save(store);
  return item;
}

// ─── automation (absorbed from lib/workflow-tree.ts) ───────────────────────
// Turns a regular planner task into a scheduled/on-demand job the tick loop
// below can fire. Unlike the rest of this file, these operate across ALL
// owners by id — the tick has no request/caller context, and an admin
// managing automations may not be the item's own owner.

function findItemById(id: string): { store: Store; item: TaskItem } | null {
  const store = load();
  const item = store.items.find(i => i.id === id);
  return item ? { store, item } : null;
}

export function getAutomationItem(id: string): TaskItem | null {
  return findItemById(id)?.item ?? null;
}

// Merge-patches automation fields onto an item, creating `automation` (with
// fireCount 0) on first use. Only fields the caller actually sent survive
// the merge — same "undefined never overwrites" rule as updateItem above.
export function setAutomation(id: string, patch: Partial<Omit<TaskAutomation, "lastFiredAt" | "lastError" | "fireCount">>): TaskItem | null {
  const found = findItemById(id);
  if (!found) return null;
  const { store, item } = found;
  const base: TaskAutomation = item.automation ?? { enabled: true, tools: [], data: [], fireCount: 0 };
  const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  item.automation = { ...base, ...definedPatch };
  save(store);
  return item;
}

export function removeAutomation(id: string): TaskItem | null {
  const found = findItemById(id);
  if (!found) return null;
  const { store, item } = found;
  delete item.automation;
  save(store);
  return item;
}

export function getAutomationStatus(item: TaskItem): { lastFiredAt?: string; lastError?: string; nextFireAt: number | null } {
  const a = item.automation;
  if (!a) return { nextFireAt: null };
  const nextFireAt_ = a.cadence ? nextFireAt(a.cadence, a.lastFiredAt ? new Date(a.lastFiredAt) : new Date(0)) : null;
  return { lastFiredAt: a.lastFiredAt, lastError: a.lastError, nextFireAt: nextFireAt_ };
}

// Scans every owner's items for one with an active automation — the tick
// loop and the admin "all automations" listing both need this cross-owner
// view; every other function in this file is intentionally owner-scoped.
export function listAllAutomations(): TaskItem[] {
  return load().items.filter(i => !!i.automation);
}

// Phase 0's dispatch path, unchanged from workflow-tree.ts: a static
// registry of existing run<X>() functions, registered by index.ts at boot
// (avoids a static import cycle between this leaf module and the daemons).
type NativeHandler = () => Promise<unknown>;
const NATIVE_HANDLERS = new Map<string, NativeHandler>();

export function registerNativeHandler(name: string, fn: NativeHandler): void {
  NATIVE_HANDLERS.set(name, fn);
}

function recordFire(id: string, ok: boolean, error?: string): void {
  const found = findItemById(id);
  if (!found) return;
  const { store, item } = found;
  if (!item.automation) return;
  item.automation.lastFiredAt = new Date().toISOString();
  item.automation.fireCount += 1;
  item.automation.lastError = ok ? undefined : error;
  save(store);
}

export async function runAutomation(id: string): Promise<{ ok: boolean; error?: string; answer?: string }> {
  const item = getAutomationItem(id);
  if (!item?.automation) return { ok: false, error: "task has no automation configured" };
  const handler = item.automation.handler;
  if (!handler) return { ok: false, error: `automation on "${item.title}" has no handler` };
  if (handler === "planner") {
    const { planAndExecute } = await import("./agent.js");
    const { runInTaskScope } = await import("./task-scope.js");
    const taskText = item.notes ? `${item.title}\n\n${item.notes}` : item.title;
    try {
      const result = await runInTaskScope(item.id, () =>
        planAndExecute(taskText, () => {}, undefined, { toolAllowlist: item.automation!.tools, scopeId: item.id }),
      );
      recordFire(id, true);
      return { ok: true, answer: result.answer };
    } catch (e: any) {
      const error = String(e?.message ?? e);
      recordFire(id, false, error);
      return { ok: false, error };
    }
  }
  const name = handler.slice("native:".length);
  const fn = NATIVE_HANDLERS.get(name);
  if (!fn) return { ok: false, error: `no native handler registered for "${name}"` };
  try { await fn(); recordFire(id, true); return { ok: true }; }
  catch (e: any) { const error = String(e?.message ?? e); recordFire(id, false, error); return { ok: false, error }; }
}

// ─── scoped sub-tasks ───────────────────────────────────────────────────
// A task can spawn a narrower child task, dispatched independently via the
// "planner" handler above. The parent must itself be an automation-backed
// item (only those carry a tools/data scope to narrow from) — this is what
// guarantees a child's effective scope is never wider than its parent's:
// a requested tool/data path not already in the parent's own scope is
// silently dropped, never added, and an empty result after filtering a
// non-empty request is reported as an error rather than silently falling
// back to "everything."

export type SpawnSubtaskInput = { title: string; notes?: string; tools?: string[]; data?: string[] };

export function spawnSubtask(parentId: string, input: SpawnSubtaskInput): { item: TaskItem } | { error: string } {
  const found = findItemById(parentId);
  if (!found) return { error: `parent task "${parentId}" not found` };
  const { store, item: parent } = found;
  const parentScope = parent.automation;
  if (!parentScope) {
    return { error: `"${parent.title}" has no automation scope to narrow from — only an automation-backed task can spawn a scoped sub-task` };
  }

  const tools = input.tools && input.tools.length > 0
    ? input.tools.filter(t => parentScope.tools.includes(t))
    : [...parentScope.tools];
  if (input.tools && input.tools.length > 0 && tools.length === 0) {
    return { error: `none of the requested tools are within the parent task's own scope (${parentScope.tools.join(", ") || "none"})` };
  }

  const data = input.data && input.data.length > 0
    ? input.data.filter(d => parentScope.data.some(pd => d === pd || d.startsWith(pd)))
    : [...parentScope.data];

  const order = store.items.filter(i => i.ownerEmail === parent.ownerEmail && i.listId === parent.listId).length;
  const child: TaskItem = {
    id: randomUUID(), listId: parent.listId, ownerEmail: parent.ownerEmail,
    title: String(input.title ?? "").trim() || "Subtask",
    notes: input.notes ? String(input.notes) : undefined,
    steps: [], important: false, completed: false,
    createdAt: new Date().toISOString(), order,
    parentId: parent.id,
    automation: { enabled: true, tools, data, handler: "planner", fireCount: 0 },
  };
  store.items.push(child);
  save(store);
  return { item: child };
}

/** Every task spawned (directly) from `parentId`, in creation order. */
export function listChildren(parentId: string): TaskItem[] {
  return load().items.filter(i => i.parentId === parentId).sort((a, b) => a.order - b.order);
}

// Seeds one automation-backed task if a task with this exact title doesn't
// already exist for this owner — mirrors workflow-tree.ts's
// seedNodeIfMissing so a fresh install gets a sensible default without ever
// clobbering an operator's own edits on every boot.
export function seedAutomationIfMissing(ownerEmail: string, title: string, automation: Omit<TaskAutomation, "lastFiredAt" | "lastError" | "fireCount">, notes?: string): void {
  const store = load();
  if (store.items.some(i => i.ownerEmail === ownerEmail && i.title === title && i.automation)) return;
  const listId = ensureDefaultList(store, ownerEmail).id;
  const order = store.items.filter(i => i.ownerEmail === ownerEmail && i.listId === listId).length;
  const item: TaskItem = {
    id: randomUUID(), listId, ownerEmail, title, notes, steps: [],
    important: false, completed: false, createdAt: new Date().toISOString(), order,
    automation: { ...automation, fireCount: 0 },
  };
  store.items.push(item);
  save(store);
}

let scheduler: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const now = new Date();
  for (const item of listAllAutomations()) {
    const a = item.automation!;
    if (!a.enabled || !a.cadence) continue;
    const from = a.lastFiredAt ? new Date(a.lastFiredAt) : new Date(now.getTime() - 25 * 3600_000);
    const due = nextFireAt(a.cadence, from);
    if (due === null || due > now.getTime()) continue;
    console.log(`[my-tasks] firing automation "${item.title}" (handler=${a.handler ?? "none"})`);
    await runAutomation(item.id);
  }
}

export function isAutomationEngineArmed(): boolean {
  return scheduler !== null;
}

export function startTaskAutomationScheduler(): void {
  if (scheduler) return;
  scheduler = setInterval(() => { void tick(); }, 10 * 60_000);
  scheduler.unref?.();
  void tick();
}

export function stopTaskAutomationScheduler(): void {
  if (scheduler) { clearInterval(scheduler); scheduler = null; }
}

export function _resetForTests(): void {
  stopTaskAutomationScheduler();
  NATIVE_HANDLERS.clear();
}
