// Read side of the model-call trace. See lib/llm-trace.ts for what is
// recorded and, more importantly, what deliberately is not (no prompt or
// response text). Ported from the earlier prototype.
import { Router } from "express";
import { readTrace, summariseTrace } from "../lib/llm-trace.js";

export const traceRouter = Router();

// GET /api/trace/summary?hours=24[&job=<id>]
// The questions a run raises: what was slowest, what overflowed the local
// window, what failed and why, which job paid for it.
traceRouter.get("/summary", (req, res) => {
  try {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours ?? 24) || 24));
    const job = typeof req.query.job === "string" && req.query.job.trim() ? req.query.job.trim() : undefined;
    const rows = readTrace({ sinceMs: Date.now() - hours * 3600_000, job });
    res.json({ hours, job, ...summariseTrace(rows) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/trace/calls?hours=6&job=<id>&limit=200 — the raw rows, newest last.
traceRouter.get("/calls", (req, res) => {
  try {
    const hours = Math.min(720, Math.max(1, Number(req.query.hours ?? 6) || 6));
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit ?? 200) || 200));
    const job = typeof req.query.job === "string" && req.query.job.trim() ? req.query.job.trim() : undefined;
    res.json({ calls: readTrace({ sinceMs: Date.now() - hours * 3600_000, job, limit }) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});
