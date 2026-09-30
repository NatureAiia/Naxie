// RAG entity + keyword sidecar (RIFTS-X DocumentAnalyzer port).
// Pure functions, no I/O — safe to call on every chunk during indexing
// and on every query for entity-overlap boosting.

export type RagEntities = {
  emails: string[];
  phones: string[];
  amounts: string[];
  dates: string[];
};

export type FileMeta = {
  retention?: string;      // e.g. "7y", "2029-05-01", "archive" | "destroy" | "review"
  location?: string;       // e.g. "Building A / Floor 2 / Cabinet 4"
  sensitivity?: string;    // normal | sensitive | highly-confidential
  expiryDate?: string;     // YYYY-MM-DD derived from retention where possible
};

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\d{7,12})\b/g;
const AMOUNT_RE = /\$[\d,]+(?:\.\d{2})?|\b\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:dollars?|usd|kes|ngn|ghs|zar)\b/gi;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi;

function uniqLimited(items: string[], cap = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = raw.trim().slice(0, 120);
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

export function extractEntities(text: string): RagEntities {
  if (!text) return { emails: [], phones: [], amounts: [], dates: [] };
  const head = text.slice(0, 200_000); // cap regex work on huge chunks
  return {
    emails: uniqLimited(head.match(EMAIL_RE) ?? []),
    phones: uniqLimited(head.match(PHONE_RE) ?? []),
    amounts: uniqLimited(head.match(AMOUNT_RE) ?? []),
    dates: uniqLimited(head.match(DATE_RE) ?? []),
  };
}

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i in is it me my of on or our please show tell that the this to was what when where which who why with you your not all any have has had were was are our their there here that this those these than then them they we you he she it its into over under out about also just like more most other some such only own same so than too very can will".split(" "),
);

export function extractKeywords(text: string, topN = 10): string[] {
  if (!text) return [];
  const words = text.toLowerCase().match(/\b[a-z][a-z0-9-]{2,}\b/g) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([w]) => w);
}

// Entity-overlap boost 0..2 — added to a hit's score when query entities
// appear in the chunk's entity sidecar.
export function entityOverlapBoost(query: string, chunk: RagEntities): number {
  const q = extractEntities(query);
  let boost = 0;
  const qSets = {
    emails: new Set(q.emails.map(e => e.toLowerCase())),
    dates: new Set(q.dates.map(d => d.toLowerCase())),
    amounts: new Set(q.amounts.map(a => a.toLowerCase())),
  };
  for (const e of chunk.emails) if (qSets.emails.has(e.toLowerCase())) boost += 1;
  for (const d of chunk.dates) if (qSets.dates.has(d.toLowerCase())) boost += 0.5;
  for (const a of chunk.amounts) if (qSets.amounts.has(a.toLowerCase())) boost += 0.5;
  // Phone overlap is rare but high-signal.
  const qPhones = new Set(q.phones.map(p => p.replace(/\D/g, "")));
  for (const p of chunk.phones) {
    if (qPhones.has(p.replace(/\D/g, "")) && p.replace(/\D/g, "").length >= 7) boost += 1;
  }
  // Keyword overlap — cheap Jaccard-ish signal, capped.
  const qk = new Set(extractKeywords(query, 8));
  if (qk.size > 0) {
    const ck = new Set((chunk as unknown as { keywords?: string[] }).keywords ?? []);
    let common = 0;
    for (const k of qk) if (ck.has(k)) common++;
    boost += Math.min(1, common * 0.25);
  }
  return Math.min(2, boost);
}

// --- Frontmatter governance meta (RIFTS-X RetentionRule/FileLocation port) ---
// Parses a small set of frontmatter keys; never throws.
export function parseFileMeta(body: string): FileMeta {
  const out: FileMeta = {};
  try {
    const m = body.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return out;
    const fm = m[1];
    const get = (key: string): string | undefined => {
      const r = fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, "m"));
      return r ? r[1].trim().slice(0, 200) : undefined;
    };
    const retention = get("retention") ?? get("retention_rule");
    const location = get("location") ?? get("file_location");
    const sensitivity = get("sensitivity") ?? get("sensitivity_level");
    const expiry = get("expiry_date") ?? get("expiry");
    if (retention) out.retention = retention;
    if (location) out.location = location;
    if (sensitivity) out.sensitivity = sensitivity.toLowerCase();
    if (expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry)) out.expiryDate = expiry;
    // Derive an expiry date from "7y" style retention + created date.
    if (!out.expiryDate && retention) {
      const ym = retention.match(/(\d+)\s*y/i);
      const created = get("created") ?? get("date_added");
      if (ym && created && /^\d{4}-\d{2}-\d{2}/.test(created)) {
        const d = new Date(created.slice(0, 10));
        if (!Number.isNaN(d.getTime())) {
          d.setFullYear(d.getFullYear() + Number(ym[1]));
          out.expiryDate = d.toISOString().slice(0, 10);
        }
      }
    }
  } catch { /* best-effort */ }
  return out;
}

// Risk + SLA flags surfaced in RAG previews (RIFTS-X RiskEngine/SLA port).
export function riskFlags(meta: FileMeta, body: string): string[] {
  const flags: string[] = [];
  const sens = (meta.sensitivity ?? "").toLowerCase();
  if (sens.includes("highly") || sens === "highly-confidential" || sens === "4" || sens === "3") {
    flags.push("sensitive");
  } else if (sens.includes("sensitive") || sens === "confidential") {
    flags.push("sensitive");
  }
  if (meta.expiryDate) {
    const days = Math.round((Date.parse(meta.expiryDate) - Date.now()) / 86_400_000);
    if (Number.isFinite(days)) {
      if (days < 0) flags.push("retention-expired");
      else if (days <= 30) flags.push("retention-expiring");
    }
  }
  // Overdue markers inside the note itself (tasks with past due dates).
  const dueRe = /due[:\s]+(\d{4}-\d{2}-\d{2})/gi;
  let m: RegExpExecArray | null;
  const today = new Date().toISOString().slice(0, 10);
  while ((m = dueRe.exec(body.slice(0, 20_000))) !== null) {
    if (m[1] < today && !/done|completed|closed/i.test(body.slice(Math.max(0, m.index - 60), m.index))) {
      flags.push("overdue");
      break;
    }
  }
  return [...new Set(flags)];
}
