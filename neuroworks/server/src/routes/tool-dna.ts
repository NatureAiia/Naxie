// Tool DNA — the operator-viewable/resettable side of lib/tool-dna.ts.
// Closes the gap: nothing in the Naxie Memory page could delete or turn off
// any learned data before this.

import { Router } from "express";
import { getToolDna, getToolDnaSettings, setPersonalizationEnabled, resetToolDna } from "../lib/tool-dna.js";

export const toolDnaRouter = Router();

toolDnaRouter.get("/", (_req, res) => {
  res.json({ dna: getToolDna(), settings: getToolDnaSettings() });
});

toolDnaRouter.patch("/settings", (req, res) => {
  const enabled = req.body?.personalizationEnabled;
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "body.personalizationEnabled (boolean) is required" });
  res.json({ settings: setPersonalizationEnabled(enabled) });
});

toolDnaRouter.delete("/", (_req, res) => {
  resetToolDna();
  res.json({ ok: true });
});
