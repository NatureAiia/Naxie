import { Router } from "express";
import { listOfficeNotes, setOfficeNotes } from "../lib/office-notes.js";
import { requireLayer } from "../lib/access.js";

export const officeNotesRouter = Router();

// GET /api/office-notes — every department's custom stat lines, keyed by id.
officeNotesRouter.get("/", (_req, res) => {
  res.json({ notes: listOfficeNotes() });
});

// PUT /api/office-notes/:departmentId — replace that department's lines
// (empty array clears them). Body: { lines: string[] }
officeNotesRouter.put("/:departmentId", requireLayer("admin"), (req, res) => {
  try {
    const lines = setOfficeNotes(req.params.departmentId, req.body?.lines);
    res.json({ departmentId: req.params.departmentId, lines });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});
