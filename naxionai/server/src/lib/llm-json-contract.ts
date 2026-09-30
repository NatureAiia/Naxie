// Strict LLM JSON-output contract checking — ported by PATTERN from
// ZimVoice's Groq/Gemini/Ollama client trio (integrations/*_client.py),
// which each hand-rolled the same "does the response actually match the
// promised shape" check, plus gemma_engine.py's `_extract_json` 3-tier
// recovery. Naxie already has a mature multi-backend routing/retry/fallback
// pipeline (lib/llm.ts's chooseBackendAndModel/llmGenerateWithMeta) — that
// part of ZimVoice's design is NOT re-built here. What's missing is the
// narrower piece: given raw LLM text that is SUPPOSED to be one JSON object
// matching a declared shape, recover it if reasonably possible and validate
// it actually matches — degrading to a caller-supplied default rather than
// throwing, exactly like gemma_engine's "malformed output becomes UNKNOWN,
// not a crash" rule.

export type FieldType = "string" | "number" | "boolean" | "object" | "array";

export type ContractSchema = Record<string, FieldType>;

export type ContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string; raw: string };

function typeOf(v: unknown): FieldType | "undefined" | "null" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t;
  return "undefined";
}

/**
 * Recover a single JSON object from raw LLM text, trying progressively
 * looser strategies — mirrors gemma_engine.py's `_extract_json`:
 *   1. the whole string is valid JSON as-is
 *   2. the first brace-balanced `{...}` run in the string
 *   3. a fenced ```json ... ``` (or bare ``` ... ```) code block
 * Returns `undefined` if none of these parse, rather than throwing.
 */
export function recoverJsonObject(raw: string): Record<string, unknown> | undefined {
  const tryParse = (s: string): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };

  const direct = tryParse(raw.trim());
  if (direct) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const v = tryParse(fenced[1].trim());
    if (v) return v;
  }

  // Brace-balanced scan for the first complete `{...}` run — handles a
  // model that prefixes/suffixes commentary around the JSON without fences.
  const start = raw.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === "{") depth++;
      else if (raw[i] === "}") {
        depth--;
        if (depth === 0) {
          const v = tryParse(raw.slice(start, i + 1));
          if (v) return v;
          break;
        }
      }
    }
  }
  return undefined;
}

/**
 * Validate that `obj` has every key in `schema` with the declared type.
 * Extra keys are ignored (forward-compatible); a missing key or wrong type
 * fails the whole contract — same all-or-nothing rule as ZimVoice's clients.
 */
export function checkContract(obj: Record<string, unknown>, schema: ContractSchema): string[] {
  const violations: string[] = [];
  for (const [key, expected] of Object.entries(schema)) {
    if (!(key in obj)) {
      violations.push(`missing required field "${key}"`);
      continue;
    }
    const actual = typeOf(obj[key]);
    if (actual !== expected) {
      violations.push(`field "${key}" expected ${expected}, got ${actual}`);
    }
  }
  return violations;
}

/**
 * Recover + validate raw LLM text against `schema` in one call. On any
 * failure (unparseable, or parseable but contract-violating) returns
 * `{ok:false, reason, raw}` instead of throwing — callers decide whether
 * that means "retry," "next provider," or "degrade to a default," same as
 * ZimVoice's per-client exceptions get turned into "try the next provider"
 * one layer up (already Naxie's job, in llm.ts's fallback chain, not this
 * module's).
 */
export function parseLlmContract<T = Record<string, unknown>>(
  raw: string,
  schema: ContractSchema,
): ContractResult<T> {
  const obj = recoverJsonObject(raw);
  if (!obj) return { ok: false, reason: "no parseable JSON object found in response", raw };
  const violations = checkContract(obj, schema);
  if (violations.length > 0) return { ok: false, reason: violations.join("; "), raw };
  return { ok: true, value: obj as T };
}
