// Operator kill switches for org-daemon.ts's background loops (see
// lib/daemon-settings.ts). GET is open (any signed-in caller can see what's
// running); PATCH requires admin+, same posture as routes/host-tools.ts.

import { Router } from "express";
import { getDaemonSettings, updateDaemonSettings } from "../lib/daemon-settings.js";
import { callerLayer } from "../lib/access.js";

export const daemonSettingsRouter = Router();

daemonSettingsRouter.get("/settings", (_req, res) => {
  res.json({ settings: getDaemonSettings() });
});

daemonSettingsRouter.patch("/settings", (req, res) => {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    return res.status(403).json({ error: "Changing daemon loop settings requires admin access." });
  }
  const body = req.body ?? {};
  if (!Array.isArray(body.disabledLoops) || !body.disabledLoops.every((x: any) => typeof x === "string")) {
    return res.status(400).json({ error: "disabledLoops must be an array of strings" });
  }
  res.json({ settings: updateDaemonSettings({ disabledLoops: body.disabledLoops }) });
});
