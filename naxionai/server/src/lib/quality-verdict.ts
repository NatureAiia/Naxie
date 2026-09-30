// Shared pass/score computation for quality.check (primitives.ts) — used by
// BOTH its graders (the LLM-authored JSON path and the faster Jev-typed-
// judgment path) so the two can never silently drift into different
// pass/fail semantics for the same axis scores. Pure/disk-free — unit-
// testable without a network call. Mirrors the per-deliverable-class rubric
// quality.check has always used:
//   • research (citationApplies)      — factuality + citations + persona_fit all gate
//   • ungrounded direct conversational — persona_fit is the bar; factuality only
//                                        catches egregious hallucination (>=0.85)
//   • creative/procedural/code         — persona_fit-led, factuality relaxed
// prompt_alignment gates every class — an answer that didn't do what was
// asked fails regardless of how well-cited or on-tone it is.

export type QualityAxes = {
  factuality_risk: number;
  citation_coverage: number;
  persona_fit: number;
  prompt_alignment: number;
};

export type QualityClassOpts = {
  citationApplies: boolean;
  forceUngrounded: boolean;
};

export type QualityVerdict = {
  pass: boolean;
  score: number; // rounded to 2 decimals, same as the existing LLM path
};

export function computeQualityVerdict(axes: QualityAxes, opts: QualityClassOpts): QualityVerdict {
  const { factuality_risk: factualityRisk, citation_coverage: citationCoverage, persona_fit: personaFit, prompt_alignment: promptAlignment } = axes;

  const score = opts.citationApplies
    ? (1 - factualityRisk) * 0.35 + citationCoverage * 0.25 + personaFit * 0.2 + promptAlignment * 0.2
    : opts.forceUngrounded
      ? (1 - factualityRisk) * 0.2 + personaFit * 0.4 + promptAlignment * 0.4
      : (1 - factualityRisk) * 0.3 + citationCoverage * 0.15 + personaFit * 0.3 + promptAlignment * 0.25;

  const pass = promptAlignment >= 0.5 && (opts.citationApplies
    ? factualityRisk < 0.4 && citationCoverage > 0.4 && personaFit > 0.5
    : opts.forceUngrounded
      ? personaFit > 0.5 && factualityRisk < 0.85
      : factualityRisk < 0.5 && personaFit > 0.5);

  return { pass, score: Math.round(score * 100) / 100 };
}

// Deterministic issue strings — used by the Jev path, which returns typed
// judgments only (no free-text rationale to surface). The LLM path keeps
// its own richer, model-authored `issues` array; this is the fallback
// explanation shape when there isn't one.
export function deterministicIssues(axes: QualityAxes, opts: QualityClassOpts): string[] {
  const issues: string[] = [];
  if (axes.prompt_alignment < 0.5) {
    issues.push(`prompt_alignment ${axes.prompt_alignment.toFixed(2)} — the answer did not fully address what was asked`);
  }
  if (opts.citationApplies) {
    if (axes.factuality_risk >= 0.4) issues.push(`factuality_risk high (${axes.factuality_risk.toFixed(2)})`);
    if (axes.citation_coverage <= 0.4) issues.push(`citation_coverage low (${axes.citation_coverage.toFixed(2)})`);
    if (axes.persona_fit <= 0.5) issues.push(`persona_fit low (${axes.persona_fit.toFixed(2)})`);
  } else if (opts.forceUngrounded) {
    if (axes.persona_fit <= 0.5) issues.push(`persona_fit low (${axes.persona_fit.toFixed(2)})`);
    if (axes.factuality_risk >= 0.85) issues.push(`factuality_risk very high (${axes.factuality_risk.toFixed(2)})`);
  } else {
    if (axes.factuality_risk >= 0.5) issues.push(`factuality_risk high (${axes.factuality_risk.toFixed(2)})`);
    if (axes.persona_fit <= 0.5) issues.push(`persona_fit low (${axes.persona_fit.toFixed(2)})`);
  }
  return issues;
}
