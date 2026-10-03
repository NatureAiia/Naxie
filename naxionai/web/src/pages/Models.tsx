import { useEffect, useState } from "react";
import { Cpu, Download, Trash2, Star } from "lucide-react";
import { api, getToken, type RosterRow } from "../lib/api";
import { PageHeader } from "../components/PageHeader";
import { Card, Button, showToast } from "../components/Card";
import { Notice } from "../components/Notice";

type ModelRoster = { policy: { allowPaidModels: boolean }; offline: RosterRow[]; online: RosterRow[] };

// Local Ollama model management + spend policy — ported from
// the earlier prototype' Models.tsx UI over Naxie's already-built,
// previously-unused models.ts backend (roster/catalog/pull/policy).
export function Models() {
  const [roster, setRoster] = useState<ModelRoster | null>(null);
  const [catalog, setCatalog] = useState<{ name: string; size: string; blurb: string; installed: boolean }[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState("");

  async function load() {
    try {
      const [r, c] = await Promise.all([api.getModelRoster(), api.modelCatalog()]);
      setRoster(r);
      setCatalog(c.catalog);
    } catch { /* ignore */ }
  }
  useEffect(() => { void load(); }, []);

  async function togglePolicy() {
    if (!roster) return;
    try {
      await api.setModelPolicy(!roster.policy.allowPaidModels);
      void load();
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    }
  }

  async function pull(name: string) {
    setPulling(name);
    setPullProgress("starting…");
    try {
      const token = getToken();
      const res = await fetch("/api/models/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ name }),
      });
      if (!res.body) throw new Error("no response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const evt of events) {
          const dataLine = evt.split("\n").find(l => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            const data = JSON.parse(dataLine.slice(6));
            if (data.error) { showToast(data.error, "error"); }
            else if (data.status) { setPullProgress(data.status); }
          } catch { /* skip partial */ }
        }
      }
      showToast(`${name} pulled`, "success");
      void load();
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setPulling(null);
      setPullProgress("");
    }
  }

  async function remove(name: string) {
    if (!confirm(`Remove locally-pulled model "${name}"?`)) return;
    try { await api.deleteModel(name); void load(); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  async function setDefault(name: string) {
    try { await api.setDefaultModel(name); showToast(`Default set to ${name}`, "success"); void load(); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Cpu size={24} />}
        title="Models"
        subtitle="Local Ollama models and cloud provider spend, in one place."
      />

      {roster && (
        <Notice tone={roster.policy.allowPaidModels ? "warning" : "info"}>
          Paid cloud models are currently <strong>{roster.policy.allowPaidModels ? "allowed" : "blocked"}</strong> — until allowed, any paid-model pick is downgraded to a free or local model.
          <button type="button" onClick={() => void togglePolicy()} className="ml-2 underline">
            {roster.policy.allowPaidModels ? "Block paid models" : "Allow paid models"}
          </button>
        </Notice>
      )}

      <Card title="Local models (offline)">
        <div className="space-y-1.5">
          {(roster?.offline ?? []).map(m => (
            <div key={m.name} className="flex items-center gap-2 text-xs rounded-md bg-ink-950/50 border border-ink-800 px-2.5 py-2">
              <span className="text-cream-100 flex-1 truncate">{m.name}</span>
              {m.active && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300">default</span>}
              <span className="text-cream-300/40">{m.calls} calls</span>
              {!m.active && (
                <button type="button" onClick={() => void setDefault(m.name)} title="Set as default" className="p-1 rounded-md border border-ink-800 hover:border-violet-500/40 text-cream-300/60 hover:text-cream-100">
                  <Star size={12} />
                </button>
              )}
              <button type="button" onClick={() => void remove(m.name)} className="p-1 rounded-md border border-ink-800 hover:border-coral-500/40 text-cream-300/60 hover:text-coral-400">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {(roster?.offline ?? []).length === 0 && <div className="text-xs text-cream-300/40 py-2">No local models pulled yet.</div>}
        </div>
      </Card>

      <Card title="Pull a model">
        <div className="space-y-1.5">
          {catalog.map(c => (
            <div key={c.name} className="flex items-center gap-2 text-xs rounded-md bg-ink-950/50 border border-ink-800 px-2.5 py-2">
              <div className="flex-1 min-w-0">
                <span className="text-cream-100">{c.name}</span>
                <span className="text-cream-300/40 ml-1.5">({c.size})</span>
                <div className="text-cream-300/50 truncate">{c.blurb}</div>
              </div>
              {c.installed ? (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-leaf-500/15 text-leaf-400 shrink-0">installed</span>
              ) : (
                <Button variant="subtle" onClick={() => void pull(c.name)} disabled={pulling !== null} className="shrink-0">
                  {pulling === c.name ? (pullProgress || "pulling…") : <><Download size={12} className="mr-1 inline" /> Pull</>}
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Cloud / online models">
        <div className="space-y-1.5">
          {(roster?.online ?? []).map(m => (
            <div key={m.name} className="flex items-center gap-2 text-xs rounded-md bg-ink-950/50 border border-ink-800 px-2.5 py-2">
              <span className="text-cream-100 flex-1 truncate">{m.name}</span>
              {m.providerLabel && <span className="text-cream-300/40">{m.providerLabel}</span>}
              {m.tier && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60">{m.tier}</span>}
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${m.free ? "bg-leaf-500/15 text-leaf-400" : "bg-amber-400/15 text-amber-300"}`}>{m.free ? "free" : "paid"}</span>
              <span className="text-cream-300/40">${m.costUsd.toFixed(4)}</span>
            </div>
          ))}
          {(roster?.online ?? []).length === 0 && <div className="text-xs text-cream-300/40 py-2">No cloud provider configured — add one on the connect side, or run fully local.</div>}
        </div>
      </Card>
    </div>
  );
}
