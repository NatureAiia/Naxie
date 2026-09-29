// Composite LLM-scoring — ask the model for structured sub-scores, then
// combine them with a fixed weighted formula into one ranking number.
// Ported as a pattern (not code) from omnis-signal's ai_research_intelligence
// EnricherAgent.enrich(): the model is good at judging individual dimensions
// (how urgent, how impactful) but a fixed formula — not the model itself —
// should own the tradeoff between them, so the ranking is stable and
// auditable rather than drifting with model phrasing.
//
// First application: org-tasks.ts's backlog. OrgTaskPriority (low/normal/
// high/urgent/crown) is the operator's own manual tier; this produces a
// SEPARATE, on-demand 0-100 priorityScore + the sub-scores behind it, so a
// backlog can be sorted/triaged before a human has manually set every tier.
// Deliberately not automatic (no hook on createOrgTask) — an LLM call per
// task would be a silent, uncapped cost; the operator asks for a score
// explicitly (routes/org-tasks.ts's POST /:id/score).

import { llmGenerateWithMeta } from "./llm.js";

export type PriorityDimension = "urgency" | "impact" | "effort" | "risk";

// Fixed weights — NOT model-chosen. effort's raw sub-score is "how much
// effort this looks like" (higher = more effort), so it's inverted (10 - x)
// before weighting: more effort should pull priority DOWN, same direction
// as every other weight being positive.
const WEIGHTS: Record<PriorityDimension, number> = {
  urgency: 0.35,
  impact: 0.35,
  effort: 0.15, // inverted at combine time
  risk: 0.15,   // risk of NOT doing it — higher risk pulls priority UP
};

export type PriorityScoreResult = {
  subScores: Record<PriorityDimension, number>; // each 0-10, as the model returned them
  composite: number; // 0-100
  rationale: string;
};

const DIMENSIONS: PriorityDimension[] = ["urgency", "impact", "effort", "risk"];

function clamp0to10(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(10, v));
}

// Tolerant JSON extraction — same shape of parser as weekly-improvement.ts's
// parseReview: models wrap JSON in fences or add prose around it.
function extractJsonObject(text: string): Record<string, unknown> | null {
  let body = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fence) body = fence[1].trim();
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const raw = JSON.parse(body.slice(first, last + 1));
    return raw && typeof raw === "object" ? raw : null;
  } catch { return null; }
}

function combine(subScores: Record<PriorityDimension, number>): number {
  const effortInverted = 10 - subScores.effort;
  const weighted =
    subScores.urgency * WEIGHTS.urgency +
    subScores.impact * WEIGHTS.impact +
    effortInverted * WEIGHTS.effort +
    subScores.risk * WEIGHTS.risk;
  // weighted is out of 10 (weights sum to 1) — rescale to 0-100.
  return Math.round(weighted * 10 * 10) / 10;
}

export type PriorityScoreInput = { title: string; detail?: string; context?: string };

/**
 * Asks the model for four 0-10 sub-scores (urgency, impact, effort, risk),
 * then combines them via the fixed weighted formula above. Throws only on a
 * genuinely unusable model response (missing/malformed JSON) — callers
 * should treat that as "scoring unavailable right now", not a hard failure
 * of whatever they were scoring.
 */
export async function scorePriority(input: PriorityScoreInput): Promise<PriorityScoreResult> {
  const system = [
    "You score a single work item on four independent 0-10 dimensions for a priority ranking.",
    "Respond with ONLY a JSON object, no prose, no markdown fences:",
    `{"urgency": <0-10>, "impact": <0-10>, "effort": <0-10>, "risk": <0-10>, "rationale": "<one sentence>"}`,
    "- urgency: how time-sensitive this is (10 = must happen now, 0 = no deadline pressure).",
    "- impact: how much this matters if done well (10 = high-value outcome, 0 = negligible).",
    "- effort: how much work this looks like (10 = very large effort, 0 = trivial). Higher is MORE effort, not less.",
    "- risk: the cost of NOT doing this (10 = leaving it undone is costly/risky, 0 = safe to leave undone indefinitely).",
    "Score independently — do not let one dimension's value influence another.",
  ].join("\n");
  const prompt = [
    `Title: ${input.title}`,
    input.detail ? `Detail: ${input.detail}` : "",
    input.context ? `Context: ${input.context}` : "",
  ].filter(Boolean).join("\n");

  const { text } = await llmGenerateWithMeta(prompt, system, {
    profile: "extraction",
    temperature: 0,
    maxTokens: 300,
  });

  const parsed = extractJsonObject(text);
  if (!parsed) throw new Error("priority scoring: model response contained no parseable JSON");

  const subScores = DIMENSIONS.reduce((acc, d) => {
    acc[d] = clamp0to10(parsed[d]);
    return acc;
  }, {} as Record<PriorityDimension, number>);

  return {
    subScores,
    composite: combine(subScores),
    rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 300) : "",
  };
}
