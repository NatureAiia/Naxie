// Company data that lives at a URL — ported from AI-Institute-Africa/neuroworks
// (upstream), trimmed to the core: register/list/remove/find. Upstream's
// socialLinks()/targets.ts integration is skipped — Naxie has no targets.ts
// analog to wire it into.
//
// Company knowledge was reachable three ways — the vault, uploaded documents,
// and database connections (data-sources.ts) — and a lot of it is none of
// those. A pricing page, a public register, a partner's API: the operator
// knows the link, but an agent only gets there if someone pastes it into the
// task, every time. This makes a link a NAMED company source instead.
//
// SECURITY — a registered link is a standing instruction to fetch a URL, so
// the register is the trust boundary: https only, never a private/loopback
// address (SSRF). Registering is an operator action; fetching (via
// web.fetch/smartFetch) is what agents may do. Fetched text is DATA, never
// instructions.

import { readJsonStore, statePath, tryWriteJsonStore } from "./json-store.js";
import { randomUUID } from "node:crypto";

const STORE_PATH = () => statePath("company-links.json");

export type CompanyLink = {
  id: string;
  label: string;
  url: string;
  description?: string;
  department?: string;
  createdAt: string;
  lastFetchedAt?: string;
  lastStatus?: number;
  lastError?: string;
};

export type LinkValidation = { ok: true; url: string } | { ok: false; error: string };

/** Is this URL safe to register as a standing fetch target? https-only, no private/loopback host. */
export function validateLinkUrl(raw: unknown): LinkValidation {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, error: "url is required" };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, error: `"${s}" is not a valid URL` }; }
  if (u.protocol !== "https:") {
    return { ok: false, error: `only https links can be registered (got ${u.protocol.replace(":", "") || "no scheme"})` };
  }
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
    host === "::1" || host === "[::1]" || host.endsWith(".internal") || host.endsWith(".local")
  ) {
    return { ok: false, error: `"${host}" is a private or local address — a company link must point at a public https URL` };
  }
  return { ok: true, url: u.toString() };
}

let storeUnreadable: string | null = null;

/** Why the company-links store is unreadable, or null. For /api/status. */
export function companyLinkStoreProblem(): string | null {
  return storeUnreadable;
}

function load(): CompanyLink[] {
  const read = readJsonStore<CompanyLink[]>(STORE_PATH(), () => [], {
    label: "company-links",
    validate: v => Array.isArray(v),
  });
  if (read.error) storeUnreadable = read.error;
  return Array.isArray(read.value) ? read.value : [];
}

function save(list: CompanyLink[]): void {
  if (storeUnreadable) {
    console.warn(`[company-links] persist REFUSED — store is unreadable (${storeUnreadable}). Resolve the quarantined file and restart.`);
    return;
  }
  tryWriteJsonStore(STORE_PATH(), list, { label: "company-links" });
}

export function listCompanyLinks(): CompanyLink[] {
  return load();
}

export function addCompanyLink(input: { label: string; url: string; description?: string; department?: string }): CompanyLink {
  const label = String(input.label ?? "").trim();
  if (!label) throw new Error("label is required");
  const v = validateLinkUrl(input.url);
  if (!v.ok) throw new Error(v.error);
  const list = load();
  // Same label twice would make "check the pricing page" ambiguous.
  if (list.some(l => l.label.toLowerCase() === label.toLowerCase())) {
    throw new Error(`a company link labelled "${label}" already exists`);
  }
  const fresh: CompanyLink = {
    id: `link-${randomUUID().slice(0, 8)}`,
    label,
    url: v.url,
    ...(input.description ? { description: String(input.description).slice(0, 500) } : {}),
    ...(input.department ? { department: String(input.department).slice(0, 80) } : {}),
    createdAt: new Date().toISOString(),
  };
  list.push(fresh);
  save(list);
  return fresh;
}

export function removeCompanyLink(id: string): boolean {
  const list = load();
  const next = list.filter(l => l.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

/** Note the outcome of a fetch so a rotting link is visible before it misleads. */
export function recordLinkFetch(id: string, outcome: { status?: number; error?: string }): void {
  const list = load();
  const hit = list.find(l => l.id === id);
  if (!hit) return;
  hit.lastFetchedAt = new Date().toISOString();
  hit.lastStatus = outcome.status;
  hit.lastError = outcome.error ? String(outcome.error).slice(0, 300) : undefined;
  save(list);
}

/**
 * Find a link by what the operator would say. Exact label first, then a
 * contains match, then all-tokens. Returns null on an ambiguous tie.
 */
export function findCompanyLink(query: string): CompanyLink | null {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return null;
  const list = load();
  const exact = list.filter(l => l.label.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const byId = list.find(l => l.id.toLowerCase() === q);
  if (byId) return byId;

  const contains = list.filter(l => l.label.toLowerCase().includes(q) || q.includes(l.label.toLowerCase()));
  if (contains.length === 1) return contains[0];

  const tokens = q.split(/\s+/).filter(t => t.length > 2);
  if (tokens.length) {
    const tokenHits = list.filter(l => {
      const hay = `${l.label} ${l.description ?? ""}`.toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
    if (tokenHits.length === 1) return tokenHits[0];
  }
  return null;
}
