import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, ArrowDownToLine, ArrowUpFromLine, Check, Copy, ExternalLink, Loader2, Plus, RefreshCw, RotateCw, Send, ShieldCheck, Trash2, Webhook, Workflow } from "lucide-react";
import { api, type ExecutorStatus, type HermesBridgeStatus } from "../lib/api";
import { apiResult } from "../lib/apiResult";
import { PageHeader } from "../components/PageHeader";
import { Card, Button, showToast } from "../components/Card";
import { Modal, ConfirmDialog } from "../components/Modal";
import { Notice } from "../components/Notice";
import { EmptyState, ErrorState } from "../components/States";

type EventOption = { name: string; description: string };
type OutboundTarget = { id: string; label: string; url: string; events: string[]; enabled: boolean; secretConfigured: boolean; createdAt: string };
type DeliveryStatus = "pending" | "success" | "failed" | "dead_letter";
type Delivery = { id: string; targetId: string; event: string; status: DeliveryStatus; attempts: number; lastAttemptAt?: string; nextAttemptAt?: string; lastError?: string; createdAt: string };
type InboundTarget = { id: string; targetId: string; targetKind: string; urlPath: string; secretConfigured: boolean; createdAt: string; lastHitAt?: string; hitCount: number; recentJobIds: string[] };
type Flow = { id: string; name: string; enabled: boolean; trigger: { kind: string }; steps: { id: string; kind: string; ref: string }[]; createdAt: string; invokeUrl?: string };
type FlowRun = { id: string; flowId: string; status: string; attempts: number; lastError?: string; startedAt: string; finishedAt?: string; jobId?: string; stepResults: { stepId: string; status: string; error?: string }[] };
type InboundSecret = { label: string; secret: string; url: string; sampleTask: string };
type Recipe = { id: string; label: string; task: string; help: string };

const RECIPES: Recipe[] = [
  { id: "support", label: "Support request triage", task: "Triage this support request. Summarize the issue, urgency, likely owner, and a suggested reply. Request: {{ticket_description}}", help: "Map the incoming ticket description into the placeholder before sending the request." },
  { id: "dataset", label: "New dataset review", task: "Review this newly published dataset. Summarize the important changes, flag data-quality risks, and recommend the next action. Dataset event: {{event_payload}}", help: "Send the dataset event details in the task text." },
  { id: "deadline", label: "Deadline and risk review", task: "Review this upcoming deadline. Find relevant project context, identify blockers or risks, and draft a concise update for approval. Event: {{event_payload}}", help: "Send the deadline and project identifiers in the task text." },
];

const STATUS_COLOR: Record<DeliveryStatus, string> = {
  pending: "bg-ink-800 text-cream-300/60",
  success: "bg-leaf-500/15 text-leaf-400",
  failed: "bg-amber-400/15 text-amber-300",
  dead_letter: "bg-coral-500/15 text-coral-400",
};

function age(iso?: string): string {
  if (!iso) return "Never";
  const seconds = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

async function copy(text: string, label: string) {
  try { await navigator.clipboard.writeText(text); showToast(`${label} copied`, "success"); }
  catch { showToast(`Couldn't copy ${label.toLowerCase()}`, "error"); }
}

export function Automation() {
  const [tab, setTab] = useState<"incoming" | "outgoing" | "flows">("incoming");
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [flowRuns, setFlowRuns] = useState<FlowRun[] | null>(null);
  const [createFlow, setCreateFlow] = useState(false);
  const [flowName, setFlowName] = useState("");
  const [flowTrigger, setFlowTrigger] = useState<"webhook" | "schedule">("webhook");
  const [flowStepKind, setFlowStepKind] = useState("connector.call");
  const [flowStepRef, setFlowStepRef] = useState("");
  const [flowTemplate, setFlowTemplate] = useState('{\n  "method": "GET",\n  "path": "/"\n}');
  const [deleteFlow, setDeleteFlow] = useState<Flow | null>(null);
  const [incoming, setIncoming] = useState<InboundTarget[] | null>(null);
  const [outgoing, setOutgoing] = useState<OutboundTarget[] | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [executor, setExecutor] = useState<ExecutorStatus | null>(null);
  const [bridge, setBridge] = useState<HermesBridgeStatus | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [createIncoming, setCreateIncoming] = useState(false);
  const [createOutgoing, setCreateOutgoing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [incomingLabel, setIncomingLabel] = useState("");
  const [recipeId, setRecipeId] = useState(RECIPES[0].id);
  const [outLabel, setOutLabel] = useState("");
  const [outUrl, setOutUrl] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [secretNotice, setSecretNotice] = useState<InboundSecret | { label: string; secret: string } | null>(null);
  const [deleteInbound, setDeleteInbound] = useState<InboundTarget | null>(null);
  const [deleteOutbound, setDeleteOutbound] = useState<OutboundTarget | null>(null);
  const recipe = useMemo(() => RECIPES.find(item => item.id === recipeId) ?? RECIPES[0], [recipeId]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const [inRes, outRes, deliveryRes, catalogRes, flowRes] = await Promise.all([
      apiResult<{ webhooks: InboundTarget[] }>("/api/extensions/webhooks"),
      apiResult<{ targets: OutboundTarget[] }>("/api/webhooks/targets"),
      apiResult<{ deliveries: Delivery[] }>("/api/webhooks/deliveries"),
      apiResult<{ events: EventOption[] }>("/api/webhooks/catalog"),
      apiResult<{ flows: Flow[] }>("/api/flows"),
    ]);
    if (inRes.ok) { setIncoming(inRes.webhooks); setError(""); } else setError(inRes.error);
    if (flowRes.ok) setFlows(flowRes.flows);
    if (outRes.ok) setOutgoing(outRes.targets);
    if (deliveryRes.ok) setDeliveries(deliveryRes.deliveries);
    if (catalogRes.ok) setEvents(catalogRes.events);
    const [execStatus, bridgeStatus] = await Promise.all([
      api.getExecutor().catch(() => null),
      api.hermesBridgeStatus().catch(() => null),
    ]);
    setExecutor(execStatus); setBridge(bridgeStatus);
    setRefreshing(false);
  }, []);

  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 15000); return () => clearInterval(timer); }, [refresh]);

  async function addIncoming() {
    const label = incomingLabel.trim();
    if (!label) return;
    const targetId = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || `task-${Date.now()}`;
    setBusy(true);
    const response = await apiResult<{ webhook: InboundTarget; secret?: string; alreadyExists?: boolean }>("/api/extensions/webhooks", {
      method: "POST", body: JSON.stringify({ targetId, targetKind: "task" }),
    });
    setBusy(false);
    if (!response.ok) return showToast(response.error, "error");
    setCreateIncoming(false); setIncomingLabel("");
    if (response.secret) setSecretNotice({ label, secret: response.secret, url: `${window.location.origin}${response.webhook.urlPath}`, sampleTask: recipe.task });
    else if (response.alreadyExists) showToast("This trigger already exists. Rotate its secret to reveal a new one.", "info");
    await refresh();
  }

  async function rotateIncoming(target: InboundTarget) {
    const response = await apiResult<{ webhook: InboundTarget; secret: string }>(`/api/extensions/webhooks/${encodeURIComponent(target.id)}/rotate`, { method: "POST" });
    if (!response.ok) return showToast(response.error, "error");
    setSecretNotice({ label: target.targetId, secret: response.secret, url: `${window.location.origin}${response.webhook.urlPath}`, sampleTask: recipe.task });
    await refresh();
  }

  async function removeIncoming() {
    if (!deleteInbound) return;
    const response = await apiResult(`/api/extensions/webhooks/${encodeURIComponent(deleteInbound.id)}`, { method: "DELETE" });
    if (!response.ok) return showToast(response.error, "error");
    setDeleteInbound(null); showToast("Task trigger removed", "success"); await refresh();
  }

  async function addOutgoing() {
    if (!outLabel.trim() || !outUrl.trim()) return;
    setBusy(true);
    const response = await apiResult<{ target: OutboundTarget; secret: string }>("/api/webhooks/targets", {
      method: "POST", body: JSON.stringify({ label: outLabel, url: outUrl, events: selectedEvents }),
    });
    setBusy(false);
    if (!response.ok) return showToast(response.error, "error");
    setCreateOutgoing(false); setOutLabel(""); setOutUrl(""); setSelectedEvents([]);
    setSecretNotice({ label: response.target.label, secret: response.secret });
    await refresh();
  }

  async function rotateOutgoing(target: OutboundTarget) {
    const response = await apiResult<{ target: OutboundTarget; secret: string }>(`/api/webhooks/targets/${encodeURIComponent(target.id)}/rotate-secret`, { method: "POST" });
    if (!response.ok) return showToast(response.error, "error");
    setSecretNotice({ label: target.label, secret: response.secret }); await refresh();
  }

  async function toggleOutgoing(target: OutboundTarget) {
    const response = await apiResult<{ target: OutboundTarget }>(`/api/webhooks/targets/${encodeURIComponent(target.id)}`, {
      method: "PATCH", body: JSON.stringify({ enabled: !target.enabled }),
    });
    if (!response.ok) return showToast(response.error, "error");
    await refresh();
  }

  async function removeOutgoing() {
    if (!deleteOutbound) return;
    const response = await apiResult(`/api/webhooks/targets/${encodeURIComponent(deleteOutbound.id)}`, { method: "DELETE" });
    if (!response.ok) return showToast(response.error, "error");
    setDeleteOutbound(null); showToast("Event destination removed", "success"); await refresh();
  }

  async function testOutgoing(target: OutboundTarget) {
    const response = await apiResult<{ dispatched: number }>("/api/webhooks/test", { method: "POST", body: JSON.stringify({ targetId: target.id }) });
    if (!response.ok) return showToast(response.error, "error");
    showToast(response.dispatched ? "Test attempt recorded. Check delivery status below." : "Destination is disabled.", response.dispatched ? "success" : "error");
    await refresh();
  }

  async function replay(delivery: Delivery) {
    const response = await apiResult<{ delivery: Delivery }>(`/api/webhooks/deliveries/${encodeURIComponent(delivery.id)}/replay`, { method: "POST" });
    if (!response.ok) return showToast(response.error, "error");
    showToast(`Replay ${response.delivery.status}`, response.delivery.status === "success" ? "success" : "error"); await refresh();
  }

  async function addFlow() {
    if (!flowName.trim() || !flowStepRef.trim()) return;
    let template: unknown = {};
    try { template = flowTemplate.trim() ? JSON.parse(flowTemplate) : {}; }
    catch { return showToast("Step template is not valid JSON", "error"); }
    setBusy(true);
    const trigger = flowTrigger === "webhook" ? { kind: "webhook" } : { kind: "schedule", cadence: { daysOfWeek: [], hour: 8, minute: 0 } };
    const response = await apiResult<{ flow: Flow; invokeUrl?: string; secret?: string }>("/api/flows", {
      method: "POST", body: JSON.stringify({ name: flowName.trim(), trigger, steps: [{ kind: flowStepKind, ref: flowStepRef.trim(), template }] }),
    });
    setBusy(false);
    if (!response.ok) return showToast(response.error, "error");
    setCreateFlow(false); setFlowName(""); setFlowStepRef("");
    if (response.secret && response.invokeUrl) setSecretNotice({ label: response.flow.name, secret: response.secret, url: `${window.location.origin}${response.invokeUrl}`, sampleTask: "Flow trigger payload, e.g. {\"body\":{\"email\":\"a@x.com\"}}" });
    else showToast("Flow created", "success");
    await refresh();
  }

  async function toggleFlow(flow: Flow) {
    const response = await apiResult<{ flow: Flow }>(`/api/flows/${encodeURIComponent(flow.id)}`, {
      method: "PATCH", body: JSON.stringify({ enabled: !flow.enabled }),
    });
    if (!response.ok) return showToast(response.error, "error");
    await refresh();
  }

  async function removeFlow() {
    if (!deleteFlow) return;
    const response = await apiResult(`/api/flows/${encodeURIComponent(deleteFlow.id)}`, { method: "DELETE" });
    if (!response.ok) return showToast(response.error, "error");
    setDeleteFlow(null); showToast("Flow removed", "success"); await refresh();
  }

  async function fireFlow(flow: Flow) {
    const response = await apiResult<{ runId: string }>(`/api/flows/${encodeURIComponent(flow.id)}/fire`, { method: "POST", body: JSON.stringify({ payload: {} }) });
    if (!response.ok) return showToast(response.error, "error");
    showToast(`Flow fired (run ${response.runId.slice(0, 8)})`, "success");
    const runs = await apiResult<{ runs: FlowRun[] }>(`/api/flows/${encodeURIComponent(flow.id)}/runs`);
    if (runs.ok) setFlowRuns(runs.runs);
  }

  async function testFlow(flow: Flow) {
    const response = await apiResult<{ resolved: unknown[]; warnings: string[] }>(`/api/flows/${encodeURIComponent(flow.id)}/test`, { method: "POST", body: JSON.stringify({ sample: { body: {} } }) });
    if (!response.ok) return showToast(response.error, "error");
    showToast(response.warnings.length ? `Mapper warnings: ${response.warnings.join("; ").slice(0, 200)}` : "Mapper resolved cleanly", response.warnings.length ? "info" : "success");
  }

  const readinessLabel = executor?.hermes.readiness === "ready" ? "Ready" : executor?.hermes.readiness === "install" ? "Install Hermes" : executor ? "Needs setup" : "Checking…";
  const bridgeLabel = !bridge ? "Checking…" : bridge.registered && bridge.enabled ? `${bridge.toolCount} Naxie tools connected` : "Naxie tools not connected";

  return (
    <div className="space-y-6">
      <PageHeader icon={<Workflow size={24} />} title="Automation" subtitle="Connect services that start Naxie tasks or receive updates from Naxie." action={<Button variant="subtle" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh</Button>} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="!p-4"><div className="flex items-center gap-2 text-sm font-medium"><ArrowDownToLine size={15} className="text-violet-300" /> Incoming task trigger</div><p className="text-xs text-cream-300/60 mt-2">An app sends a signed request to Naxie. Naxie creates a job and returns its job ID.</p></Card>
        <Card className="!p-4"><div className="flex items-center gap-2 text-sm font-medium"><ArrowUpFromLine size={15} className="text-violet-300" /> Outgoing event</div><p className="text-xs text-cream-300/60 mt-2">Naxie sends selected events to your endpoint, signs each request, and tracks delivery attempts.</p></Card>
        <Card className="!p-4"><div className="flex items-center gap-2 text-sm font-medium"><Activity size={15} className="text-violet-300" /> Hermes agent</div><div className="flex justify-between gap-2 text-xs text-cream-300/65 mt-2"><span>{readinessLabel}</span><span>{executor?.mode === "hermes" ? "Running tasks" : "Available"}</span></div><div className="text-[11px] text-cream-300/45 mt-1">{bridgeLabel}</div><Link to="/hermes" className="inline-flex items-center gap-1 text-xs text-violet-300 hover:text-violet-200 mt-3">Configure Hermes <ExternalLink size={11} /></Link></Card>
      </div>

      <div className="flex gap-2 border-b border-ink-800 pb-2">
        <button onClick={() => setTab("incoming")} className={`px-3 py-2 rounded-lg text-sm ${tab === "incoming" ? "bg-violet-500/15 text-violet-200" : "text-cream-300/60 hover:text-cream-100"}`}>Incoming task triggers</button>
        <button onClick={() => setTab("outgoing")} className={`px-3 py-2 rounded-lg text-sm ${tab === "outgoing" ? "bg-violet-500/15 text-violet-200" : "text-cream-300/60 hover:text-cream-100"}`}>Outgoing event destinations</button>
        <button onClick={() => setTab("flows")} className={`px-3 py-2 rounded-lg text-sm ${tab === "flows" ? "bg-violet-500/15 text-violet-200" : "text-cream-300/60 hover:text-cream-100"}`}>Flows</button>
      </div>

      {error && <ErrorState body={error} onRetry={() => void refresh()} />}
      {tab === "incoming" ? (
        <IncomingSection items={incoming} recipe={recipe} recipeId={recipeId} onRecipe={setRecipeId} onAdd={() => setCreateIncoming(true)} onRotate={rotateIncoming} onDelete={setDeleteInbound} />
      ) : tab === "outgoing" ? (
        <OutgoingSection items={outgoing} deliveries={deliveries} events={events} onAdd={() => setCreateOutgoing(true)} onRotate={rotateOutgoing} onToggle={toggleOutgoing} onDelete={setDeleteOutbound} onTest={testOutgoing} onReplay={replay} />
      ) : (
        <FlowsSection items={flows} runs={flowRuns} onAdd={() => setCreateFlow(true)} onToggle={toggleFlow} onDelete={setDeleteFlow} onTest={testFlow} onFire={fireFlow} />
      )}

      {secretNotice && <Modal open onClose={() => setSecretNotice(null)} title="Copy this secret now">
        <Notice tone="warning">This secret is shown only after creation or rotation. Copy it into your service’s secret store before closing.</Notice>
        {"url" in secretNotice && <div className="mt-3"><div className="text-xs text-cream-300/60 mb-1">Incoming trigger URL</div><code className="block break-all rounded bg-ink-950 p-2 text-xs">{secretNotice.url}</code></div>}
        <div className="mt-3"><div className="text-xs text-cream-300/60 mb-1">Secret for {secretNotice.label}</div><div className="flex gap-2"><code className="flex-1 break-all rounded bg-ink-950 p-2 text-xs">{secretNotice.secret}</code><Button variant="subtle" onClick={() => void copy(secretNotice.secret, "Secret")}><Copy size={13} /></Button></div></div>
        {"sampleTask" in secretNotice && <div className="mt-3"><div className="flex items-center justify-between gap-2"><div className="text-xs text-cream-300/60 mb-1">Copyable request example</div><Button variant="subtle" onClick={() => void copy(`curl -X POST '${secretNotice.url}' -H 'Content-Type: application/json' -H 'X-Webhook-Secret: ${secretNotice.secret}' -H 'Idempotency-Key: <upstream-event-id>' --data '${JSON.stringify({ task: secretNotice.sampleTask }).replace(/'/g, "'\\''")}'`, "Request example")}><Copy size={13} /> Copy request</Button></div><pre className="overflow-auto rounded bg-ink-950 p-2 text-[11px]">{`curl -X POST '${secretNotice.url}' -H 'Content-Type: application/json' -H 'X-Webhook-Secret: <secret>' -H 'Idempotency-Key: <upstream-event-id>' --data '${JSON.stringify({ task: secretNotice.sampleTask }).replace(/'/g, "'\\''")}'`}</pre><div className="text-[11px] text-cream-300/45 mt-1">Replace the placeholder event ID on every source event; retries with the same ID return the existing job.</div></div>}
      </Modal>}

      <Modal open={createIncoming} onClose={() => setCreateIncoming(false)} title="Create incoming task trigger">
        <div className="space-y-3">
          <p className="text-xs text-cream-300/60">Give this trigger a name. Your external service will send a task and an idempotency key to its generated URL.</p>
          <label className="block text-xs text-cream-300/60">Trigger name<input value={incomingLabel} onChange={e => setIncomingLabel(e.target.value)} placeholder="Support triage" className="mt-1 w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100" /></label>
          <label className="block text-xs text-cream-300/60">Recipe preview<select value={recipeId} onChange={e => setRecipeId(e.target.value)} className="mt-1 w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100">{RECIPES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <p className="text-[11px] text-cream-300/50">{recipe.help} Incoming tasks still follow Naxie’s normal approval rules.</p>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCreateIncoming(false)}>Cancel</Button><Button disabled={busy || !incomingLabel.trim()} onClick={() => void addIncoming()}>{busy ? "Creating…" : "Create trigger"}</Button></div>
        </div>
      </Modal>

      <Modal open={createOutgoing} onClose={() => setCreateOutgoing(false)} title="Add event destination">
        <div className="space-y-3">
          <label className="block text-xs text-cream-300/60">Name<input value={outLabel} onChange={e => setOutLabel(e.target.value)} placeholder="Analytics pipeline" className="mt-1 w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100" /></label>
          <label className="block text-xs text-cream-300/60">Destination URL<input type="url" value={outUrl} onChange={e => setOutUrl(e.target.value)} placeholder="https://example.com/hooks/naxie" className="mt-1 w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100" /></label>
          <fieldset><legend className="text-xs text-cream-300/60 mb-1">Events to send</legend><div className="space-y-2">{events.filter(event => event.name !== "webhook.test").map(event => <label key={event.name} className="flex gap-2 text-xs text-cream-200"><input type="checkbox" checked={selectedEvents.includes(event.name)} onChange={e => setSelectedEvents(curr => e.target.checked ? [...curr, event.name] : curr.filter(v => v !== event.name))} /><span><code>{event.name}</code><span className="block text-cream-300/45">{event.description}</span></span></label>)}</div><div className="text-[11px] text-cream-300/45 mt-2">No events selected means all current and future events.</div></fieldset>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCreateOutgoing(false)}>Cancel</Button><Button disabled={busy || !outLabel.trim() || !outUrl.trim()} onClick={() => void addOutgoing()}>{busy ? "Adding…" : "Add destination"}</Button></div>
        </div>
      </Modal>

      <Modal open={createFlow} onClose={() => setCreateFlow(false)} title="Create flow">
        <div className="space-y-3">
          <p className="text-xs text-cream-300/60">A flow runs ordered steps when its trigger fires. Tokens like <code>{"{{$.trigger.body.email}}"}</code> map trigger data into step inputs without the LLM.</p>
          <label className="block text-xs text-cream-300/60">Flow name<input value={flowName} onChange={e => setFlowName(e.target.value)} placeholder="Stripe → CRM" className="mt-1 w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100" /></label>
          <label className="block text-xs text-cream-300/60">Trigger<select value={flowTrigger} onChange={e => setFlowTrigger(e.target.value as "webhook" | "schedule")} className="mt-1 w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100"><option value="webhook">Webhook (per-flow URL + secret)</option><option value="schedule">Schedule (daily 08:00, editable via API)</option></select></label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-cream-300/60">First step<select value={flowStepKind} onChange={e => setFlowStepKind(e.target.value)} className="mt-1 w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100"><option value="connector.call">Connector call</option><option value="webhook.publish">Publish event</option><option value="agent.task">Agent task</option></select></label>
            <label className="block text-xs text-cream-300/60">Ref (connector / event / task)<input value={flowStepRef} onChange={e => setFlowStepRef(e.target.value)} placeholder="crm" className="mt-1 w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100" /></label>
          </div>
          <label className="block text-xs text-cream-300/60">Step template (JSON, {"{{$.trigger…}}"} tokens)<textarea value={flowTemplate} onChange={e => setFlowTemplate(e.target.value)} rows={5} spellCheck={false} className="mt-1 w-full bg-ink-950 border border-ink-800 rounded-md px-3 py-2 text-xs font-mono text-cream-100" /></label>
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCreateFlow(false)}>Cancel</Button><Button disabled={busy || !flowName.trim() || !flowStepRef.trim()} onClick={() => void addFlow()}>{busy ? "Creating…" : "Create flow"}</Button></div>
        </div>
      </Modal>

      <ConfirmDialog open={deleteFlow !== null} title="Remove flow?" body="Its trigger URL stops working and scheduled fires stop. Run history stays on disk." rows={deleteFlow ? [["Name", deleteFlow.name], ["Steps", String(deleteFlow.steps.length)]] : []} confirmLabel="Remove flow" danger onConfirm={() => void removeFlow()} onCancel={() => setDeleteFlow(null)} />
      <ConfirmDialog open={deleteInbound !== null} title="Remove incoming trigger?" body="The endpoint secret will stop working and future requests will be rejected." rows={deleteInbound ? [["Name", deleteInbound.targetId], ["Requests received", String(deleteInbound.hitCount)]] : []} confirmLabel="Remove trigger" danger onConfirm={() => void removeIncoming()} onCancel={() => setDeleteInbound(null)} />
      <ConfirmDialog open={deleteOutbound !== null} title="Remove event destination?" body="Naxie will stop sending events to this endpoint. Delivery history remains available." rows={deleteOutbound ? [["Name", deleteOutbound.label], ["URL", deleteOutbound.url]] : []} confirmLabel="Remove destination" danger onConfirm={() => void removeOutgoing()} onCancel={() => setDeleteOutbound(null)} />
    </div>
  );
}

function FlowsSection({ items, runs, onAdd, onToggle, onDelete, onTest, onFire }: {
  items: Flow[] | null; runs: FlowRun[] | null; onAdd: () => void;
  onToggle: (flow: Flow) => void; onDelete: (flow: Flow) => void;
  onTest: (flow: Flow) => void; onFire: (flow: Flow) => void;
}) {
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><div><h2 className="font-medium text-cream-50">Trigger → steps automations</h2><p className="text-xs text-cream-300/50 mt-1">Deterministic field mapping first; the agent only runs on agent.task steps.</p></div><Button onClick={onAdd}><Plus size={13} /> Create flow</Button></div>
    {items === null ? <div className="text-sm text-cream-300/50">Loading flows…</div> : items.length === 0 ? <EmptyState icon={Workflow} title="No flows" body="Create one: a webhook trigger plus a connector call with {{$.trigger…}} tokens." action={<Button onClick={onAdd}><Plus size={13} /> Create flow</Button>} /> : <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{items.map(flow => <Card key={flow.id} className={flow.enabled ? "" : "opacity-60"}>
      <div className="flex items-start justify-between gap-3"><div><div className="font-medium text-cream-50">{flow.name}</div><div className="text-[11px] text-cream-300/45 mt-1">{flow.trigger.kind} · {flow.steps.length} step{flow.steps.length === 1 ? "" : "s"} · {flow.steps.map(s => s.kind).join(" → ")}</div></div><span className={`text-[10px] h-fit rounded-full px-2 py-1 ${flow.enabled ? "bg-leaf-500/10 text-leaf-300" : "bg-ink-800 text-cream-300/55"}`}>{flow.enabled ? "enabled" : "paused"}</span></div>
      {flow.invokeUrl && <code className="block text-[11px] text-cream-200 bg-ink-950 p-2 rounded mt-3 break-all">{window.location.origin}{flow.invokeUrl}</code>}
      <div className="flex flex-wrap gap-1.5 mt-3"><Button variant="subtle" onClick={() => onFire(flow)}><Send size={12} /> Run now</Button><Button variant="subtle" onClick={() => onTest(flow)}><ShieldCheck size={12} /> Test mapper</Button><Button variant="subtle" onClick={() => onToggle(flow)}><RotateCw size={12} /> {flow.enabled ? "Pause" : "Enable"}</Button><Button variant="ghost" onClick={() => onDelete(flow)}><Trash2 size={12} /> Remove</Button></div>
    </Card>)}</div>}
    {runs && runs.length > 0 && <section><h3 className="text-sm font-medium text-cream-100 mb-2">Latest runs</h3><div className="space-y-1.5 max-h-64 overflow-y-auto">{runs.map(run => <div key={run.id} className="rounded-md bg-ink-950/50 border border-ink-800 px-3 py-2 text-xs"><span className={`text-[9px] px-1.5 py-0.5 rounded-full ${run.status === "succeeded" ? "bg-leaf-500/15 text-leaf-400" : run.status === "failed" ? "bg-coral-500/15 text-coral-400" : "bg-ink-800 text-cream-300/60"}`}>{run.status}</span><span className="ml-2 text-cream-300/60">attempt {run.attempts} · {run.stepResults.map(s => `${s.stepId}:${s.status}`).join(", ")}</span>{run.lastError && <span className="block text-[10px] text-coral-300/80 break-all mt-1">{run.lastError}</span>}</div>)}</div></section>}
    <Notice tone="info">Webhook flows answer in under 50 ms with a run ID and execute async. Step outputs are previewed (2 KB) on the run — full bodies stay server-side.</Notice>
  </div>;
}

function IncomingSection({ items, recipe, recipeId, onRecipe, onAdd, onRotate, onDelete }: {
  items: InboundTarget[] | null; recipe: Recipe; recipeId: string; onRecipe: (value: string) => void; onAdd: () => void;
  onRotate: (target: InboundTarget) => void; onDelete: (target: InboundTarget) => void;
}) {
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><div><h2 className="font-medium text-cream-50">Apps that can start Naxie work</h2><p className="text-xs text-cream-300/50 mt-1">Requests create a normal Naxie job. Use an upstream event ID as the idempotency key.</p></div><Button onClick={onAdd}><Plus size={13} /> Create trigger</Button></div>
    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">{RECIPES.map(item => <button key={item.id} onClick={() => { onRecipe(item.id); onAdd(); }} className={`text-left rounded-lg border p-3 ${recipeId === item.id ? "border-violet-500/40 bg-violet-500/5" : "border-ink-800 hover:border-violet-500/25"}`}><div className="text-xs font-medium text-cream-100">{item.label}</div><div className="text-[11px] text-cream-300/50 mt-1">{item.help}</div></button>)}</div>
    {items === null ? <div className="text-sm text-cream-300/50">Loading incoming triggers…</div> : items.length === 0 ? <EmptyState icon={Webhook} title="No incoming triggers" body="Create one to let Zapier, Make, or another service start a Naxie task." action={<Button onClick={onAdd}><Plus size={13} /> Create trigger</Button>} /> : <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{items.map(item => <Card key={item.id}>
      <div className="flex items-start justify-between gap-3"><div><div className="font-medium text-cream-50">{item.targetId}</div><div className="text-[11px] text-cream-300/45 mt-1">{item.targetKind === "task" ? "Task trigger" : `Connected to ${item.targetKind}`}</div></div><span className="text-[10px] rounded-full px-2 py-1 bg-leaf-500/10 text-leaf-300">active</span></div>
      <code className="block text-[11px] text-cream-200 bg-ink-950 p-2 rounded mt-3 break-all">{window.location.origin}{item.urlPath}</code>
      <div className="text-[11px] text-cream-300/45 mt-2">{item.hitCount} requests · last received {age(item.lastHitAt)}</div>
      {item.recentJobIds.length > 0 && <div className="mt-2 text-[11px] text-cream-300/45">Recent jobs: {item.recentJobIds.map((jobId, index) => <span key={jobId}>{index > 0 ? ", " : " "}<Link className="text-violet-300 hover:text-violet-200" to={`/runs/${encodeURIComponent(jobId)}`}>{jobId.slice(0, 8)}</Link></span>)}</div>}
      <div className="flex gap-2 mt-3"><Button variant="subtle" onClick={() => onRotate(item)}><RotateCw size={12} /> Rotate secret</Button><Button variant="ghost" onClick={() => onDelete(item)}><Trash2 size={12} /> Remove</Button></div>
    </Card>)}</div>}
    <Notice tone="info">Incoming requests require <code>X-Webhook-Secret</code>. Naxie can deduplicate retries when the caller also sends a stable <code>Idempotency-Key</code>. Job actions continue to use Naxie’s approval flow.</Notice>
  </div>;
}

function OutgoingSection({ items, deliveries, events, onAdd, onRotate, onToggle, onDelete, onTest, onReplay }: {
  items: OutboundTarget[] | null; deliveries: Delivery[] | null; events: EventOption[]; onAdd: () => void;
  onRotate: (target: OutboundTarget) => void; onToggle: (target: OutboundTarget) => void; onDelete: (target: OutboundTarget) => void;
  onTest: (target: OutboundTarget) => void; onReplay: (delivery: Delivery) => void;
}) {
  const targetLabel = (id: string) => items?.find(target => target.id === id)?.label ?? id.slice(0, 8);
  return <div className="space-y-5">
    <div className="flex items-center justify-between gap-3"><div><h2 className="font-medium text-cream-50">Where Naxie can send updates</h2><p className="text-xs text-cream-300/50 mt-1">Requests use HMAC-SHA256 signatures. Failed deliveries retry with backoff and can be replayed.</p></div><Button onClick={onAdd}><Plus size={13} /> Add destination</Button></div>
    {items === null ? <div className="text-sm text-cream-300/50">Loading event destinations…</div> : items.length === 0 ? <EmptyState icon={Webhook} title="No event destinations" body="Add an endpoint to receive published Naxie events." action={<Button onClick={onAdd}><Plus size={13} /> Add destination</Button>} /> : <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{items.map(target => <Card key={target.id} className={target.enabled ? "" : "opacity-60"}>
      <div className="flex justify-between gap-3"><div className="min-w-0"><div className="font-medium text-cream-50 truncate">{target.label}</div><div className="text-[11px] text-cream-300/45 truncate mt-1">{target.url}</div><div className="text-[11px] text-cream-300/45 mt-1">{target.events.length ? target.events.join(", ") : "All events"}</div><div className="text-[10px] text-cream-300/35 mt-2">Signing secret {target.secretConfigured ? "configured" : "missing"}</div></div><span className={`text-[10px] h-fit rounded-full px-2 py-1 ${target.enabled ? "bg-leaf-500/10 text-leaf-300" : "bg-ink-800 text-cream-300/55"}`}>{target.enabled ? "enabled" : "paused"}</span></div>
      <div className="flex flex-wrap gap-1.5 mt-3"><Button variant="subtle" onClick={() => onTest(target)}><Send size={12} /> Send test</Button><Button variant="subtle" onClick={() => onToggle(target)}><RotateCw size={12} /> {target.enabled ? "Pause" : "Enable"}</Button><Button variant="subtle" onClick={() => onRotate(target)}><ShieldCheck size={12} /> Rotate secret</Button><Button variant="ghost" onClick={() => onDelete(target)}><Trash2 size={12} /> Remove</Button></div>
    </Card>)}</div>}
    <section><h3 className="text-sm font-medium text-cream-100 mb-2">Recent delivery attempts</h3>{deliveries === null ? <div className="text-xs text-cream-300/50">Loading…</div> : deliveries.length === 0 ? <EmptyState icon={Activity} title="No delivery history" body="Send a test event or wait for Naxie to publish an event." /> : <div className="space-y-1.5 max-h-96 overflow-y-auto">{deliveries.map(delivery => <div key={delivery.id} className="rounded-md bg-ink-950/50 border border-ink-800 px-3 py-2 flex flex-wrap items-center gap-2 text-xs">
      <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${STATUS_COLOR[delivery.status]}`}>{delivery.status.replace("_", " ")}</span><code className="text-cream-100">{delivery.event}</code><span className="text-cream-300/45">→ {targetLabel(delivery.targetId)}</span><span className="text-cream-300/40">attempt {delivery.attempts}</span><span className="text-cream-300/30 ml-auto">{age(delivery.lastAttemptAt ?? delivery.createdAt)}</span>
      {(delivery.status === "failed" || delivery.status === "dead_letter") && <Button variant="ghost" onClick={() => onReplay(delivery)}>Replay</Button>}{delivery.nextAttemptAt && delivery.status === "failed" && <span className="w-full text-[10px] text-cream-300/40">Next retry {new Date(delivery.nextAttemptAt).toLocaleString()}</span>}{delivery.lastError && <span className="w-full text-[10px] text-coral-300/80 break-all">{delivery.lastError}</span>}
    </div>)}</div>}</section>
    <div className="text-[11px] text-cream-300/45">Available events: {events.map(event => <span key={event.name} className="mr-2"><code>{event.name}</code> — {event.description}</span>)}</div>
  </div>;
}
