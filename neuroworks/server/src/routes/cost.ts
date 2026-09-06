import { Router } from "express";
import { getCostSummary, getCostRecords } from "../lib/cost-tracker.js";

export const costRouter = Router();

costRouter.get("/summary", (_req, res) => {
  res.json(getCostSummary());
});

costRouter.get("/records", (req, res) => {
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  res.json({ records: getCostRecords(since) });
});

// Prompt-cache effectiveness — how much of the cloud input token spend is being
// served from a cached prefix (per profile + per model). The headline number is
// overall.cacheHitRatio; a healthy stable-prefix setup drives it up over a run
// as prefixes repeat. Cloud providers only.
costRouter.get("/cache-stats", async (_req, res) => {
  const { cacheStatsSnapshot } = await import("../lib/prompt-cache-stats.js");
  res.json(cacheStatsSnapshot());
});

// Daily LLM/API spend trend — powers the Cost page's trend chart. Sums each
// cost record into its calendar day.
costRouter.get("/trend", async (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days ?? 14)));
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const dayOf = (iso: string) => new Date(iso).toISOString().slice(0, 10);

  const neuroByDay = new Map<string, number>();
  for (const r of getCostRecords(sinceIso)) {
    const k = dayOf(r.ts);
    neuroByDay.set(k, (neuroByDay.get(k) ?? 0) + r.costUsd);
  }

  const series = [...neuroByDay.keys()].sort().map(date => ({
    date,
    neuroUsd: Math.round((neuroByDay.get(date) ?? 0) * 10000) / 10000,
  }));
  res.json({ days, series });
});
