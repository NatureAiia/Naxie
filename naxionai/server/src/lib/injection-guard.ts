// Prompt-injection guard for fetched web text — innovation-scan.ts's
// searchFetchValidate() feeds both its targeted and broad-watch passes
// through this before the text ever reaches summarizeBatch()'s LLM prompt.
// source-validator.ts already gates on page CREDIBILITY (auth walls,
// captchas, thin content) but says nothing about a credible-looking page
// that also carries an instruction aimed at the model reading it — this
// closes that gap. Zero LLM calls: a fixed pattern list, same cost model as
// scanForSecurityRisks in security.ts.

const INJECTION_PATTERNS: RegExp[] = [
  /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+instructions?/gi,
  /(?:ignore|disregard)\s+(?:all\s+)?(?:the\s+)?(?:instructions?|rules?|prompts?)\s+(?:above|before\s+this)/gi,
  /you\s+are\s+now\s+(?:in\s+)?(?:an?\s+)?(?:admin|administrator|developer|debug|dan|jailbreak(?:ed)?|unrestricted|god)\s*(?:mode)?/gi,
  /(?:entering|activate|enable)\s+developer\s+mode/gi,
  /developer\s+mode\s+(?:enabled|activated|on)\b/gi,
  /system\s*note\s*:/gi,
  /system\s*prompt\s*:/gi,
  /new\s+instructions?\s*:/gi,
  /act\s+as\s+(?:if\s+you\s+(?:are|were)|an?)\s+(?:unrestricted|unfiltered|jailbroken)/gi,
  /reveal\s+(?:your\s+)?(?:system\s+prompt|hidden\s+instructions?)/gi,
  /print\s+(?:your\s+)?(?:system\s+prompt|initial\s+instructions?)/gi,
  /do\s+anything\s+now\b/gi,
  /override\s+(?:your\s+)?(?:previous|prior|safety)\s+instructions?/gi,
];

const MARKER = "[REDACTED:prompt-injection]";

// Strips/neutralizes obvious role-hijacking phrases from text about to enter
// an LLM prompt. Deliberately a pattern list, not a classifier — matching the
// zero-extra-token-cost shape of this file's neighbours.
export function sanitizeFetchedText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of INJECTION_PATTERNS) out = out.replace(re, MARKER);
  return out;
}
