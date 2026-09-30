// Did this run actually work?
//
// Ported from AI-Institute-Africa/neuroworks. `status: "succeeded"` has
// historically meant only "the code reached the end without throwing" — not
// that the run produced anything. Origin incident: a batch of daily jobs all
// recorded "succeeded" with a 221-character answer reading "_LLM reflection
// failed after retry (`fetch failed`)..._" — the synthesis failure was
// returned as PROSE, never as state, so nothing downstream (calendar, gates,
// success-rate stats) could tell a failed run from a good one.
//
// Two layers, and the order matters:
//   1. A STRUCTURED FLAG on the result is authoritative — a runner that knows
//      it failed says so, and this believes it.
//   2. A SENTINEL SCAN is the backstop, for a runner not yet taught to report
//      state. Narrow on purpose — these are OUR OWN emitted strings, never a
//      generic word like "failed" that a report ABOUT a failure would trip.

export type Outcome = "succeeded" | "degraded" | "failed";

/**
 * The give-up messages this codebase writes into an otherwise normal answer.
 * Add to this list when a runner grows a new "I could not do the job but
 * here is something" path. Each entry must be text WE emit.
 */
export const FAILURE_SENTINELS: readonly RegExp[] = [
  /LLM reflection failed after retry/i,
  /exceeded the \d+min synthesis cap/i,
  /No usable evidence this run/i,
];

/** Partial view of a runner result — anything with these shapes is accepted. */
export type RunResultish = {
  answer?: unknown;
  failed?: unknown;
  degraded?: unknown;
  error?: unknown;
} | null | undefined;

export type OutcomeVerdict = {
  outcome: Outcome;
  /** Set when the run did not fully succeed. Suitable for `job.error`. */
  reason?: string;
  /** False when the run did not produce what it exists to produce. */
  delivered: boolean;
};

/**
 * Grade a finished run. `degraded` exists because some runs half-work — a
 * report that wrote four of six sections is neither a success nor a
 * failure, and collapsing it into either loses the thing an operator needs
 * to know.
 */
export function runOutcome(result: RunResultish): OutcomeVerdict {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.failed === true) {
      return { outcome: "failed", reason: str(r.error) || "the run reported failure", delivered: false };
    }
    if (r.degraded === true) {
      return { outcome: "degraded", reason: str(r.error) || "the run reported partial output", delivered: false };
    }
  }

  const answer = str((result as any)?.answer);
  if (answer) {
    for (const re of FAILURE_SENTINELS) {
      const m = answer.match(re);
      if (m) return { outcome: "failed", reason: `the answer says the run gave up: "${m[0]}"`, delivered: false };
    }
  }

  return { outcome: "succeeded", delivered: true };
}

/** Convenience for the job-record call sites. */
export function outcomeToJobStatus(o: Outcome): "succeeded" | "failed" {
  // `degraded` has no job-status of its own — recorded as a success that did
  // not deliver, so a partial report stays readable while the delivery flag
  // keeps it out of the success count.
  return o === "failed" ? "failed" : "succeeded";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
