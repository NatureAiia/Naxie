// "Business Finance" — the operator's business books: a product price book
// (cost vs sell, margin), business income/expense tracking, deterministic
// leakage detection (recurring drains + category spikes), cash runway
// forecasting, and approval-gated big spends (IntelliRevenue-inspired set:
// leakage, forecast, spend approvals, price catalogue).
//
// Deliberately separate from lib/personal-finance.ts (the operator's own
// budget) and lib/finance-snapshot.ts (Aria's market feed) — different
// store, different file, never merged. Persisted at
// .naxion/business-finance.json, scoped per operator by ownerEmail,
// mirroring lib/my-tasks.ts's pattern (atomic write, "local" fallback).
//
// Approval flow: expenses at/above settings.approvalThreshold do NOT post
// directly — recordExpense() holds them as PendingSpend rows and the route
// files an OrgTask (role "admin", kind "spend", detail carries
// "finance-pending:<pendingId>") via requestApproval(). Approving through
// PATCH /api/org-tasks/:id/resolve settles via settlePendingSpend() (hooked
// in routes/org-tasks.ts, same shape as the improver hook); rejecting drops
// the pending row. Either surface — Approvals page or this page — runs the
// same single path, so no split-brain.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.naxion");
let CONFIG_PATH = resolve(CONFIG_DIR, "business-finance.json");

// Test seam — points the store at a scratch file so tests never touch the
// real .naxion/ state (matches lib/personal-finance.ts's convention).
export function _setStateFileForTests(path: string): void {
  CONFIG_PATH = path;
}

export type Product = {
  id: string;
  ownerEmail: string;
  businessId: string;
  name: string;
  category: string;
  costPrice: number;
  sellPrice: number;
  unit: string;
  active: boolean;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type BizTxn = {
  id: string;
  ownerEmail: string;
  businessId: string;
  type: "income" | "expense";
  label: string;
  category: string;
  amount: number;
  date: string; // YYYY-MM-DD
  productId?: string;
  createdAt: string;
};

export type PendingSpend = {
  id: string;
  ownerEmail: string;
  businessId: string;
  label: string;
  category: string;
  amount: number;
  date: string;
  taskId: string;
  createdAt: string;
};

export type BusinessSettings = {
  businessName: string;
  currency: string;
  approvalThreshold: number; // expenses >= this park for approval (0 disables)
  cashOnHand: number;
};

export type BusinessWorkspace = {
  id: string;
  ownerEmail: string;
  name: string;
  currency: string;
  createdAt: string;
};

export const BIZ_CATEGORIES = [
  "Sales", "Stock", "Rent", "Salaries", "Transport", "Utilities",
  "Marketing", "Maintenance", "Fees", "Other",
] as const;

export const PRODUCT_CATEGORIES = [
  "Repair", "Accessories", "Devices", "Services", "Other",
] as const;

type Store = {
  businesses: BusinessWorkspace[];
  products: Product[];
  txns: BizTxn[];
  pending: PendingSpend[];
  settingsByBusiness: Record<string, BusinessSettings>;
};

const DEFAULT_SETTINGS: BusinessSettings = { businessName: "Varity Vault", currency: "USD", approvalThreshold: 200, cashOnHand: 0 };
const DEFAULT_BUSINESS_ID = "default";
const businessKey = (ownerEmail: string, businessId: string) => `${ownerEmail}::${businessId}`;

function load(): Store {
  try {
    if (!existsSync(CONFIG_PATH)) return { businesses: [], products: [], txns: [], pending: [], settingsByBusiness: {} };
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const products = Array.isArray(parsed?.products) ? parsed.products : [];
    const txns = Array.isArray(parsed?.txns) ? parsed.txns : [];
    const pending = Array.isArray(parsed?.pending) ? parsed.pending : [];
    const oldSettings = parsed?.settingsByOwner && typeof parsed.settingsByOwner === "object" ? parsed.settingsByOwner : {};
    const businesses: BusinessWorkspace[] = Array.isArray(parsed?.businesses) ? parsed.businesses : [];
    const owners = new Set<string>([
      ...products.map((row: Product) => row.ownerEmail), ...txns.map((row: BizTxn) => row.ownerEmail),
      ...pending.map((row: PendingSpend) => row.ownerEmail), ...Object.keys(oldSettings),
    ]);
    for (const ownerEmail of owners) {
      if (!businesses.some(b => b.ownerEmail === ownerEmail && b.id === DEFAULT_BUSINESS_ID)) {
        const legacy = oldSettings[ownerEmail] ?? {};
        businesses.push({ id: DEFAULT_BUSINESS_ID, ownerEmail, name: legacy.businessName || "Varity Vault", currency: legacy.currency || "USD", createdAt: new Date(0).toISOString() });
      }
    }
    const settingsByBusiness: Record<string, BusinessSettings> = parsed?.settingsByBusiness && typeof parsed.settingsByBusiness === "object"
      ? parsed.settingsByBusiness
      : Object.fromEntries(Object.entries(oldSettings).map(([owner, settings]) => [businessKey(owner, DEFAULT_BUSINESS_ID), { ...DEFAULT_SETTINGS, ...(settings as Partial<BusinessSettings>) }]));
    return {
      businesses,
      products: products.map((row: Product) => ({ ...row, businessId: row.businessId || DEFAULT_BUSINESS_ID })),
      txns: txns.map((row: BizTxn) => ({ ...row, businessId: row.businessId || DEFAULT_BUSINESS_ID })),
      pending: pending.map((row: PendingSpend) => ({ ...row, businessId: row.businessId || DEFAULT_BUSINESS_ID })),
      settingsByBusiness,
    };
  } catch { return { businesses: [], products: [], txns: [], pending: [], settingsByBusiness: {} }; }
}

function save(store: Store): void {
  if (!existsSync(dirname(CONFIG_PATH))) mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

export function marginOf(costPrice: number, sellPrice: number): { amount: number; pct: number } {
  const amount = sellPrice - costPrice;
  return { amount, pct: sellPrice > 0 ? amount / sellPrice : 0 };
}

// ─── settings ─────────────────────────────────────────────────────────

function ensureOwnerWorkspace(store: Store, ownerEmail: string): BusinessWorkspace {
  let business = store.businesses.find(b => b.ownerEmail === ownerEmail && b.id === DEFAULT_BUSINESS_ID);
  if (!business) {
    business = { id: DEFAULT_BUSINESS_ID, ownerEmail, name: DEFAULT_SETTINGS.businessName, currency: DEFAULT_SETTINGS.currency, createdAt: new Date().toISOString() };
    store.businesses.push(business);
    store.settingsByBusiness[businessKey(ownerEmail, DEFAULT_BUSINESS_ID)] ??= { ...DEFAULT_SETTINGS };
    save(store);
  }
  return business;
}

export function listBusinesses(ownerEmail: string): BusinessWorkspace[] {
  const store = load();
  ensureOwnerWorkspace(store, ownerEmail);
  return store.businesses.filter(b => b.ownerEmail === ownerEmail).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getBusiness(ownerEmail: string, businessId: string): BusinessWorkspace | null {
  return listBusinesses(ownerEmail).find(b => b.id === businessId) ?? null;
}

export function selectBusinessForAgent(ownerEmail: string, name?: string): { business?: BusinessWorkspace; error?: string } {
  const businesses = listBusinesses(ownerEmail);
  if (name?.trim()) {
    const business = businesses.find(b => b.name.toLowerCase() === name.trim().toLowerCase());
    return business ? { business } : { error: `No business named "${name}". Available: ${businesses.map(b => b.name).join(", ")}` };
  }
  if (businesses.length === 1) return { business: businesses[0] };
  return { error: `Choose a business workspace. Available: ${businesses.map(b => b.name).join(", ")}` };
}

export function createBusiness(ownerEmail: string, input: { name: string; currency?: string }): BusinessWorkspace {
  const store = load();
  ensureOwnerWorkspace(store, ownerEmail);
  const business: BusinessWorkspace = {
    id: randomUUID(), ownerEmail, name: input.name.trim().slice(0, 100),
    currency: (input.currency || DEFAULT_SETTINGS.currency).toUpperCase(), createdAt: new Date().toISOString(),
  };
  store.businesses.push(business);
  store.settingsByBusiness[businessKey(ownerEmail, business.id)] = { ...DEFAULT_SETTINGS, businessName: business.name, currency: business.currency };
  save(store);
  return business;
}

export function getSettings(ownerEmail: string, businessId = DEFAULT_BUSINESS_ID): BusinessSettings {
  const store = load();
  ensureOwnerWorkspace(store, ownerEmail);
  return { ...DEFAULT_SETTINGS, ...(store.settingsByBusiness[businessKey(ownerEmail, businessId)] ?? {}) };
}

export function updateSettings(ownerEmail: string, patch: Partial<BusinessSettings>, businessId = DEFAULT_BUSINESS_ID): BusinessSettings {
  const store = load();
  ensureOwnerWorkspace(store, ownerEmail);
  const key = businessKey(ownerEmail, businessId);
  const next = { ...DEFAULT_SETTINGS, ...(store.settingsByBusiness[key] ?? {}) };
  if (patch.businessName !== undefined) next.businessName = String(patch.businessName).trim().slice(0, 100) || DEFAULT_SETTINGS.businessName;
  if (patch.currency !== undefined) next.currency = String(patch.currency).toUpperCase();
  if (patch.approvalThreshold !== undefined) next.approvalThreshold = Math.max(0, Number(patch.approvalThreshold) || 0);
  if (patch.cashOnHand !== undefined) next.cashOnHand = Math.max(0, Number(patch.cashOnHand) || 0);
  store.settingsByBusiness[key] = next;
  const business = store.businesses.find(b => b.ownerEmail === ownerEmail && b.id === businessId);
  if (business) { business.name = next.businessName; business.currency = next.currency; }
  save(store);
  return { ...next };
}

// ─── products (price book) ────────────────────────────────────────────

export function listProducts(ownerEmail: string, opts: { includeInactive?: boolean; businessId?: string } = {}): Product[] {
  return load().products
    .filter(p => p.ownerEmail === ownerEmail && p.businessId === (opts.businessId ?? DEFAULT_BUSINESS_ID) && (opts.includeInactive || p.active))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createProduct(ownerEmail: string, input: { name: string; category?: string; costPrice: number; sellPrice: number; unit?: string; notes?: string }, businessId = DEFAULT_BUSINESS_ID): Product {
  const store = load();
  const now = new Date().toISOString();
  const product: Product = {
    id: randomUUID(), ownerEmail, businessId,
    name: input.name.trim().slice(0, 120),
    category: input.category?.trim().slice(0, 60) || "Other",
    costPrice: Math.max(0, Number(input.costPrice) || 0),
    sellPrice: Math.max(0, Number(input.sellPrice) || 0),
    unit: input.unit?.trim().slice(0, 20) || "each",
    active: true,
    notes: input.notes?.trim().slice(0, 300) || undefined,
    createdAt: now, updatedAt: now,
  };
  store.products.push(product);
  save(store);
  return product;
}

export function updateProduct(ownerEmail: string, id: string, patch: Partial<Pick<Product, "name" | "category" | "costPrice" | "sellPrice" | "unit" | "active" | "notes">>, businessId = DEFAULT_BUSINESS_ID): Product | null {
  const store = load();
  const idx = store.products.findIndex(p => p.id === id && p.ownerEmail === ownerEmail && p.businessId === businessId);
  if (idx === -1) return null;
  const cur = store.products[idx];
  store.products[idx] = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) } : {}),
    ...(patch.category !== undefined ? { category: patch.category.trim().slice(0, 60) || "Other" } : {}),
    ...(patch.costPrice !== undefined ? { costPrice: Math.max(0, Number(patch.costPrice) || 0) } : {}),
    ...(patch.sellPrice !== undefined ? { sellPrice: Math.max(0, Number(patch.sellPrice) || 0) } : {}),
    ...(patch.unit !== undefined ? { unit: patch.unit.trim().slice(0, 20) || "each" } : {}),
    ...(patch.active !== undefined ? { active: !!patch.active } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes.trim().slice(0, 300) || undefined } : {}),
    updatedAt: new Date().toISOString(),
  };
  save(store);
  return store.products[idx];
}

export function deleteProduct(ownerEmail: string, id: string, businessId = DEFAULT_BUSINESS_ID): boolean {
  const store = load();
  const before = store.products.length;
  store.products = store.products.filter(p => !(p.id === id && p.ownerEmail === ownerEmail && p.businessId === businessId));
  if (store.products.length === before) return false;
  // Keep history intact — sale rows keep their label, just lose the link.
  for (const t of store.txns) {
    if (t.ownerEmail === ownerEmail && t.businessId === businessId && t.productId === id) delete t.productId;
  }
  save(store);
  return true;
}

// ─── transactions ─────────────────────────────────────────────────────

export function listTxns(ownerEmail: string, opts: { from?: string; to?: string; businessId?: string } = {}): BizTxn[] {
  return load().txns
    .filter(t => t.ownerEmail === ownerEmail && t.businessId === (opts.businessId ?? DEFAULT_BUSINESS_ID) && (!opts.from || t.date >= opts.from) && (!opts.to || t.date <= opts.to))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export function addTxn(ownerEmail: string, input: { type: BizTxn["type"]; label: string; category: string; amount: number; date: string; productId?: string }, businessId = DEFAULT_BUSINESS_ID): BizTxn {
  const store = load();
  const txn: BizTxn = {
    id: randomUUID(), ownerEmail, businessId,
    type: input.type,
    label: input.label.trim().slice(0, 120),
    category: input.category.trim().slice(0, 60) || "Other",
    amount: Math.max(0, Number(input.amount) || 0),
    date: input.date,
    ...(input.productId ? { productId: input.productId } : {}),
    createdAt: new Date().toISOString(),
  };
  store.txns.push(txn);
  save(store);
  return txn;
}

export function deleteTxn(ownerEmail: string, id: string, businessId = DEFAULT_BUSINESS_ID): boolean {
  const store = load();
  const before = store.txns.length;
  store.txns = store.txns.filter(t => !(t.id === id && t.ownerEmail === ownerEmail && t.businessId === businessId));
  if (store.txns.length === before) return false;
  save(store);
  return true;
}

// ─── pending big spends (approval-gated) ──────────────────────────────

export const FINANCE_PENDING_PREFIX = "finance-pending:";

export function buildFinanceTaskDetail(pendingId: string, description: string): string {
  return `${FINANCE_PENDING_PREFIX}${pendingId}\n${description}`;
}

export function parseFinancePendingRef(detail: string): string | null {
  if (!detail.startsWith(FINANCE_PENDING_PREFIX)) return null;
  const id = detail.slice(FINANCE_PENDING_PREFIX.length).split("\n")[0].trim();
  return id || null;
}

export function listPending(ownerEmail: string, businessId?: string): PendingSpend[] {
  return load().pending
    .filter(p => p.ownerEmail === ownerEmail && (!businessId || p.businessId === businessId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createPendingSpend(ownerEmail: string, input: { label: string; category: string; amount: number; date: string; taskId: string }, businessId = DEFAULT_BUSINESS_ID): PendingSpend {
  const store = load();
  const pending: PendingSpend = {
    id: randomUUID(), ownerEmail, businessId,
    label: input.label.trim().slice(0, 120),
    category: input.category.trim().slice(0, 60) || "Other",
    amount: Math.max(0, Number(input.amount) || 0),
    date: input.date,
    taskId: input.taskId,
    createdAt: new Date().toISOString(),
  };
  store.pending.push(pending);
  save(store);
  return pending;
}

// Settle a parked spend after its OrgTask resolves. Approve posts it as a
// real expense row; reject drops it. Returns the posted txn (approve) or
// null (reject / unknown id). Never throws on unknown ids — the approval
// inbox must stay usable even if the finance row was cleaned up first.
export function settlePendingSpend(ownerEmail: string, pendingId: string, approved: boolean): BizTxn | null {
  const store = load();
  const idx = store.pending.findIndex(p => p.id === pendingId && p.ownerEmail === ownerEmail);
  if (idx === -1) return null;
  const [pending] = store.pending.splice(idx, 1);
  let posted: BizTxn | null = null;
  if (approved) {
    posted = {
      id: randomUUID(), ownerEmail, businessId: pending.businessId, type: "expense",
      label: pending.label, category: pending.category,
      amount: pending.amount, date: pending.date,
      createdAt: new Date().toISOString(),
    };
    store.txns.push(posted);
  }
  save(store);
  return posted;
}

// ─── summary — plain arithmetic, no LLM involved ───────────────────────

export type BusinessSummary = {
  income: number;
  expenses: number;
  net: number;
  byCategory: { category: string; amount: number }[];
  topProducts: { productId: string; name: string; revenue: number; estMargin: number }[];
};

export function summarizeBiz(ownerEmail: string, opts: { from?: string; to?: string; businessId?: string } = {}): BusinessSummary {
  const txns = listTxns(ownerEmail, opts);
  const products = new Map(listProducts(ownerEmail, { includeInactive: true, businessId: opts.businessId }).map(p => [p.id, p]));
  const income = txns.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expenses = txns.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const byCategoryMap = new Map<string, number>();
  for (const t of txns.filter(t => t.type === "expense")) byCategoryMap.set(t.category, (byCategoryMap.get(t.category) ?? 0) + t.amount);
  const byCategory = [...byCategoryMap.entries()].sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount }));
  const revenueByProduct = new Map<string, number>();
  for (const t of txns.filter(t => t.type === "income" && t.productId)) {
    revenueByProduct.set(t.productId!, (revenueByProduct.get(t.productId!) ?? 0) + t.amount);
  }
  const topProducts = [...revenueByProduct.entries()]
    .map(([productId, revenue]) => {
      const p = products.get(productId);
      const pct = p ? marginOf(p.costPrice, p.sellPrice).pct : 0;
      return { productId, name: p?.name ?? "Removed product", revenue, estMargin: revenue * pct };
    })
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);
  return { income, expenses, net: income - expenses, byCategory, topProducts };
}

// ─── leakage — recurring drains + category spikes, deterministic ───────

export type Leak = {
  kind: "recurring" | "spike";
  label: string;
  category: string;
  monthlyEstimate: number;
  occurrences: number;
  detail: string;
};

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

export function findLeaks(ownerEmail: string, businessId = DEFAULT_BUSINESS_ID): Leak[] {
  const expenses = listTxns(ownerEmail, { businessId }).filter(t => t.type === "expense");
  if (expenses.length === 0) return [];
  const leaks: Leak[] = [];

  // Recurring: same normalized label in 3+ distinct months with a roughly
  // monthly cadence (median gap 25–35 days), latest occurrence recent
  // (within ~40 days) so dead subscriptions don't nag forever.
  const byLabel = new Map<string, BizTxn[]>();
  for (const t of expenses) {
    const key = normalizeLabel(t.label);
    if (!key) continue;
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key)!.push(t);
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  for (const [label, rows] of byLabel) {
    const months = [...new Set(rows.map(r => monthKey(r.date)))].sort();
    if (months.length < 3) continue;
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((Date.parse(sorted[i].date) - Date.parse(sorted[i - 1].date)) / 86_400_000);
    }
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    if (median < 25 || median > 35) continue;
    const latestGap = (Date.parse(todayStr) - Date.parse(sorted[sorted.length - 1].date)) / 86_400_000;
    if (latestGap > 40) continue;
    const monthlyEstimate = rows.reduce((s, r) => s + r.amount, 0) / Math.max(1, monthsBetween(months[0], months[months.length - 1]) + 1);
    leaks.push({
      kind: "recurring", label: sorted[sorted.length - 1].label, category: sorted[sorted.length - 1].category,
      monthlyEstimate: Math.round(monthlyEstimate * 100) / 100,
      occurrences: rows.length,
      detail: `${rows.length} charges across ${months.length} months`,
    });
  }

  // Spikes: this month's category total ≥ 2× the prior-3-month average,
  // with a minimum 20-unit movement in this workspace's currency.
  const cur = todayStr.slice(0, 7);
  const prior: string[] = [];
  {
    let [y, m] = cur.split("-").map(Number);
    for (let i = 0; i < 3; i++) {
      m -= 1;
      if (m < 1) { m = 12; y -= 1; }
      prior.unshift(`${y}-${String(m).padStart(2, "0")}`);
    }
  }
  const sumFor = (month: string, category: string) =>
    expenses.filter(t => monthKey(t.date) === month && t.category === category).reduce((s, t) => s + t.amount, 0);
  const categories = [...new Set(expenses.map(t => t.category))];
  for (const category of categories) {
    const thisMonth = sumFor(cur, category);
    if (thisMonth < 20) continue;
    const avg = prior.reduce((s, mo) => s + sumFor(mo, category), 0) / 3;
    if (avg < 10) continue; // no baseline — can't call it a spike
    if (thisMonth >= avg * 2) {
      leaks.push({
        kind: "spike", label: `${category} spending`, category,
        monthlyEstimate: Math.round((thisMonth - avg) * 100) / 100,
        occurrences: expenses.filter(t => monthKey(t.date) === cur && t.category === category).length,
        detail: `This month's spend is at least twice the recent average`,
      });
    }
  }

  return leaks.sort((a, b) => b.monthlyEstimate - a.monthlyEstimate);
}

// ─── forecast — burn, runway, 3-month projection ───────────────────────

export type Forecast = {
  monthsOfData: number;
  avgMonthlyIncome: number;
  avgMonthlyBurn: number;
  netMonthly: number;
  cashOnHand: number;
  runwayMonths: number | null; // null = not burning (no runway question)
  projection: { month: string; income: number; burn: number; cash: number }[];
};

export function forecastBiz(ownerEmail: string, businessId = DEFAULT_BUSINESS_ID): Forecast {
  const txns = listTxns(ownerEmail, { businessId });
  const { cashOnHand } = getSettings(ownerEmail, businessId);
  const byMonth = new Map<string, { income: number; burn: number }>();
  for (const t of txns) {
    const k = monthKey(t.date);
    if (!byMonth.has(k)) byMonth.set(k, { income: 0, burn: 0 });
    const b = byMonth.get(k)!;
    if (t.type === "income") b.income += t.amount;
    else b.burn += t.amount;
  }
  // Last up-to-6 months that actually have activity (skips dead gaps that
  // would drag the average toward zero and lie about the run rate).
  const keys = [...byMonth.keys()].sort().slice(-6);
  const monthsOfData = keys.length;
  const avgMonthlyIncome = monthsOfData ? keys.reduce((s, k) => s + byMonth.get(k)!.income, 0) / monthsOfData : 0;
  const avgMonthlyBurn = monthsOfData ? keys.reduce((s, k) => s + byMonth.get(k)!.burn, 0) / monthsOfData : 0;
  const netMonthly = avgMonthlyIncome - avgMonthlyBurn;
  // Runway only means something while burning more than comes in.
  const netBurn = Math.max(0, avgMonthlyBurn - avgMonthlyIncome);
  const runwayMonths = netBurn > 0 ? Math.floor(cashOnHand / netBurn * 10) / 10 : null;
  const projection: Forecast["projection"] = [];
  {
    let [y, m] = new Date().toISOString().slice(0, 7).split("-").map(Number);
    let cash = cashOnHand;
    for (let i = 0; i < 3; i++) {
      m += 1;
      if (m > 12) { m = 1; y += 1; }
      cash = Math.max(0, cash + netMonthly);
      projection.push({
        month: `${y}-${String(m).padStart(2, "0")}`,
        income: Math.round(avgMonthlyIncome * 100) / 100,
        burn: Math.round(avgMonthlyBurn * 100) / 100,
        cash: Math.round(cash * 100) / 100,
      });
    }
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    monthsOfData,
    avgMonthlyIncome: round2(avgMonthlyIncome),
    avgMonthlyBurn: round2(avgMonthlyBurn),
    netMonthly: round2(netMonthly),
    cashOnHand,
    runwayMonths,
    projection,
  };
}

// ─── approval settlement (called from the org-tasks resolve hook) ──────

// Resolve a spend approval end-to-end: runs the standard task transition,
// settles the parked finance row, and parks approved spends at "done"
// (the action is executed inline, so "active" would be a lie). Returns null
// when the task isn't a finance spend awaiting approval — the caller falls
// back to the generic path. Lazy cycle: org-tasks.ts (lib) never imports
// this module; only routes/org-tasks.ts does, dynamically.
export async function settleSpendApproval(
  taskId: string,
  approved: boolean,
  ownerEmail: string,
): Promise<{ task: import("./org-tasks.js").OrgTask | null; posted: BizTxn | null } | null> {
  // Dynamic import keeps the module graph acyclic for direct lib consumers
  // (tests import this file without pulling the whole org-task world).
  const org = await import("./org-tasks.js");
  const task = org.getOrgTask(taskId);
  if (!task || task.status !== "waiting-on-approval" || task.pendingApproval?.kind !== "spend") return null;
  const pendingId = parseFinancePendingRef(task.detail ?? "");
  if (!pendingId) return null;
  org.resolveApproval(taskId, approved);
  const posted = settlePendingSpend(ownerEmail, pendingId, approved);
  const finalTask = approved ? org.updateOrgTaskStatus(taskId, "done") : org.getOrgTask(taskId) ?? null;
  return { task: finalTask, posted };
}
