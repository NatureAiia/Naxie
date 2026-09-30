// Which my-tasks.ts automation-backed task item is this call running for?
// Same shape as job-scope.ts (AsyncLocalStorage carrying an id down the
// async subtree), one level up: this carries the TASK ITEM id, not the job
// id, so a primitive running mid-plan can ask "which task spawned me" and
// resolve ITS scope (tools/data) to narrow a spawned sub-task's own scope
// against — the invariant a child's effective scope is never wider than its
// parent's depends on this being resolved from execution context, not a
// caller-supplied id a step could forge to escape its own scope.

import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<string>();

/** Run `fn` with `taskItemId` visible to everything it awaits. */
export function runInTaskScope<T>(taskItemId: string, fn: () => T): T {
  return scope.run(taskItemId, fn);
}

/** The automation-backed task item this code is running for, or undefined
 *  outside any task-automation dispatch (plain chat, a health check, a
 *  test). Undefined is a normal answer, not a failure. */
export function currentTaskItemId(): string | undefined {
  return scope.getStore();
}
