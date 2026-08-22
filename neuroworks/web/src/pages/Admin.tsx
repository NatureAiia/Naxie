import { useEffect, useState } from "react";
import { api, type HostToolsSettings, type OrgTask, type OrgRole, type OrgTaskStatus } from "../lib/api";
import { Card, StatusDot, showToast } from "../components/Card";

type ModelInfo = {
  name: string;
  family: string;
  paramSize?: string;
  sizeGB?: number;
  capabilities: { jsonStrict: number; reasoning: number; longForm: number; speed: number; cost: number };
};

export function Admin() {
  const [status, setStatus] = useState<any>(null);
  const [peers, setPeers] = useState<{ self: any; peers: any[]; registry?: any[] } | null>(null);
  // External (CLI) agents like Hermes — rendered in the Workforce card alongside
  // clawbot peers so the operator manages one workforce, not two surfaces.
  const [externalAgents, setExternalAgents] = useState<any[]>([]);
  const [vaultStats, setVaultStats] = useState<any>(null);
  const [llm, setLlm] = useState<{ ollama: { ok: boolean; model: string; error?: string }; openrouter: { enabled: boolean; ok: boolean; model: string; error?: string }; primary: "ollama" | "openrouter" } | null>(null);
  useEffect(() => { api.status().then(setStatus); }, []);
  useEffect(() => {
    let alive = true;
    async function tick() {
      try { const r = await api.peers(); if (alive) setPeers(r); } catch {}
      try { const ext = await api.externalAgents(); if (alive) setExternalAgents(ext.agents ?? []); } catch {}
      try { const v = await api.vaultStats(); if (alive) setVaultStats(v); } catch {}
      try { const l = await api.llmStatus(); if (alive) setLlm(l); } catch {}
    }
    tick();
    const i = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(i); };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-cream-50">Admin</h1>
        <p className="text-sm text-cream-300/70 mt-1">Workforce health, agents, local models, and system configuration.</p>
      </div>

      {!status ? <Card><div className="text-sm text-cream-300/60">Loading…</div></Card> : (
        <>
          {!status.ready && (
            <div className="bg-flame-500/10 border border-flame-500/30 rounded-xl p-4">
              <div className="text-sm font-medium text-flame-400">Degraded mode</div>
              <div className="text-xs text-flame-300/80 mt-1">Missing env: <span className="font-mono">{status.missing.join(", ")}</span>. Set in <span className="font-mono">clawbot/.env</span> and restart.</div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Card title="Vault">
              <div className="space-y-1.5 text-sm">
                <div className="text-cream-300/70">Local path</div>
                <div className="font-mono text-xs text-cream-100 break-all">{status.vaultPath}</div>
                <div className="text-cream-300/70 mt-3">GitHub repo</div>
                <div className="font-mono text-xs text-cream-100">{status.vaultRepo}</div>
              </div>
            </Card>
            <Card title="LLM backends">
              <LLMBackendBlock llm={llm} fallbackOllama={status.ollama} />
            </Card>
            <Card title="Cloud worker (Neuro)" className="col-span-2">
              {status.lastWorkflow?.error && <div className="text-xs text-coral-400">{status.lastWorkflow.error}</div>}
              {status.lastWorkflow && !status.lastWorkflow.error && (
                <div className="text-sm space-y-1">
                  <StatusDot ok={status.lastWorkflow.conclusion === "success"} label={`Last run: ${status.lastWorkflow.conclusion ?? status.lastWorkflow.status}`} />
                  <div className="text-xs text-cream-300/60">{new Date(status.lastWorkflow.createdAt).toLocaleString()}</div>
                  <a href={status.lastWorkflow.htmlUrl} target="_blank" className="text-xs text-violet-400 hover:text-violet-500">view on GitHub →</a>
                </div>
              )}
              {status.lastDigest && (
                <div className="mt-3 pt-3 border-t border-ink-800 text-xs text-cream-300/70">
                  Last digest: <span className="text-cream-100">{status.lastDigest.reposScanned} repos · {status.lastDigest.totalCommits} commits · {status.lastDigest.totalPrs} PRs · {status.lastDigest.totalIssues} issues</span>
                </div>
              )}
            </Card>
          </div>

          <Card title="Vault sync">
            <VaultSyncBlock stats={vaultStats} vaultPath={status.vaultPath} />
          </Card>

          <ModelsSection />

          <div className="grid grid-cols-2 gap-4">
            <SystemAccessCard />
            <OrgTasksCard />
          </div>

          <Card title="Configuration">
            <div className="text-xs text-cream-300/70 mb-3">NeuroWorks reads its config from <span className="font-mono">clawbot/.env</span>. Edit there and restart to apply changes durably.</div>
            <ul className="text-xs space-y-1.5 font-mono text-cream-200">
              <li><span className="text-cream-300/50">VAULT_PATH</span> — local Obsidian vault location</li>
              <li><span className="text-cream-300/50">VAULT_REPO</span> — GitHub repo for the vault</li>
              <li><span className="text-cream-300/50">GITHUB_TOKEN</span> — fine-grained PAT for Neuro</li>
              <li><span className="text-cream-300/50">OLLAMA_MODEL</span> — default model (overridable above at runtime)</li>
              <li><span className="text-cream-300/50">OLLAMA_PLAN_MODEL</span> — pin a model for planning (skips capability scorer)</li>
              <li><span className="text-cream-300/50">OLLAMA_SYNTH_MODEL</span> — pin a model for synthesis</li>
              <li><span className="text-cream-300/50">OLLAMA_TRIAGE_MODEL</span> — pin a model for triage / direct-answer classification</li>
              <li><span className="text-cream-300/50">OLLAMA_EXTRACT_MODEL</span> — pin a model for JSON extraction (personas, quality)</li>
              <li><span className="text-cream-300/50">NEUROWORKS_TRIAGE</span> — set to <span className="text-cream-300/40">0</span> to disable the direct-answer shortcut</li>
              <li><span className="text-cream-300/50">NEUROWORKS_PEERS</span> — comma-separated peer URLs for delegation + review</li>
              <li><span className="text-cream-300/50">NEUROWORKS_AUTO_REVIEW</span> — set to <span className="text-cream-300/40">0</span> to disable post-synthesis peer review</li>
              <li><span className="text-cream-300/50">NEUROWORKS_OVERLOAD_THRESHOLD</span> — local in-flight count that triggers peer hand-off (default 2)</li>
              <li><span className="text-cream-300/50">NEUROWORKS_VAULT_SCAN</span> — set to <span className="text-cream-300/40">0</span> to disable secret-scan gate on vault writes</li>
              <li><span className="text-cream-300/50">NEUROWORKS_AUTO_REBASE_RECOVERY</span> — set to <span className="text-cream-300/40">1</span> to enable post-push rebase recovery (off by default — risky)</li>
              <li><span className="text-cream-300/50">NEUROWORKS_NO_WARMUP</span> — set to <span className="text-cream-300/40">1</span> to skip Ollama pre-warm at boot</li>
              <li><span className="text-cream-300/50">NEUROWORKS_PORT</span> — backend bind port</li>
            </ul>
          </Card>

          <Card title="Workforce">
            {!peers ? (
              <div className="text-sm text-cream-300/60">Loading workforce…</div>
            ) : (
              <div className="space-y-3">
                <ClawbotRow bot={{ ...peers.self, ok: true }} isSelf />
                {peers.peers.length > 0 && peers.peers.map((p, i) => <ClawbotRow key={i} bot={p} />)}
                {externalAgents.length > 0 && (
                  <div className="pt-2 mt-2 border-t border-ink-800 space-y-2">
                    <div className="text-[11px] uppercase tracking-wider text-cream-300/50 px-1">External agents</div>
                    {externalAgents.map((a, i) => <ExternalAgentRow key={`ext-${i}`} agent={a} />)}
                  </div>
                )}
                <WorkerControls
                  hasActive={peers.peers.some(p => p.ok && p.ready)}
                  registry={peers.registry ?? []}
                  onChanged={async () => {
                    try { const r = await api.peers(); setPeers(r); } catch {}
                  }}
                />
              </div>
            )}
            <div className="text-[11px] text-cream-300/50 mt-4 leading-relaxed">
              <div className="text-cream-200 font-medium not-italic mb-1">How the workforce splits</div>
              <p className="italic">
                The <span className="font-mono not-italic">persona-shifter</span> peer is the worker — by default <span className="text-cream-100 not-italic">every</span> ad-hoc chat task is delegated to it (planning, research, synthesis). The primary Neuro then acts as the editor: it scores the peer's output for quality, scans for secrets, and only captures answers that are rooted in real context (vault notes, URLs, GitHub refs) to your second brain at <span className="font-mono not-italic">0-Inbox/</span>. Set <span className="font-mono not-italic">NEUROWORKS_DELEGATE_ALL=0</span> in <span className="font-mono not-italic">clawbot/.env</span> to revert to the older "delegate only on overload" routing.
              </p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// Renders the two LLM backends side-by-side so the customer can see at a
// glance which path is hot. Primary tag flags which backend handles a default
// /balanced call — the most common dispatch shape. When OR is disabled the
// row still renders, just dimmed with a "set OPENROUTER_API_KEY" nudge.
function LLMBackendBlock({ llm, fallbackOllama }: { llm: { ollama: { ok: boolean; model: string; error?: string }; openrouter: { enabled: boolean; ok: boolean; model: string; error?: string }; primary: "ollama" | "openrouter" } | null; fallbackOllama: { ok: boolean; model: string; error?: string } }) {
  const ollama = llm?.ollama ?? fallbackOllama;
  const or = llm?.openrouter;
  const primary = llm?.primary ?? "ollama";
  return (
    <div className="space-y-3 text-sm">
      <div className={`flex items-start gap-3 p-3 rounded-md border ${primary === "ollama" ? "border-violet-500/40 bg-violet-500/5" : "border-ink-800"}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-cream-50">Ollama</span>
            <span className="text-[10px] text-cream-300/50">local · free</span>
            {primary === "ollama" && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300">primary</span>}
          </div>
          <div className="mt-1">
            <StatusDot ok={ollama.ok} label={ollama.ok ? `${ollama.model} ready` : (ollama.error ?? "unreachable")} />
          </div>
        </div>
      </div>
      <div className={`flex items-start gap-3 p-3 rounded-md border ${primary === "openrouter" ? "border-violet-500/40 bg-violet-500/5" : or?.enabled ? "border-ink-800" : "border-ink-800/60 opacity-70"}`}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-cream-50">OpenRouter</span>
            <span className="text-[10px] text-cream-300/50">cloud · fast</span>
            {primary === "openrouter" && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300">primary</span>}
          </div>
          {or?.enabled ? (
            <div className="mt-1">
              <StatusDot ok={or.ok} label={or.ok ? `${or.model} ready` : (or.error ?? "unreachable")} />
            </div>
          ) : (
            <div className="text-[11px] text-cream-300/50 mt-1">
              Off — set <span className="font-mono">OPENROUTER_API_KEY</span> in <span className="font-mono">.env</span> to route slow profiles to a cloud model and reclaim seconds per call.
            </div>
          )}
        </div>
      </div>
      <div className="text-[11px] text-cream-300/50">
        Used by Engineering and Knowledge agents. Profiles are picked per step (planning, synthesis, triage, extraction). Each backend can run any profile.
      </div>
    </div>
  );
}

function VaultSyncBlock({ stats, vaultPath }: { stats: any; vaultPath?: string }) {
  const [retry, setRetry] = useState<{ state: "idle" | "running" | "ok" | "fail"; info?: string }>({ state: "idle" });
  if (!stats) return <div className="text-sm text-cream-300/60">Loading vault stats…</div>;
  const lc = stats.lastCommit;
  const ago = lc?.at ? Math.round((Date.now() - lc.at) / 1000) : null;
  const agoLabel = ago == null ? "never" : ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago / 60)}m ago` : `${Math.round(ago / 3600)}h ago`;
  const ok = lc?.ok === true;
  const pushed = lc?.pushed === true;
  const pushFailed = ok && !pushed;
  async function doRetry() {
    setRetry({ state: "running" });
    try {
      const r = await api.vaultRetryPush();
      if (r.pushed) setRetry({ state: "ok", info: r.aheadBy != null ? `synced (was ${r.aheadBy} ahead)` : "synced" });
      else setRetry({ state: "fail", info: r.error ?? "push failed" });
    } catch (e: any) { setRetry({ state: "fail", info: e?.message ?? String(e) }); }
  }
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Last commit" value={agoLabel} tone={ok ? "ok" : "default"} />
        <Stat label="Pushed" value={pushed ? "yes" : ok ? "local only" : "—"} tone={pushed ? "ok" : ok ? "warn" : "default"} />
        <Stat label="Pending writes" value={stats.pendingWrites} tone={stats.pendingWrites > 0 ? "warn" : "default"} />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Total commits" value={stats.totalCommits} />
        <Stat label="Writes coalesced" value={stats.coalescedSavings} />
        <Stat label="Debounce" value={`${stats.debounceMs}ms`} />
      </div>
      {pushFailed && (
        <div className="text-xs bg-flame-500/10 border border-flame-500/30 rounded-md px-3 py-2.5">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span className="font-medium text-flame-400">Origin push pending</span>
            <span className="text-cream-300/60">Commits are local; origin/main hasn't been updated.</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={doRetry}
              disabled={retry.state === "running"}
              className="text-xs px-3 py-1.5 rounded-md bg-violet-500/15 border border-violet-500/40 text-violet-300 hover:bg-violet-500/25 disabled:opacity-40"
            >
              {retry.state === "running" ? "Retrying…" : "Retry push"}
            </button>
            {retry.state === "ok" && <span className="text-[11px] text-leaf-400">✓ {retry.info}</span>}
            {retry.state === "fail" && <span className="text-[11px] text-coral-400 font-mono break-all">{retry.info}</span>}
          </div>
        </div>
      )}
      {lc?.error && !pushFailed && (
        <div className="text-xs text-flame-400 bg-flame-500/10 border border-flame-500/30 rounded-md px-3 py-2">
          <div className="font-medium mb-1">Last sync issue</div>
          <div className="font-mono break-all">{lc.error}</div>
        </div>
      )}
      {lc?.message && (
        <div className="text-[11px] text-cream-300/50 font-mono break-all">
          last: {lc.message}
        </div>
      )}
      {vaultPath && (
        <div className="text-[11px] text-cream-300/40 font-mono break-all">vault: {vaultPath}</div>
      )}
    </div>
  );
}

function Stat({ label, value, tone = "default" }: { label: string; value: any; tone?: "default" | "ok" | "warn" }) {
  const color = tone === "warn" ? "text-flame-400" : tone === "ok" ? "text-leaf-400" : "text-cream-50";
  return (
    <div className="bg-ink-950 border border-ink-800 rounded-md px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-cream-300/50">{label}</div>
      <div className={`font-display text-lg ${color}`}>{value ?? "—"}</div>
    </div>
  );
}

// Worker management — find / add / remove peer clawbots without restarting.
// Shows different empty-states depending on whether the registry has any
// known peers at all (truly empty) vs has peers it can't reach (booted but
// dropped). Both cases get a "Find workers" scan and a manual "Add by URL".
function WorkerControls({ hasActive, registry, onChanged }: { hasActive: boolean; registry: any[]; onChanged: () => Promise<void> }) {
  const [url, setUrl] = useState("");
  const [scan, setScan] = useState<{ state: "idle" | "running" | "done"; found?: number; tried?: number }>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [worker, setWorker] = useState<any>(null);
  const [workerBusy, setWorkerBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    async function tick() { try { const w = await api.workerStatus(); if (alive) setWorker(w); } catch {} }
    tick();
    const i = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(i); };
  }, []);
  async function startWorker() {
    setWorkerBusy(true); setErr(null);
    try { await api.startWorker(); await onChanged(); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setWorkerBusy(false); }
  }
  async function stopWorker() {
    setWorkerBusy(true); setErr(null);
    try { await api.stopWorker(); await onChanged(); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setWorkerBusy(false); }
  }

  const dropped = registry.filter(r => r.dropped);
  const knownButUnreachable = registry.filter(r => !r.dropped && r.consecutiveFails > 0);

  async function find() {
    setScan({ state: "running" });
    try {
      const r = await api.discoverPeers();
      setScan({ state: "done", found: r.found, tried: r.tried });
      await onChanged();
    } catch (e: any) { setErr(e?.message ?? String(e)); setScan({ state: "idle" }); }
  }
  async function add() {
    if (!url.trim()) return;
    setBusy(true); setErr(null);
    try { await api.registerPeer(url.trim()); setUrl(""); await onChanged(); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }
  async function remove(u: string) {
    try { await api.deregisterPeer(u); await onChanged(); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  return (
    <div className="space-y-2.5">
      {worker?.running && worker?.managed && (
        <div className="text-[11px] text-leaf-400 bg-leaf-500/10 border border-leaf-500/30 rounded-md px-3 py-2 flex items-center gap-2 flex-wrap">
          <span>✓ Managed worker running</span>
          <span className="text-cream-300/60 font-mono">pid {worker.pid} · {worker.url}</span>
          {worker.uptimeMs && <span className="text-cream-300/50">· up {Math.round(worker.uptimeMs / 1000)}s</span>}
          <button
            type="button"
            onClick={stopWorker}
            disabled={workerBusy}
            className="ml-auto text-[11px] text-cream-300/70 hover:text-coral-400 disabled:opacity-40"
          >
            {workerBusy ? "stopping…" : "stop"}
          </button>
        </div>
      )}
      {!hasActive && !worker?.running && (
        <div className="border border-dashed border-flame-500/30 bg-flame-500/5 rounded-lg p-3 text-xs">
          <div className="font-medium text-flame-400 mb-1">No worker peer reachable</div>
          <div className="text-cream-300/80 leading-relaxed">
            The primary will spawn one automatically on the next task, but you can start it now to get parallel sub-agents + the curation gate immediately.
          </div>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <button
              type="button"
              onClick={startWorker}
              disabled={workerBusy}
              className="text-xs px-3 py-1.5 rounded-md bg-violet-500 hover:bg-violet-600 text-white disabled:opacity-40"
            >
              {workerBusy ? "Starting…" : "Start managed worker"}
            </button>
            <span className="text-[11px] text-cream-300/50">or run <span className="font-mono">pnpm secondary</span> in a separate terminal</span>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={find}
          disabled={scan.state === "running"}
          className="text-xs px-3 py-1.5 rounded-md bg-violet-500/15 border border-violet-500/40 text-violet-300 hover:bg-violet-500/25 disabled:opacity-40"
        >
          {scan.state === "running" ? "Scanning…" : "Find workers"}
        </button>
        <span className="text-[11px] text-cream-300/50">Scans 127.0.0.1:7471–7475 for Neuro peers</span>
        {scan.state === "done" && scan.found! > 0 && (
          <span className="text-[11px] text-leaf-400">✓ found {scan.found} of {scan.tried}</span>
        )}
        {scan.state === "done" && scan.found === 0 && (
          <span className="text-[11px] text-cream-300/50">no peers responded (tried {scan.tried})</span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void add(); }}
          placeholder="http://127.0.0.1:7473 or remote URL"
          className="flex-1 min-w-[200px] bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded-md px-3 py-1.5 text-xs font-mono focus:outline-none placeholder:text-cream-300/30"
        />
        <button
          type="button"
          onClick={add}
          disabled={busy || !url.trim()}
          className="text-xs px-3 py-1.5 rounded-md bg-ink-800 border border-ink-700 hover:border-violet-500/40 text-cream-100 disabled:opacity-40"
        >
          Register peer
        </button>
      </div>
      {err && <div className="text-[11px] text-coral-400">{err}</div>}
      {(dropped.length > 0 || knownButUnreachable.length > 0) && (
        <details className="text-[11px]">
          <summary className="text-cream-300/60 cursor-pointer hover:text-cream-100">Registry ({registry.length} known)</summary>
          <ul className="mt-2 space-y-1">
            {registry.map(r => (
              <li key={r.url} className="flex items-center gap-2 flex-wrap">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${r.dropped ? "bg-coral-500" : r.consecutiveFails > 0 ? "bg-flame-500" : "bg-leaf-500"}`} />
                <span className="font-mono text-cream-200 truncate">{r.url}</span>
                <span className="text-cream-300/50">{r.dropped ? "dropped" : r.consecutiveFails > 0 ? `failing (${r.consecutiveFails})` : "ok"}</span>
                <span className="text-cream-300/40 italic">{r.source}</span>
                {r.note && <span className="text-cream-300/40 truncate">— {r.note}</span>}
                <button type="button" onClick={() => remove(r.url)} className="ml-auto text-cream-300/50 hover:text-coral-400">remove</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ClawbotRow({ bot, isSelf = false }: { bot: any; isSelf?: boolean }) {
  const busy = (bot.inflightJobs ?? 0) > 0;
  const dead = bot.ok === false;
  const role = (bot.role ?? "primary").toLowerCase();
  const roleColor = role === "persona-shifter" ? "text-flame-400 bg-flame-500/10 border-flame-500/30"
    : role === "general" ? "text-leaf-400 bg-leaf-500/10 border-leaf-500/30"
    : "text-violet-300 bg-violet-500/10 border-violet-500/30";
  return (
    <div className={`flex items-start gap-4 p-3 rounded-lg border ${dead ? "border-coral-500/30 bg-coral-500/5" : "border-ink-800 bg-ink-950"}`}>
      <div className="w-10 h-10 rounded-lg bg-flame-500/15 grid place-items-center text-flame-400 text-xl flex-shrink-0">⌬</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-cream-50">{bot.name ?? "Neuro"}</span>
          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${roleColor}`}>{role}</span>
          {isSelf && <span className="text-[10px] uppercase tracking-wider text-cream-300/40">this server</span>}
        </div>
        <div className="text-[11px] text-cream-300/70 mt-1 font-mono break-all">
          {bot.url ? `${bot.url} · ` : ""}{bot.model ?? "unknown model"}{bot.rttMs != null && !isSelf ? ` · ${bot.rttMs}ms` : ""}
        </div>
        <div className="text-[11px] text-cream-300/50 mt-1">
          {dead ? <span className="text-coral-400">offline{bot.error ? ` — ${bot.error}` : ""}</span>
            : busy ? `${bot.inflightJobs} task${bot.inflightJobs === 1 ? "" : "s"} in flight`
            : "idle"}
        </div>
      </div>
      <StatusDot ok={!dead && bot.ready !== false} label={dead ? "offline" : busy ? "busy" : "idle"} />
    </div>
  );
}

// External-agent row — mirrors ClawbotRow shape so the two read as one
// workforce, but the metadata differs: external CLI agents don't expose an
// inflight count (spawned per task), so we surface recent throughput as the
// heartbeat instead, and we surface the install path + install-state badge
// in place of the "this server" tag.
function ExternalAgentRow({ agent }: { agent: any }) {
  const r = agent.recentJobs ?? { last1h: 0, last24h: 0, total: 0, succeeded: 0, failed: 0 };
  const installed = !!agent.installed;
  const live = r.last1h > 0;
  return (
    <div className={`flex items-start gap-4 p-3 rounded-lg border ${!installed ? "border-coral-500/30 bg-coral-500/5" : "border-ink-800 bg-ink-950"}`}>
      <div className="w-10 h-10 rounded-lg bg-violet-500/15 grid place-items-center text-violet-300 text-xl flex-shrink-0">◈</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-cream-50">{agent.name}</span>
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border text-violet-300 bg-violet-500/10 border-violet-500/30">{agent.kind}</span>
          <span className="text-[10px] uppercase tracking-wider text-cream-300/40">external</span>
        </div>
        <div className="text-[11px] text-cream-300/70 mt-1 font-mono break-all">
          {installed ? (agent.binPath ?? "installed") : "not installed"}
        </div>
        <div className="text-[11px] text-cream-300/50 mt-1">
          {!installed ? <span className="text-coral-400">install Hermes Agent (Nous Research) to enable</span>
            : `${r.total} run${r.total === 1 ? "" : "s"} tracked · ${r.succeeded} succeeded · ${r.failed} failed${r.last1h ? ` · ${r.last1h} in last hour` : ""}`}
        </div>
      </div>
      <StatusDot ok={installed} label={!installed ? "offline" : live ? "busy" : "idle"} />
    </div>
  );
}

function ModelsSection() {
  const [data, setData] = useState<{ default: string; models: ModelInfo[]; recommendations: Record<string, string>; profiles: Record<string, Record<string, number>> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  async function load() {
    try { setData(await api.listModels()); } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function setDefault(name: string) {
    setBusy(name); setErr(""); setMsg("");
    try {
      const r = await api.setDefaultModel(name);
      setMsg(`Default is now ${r.default}. ${r.hint}`);
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  }

  if (!data) {
    return <Card title="Local models"><div className="text-sm text-cream-300/60">Loading models from Ollama…</div></Card>;
  }

  // Sort by score against a "balanced" need vector so the most useful model
  // surfaces first. Simple heuristic: capabilities sum minus cost weight.
  const ranked = [...data.models].sort((a, b) => {
    const sa = a.capabilities.jsonStrict + a.capabilities.reasoning + a.capabilities.longForm + a.capabilities.speed - a.capabilities.cost * 0.5;
    const sb = b.capabilities.jsonStrict + b.capabilities.reasoning + b.capabilities.longForm + b.capabilities.speed - b.capabilities.cost * 0.5;
    return sb - sa;
  });

  // Reverse map: model → which profiles recommend it
  const profileByModel: Record<string, string[]> = {};
  for (const [profile, model] of Object.entries(data.recommendations)) {
    (profileByModel[model] ??= []).push(profile);
  }

  return (
    <Card title="Local models">
      <div className="text-xs text-cream-300/70 mb-3">
        These are pulled into Ollama. The router scores each against the active task profile and picks the best fit per call.
        Default model: <span className="font-mono text-cream-100">{data.default}</span>
      </div>
      {msg && <div className="text-xs text-leaf-400 bg-leaf-500/10 border border-leaf-500/30 rounded-md px-3 py-2 mb-3">{msg}</div>}
      {err && <div className="text-xs text-coral-400 bg-coral-500/10 border border-coral-500/30 rounded-md px-3 py-2 mb-3">{err}</div>}

      <div className="space-y-2">
        {ranked.map(m => (
          <div key={m.name} className={`bg-ink-950 border rounded-lg p-3 ${m.name === data.default ? "border-violet-500/50" : "border-ink-800"}`}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <div className="font-mono text-sm text-cream-50">
                  {m.name}
                  {m.name === data.default && <span className="ml-2 text-[10px] uppercase tracking-wider bg-violet-500/20 text-violet-300 px-1.5 py-0.5 rounded border border-violet-500/30">default</span>}
                </div>
                <div className="text-[11px] text-cream-300/60 mt-0.5">
                  {m.family}{m.paramSize ? ` · ${m.paramSize}` : ""}{m.sizeGB ? ` · ${m.sizeGB} GB` : ""}
                </div>
                {profileByModel[m.name] && (
                  <div className="text-[10px] text-cream-300/50 mt-1">
                    Picked for: {profileByModel[m.name].map(p => <span key={p} className="font-mono text-violet-400 mr-2">{p}</span>)}
                  </div>
                )}
              </div>
              {m.name !== data.default && (
                <button
                  onClick={() => setDefault(m.name)}
                  disabled={busy === m.name}
                  className="text-xs text-cream-100 bg-ink-800 hover:bg-ink-700 border border-ink-700 px-3 py-1 rounded-md disabled:opacity-50"
                >
                  {busy === m.name ? "…" : "Set default"}
                </button>
              )}
            </div>
            <CapabilityBars cap={m.capabilities} />
          </div>
        ))}
      </div>

      <div className="mt-4 pt-3 border-t border-ink-800">
        <div className="text-[10px] uppercase tracking-wider text-cream-300/50 mb-2">Profile → Model routing</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono">
          {Object.entries(data.recommendations).map(([profile, model]) => (
            <div key={profile} className="flex justify-between gap-3">
              <span className="text-cream-300/60">{profile}</span>
              <span className="text-cream-100 truncate">{model}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function CapabilityBars({ cap }: { cap: { jsonStrict: number; reasoning: number; longForm: number; speed: number; cost: number } }) {
  const rows: { label: string; value: number; max: number; color: string; invert?: boolean }[] = [
    { label: "JSON strict", value: cap.jsonStrict, max: 10, color: "bg-violet-500" },
    { label: "Reasoning", value: cap.reasoning, max: 10, color: "bg-leaf-500" },
    { label: "Long-form", value: cap.longForm, max: 10, color: "bg-flame-500" },
    { label: "Speed", value: cap.speed, max: 10, color: "bg-cream-300" },
    { label: "Cost", value: cap.cost, max: 10, color: "bg-coral-500", invert: true },
  ];
  return (
    <div className="grid grid-cols-5 gap-2">
      {rows.map(r => (
        <div key={r.label} className="text-[10px]">
          <div className="text-cream-300/60 mb-0.5">{r.label}{r.invert ? " (lower = better)" : ""}</div>
          <div className="h-1 bg-ink-800 rounded overflow-hidden">
            <div className={`h-full ${r.color}`} style={{ width: `${(r.value / r.max) * 100}%` }} />
          </div>
          <div className="text-cream-300/40 mt-0.5 font-mono">{r.value}/{r.max}</div>
        </div>
      ))}
    </div>
  );
}

// Settings > System Access (docs/naxie-architecture.md §2.2/§8.5) — the
// on/off switches gating Naxie's host-level tools (open apps, screenshots,
// volume/brightness, clipboard read/write). Both default OFF server-side;
// this card is the only UI that can flip them.
function SystemAccessCard() {
  const [settings, setSettings] = useState<HostToolsSettings | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { const r = await api.hostToolsSettings(); setSettings(r.settings); } catch {}
  }
  useEffect(() => { load(); }, []);

  async function update(patch: Partial<HostToolsSettings>) {
    setBusy(true);
    try {
      const r = await api.updateHostToolsSettings(patch);
      setSettings(r.settings);
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="System Access">
      <div className="text-xs text-cream-300/70 mb-3">
        Grants Naxie real OS-level access — open apps, take screenshots, control volume/brightness, read/write the
        clipboard. Both switches default off; leave off unless you actively want Naxie to use them.
      </div>
      {!settings ? (
        <div className="text-sm text-cream-300/60">Loading…</div>
      ) : (
        <div className="space-y-3">
          <ToggleRow
            label="Allow system control"
            hint="Open apps (allowlisted), screenshots, volume, brightness, battery status."
            checked={settings.allowSystemControl}
            disabled={busy}
            onChange={v => update({ allowSystemControl: v })}
          />
          <ToggleRow
            label="Allow clipboard access"
            hint="Read or write the system clipboard."
            checked={settings.allowClipboardAccess}
            disabled={busy}
            onChange={v => update({ allowClipboardAccess: v })}
          />
          <div>
            <div className="text-[11px] text-cream-300/60 mb-1">Git repo path (the only repo Naxie may check/pull)</div>
            <input
              defaultValue={settings.gitRepoPath}
              onBlur={e => { if (e.target.value.trim() !== settings.gitRepoPath) update({ gitRepoPath: e.target.value }); }}
              placeholder="D:\path\to\repo"
              disabled={busy}
              className="w-full bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded-md px-3 py-1.5 text-xs font-mono focus:outline-none placeholder:text-cream-300/30 disabled:opacity-40"
            />
          </div>
        </div>
      )}
    </Card>
  );
}

function ToggleRow({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3 p-3 rounded-md border border-ink-800 bg-ink-950">
      <div className="min-w-0">
        <div className="text-sm text-cream-100">{label}</div>
        <div className="text-[11px] text-cream-300/50 mt-0.5">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`flex-shrink-0 relative w-9 h-5 rounded-full transition-colors disabled:opacity-40 ${checked ? "bg-violet-500" : "bg-ink-700"}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-cream-50 transition-transform ${checked ? "translate-x-4" : ""}`} />
      </button>
    </div>
  );
}

// Org dashboard (docs/naxie-architecture.md §4/§8.5) — a read-only diagnostics
// view over the per-role task backlog. lib/jobs.ts already files every
// finished Job onto a role's backlog; this is the first surface that reads
// any of it back. Deliberately not wired into Approvals.tsx yet (§8.5's
// fuller approval-inbox integration is a separate pass).
const ORG_ROLES: OrgRole[] = ["scheduler", "researcher", "executor", "admin", "architect"];
const ORG_STATUSES: OrgTaskStatus[] = ["backlog", "active", "blocked", "waiting-on-approval", "done"];

function OrgTasksCard() {
  const [tasks, setTasks] = useState<OrgTask[] | null>(null);
  const [role, setRole] = useState<OrgRole | "">("");
  const [status, setStatus] = useState<OrgTaskStatus | "">("");

  async function load() {
    try {
      const r = await api.orgTasks({ role: role || undefined, status: status || undefined });
      setTasks(r.tasks);
    } catch {}
  }
  useEffect(() => { load(); }, [role, status]);

  return (
    <Card title="Org tasks">
      <div className="text-xs text-cream-300/70 mb-3">
        Naxie's internal per-role backlog — diagnostics only, not a feature you're meant to manage directly.
      </div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <select value={role} onChange={e => setRole(e.target.value as OrgRole | "")} className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1 text-[11px] text-cream-100">
          <option value="">All roles</option>
          {ORG_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value as OrgTaskStatus | "")} className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1 text-[11px] text-cream-100">
          <option value="">All statuses</option>
          {ORG_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      {!tasks ? (
        <div className="text-sm text-cream-300/60">Loading…</div>
      ) : tasks.length === 0 ? (
        <div className="text-sm text-cream-300/60">No org tasks yet — they're filed automatically as jobs finish.</div>
      ) : (
        <div className="space-y-1.5 max-h-80 overflow-y-auto">
          {tasks.map(t => (
            <div key={t.id} className="flex items-center gap-2 p-2 rounded-md border border-ink-800 bg-ink-950 text-xs">
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-violet-500/30 text-violet-300 bg-violet-500/10 flex-shrink-0">{t.role}</span>
              <span className="text-cream-100 truncate flex-1">{t.title}</span>
              <span className="text-cream-300/50 flex-shrink-0">{t.status}</span>
              <span className="text-cream-300/40 flex-shrink-0">{new Date(t.updatedAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

