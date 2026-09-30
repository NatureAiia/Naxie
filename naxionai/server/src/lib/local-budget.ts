// How long a LOCAL generation is actually allowed to take. Ported from
// AI-Institute-Africa/neuroworks, the direct companion to llm-lane.ts.
//
// THE MISTAKE THIS FIXES. llm-lane.ts's own header states the rule: "CALLER
// TIMEOUTS NOW INCLUDE LANE WAIT [...] size a caller-side budget for a
// QUEUED call, not an idle box." Upstream measured this going wrong twice:
// a 75s-per-section timer expired on three consecutive sections while a
// harness held every lane slot; then a run with a bigger number (six
// sections, 300s budget) did the same thing at a larger scale — all six
// timed out, and the lane reported an average wait of 219 of the 300
// seconds the budget allowed.
//
// So the budget stops being a number somebody picked and becomes a function
// of three things that can actually be measured: how many tokens were
// asked for, how many of our own calls are in flight together, and how
// long the queue is right now.
//
// The throughput table below is copied from upstream's own measurements on
// their box (qwen2.5:3b, CPU-only). It is a SHAPE (how per-call throughput
// falls under contention), not a promise about any particular machine —
// every constant is env-overridable so this box's own numbers replace it.

/**
 * Aggregate decode throughput, measured upstream (qwen2.5:3b, CPU, 6 cores),
 * same prompt N-up. What a CALLER experiences is aggregate/n — the column
 * that matters and the one easiest to forget:
 *     n=1  6.41   n=2  5.15   n=4  4.16   n=6  2.94 tok/s per call
 */
const MEASURED_AGGREGATE_TPS: ReadonlyArray<readonly [n: number, tps: number]> = [
  [1, 6.41],
  [2, 10.30],
  [4, 16.62],
  [6, 17.65],
];

/** Per-call decode rate at n=1, overridable per box. */
const MEASURED_DECODE_TPS_N1 = Math.max(
  0.1,
  Number(process.env.NAXION_LOCAL_DECODE_TPS ?? "3.19") || 3.19,
);

/** Prompt-eval rate by prompt size. Slower on short prompts: fixed overhead. */
const MEASURED_PROMPT_EVAL_TPS: ReadonlyArray<readonly [tokens: number, tps: number]> = [
  [622, 15.6],
  [2334, 33.0],
];

/**
 * Time to process the prompt before the first token — a function of prompt
 * length, not a constant. A multi-thousand-token prompt can spend more time
 * in prompt-eval than the entire generation that follows it.
 */
export function promptEvalMs(promptChars: number): number {
  // NaN has to be caught here, not clamped by Math.max — Math.max(0, NaN)
  // is NaN, and a NaN budget makes setTimeout fire IMMEDIATELY, turning a
  // generous ceiling into an instant timeout.
  const chars = Number.isFinite(promptChars) ? Math.max(0, promptChars) : 0;
  const tokens = Math.max(1, Math.ceil(chars / 4));
  const pts = MEASURED_PROMPT_EVAL_TPS;
  let tps: number;
  if (tokens <= pts[0][0]) tps = pts[0][1];
  else if (tokens >= pts[pts.length - 1][0]) tps = pts[pts.length - 1][1];
  else {
    const lo = pts[0], hi = pts[1];
    tps = lo[1] + (hi[1] - lo[1]) * ((tokens - lo[0]) / (hi[0] - lo[0]));
  }
  return (tokens / tps) * 1000;
}

/** What this box can actually be asked for, on local, per section/call. Overridable per box. */
export const LOCAL_MAX_OUTPUT_TOKENS = Math.max(
  120,
  Number(process.env.NAXION_LOCAL_MAX_OUTPUT_TOKENS ?? "500") || 500,
);
export const LOCAL_EVIDENCE_CHARS = Math.max(
  1_000,
  Number(process.env.NAXION_LOCAL_EVIDENCE_CHARS ?? "6000") || 6_000,
);

/**
 * A SYNTHESIS section needs more room than a research one — it has to cover
 * everything that reported and reconcile it, a strictly bigger ask. The
 * budget already scales with maxTokens, so the extra time is derived rather
 * than guessed.
 */
export const LOCAL_SYNTH_MAX_OUTPUT_TOKENS = Math.max(
  LOCAL_MAX_OUTPUT_TOKENS,
  Number(process.env.NAXION_LOCAL_SYNTH_MAX_OUTPUT_TOKENS ?? "900") || 900,
);

/** Per-call decode rate at N in flight, interpolated between measured points. */
export function perCallTps(inFlight: number): number {
  const n = Math.max(1, Math.floor(inFlight) || 1);
  const pts = MEASURED_AGGREGATE_TPS;
  let agg: number;
  if (n <= pts[0][0]) agg = pts[0][1];
  else if (n >= pts[pts.length - 1][0]) {
    // Past the largest measured point throughput is flat — it stops paying
    // at OLLAMA_NUM_PARALLEL and the surplus queues one layer deeper.
    // Holding the aggregate constant means the PER-CALL rate keeps falling,
    // which is what actually happens.
    agg = pts[pts.length - 1][1];
  } else {
    let lo = pts[0], hi = pts[pts.length - 1];
    for (let i = 0; i < pts.length - 1; i++) {
      if (n >= pts[i][0] && n <= pts[i + 1][0]) { lo = pts[i]; hi = pts[i + 1]; break; }
    }
    const span = hi[0] - lo[0];
    agg = span === 0 ? lo[1] : lo[1] + (hi[1] - lo[1]) * ((n - lo[0]) / span);
  }
  // The TABLE supplies the SHAPE of how per-call throughput falls with
  // contention; the measured n=1 rate supplies the SCALE — they came from
  // different configurations, so mixing them by ratio is the honest
  // combination.
  const shape = (agg / n) / (MEASURED_AGGREGATE_TPS[0][1] / MEASURED_AGGREGATE_TPS[0][0]);
  return Math.max(0.1, MEASURED_DECODE_TPS_N1 * shape);
}

/** Time to the first token — prompt processing, not generation. Overridable per box. */
export const LOCAL_TTFT_MS = Math.max(
  10_000,
  Number(process.env.NAXION_LOCAL_TTFT_MS ?? "130000") || 130_000,
);

/** Never go below this, however small the ask. */
export const LOCAL_BUDGET_FLOOR_MS = Math.max(
  60_000,
  Number(process.env.NAXION_LOCAL_BUDGET_FLOOR_MS ?? "240000") || 240_000,
);

/**
 * A cloud section is a different animal — well under 30s in the common
 * case. The derivation below is a LOCAL correction, not a general theory of
 * timeouts, so cloud keeps a flat budget.
 */
export const CLOUD_BUDGET_MS = Math.max(
  30_000,
  Number(process.env.NAXION_CLOUD_SECTION_MS ?? "300000") || 300_000,
);

const SAFETY = Math.max(1, Number(process.env.NAXION_LOCAL_BUDGET_SAFETY ?? "1.5") || 1.5);

export type BudgetInput = {
  /** Tokens the caller asked the model to generate. */
  maxTokens: number;
  /** How many of OUR calls will be in flight together. 1 when writing serially. */
  inFlight: number;
  /** Observed mean lane wait, from llmLaneStatus().avgWaitMs. Optional. */
  observedWaitMs?: number;
  /** True when the call will go to a cloud provider. */
  cloud?: boolean;
  /**
   * Size of the assembled prompt, when the caller knows it. Prompt
   * processing is the larger term for anything over a couple of thousand
   * tokens on a local box, and was historically modelled as a constant.
   */
  promptChars?: number;
  /**
   * Can a cloud failure fall back to a LOCAL model? Default TRUE — in this
   * codebase every cloud path can eventually land on Ollama. Pass `false`
   * only for a call that genuinely has nowhere else to go.
   */
  localFallback?: boolean;
};

/**
 * The budget, and the reasoning behind it, so a log line can explain
 * itself.
 *
 * `observedWaitMs` is added rather than ignored because caller timeouts
 * include lane wait BY DESIGN — a budget that models only the model is the
 * same mistake in smaller clothes.
 *
 * A CLOUD SECTION IS BUDGETED FOR THE PATH IT MIGHT ACTUALLY TAKE: when
 * every registered cloud provider is out of credits/quota, llm.ts falls
 * back to local Ollama carrying whatever budget the caller set for the
 * cloud call — which a local call cannot meet if that budget is a flat
 * "well under 30s" figure. So when a local fallback exists, the budget is
 * the MAX of the two, never the cloud figure alone. A budget is a ceiling,
 * not a duration: a cloud section that finishes in 25s is not slowed down
 * by a generous ceiling.
 */
export function localSynthBudget(o: BudgetInput): { ms: number; why: string } {
  if (!o.cloud) return deriveLocalBudget(o);

  const cloudOnly = { ms: CLOUD_BUDGET_MS, why: `cloud section, flat ${Math.round(CLOUD_BUDGET_MS / 1000)}s` };
  if (o.localFallback === false) return cloudOnly;

  const local = deriveLocalBudget(o);
  if (local.ms <= CLOUD_BUDGET_MS) return cloudOnly;
  return {
    ms: local.ms,
    why: `cloud section, but a cloud failure lands on local — max(${Math.round(CLOUD_BUDGET_MS / 1000)}s cloud,`
      + ` ${Math.round(local.ms / 1000)}s local): ${local.why}`,
  };
}

function deriveLocalBudget(o: BudgetInput): { ms: number; why: string } {
  const tokens = Math.max(1, Math.floor(o.maxTokens) || 1);
  const tps = perCallTps(o.inFlight);
  const genMs = (tokens / tps) * 1000;
  const wait = Math.max(0, Math.floor(o.observedWaitMs ?? 0));
  // PROMPT PROCESSING IS A FUNCTION OF THE PROMPT, not a constant. When the
  // caller says how big its prompt is, use the measured curve; otherwise
  // fall back to the old flat allowance, which is what a caller that
  // cannot know its prompt size still needs.
  const ttft = o.promptChars ? promptEvalMs(o.promptChars) : LOCAL_TTFT_MS;
  const raw = (ttft + genMs) * SAFETY + wait;
  const ms = Math.max(LOCAL_BUDGET_FLOOR_MS, Math.round(raw));
  return {
    ms,
    why: `${tokens} tok at ${tps.toFixed(2)} tok/s (${o.inFlight} in flight) = ${Math.round(genMs / 1000)}s`
      + ` + ${Math.round(ttft / 1000)}s prompt eval`
      + (o.promptChars ? ` on ${o.promptChars} chars` : " (flat allowance — prompt size unknown)")
      + `, x${SAFETY} safety`
      + (wait ? ` + ${Math.round(wait / 1000)}s observed queue wait` : "")
      + ` -> ${Math.round(ms / 1000)}s`,
  };
}

/**
 * How many sections to write at once. ONE when the cloud is off — not a
 * throttle for its own sake: at n in flight each call decodes far slower
 * than solo (see MEASURED_AGGREGATE_TPS above), so parallel writing makes
 * every section slower and, at the extreme measured upstream, finishes
 * none of them. Sequential writing is the box being used properly, not
 * conservatively.
 *
 * With the cloud on, sections really can be written together, bounded by
 * the lane so the local fallback path cannot be oversubscribed either.
 *
 * `cloud` MUST mean "the cloud can serve a token right now", not "a cloud
 * key exists" — concurrency cannot be corrected after the fact the way the
 * budget can: once N sections are dispatched together and every cloud call
 * fails on credits/quota, N local generations are already contending.
 */
export function writeConcurrency(o: { cloud: boolean; agents: number; laneCap: number }): number {
  if (!o.cloud) return 1;
  return Math.max(1, Math.min(Math.max(1, o.agents), Math.max(1, o.laneCap)));
}
