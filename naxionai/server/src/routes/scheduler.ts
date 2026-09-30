import { Router } from "express";
import { listEngines } from "../lib/scheduler-registry.js";

// Introspection for the new orchestration core (scheduler-registry.ts) — the
// registered engines' name/interval/last-run/last-error, so Command Center
// can show "Orchestration: N engines" instead of the core being invisible.

export const schedulerRouter = Router();

schedulerRouter.get("/status", (_req, res) => res.json({ engines: listEngines() }));
