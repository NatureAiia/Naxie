import { useState, useEffect, ChangeEvent } from "react";
import { Cable, Plus, Trash2, CheckCircle2, Loader2, AlertTriangle, Play, Power, ListTree, Sparkles, X } from "lucide-react";
import { api, type McpServer, type McpServerInput, type McpCatalogEntry, type McpTool, type McpCallResult } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { Modal, ConfirmDialog } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { Input, Textarea } from "../components/forms";
import { relTime } from "../lib/time";

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

export function McpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [prefill, setPrefill] = useState<McpCatalogEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<McpServer | null>(null);
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);

  async function refresh() {
    try { const l = await api.listMcpServers(); setServers(l.servers); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { api.mcpCatalog().then(r => setCatalog(r.catalog)).catch(() => {}); }, []);

  const installedCommands = new Set(servers.map(s => `${s.command} ${s.args.join(" ")}`));
  const suggestions = catalog.filter(c => !installedCommands.has(`${c.command} ${c.args.join(" ")}`));

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

  function openWith(entry: McpCatalogEntry | null) {
    setPrefill(entry);
    setAdding(true);
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
        <Button onClick={() => openWith(null)}><Plus size={14} /> Add MCP server</Button>
      </div>

      {suggestions.length > 0 && (
        <Card>
          <div className="text-[11px] text-cream-300/70 flex items-center gap-1.5 mb-2"><Sparkles size={13} /> Suggested servers — hand-verified against the official MCP servers list</div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map(c => (
              <button key={c.id} type="button" onClick={() => openWith(c)}
                title={c.description}
                className="text-[12px] px-2.5 py-1.5 rounded-lg bg-ink-950/50 border border-ink-800 text-cream-200 hover:border-violet-500/50 hover:text-cream-50 flex items-center gap-1.5">
                <Plus size={11} /> {c.label}
              </button>
            ))}
          </div>
        </Card>
      )}

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

      {adding && <AddMcpServerModal prefill={prefill} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} />}
      {inspecting && <ToolsModal server={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  );
}

const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60 placeholder:text-cream-300/30";

function AddMcpServerModal({ prefill, onClose, onSaved }: { prefill: McpCatalogEntry | null; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(prefill?.label ?? "");
  const [description, setDescription] = useState(prefill?.description ?? "");
  const [command, setCommand] = useState(prefill?.command ?? "npx");
  const [argsText, setArgsText] = useState(prefill?.args.map(a => a.includes(" ") ? `"${a}"` : a).join(" ") ?? "");
  const [envJson, setEnvJson] = useState(prefill?.env?.length ? JSON.stringify(Object.fromEntries(prefill.env.map(e => [e.name, ""])), null, 2) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Confirm-before-external-action (ported from KimmyDeku/sebastian's
  // ConfirmDialog pattern): filling the form doesn't start the process —
  // "Add server" opens a confirm step naming exactly what will run, and
  // nothing calls the API until that's confirmed.
  const [pendingBody, setPendingBody] = useState<McpServerInput | null>(null);

  function review() {
    setErr(null);
    let env: Record<string, string> | undefined;
    if (envJson.trim()) {
      try { env = JSON.parse(envJson); }
      catch { setErr("Env vars must be valid JSON (an object of NAME → value)"); return; }
    }
    // args: split on whitespace, respecting simple "quoted strings"
    const args = (argsText.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(a => a.replace(/^['"]|['"]$/g, ""));
    setPendingBody({ label, description: description || undefined, command, args, env });
  }

  async function confirmAdd() {
    if (!pendingBody) return;
    setSaving(true);
    try {
      await api.addMcpServer(pendingBody);
      showToast("MCP server added", "success");
      onSaved();
    } catch (e: any) { setErr(e?.message ?? String(e)); setPendingBody(null); }
    finally { setSaving(false); }
  }

  return (
    <Modal open onClose={onClose} title="Add MCP server" size="lg" showCloseButton={true}>
      <div className="space-y-4">
        <Input
          label="Label"
          value={label}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
          placeholder="Filesystem"
        />
        <Input
          label="Description"
          value={description}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
          placeholder="What this server exposes — agents read this"
        />
        <Input
          label="Command"
          value={command}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setCommand(e.target.value)}
          placeholder="npx"
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          label="Args"
          value={argsText}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setArgsText(e.target.value)}
          placeholder='-y @modelcontextprotocol/server-filesystem /home/user/docs'
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="text-[11px] text-cream-300/40">Space-separated; wrap an argument with spaces in quotes.</div>
        <Textarea
          label="Env vars (JSON, optional)"
          value={envJson}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setEnvJson(e.target.value)}
          rows={3}
          placeholder={'{ "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }'}
          className="font-mono text-[12px]"
          spellCheck={false}
        />
        <div className="text-[11px] text-cream-300/40">Encrypted at rest, never shown again after saving.</div>
        {prefill?.env?.length ? (
          <div className="text-[11px] text-amber-300/70 p-2 bg-amber-500/5 border border-amber-500/20 rounded-lg">
            {prefill.label} needs: {prefill.env.map(e => `${e.name}${e.required ? "" : " (optional)"}`).join(", ")}
          </div>
        ) : null}
        <div className="text-xs text-cream-300/60 bg-ink-900/50 border border-ink-800 rounded-xl px-4 py-3 leading-relaxed">
          This runs a local command with the server's own OS permissions. Only add servers from sources you trust.
        </div>
      </div>

      {err && <div className="text-sm text-coral-400 flex items-center gap-2 p-3 rounded-lg bg-coral-500/5 border border-coral-500/20"><AlertTriangle size={16} /> {err}</div>}
      <div className="flex justify-end pt-2">
        <Button onClick={review} disabled={!label || !command} className="px-6 py-2"><Plus size={16} /> Add server</Button>
      </div>

      <ConfirmDialog
        open={pendingBody !== null}
        title="Add this MCP server?"
        rows={pendingBody ? [
          ["Label", pendingBody.label],
          ["Command", [pendingBody.command, ...(pendingBody.args ?? [])].join(" ")],
          ["Description", pendingBody.description ?? "—"],
          ["Env vars", pendingBody.env ? Object.keys(pendingBody.env).join(", ") : "none"],
        ] : []}
        body="This starts a new local process the next time the agent uses it, with its own OS permissions. Nothing runs until you confirm — and every tool call it makes still needs your approval afterward."
        confirmLabel="Add server"
        busy={saving}
        onConfirm={confirmAdd}
        onCancel={() => setPendingBody(null)}
      />
    </Modal>
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
    <div className="fixed inset-0 z-50 bg-ink-900 flex flex-col overflow-hidden" onClick={onClose}>
      <div className="flex-1 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-6 border-b border-ink-800 shrink-0">
          <h2 className="text-2xl text-cream-50 font-medium flex items-center gap-3"><ListTree size={24} /> Tools — {server.label}</h2>
          <button onClick={onClose} className="p-2 text-cream-300/50 hover:text-cream-100 hover:bg-ink-800 rounded-lg transition-colors"><X size={24} /></button>
        </div>

        <div className="flex-1 grid grid-cols-1 lg:grid-cols-4 overflow-hidden">
          <div className="lg:col-span-1 p-6 space-y-6 border-r border-ink-800 overflow-y-auto bg-ink-950/30">
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-ink-900 border border-ink-800">
                <div className="text-xs font-medium text-cream-300/70 uppercase tracking-wider mb-2">Server Info</div>
                <div className="text-sm text-cream-100 font-medium mb-1">{server.label}</div>
                <div className="text-[11px] font-mono text-cream-300/50 break-all">{server.command} {server.args.join(" ")}</div>
              </div>
              {server.description && (
                <div className="text-xs text-cream-300/60 leading-relaxed italic">
                  "{server.description}"
                </div>
              )}
            </div>
            <div className="p-4 rounded-xl bg-ink-950/50 border border-ink-800 text-xs text-cream-300/50 leading-relaxed">
              MCP servers run as local processes with your OS permissions. Every tool call is manually approved before execution.
            </div>
          </div>

          <div className="lg:col-span-3 p-6 space-y-4 overflow-y-auto bg-ink-900">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-medium text-cream-300/70 uppercase tracking-widest">Available Tools</h3>
              {tools.length > 0 && <span className="text-xs bg-ink-800 text-cream-300 px-3 py-1 rounded-full border border-ink-700">{tools.length} tools found</span>}
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-cream-300/60 py-20 justify-center"><Loader2 size={20} className="animate-spin" /> Starting server &amp; discovering tools…</div>
            ) : err ? (
              <div className="text-sm text-coral-400 flex items-center gap-2 p-6 rounded-2xl bg-coral-500/5 border border-coral-500/20"><AlertTriangle size={18} /> {err}</div>
            ) : tools.length === 0 ? (
              <div className="text-sm text-cream-300/50 text-center py-32 border-2 border-dashed border-ink-800 rounded-2xl">This server reported no tools.</div>
            ) : tools.map(t => (
              <div key={t.name} className="rounded-2xl bg-ink-950/50 border border-ink-800 p-5 hover:border-violet-500/40 transition-all group">
                <div className="flex items-center justify-between gap-4">
                  <div className="font-mono text-base text-cream-100">{t.name}</div>
                  <Button variant="subtle" className="px-4 py-1.5" onClick={() => setTrying(t)}><Play size={14} /> Try tool</Button>
                </div>
                {t.description && <div className="text-sm text-cream-300/60 mt-2 leading-relaxed">{t.description}</div>}
                {trying?.name === t.name && <TryToolPanel server={server} tool={t} onClose={() => setTrying(null)} />}
              </div>
            ))}
          </div>
        </div>
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
