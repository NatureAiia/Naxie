import { useEffect, useState } from "react";
import { Cpu, Download, Trash2, Star, ChevronUp, ChevronDown, Power, Plus } from "lucide-react";
import { api, getToken, type RosterRow } from "../lib/api";
import { PageHeader } from "../components/PageHeader";
import { Card, Button, showToast } from "../components/Card";
import { Notice } from "../components/Notice";

type ModelRoster = { policy: { allowPaidModels: boolean }; offline: RosterRow[]; online: RosterRow[] };
type ModelProvider = { id: string; label: string; kind: string; baseUrl: string; model: string; active: boolean; keyPrefix: string; createdAt: string; position: number };

// Local Ollama model management + spend policy — ported from
// the earlier prototype' Models.tsx UI over Naxie's already-built,
// previously-unused models.ts backend (roster/catalog/pull/policy).
export function Models() {
  const [roster, setRoster] = useState<ModelRoster | null>(null);
  const [catalog, setCatalog] = useState<{ name: string; size: string; blurb: string; installed: boolean }[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState("");
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [kinds, setKinds] = useState<Record<string, { label: string; baseUrl: string; modelHint: string }>>({});
  const [showAdd, setShowAdd] = useState(false);
  const [fKind, setFKind] = useState("ollama_cloud");
  const [fLabel, setFLabel] = useState("");
  const [fModel, setFModel] = useState("");
  const [fKey, setFKey] = useState("");
  const [fBase, setFBase] = useState("");

  async function load() {
    try {
      const [r, c, p] = await Promise.all([api.getModelRoster(), api.modelCatalog(), api.listModelProviders().catch(() => null)]);
      setRoster(r);
      setCatalog(c.catalog);
      if (p) {
        setProviders([...p.providers].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
        setKinds(p.kinds ?? {});
        const firstKind = Object.keys(p.kinds ?? {})[0];
        if (firstKind) setFKind(f => (p.kinds as any)[f] ? f : firstKind);
      }
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

  async function activateProvider(id: string) {
    try { await api.activateModelProvider(id); showToast("Provider activated", "success"); void load(); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  async function removeProvider(p: ModelProvider) {
    if (!confirm(`Remove provider "${p.label}"?${p.active ? " It is ACTIVE — traffic falls back to the .env-configured endpoint." : ""}`)) return;
    try { await api.removeModelProvider(p.id); showToast("Provider removed", "success"); void load(); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  async function moveProvider(id: string, dir: -1 | 1) {
    const idx = providers.findIndex(p => p.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= providers.length) return;
    const next = [...providers];
    [next[idx], next[j]] = [next[j], next[idx]];
    setProviders(next);
    try {
      const r = await api.reorderModelProviders(next.map(p => p.id));
      setProviders([...r.providers].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
      void load();
    }
  }

  async function addProvider() {
    if (!fModel.trim() || !fKey.trim()) { showToast("Model + API key are required", "error"); return; }
    try {
      await api.addModelProvider({
        kind: fKind,
        model: fModel.trim(),
        apiKey: fKey.trim(),
        label: fLabel.trim() || undefined,
        baseUrl: fBase.trim() || undefined,
        active: providers.length === 0,
      });
      showToast("Provider added", "success");
      setShowAdd(false); setFLabel(""); setFModel(""); setFKey(""); setFBase("");
      void load();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  const FIELD = "w-full rounded-md bg-ink-950/60 border border-ink-800 px-2.5 py-1.5 text-xs text-cream-100 placeholder:text-cream-300/30 focus:outline-none focus:border-violet-500/50";

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

      <Card title="Cloud providers (priority order)">
        <p className="text-[11px] text-cream-300/50 mb-2">
          The badged row is the active provider. When it fails, the others are tried top-to-bottom, then local Ollama.
        </p>
        <div className="space-y-1.5">
          {providers.map((p, i) => (
            <div key={p.id} className={`flex items-center gap-1.5 text-xs rounded-md border px-2 py-2 ${p.active ? "bg-violet-500/10 border-violet-500/40" : "bg-ink-950/50 border-ink-800"}`}>
              <span className="text-cream-300/40 font-mono w-5 text-center shrink-0">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <span className="text-cream-100">{p.label}</span>
                <span className="text-cream-300/40 ml-1.5">{kinds[p.kind]?.label ?? p.kind}</span>
                <div className="text-cream-300/50 truncate font-mono">{p.model} <span className="text-cream-300/30">· {p.keyPrefix}</span></div>
              </div>
              {p.active && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300 shrink-0">active</span>}
              <button type="button" onClick={() => void moveProvider(p.id, -1)} disabled={i === 0} title="Move up (higher priority)" className="p-1 rounded-md border border-ink-800 hover:border-violet-500/40 text-cream-300/60 hover:text-cream-100 disabled:opacity-30">
                <ChevronUp size={12} />
              </button>
              <button type="button" onClick={() => void moveProvider(p.id, 1)} disabled={i === providers.length - 1} title="Move down (lower priority)" className="p-1 rounded-md border border-ink-800 hover:border-violet-500/40 text-cream-300/60 hover:text-cream-100 disabled:opacity-30">
                <ChevronDown size={12} />
              </button>
              {!p.active && (
                <button type="button" onClick={() => void activateProvider(p.id)} title="Make active" className="p-1 rounded-md border border-ink-800 hover:border-leaf-500/40 text-cream-300/60 hover:text-leaf-400">
                  <Power size={12} />
                </button>
              )}
              <button type="button" onClick={() => void removeProvider(p)} title="Remove provider" className="p-1 rounded-md border border-ink-800 hover:border-coral-500/40 text-cream-300/60 hover:text-coral-400">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {providers.length === 0 && <div className="text-xs text-cream-300/40 py-2">No cloud providers yet — add one below, or run fully local.</div>}
        </div>
        {!showAdd ? (
          <Button variant="subtle" onClick={() => setShowAdd(true)} className="mt-2">
            <Plus size={12} className="mr-1 inline" /> Add provider
          </Button>
        ) : (
          <div className="mt-2 rounded-md border border-ink-800 bg-ink-950/50 p-2.5 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-cream-300/60">Kind
                <select value={fKind} onChange={e => { setFKind(e.target.value); setFModel(""); setFBase(""); }} className={`${FIELD} mt-1`}>
                  {Object.entries(kinds).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </label>
              <label className="text-[11px] text-cream-300/60">Label (optional)
                <input value={fLabel} onChange={e => setFLabel(e.target.value)} placeholder={kinds[fKind]?.label ?? ""} className={`${FIELD} mt-1`} />
              </label>
            </div>
            <label className="text-[11px] text-cream-300/60 block">Model
              <input value={fModel} onChange={e => setFModel(e.target.value)} placeholder={kinds[fKind]?.modelHint ?? "model id"} className={`${FIELD} mt-1 font-mono`} />
            </label>
            <label className="text-[11px] text-cream-300/60 block">API key
              <input type="password" value={fKey} onChange={e => setFKey(e.target.value)} placeholder="sk-…" autoComplete="off" className={`${FIELD} mt-1 font-mono`} />
            </label>
            {fKind === "custom" && (
              <label className="text-[11px] text-cream-300/60 block">Base URL (OpenAI-compatible)
                <input value={fBase} onChange={e => setFBase(e.target.value)} placeholder="https://…" autoComplete="off" spellCheck={false} className={`${FIELD} mt-1 font-mono`} />
              </label>
            )}
            <div className="flex gap-2">
              <Button variant="subtle" onClick={() => void addProvider()}>Save provider</Button>
              <button type="button" onClick={() => setShowAdd(false)} className="text-xs text-cream-300/60 hover:text-cream-100 px-2">Cancel</button>
            </div>
          </div>
        )}
      </Card>

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
