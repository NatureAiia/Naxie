import { useEffect, useMemo, useState } from "react";
import { FolderTree, Plus, Play, Pause, Pencil, Trash2, AlertTriangle, Search } from "lucide-react";
import { Card, Button, showToast } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { Notice } from "../components/Notice";
import { Modal, ConfirmDialog } from "../components/Modal";
import { EmptyState } from "../components/States";
import { Option } from "../components/Option";
import { apiResult } from "../lib/apiResult";
import { DAY_LABELS, formatCadence, formatNext } from "../lib/scheduleFormat";

// Management UI for the _workflows/ tree (server/src/lib/workflow-tree.ts) —
// Phase 0 shipped the engine with no UI at all; this is what lets the
// operator see, create, edit, run, and delete nodes instead of hand-editing
// task.md in Obsidian. A "workflow" here is just a folder; a "task" is a
// folder inside it with one task.md.

type Cadence = { daysOfWeek: number[]; hour: number; minute: number; once?: string };
type NodeStatus = { lastFiredAt?: string; lastError?: string; nextFireAt: number | null };
type TreeNode = {
  path: string; id: string; enabled: boolean; cadence?: Cadence;
  tools: string[]; data: string[]; outputPath?: string; handler?: string; body: string;
  status: NodeStatus;
};
type ToolInfo = { name: string; description?: string; readonly?: boolean };

function workflowOf(path: string): string {
  // "_workflows/<workflow>/<task>" — everything between the root and the leaf.
  const parts = path.replace(/^_workflows\//, "").split("/");
  return parts.slice(0, -1).join("/") || "(root)";
}

const emptyForm = {
  workflowId: "", taskId: "", enabled: true, hasCadence: false,
  days: [1, 2, 3, 4, 5] as number[], hour: 9, minute: 0,
  tools: [] as string[], data: "", outputPath: "", body: "",
};
type FormState = typeof emptyForm;

export function WorkflowTree() {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [engineArmed, setEngineArmed] = useState(false);
  const [flagEnabled, setFlagEnabled] = useState(false);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<TreeNode | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TreeNode | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [toolFilter, setToolFilter] = useState("");

  async function load() {
    const [n, t] = await Promise.all([
      apiResult<{ nodes: TreeNode[]; engineArmed: boolean; flagEnabled: boolean }>("/api/workflow-tree"),
      apiResult<{ tools: ToolInfo[] }>("/api/workflow-tree/tool-catalog"),
    ]);
    if (n.ok) { setNodes(n.nodes); setEngineArmed(n.engineArmed); setFlagEnabled(n.flagEnabled); }
    if (t.ok) setTools(t.tools);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  const grouped = useMemo(() => {
    const byWorkflow = new Map<string, TreeNode[]>();
    for (const n of nodes) {
      const w = workflowOf(n.path);
      if (!byWorkflow.has(w)) byWorkflow.set(w, []);
      byWorkflow.get(w)!.push(n);
    }
    return [...byWorkflow.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [nodes]);

  function openCreate() {
    setForm(emptyForm);
    setToolFilter("");
    setCreating(true);
  }

  function openEdit(n: TreeNode) {
    setForm({
      workflowId: workflowOf(n.path), taskId: n.id, enabled: n.enabled, hasCadence: !!n.cadence,
      days: n.cadence?.daysOfWeek ?? [1, 2, 3, 4, 5], hour: n.cadence?.hour ?? 9, minute: n.cadence?.minute ?? 0,
      tools: n.tools, data: n.data.join(", "), outputPath: n.outputPath ?? "", body: n.body,
    });
    setToolFilter("");
    setEditing(n);
  }

  function toggleDay(d: number) {
    setForm(f => ({ ...f, days: f.days.includes(d) ? f.days.filter(x => x !== d) : [...f.days, d].sort((a, b) => a - b) }));
  }
  function toggleTool(name: string) {
    setForm(f => ({ ...f, tools: f.tools.includes(name) ? f.tools.filter(t => t !== name) : [...f.tools, name] }));
  }

  function fieldsFromForm() {
    return {
      enabled: form.enabled,
      cadence: form.hasCadence ? { daysOfWeek: form.days, hour: form.hour, minute: form.minute } : undefined,
      tools: form.tools,
      data: form.data.split(",").map(s => s.trim()).filter(Boolean),
      outputPath: form.outputPath.trim() || undefined,
      body: form.body,
    };
  }

  async function submitCreate() {
    if (!form.workflowId.trim() || !form.taskId.trim()) return showToast("Workflow and task ids are required", "error");
    const r = await apiResult("/api/workflow-tree", { method: "POST", body: JSON.stringify({ workflowId: form.workflowId.trim(), taskId: form.taskId.trim(), ...fieldsFromForm() }) });
    if (!r.ok) return showToast(r.error, "error");
    showToast("Task created", "success");
    setCreating(false);
    void load();
  }

  async function submitEdit() {
    if (!editing) return;
    const r = await apiResult(`/api/workflow-tree/node?path=${encodeURIComponent(editing.path)}`, { method: "PATCH", body: JSON.stringify(fieldsFromForm()) });
    if (!r.ok) return showToast(r.error, "error");
    showToast("Saved", "success");
    setEditing(null);
    void load();
  }

  async function toggleEnabled(n: TreeNode) {
    setBusy(n.path);
    const r = await apiResult(`/api/workflow-tree/node?path=${encodeURIComponent(n.path)}`, { method: "PATCH", body: JSON.stringify({ enabled: !n.enabled }) });
    if (!r.ok) showToast(r.error, "error");
    await load();
    setBusy(null);
  }

  async function runNow(n: TreeNode) {
    setBusy(n.path);
    const r = await apiResult(`/api/workflow-tree/node/run?path=${encodeURIComponent(n.path)}`, { method: "POST" });
    if (!r.ok) showToast(r.error, "error");
    else showToast(`Ran "${n.id}"`, "success");
    await load();
    setBusy(null);
  }

  async function confirmDeleteNode() {
    if (!confirmDelete) return;
    const r = await apiResult(`/api/workflow-tree/node?path=${encodeURIComponent(confirmDelete.path)}`, { method: "DELETE" });
    if (!r.ok) showToast(r.error, "error");
    setConfirmDelete(null);
    void load();
  }

  const filteredTools = tools.filter(t => !toolFilter.trim() || t.name.toLowerCase().includes(toolFilter.toLowerCase()) || t.description?.toLowerCase().includes(toolFilter.toLowerCase()));

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        icon={<FolderTree size={22} className="text-violet-400" />}
        title="Workflow Tree"
        subtitle="Every scheduled and on-demand task Naxie runs, as a real folder tree — a workflow is a folder, a task is a folder inside it with its own instructions, tools and data."
        action={<Button onClick={openCreate}><Plus size={14} /> New task</Button>}
      />

      <Notice tone={engineArmed ? "confirm" : "warning"}>
        {engineArmed
          ? "The tree engine is live in this process — enabled tasks with a cadence fire automatically."
          : flagEnabled
            ? "NEUROWORKS_WORKFLOW_TREE=1 is set but the engine hasn't armed yet in this process — restart the server."
            : "The tree engine isn't armed in this process (set NEUROWORKS_WORKFLOW_TREE=1 and restart to enable live firing). You can still create, edit and \"Run now\" tasks below."}
      </Notice>

      {loading ? (
        <p className="text-xs text-cream-300/60">Loading…</p>
      ) : nodes.length === 0 ? (
        <Card>
          <EmptyState icon={FolderTree} title="No tasks yet" body="Create your first task to see it here — instructions, a tool allowlist, and an optional cadence." action={<Button onClick={openCreate}><Plus size={14} /> New task</Button>} />
        </Card>
      ) : (
        grouped.map(([workflow, list]) => (
          <Card key={workflow} title={workflow}>
            <div className="divide-y divide-ink-800">
              {list.map(n => (
                <div key={n.path} className="py-3 first:pt-0 last:pb-0 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm text-cream-50 font-medium">{n.id}</span>
                      {!n.enabled && <span className="text-[10px] uppercase tracking-wider text-cream-300/50 bg-ink-850 border border-ink-700 rounded px-1.5 py-0.5">paused</span>}
                      {n.handler && <span className="text-[10px] font-mono text-cream-300/50">{n.handler}</span>}
                    </div>
                    <div className="text-[11px] text-cream-300/70 flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                      <span>{n.cadence ? formatCadence(n.cadence) : "On-demand"}</span>
                      {n.cadence && <><span className="text-cream-300/40">·</span><span>Next: {n.enabled ? formatNext(n.status.nextFireAt) : "paused"}</span></>}
                      <span className="text-cream-300/40">·</span>
                      <span>{n.tools.length} tool{n.tools.length === 1 ? "" : "s"}</span>
                    </div>
                    {n.status.lastFiredAt && (
                      <div className="text-[10px] text-cream-300/50 mt-1">Last fired {new Date(n.status.lastFiredAt).toLocaleString()}</div>
                    )}
                    {n.status.lastError && (
                      <div className="text-[10px] text-coral-400 mt-1 flex items-start gap-1"><AlertTriangle size={11} className="mt-0.5" /> {n.status.lastError}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => void runNow(n)} disabled={busy === n.path} className="text-cream-300 hover:text-cream-50 p-1.5 rounded hover:bg-ink-800" title="Run now" aria-label="Run now"><Play size={14} /></button>
                    <button onClick={() => void toggleEnabled(n)} disabled={busy === n.path} className="text-cream-300 hover:text-cream-50 p-1.5 rounded hover:bg-ink-800" title={n.enabled ? "Pause" : "Resume"} aria-label={n.enabled ? "Pause" : "Resume"}>
                      {n.enabled ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button onClick={() => openEdit(n)} className="text-cream-300 hover:text-cream-50 p-1.5 rounded hover:bg-ink-800" title="Edit" aria-label="Edit"><Pencil size={14} /></button>
                    <button onClick={() => setConfirmDelete(n)} className="text-cream-300/70 hover:text-coral-400 p-1.5 rounded hover:bg-ink-800" title="Delete" aria-label="Delete"><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))
      )}

      {(creating || editing) && (
        <Modal open onClose={() => { setCreating(false); setEditing(null); }} title={editing ? `Edit "${editing.id}"` : "New task"} className="max-w-2xl">
          <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
            {!editing && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Workflow</label>
                  <input value={form.workflowId} onChange={e => setForm(f => ({ ...f, workflowId: e.target.value }))} placeholder="e.g. ops" className="w-full bg-ink-950 border border-ink-800 rounded-md px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Task</label>
                  <input value={form.taskId} onChange={e => setForm(f => ({ ...f, taskId: e.target.value }))} placeholder="e.g. weekly-digest" className="w-full bg-ink-950 border border-ink-800 rounded-md px-3 py-2 text-sm" />
                </div>
                <p className="col-span-2 text-[11px] text-cream-300/50">Lowercase letters, numbers and hyphens only — this becomes the folder path <code>_workflows/{form.workflowId || "workflow"}/{form.taskId || "task"}</code>.</p>
              </div>
            )}

            <div>
              <label className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Instructions</label>
              <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} rows={4} placeholder="What should Naxie do when this task runs?" className="w-full bg-ink-950 border border-ink-800 rounded-md px-3 py-2 text-sm" />
            </div>

            <label className="flex items-center gap-2 text-sm text-cream-100">
              <input type="checkbox" checked={form.hasCadence} onChange={e => setForm(f => ({ ...f, hasCadence: e.target.checked }))} />
              Runs on a schedule (otherwise on-demand only)
            </label>

            {form.hasCadence && (
              <div className="space-y-2 pl-1 border-l-2 border-ink-800 ml-1">
                <div className="flex flex-wrap gap-1 pl-3">
                  {DAY_LABELS.map((d, i) => (
                    <Option key={d} selected={form.days.includes(i)} onToggle={() => toggleDay(i)}>{d}</Option>
                  ))}
                </div>
                <div className="flex items-center gap-2 pl-3">
                  <input type="number" min={0} max={23} value={form.hour} onChange={e => setForm(f => ({ ...f, hour: Number(e.target.value) }))} className="w-16 bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-sm" />
                  <span className="text-cream-300/50">:</span>
                  <input type="number" min={0} max={59} value={form.minute} onChange={e => setForm(f => ({ ...f, minute: Number(e.target.value) }))} className="w-16 bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-sm" />
                  <span className="text-xs text-cream-300/50">local time</span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Vault paths this task may read (optional, comma-separated)</label>
              <input value={form.data} onChange={e => setForm(f => ({ ...f, data: e.target.value }))} placeholder="_neuroworks/" className="w-full bg-ink-950 border border-ink-800 rounded-md px-3 py-2 text-sm font-mono" />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-[11px] uppercase tracking-wider text-cream-300/60">Tools this task may call ({form.tools.length} selected)</label>
              </div>
              <div className="relative mb-1.5">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-cream-300/40" />
                <input value={toolFilter} onChange={e => setToolFilter(e.target.value)} placeholder="Filter tools…" className="w-full bg-ink-950 border border-ink-800 rounded-md pl-7 pr-3 py-1.5 text-xs" />
              </div>
              <div className="max-h-40 overflow-y-auto border border-ink-800 rounded-md divide-y divide-ink-800">
                {filteredTools.map(t => (
                  <label key={t.name} className="flex items-start gap-2 px-2 py-1.5 text-xs hover:bg-ink-900 cursor-pointer">
                    <input type="checkbox" checked={form.tools.includes(t.name)} onChange={() => toggleTool(t.name)} className="mt-0.5" />
                    <span className="font-mono text-cream-100 shrink-0">{t.name}</span>
                    <span className="text-cream-300/50 truncate">{t.description}</span>
                  </label>
                ))}
                {filteredTools.length === 0 && <div className="px-2 py-3 text-xs text-cream-300/50 text-center">No tools match.</div>}
              </div>
            </div>

            {editing && (
              <label className="flex items-center gap-2 text-sm text-cream-100">
                <input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} />
                Enabled
              </label>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-4 border-t border-ink-800 mt-4">
            <Button variant="ghost" onClick={() => { setCreating(false); setEditing(null); }}>Cancel</Button>
            <Button onClick={() => void (editing ? submitEdit() : submitCreate())}>{editing ? "Save" : "Create task"}</Button>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title={`Delete "${confirmDelete?.id}"?`}
        rows={confirmDelete ? [["Path", confirmDelete.path], ["Tools", confirmDelete.tools.join(", ") || "none"]] : []}
        body="This removes the task's folder from the vault entirely. It won't run again."
        confirmLabel="Delete"
        danger
        onConfirm={() => void confirmDeleteNode()}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
