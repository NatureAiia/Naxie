import { useEffect, useState } from "react";
import { Workflow, Play, Power, Trash2, Loader2, ExternalLink, AlertTriangle, RefreshCw, Send, X, Wand2, Plus } from "lucide-react";
import { api, type N8nStatus, type N8nWorkflow, type N8nExecution, type WorkflowDraft } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";

// n8n — self-hosted workflow automation. Everything here reads/writes n8n's
// own REST API through server/src/lib/n8n.ts (N8N_BASE_URL + N8N_API_KEY in
// .env — see server/src/routes/n8n.ts). This is the ONE place to monitor,
// activate/deactivate, and fire workflows; the old "n8n" entry under
// Extensions → Integrations was a disconnected duplicate and has been
// removed (see lib/integrations.ts).

function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function N8n() {
  const [status, setStatus] = useState<N8nStatus | null>(null);
  const [workflows, setWorkflows] = useState<N8nWorkflow[] | null>(null);
  const [executions, setExecutions] = useState<N8nExecution[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try { setStatus(await api.n8nStatus()); } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function refreshData() {
    try { const r = await api.listN8nWorkflows({ limit: 50 }); setWorkflows(r.workflows); } catch { setWorkflows([]); }
    try { const r = await api.listN8nExecutions({ limit: 20 }); setExecutions(r.data ?? []); } catch { setExecutions([]); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (status?.enabled) void refreshData(); }, [status?.enabled]);

  async function toggle(w: N8nWorkflow) {
    setBusy(w.id);
    try {
      if (w.active) await api.deactivateN8nWorkflow(w.id);
      else await api.activateN8nWorkflow(w.id);
      showToast(`${w.name} ${w.active ? "deactivated" : "activated"}`, "success");
      await refreshData();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(null); }
  }

  async function remove(w: N8nWorkflow) {
    if (!confirm(`Delete workflow "${w.name}"? This removes it from n8n entirely.`)) return;
    setBusy(w.id);
    try { await api.deleteN8nWorkflow(w.id); showToast("Workflow deleted", "success"); await refreshData(); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(null); }
  }

  const workflowById = (id?: string) => workflows?.find(w => w.id === id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><Workflow size={24} /> n8n</h1>
        <p className="text-sm text-cream-300/70 mt-1 max-w-3xl">
          Monitor, activate, and trigger your self-hosted n8n workflows — the same instance agents reach via the
          <span className="font-mono"> n8n.*</span> tools. Configured via <span className="font-mono text-cream-200">N8N_BASE_URL</span> +
          <span className="font-mono text-cream-200"> N8N_API_KEY</span> in <span className="font-mono">.env</span>.
        </p>
      </div>

      <Card title="Status" action={<Button variant="subtle" onClick={() => { void refresh(); void refreshData(); }}><RefreshCw size={13} /> Refresh</Button>}>
        {!status ? (
          <div className="text-sm text-cream-300/60 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : !status.configured ? (
          <div className="text-sm space-y-2">
            <div className="text-amber-300/90 flex items-center gap-1.5"><AlertTriangle size={14} /> Not configured</div>
            <div className="text-[12px] text-cream-300/60">
              Run n8n (<span className="font-mono">docker run -it --rm -p 5678:5678 n8nio/n8n</span>), open <span className="font-mono">Settings → API → Create API Key</span>,
              then set <span className="font-mono text-cream-200">N8N_BASE_URL</span> and <span className="font-mono text-cream-200">N8N_API_KEY</span> in
              <span className="font-mono"> neuroworks/.env</span> and restart the server.
            </div>
            <a href="https://docs.n8n.io/api/authentication/" target="_blank" rel="noreferrer" className="text-[12px] text-violet-400 hover:text-violet-300 inline-flex items-center gap-1">n8n API docs <ExternalLink size={11} /></a>
          </div>
        ) : (
          <div className="flex items-center gap-3 text-sm">
            <span className={`inline-block w-2 h-2 rounded-full ${status.health.ok ? "bg-leaf-500" : "bg-coral-500"}`} />
            <span className={status.health.ok ? "text-leaf-400" : "text-coral-400"}>{status.health.detail}</span>
            {status.baseUrl && (
              <a href={status.baseUrl} target="_blank" rel="noreferrer" className="text-violet-400 hover:text-violet-300 inline-flex items-center gap-1 text-[12px] ml-auto">
                Open n8n <ExternalLink size={11} />
              </a>
            )}
          </div>
        )}
        {err && <div className="text-[12px] text-coral-400 mt-2 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
      </Card>

      {status?.configured && (
        <>
          <GenerateWorkflowCard onCreated={refreshData} />

          <Card title={`Workflows${workflows ? ` (${workflows.length})` : ""}`}>
            {workflows === null ? (
              <div className="text-sm text-cream-300/60 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading workflows…</div>
            ) : workflows.length === 0 ? (
              <div className="text-center py-6 text-cream-300/60 text-sm">No workflows yet — build one in n8n, then manage it here.</div>
            ) : (
              <div className="space-y-2">
                {workflows.map(w => (
                  <div key={w.id} className="flex items-center gap-3 py-2 px-3 rounded-lg bg-ink-950/50 border border-ink-800">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${w.active ? "bg-leaf-500" : "bg-ink-600"}`} title={w.active ? "Active" : "Inactive"} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-cream-100 truncate">{w.name}</div>
                      <div className="text-[11px] text-cream-300/50">
                        {w.updatedAt ? `Updated ${relTime(w.updatedAt)}` : ""}{w.tags?.length ? ` · ${w.tags.map((t: any) => t.name ?? t).join(", ")}` : ""}
                      </div>
                    </div>
                    {status.baseUrl && (
                      <a href={`${status.baseUrl}/workflow/${w.id}`} target="_blank" rel="noreferrer" className="text-cream-300/50 hover:text-cream-100 p-1.5" title="Open in n8n">
                        <ExternalLink size={14} />
                      </a>
                    )}
                    <Button variant="subtle" onClick={() => toggle(w)} disabled={busy === w.id}>
                      {busy === w.id ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} {w.active ? "Deactivate" : "Activate"}
                    </Button>
                    <button type="button" onClick={() => remove(w)} className="text-cream-300/50 hover:text-coral-400 p-1.5" title="Delete"><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Recent executions">
            {executions === null ? (
              <div className="text-sm text-cream-300/60 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>
            ) : executions.length === 0 ? (
              <div className="text-center py-4 text-cream-300/60 text-sm">No executions yet.</div>
            ) : (
              <div className="space-y-1.5">
                {executions.map(e => {
                  const wf = workflowById(e.workflowId);
                  const ok = e.status ? e.status === "success" : e.finished;
                  return (
                    <div key={e.id} className="flex items-center gap-2 text-[12px] py-1.5 px-2 rounded-md bg-ink-950/40 border border-ink-800">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ok ? "bg-leaf-500" : e.status === "error" ? "bg-coral-500" : "bg-amber-400/80"}`} />
                      <span className="text-cream-200 truncate">{wf?.name ?? e.workflowId ?? "unknown workflow"}</span>
                      <span className="text-cream-300/50 ml-auto shrink-0">{e.status ?? (e.finished ? "finished" : "running")} · {relTime(e.startedAt)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="Trigger a webhook" action={<Button variant="subtle" onClick={() => setTriggering(true)}><Send size={13} /> New trigger</Button>}>
            <div className="text-[12px] text-cream-300/60">
              Fire any of your n8n Webhook-triggered workflows directly — the same call the <span className="font-mono">n8n.trigger_webhook</span> agent tool makes.
            </div>
          </Card>
        </>
      )}

      {triggering && <TriggerModal onClose={() => setTriggering(false)} />}
    </div>
  );
}

const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60 placeholder:text-cream-300/30";

// Describe a workflow in plain English, get a draft back, review it, then
// create it in n8n — the same n8n.create_workflow call an agent can already
// make from chat, just with a dedicated, always-previewed entry point.
function GenerateWorkflowCard({ onCreated }: { onCreated: () => Promise<void> }) {
  const [goal, setGoal] = useState("");
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);

  async function generate() {
    setGenerating(true); setDraft(null);
    try { setDraft((await api.generateN8nWorkflow(goal)).draft); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setGenerating(false); }
  }

  async function create() {
    if (!draft) return;
    setCreating(true);
    try {
      await api.createN8nWorkflow(draft);
      showToast(`Workflow "${draft.name}" created (inactive) — activate it below`, "success");
      setDraft(null);
      setGoal("");
      await onCreated();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setCreating(false); }
  }

  return (
    <Card title="Describe a workflow to build">
      <div className="space-y-3">
        <div className="flex gap-2">
          <input
            value={goal}
            onChange={e => setGoal(e.target.value)}
            placeholder="e.g. Every weekday morning, post a Slack summary"
            className={FIELD}
            onKeyDown={e => { if (e.key === "Enter" && goal.trim() && !generating) void generate(); }}
          />
          <Button onClick={generate} disabled={generating || !goal.trim()}>
            {generating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Generate
          </Button>
        </div>
        {draft && (
          <div className="rounded-lg border border-ink-800 bg-ink-950/60 p-3 space-y-2">
            <div className="text-sm text-cream-100">{draft.name}</div>
            <ul className="text-[12px] text-cream-300/70 list-disc list-inside">
              {draft.nodes.map((n: any, i: number) => <li key={i}>{n.name} <span className="text-cream-300/40">({n.type})</span></li>)}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button>
              <Button onClick={create} disabled={creating}>{creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create in n8n</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function TriggerModal({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState("");
  const [method, setMethod] = useState("POST");
  const [bodyText, setBodyText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; status?: number; body?: unknown; error?: string } | null>(null);

  async function run() {
    setRunning(true); setResult(null);
    let body: any;
    if (bodyText.trim() && method !== "GET") {
      try { body = JSON.parse(bodyText); } catch { body = bodyText; }
    }
    try {
      const r = path.trim().startsWith("http")
        ? await api.triggerN8nWebhook({ url: path.trim(), method, body })
        : await api.triggerN8nWebhook({ path: path.trim(), method, body });
      setResult(r);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message ?? String(e) });
    } finally { setRunning(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-lg bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-3 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">Trigger a webhook</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>
        <div className="flex gap-2">
          <select value={method} onChange={e => setMethod(e.target.value)} className={`${FIELD} !w-28`}>
            {["POST", "GET", "PUT", "DELETE"].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <input value={path} onChange={e => setPath(e.target.value)} placeholder="my-hook  or  https://.../webhook/my-hook" className={`${FIELD} font-mono`} spellCheck={false} />
        </div>
        <div className="text-[10px] text-cream-300/40">A short path resolves against your configured webhook base URL; a full URL is used as-is.</div>
        {method !== "GET" && (
          <textarea value={bodyText} onChange={e => setBodyText(e.target.value)} rows={3} placeholder='{ "key": "value" }' className={`${FIELD} font-mono text-[12px]`} spellCheck={false} />
        )}
        <div className="flex justify-end">
          <Button onClick={run} disabled={running || !path.trim()}>{running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Send</Button>
        </div>
        {result && (
          <div className="rounded-lg border border-ink-800 bg-ink-950/60 p-3 space-y-1">
            <div className={`text-[12px] ${result.ok ? "text-leaf-400" : "text-coral-400"}`}>
              {result.error ? `Error: ${result.error}` : `HTTP ${result.status}`}
            </div>
            {result.body !== undefined && (
              <pre className="text-[11px] text-cream-200/90 font-mono whitespace-pre-wrap break-words max-h-56 overflow-auto">
                {typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
