// Compliance / renewal deadline tracking — licenses, insurance, certificates,
// contracts: anything with a real-world expiry date the operator must act on
// before it lapses. Net-new concept (no prior compliance-renewal model
// existed) — deliberately minimal: a flat list of deadlines, configurable
// reminder offsets, and one escalation path when a reminder sits unactioned
// past the deadline itself.
//
// Persistence mirrors org-tasks.ts exactly (org-daemon's OWN task backlog):
// an in-memory cache, an mtime check on load so a worker process's write is
// picked up without a restart, and a plain JSON file under .neuroworks/.
// NOT json-store.ts — org-tasks.ts never adopted that atomic-write helper
// (it hand-rolls cache+mtime+writeFileSync), so this follows the pattern
// org-daemon.ts's tasks ACTUALLY use rather than the newer helper a couple of
// unrelated lib files (omnisignal.ts/adrs.ts) happen to use instead.
//
// Notification path reuses notify.ts exactly as maybeEscalateBlockedSLA does
// (notifyAttention for a plain reminder, notifyUrgent for the escalation
// tier). Escalation additionally emails a specific configured recipient
// directly via email.ts — notify.ts's notifyUrgent always targets the
// operator, and "escalate to a DIFFERENT recipient" needs an address
// notify.ts has no concept of.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { logAudit } from "./audit-log.js";
import { notifyAttention, notifyUrgent } from "./notify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.neuroworks");
const FILE = join(STATE_DIR, "compliance-renewals.json");

export type ComplianceStatus = "active" | "renewed" | "archived";

export type ComplianceRenewal = {
  id: string;
  name: string;                    // e.g. "Business liability insurance", "api.example.com TLS cert"
  expiryDate: string;              // ISO date (YYYY-MM-DD) — the real-world deadline
  reminderOffsetsDays: number[];   // days-before-expiry to remind, sorted desc, e.g. [30, 14, 3]
  remindedOffsets: number[];       // offsets already fired — prevents re-notifying the same one every tick
  escalationRecipient?: string;    // email to escalate to if a reminder sits unactioned past expiryDate
  status: ComplianceStatus;
  notes?: string;
  lastReminderAt?: string;
  escalatedAt?: string;
  createdAt: string;
  updatedAt: string;
};

const DEFAULT_OFFSETS_DAYS = [30, 14, 3];

// ─── persistence (mirrors org-tasks.ts's load()/persist() exactly) ────────

type Store = { renewals: ComplianceRenewal[] };
let cache: Store | null = null;
let cacheMtimeMs = 0;

function load(): Store {
  const cached = cache;
  if (cached) {
    try {
      const m = statSync(FILE).mtimeMs;
      if (m === cacheMtimeMs) return cached;
      cache = null; // file changed under us (e.g. a worker process) — re-read
    } catch { return cached; }
  }
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(FILE)) {
    cache = { renewals: [] };
    persist();
    return cache;
  }
  try {
    const raw = readFileSync(FILE, "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    cache = { renewals: Array.isArray(parsed.renewals) ? parsed.renewals : [] };
  } catch (e) {
    console.warn(`[compliance-renewals] failed to read ${FILE}: ${(e as Error).message}. Starting empty.`);
    cache = { renewals: [] };
  }
  try { cacheMtimeMs = statSync(FILE).mtimeMs; } catch { cacheMtimeMs = 0; }
  return cache;
}

function persist(): void {
  if (!cache) return;
  try {
    writeFileSync(FILE, JSON.stringify(cache, null, 2));
    try { cacheMtimeMs = statSync(FILE).mtimeMs; } catch { /* next load() re-reads — harmless */ }
  } catch (e) {
    console.warn(`[compliance-renewals] persist failed: ${(e as Error).message}`);
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────

export function listComplianceRenewals(filter?: { status?: ComplianceStatus }): ComplianceRenewal[] {
  let list = load().renewals.slice();
  if (filter?.status) list = list.filter(r => r.status === filter.status);
  return list.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
}

export function getComplianceRenewal(id: string): ComplianceRenewal | undefined {
  return load().renewals.find(r => r.id === id);
}

export type CreateComplianceRenewalInput = {
  name: string;
  expiryDate: string;
  reminderOffsetsDays?: number[];  // default [30, 14, 3]
  escalationRecipient?: string;
  notes?: string;
};

export function createComplianceRenewal(input: CreateComplianceRenewalInput): ComplianceRenewal {
  const s = load();
  const now = new Date().toISOString();
  const offsets = (input.reminderOffsetsDays && input.reminderOffsetsDays.length > 0 ? input.reminderOffsetsDays : DEFAULT_OFFSETS_DAYS)
    .filter(n => Number.isFinite(n) && n >= 0)
    .slice()
    .sort((a, b) => b - a);
  const renewal: ComplianceRenewal = {
    id: randomUUID(),
    name: input.name,
    expiryDate: input.expiryDate,
    reminderOffsetsDays: offsets.length > 0 ? offsets : DEFAULT_OFFSETS_DAYS,
    remindedOffsets: [],
    escalationRecipient: input.escalationRecipient,
    status: "active",
    notes: input.notes,
    createdAt: now,
    updatedAt: now,
  };
  s.renewals.push(renewal);
  persist();
  try { logAudit({ level: "info", actor: "compliance", action: "compliance.created", target: renewal.name, detail: `expires ${renewal.expiryDate}`, result: "success" }); } catch { /* best-effort */ }
  return renewal;
}

// Move a renewal to a new lifecycle status. Marking "renewed" (or archiving a
// deadline that no longer applies) is how a reminder gets "actioned" — it's
// what stops processDueReminders from ever escalating it.
export function updateComplianceRenewalStatus(id: string, status: ComplianceStatus): ComplianceRenewal | null {
  const s = load();
  const idx = s.renewals.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const next: ComplianceRenewal = { ...s.renewals[idx], status, updatedAt: new Date().toISOString() };
  s.renewals[idx] = next;
  persist();
  try { logAudit({ level: "info", actor: "compliance", action: `compliance.${status}`, target: next.name, detail: "", result: "success" }); } catch { /* best-effort */ }
  return next;
}

// ─── Reminder / escalation processing (called from org-daemon tick) ───────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysUntil(expiryDate: string, now: number): number {
  const expiry = new Date(`${expiryDate}T00:00:00`).getTime();
  return Math.floor((expiry - now) / MS_PER_DAY);
}

async function remind(id: string, offset: number, daysLeft: number, now: number): Promise<void> {
  const s = load();
  const idx = s.renewals.findIndex(r => r.id === id);
  if (idx === -1) return;
  const r = s.renewals[idx];
  s.renewals[idx] = { ...r, remindedOffsets: [...r.remindedOffsets, offset], lastReminderAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
  persist();
  const daysWord = daysLeft <= 0 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  void notifyAttention(
    `Naxie — renewal due ${daysWord}`,
    `"${r.name}" expires ${r.expiryDate} (${daysWord}). This was the ${offset}-day-out reminder — mark it renewed once handled.`,
    { actor: "compliance", target: r.name },
  );
  try { logAudit({ level: "info", actor: "compliance", action: "compliance.reminder", target: r.name, detail: `${offset}d-out reminder, expires ${r.expiryDate}`, result: "success" }); } catch { /* best-effort */ }
}

async function escalate(id: string, now: number): Promise<void> {
  const s = load();
  const idx = s.renewals.findIndex(r => r.id === id);
  if (idx === -1) return;
  const r = s.renewals[idx];
  s.renewals[idx] = { ...r, escalatedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
  persist();
  const overdueDays = Math.abs(daysUntil(r.expiryDate, now));
  const subject = `Naxie — ESCALATION: "${r.name}" renewal is overdue`;
  const body = `"${r.name}" expired ${r.expiryDate} (${overdueDays} day${overdueDays === 1 ? "" : "s"} ago) and no one marked it renewed despite reminder(s) at ${r.reminderOffsetsDays.join("/")}-day(s) out. Escalating.`;
  // Standard urgent tier first — same path maybeEscalateBlockedSLA uses, so
  // the operator sees it even when no distinct escalation recipient is set.
  await notifyUrgent(subject, body, { actor: "compliance", target: r.name });
  // Escalation's whole point is reaching someone ELSE once the operator
  // hasn't acted — notify.ts's notifyUrgent has no concept of "a different
  // recipient", so send one extra email directly via the same primitive
  // notifyUrgent uses internally, straight to the configured recipient.
  if (r.escalationRecipient) {
    try {
      const { sendEmail, emailConfigured } = await import("./email.js");
      if (emailConfigured()) {
        await sendEmail({ to: r.escalationRecipient, subject, body });
      }
    } catch (e) {
      console.warn(`[compliance-renewals] escalation email to ${r.escalationRecipient} failed: ${(e as Error).message}`);
    }
  }
  try {
    logAudit({
      level: "warn",
      actor: "compliance",
      action: "compliance.escalated",
      target: r.name,
      detail: `overdue ${overdueDays}d — escalated to ${r.escalationRecipient ?? "operator (no distinct recipient configured)"}`,
      result: "success",
    });
  } catch { /* best-effort */ }
}

// Process every active renewal once per tick: fire the next due reminder
// offset, or escalate to a different recipient once the deadline itself has
// passed with the item still unactioned. Takes `now` as a parameter so it's
// testable without relying on the real clock — mirrors org-daemon.ts's own
// sweepStaleOrgApprovals/maybeEscalateBlockedSLA shape.
export async function processDueReminders(now = Date.now()): Promise<{ reminded: number; escalated: number }> {
  let reminded = 0;
  let escalated = 0;
  for (const r of listComplianceRenewals({ status: "active" })) {
    const daysLeft = daysUntil(r.expiryDate, now);

    if (daysLeft < 0) {
      if (!r.escalatedAt) {
        await escalate(r.id, now);
        escalated += 1;
      }
      // Already escalated (or just was) — wait for a human to change status
      // rather than escalating again every tick.
      continue;
    }

    // Fire the largest configured offset that's due and not yet sent, so a
    // daemon that was down catches up in offset order (30d before 14d) even
    // if several became due while it was offline.
    const due = [...r.reminderOffsetsDays].sort((a, b) => b - a).find(off => daysLeft <= off && !r.remindedOffsets.includes(off));
    if (due === undefined) continue;
    await remind(r.id, due, daysLeft, now);
    reminded += 1;
  }
  return { reminded, escalated };
}
