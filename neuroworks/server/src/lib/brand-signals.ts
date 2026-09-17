import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { getBrand, type Brand } from "./brands.js";
import { acquire, type OmniRecord } from "./omnisignal.js";
import { findPrimitive } from "./primitives.js";

// Brand-signal monitoring — own-brand mentions and content-opportunity
// signals, per brand. Shaped after MAIA (a separate app, not imported here):
// ingest -> 3 gates -> a provenance-labelled DRAFT signal -> a human-only
// validate/reject decision -> an export path that can only ever read
// validated rows -> two dumb, explainable alert rules -> refused candidates
// kept with a reason, never silently discarded.
//
// Explicitly NOT built here: competitor watching, an 8-agent research
// engine, prose-report generation, or any MAIA code. Acquisition reuses
// omnisignal.ts as-is; this file is the only new "engine" — the store + the
// 3 gates + the 2 alert rules.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const STORE = resolve(CONFIG_DIR, "brand-signals.json");

export type BrandSignal = {
  id: string;
  dedupeKey: string;
  brandId: string;
  kind: "mention" | "opportunity";
  text: string;
  sourceUrl?: string;
  sourceType: "web_search" | "web_page" | "vault" | "email" | "telegram";
  provenance: number; // 0.6 = brand's own domain/handle ("primary"), 0.4 = third-party — how directly sourced, NEVER a truth/confidence score
  seenCount: number;
  status: "draft" | "validated" | "rejected";
  refusedReason?: string;
  createdAt: string;
  validatedAt?: string;
};

export type BrandSignalRun = {
  id: string;
  brandId: string;
  startedAt: string;
  finishedAt?: string;
  candidateCount: number;
  signalCount: number;
  refusedCount: number;
  error?: string;
};

type Store = { signals: BrandSignal[]; runs: BrandSignalRun[] };

function load(): Store {
  try { if (existsSync(STORE)) return JSON.parse(readFileSync(STORE, "utf8")) as Store; }
  catch { /* corrupt → empty */ }
  return { signals: [], runs: [] };
}
function save(s: Store): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STORE, JSON.stringify(s, null, 2), { encoding: "utf8", mode: 0o600 });
}

function makeDedupeKey(brandId: string, urlOrText: string): string {
  return createHash("sha256").update(`${brandId}::${urlOrText.trim().toLowerCase()}`).digest("hex").slice(0, 24);
}

export function listSignals(filter?: { brandId?: string; status?: BrandSignal["status"] }): BrandSignal[] {
  let list = load().signals;
  if (filter?.brandId) list = list.filter(s => s.brandId === filter.brandId);
  if (filter?.status) list = list.filter(s => s.status === filter.status);
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getSignal(id: string): BrandSignal | undefined {
  return load().signals.find(s => s.id === id);
}

// The "normalise" step — dedupe lookup + seenCount bump, or a new draft row.
// Returns null if a row with this dedupeKey already exists AND is already
// validated/rejected (a human already decided; a repeat sighting shouldn't
// resurrect it as a fresh draft).
export function upsertSignal(input: {
  brandId: string; kind: BrandSignal["kind"]; text: string; sourceUrl?: string;
  sourceType: BrandSignal["sourceType"]; provenance: number;
}): BrandSignal | null {
  const store = load();
  const dedupeKey = makeDedupeKey(input.brandId, input.sourceUrl || input.text);
  const existing = store.signals.find(s => s.dedupeKey === dedupeKey);
  if (existing) {
    existing.seenCount += 1;
    save(store);
    return existing.status === "draft" ? existing : null;
  }
  const signal: BrandSignal = {
    id: randomUUID(),
    dedupeKey,
    brandId: input.brandId,
    kind: input.kind,
    text: input.text,
    sourceUrl: input.sourceUrl,
    sourceType: input.sourceType,
    provenance: input.provenance,
    seenCount: 1,
    status: "draft",
    createdAt: new Date().toISOString(),
  };
  store.signals.push(signal);
  save(store);
  return signal;
}

// A refused candidate — kept for audit (never silently discarded), but never
// becomes a real signal a human is asked to review.
function recordRefusal(brandId: string, text: string, sourceUrl: string | undefined, sourceType: BrandSignal["sourceType"], reason: string): void {
  const store = load();
  const dedupeKey = makeDedupeKey(brandId, sourceUrl || text);
  if (store.signals.some(s => s.dedupeKey === dedupeKey)) return; // already recorded once
  store.signals.push({
    id: randomUUID(), dedupeKey, brandId, kind: "mention", text: text.slice(0, 500), sourceUrl,
    sourceType, provenance: 0, seenCount: 1, status: "rejected", refusedReason: reason, createdAt: new Date().toISOString(),
  });
  save(store);
}

// The only way out of "draft" — a human decision. No auto-validate path.
export function validateSignal(id: string, decision: "validated" | "rejected"): BrandSignal | null {
  const store = load();
  const s = store.signals.find(x => x.id === id);
  if (!s) return null;
  s.status = decision;
  s.validatedAt = new Date().toISOString();
  save(store);
  return s;
}

// The export gate lives in the query itself — no override parameter can widen it.
export function exportValidatedSignals(brandId?: string): BrandSignal[] {
  return listSignals({ brandId, status: "validated" });
}

export function listRuns(brandId?: string): BrandSignalRun[] {
  const runs = load().runs;
  return (brandId ? runs.filter(r => r.brandId === brandId) : runs).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function recordRun(run: BrandSignalRun): void {
  const store = load();
  store.runs.push(run);
  // Keep the last 200 runs per brand's worth of history bounded overall — this
  // is operational log, not the audit trail (signals themselves are the audit
  // trail and are never pruned).
  if (store.runs.length > 500) store.runs.splice(0, store.runs.length - 500);
  save(store);
}

// Generic, non-per-brand reputation-risk terms for the "critical" alert rule.
// Deliberately simple/fixed — a scored alert nobody can explain is how alert
// fatigue starts. Override candidate for a future per-brand list; v1 ships one
// shared list, same "dumb, explainable" posture as the rest of this pipeline.
const RISK_TERMS = ["lawsuit", "scam", "fraud", "boycott", "recall", "data breach", "hacked", "scandal", "sued", "class action"];

function isReputationRisk(text: string): boolean {
  const lower = text.toLowerCase();
  return RISK_TERMS.some(t => lower.includes(t));
}

async function sendAlert(brand: Brand, text: string): Promise<void> {
  try {
    const tg = findPrimitive("telegram.send");
    if (tg) await tg.handler({ text });
  } catch { /* non-fatal — alerting must never break the scan */ }
  const alertEmail = process.env.NEUROWORKS_BRAND_ALERT_EMAIL?.trim();
  if (alertEmail) {
    try {
      const em = findPrimitive("email.send");
      if (em) await em.handler({ to: alertEmail, subject: `Brand signal alert — ${brand.name}`, body: text });
    } catch { /* non-fatal */ }
  }
}

// The 3 gates a candidate must pass to become a signal:
//   1. on this brand's watch list?  2. has a real http source?  3. has a finding?
// A candidate that fails gate 1 is simply not a candidate (not logged — avoids
// pure-noise buildup). One that passes gate 1 but fails 2/3 is persisted
// rejected, with a reason, for audit.
function gateCandidate(brand: Brand, record: OmniRecord): { pass: true; text: string; url?: string } | { pass: false; onWatchList: boolean; reason: string; text: string; url?: string } {
  const text = String(record.text ?? record.snippet ?? record.preview ?? "").trim();
  const title = String(record.title ?? "").trim();
  const combined = `${title} ${text}`.trim();
  const url = typeof record.url === "string" ? record.url : undefined;

  const terms = (brand.watchTerms ?? []).map(t => t.toLowerCase()).filter(Boolean);
  const onWatchList = terms.length === 0 ? false : terms.some(t => combined.toLowerCase().includes(t));
  if (!onWatchList) return { pass: false, onWatchList: false, reason: "not on watch list", text: combined, url };

  if (!url || !/^https?:\/\//i.test(url)) return { pass: false, onWatchList: true, reason: "no real http source", text: combined, url };
  if (!combined || combined.length < 20) return { pass: false, onWatchList: true, reason: "no substantive finding", text: combined, url };

  return { pass: true, text: combined, url };
}

// Primary/third-party provenance — "how directly sourced," never a truth
// score. A hit on the brand's own domain/handle (best-effort: the brand's
// slug appears in the URL host) counts as primary; everything else third-party.
function provenanceFor(brand: Brand, url: string): number {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const brandTokens = [brand.id, ...brand.name.toLowerCase().split(/\s+/)].filter(t => t.length > 2);
    return brandTokens.some(t => host.includes(t)) ? 0.6 : 0.4;
  } catch { return 0.4; }
}

// One scan for one brand: acquire (via omnisignal, watch-term web searches) ->
// gate -> upsert signals -> alert on anything critical -> record the run.
// Refuses to run with an empty watch list (mirrors MAIA's same refusal).
export async function runBrandSignalScan(brandId: string): Promise<BrandSignalRun> {
  const brand = getBrand(brandId);
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  if (!brand) {
    const run: BrandSignalRun = { id: runId, brandId, startedAt, finishedAt: new Date().toISOString(), candidateCount: 0, signalCount: 0, refusedCount: 0, error: "brand not found" };
    recordRun(run);
    return run;
  }
  const terms = (brand.watchTerms ?? []).filter(Boolean);
  if (terms.length === 0) {
    const run: BrandSignalRun = { id: runId, brandId, startedAt, finishedAt: new Date().toISOString(), candidateCount: 0, signalCount: 0, refusedCount: 0, error: "watch list is empty — add watchTerms to this brand before scanning" };
    recordRun(run);
    return run;
  }

  const acquisition = await acquire(terms.map(term => ({ kind: "web_search" as const, query: term, limit: 8 })));

  let signalCount = 0;
  let refusedCount = 0;
  const newDraftKinds = new Set<string>();
  for (const record of acquisition.records) {
    const gate = gateCandidate(brand, record);
    if (!gate.pass) {
      if (gate.onWatchList) { recordRefusal(brand.id, gate.text, gate.url, "web_search", gate.reason); refusedCount++; }
      continue;
    }
    const kind: BrandSignal["kind"] = "mention";
    const provenance = provenanceFor(brand, gate.url!);
    const signal = upsertSignal({ brandId: brand.id, kind, text: gate.text.slice(0, 1000), sourceUrl: gate.url, sourceType: "web_search", provenance });
    if (!signal) continue; // dedupe hit on an already-decided row
    if (signal.seenCount === 1) {
      signalCount++;
      // Alert rule 1 — critical: reputation-risk terms, immediate.
      if (isReputationRisk(signal.text)) {
        await sendAlert(brand, `🚨 Critical brand signal for ${brand.name}\n\n${signal.text.slice(0, 300)}\n\nSource: ${signal.sourceUrl}\n\nValidate/reject: POST /api/brand-signals/${signal.id}/validate`);
      }
      // Alert rule 2 — notable: first-ever signal of this kind for this brand.
      const seenBefore = listSignals({ brandId: brand.id }).some(s => s.id !== signal.id && s.kind === signal.kind);
      if (!seenBefore && !newDraftKinds.has(signal.kind)) {
        newDraftKinds.add(signal.kind);
        await sendAlert(brand, `ℹ️ First-ever "${signal.kind}" signal for ${brand.name}\n\n${signal.text.slice(0, 300)}\n\nSource: ${signal.sourceUrl}`);
      }
    }
  }

  const run: BrandSignalRun = {
    id: runId, brandId: brand.id, startedAt, finishedAt: new Date().toISOString(),
    candidateCount: acquisition.total, signalCount, refusedCount,
  };
  recordRun(run);

  if (signalCount > 0) {
    await sendAlert(brand, `📋 ${signalCount} new draft signal${signalCount === 1 ? "" : "s"} for ${brand.name} — review with GET /api/brand-signals?brandId=${brand.id}&status=draft, then POST /api/brand-signals/:id/validate.`);
  }

  return run;
}
