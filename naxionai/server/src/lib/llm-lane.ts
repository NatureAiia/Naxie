// One global lane for local inference. Ported from AI-Institute-Africa/
// neuroworks.
//
// THE BUG THIS FIXES. Concurrency was bounded in several unrelated places and
// none of them was global (a job cap, a per-run sub-agent budget, a worker
// count) — none shared with the others. At typical settings that could aim
// well more requests at Ollama than OLLAMA_NUM_PARALLEL actually serves. The
// surplus does not run faster; it queues INSIDE Ollama, holding open HTTP
// streams and burning the caller's own first-token timer while it waits.
// Raising a job cap just multiplies the oversubscription.
//
// MEASURED upstream (qwen2.5:3b, CPU-only, 6 cores), same prompt N-up,
// aggregate decode throughput:
//     n=1   6.41 tok/s   1.00x
//     n=2  10.30 tok/s   1.61x
//     n=4  16.62 tok/s   2.59x     <- OLLAMA_NUM_PARALLEL
//     n=6  17.65 tok/s   2.75x     <- +6% for +50% concurrency
// Parallelism is genuinely worth having up to OLLAMA_NUM_PARALLEL; past that,
// requests queue one layer deeper than the caller can see.
//
// Bounding the lane HERE, globally, is what makes a high job/worker cap safe:
// the one contended resource gets a fair FIFO queue, and every other lane
// (vault, web, github, fs) stays free to fan out as wide as it likes, because
// none of it touches Ollama.
//
// Deadlock safety: this wraps exactly one HTTP request to /api/generate, and
// a request never nests another inside itself, so a slot holder can never
// wait on a slot. Do not move this gate up to the tool or step level, where a
// step that calls a model while awaiting another such step WOULD deadlock.
//
// CALLER TIMEOUTS NOW INCLUDE LANE WAIT. A caller that arms its own
// AbortController before calling into the local model is timing the queue as
// well as the model — size a caller-side budget for a QUEUED call, not an
// idle box, or pass the signal through so the wait is cancellable.

/** Concurrent local generations allowed. Must track Ollama's own limit. */
function laneSize(): number {
  const explicit = Number(process.env.NAXION_LOCAL_LLM_LANE ?? "");
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  // Default to what Ollama will actually serve in parallel. Anything above it
  // is queueing dressed up as concurrency; anything below it leaves the box
  // idle. Ollama's own default is 1 when unset, but 4 is its usual
  // auto-selection with memory to spare — conservative default so an unset
  // env does not serialise a box that was measured to do 2.59x.
  const fromOllama = Number(process.env.OLLAMA_NUM_PARALLEL ?? "");
  if (Number.isFinite(fromOllama) && fromOllama > 0) return Math.floor(fromOllama);
  return 4;
}

const CAP = laneSize();

type Waiter = { resolve: () => void; reject: (e: Error) => void; queuedAt: number; signal?: AbortSignal; onAbort?: () => void };

let active = 0;
const queue: Waiter[] = [];

// Observability. Without this the lane is invisible and the next person to
// tune concurrency is back to guessing, which is how there ended up being
// three uncoordinated caps in the first place.
const stats = {
  cap: CAP,
  admitted: 0,
  /** Calls that had to wait for a slot at all. */
  queued: 0,
  /** Longest a call has ever sat waiting, ms. The number that says "cap is too low". */
  maxWaitMs: 0,
  totalWaitMs: 0,
  /** Deepest the queue has ever been. */
  maxDepth: 0,
};

export function llmLaneStatus() {
  return {
    ...stats,
    active,
    waiting: queue.length,
    avgWaitMs: stats.queued > 0 ? Math.round(stats.totalWaitMs / stats.queued) : 0,
  };
}

function release(): void {
  const next = queue.shift();
  if (next) {
    // Hand the slot straight over — `active` stays at the cap, so there is
    // no window where a third party can steal it and no double-count.
    const waited = Date.now() - next.queuedAt;
    stats.totalWaitMs += waited;
    if (waited > stats.maxWaitMs) stats.maxWaitMs = waited;
    if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
    next.resolve();
  } else {
    active = Math.max(0, active - 1);
  }
}

/**
 * Run `fn` holding one local-inference slot.
 *
 * `signal` is honoured WHILE QUEUED: a caller that gives up waiting leaves
 * the queue instead of being admitted later to do work nobody wants. A
 * caller that has already started keeps its slot until `fn` settles.
 */
export async function withLocalLlmSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error("aborted before acquiring local LLM slot");
  stats.admitted += 1;

  if (active < CAP) {
    active += 1;
  } else {
    stats.queued += 1;
    if (queue.length + 1 > stats.maxDepth) stats.maxDepth = queue.length + 1;
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = { resolve, reject, queuedAt: Date.now(), signal };
      if (signal) {
        w.onAbort = () => {
          const i = queue.indexOf(w);
          // Only bail if still QUEUED. If release() already handed us the
          // slot, the resolve has fired and dropping out now would leak it.
          if (i >= 0) {
            queue.splice(i, 1);
            signal.removeEventListener("abort", w.onAbort!);
            reject(new Error("aborted while waiting for a local LLM slot"));
          }
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      queue.push(w);
      if (signal?.aborted) w.onAbort?.();
    });
  }

  try {
    return await fn();
  } finally {
    release();
  }
}

/** Test-only — resets lane state between test files so one test's held slots don't leak into the next. */
export function _resetLaneForTests(): void {
  active = 0;
  queue.length = 0;
  stats.admitted = 0;
  stats.queued = 0;
  stats.maxWaitMs = 0;
  stats.totalWaitMs = 0;
  stats.maxDepth = 0;
}
