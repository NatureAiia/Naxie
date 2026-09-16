// Minimal CRM store — contacts, deals/pipeline, and a per-contact activity
// timeline. JSON-backed under .neuroworks/crm.json, following the same
// convention as connectors.ts / oauth-connectors.ts / email-threads.ts
// (atomic temp+rename write, no DB dependency — Postgres/pgvector here is
// optional and off by default, see config.ts's pgvectorEnabled).
//
// Contacts are the one durable identity; email-inbound.ts links an inbound
// sender to a contact by email so a mailbox becomes CRM activity for free.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { maskSensitiveFields } from "./security.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const CONFIG_PATH = resolve(CONFIG_DIR, "crm.json");

export type Contact = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  source?: string;      // e.g. "email", "manual", "web"
  tags: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type Deal = {
  id: string;
  contactId: string;
  title: string;
  pipelineId: string;
  stage: string;
  value?: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};

export type Pipeline = {
  id: string;
  name: string;
  stages: string[];
};

export type Activity = {
  id: string;
  contactId: string;
  kind: "note" | "email" | "call" | "stage-change";
  body: string;
  at: string;
};

type Store = { contacts: Contact[]; deals: Deal[]; pipelines: Pipeline[]; activities: Activity[] };

const DEFAULT_PIPELINE: Pipeline = {
  id: "default",
  name: "Default Pipeline",
  stages: ["New", "Qualified", "Proposal", "Won", "Lost"],
};

let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  if (!existsSync(CONFIG_PATH)) {
    cache = { contacts: [], deals: [], pipelines: [DEFAULT_PIPELINE], activities: [] };
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    cache = {
      contacts: Array.isArray(parsed?.contacts) ? parsed.contacts : [],
      deals: Array.isArray(parsed?.deals) ? parsed.deals : [],
      pipelines: Array.isArray(parsed?.pipelines) && parsed.pipelines.length ? parsed.pipelines : [DEFAULT_PIPELINE],
      activities: Array.isArray(parsed?.activities) ? parsed.activities : [],
    };
  } catch {
    cache = { contacts: [], deals: [], pipelines: [DEFAULT_PIPELINE], activities: [] };
  }
  return cache;
}

function persist(): void {
  if (!cache) return;
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  renameSync(tmp, CONFIG_PATH);
}

// ─── Contacts ───

export function listContacts(): Contact[] {
  return load().contacts.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getContact(id: string): Contact | undefined {
  return load().contacts.find(c => c.id === id);
}

function findContactByEmail(email: string): Contact | undefined {
  const key = email.trim().toLowerCase();
  if (!key) return undefined;
  return load().contacts.find(c => c.email?.toLowerCase() === key);
}

// Creates a contact, or updates+returns the existing one matched by email
// (the only reliable natural key an inbound channel gives us today).
export function upsertContact(input: {
  email?: string; name?: string; phone?: string; company?: string; source?: string; tags?: string[]; notes?: string;
}): Contact {
  const store = load();
  const now = new Date().toISOString();
  const email = input.email?.trim();
  const existing = email ? findContactByEmail(email) : undefined;
  if (existing) {
    if (input.name) existing.name = input.name;
    if (input.phone) existing.phone = input.phone;
    if (input.company) existing.company = input.company;
    if (input.notes) existing.notes = input.notes;
    if (input.tags?.length) existing.tags = Array.from(new Set([...existing.tags, ...input.tags]));
    existing.updatedAt = now;
    persist();
    return existing;
  }
  const contact: Contact = {
    id: randomUUID(),
    name: input.name?.trim() || undefined,
    email: email || undefined,
    phone: input.phone?.trim() || undefined,
    company: input.company?.trim() || undefined,
    source: input.source?.trim() || "manual",
    tags: input.tags ?? [],
    notes: input.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
  store.contacts.push(contact);
  persist();
  return contact;
}

// ─── Pipelines & deals ───

export function listPipelines(): Pipeline[] {
  return load().pipelines;
}

export function listDeals(filter?: { contactId?: string; pipelineId?: string; stage?: string }): Deal[] {
  let deals = load().deals.slice();
  if (filter?.contactId) deals = deals.filter(d => d.contactId === filter.contactId);
  if (filter?.pipelineId) deals = deals.filter(d => d.pipelineId === filter.pipelineId);
  if (filter?.stage) deals = deals.filter(d => d.stage === filter.stage);
  return deals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createDeal(input: { contactId: string; title: string; pipelineId?: string; stage?: string; value?: number }): Deal {
  const store = load();
  const contact = store.contacts.find(c => c.id === input.contactId);
  if (!contact) throw new Error(`contact "${input.contactId}" not found`);
  const pipelineId = input.pipelineId || DEFAULT_PIPELINE.id;
  const pipeline = store.pipelines.find(p => p.id === pipelineId);
  if (!pipeline) throw new Error(`pipeline "${pipelineId}" not found`);
  const stage = input.stage && pipeline.stages.includes(input.stage) ? input.stage : pipeline.stages[0];
  const now = new Date().toISOString();
  const deal: Deal = {
    id: randomUUID(), contactId: input.contactId, title: input.title.trim(),
    pipelineId, stage, value: input.value, createdAt: now, updatedAt: now,
  };
  store.deals.push(deal);
  persist();
  return deal;
}

export function moveDealStage(dealId: string, stage: string): Deal {
  const store = load();
  const deal = store.deals.find(d => d.id === dealId);
  if (!deal) throw new Error(`deal "${dealId}" not found`);
  const pipeline = store.pipelines.find(p => p.id === deal.pipelineId);
  if (pipeline && !pipeline.stages.includes(stage)) {
    throw new Error(`stage "${stage}" is not valid for pipeline "${pipeline.name}" (valid: ${pipeline.stages.join(", ")})`);
  }
  const now = new Date().toISOString();
  const fromStage = deal.stage;
  deal.stage = stage;
  deal.updatedAt = now;
  if (stage === "Won" || stage === "Lost") deal.closedAt = now;
  store.activities.push({
    id: randomUUID(), contactId: deal.contactId, kind: "stage-change",
    body: `Deal "${deal.title}" moved from ${fromStage} to ${stage}`, at: now,
  });
  persist();
  return deal;
}

// ─── Activities ───

export function listActivities(contactId: string): Activity[] {
  return load().activities.filter(a => a.contactId === contactId).sort((a, b) => b.at.localeCompare(a.at));
}

export function logActivity(input: { contactId: string; kind: Activity["kind"]; body: string }): Activity {
  const store = load();
  if (!store.contacts.some(c => c.id === input.contactId)) throw new Error(`contact "${input.contactId}" not found`);
  const activity: Activity = { id: randomUUID(), contactId: input.contactId, kind: input.kind, body: input.body.slice(0, 4000), at: new Date().toISOString() };
  store.activities.push(activity);
  persist();
  return activity;
}

// ─── Naxie context injection ───
// Compact CRM snapshot folded into every Naxie turn (naxie-context.ts) so
// "how's the pipeline looking" or "who am I meeting with" doesn't need a
// dedicated tool call for the common case — cheap since load() is an
// in-memory cache, not a fresh disk read. Empty string when the CRM has
// nothing in it yet, so a fresh install doesn't pad every prompt with
// "0 contacts, 0 deals."
export function crmContextSummary(): string {
  const store = load();
  if (store.contacts.length === 0 && store.deals.length === 0) return "";
  // Masked before any field is read out into the prompt string below — a
  // future field (or a synced-in record with more columns than today's
  // Contact/Deal shape) shouldn't have to earn its way into this summary by
  // remembering to mask it here too.
  const contacts: Contact[] = store.contacts.map(c => maskSensitiveFields(c, "contact"));
  const deals: Deal[] = store.deals.map(d => maskSensitiveFields(d, "deal"));
  const openDeals = deals.filter(d => d.stage !== "Won" && d.stage !== "Lost");
  const openValue = openDeals.reduce((sum, d) => sum + (d.value ?? 0), 0);
  const topDeals = openDeals.slice().sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 3);
  const contactLabel = (id: string) => {
    const c = contacts.find(x => x.id === id);
    return c?.name || c?.email || "unknown contact";
  };
  const lines = [
    `${contacts.length} contact${contacts.length === 1 ? "" : "s"}, ${openDeals.length} open deal${openDeals.length === 1 ? "" : "s"}` +
    (openValue > 0 ? ` (${openValue.toLocaleString()} total open value)` : "") + ".",
  ];
  if (topDeals.length > 0) {
    lines.push("Top open deals: " + topDeals.map(d =>
      `"${d.title}" — ${d.stage}${d.value ? `, ${d.value.toLocaleString()}` : ""} (${contactLabel(d.contactId)})`,
    ).join("; "));
  }
  return lines.join("\n");
}
