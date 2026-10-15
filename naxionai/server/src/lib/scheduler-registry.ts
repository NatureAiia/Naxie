// Minimal orchestration core — a shared registry background engines
// register into, so there's one place to list "what's running" instead of
// each engine being an invisible standalone setInterval. Proven first with
// github-watcher.ts, then migrated (2026-10-14) onto org-daemon.ts,
// reflection.ts, innovation-scan.ts, weekly-rollup.ts, todo-brief.ts,
// wiki-compile.ts (both its schedulers) and vault.ts's pull scheduler — each
// keeps its own tick()/run logic and public startX()/stopX() API, just
// delegating the actual setInterval bookkeeping here. schedules.ts (the
// user-facing schedule engine, 30s tick) and extension-scheduler.ts stay on
// their own standalone timers: schedules.ts needs sub-10-minute precision
// this registry doesn't offer, and extension-scheduler.ts's env-toggle
// (NAXION_EXTENSION_HEALTH_SCHEDULER=0) doesn't fit the registry's
// always-on-register shape.

export type Engine = {
  name: string;
  intervalSeconds: number;
  run: () => Promise<void> | void;
};

type EngineState = Engine & { timer: NodeJS.Timeout | null; lastRunAt?: string; lastError?: string };

const engines = new Map<string, EngineState>();

// Starts the engine's own setInterval immediately — same idiom every
// existing scheduler already uses (setInterval(fn, ms).unref()), just
// tracked centrally so listEngines() can report on it.
export function registerEngine(engine: Engine): void {
  if (engines.has(engine.name)) return; // idempotent — a re-register (e.g. hot reload) is a no-op
  const state: EngineState = { ...engine, timer: null };
  engines.set(engine.name, state);

  async function tick() {
    try {
      await state.run();
      state.lastRunAt = new Date().toISOString();
      state.lastError = undefined;
    } catch (e: any) {
      state.lastError = String(e?.message ?? e);
      console.warn(`[scheduler-registry] engine "${engine.name}" failed: ${state.lastError}`);
    }
  }

  state.timer = setInterval(() => void tick(), engine.intervalSeconds * 1000);
  state.timer.unref?.();
  // One immediate run on registration, mirroring schedules.ts's own
  // catch-up-on-boot convention, so a fresh boot doesn't wait a full
  // interval before the first check.
  setTimeout(() => void tick(), 5_000);
}

export function listEngines(): { name: string; intervalSeconds: number; lastRunAt?: string; lastError?: string }[] {
  return [...engines.values()].map(({ name, intervalSeconds, lastRunAt, lastError }) => ({ name, intervalSeconds, lastRunAt, lastError }));
}

// Stops and forgets one engine — the graceful-shutdown counterpart to
// registerEngine. Each migrated scheduler's own stopX() delegates here so
// callers (index.ts's shutdown handler) keep working unchanged.
export function unregisterEngine(name: string): void {
  const state = engines.get(name);
  if (!state) return;
  if (state.timer) clearInterval(state.timer);
  engines.delete(name);
}

// Test-only — clears every registered engine's timer so a test suite can
// register fresh engines without leaking intervals across test files.
export function _resetForTests(): void {
  for (const state of engines.values()) {
    if (state.timer) clearInterval(state.timer);
  }
  engines.clear();
}
