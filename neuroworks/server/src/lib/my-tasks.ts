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

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const CONFIG_PATH = resolve(CONFIG_DIR, "my-tasks.json");

export type TaskStep = { id: string; title: string; done: boolean };

export type RepeatRule = { freq: "daily" | "weekly" | "monthly"; interval: number };

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
