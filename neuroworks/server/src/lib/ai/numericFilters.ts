/**
 * Kuwana numericFilters — personal-app port (vault-centric, no catalog).
 * Parses "under 10%", "at least 3", "low interest" etc. from a free-text question
 * and filters/sorts RAG hits whose preview contains numbers — conservative, threshold
 * that would leave nothing is dropped (returning empty is worse than closest).
 */
export type NumericConstraint =
  | { field: string; kind: "max"; value: number }
  | { field: string; kind: "min"; value: number }
  | { field: string; kind: "prefer"; direction: "low" | "high" };

const MAX_PHRASES = ["under","below","less than","lower than","no more than","at most","cheaper than","within"];
const MIN_PHRASES = ["over","above","more than","higher than","at least","no less than","minimum of","starting at"];
const LOW_WORDS = ["low","lowest","cheap","cheapest","least","smallest","minimum","affordable"];
const HIGH_WORDS = ["high","highest","most","largest","maximum","biggest","greatest"];

function esc(s: string){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
const THRESHOLD_RE = new RegExp(`\\b(?:(?<max>${MAX_PHRASES.map(esc).join("|")})|(?<min>${MIN_PHRASES.map(esc).join("|")}))\\b\\s*(?:[$]?\\s*(?<value>\\d[\\d,]*(?:\\.\\d+)?))`,"g");
const LOW_RE = new RegExp(`\\b(?:${LOW_WORDS.map(esc).join("|")})\\b`,"g");
const HIGH_RE = new RegExp(`\\b(?:${HIGH_WORDS.map(esc).join("|")})\\b`,"g");

function extractNumber(s: string): number | null { const n = Number(s.replace(/[,]/g,"")); return Number.isFinite(n)?n:null; }

export function parseNumericConstraints(question: string, fields: string[] = []): NumericConstraint[] {
  const text = question.toLowerCase();
  const constraints: NumericConstraint[] = [];
  // generic field-agnostic: if user says "under $50" without naming a field, attach to price/cost
  const field = fields[0] ?? "price";
  for (const m of text.matchAll(THRESHOLD_RE)) {
    const v = extractNumber(m.groups?.value ?? "");
    if (v===null) continue;
    constraints.push({ field, kind: m.groups?.max ? "max" : "min", value: v });
  }
  if (constraints.length===0) {
    if (LOW_RE.test(text)) constraints.push({ field, kind:"prefer", direction:"low" });
    else if (HIGH_RE.test(text)) constraints.push({ field, kind:"prefer", direction:"high" });
  }
  return constraints;
}

export function describeConstraints(constraints: NumericConstraint[]): string[] {
  return constraints.map(c => c.kind==="max"?`${c.field} ≤ ${c.value}`:c.kind==="min"?`${c.field} ≥ ${c.value}`:`${c.field}: ${c.direction} preferred`);
}
