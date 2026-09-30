// Circuit breaker for the LLM-backed review steps (quality.check,
// peer.review). Ported from AI-Institute-Africa/neuroworks.
//
// THE PROBLEM, measured upstream over 150 recent jobs on one machine:
//
//   quality.check   1,991s across 55 runs — but p50 was 3.5s and FIFTEEN runs
//                   hit the 120s cap exactly. ~1,800s of the total was spent
//                   timing out.
//   peer.review     1,417s across 30 runs — 14 of them ended
//                   "wall-time cap (90s) exceeded — kept the existing draft".
//                   ~1,260s spent producing nothing.
//
// About 51 minutes of that window went on reviews that were discarded. Both
// steps are non-essential polish: on timeout the caller keeps the existing
// draft and carries on. So the failure mode is not "review was wrong", it is
// "we waited two minutes to learn the reviewer is too slow right now" — and
// then did it again on the very next task.
//
// The slowness is bursty, not permanent: it tracks whatever else is loading
// the machine (a big local model, memory pressure, a disk that is nearly
// full). p50 of 3.5s says quality.check is genuinely fast when the box is
// healthy.
//
// So: after a few consecutive timeouts, skip the step for a cooldown and let
// the task finish. Any success closes the circuit immediately. The result is
// the same draft the caller would have kept anyway, minus the two-minute wait.

export type BreakerName = "quality.check" | "peer.review";

type State = { consecutiveTimeouts: number; openedAt: number };

const state = new Map<BreakerName, State>();

// Read per call rather than at module load: an operator can retune these
// without a restart, and tests can exercise the cooldown without a fake clock.
//
// Three strikes: one slow run is noise, three in a row is a loaded machine.
const tripAfter = () => Number(process.env.NAXION_REVIEW_BREAKER_TRIP ?? "3");
// Long enough to ride out a burst, short enough that a recovered machine gets
// its reviews back within a few tasks.
const cooldownMs = () => Number(process.env.NAXION_REVIEW_BREAKER_COOLDOWN_MS ?? String(10 * 60_000));

function get(name: BreakerName): State {
  let s = state.get(name);
  if (!s) { s = { consecutiveTimeouts: 0, openedAt: 0 }; state.set(name, s); }
  return s;
}

/**
 * Should this review be skipped right now?
 *
 * Returns a reason string when the circuit is open (so the caller can log
 * something honest), or null when the step should run.
 */
export function reviewSkipReason(name: BreakerName): string | null {
  const s = get(name);
  if (s.openedAt === 0) return null;
  const elapsed = Date.now() - s.openedAt;
  if (elapsed >= cooldownMs()) {
    // Cooldown served — half-open. Let the next call through; if it times
    // out again the circuit re-opens immediately (consecutiveTimeouts is
    // untouched until we see the outcome).
    s.openedAt = 0;
    return null;
  }
  const mins = Math.max(1, Math.round((cooldownMs() - elapsed) / 60_000));
  return `${name} skipped — it timed out ${s.consecutiveTimeouts}x in a row, so it is being rested for ~${mins} more min while this machine is slow. The draft is unchanged.`;
}

/** Record that the step finished in time. Closes the circuit. */
export function noteReviewSuccess(name: BreakerName): void {
  const s = get(name);
  s.consecutiveTimeouts = 0;
  s.openedAt = 0;
}

/** Record a wall-time timeout. Trips the circuit once they stack up. */
export function noteReviewTimeout(name: BreakerName): void {
  const s = get(name);
  s.consecutiveTimeouts += 1;
  if (s.consecutiveTimeouts >= tripAfter()) s.openedAt = Date.now();
}

/** For the status page / tests. */
export function reviewBreakerState(): Record<string, { consecutiveTimeouts: number; open: boolean; msRemaining: number }> {
  const out: Record<string, { consecutiveTimeouts: number; open: boolean; msRemaining: number }> = {};
  for (const [name, s] of state) {
    const remaining = s.openedAt === 0 ? 0 : Math.max(0, cooldownMs() - (Date.now() - s.openedAt));
    out[name] = { consecutiveTimeouts: s.consecutiveTimeouts, open: remaining > 0, msRemaining: remaining };
  }
  return out;
}

/** Test hook. */
export function resetReviewBreakers(): void { state.clear(); }
