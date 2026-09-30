import { Router } from "express";
import { listSignals, getSignal, validateSignal, exportValidatedSignals, listRuns, runBrandSignalScan } from "../lib/brand-signals.js";
import { requireLayer } from "../lib/access.js";

// Brand-signal monitoring API — own-brand mentions/content-opportunities per
// brand, MAIA-shaped (ingest -> gate -> provenance-labelled draft -> human
// validate -> gated export). See lib/brand-signals.ts for the full design.

export const brandSignalsRouter = Router();

// GET /api/brand-signals?brandId=&status=
brandSignalsRouter.get("/", (req, res) => {
  const brandId = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
  const status = typeof req.query.status === "string" ? (req.query.status as any) : undefined;
  res.json({ signals: listSignals({ brandId, status }) });
});

brandSignalsRouter.get("/runs", (req, res) => {
  const brandId = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
  res.json({ runs: listRuns(brandId) });
});

// The export gate — status==="validated" is baked into exportValidatedSignals
// itself; there is no parameter here that can widen it.
brandSignalsRouter.get("/export", (req, res) => {
  const brandId = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
  res.json({ signals: exportValidatedSignals(brandId) });
});

brandSignalsRouter.get("/:id", (req, res) => {
  const s = getSignal(req.params.id);
  if (!s) return res.status(404).json({ error: "signal not found" });
  res.json({ signal: s });
});

// POST /api/brand-signals/:id/validate — body: { decision: "validated" | "rejected" }
// The ONLY way a signal leaves "draft". No auto-validate path exists anywhere.
brandSignalsRouter.post("/:id/validate", requireLayer("admin"), (req, res) => {
  const decision = req.body?.decision;
  if (decision !== "validated" && decision !== "rejected") {
    return res.status(400).json({ error: 'decision must be "validated" or "rejected"' });
  }
  try {
    const s = validateSignal(req.params.id, decision);
    if (!s) return res.status(404).json({ error: "signal not found" });
    res.json({ signal: s });
  } catch (e: any) {
    res.status(409).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/brand-signals/scan — body: { brandId }. Manual trigger; pair with
// a Schedule (schedule.create) for a recurring scan once a brand's watch list
// is set up. Refuses (with a clear error, not a silent no-op) if the brand's
// watchTerms are empty.
brandSignalsRouter.post("/scan", requireLayer("admin"), async (req, res) => {
  const brandId = String(req.body?.brandId ?? "").trim();
  if (!brandId) return res.status(400).json({ error: "brandId is required" });
  try {
    const run = await runBrandSignalScan(brandId);
    res.json({ run });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
