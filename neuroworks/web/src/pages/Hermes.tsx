import { useState, useEffect } from "react";
import { ArrowLeftRight, CheckCircle2, XCircle, Loader2, RefreshCw, Plug, ListTree, TerminalSquare } from "lucide-react";
import { api, type HermesBridgeStatus, type ExecutorStatus } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";

// Everything about the Hermes integration lives on this one page: launching
// the external CLI, which agent (clawbot vs Hermes) actually runs tasks, and
// the MCP bridge that lets Hermes call clawbot's own tools. Previously spread
// across SpinUpAgent (the launcher) and nowhere at all (the executor toggle
// had an API but no UI) — consolidated here so there's one place to look.

function Row({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string | null }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      {ok === null ? (
        <Loader2 size={15} className="animate-spin text-cream-300/50 mt-0.5 shrink-0" />
      ) : ok ? (
        <CheckCircle2 size={15} className="text-leaf-400 mt-0.5 shrink-0" />
      ) : (
        <XCircle size={15} className="text-coral-400/80 mt-0.5 shrink-0" />
      )}
      <div className="min-w-0">
        <div className="text-sm text-cream-100">{label}</div>
        {detail && <div className="text-[11px] font-mono text-cream-300/50 break-all">{detail}</div>}
      </div>
    </div>
  );
}

function LaunchCard() {
  const [launching, setLaunching] = useState(false);
  async function launch() {
    setLaunching(true);
    try {
      const r = await api.launchHermesAgent();
      showToast(r.result, /turned off/i.test(r.result) ? "error" : "success");
    } catch (e: any) {
      showToast(`Couldn't launch Hermes: ${e.message}`, "error");
    } finally {
      setLaunching(false);
    }
  }
  return (
    <Card>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="shrink-0 rounded-lg bg-violet-500/10 p-2 text-violet-400"><TerminalSquare size={20} /></div>
          <div>
            <div className="font-semibold text-cream-50">Hermes Agent</div>
            <div className="text-sm text-cream-300/70">External, self-hosted (local, 127.0.0.1) — opens in its own terminal window, not a NeuroWorks persona.</div>
          </div>
        </div>
        <Button onClick={launch} disabled={launching}>
          {launching ? <span className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Opening…</span> : "Open Hermes"}
        </Button>
      </div>
    </Card>
  );
}

function ExecutorCard() {
  const [status, setStatus] = useState<ExecutorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [modelDraft, setModelDraft] = useState("");

  async function refresh() {
    try {
      const s = await api.getExecutor();
      setStatus(s);
      setModelDraft(s.hermesModelOverride ?? "");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function patch(body: Parameters<typeof api.setExecutor>[0]) {
    setBusy(true);
    try {
      await api.setExecutor(body);
      await refresh();
      showToast("Executor updated", "success");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(false); }
  }

  if (loading || !status) {
    return <Card><div className="flex items-center gap-2 text-sm text-cream-300/60"><Loader2 size={16} className="animate-spin" /> Loading executor…</div></Card>;
  }

  return (
    <Card title="Primary executor">
      <p className="text-[12px] text-cream-300/60 mb-3">
        Which agent actually runs tasks. Clawbot is the built-in plan → execute → synth pipeline; Hermes runs
        the task itself and offloads back to clawbot for anything it can't do.
      </p>
      <div className="flex gap-2 mb-3">
        <Button variant={status.mode === "clawbot" ? "primary" : "subtle"} disabled={busy} onClick={() => patch({ mode: "clawbot" })}>Clawbot</Button>
        <Button variant={status.mode === "hermes" ? "primary" : "subtle"} disabled={busy || !status.hermes.available} onClick={() => patch({ mode: "hermes" })}>Hermes</Button>
      </div>

      <div className="divide-y divide-ink-800/60">
        <Row ok={status.hermes.available} label="Hermes installed" detail={status.hermes.binPath} />
      </div>

      {status.mode === "hermes" && (
        <div className="mt-3 space-y-3 border-t border-ink-800 pt-3">
          <label className="flex items-center gap-2 text-sm text-cream-200">
            <input type="checkbox" checked={status.hermesLocal} disabled={busy}
              onChange={e => patch({ hermesLocal: e.target.checked })} />
            Run against local Ollama ({status.hermes.localModel}) instead of {status.hermes.provider} — free, offline
          </label>
          <label className="flex items-center gap-2 text-sm text-cream-200">
            <input type="checkbox" checked={status.crosscheck} disabled={busy}
              onChange={e => patch({ crosscheck: e.target.checked })} />
            Cross-check — on a quality-gate fail, have a peer judge Hermes's answer against clawbot's instead of always taking clawbot's
          </label>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Model override (blank = default: {status.hermes.model})</label>
            <div className="flex gap-2">
              <input value={modelDraft} onChange={e => setModelDraft(e.target.value)}
                placeholder={status.hermes.model}
                className="flex-1 bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60 font-mono" />
              <Button variant="subtle" disabled={busy} onClick={() => patch({ hermesModel: modelDraft.trim() || null })}>Save</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function BridgeCard() {
  const [status, setStatus] = useState<HermesBridgeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [showTools, setShowTools] = useState(false);

  async function refresh() {
    try { setStatus(await api.hermesBridgeStatus()); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function register() {
    setRegistering(true);
    try {
      const r = await api.registerHermesBridge();
      showToast(r.alreadyRegistered ? "Already registered with Hermes" : "Registered — restart `hermes chat` to pick it up", "success");
      setStatus(r.status);
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setRegistering(false); }
  }

  const connected = status?.registered && status?.enabled;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-cream-100 tracking-tight">MCP bridge — clawbot's tools, exposed to Hermes</h2>
        <Button variant="subtle" onClick={() => { setLoading(true); void refresh(); }}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-cream-300/60"><Loader2 size={16} className="animate-spin" /> Checking bridge status…</div>
      ) : !status ? (
        <Card><div className="text-center py-8 text-cream-300/60 text-sm">Couldn't load status.</div></Card>
      ) : (
        <>
          <Card>
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2.5 h-2.5 rounded-full ${connected ? "bg-leaf-500" : "bg-amber-400/80"}`} />
              <span className="text-sm text-cream-100">{connected ? "Registered and enabled" : status.registered ? "Registered, but disabled" : "Not registered with Hermes yet"}</span>
            </div>
            <div className="divide-y divide-ink-800/60 mt-2">
              <Row ok={status.hermesInstalled} label="Hermes agent installed" detail={status.hermesBinPath} />
              <Row ok={status.hermesConfigExists} label="Hermes config.yaml found" detail={status.hermesConfigPath} />
              <Row ok={status.bridgeScriptExists} label="Bridge script present" detail={status.bridgeScriptPath} />
              <Row ok={status.registered ? status.enabled : false} label={status.registered ? "Registered in Hermes's mcp_servers" : "Not yet in Hermes's mcp_servers"} />
            </div>
            {!status.registered && (
              <div className="mt-3 flex items-center gap-2">
                <Button onClick={register} disabled={registering || !status.hermesConfigExists}>
                  {registering ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Register with Hermes
                </Button>
                {!status.hermesConfigExists && <span className="text-[11px] text-cream-300/50">Install Hermes first — no config.yaml to write to.</span>}
              </div>
            )}
            {status.registered && !status.enabled && (
              <div className="mt-3 text-[11px] text-amber-300/70">
                Present but disabled in Hermes's config — set <span className="font-mono">enabled: true</span> under
                <span className="font-mono"> mcp_servers.clawbot</span> in {status.hermesConfigPath}.
              </div>
            )}
          </Card>

          <Card>
            <button type="button" onClick={() => setShowTools(v => !v)} className="w-full flex items-center justify-between text-left">
              <div className="text-sm text-cream-100 flex items-center gap-2"><ListTree size={15} /> Tools exposed to Hermes</div>
              <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60">{status.toolCount}</span>
            </button>
            {showTools && (
              <div className="mt-3 space-y-1.5 max-h-96 overflow-auto">
                {status.tools.map(t => (
                  <div key={t.name} className="rounded-lg bg-ink-950/50 border border-ink-800 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-mono text-[12px] text-cream-100">{t.name}</div>
                      {!t.readonly && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300/80">write</span>}
                    </div>
                    <div className="text-[11px] text-cream-300/60 mt-0.5">{t.description}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="text-[10px] text-cream-300/40 mt-2">
              Catalog controlled by the allowlist in <span className="font-mono">server/src/routes/primitives.ts</span> (override with the
              <span className="font-mono"> NEUROWORKS_MCP_TOOLS</span> env var).
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

export function Hermes() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><ArrowLeftRight size={24} /> Hermes</h1>
        <p className="text-sm text-cream-300/70 mt-1 max-w-3xl">
          Nous Research's Hermes CLI — a separate, self-hosted agent NeuroWorks can launch, hand tasks to, and hand
          its own tools to. Everything about that integration lives here.
        </p>
      </div>

      <LaunchCard />
      <ExecutorCard />
      <BridgeCard />
    </div>
  );
}
