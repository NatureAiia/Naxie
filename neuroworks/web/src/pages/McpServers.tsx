import { useState, useEffect } from "react";
import { Cable, Plus, Trash2, CheckCircle2, Loader2, X, AlertTriangle, Play, Power, ListTree } from "lucide-react";
import { api, type McpServer, type McpServerInput, type McpTool, type McpCallResult } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";

// MCP-client servers — register EXTERNAL MCP servers (community catalog, e.g.
// github.com/punkpeye/awesome-mcp-servers: filesystem, browser, Postgres,
// Google Drive, ...) as local child-process tool sources for the agent. Each
// server is a command + args (+ optional env for its own API keys); the
// server is spawned on first use, its tools are discovered via MCP's
// tools/list, and the agent reaches them through mcp.describe / mcp.call.
//
// More privileged than a Connector (a spawned process isn't scoped to an
// origin the way an HTTP call is) — so every call is ALWAYS approval-gated,
// with no read/write auto-approve toggle.

function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function McpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<McpServer | null>(null);

  async function refresh() {
    try { const l = await api.listMcpServers(); setServers(l.servers); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function toggle(s: McpServer) {
    setBusy(s.id);
    try { await api.setMcpServerDisabled(s.id, !s.disabled); await refresh(); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(null); }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Remove MCP server "${label}"? The agent will no longer be able to call its tools.`)) return;
    try { await api.removeMcpServer(id); showToast("MCP server removed", "success"); refresh(); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><Cable size={24} /> MCP Servers</h1>
        <p className="text-sm text-cream-300/70 mt-1 max-w-3xl">
          Plug in any Model Context Protocol server — filesystem, browser, database, or one from the community
          catalog — as a local tool source. Each server is a <span className="font-mono">command</span> the operator
          configures; it's spawned on first use and its tools are discovered automatically. Every call is
          <span className="text-cream-200"> always approval-gated</span> — an MCP server runs as a local process, not
          a scoped HTTP endpoint.
        </p>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => setAdding(true)}><Plus size={14} /> Add MCP server</Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-cream-300/60"><Loader2 size={16} className="animate-spin" /> Loading MCP servers…</div>
      ) : servers.length === 0 ? (
        <Card>
          <div className="text-center py-8 text-cream-300/60 text-sm">
            No MCP servers yet. Add one with the command that launches it (e.g. <span className="font-mono">npx -y @modelcontextprotocol/server-filesystem /path</span>)
            — see <a href="https://github.com/punkpeye/awesome-mcp-servers" target="_blank" rel="noreferrer" className="text-violet-400 hover:text-violet-300">awesome-mcp-servers</a> for options.
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {servers.map(s => {
            const dot = s.disabled ? "bg-ink-600" : s.lastError ? "bg-coral-500" : s.lastConnectedAt ? "bg-leaf-500" : "bg-amber-400/80 animate-pulse";
            return (
              <Card key={s.id}>
                <div className="flex items-start gap-3">
                  <div className="relative mt-0.5">
                    <div className="w-9 h-9 rounded-lg bg-violet-500/15 grid place-items-center text-violet-300 text-xs font-semibold">{s.label.slice(0, 2).toUpperCase()}</div>
                    <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-ink-900 ${dot}`}
                      title={s.disabled ? "Disabled" : s.lastError ? `Error — ${s.lastError}` : s.lastConnectedAt ? "Connected" : "Not started yet"} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-cream-100 flex items-center gap-2 flex-wrap">
                      {s.label}
                      <span className="font-mono text-[11px] text-cream-300/50">{s.command} {s.args.join(" ")}</span>
                      {s.envKeys.length > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60">{s.envKeys.length} env var{s.envKeys.length === 1 ? "" : "s"}</span>}
                      {typeof s.lastToolCount === "number" && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60">{s.lastToolCount} tool{s.lastToolCount === 1 ? "" : "s"}</span>}
                      {s.disabled && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/40">disabled</span>}
                    </div>
                    {s.description && <div className="text-[12px] text-cream-300/60 mt-0.5">{s.description}</div>}
                    <div className="text-[11px] mt-1">
                      {s.lastError
                        ? <span className="text-coral-400/90">Error · {s.lastError}</span>
                        : s.lastConnectedAt
                          ? <span className="text-leaf-400/90">Connected · {relTime(s.lastConnectedAt)}</span>
                          : <span className="text-cream-300/50">Not started yet — starts on first use</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="subtle" onClick={() => setInspecting(s)} disabled={s.disabled}><ListTree size={13} /> Tools</Button>
                    <Button variant="subtle" onClick={() => toggle(s)} disabled={busy === s.id}>
                      {busy === s.id ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />} {s.disabled ? "Enable" : "Disable"}
                    </Button>
                    <button type="button" onClick={() => remove(s.id, s.label)} className="text-cream-300/50 hover:text-coral-400 p-1.5" title="Remove"><Trash2 size={15} /></button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {adding && <AddMcpServerModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} />}
      {inspecting && <ToolsModal server={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  );
}

const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60 placeholder:text-cream-300/30";

function AddMcpServerModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState("");
  const [envJson, setEnvJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    let env: Record<string, string> | undefined;
    if (envJson.trim()) {
      try { env = JSON.parse(envJson); }
      catch { setErr("Env vars must be valid JSON (an object of NAME → value)"); return; }
    }
    // args: split on whitespace, respecting simple "quoted strings"
    const args = (argsText.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(a => a.replace(/^['"]|['"]$/g, ""));
    const body: McpServerInput = { label, description: description || undefined, command, args, env };
    setSaving(true);
    try {
      await api.addMcpServer(body);
      showToast("MCP server added", "success");
      onSaved();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-lg bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">Add MCP server</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Label <span className="text-coral-400">*</span></label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Filesystem" className={FIELD} />
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Description</label>
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="What this server exposes — agents read this" className={FIELD} />
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Command <span className="text-coral-400">*</span></label>
            <input value={command} onChange={e => setCommand(e.target.value)} placeholder="npx" className={`${FIELD} font-mono`} autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Args</label>
            <input value={argsText} onChange={e => setArgsText(e.target.value)} placeholder='-y @modelcontextprotocol/server-filesystem /home/user/docs' className={`${FIELD} font-mono`} autoComplete="off" spellCheck={false} />
            <div className="text-[10px] text-cream-300/40 mt-1">Space-separated; wrap an argument with spaces in quotes.</div>
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Env vars (JSON, optional)</label>
            <textarea value={envJson} onChange={e => setEnvJson(e.target.value)} rows={3}
              placeholder={'{ "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }'} className={`${FIELD} font-mono text-[12px]`} spellCheck={false} />
            <div className="text-[10px] text-cream-300/40 mt-1">Encrypted at rest, never shown again after saving — for a server's own API keys (e.g. a GitHub MCP server's PAT).</div>
          </div>
          <div className="text-[11px] text-cream-300/60 bg-ink-950/40 border border-ink-800 rounded-lg px-3 py-2">
            This runs a local command with the server's own OS permissions. Only add servers from sources you trust —
            see <a href="https://github.com/punkpeye/awesome-mcp-servers" target="_blank" rel="noreferrer" className="text-violet-400 hover:text-violet-300">awesome-mcp-servers</a> for a curated list.
          </div>
        </div>

        {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
        <div className="flex justify-end pt-1">
          <Button onClick={submit} disabled={saving || !label || !command}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add server</Button>
        </div>
      </div>
    </div>
  );
}

function ToolsModal({ server, onClose }: { server: McpServer; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [trying, setTrying] = useState<McpTool | null>(null);

  async function load() {
    setLoading(true); setErr(null);
    try { const r = await api.mcpServerTools(server.id); setTools(r.tools); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [server.id]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-lg bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-3 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">Tools — {server.label}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-cream-300/60 py-4"><Loader2 size={16} className="animate-spin" /> Starting server &amp; discovering tools…</div>
        ) : err ? (
          <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>
        ) : tools.length === 0 ? (
          <div className="text-sm text-cream-300/60 py-4 text-center">This server reported no tools.</div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-auto">
            {tools.map(t => (
              <div key={t.name} className="rounded-lg bg-ink-950/50 border border-ink-800 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-mono text-sm text-cream-100">{t.name}</div>
                  <Button variant="subtle" onClick={() => setTrying(t)}><Play size={12} /> Try</Button>
                </div>
                {t.description && <div className="text-[12px] text-cream-300/60 mt-1">{t.description}</div>}
              </div>
            ))}
          </div>
        )}

        {trying && <TryToolPanel server={server} tool={trying} onClose={() => setTrying(null)} />}
      </div>
    </div>
  );
}

function TryToolPanel({ server, tool, onClose }: { server: McpServer; tool: McpTool; onClose: () => void }) {
  const [argsJson, setArgsJson] = useState("{}");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<McpCallResult | null>(null);

  async function run() {
    setRunning(true); setResult(null);
    let args: any = {};
    try { args = argsJson.trim() ? JSON.parse(argsJson) : {}; } catch { /* send raw text as fallback */ }
    try {
      const { result } = await api.callMcpServer(server.id, { tool: tool.name, arguments: args });
      setResult(result);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message ?? String(e) });
    } finally { setRunning(false); }
  }

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950/60 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm text-cream-100">Try — <span className="font-mono">{tool.name}</span></div>
        <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={14} /></button>
      </div>
      <textarea value={argsJson} onChange={e => setArgsJson(e.target.value)} rows={3} placeholder='{ "path": "/tmp/x.txt" }' className={`${FIELD} font-mono text-[12px]`} spellCheck={false} />
      <div className="flex justify-end">
        <Button onClick={run} disabled={running}>{running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Send</Button>
      </div>
      {result && (
        <div className="space-y-1">
          <div className={`text-[12px] flex items-center gap-1.5 ${result.ok ? "text-leaf-400" : "text-coral-400"}`}>
            {result.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />} {result.error ?? "ok"}{result.truncated ? " · truncated" : ""}
          </div>
          <pre className="text-[11px] text-cream-200/90 font-mono whitespace-pre-wrap break-words max-h-56 overflow-auto">
            {typeof result.content === "string" ? result.content : JSON.stringify(result.content, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
