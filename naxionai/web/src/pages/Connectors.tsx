import { useEffect, useRef, useState } from "react";
import { useSearchParams, Navigate } from "react-router-dom";
import { Boxes, Plus, Trash2, CheckCircle2, Loader2, X, AlertTriangle, Play, Pencil, Lock, Unlock, Plug, Sparkles, Database } from "lucide-react";
import { api, type Connector, type ConnectorAuthCatalog, type ConnectorAuthType, type ConnectorInput, type ConnectorCallResult, type ConnectorTemplate, type User } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { TabGroup, type TabDef } from "../components/TabGroup";
import { Modal } from "../components/Modal";
import { Input } from "../components/forms";
import { relTime } from "../lib/time";
import { NaxiePersonalConnectors } from "../components/NaxiePersonalConnectors";
import { LibraryConnections } from "../components/library/LibraryConnections";
import { CompanyLinksPanel } from "../components/library/CompanyLinksPanel";

// Connectors — register the company's existing systems (any HTTP API) so agents
// can read from / act on them. Each connector stores a base URL, an auth scheme
// (encrypted at rest), and an endpoint manifest that agents read via
// connector.describe before calling with connector.call. Read-only by default.

export function Connectors() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Policies moved back out to its own System-group page (/policies).
  if (searchParams.get("tab") === "policies") {
    return <Navigate to="/policies" replace />;
  }
  const activeTab: "connectors" | "databases" = searchParams.get("tab") === "databases" ? "databases" : "connectors";
  function setTab(tab: "connectors" | "databases") {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (tab === "connectors") next.delete("tab");
      else next.set("tab", tab);
      return next;
    }, { replace: true });
  }
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => { api.session().then(s => setUser(s.user)).catch(() => setUser(null)); }, []);
  const role = (user?.role ?? "") as string;
  const layer = !user ? "superadmin" : role === "superadmin" ? "superadmin" : role === "admin" ? "admin" : "staff";
  const canSeeDatabases = layer !== "staff";
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [authTypes, setAuthTypes] = useState<ConnectorAuthCatalog[]>([]);
  const [templates, setTemplates] = useState<ConnectorTemplate[]>([]);
  const [editing, setEditing] = useState<Connector | "new" | null>(null);
  const [template, setTemplate] = useState<ConnectorTemplate | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [trying, setTrying] = useState<Connector | null>(null);
  const [connecting, setConnecting] = useState<Connector | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);

  async function refresh() {
    try { const l = await api.listConnectors(); setConnectors(l.connectors); } catch {}
    try { const c = await api.connectorsCatalog(); setAuthTypes(c.authTypes); } catch {}
    try { const t = await api.connectorTemplates(); setTemplates(t.templates); } catch {}
  }
  useEffect(() => { void refresh(); }, []);

  async function test(id: string) {
    setTesting(id);
    try {
      const r = await api.testConnector(id);
      showToast(r.ok ? `✓ ${r.detail}` : `Test failed: ${r.detail}`, r.ok ? "success" : "error");
      await refresh();
    } catch (e: any) { showToast(`Test error: ${e?.message ?? e}`, "error"); }
    finally { setTesting(null); }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Remove connector "${label}"? Agents will no longer be able to call this system.`)) return;
    try { await api.removeConnector(id); showToast("Connector removed", "success"); refresh(); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connectors"
        subtitle={activeTab === "databases"
          ? "Company database connections and curated department data for agents to query."
          : "Wire up your existing company systems so agents can read & act on them. Each connector holds a base URL, an auth scheme (encrypted at rest), and an endpoint manifest agents read before calling."}
        icon={<Boxes size={28} />}
        action={
          <TabGroup
            tabs={[
              { id: "connectors", label: <><Boxes size={14} /> Connectors</> },
              { id: "databases", label: <><Database size={14} /> Databases</> },
            ]}
            value={activeTab}
            onChange={(id) => setTab(id as "connectors" | "databases")}
            variant="pill"
          />
        }
      />

      {activeTab === "databases" ? (
        canSeeDatabases ? (
          <div className="space-y-4">
            <LibraryConnections />
            <CompanyLinksPanel />
          </div>
        ) : (
          <div className="text-sm text-cream-300/70 bg-ink-900 border border-ink-800 rounded-lg px-4 py-3">
            You don't have permission to view database connections. Ask an admin for access.
          </div>
        )
      ) : (
        <>
          <NaxiePersonalConnectors />

      <div className="flex justify-end gap-2 relative">
        {templates.length > 0 && (
          <div className="relative">
            <Button variant="subtle" onClick={() => setShowTemplates(s => !s)}><Sparkles size={14} /> Quick add</Button>
            {showTemplates && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowTemplates(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-ink-900 border border-ink-700 rounded-xl p-1.5 shadow-xl">
                  {templates.map(t => (
                    <button key={t.id} type="button"
                      onClick={() => { setTemplate(t); setEditing("new"); setShowTemplates(false); }}
                      className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-ink-800 text-sm text-cream-100">
                      <div>{t.label}</div>
                      <div className="text-[11px] text-cream-300/60 line-clamp-2">{t.description}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        <Button onClick={() => { setTemplate(null); setEditing("new"); }}><Plus size={14} /> Add connector</Button>
      </div>

      {connectors.length === 0 ? (
        <Card>
          <div className="text-center py-8 text-cream-300/60 text-sm">
            No connectors yet. Add your first company system — point it at the base URL, choose how it authenticates, and
            (optionally) describe its endpoints so agents know what they can do.
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {connectors.map(c => {
            const t = c.lastTest;
            const dot = !t ? "bg-amber-400/80 animate-pulse" : t.ok ? "bg-leaf-500" : "bg-coral-500";
            return (
              <Card key={c.id}>
                <div className="flex items-start gap-3">
                  <div className="relative mt-0.5">
                    <div className="w-9 h-9 rounded-lg bg-violet-500/15 grid place-items-center text-violet-300 text-xs font-semibold">{c.label.slice(0, 2).toUpperCase()}</div>
                    <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-ink-900 ${dot}`} title={t ? `${t.ok ? "Working" : "Failing"} — ${t.detail}` : "Not tested yet"} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-cream-100 flex items-center gap-2 flex-wrap">
                      {c.label}
                      <span className="font-mono text-[11px] text-cream-300/50">{c.baseUrl}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/70">{c.auth.type}</span>
                      {c.auth.type === "oauth2" && (
                        c.auth.secretSet
                          ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-leaf-500/15 text-leaf-400 inline-flex items-center gap-1"><Plug size={9} /> connected</span>
                          : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-400/15 text-amber-300 inline-flex items-center gap-1"><Plug size={9} /> not connected</span>
                      )}
                      {c.writeEnabled
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-coral-500/15 text-coral-300 inline-flex items-center gap-1"><Unlock size={9} /> writes on</span>
                        : <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60 inline-flex items-center gap-1"><Lock size={9} /> read-only</span>}
                      {c.skipApprovalForReads && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300" title="Reads skip the approval gate">instant reads</span>}
                      {(c.endpoints?.length ?? 0) > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60">{c.endpoints!.length} endpoint{c.endpoints!.length === 1 ? "" : "s"}</span>}
                    </div>
                    {c.description && <div className="text-[12px] text-cream-300/60 mt-0.5">{c.description}</div>}
                    <div className="text-[11px] mt-1">
                      {t
                        ? <span className={t.ok ? "text-leaf-400/90" : "text-coral-400/90"}>{t.ok ? "Working" : "Failing"} · {t.detail} · {relTime(t.at)}</span>
                        : <span className="text-amber-300/80">Not tested yet</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {c.auth.type === "oauth2" && (
                      <Button variant="subtle" onClick={() => setConnecting(c)}>
                        <Plug size={13} /> {c.auth.secretSet ? "Reconnect" : "Connect"}
                      </Button>
                    )}
                    <Button variant="subtle" onClick={() => setTrying(c)}><Play size={13} /> Try</Button>
                    <Button variant="subtle" onClick={() => test(c.id)} disabled={testing === c.id}>
                      {testing === c.id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Test
                    </Button>
                    <button type="button" onClick={() => setEditing(c)} className="text-cream-300/50 hover:text-cream-100 p-1.5" title="Edit"><Pencil size={15} /></button>
                    <button type="button" onClick={() => remove(c.id, c.label)} className="text-cream-300/50 hover:text-coral-400 p-1.5" title="Remove"><Trash2 size={15} /></button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <ConnectorModal
          authTypes={authTypes}
          existing={editing === "new" ? null : editing}
          template={editing === "new" ? template : null}
          onClose={() => { setEditing(null); setTemplate(null); }}
          onSaved={() => { setEditing(null); setTemplate(null); refresh(); }}
        />
      )}
      {trying && <TryModal connector={trying} onClose={() => setTrying(null)} />}
      {connecting && <ConnectModal connector={connecting} onClose={() => setConnecting(null)} onConnected={() => { setConnecting(null); refresh(); }} />}
        </>
      )}
    </div>
  );
}

const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60 placeholder:text-cream-300/30";

function ConnectorModal({ authTypes, existing, template, onClose, onSaved }: {
  authTypes: ConnectorAuthCatalog[]; existing: Connector | null; template?: ConnectorTemplate | null; onClose: () => void; onSaved: () => void;
}) {
  const [label, setLabel] = useState(existing?.label ?? template?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? template?.baseUrl ?? "");
  const [description, setDescription] = useState(existing?.description ?? template?.description ?? "");
  const [authType, setAuthType] = useState<ConnectorAuthType>(existing?.auth.type ?? template?.auth?.type ?? "none");
  const [authIn, setAuthIn] = useState<"header" | "query">(existing?.auth.in ?? template?.auth?.in ?? "header");
  const [authName, setAuthName] = useState(existing?.auth.name ?? template?.auth?.name ?? "");
  const [username, setUsername] = useState(existing?.auth.username ?? "");
  const [secret, setSecret] = useState(""); // blank = keep existing on edit
  const [tenant, setTenant] = useState(existing?.auth.tenant ?? template?.auth?.tenant ?? "common");
  const [clientId, setClientId] = useState(existing?.auth.clientId ?? template?.auth?.clientId ?? "");
  const [scope, setScope] = useState(existing?.auth.scope ?? template?.auth?.scope ?? "");
  const [writeEnabled, setWriteEnabled] = useState(existing?.writeEnabled ?? template?.writeEnabled ?? false);
  const [skipApprovalForReads, setSkipApprovalForReads] = useState(existing?.skipApprovalForReads ?? template?.skipApprovalForReads ?? false);
  const [endpointsJson, setEndpointsJson] = useState(
    existing?.endpoints ? JSON.stringify(existing.endpoints, null, 2) : template?.endpoints ? JSON.stringify(template.endpoints, null, 2) : "");
  const [headersJson, setHeadersJson] = useState(existing?.headers ? JSON.stringify(existing.headers, null, 2) : "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const needsSecret = authType !== "none" && authType !== "oauth2";
  const secretLabel = authType === "bearer" ? "Token" : authType === "basic" ? "Password" : "Key / value";
  const showName = authType === "apiKey" || authType === "header";

  async function submit() {
    setErr(null);
    let endpoints: any; let headers: any;
    try { endpoints = endpointsJson.trim() ? JSON.parse(endpointsJson) : undefined; }
    catch { setErr("Endpoints must be valid JSON (an array of { name, method, path, description? })"); return; }
    try { headers = headersJson.trim() ? JSON.parse(headersJson) : undefined; }
    catch { setErr("Static headers must be valid JSON (an object of name → value)"); return; }

    const auth: ConnectorInput["auth"] = { type: authType };
    if (authType === "apiKey") { auth.in = authIn; auth.name = authName; if (secret) auth.value = secret; }
    else if (authType === "bearer") { if (secret) auth.token = secret; }
    else if (authType === "basic") { auth.username = username; if (secret) auth.password = secret; }
    else if (authType === "header") { auth.name = authName; if (secret) auth.value = secret; }
    else if (authType === "oauth2") { auth.tenant = tenant; auth.clientId = clientId; auth.scope = scope; }

    const body: ConnectorInput = { label, baseUrl, description: description || undefined, auth, headers, endpoints, writeEnabled, skipApprovalForReads };
    setSaving(true);
    try {
      if (existing) await api.updateConnector(existing.id, body);
      else await api.addConnector(body);
      showToast(existing ? "Connector updated" : "Connector added — click “Connect” to sign in", "success");
      onSaved();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-lg bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">{existing ? "Edit connector" : "Add connector"}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Label <span className="text-coral-400">*</span></label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Acme Orders API" className={FIELD} />
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Base URL <span className="text-coral-400">*</span></label>
            <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.acme.com" className={`${FIELD} font-mono`} autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Description</label>
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="What this system is — agents read this" className={FIELD} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-cream-300/70 mb-1">Auth</label>
              <select value={authType} onChange={e => setAuthType(e.target.value as ConnectorAuthType)} className={FIELD}>
                {(authTypes.length ? authTypes : [{ type: "none", label: "No auth" }] as any).map((a: any) => (
                  <option key={a.type} value={a.type}>{a.label}</option>
                ))}
              </select>
            </div>
            {authType === "apiKey" && (
              <div>
                <label className="block text-[11px] text-cream-300/70 mb-1">Send key in</label>
                <select value={authIn} onChange={e => setAuthIn(e.target.value as "header" | "query")} className={FIELD}>
                  <option value="header">Header</option>
                  <option value="query">Query param</option>
                </select>
              </div>
            )}
          </div>

          {showName && (
            <div>
              <label className="block text-[11px] text-cream-300/70 mb-1">{authType === "apiKey" ? "Param name" : "Header name"}</label>
              <input value={authName} onChange={e => setAuthName(e.target.value)} placeholder={authType === "apiKey" ? (authIn === "query" ? "api_key" : "X-API-Key") : "Authorization"} className={`${FIELD} font-mono`} />
            </div>
          )}
          {authType === "basic" && (
            <div>
              <label className="block text-[11px] text-cream-300/70 mb-1">Username</label>
              <input value={username} onChange={e => setUsername(e.target.value)} className={`${FIELD} font-mono`} autoComplete="off" />
            </div>
          )}
          {authType === "oauth2" && (
            <div className="space-y-3">
              <div className="text-[11px] text-cream-300/60 bg-ink-950/40 border border-ink-800 rounded-lg px-3 py-2">
                Requires a free Azure AD app registration (public client, no secret). Save this connector, then use
                “Connect” on its row to sign in via device code.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-cream-300/70 mb-1">Tenant</label>
                  <input value={tenant} onChange={e => setTenant(e.target.value)} placeholder="consumers" className={`${FIELD} font-mono`} spellCheck={false} />
                </div>
                <div>
                  <label className="block text-[11px] text-cream-300/70 mb-1">Application (client) ID <span className="text-coral-400">*</span></label>
                  <input value={clientId} onChange={e => setClientId(e.target.value)} className={`${FIELD} font-mono`} spellCheck={false} />
                </div>
              </div>
              <div>
                <label className="block text-[11px] text-cream-300/70 mb-1">Scopes</label>
                <input value={scope} onChange={e => setScope(e.target.value)} placeholder="Tasks.ReadWrite offline_access" className={`${FIELD} font-mono`} spellCheck={false} />
              </div>
            </div>
          )}
          {needsSecret && (
            <div>
              <label className="block text-[11px] text-cream-300/70 mb-1">{secretLabel}{!existing && <span className="text-coral-400"> *</span>}</label>
              <input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={existing?.auth.secretSet ? "•••••• (leave blank to keep)" : ""} className={`${FIELD} font-mono`} autoComplete="off" spellCheck={false} />
            </div>
          )}

          <details className="rounded-lg border border-ink-800 bg-ink-950/40">
            <summary className="text-[12px] text-cream-300/70 px-3 py-2 cursor-pointer select-none">Endpoint manifest &amp; static headers (optional)</summary>
            <div className="px-3 pb-3 space-y-3">
              <div>
                <label className="block text-[11px] text-cream-300/70 mb-1">Endpoints (JSON array)</label>
                <textarea value={endpointsJson} onChange={e => setEndpointsJson(e.target.value)} rows={6}
                  placeholder={'[\n  { "name": "list_orders", "method": "GET", "path": "/v1/orders", "description": "List recent orders", "query": ["status","limit"] }\n]'}
                  className={`${FIELD} font-mono text-[12px]`} spellCheck={false} />
                <div className="text-[10px] text-cream-300/40 mt-1">Agents read this manifest (connector.describe) to learn how to call the system.</div>
              </div>
              <div>
                <label className="block text-[11px] text-cream-300/70 mb-1">Static headers (JSON object)</label>
                <textarea value={headersJson} onChange={e => setHeadersJson(e.target.value)} rows={2}
                  placeholder={'{ "Accept": "application/json" }'} className={`${FIELD} font-mono text-[12px]`} spellCheck={false} />
              </div>
            </div>
          </details>

          <label className="flex items-center gap-2 text-[13px] text-cream-200 cursor-pointer">
            <input type="checkbox" checked={writeEnabled} onChange={e => setWriteEnabled(e.target.checked)} className="accent-coral-500" />
            Allow write methods (POST/PUT/PATCH/DELETE) — off keeps agents read-only on this system
          </label>
          <label className="flex items-start gap-2 text-[13px] text-cream-200 cursor-pointer">
            <input type="checkbox" checked={skipApprovalForReads} onChange={e => setSkipApprovalForReads(e.target.checked)} className="accent-coral-500 mt-0.5" />
            <span>
              Skip approval for reads (GET/HEAD) — agents can query this connector instantly without pausing for
              sign-off. Only enable for low-sensitivity data (e.g. your own task list); writes always stay gated.
            </span>
          </label>
        </div>

        {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
        <div className="flex justify-end pt-1">
          <Button onClick={submit} disabled={saving || !label || !baseUrl}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {existing ? "Save" : "Add connector"}</Button>
        </div>
      </div>
    </div>
  );
}

function TryModal({ connector, onClose }: { connector: Connector; onClose: () => void }) {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState(connector.endpoints?.[0]?.path ?? "/");
  const [bodyText, setBodyText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ConnectorCallResult | null>(null);

  async function run() {
    setRunning(true); setResult(null);
    let body: any;
    if (bodyText.trim() && method !== "GET" && method !== "HEAD") {
      try { body = JSON.parse(bodyText); } catch { body = bodyText; }
    }
    try {
      const { result } = await api.callConnector(connector.id, { method, path, body });
      setResult(result);
    } catch (e: any) {
      setResult({ ok: false, status: 0, url: "", method, body: null, error: e?.message ?? String(e) });
    } finally { setRunning(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-lg bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-3 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">Try — {connector.label}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>
        <div className="flex gap-2">
          <select value={method} onChange={e => setMethod(e.target.value)} className={`${FIELD} !w-28`}>
            {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <input value={path} onChange={e => setPath(e.target.value)} placeholder="/v1/orders" className={`${FIELD} font-mono`} spellCheck={false} />
        </div>
        {connector.endpoints && connector.endpoints.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {connector.endpoints.map(ep => (
              <button key={ep.name} type="button" onClick={() => { setMethod(ep.method); setPath(ep.path); }}
                className="text-[10px] px-2 py-1 rounded-full bg-ink-800 text-cream-300/70 hover:text-cream-100 font-mono">
                {ep.method} {ep.name}
              </button>
            ))}
          </div>
        )}
        {method !== "GET" && method !== "HEAD" && (
          <textarea value={bodyText} onChange={e => setBodyText(e.target.value)} rows={3} placeholder='{ "key": "value" }' className={`${FIELD} font-mono text-[12px]`} spellCheck={false} />
        )}
        <div className="flex justify-end">
          <Button onClick={run} disabled={running}>{running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Send</Button>
        </div>
        {result && (
          <div className="rounded-lg border border-ink-800 bg-ink-950/60 p-3 space-y-1">
            <div className={`text-[12px] ${result.ok ? "text-leaf-400" : "text-coral-400"}`}>
              {result.error ? `Error: ${result.error}` : `HTTP ${result.status}`}{result.truncated ? " · truncated" : ""}
            </div>
            <pre className="text-[11px] text-cream-200/90 font-mono whitespace-pre-wrap break-words max-h-72 overflow-auto">
              {typeof result.body === "string" ? result.body : JSON.stringify(result.body, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// OAuth2 device-code sign-in. Kicks off the flow, shows the user code +
// verification link, then polls until the server reports the tokens landed
// (or the flow errors/expires). The device code itself never reaches the
// browser — only the short user-facing code and the Microsoft URL do.
function ConnectModal({ connector, onClose, onConnected }: { connector: Connector; onClose: () => void; onConnected: () => void }) {
  const [state, setState] = useState<"starting" | "pending" | "error" | "expired">("starting");
  const [info, setInfo] = useState<{ userCode: string; verificationUri: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    (async () => {
      try {
        const flow = await api.startConnectorOAuth(connector.id);
        if (stopped.current) return;
        setInfo({ userCode: flow.userCode, verificationUri: flow.verificationUri, message: flow.message });
        setState("pending");
        const intervalMs = Math.max(2, flow.interval) * 1000;
        const poll = async () => {
          if (stopped.current) return;
          try {
            const r = await api.pollConnectorOAuth(connector.id, flow.flowId);
            if (stopped.current) return;
            if (r.status === "complete") { showToast(`Connected “${connector.label}”`, "success"); onConnected(); return; }
            if (r.status === "pending") { pollTimer.current = setTimeout(poll, intervalMs); return; }
            setState(r.status === "expired" ? "expired" : "error");
            setError(r.error ?? null);
          } catch (e: any) {
            if (stopped.current) return;
            setState("error"); setError(e?.message ?? String(e));
          }
        };
        pollTimer.current = setTimeout(poll, intervalMs);
      } catch (e: any) {
        if (stopped.current) return;
        setState("error"); setError(e?.message ?? String(e));
      }
    })();
    return () => { stopped.current = true; if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [connector.id]);

  return (
    <Modal open onClose={onClose} title={`Connect — ${connector.label}`} size="sm">
      {state === "starting" && (
        <div className="flex items-center gap-2 text-sm text-cream-300/70"><Loader2 size={14} className="animate-spin" /> Requesting a sign-in code…</div>
      )}

      {state === "pending" && info && (
        <div className="space-y-3 text-center">
          <div className="text-[12px] text-cream-300/70">Go to</div>
          <a href={info.verificationUri} target="_blank" rel="noreferrer" className="text-sm text-violet-300 underline break-all">{info.verificationUri}</a>
          <div className="text-[12px] text-cream-300/70">and enter this code:</div>
          <div className="text-2xl font-mono tracking-widest text-cream-50 bg-ink-950/60 border border-ink-800 rounded-lg py-2">{info.userCode}</div>
          <div className="flex items-center justify-center gap-2 text-[12px] text-cream-300/60"><Loader2 size={12} className="animate-spin" /> Waiting for sign-in…</div>
        </div>
      )}

      {(state === "error" || state === "expired") && (
        <div className="text-[12px] text-coral-400 flex items-center gap-1.5">
          <AlertTriangle size={13} /> {state === "expired" ? "Code expired — try again." : (error ?? "Sign-in failed.")}
        </div>
      )}
    </Modal>
  );
}
