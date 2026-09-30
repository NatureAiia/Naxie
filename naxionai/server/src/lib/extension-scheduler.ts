import { getHealthSummaries } from "./extension-health.js";
import { EXTENSION_CATALOG, testExtension } from "./extensions.js";
import { testAllConnections } from "./integrations.js";
import { listConnectors } from "./connectors.js";
import { logAudit } from "./audit-log.js";
import { isOffline } from "./offline-mode.js";

let timer: ReturnType<typeof setInterval> | null = null;
let lastRunAt: string | null = null;
let lastResult: any = null;
let running = false;

async function tick() {
  if (running) return;
  // Offline mode: every external extension would "fail" — skip so the
  // health history doesn't fill with false alerts.
  if (isOffline()) return;
  running = true;
  try {
    const t0 = Date.now();
    // test core extensions
    const coreTests = await Promise.all(
      EXTENSION_CATALOG.filter(c => c.testable).map(async c => {
        try { const r = await testExtension(c.id); return { id: c.id, ...r }; }
        catch (e: any) { return { id: c.id, ok: false, detail: String(e?.message ?? e) }; }
      })
    );
    // integrations already record lastTest via testAllConnections
    let integrationTests: any[] = [];
    try { integrationTests = await testAllConnections(); } catch {}
    const fails = [...coreTests, ...integrationTests].filter(x => !x.ok);
    const summaries = getHealthSummaries(7);
    const alertIds = summaries.filter(s => s.alert).map(s => s.id);

    lastRunAt = new Date().toISOString();
    lastResult = { coreTests, integrationTests, fails: fails.length, alerts: alertIds, ms: Date.now() - t0 };

    if (fails.length > 0 || alertIds.length > 0) {
      logAudit({
        level: "warn",
        actor: "scheduler",
        action: "extension.healthCheck",
        target: `fail:${fails.length} alert:${alertIds.length}`,
        detail: `core fails: ${fails.map(f => `${f.id}:${f.detail.slice(0,80)}`).join(" | ")} | alerts: ${alertIds.join(",")}`,
        result: "failure",
      });
    } else {
      logAudit({ level: "info", actor: "scheduler", action: "extension.healthCheck", target: "all-ok", detail: `all ${coreTests.length} core + ${integrationTests.length} integrations ok in ${Date.now()-t0}ms`, result: "success" });
    }
  } catch (e: any) {
    logAudit({ level: "error", actor: "scheduler", action: "extension.healthCheck", target: "error", detail: String(e?.message ?? e).slice(0,200), result: "failure" });
  } finally {
    running = false;
  }
}

export function startExtensionHealthScheduler() {
  if (timer) return;
  const intervalMs = Math.max(60_000, Number(process.env.NAXION_EXTENSION_HEALTH_INTERVAL_MS ?? 3600000) || 3600000); // default 1h
  if (process.env.NAXION_EXTENSION_HEALTH_SCHEDULER === "0") {
    console.log("  ⓘ extension health scheduler disabled (NAXION_EXTENSION_HEALTH_SCHEDULER=0)");
    return;
  }
  console.log(`  ⓘ extension health scheduler armed (${intervalMs/1000}s interval)`);
  // first run 30s after boot so health file + llm warmup settle
  setTimeout(() => void tick(), 30000).unref?.();
  timer = setInterval(() => void tick(), intervalMs);
  // don't keep process alive on this timer alone
  (timer as any).unref?.();
}

export function stopExtensionHealthScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function getExtensionSchedulerStatus() {
  return { running: !!timer, lastRunAt, lastResult, intervalMs: Number(process.env.NAXION_EXTENSION_HEALTH_INTERVAL_MS ?? 3600000) };
}

// Manual trigger for UI button
export async function runExtensionHealthCheckNow() {
  await tick();
  return { lastRunAt, lastResult };
}
