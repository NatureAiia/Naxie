// Offline mode switch (see lib/offline-mode.ts). GET is open so every client
// can render the header pill; POST requires admin+, same posture as
// routes/daemon-settings.ts.

import { Router } from "express";
import { getOfflineMode, setOffline } from "../lib/offline-mode.js";
import { callerLayer } from "../lib/access.js";
import { logAudit } from "../lib/audit-log.js";

export const offlineModeRouter = Router();

offlineModeRouter.get("/", (_req, res) => {
  res.json(getOfflineMode());
});

offlineModeRouter.post("/", (req, res) => {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    return res.status(403).json({ error: "Switching offline mode requires admin access." });
  }
  const offline = req.body?.offline;
  if (typeof offline !== "boolean") return res.status(400).json({ error: "body.offline (boolean) is required" });
  const state = setOffline(offline);
  logAudit({
    level: "info",
    actor: "operator",
    action: offline ? "offline_mode.on" : "offline_mode.off",
    target: "network",
    detail: offline ? "internet disconnected — local-only (localhost + LAN)" : "back online",
    result: "success",
  });
  res.json(state);
});
