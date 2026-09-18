import { Router } from "express";
import { todoBriefStatus } from "../lib/todo-brief.js";

export const todoBriefRouter = Router();

// Read-only status for the Daily Rhythm view (Schedules page) — todo-brief
// has no other HTTP surface (it's a pure background daemon, no on-demand
// trigger route like reflection/innovation-scan have).
todoBriefRouter.get("/", async (_req, res) => {
  try {
    res.json(await todoBriefStatus());
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});
