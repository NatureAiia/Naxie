// Non-throwing fetch wrapper — an opt-in alternative to lib/api.ts's req<T>()
// (which throws ApiError on any failure). Modeled on KimmyDeku/sebastian's
// client-side api() helper: checks navigator.onLine first, and normalizes
// every failure mode (offline, network, non-JSON response, server-reported
// error) into the same { ok: false, code, error } shape the server's
// lib/respond.ts already returns on success/empty/error — so a caller that
// prefers "branch on the result" over "catch the throw" gets one consistent
// shape either way.
//
// req<T>() is not being replaced — this is additive for call sites that want
// it, starting with the calendar-export and weather status callers.

import { getToken } from "./api";

export type ApiResult<T> = { ok: true; code?: undefined } & T | { ok: false; code: string; error: string };

export async function apiResult<T = object>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, code: "offline", error: "You're offline — this needs a network connection." };
  }
  const token = getToken();
  let r: Response;
  try {
    r = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) },
    });
  } catch (e: any) {
    return { ok: false, code: "network", error: `Cannot reach the server at ${path}.` };
  }
  let body: any;
  try {
    body = await r.json();
  } catch {
    return { ok: false, code: "network", error: `Unreadable response (${r.status}) from ${path}.` };
  }
  if (!r.ok && body?.ok === undefined) {
    // A route that hasn't adopted lib/respond.ts yet (bare { error } shape) —
    // still normalize rather than pass through an inconsistent object.
    return { ok: false, code: "error", error: body?.error ?? `${r.status} ${r.statusText}` };
  }
  return body as ApiResult<T>;
}
