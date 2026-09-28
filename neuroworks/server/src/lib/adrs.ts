// ADRS — AI Data Readiness System pipeline.
//
// This is NeuroWorks' main data pipeline. It takes raw records (from a company
// data source, an upload, a scrape, or inline JSON) and runs them through the
// ADRS stages, then PUBLISHES a versioned dataset into the vault as three
// machine-ready artifacts (ML CSV, knowledge-graph JSONL, RAG chunks) plus a
// knowledge-pack card. Because the artifacts live in the vault they're indexed
// by vault-index, so agents LEARN from every published dataset via retrieval —
// the published dataset shows up as a knowledge pack (see knowledge-packs.ts).
//
// Stage map (mirrors the ADRS architecture diagram):
//   1. Normalization Engine        — canonicalise keys, trim/clean values, coerce types
//   2. Cryptographic Hashing       — SHA-256 per record + a Merkle-style batch root hash
//   3. Confidence Scoring          — completeness score per record (0..1)
//   4. HITL Validation gate        — records below the threshold are flagged for review
//   5. Entity Resolution           — dedup by hash, merge duplicates into a Golden Record
//   6. Dataset Publishing          — write CSV + JSONL + RAG chunks + pack card to the vault
//   7. Autonomous Feedback Loop    — published artifacts re-enter the vault index for agents
//
// Deterministic + dependency-free (node crypto + fs) so it runs in the free
// local core (Approach D) with no API keys.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readJsonStore, statePath, tryWriteJsonStore } from "./json-store.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { writeVaultFile } from "./vault.js";
import { publishEvent } from "./webhook-delivery.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.NEUROWORKS_STATE_DIR
  ? resolve(process.env.NEUROWORKS_STATE_DIR)
  : resolve(__dirname, "../../../.neuroworks");
// Resolved per call, not at import time — see json-store.ts statePath().
const REGISTRY_PATH = () => statePath("datasets.json");

// Vault folder that holds every published dataset. Lives under the vault so the
// index picks it up and the Knowledge browser can open the artifacts.
export const DATASETS_DIR = "_datasets";

export type AdrsRecord = Record<string, unknown>;

export type StageReport = {
  stage: string;
  in: number;
  out: number;
  note: string;
};

export type DatasetManifest = {
  id: string;
  name: string;
  sector?: string;
  source: string;
  createdAt: string;
  rawCount: number;        // input records
  recordCount: number;     // golden records published
  reviewQueue: number;     // records flagged for HITL review
  ambiguousMatches: number; // golden records left unmerged on a single weak signal — needs human resolution
  avgConfidence: number;   // mean confidence of published records (0..1)
  rootHash: string;        // batch root hash (tamper-evident provenance anchor)
  fields: string[];        // union of golden-record field names
  stages: StageReport[];
  outputs: { csv: string; jsonl: string; rag: string; card: string };
};

export type PublishInput = {
  name: string;
  records: AdrsRecord[];
  sector?: string;
  source?: string;
  keyField?: string;            // entity-resolution merge key; falls back to full-hash dedup
  confidenceThreshold?: number; // default 0.6
};

// ── Registry (manifests live outside the vault — derived metadata) ──────────

// Set when the store existed but could not be read. Blocks writes, so a damaged
// file is never overwritten with an empty store — see json-store.ts.
let storeUnreadable: string | null = null;

/** Why the datasets store is unreadable, or null. For /api/status. */
export function datasetStoreProblem(): string | null {
  return storeUnreadable;
}

function loadRegistry(): DatasetManifest[] {
  const read = readJsonStore<DatasetManifest[]>(REGISTRY_PATH(), () => [], {
    label: "datasets",
    validate: v => Array.isArray(v),
  });
  if (read.error) storeUnreadable = read.error;
  return Array.isArray(read.value) ? read.value : [];
}

function saveRegistry(list: DatasetManifest[]): void {
  if (storeUnreadable) {
    console.warn(`[datasets] persist REFUSED — store is unreadable (${storeUnreadable}). Resolve the quarantined file and restart.`);
    return;
  }
  tryWriteJsonStore(REGISTRY_PATH(), list, { label: "datasets" });
}

export function listDatasets(): DatasetManifest[] {
  return loadRegistry().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDataset(id: string): DatasetManifest | undefined {
  return loadRegistry().find(d => d.id === id);
}

export function deleteDataset(id: string): boolean {
  const list = loadRegistry();
  const next = list.filter(d => d.id !== id);
  if (next.length === list.length) return false;
  saveRegistry(next);
  return true;
}

// ── Stage 1: Normalization Engine ───────────────────────────────────────────

function canonicalKey(k: string): string {
  return k.trim().toLowerCase().replace(/[\s.]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

// Values that look present but carry no real information. Must never count as
// filled data — a "n/a" or "tbd" cell would otherwise inflate confidence and
// win a golden-record merge over an actually-known value from another dupe.
const WEAK_VALUES = new Set([
  "n/a", "na", "none", "null", "-", "--", "tbd", "unknown", "unk",
  "see attached", "as applicable", "not applicable", "not available", "pending", "?",
]);

function isWeakValue(t: string): boolean {
  return WEAK_VALUES.has(t.toLowerCase());
}

// African-leaning phone normalisation: infer a country calling code from
// whatever's already in the string (leading "+", a "00" trunk prefix, or a
// bare national number with its own trunk "0"), rather than assuming one
// country. Numbers we can't confidently place are left as digits-only rather
// than guessing a code.
const AFRICAN_TRUNK_CODES: Record<string, string> = {
  "254": "0", // Kenya
  "256": "0", // Uganda
  "255": "0", // Tanzania
  "263": "0", // Zimbabwe
  "234": "0", // Nigeria
  "27": "0",  // South Africa
  "233": "0", // Ghana
  "260": "0", // Zambia
  "265": "0", // Malawi
  "250": "0", // Rwanda
};

function coercePhone(raw: string): string | null {
  let digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+")) return `+${digits.slice(1).replace(/\D/g, "")}`;
  digits = digits.replace(/\D/g, "");
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  for (const code of Object.keys(AFRICAN_TRUNK_CODES)) {
    if (digits.startsWith(code) && digits.length >= code.length + 8) return `+${digits}`;
  }
  if (digits.startsWith("0") && digits.length >= 9) return digits; // national form, country unknown — leave for review rather than guess
  return digits.length >= 8 ? digits : null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASH_DATE_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;

function coerceDate(t: string): string | null {
  if (DATE_RE.test(t)) return t;
  const m = t.match(SLASH_DATE_RE);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = Number(y) < 70 ? `20${y}` : `19${y}`;
    // Ambiguous d/m vs m/d — prefer day-first (the common non-US convention in
    // this dataset's target markets) but fall back to month-first if day-first
    // is out of range.
    let day = Number(a), month = Number(b);
    if (day > 12 && month <= 12) { /* already day-first */ }
    else if (month > 12 && day <= 12) { [day, month] = [month, day]; }
    else if (day > 31) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const parsed = Date.parse(t);
  if (!Number.isNaN(parsed) && /[a-zA-Z]/.test(t)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

function isPhoneField(key: string): boolean {
  return /phone|mobile|cell|whatsapp|contact_number|tel$/i.test(key);
}

function isDateField(key: string): boolean {
  return /date|_dob$|^dob$|birthdate|born$/i.test(key);
}

function coerce(v: unknown, key = ""): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const t = v.trim().replace(/\s+/g, " ");
    if (t === "" || isWeakValue(t)) return null;
    if (isPhoneField(key)) return coercePhone(t) ?? t;
    if (isDateField(key)) return coerceDate(t) ?? t;
    // Numeric-looking strings → numbers (keeps CSVs ML-ready).
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
    return t;
  }
  if (typeof v === "object") return JSON.stringify(v);
  return v;
}

function normalizeRecord(rec: AdrsRecord): AdrsRecord {
  const out: AdrsRecord = {};
  for (const [k, v] of Object.entries(rec)) {
    const key = canonicalKey(k);
    if (!key) continue;
    out[key] = coerce(v, key);
  }
  return out;
}

// ── Stage 2: Cryptographic Hashing ──────────────────────────────────────────

function hashRecord(rec: AdrsRecord): string {
  // Sort keys so logically-identical records hash equal regardless of column order.
  const sorted = Object.keys(rec).sort().map(k => [k, rec[k]]);
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// Merkle-style fold over the per-record hashes → a single tamper-evident root
// for the whole batch (the "immutable digital barcode" in the diagram).
function rootHashOf(hashes: string[]): string {
  if (hashes.length === 0) return createHash("sha256").update("empty").digest("hex");
  let layer = [...hashes].sort();
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i];
      const b = layer[i + 1] ?? a; // odd node duplicates up
      next.push(createHash("sha256").update(a + b).digest("hex"));
    }
    layer = next;
  }
  return layer[0];
}

// ── Stage 3: Confidence Scoring ─────────────────────────────────────────────
// Weighted multi-check score, not a raw completeness fraction: a record full
// of technically-non-null-but-malformed values (a phone that isn't a phone)
// shouldn't outscore a sparser but genuinely clean one.

function isFilled(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "";
}

function isValidValue(v: unknown, field: string): boolean {
  if (!isFilled(v)) return false;
  if (typeof v === "string" && isWeakValue(v)) return false;
  if (isPhoneField(field)) return typeof v === "string" && /^\+?\d{8,15}$/.test(v);
  if (isDateField(field)) return typeof v === "string" && DATE_RE.test(v);
  return true;
}

function scoreConfidence(rec: AdrsRecord, fieldUniverse: string[]): number {
  if (fieldUniverse.length === 0) return 0;
  let filled = 0;
  let valid = 0;
  let clean = 0;
  for (const f of fieldUniverse) {
    const v = rec[f];
    if (isFilled(v)) {
      filled += 1;
      if (!(typeof v === "string" && isWeakValue(v))) clean += 1;
      if (isValidValue(v, f)) valid += 1;
    }
  }
  const completeness = filled / fieldUniverse.length;
  const validity = filled > 0 ? valid / filled : 0;
  const denylistPass = filled > 0 ? clean / filled : 0;
  const score = completeness * 0.5 + validity * 0.3 + denylistPass * 0.2;
  return Math.round(score * 1000) / 1000;
}

// ── Stage 5: Entity Resolution → Golden Record ──────────────────────────────
// Group by keyField/full-hash (exact match, as before) AND by multi-signal
// agreement (name+email, name+phone, email+phone — any 2 of the 3). Records
// sharing only ONE weak signal (e.g. name alone) are never auto-merged; they're
// left as separate golden records and flagged via ambiguousMatch for a human
// to resolve. Within a merged group, each output field independently takes
// the value from whichever member has the highest confidence AMONG members
// that actually have that field — a per-field union, not a null-fill from a
// single "base" record.

type Scored = { rec: AdrsRecord; hash: string; confidence: number; review: boolean; ambiguousMatch: boolean };

function isNameField(key: string): boolean {
  return /^(name|full_name|fullname)$/.test(key);
}

type EntitySignals = { name?: string; email?: string; phone?: string };

function extractSignals(rec: AdrsRecord): EntitySignals {
  const sig: EntitySignals = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim().toLowerCase();
    if (!s) continue;
    if (!sig.name && isNameField(k)) sig.name = s;
    if (!sig.email && /email/.test(k)) sig.email = s;
    if (!sig.phone && isPhoneField(k)) sig.phone = s;
  }
  if (!sig.name) {
    const first = rec["first_name"];
    const last = rec["last_name"] ?? rec["surname"];
    if (first != null && last != null) sig.name = `${String(first).trim()} ${String(last).trim()}`.toLowerCase();
  }
  return sig;
}

function signalMatchCount(a: EntitySignals, b: EntitySignals): number {
  let n = 0;
  if (a.name && b.name && a.name === b.name) n += 1;
  if (a.email && b.email && a.email === b.email) n += 1;
  if (a.phone && b.phone && a.phone === b.phone) n += 1;
  return n;
}

function goldenRecords(rows: Scored[], keyField?: string): Scored[] {
  const n = rows.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const exactGroups = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const key = keyField && r.rec[keyField] != null ? `k:${String(r.rec[keyField])}` : `h:${r.hash}`;
    if (!exactGroups.has(key)) exactGroups.set(key, []);
    exactGroups.get(key)!.push(i);
  });
  for (const idxs of exactGroups.values()) for (let j = 1; j < idxs.length; j++) union(idxs[0], idxs[j]);

  const signals = rows.map(r => extractSignals(r.rec));
  const ambiguous = new Set<number>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      const m = signalMatchCount(signals[i], signals[j]);
      if (m >= 2) union(i, j);
      else if (m === 1) { ambiguous.add(i); ambiguous.add(j); }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const golden: Scored[] = [];
  for (const idxs of groups.values()) {
    const group = idxs.map(i => rows[i]);
    const fieldNames = new Set<string>();
    for (const g of group) for (const k of Object.keys(g.rec)) fieldNames.add(k);
    const base: AdrsRecord = {};
    for (const f of fieldNames) {
      let bestVal: unknown = null;
      let bestConf = -1;
      for (const g of group) {
        const v = g.rec[f];
        if (v === null || v === undefined || v === "") continue;
        if (g.confidence > bestConf) { bestConf = g.confidence; bestVal = v; }
      }
      base[f] = bestVal;
    }
    const bestConfidence = Math.max(...group.map(g => g.confidence));
    const hash = hashRecord(base);
    golden.push({
      rec: base,
      hash,
      confidence: bestConfidence,
      review: group.some(g => g.review),
      ambiguousMatch: idxs.some(i => ambiguous.has(i)),
    });
  }
  return golden;
}

// ── PII stripping (ML exports only — RAG markdown keeps every field) ───────
// The ML CSV/JSONL are for training/feature pipelines, not human retrieval:
// stripping identifier-shaped columns there closes a real leak without
// touching the RAG export, which needs the full record to answer questions.

const PII_FIELD_NAMES = new Set([
  "email", "email_address", "phone", "phone_number", "mobile", "mobile_number",
  "cell", "cell_phone", "whatsapp", "ssn", "social_security_number",
  "national_id", "national_id_number", "id_number", "passport", "passport_number",
  "address", "home_address", "street_address", "physical_address", "postal_address",
  "dob", "date_of_birth", "birthdate", "birth_date",
]);

const PII_FIELD_PATTERNS = [
  /email/, /phone|mobile|cell|whatsapp/, /ssn|social_security/,
  /national_id|id_number|passport/, /address/, /dob$|date_of_birth|birth_?date/,
];

function isIdentifierField(field: string): boolean {
  return PII_FIELD_NAMES.has(field) || PII_FIELD_PATTERNS.some(re => re.test(field));
}

// ── Output serialisers ──────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: AdrsRecord[], fields: string[]): string {
  const lines = [fields.map(csvCell).join(",")];
  for (const r of rows) lines.push(fields.map(f => csvCell(r[f])).join(","));
  return lines.join("\n") + "\n";
}

// Knowledge-graph JSONL: one node per golden record + one edge per non-null
// field value (entity → attribute value). Simple, but real relational structure
// an agent or downstream tool can traverse.
function toGraphJsonl(rows: Scored[], fields: string[], keyField: string | undefined, datasetId: string): string {
  const out: string[] = [];
  rows.forEach((r, i) => {
    const id = keyField && r.rec[keyField] != null ? `${datasetId}:${String(r.rec[keyField])}` : `${datasetId}:${r.hash.slice(0, 12)}`;
    const label = keyField && r.rec[keyField] != null ? String(r.rec[keyField]) : `record-${i + 1}`;
    const props: AdrsRecord = {};
    for (const f of fields) props[f] = r.rec[f];
    out.push(JSON.stringify({ type: "node", id, label, props, confidence: r.confidence, hash: r.hash }));
    for (const f of fields) {
      if (f === keyField) continue;
      const v = r.rec[f];
      if (v === null || v === undefined || v === "") continue;
      out.push(JSON.stringify({ type: "edge", from: id, rel: f, to: String(v) }));
    }
  });
  return out.join("\n") + "\n";
}

// RAG-ready chunks: one markdown section per golden record. vault-index treats
// the whole file as a searchable doc; the per-record headings keep retrieval
// previews legible.
function toRagMarkdown(name: string, rows: Scored[], fields: string[]): string {
  const head = `# ${name} — RAG chunks\n\n> Published dataset. Each section is one golden record an agent can retrieve.\n`;
  const chunks = rows.map((r, i) => {
    const body = fields
      .filter(f => r.rec[f] !== null && r.rec[f] !== undefined && r.rec[f] !== "")
      .map(f => `- **${f}**: ${r.rec[f]}`)
      .join("\n");
    return `## Record ${i + 1}\n${body}\n\n_confidence: ${r.confidence} · hash: ${r.hash.slice(0, 12)}_`;
  });
  return head + "\n" + chunks.join("\n\n") + "\n";
}

function packCard(m: DatasetManifest, sampleFields: string[]): string {
  return `# ${m.name} — Dataset Knowledge Pack

> Published by the Intellinexus data pipeline. Agents learn from this dataset via vault
> retrieval — search for its subject and the records below surface as context.

## Provenance & audit
- **Dataset id**: \`${m.id}\`
- **Source**: ${m.source}
- **Sector**: ${m.sector ?? "general"}
- **Published**: ${m.createdAt}
- **Batch root hash** (tamper-evident): \`${m.rootHash}\`
- **Records**: ${m.recordCount} golden (${m.rawCount} raw in) · **avg confidence**: ${(m.avgConfidence * 100).toFixed(1)}%
- **HITL review queue**: ${m.reviewQueue} record${m.reviewQueue === 1 ? "" : "s"} flagged below confidence threshold
- **Ambiguous matches**: ${m.ambiguousMatches} record${m.ambiguousMatches === 1 ? "" : "s"} left unmerged on a single weak signal — needs human resolution

## Fields
${m.fields.map(f => `- \`${f}\``).join("\n")}

## Pipeline stages
| Stage | In | Out | Note |
|---|---|---|---|
${m.stages.map(s => `| ${s.stage} | ${s.in} | ${s.out} | ${s.note} |`).join("\n")}

## Machine-ready outputs
- **ML CSV** — \`${m.outputs.csv}\`
- **Knowledge-graph JSONL** — \`${m.outputs.jsonl}\`
- **RAG chunks** — \`${m.outputs.rag}\`

## How agents use this
The RAG chunks and this card are indexed in the vault. Any agent answering a
question in this domain retrieves the golden records as grounding. Sample fields:
${sampleFields.map(f => `\`${f}\``).join(", ")}.
`;
}

// ── The pipeline ────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "dataset";
}

export type PublishResult = { manifest: DatasetManifest };

// Run the full ADRS pipeline over `records` and publish the dataset.
export function publishDataset(input: PublishInput): PublishResult {
  const threshold = input.confidenceThreshold ?? 0.6;
  const raw = Array.isArray(input.records) ? input.records : [];
  const stages: StageReport[] = [];

  // 1. Normalization
  const normalized = raw.map(normalizeRecord).filter(r => Object.keys(r).length > 0);
  stages.push({ stage: "Normalization", in: raw.length, out: normalized.length, note: "canonical keys, trimmed + type-coerced values" });

  // Field universe (post-normalization) drives confidence + CSV columns.
  const fieldSet = new Set<string>();
  for (const r of normalized) for (const k of Object.keys(r)) fieldSet.add(k);
  const fieldUniverse = [...fieldSet];

  // 2. Cryptographic hashing
  const hashed: Scored[] = normalized.map(rec => ({ rec, hash: hashRecord(rec), confidence: 0, review: false, ambiguousMatch: false }));
  const rootHash = rootHashOf(hashed.map(h => h.hash));
  stages.push({ stage: "Cryptographic Hashing", in: normalized.length, out: hashed.length, note: `SHA-256 per record; batch root ${rootHash.slice(0, 12)}…` });

  // 3. Confidence scoring + 4. HITL gate
  let reviewQueue = 0;
  for (const h of hashed) {
    h.confidence = scoreConfidence(h.rec, fieldUniverse);
    h.review = h.confidence < threshold;
    if (h.review) reviewQueue += 1;
  }
  stages.push({ stage: "Confidence Scoring", in: hashed.length, out: hashed.length, note: `completeness over ${fieldUniverse.length} fields` });
  stages.push({ stage: "HITL Validation", in: hashed.length, out: hashed.length - reviewQueue, note: `${reviewQueue} flagged below ${threshold} confidence` });

  // 5. Entity resolution → golden records
  const golden = goldenRecords(hashed, input.keyField ? canonicalKey(input.keyField) : undefined);
  const ambiguousMatches = golden.filter(g => g.ambiguousMatch).length;
  stages.push({
    stage: "Entity Resolution",
    in: hashed.length,
    out: golden.length,
    note: `${input.keyField ? `merged on "${input.keyField}" + ` : ""}multi-signal (name+email/phone) match, per-field union merge; ${ambiguousMatches} flagged as ambiguous (single weak signal)`,
  });

  // Recompute the published field universe from golden records (merge may add columns).
  const goldenFieldSet = new Set<string>();
  for (const g of golden) for (const k of Object.keys(g.rec)) goldenFieldSet.add(k);
  const fields = [...goldenFieldSet];

  const avgConfidence = golden.length
    ? Math.round((golden.reduce((s, g) => s + g.confidence, 0) / golden.length) * 1000) / 1000
    : 0;

  // 6. Publish artifacts to the vault.
  const id = `${slugify(input.name)}-${Date.now().toString(36)}`;
  const base = `${DATASETS_DIR}/${id}`;
  const outputs = {
    csv: `${base}/dataset.csv`,
    jsonl: `${base}/graph.jsonl`,
    rag: `${base}/rag.md`,
    card: `${base}/00-${slugify(input.name)}.md`,
  };

  const manifest: DatasetManifest = {
    id,
    name: input.name,
    sector: input.sector,
    source: input.source ?? "inline",
    createdAt: new Date().toISOString(),
    rawCount: raw.length,
    recordCount: golden.length,
    reviewQueue,
    ambiguousMatches,
    avgConfidence,
    rootHash,
    fields,
    stages,
    outputs,
  };

  const mlFields = fields.filter(f => !isIdentifierField(f));
  writeVaultFile(outputs.csv, toCsv(golden.map(g => g.rec), mlFields));
  writeVaultFile(outputs.jsonl, toGraphJsonl(golden, mlFields, input.keyField ? canonicalKey(input.keyField) : undefined, id));
  writeVaultFile(outputs.rag, toRagMarkdown(input.name, golden, fields));
  writeVaultFile(outputs.card, packCard(manifest, fields.slice(0, 8)));

  stages.push({ stage: "Dataset Publishing", in: golden.length, out: golden.length, note: "CSV + JSONL + RAG + pack card written to vault" });

  // 7. Register (the vault watcher re-indexes the new files → agents can learn).
  const list = loadRegistry();
  list.push(manifest);
  saveRegistry(list);

  // Notify any registered webhook targets — fire-and-forget so a slow or
  // failing external endpoint never delays the publish itself; the delivery
  // retry engine (webhook-delivery.ts) handles anything that fails here.
  void publishEvent("dataset.published", {
    id: manifest.id,
    name: manifest.name,
    sector: manifest.sector,
    source: manifest.source,
    recordCount: manifest.recordCount,
    avgConfidence: manifest.avgConfidence,
    rootHash: manifest.rootHash,
  }).catch(() => { /* publishEvent already records the failure per-delivery */ });

  return { manifest };
}

// Convenience used by the route + primitive: turn DB/CSV query rows into a dataset.
export function publishFromRows(name: string, rows: AdrsRecord[], opts: Partial<PublishInput> = {}): PublishResult {
  return publishDataset({ name, records: rows, ...opts });
}

export function vaultDatasetsRoot(): string {
  return resolve(config.vaultPath, DATASETS_DIR);
}
