import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Puzzle, Plug, Boxes, Cpu, Cloud, KeyRound, CheckCircle2, AlertTriangle, Loader2, ExternalLink, X, Play, Settings2, Radio, Layers, Sparkles, Plus, Clock, Shield, RefreshCw, History, Copy, Upload, Webhook, Download, LayoutGrid, DollarSign, BarChart3, TrendingUp, Calendar, Hourglass, Server, MessageCircle } from "lucide-react";
import { api, type ConnectorAuthType, type RagStatus, type TimeAnalysis, type CostTrend, type RosterRow } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { Integrations } from "./Integrations";
import { WhatsApp } from "./WhatsApp";
import { AuditLog } from "./AuditLog";
import { SignalBloom } from "../components/SignalBloom";
import { GlassCard } from "../components/GlassCard";

// Extensions — Plugins & Integrations Hub
// Monitors platform APIs (OpenRouter, Supabase… env-gated) plus
// token-based integrations / model providers in one place.
// Integrations used to be its own page/route; it now lives as a tab here
// (the old /integrations URL redirects in). Connectors (company systems +
// personal Google/Microsoft accounts) and MCP Servers each moved OUT to
// their own top-level pages under Connect — see pages/Connectors.tsx,
// pages/McpServers.tsx, and Layout.tsx's connectNav.
// Env secrets are never returned — only prefix + enabled/health.

type ExtTab = "overview" | "platform" | "integrations" | "audit" | "cost" | "whatsapp";

const TABS: { id: ExtTab; label: string; icon: any }[] = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "platform", label: "Platform APIs", icon: Cpu },
  { id: "integrations", label: "Integrations", icon: Plug },
  { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
  { id: "audit", label: "Audit", icon: History },
  { id: "cost", label: "AI Models & Cost", icon: DollarSign },
];

type ExtensionCore = {
  id: string; name: string; category: string; description: string;
  envKey: string; docsUrl?: string; testable: boolean;
  enabled: boolean; configured: boolean; keyPrefix?: string; model?: string;
  detail: string; health?: { ok: boolean; detail: string };
  throttled?: boolean;
  circuit?: { state: string; failures: number; until?: string };
};

type ExtensionsSnapshot = {
  core: ExtensionCore[];
  integrations: { id: string; providerId: string; providerName: string; label: string; lastTest?: { ok: boolean; detail: string; at: string } }[];
  connectors: { id: string; label: string; baseUrl: string; lastTest?: { ok: boolean; detail: string; at: string } }[];
  providers: { id: string; label: string; kind: string; model: string; active: boolean }[];
  counts: { coreTotal: number; coreEnabled: number; coreHealthy: number; integrations: number; connectors: number; modelProviders: number };
  catalog: { id: string; name: string; connectHint: string }[];
  healthSummaries: { id: string; total: number; ok: number; fail: number; uptimePct: number; recent: any[]; spark: number[]; alert?: string }[];
  healthHistory: any[];
  costSummary: { totalCostUsd: number; callCount: number };
  alerts: { id: string; alert: string; uptimePct: number }[];
};

const CATEGORY_META: Record<string, { label: string; icon: any }> = {
  llm: { label: "LLM", icon: Cpu },
  voice: { label: "Voice", icon: Radio },
  storage: { label: "Storage", icon: Layers },
  scraping: { label: "Scraping", icon: Settings2 },
  media: { label: "Media", icon: Sparkles },
  social: { label: "Social", icon: Plug },
  infra: { label: "Infra", icon: Boxes },
};

function HealthDot({ ok, missing }: { ok?: boolean; missing?: boolean }) {
  if (missing) return <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400/80 animate-pulse" />;
  if (ok === undefined) return <span className="inline-block w-2.5 h-2.5 rounded-full bg-ink-600" />;
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${ok ? "bg-leaf-500" : "bg-coral-500"}`} />;
}

function Sparkline({ spark }: { spark: number[] }) {
  if (!spark || spark.length === 0) return <span className="text-[10px] text-cream-300/30">no history</span>;
  return (
    <span className="inline-flex items-end gap-px h-3">
      {spark.slice(-20).map((v, i) => (
        <span key={i} className={`w-1 rounded-sm ${v ? "bg-leaf-500" : "bg-coral-500"}`} style={{ height: v ? "100%" : "45%" }} title={v ? "ok" : "fail"} />
      ))}
    </span>
  );
}

function ExpiryBadge({ state, days, expiresAt }: { state?: string; days?: number; expiresAt?: string }) {
  if (!state || state === "unset") return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/40">no expiry</span>;
  if (state === "expired") return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-coral-500/20 text-coral-300 border border-coral-500/30 flex items-center gap-1"><Clock size={9} /> expired {days}d ago</span>;
  if (state === "soon") return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 flex items-center gap-1"><Clock size={9} /> {days}d left</span>;
  return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-leaf-500/10 text-leaf-400 flex items-center gap-1"><Clock size={9} /> {days}d</span>;
}

export function Extensions() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  // The old Marketplace tab was removed — its content (versioned user skills)
  // now lives on the Skills page. Deep-links land there instead of overview.
  if (tabParam === "marketplace") {
    window.location.replace("/skills");
  }
  const tab: ExtTab = tabParam && TABS.some(t => t.id === tabParam) ? (tabParam as ExtTab) : "overview";
  function setTab(t: ExtTab) {
    setSearchParams(t === "overview" ? {} : { tab: t }, { replace: true });
  }
  const [data, setData] = useState<ExtensionsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [hintFor, setHintFor] = useState<ExtensionCore | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addTab, setAddTab] = useState<"integration" | "connector" | "model">("integration");
  const [rotateTarget, setRotateTarget] = useState<{ kind: "integration" | "connector"; id: string; label: string } | null>(null);
  const [scheduler, setScheduler] = useState<any>(null);
  const [ragStatus, setRagStatus] = useState<RagStatus | null>(null);
  const [ragDbUrl, setRagDbUrl] = useState("");
  const [ragEmbedKey, setRagEmbedKey] = useState("");
  const [ragMongoUrl, setRagMongoUrl] = useState("");
  const [ragMongoDb, setRagMongoDb] = useState("naxionai");
  const [ragMongoCollection, setRagMongoCollection] = useState("vault_chunks");
  const [ragMongoIndex, setRagMongoIndex] = useState("vector_index");
  const [ragSaving, setRagSaving] = useState(false);
  const [ragReembedding, setRagReembedding] = useState(false);

  // AI Models & Cost tab
  const [costSummaryFull, setCostSummaryFull] = useState<any>(null);
  const [costLoading, setCostLoading] = useState(true);
  const [timeA, setTimeA] = useState<TimeAnalysis | null>(null);
  const [costTrendData, setCostTrendData] = useState<CostTrend | null>(null);
  const [cacheStats, setCacheStats] = useState<any>(null);
  const [roster, setRoster] = useState<{ policy: { allowPaidModels: boolean }; offline: RosterRow[]; online: RosterRow[] } | null>(null);
  const [costLoaded, setCostLoaded] = useState(false);
  function loadCostTab() {
    setCostLoaded(true);
    api.getCostSummary().then(setCostSummaryFull).catch(() => {}).finally(() => setCostLoading(false));
    api.timeAnalysis(30).then(setTimeA).catch(() => {});
    api.costTrend(14).then(setCostTrendData).catch(() => {});
    api.cacheStats().then(setCacheStats).catch(() => {});
    api.getModelRoster().then(setRoster).catch(() => {});
  }
  useEffect(() => { if (tab === "cost" && !costLoaded) loadCostTab(); }, [tab]);
  async function togglePaidModels(next: boolean) {
    try {
      const r = await api.setModelPolicy(next);
      setRoster(prev => prev ? { ...prev, policy: r.policy } : prev);
      showToast(next ? "Paid models approved" : "Paid models blocked — free tier + local only", next ? "success" : "info");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  function refreshRagStatus() {
    api.ragStatus().then(setRagStatus).catch(() => {});
  }
  async function saveRagConfig() {
    if (!ragDbUrl.trim() && !ragEmbedKey.trim() && !ragMongoUrl.trim()) return;
    setRagSaving(true);
    try {
      const patch: { supabaseDbUrl?: string; openaiEmbeddingApiKey?: string; mongodbVectorUrl?: string; mongodbVectorDb?: string; mongodbVectorCollection?: string; mongodbVectorIndex?: string } = {};
      if (ragDbUrl.trim()) patch.supabaseDbUrl = ragDbUrl.trim();
      if (ragEmbedKey.trim()) patch.openaiEmbeddingApiKey = ragEmbedKey.trim();
      if (ragMongoUrl.trim()) patch.mongodbVectorUrl = ragMongoUrl.trim();
      if (ragMongoDb.trim()) patch.mongodbVectorDb = ragMongoDb.trim();
      if (ragMongoCollection.trim()) patch.mongodbVectorCollection = ragMongoCollection.trim();
      if (ragMongoIndex.trim()) patch.mongodbVectorIndex = ragMongoIndex.trim();
      const r = await api.ragSetConfig(patch);
      setRagStatus(r);
      setRagDbUrl(""); setRagEmbedKey(""); setRagMongoUrl(""); setRagMongoDb("naxionai"); setRagMongoCollection("vault_chunks"); setRagMongoIndex("vector_index");
      showToast("Vector store credentials saved", "success");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setRagSaving(false); }
  }
  async function reembedNow() {
    setRagReembedding(true);
    try {
      const r = await api.ragReembedNow();
      showToast(r.ok ? `Re-embedded ${r.lastRun?.chunks ?? 0} chunk(s)` : (r.error ?? "Re-embed failed"), r.ok ? "success" : "error");
      refreshRagStatus();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setRagReembedding(false); }
  }

  async function refresh() {
    try {
      const r = await fetch("/api/extensions", { headers: { "Content-Type": "application/json", ...(localStorage.getItem("naxie.token") ? { Authorization: `Bearer ${localStorage.getItem("naxie.token")}` } : {}) } });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = await r.json();
      setData(j);
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    // scheduler status
    fetch("/api/extensions/scheduler/status", { headers: { "Content-Type": "application/json", ...(localStorage.getItem("naxie.token") ? { Authorization: `Bearer ${localStorage.getItem("naxie.token")}` } : {}) } }).then(r=> r.json()).then(setScheduler).catch(()=>{});
    refreshRagStatus();
  }, []);

  async function exportSkill(id: string, kind: "connector"|"integration") {
    try {
      const r = await fetch(`/api/extensions/export/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json", ...(localStorage.getItem("naxie.token") ? { Authorization: `Bearer ${localStorage.getItem("naxie.token")}` } : {}) }, body: JSON.stringify({ kind }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error + (j.findings ? `: ${j.findings.map((f:any)=>f.type).join(", ")}` : ""));
      showToast(`Exported ${j.filename} v${j.version} — view it on the Skills page`, "success");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  async function testOne(id: string) {
    setTesting(id);
    try {
      const r = await fetch(`/api/extensions/test/${encodeURIComponent(id)}`, { method: "POST", headers: { "Content-Type": "application/json", ...(localStorage.getItem("naxie.token") ? { Authorization: `Bearer ${localStorage.getItem("naxie.token")}` } : {}) } });
      const j = await r.json();
      showToast(j.ok ? `✓ ${j.detail}` : `Fail: ${j.detail}`, j.ok ? "success" : "error");
      await refresh();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setTesting(null); }
  }

  async function testAll() {
    setTestingAll(true);
    try {
      const r = await fetch("/api/extensions/test-all", { method: "POST", headers: { "Content-Type": "application/json", ...(localStorage.getItem("naxie.token") ? { Authorization: `Bearer ${localStorage.getItem("naxie.token")}` } : {}) } });
      const j = await r.json();
      const coreOk = (j.core ?? []).filter((x: any) => x.ok).length;
      const coreTotal = (j.core ?? []).length;
      showToast(coreTotal ? `${coreOk}/${coreTotal} platform checks ok` : "Test completed", "success");
      await refresh();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setTestingAll(false); }
  }

  if (loading) return <div className="flex items-center gap-2 text-sm text-cream-300/60"><Loader2 size={16} className="animate-spin" /> Loading extensions…</div>;
  if (!data) return <div className="text-sm text-coral-400">Failed to load extensions.</div>;

  const byId = (arr: any[], id: string) => arr.find((x: any) => x.id === id);
  const coreByCat = (() => {
    const m = new Map<string, ExtensionCore[]>();
    for (const c of data.core) {
      const arr = m.get(c.category) ?? [];
      arr.push(c);
      m.set(c.category, arr);
    }
    return [...m.entries()];
  })();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><Puzzle size={24} /> Plugins & Extensions</h1>
          <p className="text-sm text-cream-300/70 mt-1 max-w-3xl">
            Monitor platform APIs (env-gated) and connected services (integrations, model providers) in one place. Company systems and personal Google/Microsoft accounts live on <span className="text-cream-200">Connectors</span> now.
            <span className="text-cream-200"> Connect</span> adds a new API account, <span className="text-cream-200">Test</span> verifies it’s working — secrets are encrypted at rest and never shown.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}><Plus size={14} /> Add Plugin / API</Button>
      </div>

      {/* Tabs — Integrations & Connectors used to be separate pages; they now
          live here alongside Platform APIs & Audit. Versioned user skills
          moved to the Skills page. */}
      <div className="flex flex-wrap gap-1 p-1 bg-ink-950 rounded-lg border border-ink-800 w-fit">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5 transition-colors ${tab === t.id ? "bg-violet-600 text-white" : "text-cream-300/70 hover:text-cream-100"}`}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
      <>
      <div className="grid grid-cols-4 gap-3">
        {[
          { id: "platform" as ExtTab, href: null, label: "Platform APIs enabled", value: `${data.counts.coreEnabled}/${data.counts.coreTotal}`, sub: `${data.counts.coreHealthy} healthy`, icon: Cpu },
          { id: "integrations" as ExtTab, href: null, label: "Integrations", value: String(data.counts.integrations), sub: "Buffer Business, GitHub…", icon: Plug },
          { id: null, href: "/connectors", label: "Connectors", value: String(data.counts.connectors), sub: "Company systems + personal accounts", icon: Boxes },
          { id: null, href: null, label: "Model Providers", value: String(data.counts.modelProviders), sub: `${(data.costSummary?.totalCostUsd ?? 0).toFixed(2)} USD 30d`, icon: Cloud },
        ].map(k => (
          <div key={k.label} onClick={k.id ? () => setTab(k.id!) : k.href ? () => navigate(k.href!) : undefined}>
            <Card className={`!p-4 ${k.id || k.href ? "cursor-pointer hover:border-violet-500/40" : ""}`}>
              <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-cream-300/50"><k.icon size={13} /> {k.label}</div>
              <div className="text-2xl font-semibold text-cream-50 mt-1">{k.value}</div>
              <div className="text-[11px] text-cream-300/50">{k.sub}</div>
            </Card>
          </div>
        ))}
      </div>

      {data.alerts && data.alerts.length > 0 && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 flex items-start gap-2">
          <AlertTriangle size={16} className="text-amber-400 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-medium text-amber-200">Attention needed — {data.alerts.length} failing</div>
            <div className="text-xs text-amber-200/80 mt-1 flex flex-wrap gap-2">
              {data.alerts.map(a => (
                <span key={a.id} className="px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/30">{a.id}: {a.alert} ({a.uptimePct}%)</span>
              ))}
            </div>
          </div>
          <Button variant="subtle" onClick={testAll} disabled={testingAll}>{testingAll ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Re-test</Button>
        </div>
      )}

      {/* Scheduler + webhook → job status */}
      <Card title="Automation">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg bg-ink-950/50 border border-ink-800 p-3">
            <div className="text-xs text-cream-300/60 flex items-center gap-1.5"><History size={12} /> Health scheduler</div>
            <div className="mt-1 text-cream-100">{scheduler ? (scheduler.running ? `Running every ${Math.round((scheduler.intervalMs||3600000)/1000/60)}m` : "Disabled") : "Loading…"}</div>
            <div className="text-[11px] text-cream-300/50 mt-1">{scheduler?.lastRunAt ? `Last: ${new Date(scheduler.lastRunAt).toLocaleString()} · ${scheduler.lastResult?.fails ?? 0} fails` : "No run yet (first in 30s after boot)"}</div>
            <Button variant="subtle" onClick={async () => {
              try { const r = await fetch("/api/extensions/scheduler/run", { method: "POST", headers: { "Content-Type": "application/json", ...(localStorage.getItem("naxie.token") ? { Authorization: `Bearer ${localStorage.getItem("naxie.token")}` } : {}) } }); const j = await r.json(); showToast(`Scheduler ran: ${j.lastResult?.fails ?? 0} fails`, "success"); const s = await fetch("/api/extensions/scheduler/status", { headers: { "Content-Type": "application/json", ...(localStorage.getItem("naxie.token") ? { Authorization: `Bearer ${localStorage.getItem("naxie.token")}` } : {}) } }).then(r=>r.json()); setScheduler(s); refresh(); } catch (e:any){ showToast(e?.message ?? String(e), "error"); }
            }} className="mt-2"><Play size={12} /> Run now</Button>
          </div>
          <div className="rounded-lg bg-ink-950/50 border border-ink-800 p-3">
            <div className="text-xs text-cream-300/60 flex items-center gap-1.5"><Webhook size={12} /> Webhook → Job</div>
            <div className="mt-1 text-cream-100">Zapier/Make → PA tasks</div>
            <div className="text-[11px] text-cream-300/50 mt-1">POST JSON with <span className="font-mono">{"{task: \"...\"}"}</span> to any webhook above → auto-creates a job (<span className="font-mono">webhook:{"<id>"}</span>) and runs via <span className="font-mono">planAndExecute</span>. Poll <span className="font-mono">/api/tasks/jobs/:id</span>.</div>
            <div className="text-[11px] text-cream-300/40 mt-1">Fallback secret: set <span className="font-mono">EXTENSION_WEBHOOK_SECRET</span> in .env for all webhooks.</div>
          </div>
        </div>
      </Card>

      {/* Daily spend trend + paid-models policy toggle live on the AI Models & Cost tab now — see Cost.tsx. */}

      {/* Model Providers */}
      <Card title={`Model Providers · ${data.providers.length}`} action={<Button variant="subtle" onClick={() => { setAddTab("model"); setShowAdd(true); }}><Cpu size={13} /> Add provider</Button>}>
        {data.providers.length === 0 ? (
          <div className="text-sm text-cream-300/60 py-4 text-center">No BYO providers yet. <button onClick={() => { setAddTab("model"); setShowAdd(true); }} className="text-violet-400 hover:text-violet-300">Add one →</button> OpenAI / OpenRouter / Groq.</div>
        ) : (
          <div className="space-y-2">
            {data.providers.map(p => (
              <div key={p.id} className="flex items-center gap-3 py-2 px-3 rounded-lg bg-ink-950/50 border border-ink-800 group">
                <span className={`w-2 h-2 rounded-full ${p.active ? "bg-leaf-500" : "bg-ink-600"}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-cream-100">{p.label} <span className="text-cream-300/40">· {p.kind} · {p.model}</span> {p.active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-leaf-500/10 text-leaf-400">active</span>}</div>
                </div>
                {!p.active && (
                  <button
                    onClick={async () => { try { await api.activateModelProvider(p.id); showToast("Activated", "success"); refresh(); } catch (e: any) { showToast(e?.message ?? "Failed", "error"); } }}
                    className="opacity-0 group-hover:opacity-100 text-xs text-cream-300/60 hover:text-violet-300"
                  >activate</button>
                )}
                <button
                  onClick={async () => { if (!confirm("Remove this provider?")) return; try { await api.removeModelProvider(p.id); showToast("Removed", "success"); refresh(); } catch (e: any) { showToast(e?.message ?? "Failed", "error"); } }}
                  className="opacity-0 group-hover:opacity-100 text-cream-300/40 hover:text-coral-400 p-1"
                ><X size={13} /></button>
              </div>
            ))}
          </div>
        )}
      </Card>
      </>
      )}

      {tab === "platform" && (
      <Card
        title="Platform APIs"
        action={<Button variant="subtle" onClick={testAll} disabled={testingAll}>{testingAll ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Test all</Button>}
      >
        <div className="space-y-4">
          {coreByCat.map(([cat, items]) => {
            const meta = CATEGORY_META[cat] ?? { label: cat, icon: Settings2 };
            const Icon = meta.icon;
            return (
              <div key={cat}>
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-cream-300/40 mb-2"><Icon size={12} /> {meta.label}</div>
                <div className="grid grid-cols-2 gap-3">
                  {items.map(ext => {
                    const hs = byId(data.healthSummaries || [], ext.id);
                    return (
                    <div key={ext.id} className={`flex items-start gap-3 p-3 rounded-xl border ${ext.enabled ? "bg-ink-900/40 border-ink-700" : "bg-ink-950/30 border-ink-800 opacity-80"}`}>
                      <div className="relative mt-0.5">
                        <div className={`w-9 h-9 rounded-lg grid place-items-center text-xs font-semibold ${ext.enabled ? "bg-violet-500/15 text-violet-300" : "bg-ink-800 text-cream-300/60"}`}>{ext.name.slice(0, 2).toUpperCase()}</div>
                        <span className="absolute -bottom-1 -right-1 ring-2 ring-ink-900 rounded-full p-0.5 bg-ink-900"><HealthDot ok={ext.health?.ok} missing={!ext.configured} /></span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-cream-100 flex items-center gap-1.5 flex-wrap">
                          {ext.name}
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${ext.enabled ? "bg-leaf-500/10 text-leaf-400" : "bg-ink-800 text-cream-300/50"}`}>{ext.enabled ? "enabled" : "disabled"}</span>
                          {ext.keyPrefix && <span className="font-mono text-[10px] text-cream-300/50">{ext.keyPrefix}</span>}
                          {hs && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${hs.uptimePct >= 95 ? "bg-leaf-500/10 text-leaf-400" : hs.uptimePct >= 80 ? "bg-amber-500/10 text-amber-300" : "bg-coral-500/10 text-coral-400"}`}>{hs.uptimePct}% 7d</span>}
                          {ext.throttled && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-coral-500/20 text-coral-300 border border-coral-500/30">throttled 5m</span>}
                        </div>
                        <div className="text-[11px] text-cream-300/60 mt-0.5 line-clamp-2">{ext.detail}</div>
                        <div className="text-[10px] text-cream-300/40 font-mono">{ext.envKey}{ext.model ? ` · ${ext.model}` : ""}</div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {hs && <Sparkline spark={hs.spark} />}
                          {hs && hs.total > 0 && <span className="text-[10px] text-cream-300/40">{hs.ok}/{hs.total} ok · {hs.fail} fail</span>}
                          {hs?.alert && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">{hs.alert}</span>}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1 shrink-0">
                        {ext.testable ? (
                          <Button variant="subtle" onClick={() => testOne(ext.id)} disabled={testing === ext.id}>
                            {testing === ext.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Test
                          </Button>
                        ) : <span className="text-[10px] text-cream-300/30 px-2 py-1">no test</span>}
                        <button onClick={() => setHintFor(ext)} className="text-[11px] text-violet-400 hover:text-violet-300 inline-flex items-center gap-1 justify-center"><KeyRound size={11} /> Connect</button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-[11px] text-cream-300/40">
          Platform APIs are configured via <span className="font-mono text-cream-300/70">naxionai/.env</span> (gitignored). Change a key → restart the server. The health dots above reflect live status.
        </div>
      </Card>
      )}

      {tab === "platform" && ragStatus && (
      <Card
        title="Vector store"
        action={<Button variant="subtle" onClick={reembedNow} disabled={ragReembedding || (!ragStatus.pgvectorEnabled && !ragStatus.mongodbVectorEnabled) || !ragStatus.openaiEmbeddingEnabled}>{ragReembedding ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Re-embed now</Button>}
      >
        <p className="text-xs text-cream-300/60 mb-3">
          Naxie's vault gets re-embedded into a pgvector store (Supabase Postgres) and/or MongoDB Atlas Vector Search on every write, powering semantic search over your notes.
          Already running once values below are set — no restart needed, no code change either way.
        </p>
        <div className="flex items-center gap-3 flex-wrap mb-3">
          <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${(ragStatus.pgvectorEnabled || ragStatus.mongodbVectorEnabled) && ragStatus.openaiEmbeddingEnabled ? (ragStatus.connected ? "bg-leaf-500/10 text-leaf-400" : "bg-amber-500/10 text-amber-300") : "bg-ink-800 text-cream-300/50"}`}>
            <HealthDot ok={ragStatus.connected} missing={!ragStatus.pgvectorEnabled && !ragStatus.mongodbVectorEnabled || !ragStatus.openaiEmbeddingEnabled} />
            {(ragStatus.pgvectorEnabled || ragStatus.mongodbVectorEnabled) && ragStatus.openaiEmbeddingEnabled ? (ragStatus.connected ? "Active" : "Configured, unreachable") : "Not configured"}
          </div>
          {ragStatus.lastRun && (
            <span className="text-[11px] text-cream-300/50">
              last run {new Date(ragStatus.lastRun.at).toLocaleString()} — {ragStatus.lastRun.ok ? `${ragStatus.lastRun.chunks} chunk(s)` : `failed: ${ragStatus.lastRun.error}`}
            </span>
          )}
          {ragStatus.pending && <span className="text-[11px] text-violet-400">re-embed pending…</span>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] text-cream-300/50">Supabase DB URL {ragStatus.pgvectorEnabled && <span className="text-leaf-400">({ragStatus.overrides.supabaseDbUrlOverridden ? "set via settings" : "set via .env"})</span>}</label>
            <input type="password" value={ragDbUrl} onChange={e => setRagDbUrl(e.target.value)} placeholder={ragStatus.pgvectorEnabled ? "•••••••••••••••• (leave blank to keep)" : "postgresql://..."}
              className="mt-1 w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-xs text-cream-100 focus:outline-none focus:border-violet-500/60" />
          </div>
          <div>
            <label className="text-[11px] text-cream-300/50">OpenAI embedding API key {ragStatus.openaiEmbeddingEnabled && <span className="text-leaf-400">({ragStatus.overrides.openaiEmbeddingApiKeyOverridden ? "set via settings" : "set via .env"})</span>}</label>
            <input type="password" value={ragEmbedKey} onChange={e => setRagEmbedKey(e.target.value)} placeholder={ragStatus.openaiEmbeddingEnabled ? "•••••••••••••••• (leave blank to keep)" : "sk-..."}
              className="mt-1 w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-xs text-cream-100 focus:outline-none focus:border-violet-500/60" />
          </div>
        </div>
        {ragStatus.mongodbVectorEnabled && (
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-ink-800 pt-3">
            <div>
              <label className="text-[11px] text-cream-300/50">MongoDB Atlas URL {ragStatus.overrides.mongodbVectorUrlOverridden && <span className="text-leaf-400">(set via settings)</span>}</label>
              <input type="password" value={ragMongoUrl} onChange={e => setRagMongoUrl(e.target.value)} placeholder={ragStatus.mongodbVectorEnabled ? "•••••••••••••••• (leave blank to keep)" : "mongodb+srv://..."}
                className="mt-1 w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-xs text-cream-100 focus:outline-none focus:border-violet-500/60" />
            </div>
            <div>
              <label className="text-[11px] text-cream-300/50">MongoDB Database</label>
              <input type="text" value={ragMongoDb} onChange={e => setRagMongoDb(e.target.value)} placeholder="naxionai"
                className="mt-1 w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-xs text-cream-100 focus:outline-none focus:border-violet-500/60" />
            </div>
            <div>
              <label className="text-[11px] text-cream-300/50">MongoDB Collection</label>
              <input type="text" value={ragMongoCollection} onChange={e => setRagMongoCollection(e.target.value)} placeholder="vault_chunks"
                className="mt-1 w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-xs text-cream-100 focus:outline-none focus:border-violet-500/60" />
            </div>
            <div>
              <label className="text-[11px] text-cream-300/50">MongoDB Vector Index</label>
              <input type="text" value={ragMongoIndex} onChange={e => setRagMongoIndex(e.target.value)} placeholder="vector_index"
                className="mt-1 w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-xs text-cream-100 focus:outline-none focus:border-violet-500/60" />
            </div>
          </div>
        )}
        <div className="mt-3">
          <Button onClick={saveRagConfig} disabled={ragSaving || (!ragDbUrl.trim() && !ragEmbedKey.trim() && !ragMongoUrl.trim())}>
            {ragSaving ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} Save
          </Button>
        </div>
      </Card>
      )}

      {/* Integrations — full management UI, formerly the /integrations page */}
      {tab === "integrations" && <Integrations />}

      {/* Audit — full log, formerly the /audit page */}
      {tab === "audit" && <AuditLog />}

      {/* AI Models & Cost — formerly the /cost page, now merged in directly */}
      {tab === "cost" && (
        costLoading ? (
          <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin w-6 h-6" /></div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <GlassCard className="p-4 flex items-center gap-3">
                <SignalBloom value={Math.min(100, (costSummaryFull?.totalCostUsd ?? 0)*200)} size={48} color="flame" sublabel="spend" />
                <div><div className="text-sm text-cream-300/60">Total Cost</div><div className="text-xl font-bold">${(costSummaryFull?.totalCostUsd ?? 0).toFixed(4)}</div></div>
              </GlassCard>
              <div className="bg-ink-900 rounded-lg border p-4">
                <div className="text-sm text-cream-300/60">LLM Calls</div>
                <div className="text-2xl font-bold">{costSummaryFull?.callCount ?? 0}</div>
              </div>
              <div className="bg-ink-900 rounded-lg border p-4">
                <div className="flex items-center gap-2 text-sm text-cream-300/60">
                  <Cpu className="w-4 h-4" /> Input Tokens
                </div>
                <div className="text-2xl font-bold">{(costSummaryFull?.totalInputTokens ?? 0).toLocaleString()}</div>
              </div>
              <div className="bg-ink-900 rounded-lg border p-4">
                <div className="flex items-center gap-2 text-sm text-cream-300/60">
                  <TrendingUp className="w-4 h-4" /> Output Tokens
                </div>
                <div className="text-2xl font-bold">{(costSummaryFull?.totalOutputTokens ?? 0).toLocaleString()}</div>
              </div>
            </div>

            {roster && <ModelRosterCard roster={roster} onTogglePaid={togglePaidModels} />}

            {/* LLM/API spend trend — daily, USD. No chart lib in this app, so each
                day is a proportion bar scaled to the window's max daily spend. */}
            {costTrendData && costTrendData.series.length > 0 && (() => {
              const max = Math.max(0.0001, ...costTrendData.series.map(d => d.agentUsd));
              const totalAgent = costTrendData.series.reduce((s, d) => s + d.agentUsd, 0);
              return (
                <div className="bg-ink-900 rounded-lg border p-4">
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                    <h2 className="font-semibold flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Daily spend (last {costTrendData.days} days, USD)</h2>
                    <div className="flex gap-4 text-xs text-cream-300/60">
                      <span><span className="inline-block w-2 h-2 rounded-full bg-violet-500 mr-1" />total ${totalAgent.toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {costTrendData.series.map(d => (
                      <div key={d.date} className="flex items-center gap-3 text-[11px]">
                        <span className="w-20 shrink-0 text-cream-300/60 font-mono">{d.date.slice(5)}</span>
                        <div className="flex-1">
                          <div className="h-2 rounded bg-ink-950 overflow-hidden"><div className="h-full bg-violet-500" style={{ width: `${(d.agentUsd / max) * 100}%` }} title={`$${d.agentUsd.toFixed(4)}`} /></div>
                        </div>
                        <span className="w-20 shrink-0 text-right text-cream-300/50 tabular-nums">${d.agentUsd.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Where time goes — the waste detector. Decomposes the window into agent
                runtime vs waiting-on-human vs logged human work, names the biggest
                sinks on each side, and gives a plain-language verdict. */}
            {timeA && timeA.totals.totalMs > 0 && (
              <div className="bg-ink-900 rounded-lg border p-4">
                <h2 className="font-semibold mb-1 flex items-center gap-2"><Hourglass className="w-4 h-4" /> Where time goes — last {timeA.days} days</h2>
                <p className="text-xs text-cream-300/60 mb-3">{timeA.verdict}</p>
                <div className="h-3 rounded-full overflow-hidden flex mb-2 bg-ink-950">
                  <div className="bg-violet-500" style={{ width: `${timeA.totals.pct.agent}%` }} title={`Agent runtime ${timeA.totals.pct.agent}%`} />
                  <div className="bg-amber-500" style={{ width: `${timeA.totals.pct.humanWait}%` }} title={`Waiting on humans ${timeA.totals.pct.humanWait}%`} />
                  <div className="bg-leaf-500" style={{ width: `${timeA.totals.pct.humanWork}%` }} title={`Human work ${timeA.totals.pct.humanWork}%`} />
                </div>
                <div className="flex gap-4 text-xs text-cream-300/60 mb-4 flex-wrap">
                  <span><span className="inline-block w-2 h-2 rounded-full bg-violet-500 mr-1" />Agent runtime {timeA.totals.pct.agent}% ({fmtMs(timeA.totals.agentMs)})</span>
                  <span><span className="inline-block w-2 h-2 rounded-full bg-amber-500 mr-1" />Waiting on humans {timeA.totals.pct.humanWait}% ({fmtMs(timeA.totals.humanWaitMs + timeA.totals.openWaitMs)})</span>
                  <span><span className="inline-block w-2 h-2 rounded-full bg-leaf-500 mr-1" />Human work {timeA.totals.pct.humanWork}% ({timeA.humanWorkHours}h)</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {timeA.slowestAgentTypes.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-cream-200 mb-1.5">Slowest agent task types</div>
                      {timeA.slowestAgentTypes.slice(0, 5).map(t => (
                        <div key={t.type} className="flex justify-between text-xs text-cream-300/60 py-0.5">
                          <span className="font-mono truncate">{t.type}</span><span className="shrink-0 ml-2">{fmtMs(t.ms)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {timeA.longestWaits.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-cream-200 mb-1.5">Longest waits on a human</div>
                      {timeA.longestWaits.slice(0, 5).map((w, i) => (
                        <div key={i} className="flex justify-between text-xs text-cream-300/60 py-0.5">
                          <span className="truncate">{w.open ? "⏳ " : ""}{w.title}</span><span className="shrink-0 ml-2">{fmtMs(w.waitMs)}{w.open ? " · still waiting" : ""}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {costSummaryFull?.byModel?.length > 0 && (
              <div className="bg-ink-900 rounded-lg border p-4">
                <h2 className="font-semibold mb-3 flex items-center gap-2"><BarChart3 className="w-4 h-4" /> Cost by Model</h2>
                <div className="space-y-2">
                  {costSummaryFull.byModel.map((m: any) => (
                    <div key={m.model} className="flex items-center justify-between">
                      <span className="text-sm font-mono">{m.model}</span>
                      <div className="flex gap-4 text-sm text-cream-300/60">
                        <span>${m.costUsd.toFixed(4)}</span>
                        <span>{m.calls} calls</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {costSummaryFull?.byDay?.length > 0 && (
              <div className="bg-ink-900 rounded-lg border p-4">
                <h2 className="font-semibold mb-3 flex items-center gap-2"><Calendar className="w-4 h-4" /> Cost by Day</h2>
                <div className="space-y-1">
                  {costSummaryFull.byDay.slice(-14).map((d: any) => (
                    <div key={d.date} className="flex items-center justify-between text-sm">
                      <span>{d.date}</span>
                      <div className="flex gap-4 text-cream-300/60">
                        <span>${d.costUsd.toFixed(4)}</span>
                        <span>{d.calls} calls</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {cacheStats && (
              <div className="bg-ink-900 rounded-lg border p-4">
                <h2 className="font-semibold mb-2">Prompt cache hit-rate</h2>
                <div className="text-sm text-cream-300/60">Overall <span className="font-mono text-cream-100">{((cacheStats.overall?.cacheHitRatio ?? 0)*100).toFixed(1)}%</span> cached · {cacheStats.overall?.callsWithCache ?? 0}/{cacheStats.overall?.calls ?? 0} calls had cache</div>
                <div className="mt-2 space-y-1 text-xs">
                  {Object.entries(cacheStats.profiles ?? {}).slice(0,6).map(([k,v]:any)=>(<div key={k} className="flex justify-between"><span className="font-mono">{k}</span><span>{(v.cacheHitRatio*100).toFixed(1)}% · {v.cachedInputTokens.toLocaleString()}/{v.inputTokens.toLocaleString()} tok</span></div>))}
                </div>
              </div>
            )}

            {costSummaryFull?.recentCalls?.length > 0 && (
              <RecentCallsBlock summary={costSummaryFull} />
            )}
          </div>
        )
       )}
       
       {tab === "whatsapp" && <WhatsApp />}
       
       {hintFor && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={() => setHintFor(null)}>
          <div className="w-full max-w-md bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg text-cream-50 font-medium">Connect {hintFor.name}</h2>
              <button onClick={() => setHintFor(null)} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
            </div>
            <div className="text-sm text-cream-300/70">{hintFor.description}</div>
            <div className="rounded-lg bg-ink-950 border border-ink-800 p-3 space-y-2">
              <div className="text-[11px] text-cream-300/50">Env var</div>
              <div className="font-mono text-sm text-cream-100">{hintFor.envKey}=<span className="text-cream-300/50">••••••</span></div>
              <div className="text-[11px] text-cream-300/60">{(() => {
                const cat = data.catalog.find(c => c.id === hintFor.id);
                return cat?.connectHint ?? "Set the key in naxionai/.env then restart the server.";
              })()}</div>
            </div>
            <div className="rounded-lg bg-amber-400/10 border border-amber-400/20 px-3 py-2 text-[11px] text-amber-300/90 flex gap-1.5">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span>Keys live in <span className="font-mono">naxionai/.env</span> (gitignored). Never paste a secret into chat. After editing, restart with <span className="font-mono">pnpm -F naxion-server dev</span> or your process manager.</span>
            </div>
            <div className="flex items-center justify-between">
              {hintFor.docsUrl ? <a href={hintFor.docsUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-violet-400 hover:text-violet-300 inline-flex items-center gap-1">Get a key <ExternalLink size={11} /></a> : <span />}
              <Button onClick={() => setHintFor(null)}>Done</Button>
            </div>
          </div>
        </div>
      )}

      {rotateTarget && <RotateModal target={rotateTarget} onClose={() => setRotateTarget(null)} onRotated={() => { setRotateTarget(null); refresh(); }} />}

      {showAdd && <AddPluginModal initialTab={addTab} onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); refresh(); }} />}
    </div>
  );
}

function RotateModal({ target, onClose, onRotated }: { target: { kind: "integration" | "connector"; id: string; label: string }; onClose: () => void; onRotated: () => void }) {
  const [secret, setSecret] = useState("");
  const [secret2, setSecret2] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [roles, setRoles] = useState("superadmin");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expiryOnly, setExpiryOnly] = useState(false);

  async function submit() {
    setErr(null); setSaving(true);
    try {
      if (expiryOnly) {
        if (target.kind === "integration") await api.setIntegrationExpiry(target.id, expiresAt || null);
        else await api.setConnectorExpiry(target.id, expiresAt || null);
      } else {
        // rotate: need provider fields — for generic we try common secret names
        const values: Record<string, string> = {};
        if (secret) {
          // try common keys; server will only apply matching secret fields
          for (const k of ["token", "apiKey", "value", "botToken", "accessToken", "password", "api_key"]) values[k] = secret;
          if (secret2) values["apiToken"] = secret2; // Jira second token etc.
        }
        if (expiresAt) values.expiresAt = expiresAt;
        if (target.kind === "integration") await api.rotateIntegration(target.id, values, expiresAt || undefined);
        else await api.rotateConnector(target.id, values, expiresAt || undefined);
      }
      // roles
      if (roles) {
        const rs = roles.split(",").map(s => s.trim()).filter(Boolean);
        if (rs.length) {
          if (target.kind === "integration") await api.setIntegrationRoles(target.id, rs);
          else await api.setConnectorRoles(target.id, rs);
        }
      }
      showToast("Rotated", "success");
      onRotated();
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium flex items-center gap-2"><RefreshCw size={16} /> Rotate — {target.label}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>
        <label className="flex items-center gap-2 text-xs text-cream-300/70"><input type="checkbox" checked={expiryOnly} onChange={e => setExpiryOnly(e.target.checked)} /> Only update expiry / roles (no secret)</label>
        {!expiryOnly && (
          <>
            <div>
              <label className="block text-[11px] text-cream-300/70 mb-1">New secret / token / API key *</label>
              <input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder="paste new key" className={FIELD + " font-mono"} autoComplete="off" />
            </div>
            <div>
              <label className="block text-[11px] text-cream-300/70 mb-1">Second secret (optional — Jira apiToken etc.)</label>
              <input type="password" value={secret2} onChange={e => setSecret2(e.target.value)} className={FIELD + " font-mono"} autoComplete="off" />
            </div>
          </>
        )}
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">Expires at (ISO date — optional)</label>
          <input type="date" value={expiresAt ? expiresAt.slice(0,10) : ""} onChange={e => setExpiresAt(e.target.value ? new Date(e.target.value).toISOString() : "")} className={FIELD} />
          <div className="text-[10px] text-cream-300/40 mt-1">Sets the <Clock size={10} className="inline" /> badge; triggers “soon” at ≤7d. Leave empty for no expiry.</div>
        </div>
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">Allowed roles (comma-separated)</label>
          <input value={roles} onChange={e => setRoles(e.target.value)} placeholder="superadmin,admin" className={FIELD + " font-mono"} />
          <div className="text-[10px] text-cream-300/40 mt-1 flex items-center gap-1"><Shield size={10} /> Enforced on test/call (superadmin always allowed).</div>
        </div>
        {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="subtle" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving || (!expiryOnly && !secret)}>{saving ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {expiryOnly ? "Update" : "Rotate"}</Button>
        </div>
      </div>
    </div>
  );
}

const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60 placeholder:text-cream-300/30";

function AddPluginModal({ onClose, onAdded, initialTab = "integration" }: { onClose: () => void; onAdded: () => void; initialTab?: "integration" | "connector" | "model" }) {
  const [tab, setTab] = useState<"integration" | "connector" | "model">(initialTab);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-2xl bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium flex items-center gap-2"><Puzzle size={18} /> Add Plugin / API</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>
        <div className="flex gap-1 p-1 bg-ink-950 rounded-lg border border-ink-800 w-fit">
          {[
            { id: "integration", label: "Integration", icon: Plug, desc: "Buffer Business, Ayrshare…" },
            { id: "connector", label: "Custom API", icon: Boxes, desc: "Any HTTP API" },
            { id: "model", label: "Model Provider", icon: Cloud, desc: "OpenAI / OpenRouter…" },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id as any)} className={`px-3 py-1.5 rounded-md text-xs flex items-center gap-1.5 ${tab === t.id ? "bg-violet-600 text-white" : "text-cream-300/70 hover:text-cream-100"}`}>
              <t.icon size={12} /> {t.label}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-cream-300/50">
          {tab === "integration" && "Connect a pre-built service (29 providers). Secrets are encrypted at rest."}
          {tab === "connector" && "Wire any company HTTP API — base URL + auth + optional endpoint manifest that agents read via connector.describe."}
          {tab === "model" && "Bring your own cloud LLM — the agent routes to it when local Ollama isn’t enough."}
        </div>
        {tab === "integration" && <IntegrationAddForm onAdded={onAdded} />}
        {tab === "connector" && <ConnectorAddForm onAdded={onAdded} />}
        {tab === "model" && <ModelAddForm onAdded={onAdded} />}
      </div>
    </div>
  );
}

function IntegrationAddForm({ onAdded }: { onAdded: () => void }) {
  const [providers, setProviders] = useState<any[]>([]);
  const [providerId, setProviderId] = useState("");
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.integrationsCatalog().then(r => {
      setProviders(r.providers);
      if (r.providers[0]) { setProviderId(r.providers[0].id); setLabel(r.providers[0].name); }
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const p = providers.find(x => x.id === providerId);
    if (p) setLabel(p.name);
    setValues({});
    setErr(null);
  }, [providerId]);
  const provider = providers.find(p => p.id === providerId);
  async function submit() {
    setErr(null); setSaving(true);
    try {
      const { connection } = await api.addIntegration(providerId, label, values);
      try { const verdict = await api.testIntegration(connection.id); showToast(verdict.ok ? `✓ ${provider?.name} connected & working` : `Connected but test failed: ${verdict.detail}`, verdict.ok ? "success" : "error"); } catch {}
      if (!provider) showToast("Connected", "success");
      onAdded();
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setSaving(false); }
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">Provider *</label>
          <select value={providerId} onChange={e => setProviderId(e.target.value)} className={FIELD}>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.category}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">Label</label>
          <input value={label} onChange={e => setLabel(e.target.value)} className={FIELD} placeholder={provider?.name} />
        </div>
      </div>
      {provider?.note && <div className="text-[11px] text-amber-300/80 bg-amber-400/10 border border-amber-400/20 rounded-lg px-3 py-2">{provider.note}</div>}
      {provider?.fields?.map((f: any) => (
        <div key={f.name}>
          <label className="block text-[11px] text-cream-300/70 mb-1">{f.label}{f.required && <span className="text-coral-400"> *</span>}</label>
          <input type={f.type === "password" ? "password" : "text"} value={values[f.name] ?? ""} onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))} placeholder={f.placeholder} autoComplete="off" spellCheck={false} className={`${FIELD} font-mono`} />
        </div>
      ))}
      {provider?.docsUrl && <a href={provider.docsUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-violet-400 hover:text-violet-300 inline-flex items-center gap-1">Where to get this? <ExternalLink size={11} /></a>}
      {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
      <div className="flex justify-end"><Button onClick={submit} disabled={saving || !providerId}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Connect</Button></div>
    </div>
  );
}

function ConnectorAddForm({ onAdded }: { onAdded: () => void }) {
  const [authTypes, setAuthTypes] = useState<any[]>([]);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [description, setDescription] = useState("");
  const [authType, setAuthType] = useState<ConnectorAuthType>("none");
  const [authIn, setAuthIn] = useState<"header" | "query">("header");
  const [authName, setAuthName] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.connectorsCatalog().then(r => setAuthTypes(r.authTypes)).catch(() => {}); }, []);
  async function submit() {
    setErr(null); setSaving(true);
    try {
      const auth: any = { type: authType };
      if (authType === "apiKey") { auth.in = authIn; auth.name = authName; if (secret) auth.value = secret; }
      else if (authType === "bearer") { if (secret) auth.token = secret; }
      else if (authType === "basic") { auth.username = username; if (secret) auth.password = secret; }
      else if (authType === "header") { auth.name = authName; if (secret) auth.value = secret; }
      await api.addConnector({ label, baseUrl, description: description || undefined, auth, writeEnabled });
      showToast("Connector added — Test it to verify", "success");
      onAdded();
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setSaving(false); }
  }
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[11px] text-cream-300/70 mb-1">Label *</label>
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Acme Orders API" className={FIELD} />
      </div>
      <div>
        <label className="block text-[11px] text-cream-300/70 mb-1">Base URL *</label>
        <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.acme.com" className={`${FIELD} font-mono`} spellCheck={false} />
      </div>
      <div>
        <label className="block text-[11px] text-cream-300/70 mb-1">Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="What this system is — agents read this" className={FIELD} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">Auth</label>
          <select value={authType} onChange={e => setAuthType(e.target.value as any)} className={FIELD}>
            {(authTypes.length ? authTypes : [{ type: "none", label: "No auth" }] as any).map((a: any) => <option key={a.type} value={a.type}>{a.label}</option>)}
          </select>
        </div>
        {authType === "apiKey" && (
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Send in</label>
            <select value={authIn} onChange={e => setAuthIn(e.target.value as any)} className={FIELD}><option value="header">Header</option><option value="query">Query param</option></select>
          </div>
        )}
      </div>
      {(authType === "apiKey" || authType === "header") && (
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">{authType === "apiKey" ? "Param/Header name" : "Header name"}</label>
          <input value={authName} onChange={e => setAuthName(e.target.value)} placeholder={authType === "apiKey" ? "X-API-Key" : "Authorization"} className={`${FIELD} font-mono`} />
        </div>
      )}
      {authType === "basic" && (
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">Username</label>
          <input value={username} onChange={e => setUsername(e.target.value)} className={FIELD} />
        </div>
      )}
      {authType !== "none" && (
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">{authType === "bearer" ? "Token *" : authType === "basic" ? "Password *" : "Key / Token *"}</label>
          <input type="password" value={secret} onChange={e => setSecret(e.target.value)} className={`${FIELD} font-mono`} autoComplete="off" />
        </div>
      )}
      <label className="flex items-center gap-2 text-[13px] text-cream-200 cursor-pointer"><input type="checkbox" checked={writeEnabled} onChange={e => setWriteEnabled(e.target.checked)} className="accent-coral-500" /> Allow writes (POST/PUT/DELETE) — off = agents read-only</label>
      {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
      <div className="flex justify-end"><Button onClick={submit} disabled={saving || !label || !baseUrl}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Boxes size={14} />} Add API</Button></div>
    </div>
  );
}

function ModelAddForm({ onAdded }: { onAdded: () => void }) {
  const [kinds, setKinds] = useState<Record<string, any>>({});
  const [kind, setKind] = useState("openai");
  const [model, setModel] = useState("gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.listModelProviders().then(r => { setKinds(r.kinds); if (r.kinds[kind]) setModel(r.kinds[kind].modelHint); }).catch(() => {}); }, []);
  useEffect(() => { if (kinds[kind]) setModel(kinds[kind].modelHint); }, [kind]);
  async function submit() {
    setErr(null); setSaving(true);
    try {
      await api.addModelProvider({ kind, model, apiKey, label: label || undefined, active: true });
      showToast("Model provider added & activated", "success");
      onAdded();
    } catch (e: any) { setErr(e?.message ?? String(e)); } finally { setSaving(false); }
  }
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">Provider</label>
          <select value={kind} onChange={e => setKind(e.target.value)} className={FIELD}>
            {Object.entries(kinds).map(([k, v]: any) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">Model *</label>
          <input value={model} onChange={e => setModel(e.target.value)} placeholder={kinds[kind]?.modelHint} className={`${FIELD} font-mono`} />
        </div>
      </div>
      <div>
        <label className="block text-[11px] text-cream-300/70 mb-1">API Key *</label>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} className={`${FIELD} font-mono`} autoComplete="off" />
      </div>
      <div>
        <label className="block text-[11px] text-cream-300/70 mb-1">Label (optional)</label>
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="My OpenRouter" className={FIELD} />
      </div>
      {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
      <div className="flex justify-end"><Button onClick={submit} disabled={saving || !model || !apiKey}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Cloud size={14} />} Add Provider</Button></div>
    </div>
  );
}

function RosterRowView({ row }: { row: RosterRow }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b last:border-0 border-ink-800">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="font-mono text-xs truncate">{row.name}</span>
          {row.tier && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60">{row.tier} tier</span>}
          {row.active && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-leaf-500/10 text-leaf-400">active</span>}
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${row.free ? "bg-leaf-500/10 text-leaf-400" : "bg-amber-500/10 text-amber-400"}`}>{row.free ? "free" : "paid"}</span>
        </div>
        {row.providerLabel && <div className="text-[11px] text-cream-300/40 mt-0.5">{row.providerLabel}</div>}
      </div>
      <div className="flex gap-3 shrink-0 text-xs text-cream-300/60 tabular-nums">
        <span>{row.calls} calls</span>
        {row.failed > 0 && <span className="text-coral-400">{(row.failureRate * 100).toFixed(0)}% failed</span>}
        <span>${row.costUsd.toFixed(4)}</span>
      </div>
    </div>
  );
}

function ModelRosterCard({ roster, onTogglePaid }: { roster: { policy: { allowPaidModels: boolean }; offline: RosterRow[]; online: RosterRow[] }; onTogglePaid: (next: boolean) => void }) {
  const onlineFree = roster.online.filter(r => r.free);
  const onlinePaid = roster.online.filter(r => !r.free);
  return (
    <div className="bg-ink-900 rounded-lg border p-4">
      <h2 className="font-semibold mb-3 flex items-center gap-2"><Server className="w-4 h-4" /> Model Roster</h2>
      <div className="space-y-4">
        <div>
          <div className="text-xs font-semibold text-cream-300/60 mb-1">Offline — local (always free, last-resort fallback)</div>
          {roster.offline.length === 0
            ? <div className="text-xs text-cream-300/40">No local Ollama models pulled.</div>
            : roster.offline.map(r => <RosterRowView key={r.name} row={r} />)}
        </div>
        <div>
          <div className="text-xs font-semibold text-cream-300/60 mb-1">Online — free</div>
          {onlineFree.length === 0
            ? <div className="text-xs text-cream-300/40">No free online model configured.</div>
            : onlineFree.map(r => <RosterRowView key={`${r.providerLabel}-${r.name}-${r.tier ?? ""}`} row={r} />)}
        </div>
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-xs font-semibold text-cream-300/60">Online — paid</div>
            <button
              type="button"
              role="switch"
              aria-checked={roster.policy.allowPaidModels}
              onClick={() => onTogglePaid(!roster.policy.allowPaidModels)}
              title="Allow paid models"
              className={`shrink-0 w-11 h-6 rounded-full border transition-colors duration-150 relative ${roster.policy.allowPaidModels ? "bg-violet-600 border-violet-500" : "bg-ink-800 border-ink-700"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-150 ${roster.policy.allowPaidModels ? "translate-x-[22px]" : "translate-x-0.5"}`} />
            </button>
          </div>
          {!roster.policy.allowPaidModels && <div className="text-[11px] text-amber-400/80 mb-1">Blocked — the dispatcher downgrades these to a free model or local Ollama until approved.</div>}
          {onlinePaid.length === 0
            ? <div className="text-xs text-cream-300/40">No paid model registered.</div>
            : onlinePaid.map(r => <RosterRowView key={`${r.providerLabel}-${r.name}-${r.tier ?? ""}`} row={r} />)}
        </div>
      </div>
    </div>
  );
}

function RecentCallsBlock({ summary }: { summary: any }) {
  return (
    <div className="bg-ink-900 rounded-lg border p-4">
      <h2 className="font-semibold mb-3">Recent Calls</h2>
      <div className="space-y-1 text-sm">
        {summary.recentCalls.slice(0, 20).map((c: any, i: number) => (
          // jobId+ts alone can collide — most calls are jobId:"adhoc" (not
          // tied to a tracked job), and two calls landing in the same
          // millisecond isn't rare under concurrent requests. Index as a
          // tiebreaker is safe here since this list is a static slice, not
          // reordered/filtered independently between renders.
          <div key={`${c.jobId}-${c.ts}-${i}`} className="flex items-center justify-between border-b last:border-0 py-1">
            <div className="flex-1 min-w-0">
              <span className="font-mono text-xs truncate block">{c.model}</span>
              <span className="text-xs text-cream-300/50">{c.profile}</span>
            </div>
            <div className="flex gap-3 shrink-0 text-xs text-cream-300/60">
              <span title={`${c.inputTokens} in / ${c.outputTokens} out`}>⬆{c.inputTokens} ⬇{c.outputTokens}</span>
              <span>${c.costUsd.toFixed(6)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// "2h 15m" / "45m" / "30s" — coarse on purpose; this section is about proportions.
function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}
