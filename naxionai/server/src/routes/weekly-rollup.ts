import { Router } from "express";
import { weeklyRollupStatus } from "../lib/weekly-rollup.js";

export const weeklyRollupRouter = Router();

// Read-only status for the Daily Rhythm view (Schedules page) — weekly-rollup
// has no other HTTP surface (it's a pure background daemon, no on-demand
// trigger route like reflection/innovation-scan have).
weeklyRollupRouter.get("/", async (_req, res) => {
  try {
    res.json(await weeklyRollupStatus());
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});
