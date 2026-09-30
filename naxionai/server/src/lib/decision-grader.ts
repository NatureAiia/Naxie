// Decision-quality grader — model-free, domain-agnostic scoring of a
// synthesized report/answer BEFORE it's treated as final. No LLM call: every
// signal here is a cheap regex/string heuristic, so it can run on every
// synthesis without adding latency or cost.
//
// Four axes:
//   validity      — well-formed/complete (not empty, not truncated, no
//                   dangling placeholders)
//   correctness   — internally consistent (no impossible ratios/percentages,
//                   no conflicting verdicts, no self-admitted contradictions)
//   specificity   — concrete, not vague filler ("consider improving quality")
//   decidability  — names an actual action, an owner, and a falsifiable/
//                   checkable criterion — not just "consider doing X"
//
// WORST-FIRST verdict: the overall grade is the single weakest axis, never an
// average. A report can be perfectly valid, correct, and specific and still
// be useless if it never actually decides anything — averaging would let a
// high validity/correctness score paper over that.

export type GradeAxis = "validity" | "correctness" | "specificity" | "decidability";
export type GradeVerdict = "pass" | "warn" | "fail";

export type AxisGrade = {
  axis: GradeAxis;
  verdict: GradeVerdict;
  score: number;        // 0-100, informational only — VERDICT drives pass/fail, not this number
  findings: string[];   // short human-readable reasons, worst-first
};

export type DecisionGrade = {
  verdict: GradeVerdict;      // = the weakest axis's verdict (worst-first, never averaged)
  weakestAxis: GradeAxis;
  axes: AxisGrade[];          // always all 4, in the fixed order above
  summary: string;            // one-line human-readable rollup
};

export type GradeOptions = {
  minChars?: number;   // below this, validity is graded a hard fail (default 40)
};

const VERDICT_RANK: Record<GradeVerdict, number> = { fail: 0, warn: 1, pass: 2 };

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

// Same threshold shape for every axis — a raw 0-100 score maps to a verdict.
// Findings that represent a strong, unambiguous defect push the score below
// `failBelow` directly (see each grade* function); weaker/fuzzier signals
// only nudge it into `warn` territory.
function verdictFromScore(score: number, failBelow = 40, warnBelow = 70): GradeVerdict {
  if (score < failBelow) return "fail";
  if (score < warnBelow) return "warn";
  return "pass";
}

// ─── Validity — well-formed / complete ─────────────────────────────────────

function gradeValidity(text: string, minChars: number): AxisGrade {
  const trimmed = text.trim();
  const findings: string[] = [];
  if (trimmed.length === 0) {
    return { axis: "validity", verdict: "fail", score: 0, findings: ["output is empty"] };
  }
  let score = 100;
  if (trimmed.length < minChars) {
    findings.push(`output is only ${trimmed.length} chars — likely truncated or a stub`);
    score -= 70;
  }
  const fenceCount = (trimmed.match(/```/g) ?? []).length;
  if (fenceCount % 2 !== 0) {
    findings.push("unmatched ``` code fence — output likely truncated mid-generation");
    score -= 35;
  }
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    const openCount = (trimmed.match(new RegExp(`\\${open}`, "g")) ?? []).length;
    const closeCount = (trimmed.match(new RegExp(`\\${close}`, "g")) ?? []).length;
    if (Math.abs(openCount - closeCount) > 2) {
      findings.push(`unbalanced '${open}${close}' pairs (${openCount} vs ${closeCount})`);
      score -= 20;
    }
  }
  const placeholderMatch = trimmed.match(/\b(TODO|TBD|FIXME|XXX|PLACEHOLDER|lorem ipsum)\b|\[insert[^\]]*\]/i);
  if (placeholderMatch) {
    findings.push(`contains an unfinished placeholder marker ("${placeholderMatch[0]}")`);
    score -= 40;
  }
  // Dangling conjunction/punctuation at the very end — a generation that got
  // cut off mid-sentence, not a deliberate stylistic ending.
  if (/[,;:]\s*$/.test(trimmed) || /\b(and|or|but|the|a|an|to|of|with|is|are)\s*$/i.test(trimmed)) {
    findings.push("text ends mid-thought (dangling conjunction/punctuation)");
    score -= 25;
  }
  score = clamp(score);
  return { axis: "validity", verdict: verdictFromScore(score), score, findings };
}

// ─── Correctness — internally consistent, not self-contradicting ──────────

const POSITIVE_VERDICT_WORDS = new Set(["pass", "success", "approved", "yes", "ok", "healthy", "resolved"]);
const NEGATIVE_VERDICT_WORDS = new Set(["fail", "failure", "rejected", "no", "blocked", "unresolved", "broken"]);

function gradeCorrectness(text: string): AxisGrade {
  let score = 100;
  const findings: string[] = [];

  // Impossible ratio: "12 out of 5", "9/4" — numerator exceeding denominator
  // is a hard, unambiguous defect, not a fuzzy signal.
  for (const m of text.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)\b/gi)) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > den) {
      findings.push(`impossible ratio "${m[0].trim()}" (numerator exceeds denominator)`);
      score -= 50;
    }
  }

  // Percentage over 100% (allow tiny float slop up to 100.5 for rounding).
  for (const m of text.matchAll(/\b(\d{1,4}(?:\.\d+)?)\s*%/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > 100.5) {
      findings.push(`percentage over 100% ("${m[0]}")`);
      score -= 40;
    }
  }

  // Conflicting verdict labels: two "Verdict:"/"Overall:"/"Status:"/"Result:"
  // lines whose values land on opposite sides of pass/fail.
  const labels = [...text.matchAll(/\b(verdict|overall|status|result)\s*[:\-]\s*([a-z][a-z ]{0,20})/gi)];
  let sawPositive = false, sawNegative = false;
  for (const m of labels) {
    const word = m[2].trim().toLowerCase().split(/\s+/)[0];
    if (POSITIVE_VERDICT_WORDS.has(word)) sawPositive = true;
    if (NEGATIVE_VERDICT_WORDS.has(word)) sawNegative = true;
  }
  if (sawPositive && sawNegative) {
    findings.push("conflicting verdict labels stated (both a positive and a negative outcome claimed)");
    score -= 50;
  }

  // Self-admitted inconsistency — the text itself flags a mismatch. Weaker
  // signal (the flagged inconsistency might be resolved later in the text),
  // so it costs less than the structural checks above.
  const admission = text.match(/\b(contradicts?|inconsistent with|doesn'?t match|does not match|doesn'?t add up|does not add up|at odds with)\b/i);
  if (admission) {
    findings.push(`text itself flags a possible inconsistency ("${admission[0]}")`);
    score -= 30;
  }

  score = clamp(score);
  return { axis: "correctness", verdict: verdictFromScore(score), score, findings };
}

// ─── Specificity — concrete, not vague ─────────────────────────────────────

const VAGUE_PHRASES = [
  "consider ", "might want to", "could potentially", "in general", "as needed",
  "a number of", "look into", "explore options", "as appropriate", "etc.",
  "and so on", "improve quality", "make it better", "in due course",
  "at some point", "when possible", "if necessary", "a few", "several ",
  "various ", "things", "stuff",
];

function gradeSpecificity(text: string): AxisGrade {
  const lower = text.toLowerCase();
  const words = text.trim().split(/\s+/).filter(Boolean).length || 1;
  const per100 = 100 / words;

  const vagueHits: string[] = [];
  let vagueCount = 0;
  for (const phrase of VAGUE_PHRASES) {
    const count = lower.split(phrase).length - 1;
    if (count > 0) { vagueCount += count; vagueHits.push(phrase.trim()); }
  }

  const numberCount = (text.match(/\b\d+(?:\.\d+)?%?\b/g) ?? []).length;
  const backtickCount = (text.match(/`[^`]+`/g) ?? []).length;
  const envVarCount = (text.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []).length;
  const quotedCount = (text.match(/"[^"]{2,80}"/g) ?? []).length;
  const concreteCount = numberCount + backtickCount + envVarCount + quotedCount;

  const vagueDensity = vagueCount * per100;      // vague hits per 100 words
  const concreteDensity = concreteCount * per100; // concrete signals per 100 words

  let score = 100 - vagueDensity * 15 + Math.min(concreteDensity * 3, 20);
  const findings: string[] = [];
  if (vagueHits.length > 0) {
    findings.push(`vague filler language found (${vagueHits.slice(0, 3).map(v => `"${v}"`).join(", ")})`);
  }
  if (concreteCount === 0 && words > 40) {
    findings.push("no concrete numbers, identifiers, or named entities found in a non-trivial amount of text");
    score -= 25;
  }

  score = clamp(score);
  return { axis: "specificity", verdict: verdictFromScore(score), score, findings };
}

// ─── Decidability — names an action, an owner, and a checkable criterion ──

// Strong imperative verbs — deliberately excludes hedge verbs ("consider",
// "explore", "look into") so a hedged suggestion doesn't count as a firm
// recommended action.
const ACTION_VERBS = [
  "switch", "set", "replace", "investigate", "retire", "enable", "disable",
  "increase", "decrease", "reduce", "adjust", "move", "add", "remove", "fix",
  "update", "configure", "restart", "rotate", "escalate", "assign",
  "schedule", "cancel", "approve", "reject", "merge", "revert", "deploy",
  "rollback", "notify", "contact", "review", "archive", "delete", "create",
  "migrate", "upgrade", "downgrade", "pause", "resume", "block", "unblock",
  "grant", "revoke",
];
const ACTION_VERB_RE = new RegExp(`(^|\\n)\\s*(?:[-*\\d.)]+\\s*)?(${ACTION_VERBS.join("|")})\\b`, "im");

const OWNER_RE = /`[^`]+`|\b[A-Z][A-Z0-9_]{3,}\b|\bowner\s*:|\b(operator|scheduler|researcher|executor|admin|architect)\b/i;

const FALSIFIABLE_RE = /\b(exceeds?|below|at least|no more than|within \d+\s*(day|hour|week|month)s?|by \d{4}-\d{2}-\d{2}|>\s?\d|<\s?\d|\d+%|if\s.+\bthen\b)/i;

const HEDGE_BEFORE_ACTION_RE = new RegExp(`\\bconsider\\s+(?:${ACTION_VERBS.map(v => `${v}ing`).join("|")})`, "i");

function gradeDecidability(text: string): AxisGrade {
  // Deliberately strict baseline: the brief's own failure mode is a report
  // that only ever says "consider doing X" — that should land in fail/warn,
  // not pass-by-default.
  let score = 10;
  const findings: string[] = [];

  const hasAction = ACTION_VERB_RE.test(text);
  if (hasAction) score += 30; else findings.push("no imperative recommended action found (a named verb like \"switch\"/\"increase\"/\"retire\")");

  const hasOwner = OWNER_RE.test(text);
  if (hasOwner) score += 30; else findings.push("no named owner or responsible target found (a config key, role, or explicit \"Owner:\")");

  const hasCheckable = FALSIFIABLE_RE.test(text);
  if (hasCheckable) score += 30; else findings.push("no falsifiable/checkable success criterion found (a threshold, date, or measurable target)");

  if (HEDGE_BEFORE_ACTION_RE.test(text)) {
    findings.unshift("recommendation is hedged (\"consider …ing\") rather than a firm action");
    score -= 15;
  }

  score = clamp(score);
  return { axis: "decidability", verdict: verdictFromScore(score), score, findings };
}

// ─── Rollup ─────────────────────────────────────────────────────────────

export function gradeDecision(text: string, opts: GradeOptions = {}): DecisionGrade {
  const minChars = opts.minChars ?? 40;
  const axes: AxisGrade[] = [
    gradeValidity(text, minChars),
    gradeCorrectness(text),
    gradeSpecificity(text),
    gradeDecidability(text),
  ];

  // Worst-first: pick the axis with the lowest verdict rank, keeping the
  // FIRST one found on a tie so the fixed axis order above is the
  // deterministic tiebreaker (never an average of the four scores).
  let worst = axes[0];
  for (const a of axes) {
    if (VERDICT_RANK[a.verdict] < VERDICT_RANK[worst.verdict]) worst = a;
  }

  const summary = `${worst.verdict.toUpperCase()} — weakest axis: ${worst.axis}${worst.findings[0] ? ` (${worst.findings[0]})` : ""}`;
  return { verdict: worst.verdict, weakestAxis: worst.axis, axes, summary };
}
