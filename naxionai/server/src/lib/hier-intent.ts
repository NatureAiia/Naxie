// Hierarchical (domain -> intent) classification — ported by PATTERN from
// ZimVoice's semantic_engine.py `classify_intent`. The original scores text
// against sentence-transformer embeddings of example phrases per domain and
// per intent, then applies concept-based confidence boosts/penalties and a
// margin-based ambiguity guard. This codebase has no embedding model for
// short utterances, so the scoring here is deterministic keyword-overlap
// (Jaccard over word sets) instead of cosine similarity over embeddings —
// same staged structure and same ambiguity rule, different similarity
// function. ZimVoice's own Stage-1 domain gate was found (by its own
// source comment) to be too brittle and was bypassed in favor of letting
// every intent compete — this port keeps that lesson: domain scoring is
// informational (returned for callers/logging), never a hard filter.
//
// Ambiguity/low-confidence guard thresholds are ZimVoice's own tuned
// values (0.48 absolute floor, 0.15 margin, 0.75 margin-exempt ceiling).

import { ZIM_FINANCIAL_PHRASES } from "./shona-glossary.js";

export type IntentAnchors = Record<string, string[]>;

export type IntentDomain = {
  id: string;
  /** Example phrases for the domain itself (informational scoring only). */
  examples: string[];
  /** Intent id -> example phrases, the actual competing candidates. */
  intents: IntentAnchors;
};

const domains = new Map<string, IntentDomain>();

export function registerDomain(domain: IntentDomain): void {
  domains.set(domain.id, domain);
}

export function _resetDomainsForTests(): void {
  domains.clear();
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9']+/g) ?? []);
}

// Jaccard similarity between the query's word set and one example phrase's
// word set — a cheap, dependency-free stand-in for cosine-over-embeddings.
// Scores against every example for a label; the label's score is the best
// (max) single-example match, matching ZimVoice's own `max(...)` reduction.
function bestScore(query: Set<string>, examples: string[]): number {
  let best = 0;
  for (const ex of examples) {
    const exWords = words(ex);
    if (exWords.size === 0) continue;
    let overlap = 0;
    for (const w of exWords) if (query.has(w)) overlap++;
    const union = new Set([...query, ...exWords]).size;
    const score = union === 0 ? 0 : overlap / union;
    if (score > best) best = score;
  }
  return best;
}

export type ClassifyResult = {
  status: "resolved" | "ambiguous" | "unknown";
  domain?: { id: string; score: number };
  intent?: string;
  confidence: number;
  alternatives: { intent: string; score: number }[];
  reason?: string;
};

const UNKNOWN_FLOOR = 0.48;
const MARGIN_MIN = 0.15;
const MARGIN_EXEMPT_CEILING = 0.75;

/**
 * Classify `text` against every intent across every registered domain.
 * Stage 1 picks the best-scoring domain (informational only — logged via
 * the returned `domain` field, not used to filter candidates). Stage 2
 * scores every intent across ALL domains. Stage 3 applies the ambiguity
 * guards: below the absolute floor -> "unknown"; top two within the margin
 * (and the leader isn't confident enough to be margin-exempt) -> "ambiguous".
 */
export function classifyIntent(text: string): ClassifyResult {
  const q = words(text);
  if (domains.size === 0 || q.size === 0) {
    return { status: "unknown", confidence: 0, alternatives: [], reason: "no domains registered or empty input" };
  }

  let bestDomain = { id: "", score: 0 };
  const ranked: { intent: string; score: number }[] = [];
  for (const domain of domains.values()) {
    const dScore = bestScore(q, domain.examples);
    if (dScore > bestDomain.score) bestDomain = { id: domain.id, score: dScore };
    for (const [intent, examples] of Object.entries(domain.intents)) {
      ranked.push({ intent, score: bestScore(q, examples) });
    }
  }
  ranked.sort((a, b) => b.score - a.score);

  const [top, runnerUp] = ranked;
  if (!top || top.score < UNKNOWN_FLOOR) {
    return {
      status: "unknown",
      domain: bestDomain.id ? bestDomain : undefined,
      confidence: top?.score ?? 0,
      alternatives: ranked.slice(1, 5),
      reason: "weak absolute confidence",
    };
  }

  const margin = top.score - (runnerUp?.score ?? 0);
  if (margin < MARGIN_MIN && top.score < MARGIN_EXEMPT_CEILING) {
    return {
      status: "ambiguous",
      domain: bestDomain.id ? bestDomain : undefined,
      confidence: top.score,
      alternatives: ranked.slice(1, 5),
      reason: "ranked margin overlap too narrow",
    };
  }

  return {
    status: "resolved",
    domain: bestDomain.id ? bestDomain : undefined,
    intent: top.intent,
    confidence: top.score,
    alternatives: ranked.slice(1, 5),
  };
}

// Built-in domain seeded from the same real Zimbabwe mobile-money phrase
// data shona-glossary.ts already ported from ZimVoice's ANCHORS table (used
// there for language-detection prompt grounding; reused here as this
// classifier's example anchors — one data source, two consumers).
registerDomain({
  id: "zim-mobile-money",
  examples: Object.values(ZIM_FINANCIAL_PHRASES).flat(),
  intents: ZIM_FINANCIAL_PHRASES,
});
