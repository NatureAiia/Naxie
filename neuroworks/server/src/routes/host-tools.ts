// Settings > System Access (docs/naxie-architecture.md §2.2/§8.5) — the
// on/off toggles gating host-level tools (system_control, manage_clipboard)
// plus the one operator-configured git repo path. Both toggles default OFF;
// only an admin+ caller may change them, since flipping one on grants real
// OS-level access from an LLM-reachable surface.

import { Router } from "express";
import { getHostToolsSettings, updateHostToolsSettings } from "../lib/host-tools.js";
import { callerLayer } from "../lib/access.js";

export const hostToolsRouter = Router();

hostToolsRouter.get("/settings", (_req, res) => {
  res.json({ settings: getHostToolsSettings() });
});

hostToolsRouter.patch("/settings", (req, res) => {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    return res.status(403).json({ error: "Changing System Access settings requires admin access." });
  }
  const body = req.body ?? {};
  const patch: Partial<{ allowSystemControl: boolean; allowClipboardAccess: boolean; gitRepoPath: string }> = {};
  if (typeof body.allowSystemControl === "boolean") patch.allowSystemControl = body.allowSystemControl;
  if (typeof body.allowClipboardAccess === "boolean") patch.allowClipboardAccess = body.allowClipboardAccess;
  if (typeof body.gitRepoPath === "string") patch.gitRepoPath = body.gitRepoPath.trim();
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "no valid fields in body" });
  res.json({ settings: updateHostToolsSettings(patch) });
});
