// The workflow/task tree — Naxie's file-tree architecture (Phase 0 of
// docs/naxie-architecture's tree-model plan). A workflow is a vault folder
// under `_workflows/`; a task is a folder inside it holding one `task.md`
// (YAML frontmatter + markdown body — the same convention every other vault
// note already uses, so Obsidian renders it and vault.ts's read/write need
// no new code path).
//
// Phase 0 scope, deliberately narrow: prove the tree engine by collapsing
// the highest-duplication daemon schedulers (reflection, innovation-scan,
// todo-brief, weekly-rollup, weekly-improvement, system-audit's daily audit)
// into tree nodes driven by ONE generic runner, instead of each daemon
// re-implementing its own setInterval + lastRunDate + catch-up-guard +
// Job-record + Telegram-push boilerplate. Nodes call through
// NATIVE_HANDLERS to the existing, UNCHANGED run<X>() functions — this file
// does not reimplement tool-calling, dispatch, or scheduling math; it reuses
// lib/schedules.ts's Cadence/nextFireAt directly and (for the future
// "template:" handler path — not used by any Phase 0 node yet, but built and
// tested now so the `tools` field is real) agent.ts's planAndExecute via its
// new toolAllowlist option.
//
// Real parent/child sub-tasks, persona/skill/template convergence, and MCP
// scoping are later phases — not built here. See the plan document for the
// full phase breakdown.

import { config } from "../config.js";
import { listVault, readVaultFile, writeVaultFile, deleteVaultEntry } from "./vault.js";
import { nextFireAt, type Cadence, type ScheduleDelivery } from "./schedules.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.neuroworks");
const STATE_FILE = join(STATE_DIR, "workflow-tree-state.json");
const ROOT = "_workflows";

export type TaskHandler = `native:${string}` | `template:${string}`;

export type TaskNode = {
  path: string;              // vault-relative path to the node's folder, e.g. "_workflows/ops-daemons/todo-brief"
  id: string;
  enabled: boolean;
  cadence?: Cadence;          // absent = on-demand node (not fired by the tick), reserved for Phase 1 sub-tasks
  tools: string[];
  data: string[];
  outputPath?: string;
  deliver?: ScheduleDelivery;
  handler?: TaskHandler;
  body: string;                // markdown instructions
};

type NodeState = { lastFiredAt?: string; lastJobId?: string; lastError?: string; fireCount: number };
type StateStore = Record<string, NodeState>; // keyed by node.path

// ─── frontmatter parsing — a small, deliberately minimal YAML-subset parser
// ─── (2-level nesting, scalars, scalar arrays, inline `[]`/`[a,b]`) rather
// ─── than a new dependency, matching this codebase's existing convention of
// ─── hand-rolled frontmatter parsing (routes/reflection.ts and siblings each
// ─── already do a flat colon-split version of this same thing).

function coerceScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "" || v === "null" || v === "~") return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map(s => coerceScalar(s.trim()));
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

// Parses the indented-block subset of YAML this schema actually uses:
// `key: value`, `key:` followed by more-indented `key: value` lines (one
// level of nesting — enough for `cadence`/`deliver`), and `key:` followed by
// `- item` lines (a scalar array). Not a general YAML parser; anything more
// exotic (multi-line strings, anchors, deep nesting) is out of scope for a
// human-edited task.md and falls back to being read as a plain string.
function parseYamlBlock(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const indent = line.match(/^(\s*)/)![1].length;
    if (indent > 0) { i++; continue; } // stray indented line with no owning key — skip
    const colon = line.indexOf(":");
    if (colon < 0) { i++; continue; }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (rest) {
      out[key] = coerceScalar(rest);
      i++;
      continue;
    }
    // Nested block or list — collect the more-indented lines that follow.
    const block: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (!l.trim()) { j++; continue; }
      const li = l.match(/^(\s*)/)![1].length;
      if (li === 0) break;
      block.push(l.slice(2)); // de-indent one level
      j++;
    }
    if (block.length && block.every(l => l.trim().startsWith("- "))) {
      out[key] = block.map(l => coerceScalar(l.trim().slice(2)));
    } else if (block.length) {
      out[key] = parseYamlBlock(block);
    } else {
      out[key] = undefined;
    }
    i = j;
  }
  return out;
}

export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  return { frontmatter: parseYamlBlock(m[1].split("\n")), body: m[2] };
}

// ─── tree walk ─────────────────────────────────────────────────────────────

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseCadence(v: unknown): Cadence | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  const daysOfWeek = asStringArray((c.daysOfWeek as unknown[])?.map?.(String) ?? []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  const hour = Number(c.hour);
  const minute = Number(c.minute ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  return { daysOfWeek, hour, minute: Number.isInteger(minute) ? minute : 0, once: typeof c.once === "string" ? c.once : undefined };
}

function nodeFromFrontmatter(nodePath: string, raw: string): TaskNode | null {
  const { frontmatter: fm, body } = parseFrontmatter(raw);
  const id = typeof fm.id === "string" ? fm.id : undefined;
  if (!id) return null; // malformed — skipped, matching schedules.ts's own tolerant-parse convention
  const deliverRaw = fm.deliver as Record<string, unknown> | undefined;
  return {
    path: nodePath,
    id,
    enabled: fm.enabled !== false,
    cadence: parseCadence(fm.cadence),
    tools: asStringArray(fm.tools),
    data: asStringArray(fm.data),
    outputPath: typeof fm.outputPath === "string" ? fm.outputPath : undefined,
    deliver: deliverRaw ? { email: typeof deliverRaw.email === "string" ? deliverRaw.email : undefined } : undefined,
    handler: typeof fm.handler === "string" && (fm.handler.startsWith("native:") || fm.handler.startsWith("template:")) ? (fm.handler as TaskHandler) : undefined,
    body,
  };
}

// Recursively lists `_workflows/` via the vault's own listVault/readVaultFile
// (not raw fs calls) so the walker sees exactly what the vault sees and
// stays consistent with its root resolution / ignore rules.
export function walkWorkflowTree(rel = ROOT): TaskNode[] {
  const out: TaskNode[] = [];
  let entries: ReturnType<typeof listVault>;
  try { entries = listVault(rel); } catch { return out; }
  const hasTaskMd = entries.some(e => e.type === "file" && e.name === "task.md");
  if (hasTaskMd) {
    try {
      const node = nodeFromFrontmatter(rel, readVaultFile(`${rel}/task.md`));
      if (node) out.push(node);
      else console.warn(`[workflow-tree] skipping malformed node at ${rel}/task.md (missing "id")`);
    } catch (e: any) {
      console.warn(`[workflow-tree] failed to read ${rel}/task.md: ${e?.message ?? e}`);
    }
  }
  for (const e of entries) {
    if (e.type === "dir") out.push(...walkWorkflowTree(e.path));
  }
  return out;
}

// ─── run-state (machine-only; kept out of task.md so a human edit and a
// ─── fire's bookkeeping never race or generate git noise on every run) ────

function loadState(): StateStore {
  try {
    if (!existsSync(STATE_FILE)) return {};
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch { return {}; }
}

function saveState(s: StateStore): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e: any) { console.warn(`[workflow-tree] failed to persist state: ${e?.message ?? e}`); }
}

export function getNodeState(nodePath: string): NodeState {
  return loadState()[nodePath] ?? { fireCount: 0 };
}

function recordFire(nodePath: string, ok: boolean, error?: string): void {
  const s = loadState();
  const prev = s[nodePath] ?? { fireCount: 0 };
  s[nodePath] = ok
    ? { lastFiredAt: new Date().toISOString(), fireCount: prev.fireCount + 1 }
    : { ...prev, lastError: error, lastFiredAt: new Date().toISOString(), fireCount: prev.fireCount + 1 };
  saveState(s);
}

export function getNodeStatus(node: TaskNode): { lastFiredAt?: string; lastError?: string; nextFireAt: number | null } {
  const st = getNodeState(node.path);
  const nextFireAt_ = node.cadence ? nextFireAt(node.cadence, st.lastFiredAt ? new Date(st.lastFiredAt) : new Date(0)) : null;
  return { lastFiredAt: st.lastFiredAt, lastError: st.lastError, nextFireAt: nextFireAt_ };
}

// ─── dispatch ──────────────────────────────────────────────────────────────

// Phase 0's only dispatch path: a static registry of existing run<X>()
// functions. Deliberately a thin call-through — this migration collapses
// scheduler *dispatch* duplication, not each daemon's own analysis logic.
// Registered by index.ts at boot (avoids a static import cycle between this
// leaf module and the 6 daemon modules).
type NativeHandler = () => Promise<unknown>;
const NATIVE_HANDLERS = new Map<string, NativeHandler>();

export function registerNativeHandler(name: string, fn: NativeHandler): void {
  NATIVE_HANDLERS.set(name, fn);
}

export async function runNode(node: TaskNode): Promise<{ ok: boolean; error?: string }> {
  if (!node.handler) return { ok: false, error: `node ${node.path} has no handler` };
  if (node.handler.startsWith("native:")) {
    const name = node.handler.slice("native:".length);
    const fn = NATIVE_HANDLERS.get(name);
    if (!fn) return { ok: false, error: `no native handler registered for "${name}"` };
    try { await fn(); recordFire(node.path, true); return { ok: true }; }
    catch (e: any) { const error = String(e?.message ?? e); recordFire(node.path, false, error); return { ok: false, error }; }
  }
  // "template:" handler — designed and tested (see server/test/workflow-tree.test.ts)
  // but not used by any Phase 0 node; a later phase wires this to
  // planAndExecute(node.body, ..., { toolAllowlist: node.tools }).
  return { ok: false, error: `template handlers are not wired up yet (Phase 0 only supports native:*)` };
}

// ─── management API — read/write a node's task.md from the UI ─────────────
// (see routes/workflow-tree.ts). Every write goes through here so the file
// format stays exactly what the tick/walker above expects — the UI never
// hand-assembles frontmatter text itself.

function serializeCadence(c: Cadence): string {
  const lines = [`  daysOfWeek: [${c.daysOfWeek.join(", ")}]`, `  hour: ${c.hour}`, `  minute: ${c.minute}`];
  if (c.once) lines.push(`  once: "${c.once}"`);
  return `cadence:\n${lines.join("\n")}`;
}

function serializeStringList(key: string, items: string[]): string {
  if (items.length === 0) return `${key}: []`;
  return `${key}:\n${items.map(t => `  - ${t}`).join("\n")}`;
}

function serializeFrontmatter(fields: Omit<TaskNode, "path" | "body">): string {
  const lines = [
    `id: ${fields.id}`,
    `enabled: ${fields.enabled}`,
  ];
  if (fields.cadence) lines.push(serializeCadence(fields.cadence));
  lines.push(serializeStringList("tools", fields.tools));
  lines.push(serializeStringList("data", fields.data));
  if (fields.outputPath) lines.push(`outputPath: "${fields.outputPath}"`);
  if (fields.deliver?.email) lines.push(`deliver:\n  email: "${fields.deliver.email}"`);
  if (fields.handler) lines.push(`handler: "${fields.handler}"`);
  return lines.join("\n");
}

export function getNode(nodePath: string): TaskNode | null {
  try { return nodeFromFrontmatter(nodePath, readVaultFile(`${nodePath}/task.md`)); }
  catch { return null; }
}

// Merges a partial patch onto the node's current fields and rewrites its
// task.md. Callers (routes/workflow-tree.ts) pass only the fields a form
// actually changed; everything else is preserved from disk, so a UI edit
// can never silently drop a field the form didn't render.
export function updateNode(nodePath: string, patch: Partial<Omit<TaskNode, "path">>): TaskNode | null {
  const existing = getNode(nodePath);
  if (!existing) return null;
  // Only fields the caller actually set survive into the merge — a PATCH
  // route destructuring req.body ends up with `undefined` for every field
  // the form didn't touch, and a naive spread would overwrite the existing
  // value with that undefined instead of leaving it alone.
  const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const merged: TaskNode = { ...existing, ...definedPatch, path: nodePath };
  const content = `---\n${serializeFrontmatter(merged)}\n---\n${merged.body.trim()}\n`;
  writeVaultFile(`${nodePath}/task.md`, content);
  return merged;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function createNode(workflowId: string, taskId: string, fields: Partial<Omit<TaskNode, "path" | "id" | "body">> & { body?: string }): { ok: true; node: TaskNode } | { ok: false; error: string } {
  if (!SLUG_RE.test(workflowId) || !SLUG_RE.test(taskId)) {
    return { ok: false, error: "workflow and task ids must be lowercase letters, numbers and hyphens only (max 64 chars)" };
  }
  const nodePath = `${ROOT}/${workflowId}/${taskId}`;
  if (getNode(nodePath)) return { ok: false, error: `a node already exists at ${nodePath}` };
  const node: TaskNode = {
    path: nodePath,
    id: taskId,
    enabled: fields.enabled ?? true,
    cadence: fields.cadence,
    tools: fields.tools ?? [],
    data: fields.data ?? [],
    outputPath: fields.outputPath,
    deliver: fields.deliver,
    handler: fields.handler,
    body: fields.body ?? "",
  };
  const content = `---\n${serializeFrontmatter(node)}\n---\n${node.body.trim()}\n`;
  writeVaultFile(`${nodePath}/task.md`, content);
  return { ok: true, node };
}

// Deletes the whole node folder (task.md + anything the operator dropped
// alongside it) and its run-state entry, via the vault's own generic
// delete — same guardrails (path confinement) every other vault write uses.
export function deleteNode(nodePath: string): boolean {
  if (!getNode(nodePath)) return false;
  deleteVaultEntry(nodePath);
  const s = loadState();
  if (s[nodePath]) { delete s[nodePath]; saveState(s); }
  return true;
}

// Whether the live scheduler is actually armed in THIS process — the UI
// uses this to explain why a node with a cadence might not be firing yet
// (NEUROWORKS_WORKFLOW_TREE is a boot-time flag, deliberately not a live
// toggle — see index.ts's comment on why that's the safe rollback story
// for Phase 0's one proof migration).
export function isEngineArmed(): boolean {
  return scheduler !== null;
}

// Writes a node's task.md only if it doesn't already exist — lets a fresh
// install get a sensible default while never clobbering an operator's edit
// on every boot. Callers pass the frontmatter as literal YAML text (not an
// object) since this is a one-shot seed, not something re-serialized later.
export function seedNodeIfMissing(nodePath: string, frontmatterYaml: string, body: string): void {
  try { readVaultFile(`${nodePath}/task.md`); return; } catch { /* doesn't exist yet — seed it */ }
  const content = `---\n${frontmatterYaml.trim()}\n---\n${body}\n`;
  try { writeVaultFile(`${nodePath}/task.md`, content); }
  catch (e: any) { console.warn(`[workflow-tree] failed to seed ${nodePath}/task.md: ${e?.message ?? e}`); }
}

// ─── the generic runner ────────────────────────────────────────────────────

let scheduler: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const nodes = walkWorkflowTree();
  const now = new Date();
  for (const node of nodes) {
    if (!node.enabled || !node.cadence) continue;
    const st = getNodeState(node.path);
    const from = st.lastFiredAt ? new Date(st.lastFiredAt) : new Date(now.getTime() - 25 * 3600_000);
    const due = nextFireAt(node.cadence, from);
    // Due once `due` has passed relative to now — nextFireAt already returns
    // the first qualifying slot strictly after `from`, so "due" means that
    // slot is now in the past.
    if (due === null || due > now.getTime()) continue;
    console.log(`[workflow-tree] firing ${node.path} (handler=${node.handler ?? "none"})`);
    await runNode(node);
  }
}

export function startWorkflowTreeScheduler(): void {
  if (scheduler) return;
  scheduler = setInterval(() => { void tick(); }, 10 * 60_000);
  scheduler.unref?.();
  void tick();
}

export function stopWorkflowTreeScheduler(): void {
  if (scheduler) { clearInterval(scheduler); scheduler = null; }
}

// Test-only reset — mirrors lib/scheduler-registry.ts's own _resetForTests()
// convention so suites don't leak timers or native-handler registrations
// across test files.
export function _resetForTests(): void {
  stopWorkflowTreeScheduler();
  NATIVE_HANDLERS.clear();
  try { if (existsSync(STATE_FILE)) writeFileSync(STATE_FILE, "{}"); } catch { /* best-effort */ }
}
