// "My Finances" — the OPERATOR's own personal budget: savings plans and
// income/expense tracking. Ported near-verbatim from KimmyDeku/sebastian's
// data model (SavingsPlan/Deposit/Txn), since it was already a clean,
// minimal shape. Deliberately unrelated to lib/finance-snapshot.ts /
// routes/public-finance.ts (the Aria persona's company/market finance feed)
// — different store, different file, never merged. Persisted at
// .neuroworks/personal-finance.json, scoped per operator by ownerEmail,
// mirroring lib/my-tasks.ts's exact pattern (atomic write, "local" fallback
// for a single-operator shell with no login configured).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
let CONFIG_PATH = resolve(CONFIG_DIR, "personal-finance.json");

// Test seam — points the store at a scratch file so tests never touch the
// real .neuroworks/ state (matches lib/tool-dna.ts's own convention).
export function _setStateFileForTests(path: string): void {
  CONFIG_PATH = path;
}

export type Deposit = { id: string; amount: number; at: string; note?: string };

export type ReminderRule = { enabled: boolean; weekday?: number; dayOfMonth?: number };

export type SavingsPlan = {
  id: string;
  ownerEmail: string;
  name: string;
  target: number;
  frequency: "weekly" | "monthly" | "flexible";
  commitment: number;
  deposits: Deposit[];
  reminder: ReminderRule;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Txn = {
  id: string;
  ownerEmail: string;
  type: "income" | "expense";
  label: string;
  category: string;
  amount: number;
  date: string; // YYYY-MM-DD
  createdAt: string;
};

export const EXPENSE_CATEGORIES = [
  "Housing", "Groceries", "Transport", "Utilities", "Health", "Debt", "Savings", "Entertainment", "Other",
] as const;

type Store = { plans: SavingsPlan[]; txns: Txn[] };

function load(): Store {
  try {
    if (!existsSync(CONFIG_PATH)) return { plans: [], txns: [] };
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { plans: Array.isArray(parsed?.plans) ? parsed.plans : [], txns: Array.isArray(parsed?.txns) ? parsed.txns : [] };
  } catch { return { plans: [], txns: [] }; }
}

function save(store: Store): void {
  if (!existsSync(dirname(CONFIG_PATH))) mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

// ─── savings plans ──────────────────────────────────────────────────────

export function listPlans(ownerEmail: string, opts: { includeArchived?: boolean } = {}): SavingsPlan[] {
  const store = load();
  return store.plans
    .filter(p => p.ownerEmail === ownerEmail && (opts.includeArchived || !p.archived))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createPlan(ownerEmail: string, input: { name: string; target: number; frequency: SavingsPlan["frequency"]; commitment: number; reminder?: ReminderRule }): SavingsPlan {
  const store = load();
  const now = new Date().toISOString();
  const plan: SavingsPlan = {
    id: randomUUID(), ownerEmail,
    name: input.name.trim().slice(0, 120),
    target: Math.max(0, input.target),
    frequency: input.frequency,
    commitment: Math.max(0, input.commitment),
    deposits: [],
    reminder: input.reminder ?? { enabled: false },
    archived: false,
    createdAt: now, updatedAt: now,
  };
  store.plans.push(plan);
  save(store);
  return plan;
}

export function updatePlan(ownerEmail: string, id: string, patch: Partial<Pick<SavingsPlan, "name" | "target" | "frequency" | "commitment" | "reminder" | "archived">>): SavingsPlan | null {
  const store = load();
  const idx = store.plans.findIndex(p => p.id === id && p.ownerEmail === ownerEmail);
  if (idx === -1) return null;
  store.plans[idx] = { ...store.plans[idx], ...patch, updatedAt: new Date().toISOString() };
  save(store);
  return store.plans[idx];
}

export function deletePlan(ownerEmail: string, id: string): boolean {
  const store = load();
  const before = store.plans.length;
  store.plans = store.plans.filter(p => !(p.id === id && p.ownerEmail === ownerEmail));
  if (store.plans.length === before) return false;
  save(store);
  return true;
}

export function addDeposit(ownerEmail: string, planId: string, amount: number, note?: string): SavingsPlan | null {
  const store = load();
  const idx = store.plans.findIndex(p => p.id === planId && p.ownerEmail === ownerEmail);
  if (idx === -1) return null;
  store.plans[idx].deposits.push({ id: randomUUID(), amount, at: new Date().toISOString(), note: note?.slice(0, 200) });
  store.plans[idx].updatedAt = new Date().toISOString();
  save(store);
  return store.plans[idx];
}

export function planProgress(plan: SavingsPlan): { saved: number; pct: number } {
  const saved = plan.deposits.reduce((s, d) => s + d.amount, 0);
  return { saved, pct: plan.target > 0 ? Math.min(1, saved / plan.target) : 0 };
}

// ─── transactions ───────────────────────────────────────────────────────

export function listTxns(ownerEmail: string, opts: { from?: string; to?: string } = {}): Txn[] {
  const store = load();
  return store.txns
    .filter(t => t.ownerEmail === ownerEmail && (!opts.from || t.date >= opts.from) && (!opts.to || t.date <= opts.to))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function addTxn(ownerEmail: string, input: { type: Txn["type"]; label: string; category: string; amount: number; date: string }): Txn {
  const store = load();
  const txn: Txn = {
    id: randomUUID(), ownerEmail,
    type: input.type, label: input.label.trim().slice(0, 120), category: input.category.trim().slice(0, 60) || "Other",
    amount: Math.max(0, input.amount), date: input.date,
    createdAt: new Date().toISOString(),
  };
  store.txns.push(txn);
  save(store);
  return txn;
}

export function deleteTxn(ownerEmail: string, id: string): boolean {
  const store = load();
  const before = store.txns.length;
  store.txns = store.txns.filter(t => !(t.id === id && t.ownerEmail === ownerEmail));
  if (store.txns.length === before) return false;
  save(store);
  return true;
}

// ─── summary — plain arithmetic, no LLM involved ─────────────────────────

export type FinanceSummary = {
  income: number;
  expenses: number;
  net: number;
  byCategory: { category: string; amount: number }[];
  fiftyThirtyTwenty: { needs: number; wants: number; save: number };
};

// The non-advice framing Sebastian repeats at three layers (prompt, a
// persistent UI Notice, the page subtitle) — kept as one function so the
// prompt layer's wording can't drift from what a test asserts against, and
// so routes/personal-finance.ts's /assess handler always sends this, never
// a caller-suppliable override.
export function assessmentSystemPrompt(): string {
  return "Role: a financial organiser reviewing the operator's own recorded income and expenses. This is budgeting guidance on user-recorded figures, not regulated financial advice. Never promise returns, never suggest specific investments, and always note that for tax, debt or investment decisions a licensed professional in their country should be consulted. Reply with ONLY a JSON object: {\"headline\": string, \"savingsPlan\": string[], \"cutBack\": string[]}.";
}

export function summarize(ownerEmail: string, opts: { from?: string; to?: string } = {}): FinanceSummary {
  const txns = listTxns(ownerEmail, opts);
  const income = txns.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expenses = txns.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const byCategoryMap = new Map<string, number>();
  for (const t of txns.filter(t => t.type === "expense")) byCategoryMap.set(t.category, (byCategoryMap.get(t.category) ?? 0) + t.amount);
  const byCategory = [...byCategoryMap.entries()].sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount }));
  return {
    income, expenses, net: income - expenses, byCategory,
    fiftyThirtyTwenty: { needs: income * 0.5, wants: income * 0.3, save: income * 0.2 },
  };
}
