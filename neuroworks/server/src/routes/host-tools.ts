// Settings > System Access (docs/naxie-architecture.md §2.2/§8.5) — the
// on/off toggles gating host-level tools (system_control, manage_clipboard),
// the desktop-notification toggle (§2.3, lib/notify.ts), plus the one
// operator-configured git repo path. system_control/clipboard default OFF
// (real OS-level access); notifications default ON (display-only, no OS
// mutation — see host-tools.ts's HostToolsSettings comment). Only an admin+
// caller may change any of them.

import { Router } from "express";
import { getHostToolsSettings, updateHostToolsSettings, launchHermesAgent } from "../lib/host-tools.js";
import { callerLayer } from "../lib/access.js";

export const hostToolsRouter = Router();

hostToolsRouter.get("/settings", (_req, res) => {
  res.json({ settings: getHostToolsSettings() });
});

// Launches the local Hermes agent CLI in its own terminal window. Gated by
// the same allowSystemControl toggle as every other process-spawning host
// tool (see host-tools.ts's launchHermesAgent — fails closed when off).
hostToolsRouter.post("/hermes/launch", async (_req, res) => {
  const result = await launchHermesAgent();
  res.json({ result });
});

hostToolsRouter.patch("/settings", (req, res) => {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    return res.status(403).json({ error: "Changing System Access settings requires admin access." });
  }
  const body = req.body ?? {};
  const patch: Partial<{ allowSystemControl: boolean; allowClipboardAccess: boolean; allowNotifications: boolean; gitRepoPath: string }> = {};
  if (typeof body.allowSystemControl === "boolean") patch.allowSystemControl = body.allowSystemControl;
  if (typeof body.allowClipboardAccess === "boolean") patch.allowClipboardAccess = body.allowClipboardAccess;
  if (typeof body.allowNotifications === "boolean") patch.allowNotifications = body.allowNotifications;
  if (typeof body.gitRepoPath === "string") patch.gitRepoPath = body.gitRepoPath.trim();
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "no valid fields in body" });
  res.json({ settings: updateHostToolsSettings(patch) });
});
