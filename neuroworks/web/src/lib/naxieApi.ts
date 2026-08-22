// Client for the separate naxionai/backend (FastAPI/Python) service — proxied
// under /naxie-api by vite.config.ts. This is NOT neuroworks/server: it's a
// different product surface (Naxie's personal-assistant connectors) running
// as its own process, with its own single-user local auth. No token is sent
// here — naxionai's default single-user mode ignores it, and neuroworks'
// session token wouldn't mean anything to a different backend anyway.

const BASE = "/naxie-api";

async function naxieReq<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const body = await r.json(); msg = body.detail ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export type NaxieConnection = {
  id: string;
  account_name?: string | null;
  connection_status: string;
  scopes?: string | null;
};

export const naxieApi = {
  // Google
  googleAuthorize: () => naxieReq<{ authorize_url: string }>("/connectors/google/authorize"),
  googleList: () => naxieReq<NaxieConnection[]>("/connectors/google/"),
  googleDisconnect: (id: string) => naxieReq<{ status: string }>(`/connectors/google/${id}`, { method: "DELETE" }),

  // Microsoft
  microsoftAuthorize: () => naxieReq<{ authorize_url: string }>("/connectors/microsoft/authorize"),
  microsoftList: () => naxieReq<NaxieConnection[]>("/connectors/microsoft/"),
  microsoftDisconnect: (id: string) => naxieReq<{ status: string }>(`/connectors/microsoft/${id}`, { method: "DELETE" }),

  // Local documents
  localFolderStatus: () => naxieReq<{ configured: boolean; root_label: string | null }>("/training/local-folder/status"),
  localFolderBrowse: (subPath: string) =>
    naxieReq<{ sub_path: string; entries: { name: string; is_dir: boolean; size: number | null; supported: boolean }[] }>(
      `/training/local-folder/browse?sub_path=${encodeURIComponent(subPath)}`,
    ),
  localFolderIngest: (body: { sub_path: string; recursive: boolean; category?: string; tags?: string[]; max_files?: number }) =>
    naxieReq<{ queued: number; skipped_unsupported: number; skipped_over_cap: number; root: string }>(
      "/training/local-folder/ingest",
      { method: "POST", body: JSON.stringify(body) },
    ),
};
