// Persona auto-router.
//
// When a chat task arrives with no active persona (or with the generic
// Naxie Agent generalist active), pick the best built-in persona for the
// task and use it for the run. The user can still override via explicit
// activation; this is the "no one specified — figure it out" path.
//
// Routing is heuristic but task-shape weighted: each persona has a regex
// catalog where "shape" patterns (verb + topic, "draft a runbook", "review
// these CVs") carry weight 2 and bare-keyword patterns ("SRE", "NDA",
// "wireframe") carry weight 1. A persona needs an effective score ≥ 2 to
// win — a single bare keyword like "explain MSA to me" no longer hijacks
// routing onto contracts-reviewer. Two corroborating signals (or one
// definitive shape match) are required. The fallback is Naxie Agent.
//
// Examples:
//   "Password reset for a new laptop" → it-support (Ivy)
//   "Reconcile the ledger for March" → accountant (Cole)
//   "Schedule a LinkedIn post about the launch" → social-media-manager (Sasha)
//   "Investigate the current state of vector DBs" → researcher (Researcher)
//   "Refactor the auth middleware" → software-engineer (Sam)

import { loadPersonas, type Persona } from "./personas.js";

// A pattern is either:
//   - a bare RegExp (legacy entries) — weighted at 1 (keyword signal)
//   - { re, weight } — explicit weight (use 2 for verb+topic shape matches)
// Effective score is the SUM of weights of all matching patterns. A
// persona needs ≥ 2 to win, so a single weight-1 keyword match alone is
// never enough — it must corroborate with a shape match or another keyword.
type WeightedPattern = { re: RegExp; weight?: number };
type PersonaPattern = {
  personaId: string;
  patterns: (RegExp | WeightedPattern)[];
};

function patternWeight(p: RegExp | WeightedPattern): number {
  if (p instanceof RegExp) return 1;
  return p.weight ?? 1;
}
function patternRegex(p: RegExp | WeightedPattern): RegExp {
  return p instanceof RegExp ? p : p.re;
}

// Catalog of routing patterns per persona. Tuned to match the 50
// employee-task surface + the existing persona roster. Patterns are
// case-insensitive, word-bounded where reasonable, and biased toward
// the most distinguishing vocabulary for each role.
// Pruned to the core 8 on 2026-09-21 alongside personas.ts's own prune (all
// built-ins had zero recorded activity in 30 days) — every entry for a
// now-deleted persona id was removed outright, since pickPersonaForTask can
// never route to an id that doesn't exist in the store any more.
const PERSONA_PATTERNS: PersonaPattern[] = [
  // Engineering
  { personaId: "software-engineer", patterns: [
    { re: /\bengineering (?:scope|design|trade[- ]?off)\b/i, weight: 2 },
    { re: /\bcode review\b/i, weight: 2 },
    { re: /\bAPI (?:design|spec)\b/i, weight: 2 },
    { re: /\b(?:implement|build|refactor)\s+(?:a\s+|the\s+)?\w+/i, weight: 2 },
    { re: /\bvector (?:DB|database)\s+(?:comparison|choice)\b/i, weight: 2 },
    { re: /\btech (?:choice|stack|decision)\b/i, weight: 2 },
  ] },
  { personaId: "accountant", patterns: [
    { re: /\b(?:reconcile|reconciliation)\b/i, weight: 2 },
    { re: /\b(?:accounts?\s+(?:payable|receivable)|AP\/AR)\b/i, weight: 2 },
    { re: /\b(?:draft|create|prepare)\s+(?:an?\s+)?invoice\b/i, weight: 2 },
    { re: /\b(?:month-?end|bookkeep|ledger|payroll\s+run|balance\s+sheet)\b/i, weight: 2 },
  ] },
  { personaId: "it-support", patterns: [
    { re: /\b(?:password|MFA)\s+reset\b/i, weight: 2 },
    { re: /\b(?:troubleshoot|fix-?it|help-?desk|IT support)\b/i, weight: 2 },
    { re: /\b(?:provision|deprovision|grant)\s+access\b/i, weight: 2 },
    { re: /\b(?:can'?t|cannot)\s+(?:log\s?in|sign\s?in|connect)\b/i, weight: 2 },
  ] },
  { personaId: "social-media-manager", patterns: [
    { re: /\b(?:post|publish|schedule|share)\b[^]{0,30}\b(?:tweet|thread|twitter|\bx\b|linkedin|facebook|instagram|tiktok|threads|social(?:\s*media)?)\b/i, weight: 2 },
    { re: /\bsocial[\s-]?media\b/i, weight: 2 },
    { re: /\bcontent calendar\b/i, weight: 2 },
    { re: /\b(?:mentions|comments|engagement|followers)\b[^]{0,20}\b(?:social|twitter|linkedin|instagram|facebook)\b/i, weight: 2 },
    /\bhashtags?\b/i,
  ] },
  // Researcher — investigative shape (NOT the same as research.deep
  // primitive; this is when a HUMAN asks for multi-perspective work)
  { personaId: "researcher", patterns: [
    { re: /\bmulti[\s-]?perspective\b/i, weight: 2 },
    { re: /\bfact[\s-]?check\b/i, weight: 2 },
    /\btriangulat/i,
    { re: /\binvestigate (?:the|this|how|whether)\b/i, weight: 2 },
    { re: /\bsource (?:triangulation|cross[- ]?check)\b/i, weight: 2 },
  ] },
];

// Pick the best persona for a given task text. Returns:
//   { personaId, score, matchedPatterns } — when a clear winner emerges
//   null — when nothing matched above the confidence floor (caller falls
//         through to Naxie Agent)
//
// Confidence floor: at least one pattern must match. Ties (same score)
// resolved by lower-indexed entry in PERSONA_PATTERNS (rough proxy for
// "more central role"). When the highest scorer ties with multiple
// others, return null — auto-routing only fires when confidence is high.
// Confidence floor for an auto-route. A single bare keyword match
// (weight=1) is never enough; you need either a shape match (weight=2)
// or two corroborating keyword signals. Set higher to be more
// conservative; the unit tests are calibrated to 2.
const CONFIDENCE_FLOOR = 2;

export function pickPersonaForTask(text: string): { personaId: string; score: number; matched: string[] } | null {
  if (!text || text.length < 8) return null;
  const cap = text.slice(0, 4000);
  let best: { personaId: string; score: number; matched: string[] } | null = null;
  const tied: string[] = [];
  for (const entry of PERSONA_PATTERNS) {
    const matches: string[] = [];
    let score = 0;
    for (const pat of entry.patterns) {
      const re = patternRegex(pat);
      const m = cap.match(re);
      if (m) {
        matches.push(m[0].slice(0, 32));
        score += patternWeight(pat);
      }
    }
    if (matches.length === 0) continue;
    if (!best || score > best.score) {
      best = { personaId: entry.personaId, score, matched: matches };
      tied.length = 0;
    } else if (score === best.score) {
      tied.push(entry.personaId);
    }
  }
  // Below the confidence floor, fall through to Naxie Agent — a single
  // bare-keyword hit ("explain MSA to me", "what is autoscaling")
  // shouldn't drag the user onto a specialist persona by accident.
  if (!best || best.score < CONFIDENCE_FLOOR) return null;
  // If multiple personas tied at the top, we don't have a clear winner —
  // fall through to Naxie Agent rather than picking one over the others.
  if (tied.length > 0) return null;
  return best;
}

// Pick + return the actual Persona object, or null when no auto-route.
// Used by chat.ts when no persona is active.
export function autoRoutePersona(text: string): { persona: Persona; score: number; matched: string[] } | null {
  const pick = pickPersonaForTask(text);
  if (!pick) return null;
  try {
    const store = loadPersonas();
    const persona = store.personas.find(p => p.id === pick.personaId);
    if (!persona) return null;
    return { persona, score: pick.score, matched: pick.matched };
  } catch { return null; }
}
