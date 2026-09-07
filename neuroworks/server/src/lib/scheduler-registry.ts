// Minimal orchestration core — a shared registry new background engines
// register into, so there's one place to list "what's running" instead of
// each engine being an invisible standalone setInterval. This does NOT
// replace the existing independent schedulers (org-daemon.ts, schedules.ts,
// reflection.ts, innovation-scan.ts, wiki-compile.ts, extension-scheduler.ts,
// vault.ts's pull scheduler) — those keep their own proven
// setInterval(...).unref() idiom untouched; migrating them here is a
// separate future cleanup once this registry is proven with new engines
// (starting with github-watcher.ts).

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

// Test-only — clears every registered engine's timer so a test suite can
// register fresh engines without leaking intervals across test files.
export function _resetForTests(): void {
  for (const state of engines.values()) {
    if (state.timer) clearInterval(state.timer);
  }
  engines.clear();
}
