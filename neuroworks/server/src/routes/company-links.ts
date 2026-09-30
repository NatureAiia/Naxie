// Company reference links — named URLs agents can read as live company data.
// Ported from AI-Institute-Africa/neuroworks. Registering is an operator
// action with standing effect (agents fetch these on their own initiative),
// so writes are validated here; reads are open — the value of the feature is
// that any agent can resolve "the pricing page" by name.

import { Router } from "express";
import { listCompanyLinks, addCompanyLink, removeCompanyLink, validateLinkUrl } from "../lib/company-links.js";

export const companyLinksRouter = Router();

companyLinksRouter.get("/", (_req, res) => {
  res.json({ links: listCompanyLinks() });
});

companyLinksRouter.post("/", (req, res) => {
  try {
    const link = addCompanyLink({
      label: String(req.body?.label ?? ""),
      url: String(req.body?.url ?? ""),
      description: req.body?.description ? String(req.body.description) : undefined,
      department: req.body?.department ? String(req.body.department) : undefined,
    });
    res.json({ link });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

companyLinksRouter.delete("/:id", (req, res) => {
  res.json({ ok: removeCompanyLink(req.params.id) });
});

// Check a URL without registering it — lets the UI explain a rejection at the
// moment it is typed rather than after a save fails.
companyLinksRouter.post("/validate", (req, res) => {
  const v = validateLinkUrl(req.body?.url);
  if (!v.ok) return res.status(400).json({ error: v.error });
  res.json({ url: v.url });
});
