// Did the answer come back in the shape the operator asked for?
//
// Ported from AI-Institute-Africa/neuroworks. quality.check rates ~81% of its
// own runs a pass; human thumbs on the same work sit at ~58% — the gap is
// almost entirely SHAPE complaints ("you gave me json not a doc", "give me
// the consolidated doc not a summary"), not substance. The grader already has
// a prompt_alignment axis that explicitly mentions format and scores those
// runs as passes anyway — the finding is that an LLM asked to grade whether
// it followed an instruction is not a reliable judge of whether it followed
// an instruction.
//
// So this is DETERMINISTIC, and it bounds the LLM verdict the same way
// quality.check's citation counters already do: count first, then let the
// model score within what the count allows.
//
// Bias: FALSE NEGATIVES over false positives. A missed format break costs one
// bad answer; a wrong accusation makes the whole gate noise. Every rule fires
// only on an explicit, unambiguous request; anything unrecognised passes
// silently.

export type RequestedFormat = "json" | "csv" | "table" | "list" | "document" | "count";

export type FormatVerdict = {
  /** What the request unambiguously asked for. Empty = nothing detectable. */
  requested: RequestedFormat[];
  /** Rules that FAILED, in operator-readable words. */
  violations: string[];
  /** No detected request was broken. True when nothing was detected at all. */
  satisfied: boolean;
};

// Things a request can ask for N of, where N is countable as list items.
// Deliberately excludes sentences/words/paragraphs/pages — prose measures,
// unreliable to count.
const COUNTABLE = "questions?|bullets?|bullet points?|points?|items?|examples?|ideas?|steps?|options?|tips?|reasons?|ways?|headlines?|posts?|slides?|sections?|names?|suggestions?|recommendations?";

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, fifty: 50,
};

/** Strip fenced code blocks — their contents are payload, not prose structure. */
function withoutFences(s: string): string {
  return s.replace(/```[\s\S]*?```/g, "");
}

/** Does this text contain a real JSON object or array as its substance? */
export function looksLikeJson(answer: string): boolean {
  const t = answer.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [fenced, t].filter(Boolean) as string[]) {
    if (!/^[\[{]/.test(candidate)) continue;
    try { JSON.parse(candidate); return true; } catch { /* try the next shape */ }
  }
  return false;
}

/** A markdown table needs a header separator row — `|---|---|`. */
export function hasMarkdownTable(answer: string): boolean {
  return /^\s*\|?[^\n|]*\|[^\n]*\n\s*\|?\s*:?-{2,}/m.test(answer);
}

/** Count list items: `- x`, `* x`, `1. x`, `1) x`. Fences excluded. */
export function countListItems(answer: string): number {
  const body = withoutFences(answer);
  return (body.match(/^[ \t]*(?:[-*•]|\d+[.)])\s+\S/gm) ?? []).length;
}

/** How much of the answer is prose rather than data. */
function proseChars(answer: string): number {
  return withoutFences(answer).replace(/^[ \t]*(?:[-*•]|\d+[.)])\s+/gm, "").trim().length;
}

/**
 * Judge an answer against its request. `task` is the operator's own words —
 * nothing here reads the plan or the model's intent, only what was asked and
 * what came back.
 */
export function checkRequestedFormat(task: string, answer: string): FormatVerdict {
  const t = String(task ?? "").toLowerCase();
  const a = String(answer ?? "");
  const requested: RequestedFormat[] = [];
  const violations: string[] = [];
  if (!t.trim() || !a.trim()) return { requested, violations, satisfied: true };

  const wantsJson = /\b(?:as|in|to|return|output|give me|format(?:ted)? as)\s+(?:a\s+|an\s+|valid\s+)?json\b|\bjson\s+(?:format|output|object|array)\b/.test(t);
  const wantsCsv = /\b(?:as|in|to|export|output|give me)\s+(?:a\s+)?csv\b|\bcsv\s+(?:format|file)\b/.test(t);
  const wantsTable = /\b(?:as|in|into)\s+a\s+table\b|\btable\s+(?:format|of)\b|\btabulate\b/.test(t);
  const wantsList = /\b(?:bullet(?:ed)?\s+(?:list|points?)|as\s+(?:a\s+)?(?:list|bullets)|in\s+bullets?)\b/.test(t);
  // "a document, not a summary" is the complaint verbatim — a request for PROSE.
  const wantsDocument = /\b(?:a\s+)?(?:document|doc|report|write[- ]?up|memo|essay|article|letter|proposal)\b/.test(t)
    && !/\bdocument(?:s)?\s+(?:store|store|folder|library|id)\b/.test(t);

  if (wantsJson) {
    requested.push("json");
    if (!looksLikeJson(a)) violations.push("asked for JSON, but the answer is not parseable JSON");
  }
  if (wantsCsv) {
    requested.push("csv");
    const rows = withoutFences(a).split(/\n/).filter(l => (l.match(/,/g) ?? []).length >= 1);
    if (rows.length < 2) violations.push("asked for CSV, but the answer has no comma-separated rows");
  }
  if (wantsTable) {
    requested.push("table");
    if (!hasMarkdownTable(a)) violations.push("asked for a table, but the answer contains none");
  }
  if (wantsList) {
    requested.push("list");
    if (countListItems(a) < 2) violations.push("asked for a bulleted list, but the answer has no list items");
  }
  if (wantsDocument && !wantsJson && !wantsCsv) {
    requested.push("document");
    if (looksLikeJson(a)) violations.push("asked for a document, but the answer is raw JSON");
    else if (proseChars(a) < 400) violations.push("asked for a document, but the answer is too short to be one");
  }

  // "25 questions", "give me 5 bullet points", "three examples".
  const countMatch = t.match(new RegExp(`\\b(\\d{1,3}|${Object.keys(WORD_NUMBERS).join("|")})\\s+(?:${COUNTABLE})\\b`));
  if (countMatch) {
    const want = /^\d+$/.test(countMatch[1]) ? Number(countMatch[1]) : WORD_NUMBERS[countMatch[1]];
    // Only meaningful for a real list. Below 3 the "list" may legitimately be
    // prose; above 100 the request is rhetorical more often than literal.
    if (want >= 3 && want <= 100) {
      requested.push("count");
      const found = countListItems(a);
      if (found < want) violations.push(`asked for ${want} items, but the answer has ${found}`);
    }
  }

  return { requested, violations, satisfied: violations.length === 0 };
}

/**
 * The ceiling a format break puts on prompt_alignment. Not a hard zero — the
 * answer may be substantively excellent and simply the wrong shape, and
 * flattening it to 0 would destroy the axis's ability to rank. 0.35 is below
 * the 0.5 pass line, so a broken format cannot pass, while leaving room
 * between "wrong shape" and "wrong answer".
 */
export const FORMAT_BREAK_ALIGNMENT_CAP = 0.35;
