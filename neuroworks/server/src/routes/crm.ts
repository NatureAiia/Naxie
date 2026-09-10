import { Router } from "express";
import {
  listContacts, upsertContact, listDeals, createDeal, moveDealStage,
  listPipelines, listActivities, logActivity,
} from "../lib/crm.js";

export const crmRouter = Router();

// GET /api/crm/contacts
crmRouter.get("/contacts", (_req, res) => {
  res.json({ contacts: listContacts() });
});

// POST /api/crm/contacts — create or update-by-email
crmRouter.post("/contacts", (req, res) => {
  try {
    const b = req.body ?? {};
    const contact = upsertContact({
      email: b.email, name: b.name, phone: b.phone, company: b.company, notes: b.notes,
      tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
    });
    res.json({ contact });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// GET /api/crm/contacts/:id/activities
crmRouter.get("/contacts/:id/activities", (req, res) => {
  res.json({ activities: listActivities(String(req.params.id)) });
});

// POST /api/crm/contacts/:id/activities
crmRouter.post("/contacts/:id/activities", (req, res) => {
  try {
    const b = req.body ?? {};
    const activity = logActivity({ contactId: String(req.params.id), kind: b.kind ?? "note", body: String(b.body ?? "") });
    res.json({ activity });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// GET /api/crm/pipelines
crmRouter.get("/pipelines", (_req, res) => {
  res.json({ pipelines: listPipelines() });
});

// GET /api/crm/deals?contactId=&stage=
crmRouter.get("/deals", (req, res) => {
  const contactId = req.query.contactId ? String(req.query.contactId) : undefined;
  const stage = req.query.stage ? String(req.query.stage) : undefined;
  res.json({ deals: listDeals({ contactId, stage }) });
});

// POST /api/crm/deals
crmRouter.post("/deals", (req, res) => {
  try {
    const b = req.body ?? {};
    const deal = createDeal({ contactId: String(b.contactId), title: String(b.title), pipelineId: b.pipelineId, stage: b.stage, value: b.value !== undefined ? Number(b.value) : undefined });
    res.json({ deal });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// PATCH /api/crm/deals/:id/stage
crmRouter.patch("/deals/:id/stage", (req, res) => {
  try {
    const deal = moveDealStage(String(req.params.id), String((req.body ?? {}).stage));
    res.json({ deal });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});
