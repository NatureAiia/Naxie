// Connectivity probe — real reachability, not just "key is set".
// The old check (config.openrouterEnabled = apiKey.length>0) says "configured",
// not "reachable". This module pings the active cloud endpoint with a short
// timeout and caches the result for 45s so every Naxie turn doesn't pay a probe.

import { config } from "../config.js";

let cache: { at: number; online: boolean } | null = null;
const TTL_MS = 45_000;
const PROBE_TIMEOUT_MS = 1800;

async function probeUrl(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    // HEAD is cheapest; some providers only allow GET on /models so we try HEAD
    // then fall back to GET. We only need a TCP+TLS+HTTP success, not auth.
    let res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    if (!res.ok && res.status !== 405) {
      // retry as GET for endpoints that reject HEAD
      res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${config.openrouterApiKey}` }, signal: ctrl.signal });
    }
    // Any HTTP response (even 401/429) proves the host is reachable.
    // Only network errors / timeouts mean offline.
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function isCloudReachable(): Promise<boolean> {
  if (!config.openrouterEnabled) return false;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.online;
  // Probe the configured base URL's /models endpoint if it looks like
  // OpenRouter/OpenAI-compatible; otherwise probe a reliable captive-portal
  // check URL plus the base host.
  const base = config.openrouterBaseUrl.replace(/\/+$/, "");
  const probeTarget = base.includes("/v1") ? `${base}/models` : `${base}/models`;
  // Probe in parallel with a public check to distinguish "internet down" vs
  // "provider down". Either success means we shouldn't force offline.
  const [providerOk, internetOk] = await Promise.all([
    probeUrl(probeTarget),
    probeUrl("https://www.google.com/generate_204"),
  ]);
  const online = providerOk || internetOk;
  cache = { at: Date.now(), online };
  // If provider unreachable but internet ok, still consider online so the
  // caller can try the provider and failover via llm.ts's transient fallback
  // (which walks the fallback pool before local). Forcing hard offline would
  // skip that pool unnecessarily.
  return online;
}

export function isCloudReachableCached(): boolean | null {
  if (!cache || Date.now() - cache.at >= TTL_MS) return null;
  return cache.online;
}

export function clearConnectivityCache(): void {
  cache = null;
}
