// Weekly self-improvement review ("Weekly Reflect", lib/weekly-improvement.ts).
// GET is the status the Schedules page renders; POST /run fires one now.

import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { weeklyImprovementStatus, runWeeklyImprovement } from "../lib/weekly-improvement.js";

export const weeklyImprovementRouter = Router();

weeklyImprovementRouter.get("/", async (_req, res) => {
  try {
    const { last, nextFireAt } = await weeklyImprovementStatus();
    // The markdown can be large — the status view only needs the summary.
    res.json({
      last: last ? { date: last.date, path: last.path, generatedAt: last.generatedAt, modelUsed: last.modelUsed, proposals: last.review.proposals.map(p => ({ kind: p.kind, title: p.title, effort: p.effort })), taskIds: last.taskIds, parseFailed: last.parseFailed } : null,
      nextFireAt,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

weeklyImprovementRouter.post("/run", async (_req, res) => {
  try {
    const r = await runWeeklyImprovement();
    res.json({ date: r.date, path: r.path, proposals: r.review.proposals.length, taskIds: r.taskIds, modelUsed: r.modelUsed, parseFailed: r.parseFailed });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

weeklyImprovementRouter.get("/:date", (req, res) => {
  const date = String(req.params.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  const abs = join(config.vaultPath, "_naxion/weekly-improvements", `${date}.md`);
  if (!existsSync(abs)) return res.status(404).json({ error: "no review for that date" });
  res.json({ date, markdown: readFileSync(abs, "utf8") });
});
