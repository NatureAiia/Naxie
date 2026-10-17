// Ambient Watch HTTP surface — mounted at /api/ambient. Status for the
// header, the event feed, operator config (toggles / quiet hours / digest /
// channels), a test-nudge sender, and feed clearing. Config writes are the
// only mutating calls and carry no secrets, so no admin gate (same tier as
// daemon-settings.ts's kill switches).

import { Router } from "express";
import { respond } from "../lib/respond.js";
import {
  AMBIENT_SOURCES,
  ambientEngineStatus,
  clearAmbientEvents,
  emitAmbientEvent,
  getAmbientConfig,
  listAmbientEvents,
  runAmbientTickOnce,
  updateAmbientConfig,
  type AmbientSource,
} from "../lib/ambient.js";

export const ambientRouter = Router();

ambientRouter.get("/status", async (_req, res) => {
  try {
    const cfg = getAmbientConfig();
    const engine = ambientEngineStatus();
    let email: any = null;
    try {
      const { getEmailStatus } = await import("../lib/email.js");
      const s = await getEmailStatus();
      email = {
        configured: s.configured,
        running: s.running,
        outboundTransport: s.outboundTransport,
        inboundMode: s.inboundMode,
        inboundEnabled: s.inboundEnabled,
        user: s.user,
        triageMode: (s as any).triageMode ?? null,
      };
    } catch { /* email status is advisory */ }
    const events = listAmbientEvents({ limit: 200 });
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    const recent = events.filter(e => Date.parse(e.at) >= dayAgo);
    respond.ok(res, {
      enabled: cfg.enabled,
      engine,
      sources: cfg.sources,
      channels: cfg.channels,
      email,
      counts: {
        total: events.length,
        last24h: recent.length,
        pushed: recent.filter(e => e.notified.length > 0 && !e.notified.includes("deferred-quiet-hours")).length,
        deferred: recent.filter(e => e.notified.includes("deferred-quiet-hours")).length,
      },
    });
  } catch (e: any) {
    respond.error(res, 500, "ambient_status_failed", e?.message ?? String(e));
  }
});

ambientRouter.get("/events", (req, res) => {
  const rawSource = typeof req.query.source === "string" ? req.query.source : "";
  const source = (AMBIENT_SOURCES as string[]).includes(rawSource) ? (rawSource as AmbientSource) : undefined;
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? "50") || 50));
  try {
    respond.ok(res, { events: listAmbientEvents({ source, limit }) });
  } catch (e: any) {
    respond.error(res, 500, "ambient_events_failed", e?.message ?? String(e));
  }
});

ambientRouter.get("/config", (_req, res) => {
  try {
    respond.ok(res, { config: getAmbientConfig() });
  } catch (e: any) {
    respond.error(res, 500, "ambient_config_failed", e?.message ?? String(e));
  }
});

ambientRouter.patch("/config", (req, res) => {
  try {
    const body = req.body ?? {};
    respond.ok(res, { config: updateAmbientConfig(body) });
  } catch (e: any) {
    respond.error(res, 400, "invalid_input", e?.message ?? String(e));
  }
});

// Fire one real event through the whole pipeline (judge → quiet-hours →
// channels) so the operator can verify a nudge actually reaches them.
ambientRouter.post("/test", async (req, res) => {
  try {
    const sourceRaw = typeof req.body?.source === "string" ? req.body.source : "job";
    const source: AmbientSource = (AMBIENT_SOURCES as string[]).includes(sourceRaw) ? sourceRaw : "job";
    const ev = await emitAmbientEvent({
      source,
      title: "Ambient Watch test nudge",
      detail: `If you're reading this on ${source === "email" ? "email" : "your channels"}, the pipeline works end to end.`,
      severity: "attention",
      dedupeKey: `test:${Date.now()}`,
    });
    if (!ev) return respond.error(res, 400, "ambient_disabled", "Ambient Watch is disabled or this source is off — enable it first.");
    respond.ok(res, { event: ev });
  } catch (e: any) {
    respond.error(res, 500, "ambient_test_failed", e?.message ?? String(e));
  }
});

// Run one scan tick now instead of waiting for the 60s interval — useful
// right after wiring a source (or after "Send test" does nothing because the
// watcher itself is paused).
ambientRouter.post("/scan", async (_req, res) => {
  try {
    await runAmbientTickOnce();
    respond.ok(res, { ok: true });
  } catch (e: any) {
    respond.error(res, 500, "ambient_scan_failed", e?.message ?? String(e));
  }
});

ambientRouter.delete("/events", (_req, res) => {
  try {
    respond.ok(res, clearAmbientEvents());
  } catch (e: any) {
    respond.error(res, 500, "ambient_clear_failed", e?.message ?? String(e));
  }
});
