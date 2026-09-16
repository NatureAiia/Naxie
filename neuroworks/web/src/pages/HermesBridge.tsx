import { useState, useEffect } from "react";
import { ArrowLeftRight, CheckCircle2, XCircle, Loader2, RefreshCw, Plug, ListTree } from "lucide-react";
import { api, type HermesBridgeStatus } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";

// Read-only(ish) visibility for the clawbot-mcp.mjs bridge that lets the
// Hermes agent call clawbot's own primitives (vault, connectors, calendar,
// memory, …) over MCP. The registration itself always lives in HERMES's own
// config.yaml — MCP servers are configured client-side, and Hermes is the
// client in this direction — so this page can't "be" the registration the
// way /mcp-servers is for servers NeuroWorks itself connects to. It renders
// that external state and offers a one-click write into Hermes's config.

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

export function HermesBridge() {
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
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><ArrowLeftRight size={24} /> Hermes Bridge</h1>
          <p className="text-sm text-cream-300/70 mt-1 max-w-3xl">
            Lets the Hermes agent call clawbot's own tools — vault, connectors, calendar, memory, email — over MCP,
            via <span className="font-mono text-[12px]">server/mcp/clawbot-mcp.mjs</span>. The registration lives in
            Hermes's own config (MCP servers are always configured client-side), so this page just shows you that
            state and can write it for you.
          </p>
        </div>
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
