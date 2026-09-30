// Which job is this call for? Ported from AI-Institute-Africa/neuroworks.
//
// The LLM layer never knew. The single funnel in llm.ts passed the literal
// string "adhoc" as the job id to every cost/trace record, so every row
// ever written was unattributed and per-job spend never worked — the Cost
// page could say what was spent, never on what.
//
// Threading a job id through would mean a new option on LLMCallOptions and
// an edit at every call site, most of which are several frames away from
// anything that knows about jobs. AsyncLocalStorage carries it down the
// async subtree instead, which is exactly the shape of the problem: runJob
// already owns the whole lifetime of a job's work.

import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<string>();

/** Run `fn` with `jobId` visible to everything it awaits. */
export function runInJobScope<T>(jobId: string, fn: () => T): T {
  return scope.run(jobId, fn);
}

/**
 * The job this code is running for, or undefined outside any job.
 *
 * Undefined is a normal answer, not a failure: a health check, a schedule
 * tick and a test all call the model outside a job. Callers label those
 * "adhoc".
 */
export function currentJobId(): string | undefined {
  return scope.getStore();
}
