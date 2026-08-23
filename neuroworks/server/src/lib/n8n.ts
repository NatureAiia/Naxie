// n8n integration — self-hosted workflow automation for NeuroWorks.
//
// Exposes a typed client over n8n's REST API (https://docs.n8n.io/api/) plus
// a webhook trigger helper. Config is env-gated (N8N_BASE_URL + N8N_API_KEY)
// — when absent every helper throws a clear "not configured" error instead of
// silently failing, so agents and the UI can surface the setup hint.
//
// Auth: n8n's public API authenticates with the header `X-N8N-API-KEY`.
// Webhooks are unauthenticated by default (trigger URL contains a secret path)
// — triggerWebhook() never sends the API key.
//
// Persistence: stateless — no local file, just env + fetch.

import { config } from "../config.js";

function n8nHeaders(): Record<string, string> {
  const key = (process.env.N8N_API_KEY ?? config.n8nApiKey ?? "").trim();
  return { "X-N8N-API-KEY": key, accept: "application/json", "content-type": "application/json" };
}

export function isN8nEnabled(): boolean {
  const base = (process.env.N8N_BASE_URL ?? config.n8nBaseUrl ?? "").trim();
  const key = (process.env.N8N_API_KEY ?? config.n8nApiKey ?? "").trim();
  return !!base && !!key;
}

function requireN8n(): { base: string; key: string } {
  const base = (process.env.N8N_BASE_URL ?? config.n8nBaseUrl ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.N8N_API_KEY ?? config.n8nApiKey ?? "").trim();
  if (!base || !key) throw new Error("n8n not configured — set N8N_BASE_URL (e.g. http://127.0.0.1:5678) and N8N_API_KEY (n8n → Settings → API → Create API Key) in .env, then restart the server.");
  return { base, key };
}

async function n8nFetch(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; json: any; text: string; headers: Headers }> {
  const { base } = requireN8n();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(url, { ...init, headers: { ...n8nHeaders(), ...(init.headers ?? {}) }, signal: ctrl.signal });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body (webhook HTML) */ }
    return { ok: r.ok, status: r.status, json, text, headers: r.headers };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Health ───

export async function n8nHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    requireN8n();
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
  try {
    const r = await n8nFetch("/api/v1/workflows?limit=1");
    if (r.ok) return { ok: true, detail: `n8n reachable — ${r.json?.data?.length ?? 0} workflow(s) visible` };
    return { ok: false, detail: r.json?.message ?? `HTTP ${r.status}` };
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "n8n request timed out after 20s" : String(e?.message ?? e);
    return { ok: false, detail: msg };
  }
}

// ─── Workflows ───

export type N8nWorkflowSummary = {
  id: string; name: string; active: boolean; createdAt?: string; updatedAt?: string; tags?: any[]; nodes?: any[];
};

export async function listWorkflows(opts: { limit?: number; active?: boolean; tags?: string } = {}): Promise<{ workflows: N8nWorkflowSummary[]; count: number }> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(Math.min(100, Math.max(1, opts.limit))));
  if (opts.active !== undefined) params.set("active", String(opts.active));
  if (opts.tags) params.set("tags", opts.tags);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const r = await n8nFetch(`/api/v1/workflows${qs}`);
  if (!r.ok) throw new Error(r.json?.message ?? `n8n list workflows failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  const data = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
  return { workflows: data, count: data.length };
}

export async function getWorkflow(id: string): Promise<any> {
  if (!id?.trim()) throw new Error("workflow id is required");
  const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(id.trim())}`);
  if (!r.ok) throw new Error(r.json?.message ?? `n8n get workflow failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  return r.json;
}

export async function createWorkflow(payload: { name: string; nodes: any[]; connections: any; settings?: any; staticData?: any }): Promise<any> {
  if (!payload?.name) throw new Error("workflow name is required");
  const r = await n8nFetch("/api/v1/workflows", { method: "POST", body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(r.json?.message ?? `n8n create workflow failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  return r.json;
}

export async function updateWorkflow(id: string, patch: any): Promise<any> {
  if (!id?.trim()) throw new Error("workflow id is required");
  const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(id.trim())}`, { method: "PUT", body: JSON.stringify(patch) });
  if (!r.ok) throw new Error(r.json?.message ?? `n8n update workflow failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  return r.json;
}

export async function deleteWorkflow(id: string): Promise<{ ok: true }> {
  if (!id?.trim()) throw new Error("workflow id is required");
  const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(id.trim())}`, { method: "DELETE" });
  if (!r.ok) throw new Error(r.json?.message ?? `n8n delete workflow failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  return { ok: true };
}

export async function activateWorkflow(id: string, active: boolean): Promise<any> {
  const r = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(id.trim())}/${active ? "activate" : "deactivate"}`, { method: "POST" });
  if (!r.ok) throw new Error(r.json?.message ?? `n8n ${active ? "activate" : "deactivate"} failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  return r.json;
}

// ─── Executions ───

export async function listExecutions(opts: { limit?: number; workflowId?: string; status?: string } = {}): Promise<any> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(Math.min(100, Math.max(1, opts.limit))));
  if (opts.workflowId) params.set("workflowId", opts.workflowId);
  if (opts.status) params.set("status", opts.status);
  const qs = params.toString() ? `?${params.toString()}` : "";
  const r = await n8nFetch(`/api/v1/executions${qs}`);
  if (!r.ok) throw new Error(r.json?.message ?? `n8n list executions failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  return r.json;
}

export async function getExecution(id: string): Promise<any> {
  if (!id?.trim()) throw new Error("execution id is required");
  const r = await n8nFetch(`/api/v1/executions/${encodeURIComponent(id.trim())}`);
  if (!r.ok) throw new Error(r.json?.message ?? `n8n get execution failed (HTTP ${r.status}): ${r.text.slice(0, 300)}`);
  return r.json;
}

// ─── Webhook trigger ───
// n8n webhooks live at <base>/webhook/<path> (or /webhook-test/<path> for
// test mode). The path is the value configured in the Webhook node's "Path".
// We support two invocation styles:
//   1. Full URL (https://.../webhook/my-hook) — used as-is.
//   2. Path only (my-hook or /webhook/my-hook) — resolved against N8N_WEBHOOK_BASE_URL.
// Query params and body are forwarded verbatim.

export type TriggerWebhookOpts = {
  url?: string;          // full webhook URL — preferred when known
  path?: string;         // path-only invocation (e.g. "my-hook" or "webhook/my-hook")
  method?: string;       // GET | POST | PUT | PATCH | DELETE — default POST
  body?: unknown;        // JSON body forwarded to the webhook
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  waitForResponse?: boolean; // when false, return immediately without waiting for workflow completion
};

export type TriggerWebhookResult = {
  ok: boolean; status: number; url: string; method: string;
  body: unknown; contentType?: string; truncated?: boolean;
  headers?: Record<string, string>;
};

function resolveWebhookUrl(opts: TriggerWebhookOpts): string {
  if (opts.url?.trim()) return opts.url.trim();
  if (opts.path?.trim()) {
    const base = (process.env.N8N_WEBHOOK_BASE_URL ?? process.env.N8N_BASE_URL ?? config.n8nWebhookBaseUrl ?? config.n8nBaseUrl ?? "").trim().replace(/\/+$/, "");
    if (!base) throw new Error("n8n webhook trigger: provide a full `url`, or set N8N_BASE_URL / N8N_WEBHOOK_BASE_URL so a `path` can be resolved.");
    let p = opts.path.trim().replace(/^\/+/, "");
    // If caller passes "webhook/xxx" keep it; if bare "xxx" prefix with webhook/
    if (!p.startsWith("webhook/") && !p.startsWith("webhook-test/")) p = `webhook/${p}`;
    return `${base}/${p}`;
  }
  throw new Error("n8n webhook trigger: provide `url` (full webhook URL) or `path` (webhook path).");
}

export async function triggerWebhook(opts: TriggerWebhookOpts): Promise<TriggerWebhookResult> {
  const urlStr = resolveWebhookUrl(opts);
  let url: URL;
  try { url = new URL(urlStr); } catch { throw new Error(`n8n webhook URL is not valid: ${urlStr}`); }
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, String(v));
  const method = (opts.method ?? "POST").toUpperCase();
  const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
  let payload: string | undefined;
  if (!["GET", "HEAD"].includes(method) && opts.body !== undefined && opts.body !== null) {
    payload = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    headers["content-type"] = headers["content-type"] ?? (typeof opts.body === "string" ? "text/plain" : "application/json");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(url.toString(), { method, headers, body: payload, signal: ctrl.signal });
    const contentType = r.headers.get("content-type") ?? undefined;
    const raw = await r.text();
    const truncated = raw.length > 20000;
    const slice = truncated ? raw.slice(0, 20000) : raw;
    let body: unknown = slice;
    if (contentType?.includes("application/json")) { try { body = JSON.parse(slice); } catch { /* keep text */ } }
    const respHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => { respHeaders[k] = v; });
    return { ok: r.ok, status: r.status, url: url.toString(), method, body, contentType, truncated: truncated || undefined, headers: respHeaders };
  } catch (e: any) {
    const cause = e?.cause ? String((e.cause as any)?.message ?? e.cause) : undefined;
    const msg = e?.name === "AbortError" ? `webhook request to ${url.host} timed out after 30s` : (cause ?? e?.message ?? String(e));
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Convenience: trigger by workflow name (resolves webhook path from node's config) ───
// n8n doesn't expose "give me the webhook URL for workflow X" directly, so this
// helper fetches the workflow, finds its Webhook node(s), and builds the URL.
export async function triggerWorkflowByName(name: string, body?: unknown): Promise<TriggerWebhookResult> {
  if (!name?.trim()) throw new Error("workflow name is required");
  const { workflows } = await listWorkflows({ limit: 100 });
  const wf = workflows.find(w => w.name.toLowerCase() === name.trim().toLowerCase());
  if (!wf) throw new Error(`n8n workflow "${name}" not found — use GET /api/n8n/workflows to list available workflows`);
  const full = await getWorkflow(wf.id);
  const webhookNode = (full.nodes ?? []).find((n: any) => n.type === "n8n-nodes-base.webhook" || n.type?.includes("webhook"));
  if (!webhookNode) throw new Error(`workflow "${name}" has no Webhook trigger node — add a Webhook node in n8n first, or trigger via a direct webhook URL`);
  const path = webhookNode.parameters?.path ?? webhookNode.webhookId ?? wf.id;
  return triggerWebhook({ path: String(path), body: body ?? {}, method: "POST" });
}
