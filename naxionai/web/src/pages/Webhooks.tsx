import { useEffect, useState } from "react";
import { Webhook, Plus, RotateCw, Trash2, Send, RefreshCw } from "lucide-react";
import { apiResult } from "../lib/apiResult";
import { PageHeader } from "../components/PageHeader";
import { Card, Button, showToast } from "../components/Card";
import { Modal, ConfirmDialog } from "../components/Modal";
import { Notice } from "../components/Notice";
import { EmptyState, ErrorState } from "../components/States";

type WebhookTarget = {
  id: string;
  label: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
};

type WebhookDeliveryStatus = "pending" | "success" | "failed" | "dead_letter";

type WebhookDelivery = {
  id: string;
  targetId: string;
  event: string;
  payload: unknown;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  createdAt: string;
};

const STATUS_COLOR: Record<WebhookDeliveryStatus, string> = {
  pending: "bg-ink-800 text-cream-300/60",
  success: "bg-leaf-500/15 text-leaf-400",
  failed: "bg-amber-400/15 text-amber-300",
  dead_letter: "bg-coral-500/15 text-coral-400",
};

function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function Webhooks() {
  const [targets, setTargets] = useState<WebhookTarget[] | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [err, setErr] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WebhookTarget | null>(null);

  async function load() {
    const [t, d] = await Promise.all([
      apiResult<{ targets: WebhookTarget[] }>("/api/webhooks/targets"),
      apiResult<{ deliveries: WebhookDelivery[] }>("/api/webhooks/deliveries"),
    ]);
    if (!t.ok) { setErr(t.error); setTargets([]); } else { setTargets(t.targets); setErr(""); }
    if (d.ok) setDeliveries(d.deliveries);
  }
  useEffect(() => { void load(); const i = setInterval(load, 10000); return () => clearInterval(i); }, []);

  async function submitCreate() {
    if (!label.trim() || !url.trim()) return;
    setBusy(true);
    const r = await apiResult<{ target: WebhookTarget }>("/api/webhooks/targets", {
      method: "POST",
      body: JSON.stringify({ label, url, events: events.split(",").map(s => s.trim()).filter(Boolean) }),
    });
    setBusy(false);
    if (!r.ok) return showToast(r.error, "error");
    showToast(`Added "${r.target.label}"`, "success");
    setCreateOpen(false);
    setLabel(""); setUrl(""); setEvents("");
    void load();
  }

  async function toggleEnabled(t: WebhookTarget) {
    const r = await apiResult<{ target: WebhookTarget }>(`/api/webhooks/targets/${encodeURIComponent(t.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !t.enabled }),
    });
    if (!r.ok) return showToast(r.error, "error");
    void load();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const r = await apiResult(`/api/webhooks/targets/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" });
    if (!r.ok) return showToast((r as any).error, "error");
    showToast("Target removed", "success");
    setDeleteTarget(null);
    void load();
  }

  async function sendTest(t: WebhookTarget) {
    const r = await apiResult<{ dispatched: number }>("/api/webhooks/test", {
      method: "POST",
      body: JSON.stringify({ targetId: t.id }),
    });
    if (!r.ok) return showToast(r.error, "error");
    showToast(r.dispatched > 0 ? "Test event sent" : "Target didn't receive it (disabled or filtered)", r.dispatched > 0 ? "success" : "error");
    void load();
  }

  async function replay(d: WebhookDelivery) {
    const r = await apiResult<{ delivery: WebhookDelivery }>(`/api/webhooks/deliveries/${encodeURIComponent(d.id)}/replay`, { method: "POST" });
    if (!r.ok) return showToast(r.error, "error");
    showToast(r.delivery.status === "success" ? "Replay succeeded" : `Replay ${r.delivery.status}`, r.delivery.status === "success" ? "success" : "error");
    void load();
  }

  const targetLabel = (id: string) => targets?.find(t => t.id === id)?.label ?? id.slice(0, 8);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Webhook size={24} />}
        title="Webhooks"
        subtitle="Register standing outbound integrations — Naxie signs every delivery (HMAC-SHA256) and retries a failed one automatically until it succeeds or exhausts its retry budget."
        action={
          <div className="flex gap-2">
            <button type="button" onClick={() => void load()} className="text-xs px-3 py-1.5 rounded-md border border-ink-700 hover:border-violet-500/40 text-cream-300 hover:text-cream-100 flex items-center gap-1.5">
              <RefreshCw size={13} /> Refresh
            </button>
            <Button onClick={() => setCreateOpen(true)}><Plus size={14} className="mr-1 inline" /> Add target</Button>
          </div>
        }
      />

      <Notice tone="info">
        A target's signing secret verifies the request came from Naxie: compute HMAC-SHA256 of the raw request
        body with the secret and compare it to the <code>X-Webhook-Signature</code> header (<code>sha256=&lt;hex&gt;</code>).
        Leave "events" blank to receive every event Naxie publishes (today: <code>dataset.published</code> when the
        ADRS pipeline publishes a dataset).
      </Notice>

      {err && <ErrorState body={err} onRetry={() => void load()} />}

      {targets !== null && targets.length === 0 && !err && (
        <EmptyState icon={Webhook} title="No webhook targets yet" body="Add one to start receiving Naxie's published events." action={<Button onClick={() => setCreateOpen(true)}>Add target</Button>} />
      )}

      {targets !== null && targets.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {targets.map(t => (
            <Card key={t.id} className={t.enabled ? "" : "opacity-60"}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-cream-50 truncate">{t.label}</div>
                  <div className="text-[11px] text-cream-300/50 truncate mt-0.5">{t.url}</div>
                  <div className="text-[11px] text-cream-300/40 mt-1">
                    {t.events.length === 0 ? "all events" : t.events.join(", ")}
                  </div>
                  <div className="text-[10px] text-cream-300/30 mt-2 font-mono truncate" title={t.secret}>secret: {t.secret.slice(0, 10)}…</div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${t.enabled ? "bg-leaf-500/15 text-leaf-400" : "bg-ink-800 text-cream-300/50"}`}>
                    {t.enabled ? "enabled" : "disabled"}
                  </span>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => void sendTest(t)} title="Send test event" className="p-1.5 rounded-md border border-ink-800 hover:border-violet-500/40 text-cream-300/70 hover:text-cream-100">
                      <Send size={12} />
                    </button>
                    <button type="button" onClick={() => void toggleEnabled(t)} title={t.enabled ? "Disable" : "Enable"} className="p-1.5 rounded-md border border-ink-800 hover:border-violet-500/40 text-cream-300/70 hover:text-cream-100">
                      <RotateCw size={12} />
                    </button>
                    <button type="button" onClick={() => setDeleteTarget(t)} title="Remove" className="p-1.5 rounded-md border border-ink-800 hover:border-coral-500/40 text-cream-300/70 hover:text-coral-400">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div>
        <h2 className="text-sm font-medium text-cream-100 mb-2">Delivery log</h2>
        {deliveries === null ? (
          <div className="text-sm text-cream-300/60">Loading…</div>
        ) : deliveries.length === 0 ? (
          <EmptyState icon={Webhook} title="No deliveries yet" body="Attempts will show up here once an event is published or a test is sent." />
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {deliveries.map(d => (
              <div key={d.id} className="text-xs rounded-md bg-ink-950/50 border border-ink-800 px-2.5 py-2 flex items-center gap-2">
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_COLOR[d.status]}`}>{d.status}</span>
                <span className="text-cream-100 truncate">{d.event}</span>
                <span className="text-cream-300/40 truncate">→ {targetLabel(d.targetId)}</span>
                <span className="text-cream-300/40 shrink-0">attempt {d.attempts}</span>
                <span className="text-cream-300/30 shrink-0 ml-auto">{relTime(d.lastAttemptAt ?? d.createdAt)}</span>
                {(d.status === "failed" || d.status === "dead_letter") && (
                  <button type="button" onClick={() => void replay(d)} className="shrink-0 text-[10px] px-2 py-0.5 rounded-full border border-ink-700 hover:border-violet-500/40 text-cream-300/70 hover:text-cream-100">
                    Replay
                  </button>
                )}
                {d.lastError && <span className="w-full text-coral-400/80 text-[10px] truncate" title={d.lastError}>{d.lastError}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Add webhook target">
        <div className="space-y-3">
          <div>
            <label className="text-xs text-cream-300/60 block mb-1">Label</label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="My CRM" className="w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100" />
          </div>
          <div>
            <label className="text-xs text-cream-300/60 block mb-1">URL</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/webhooks/naxie" className="w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100" />
          </div>
          <div>
            <label className="text-xs text-cream-300/60 block mb-1">Events (comma-separated, blank = all)</label>
            <input value={events} onChange={e => setEvents(e.target.value)} placeholder="dataset.published" className="w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => void submitCreate()} disabled={busy || !label.trim() || !url.trim()}>{busy ? "…" : "Add"}</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove webhook target?"
        body="Naxie will stop sending events to this URL. Its delivery history stays in the log."
        rows={deleteTarget ? [["Label", deleteTarget.label], ["URL", deleteTarget.url]] : []}
        confirmLabel="Remove"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
