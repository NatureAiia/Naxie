// Jev (TypeSafe's "System One" model) — a non-generative, typed-judgment
// model. It doesn't write text; it answers narrow questions (a calibrated
// yes/no probability, a rubric position, or a pick-one-of-N choice) in
// ~100s of ms instead of a full generative LLM call. Used by quality.check
// (primitives.ts) as a faster alternative to its LLM-graded verdict.
//
// Degrades like every other optional integration in this codebase: no key,
// a network error, a timeout, or a malformed response all throw
// JevUnavailable — callers MUST catch it and fall back, never treat a Jev
// failure as fatal.

import { config } from "../config.js";

const REQUEST_TIMEOUT_MS = Number(process.env.NAXION_JEV_TIMEOUT_MS ?? "10000");

export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "choice"; instructions: string; options: string[] };

export type JevAnswer = {
  probability?: number;
  confidence?: number;
  category?: string;
};

export class JevUnavailable extends Error {
  constructor(reason: string) {
    super(`Jev unavailable: ${reason}`);
    this.name = "JevUnavailable";
  }
}

// state can be any JSON-serializable judgment context (the task/answer/
// sources quality.check wants graded, a ticket, whatever the caller needs
// Jev to reason about). questions is keyed by caller-chosen ids; the
// response is keyed the same way.
export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
): Promise<Record<string, JevAnswer>> {
  if (!config.jevEnabled) throw new JevUnavailable("TYPESAFE_API_KEY not set");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(config.jevBaseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.jevApiKey}`,
      },
      body: JSON.stringify({ model: config.jevModel, state, questions }),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    throw new JevUnavailable(`request failed: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new JevUnavailable(`HTTP ${r.status}: ${body.slice(0, 200)}`);
  }

  let json: any;
  try {
    json = await r.json();
  } catch (e: any) {
    throw new JevUnavailable(`bad response body: ${e?.message ?? e}`);
  }

  const out: Record<string, JevAnswer> = {};
  for (const id of Object.keys(questions)) {
    const a = json?.[id];
    if (!a || typeof a !== "object") throw new JevUnavailable(`no answer for question "${id}"`);
    out[id] = { probability: typeof a.probability === "number" ? a.probability : undefined,
      confidence: typeof a.confidence === "number" ? a.confidence : undefined,
      category: typeof a.category === "string" ? a.category : undefined };
  }
  return out;
}
