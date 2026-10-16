// Two-way sync between my-tasks.ts and Google Tasks / Microsoft To Do, for
// lists the operator explicitly opted in (TaskList.syncExternal — opt-in per
// list, never automatic, so a local list stays private unless asked).
//
// Scope, stated plainly: this reconciles TITLE, NOTES, DUE DATE and
// COMPLETION state. It does not merge conflicting concurrent edits to the
// same field on both sides — "pull" always reflects the external service's
// current value onto the local mirror, and "push" only (a) creates a
// brand-new local item on the external service once, tagging it with the
// returned id, and (b) marks an external task complete when its local mirror
// is completed. A local edit to an already-mirrored item's title/notes/due
// date is NOT pushed out in this version — only completion and brand-new
// items flow local-to-external. That covers "add a task here, see it on your
// phone" and "complete it on your phone, see it done here" without the much
// harder field-level conflict resolution a full two-way editor would need.

import { registerEngine, unregisterEngine } from "./scheduler-registry.js";
import { getValidAccessTokens } from "./oauth-connectors.js";
import {
  listSyncedLists, listItems, findItemByExternalId, addExternalItem, applyExternalUpdate, tagExternalId,
  type TaskList,
} from "./my-tasks.js";

type ExternalTask = { id: string; title: string; notes?: string; due?: string; completed: boolean };

// ─── Google Tasks (tasks.googleapis.com) ───────────────────────────────────

async function fetchGoogleTasks(token: string, listId: string): Promise<ExternalTask[]> {
  const r = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks?showCompleted=true&showHidden=true`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Google Tasks list failed (${r.status})`);
  const data: any = await r.json();
  return (data.items ?? []).map((t: any) => ({
    id: t.id, title: t.title ?? "Untitled task", notes: t.notes,
    due: t.due ? String(t.due).slice(0, 10) : undefined,
    completed: t.status === "completed",
  }));
}

async function createGoogleTask(token: string, listId: string, task: { title: string; notes?: string; due?: string }): Promise<string> {
  const r = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ title: task.title, notes: task.notes, due: task.due ? `${task.due}T00:00:00.000Z` : undefined }),
  });
  if (!r.ok) throw new Error(`Google Tasks create failed (${r.status})`);
  const data: any = await r.json();
  return data.id;
}

async function completeGoogleTask(token: string, listId: string, taskId: string): Promise<void> {
  const r = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "completed" }),
  });
  if (!r.ok) throw new Error(`Google Tasks complete failed (${r.status})`);
}

// ─── Microsoft To Do (Graph /me/todo) ──────────────────────────────────────

async function fetchMicrosoftTasks(token: string, listId: string): Promise<ExternalTask[]> {
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Microsoft To Do list failed (${r.status})`);
  const data: any = await r.json();
  return (data.value ?? []).map((t: any) => ({
    id: t.id, title: t.title ?? "Untitled task", notes: t.body?.content || undefined,
    due: t.dueDateTime?.dateTime ? String(t.dueDateTime.dateTime).slice(0, 10) : undefined,
    completed: t.status === "completed",
  }));
}

async function createMicrosoftTask(token: string, listId: string, task: { title: string; notes?: string; due?: string }): Promise<string> {
  const body: any = { title: task.title };
  if (task.notes) body.body = { content: task.notes, contentType: "text" };
  if (task.due) body.dueDateTime = { dateTime: `${task.due}T00:00:00`, timeZone: "UTC" };
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Microsoft To Do create failed (${r.status})`);
  const data: any = await r.json();
  return data.id;
}

async function completeMicrosoftTask(token: string, listId: string, taskId: string): Promise<void> {
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "completed" }),
  });
  if (!r.ok) throw new Error(`Microsoft To Do complete failed (${r.status})`);
}

// ─── reconcile one list ─────────────────────────────────────────────────────

export async function syncTaskList(list: TaskList): Promise<void> {
  const sync = list.syncExternal;
  if (!sync) return;
  const tokens = await getValidAccessTokens(sync.source);
  // A background tick has no operator to ask "which account?" — unlike the
  // agent-initiated write primitives, it just uses the first connected
  // account of that platform and skips quietly if none is connected, same
  // best-effort posture as the read primitives next to it.
  const chosen = tokens[0];
  if (!chosen) return;

  const fetchExternal = sync.source === "google" ? fetchGoogleTasks : fetchMicrosoftTasks;
  const createExternal = sync.source === "google" ? createGoogleTask : createMicrosoftTask;
  const completeExternal = sync.source === "google" ? completeGoogleTask : completeMicrosoftTask;

  const external = await fetchExternal(chosen.token, sync.externalListId);
  const externalIds = new Set(external.map(e => e.id));

  // Pull: create local mirrors for anything new, reflect state onto existing ones.
  for (const ext of external) {
    const existing = findItemByExternalId(sync.source, ext.id);
    if (existing) {
      applyExternalUpdate(existing.id, { title: ext.title, notes: ext.notes, dueDate: ext.due, completed: ext.completed });
    } else {
      addExternalItem(list.id, list.ownerEmail, { title: ext.title, notes: ext.notes, dueDate: ext.due, completed: ext.completed, externalSource: sync.source, externalId: ext.id });
    }
  }

  // Push: local-only items in this list get created externally once; a
  // mirrored item completed locally but still open externally gets completed
  // there too.
  for (const item of listItems(list.ownerEmail, { listId: list.id })) {
    if (!item.externalSource) {
      try {
        const newId = await createExternal(chosen.token, sync.externalListId, { title: item.title, notes: item.notes, due: item.dueDate });
        tagExternalId(item.id, sync.source, newId);
      } catch (e: any) {
        console.warn(`[task-sync] push-create failed for "${item.title}" (${list.name}): ${e?.message ?? e}`);
      }
      continue;
    }
    if (item.externalSource === sync.source && item.externalId && externalIds.has(item.externalId)) {
      const ext = external.find(e => e.id === item.externalId)!;
      if (item.completed && !ext.completed) {
        try { await completeExternal(chosen.token, sync.externalListId, item.externalId); }
        catch (e: any) { console.warn(`[task-sync] push-complete failed for "${item.title}" (${list.name}): ${e?.message ?? e}`); }
      }
    }
  }
}

async function syncAllOptedInLists(): Promise<void> {
  for (const list of listSyncedLists()) {
    try { await syncTaskList(list); }
    catch (e: any) { console.warn(`[task-sync] sync failed for list "${list.name}" (${list.syncExternal?.source}): ${e?.message ?? e}`); }
  }
}

const ENGINE_NAME = "task-sync";

export function startTaskSyncScheduler(): void {
  registerEngine({ name: ENGINE_NAME, intervalSeconds: 5 * 60, run: syncAllOptedInLists });
}

export function stopTaskSyncScheduler(): void {
  unregisterEngine(ENGINE_NAME);
}
