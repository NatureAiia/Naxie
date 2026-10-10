import { Router } from "express";
import { callerOf } from "../lib/access.js";
import { respond } from "../lib/respond.js";
import {
  listProducts, createProduct, updateProduct, deleteProduct, marginOf,
  listTxns, addTxn, deleteTxn,
  listPending, createPendingSpend,
  getSettings, updateSettings,
  listBusinesses, createBusiness, getBusiness,
  summarizeBiz, findLeaks, forecastBiz,
  buildFinanceTaskDetail,
  BIZ_CATEGORIES, PRODUCT_CATEGORIES,
} from "../lib/business-finance.js";
import { createOrgTask, requestApproval, setTaskDetail } from "../lib/org-tasks.js";

// "Business Finance" — the configured business's books: product price book, business
// income/expense, leakage scan, runway forecast, approval-gated big spends.
// Distinct from routes/personal-finance.ts (operator's own budget) and
// routes/public-finance.ts (Aria's market feed) — unrelated stores, never
// merged. Same per-caller ownerEmail scoping as routes/my-tasks.ts.

export const businessFinanceRouter = Router();

function ownerOf(req: any): string {
  return callerOf(req)?.email?.trim().toLowerCase() || "local";
}

function businessOf(req: any, res: any) {
  const owner = ownerOf(req);
  const id = String(req.query.businessId ?? req.body?.businessId ?? "default");
  const business = getBusiness(owner, id);
  if (!business) respond.error(res, 404, "business_not_found", "Business workspace not found");
  return business;
}

function validDate(date: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""));
}

const SUPPORTED_CURRENCIES = new Set(["USD", "ZAR", "GBP", "EUR", "CAD", "AUD", "NZD", "BWP"]);
function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
}
function hasFinancialData(owner: string, businessId: string): boolean {
  return listProducts(owner, { includeInactive: true, businessId }).length > 0 || listTxns(owner, { businessId }).length > 0 || listPending(owner, businessId).length > 0 || getSettings(owner, businessId).cashOnHand > 0;
}

businessFinanceRouter.get("/businesses", (req, res) => {
  const businesses = listBusinesses(ownerOf(req)).map(({ id, name, currency, createdAt }) => ({ id, name, currency, createdAt }));
  respond.ok(res, { businesses });
});

businessFinanceRouter.post("/businesses", (req, res) => {
  const { name, currency } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) return respond.error(res, 400, "invalid_input", "Business name is required");
  if (listBusinesses(ownerOf(req)).some(b => b.name.toLowerCase() === name.trim().toLowerCase())) return respond.error(res, 409, "business_exists", "A business with that name already exists");
  const currencyCode = String(currency || "USD").toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(currencyCode)) return respond.error(res, 400, "invalid_input", `currency must be one of: ${[...SUPPORTED_CURRENCIES].join(", ")}`);
  const { id, name: businessName, currency: businessCurrency, createdAt } = createBusiness(ownerOf(req), { name, currency: currencyCode });
  respond.ok(res, { business: { id, name: businessName, currency: businessCurrency, createdAt } }, 201);
});

// ─── price book ─────────────────────────────────────────────────────

businessFinanceRouter.get("/products", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  const products = listProducts(business.ownerEmail, { includeInactive: req.query.inactive === "1", businessId: business.id })
    .map(p => ({ ...p, margin: marginOf(p.costPrice, p.sellPrice) }));
  respond.ok(res, { products });
});

businessFinanceRouter.post("/products", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  const { name, category, costPrice, sellPrice, unit, notes } = req.body ?? {};
  if (!name || typeof name !== "string") return respond.error(res, 400, "invalid_input", "name is required");
  if (costPrice !== undefined && (!Number.isFinite(Number(costPrice)) || Number(costPrice) < 0)) {
    return respond.error(res, 400, "invalid_input", "costPrice must be a non-negative number");
  }
  if (sellPrice !== undefined && (!Number.isFinite(Number(sellPrice)) || Number(sellPrice) < 0)) {
    return respond.error(res, 400, "invalid_input", "sellPrice must be a non-negative number");
  }
  const product = createProduct(business.ownerEmail, {
    name, category,
    costPrice: Number(costPrice) || 0, sellPrice: Number(sellPrice) || 0,
    unit, notes,
  }, business.id);
  respond.ok(res, { product: { ...product, margin: marginOf(product.costPrice, product.sellPrice) } }, 201);
});

businessFinanceRouter.patch("/products/:id", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  const product = updateProduct(business.ownerEmail, req.params.id, req.body ?? {}, business.id);
  if (!product) return respond.empty(res, "product not found");
  respond.ok(res, { product: { ...product, margin: marginOf(product.costPrice, product.sellPrice) } });
});

businessFinanceRouter.delete("/products/:id", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  const ok = deleteProduct(business.ownerEmail, req.params.id, business.id);
  if (!ok) return respond.empty(res, "product not found");
  respond.ok(res, {});
});

// ─── transactions ───────────────────────────────────────────────────

businessFinanceRouter.get("/txns", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  const txns = listTxns(business.ownerEmail, { from: req.query.from as string, to: req.query.to as string, businessId: business.id });
  respond.ok(res, { txns });
});

businessFinanceRouter.post("/txns", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  const owner = business.ownerEmail;
  const { type, label, category, amount, date, productId } = req.body ?? {};
  if (!["income", "expense"].includes(type)) return respond.error(res, 400, "invalid_input", "type must be income or expense");
  if (!label || typeof label !== "string") return respond.error(res, 400, "invalid_input", "label is required");
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return respond.error(res, 400, "invalid_input", "amount must be a positive number");
  if (!validDate(date)) return respond.error(res, 400, "invalid_input", "date must be YYYY-MM-DD");
  if (productId && !listProducts(owner, { includeInactive: true, businessId: business.id }).some(p => p.id === productId)) {
    return respond.error(res, 400, "invalid_input", "productId must belong to the selected business workspace");
  }

  // Big spends park for approval instead of posting (IntelliRevenue-style
  // approval workflow, routed through the standard OrgTask inbox so the
  // Approvals page and this page share one resolution path —
  // routes/org-tasks.ts settles via settleSpendApproval()).
  if (type === "expense") {
    const { approvalThreshold, currency } = getSettings(owner, business.id);
    if (approvalThreshold > 0 && Number(amount) >= approvalThreshold) {
      const cleanLabel = label.trim().slice(0, 80);
      const task = createOrgTask({
        role: "admin",
        title: `Approve ${business.name}: ${cleanLabel} (${formatMoney(Number(amount), currency)})`,
        detail: "finance: composing…",
        priority: Number(amount) >= approvalThreshold * 3 ? "high" : "normal",
        createdBy: "user",
      });
      const pending = createPendingSpend(owner, {
        label, category: category || "Other", amount: Number(amount), date, taskId: task.id,
      }, business.id);
      // Link both directions (the task detail is what the resolve hook
      // parses — the pending row can't exist before the task does).
      setTaskDetail(task.id, buildFinanceTaskDetail(
        pending.id,
        `${business.name} — ${cleanLabel} — ${formatMoney(Number(amount), currency)} (${pending.category}, ${date})`,
      ));
      requestApproval(task.id, {
        actionDescription: `Record a ${formatMoney(Number(amount), currency)} business expense for "${cleanLabel}"?`,
        kind: "spend",
      });
      respond.ok(res, { pending, taskId: task.id, approvalRequired: true }, 202);
      return;
    }
  }

  const txn = addTxn(owner, { type, label, category: category || "Other", amount: Number(amount), date, productId }, business.id);
  respond.ok(res, { txn }, 201);
});

businessFinanceRouter.delete("/txns/:id", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  const ok = deleteTxn(business.ownerEmail, req.params.id, business.id);
  if (!ok) return respond.empty(res, "transaction not found");
  respond.ok(res, {});
});

businessFinanceRouter.get("/pending", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  respond.ok(res, { pending: listPending(business.ownerEmail, business.id) });
});

// ─── settings / insights ────────────────────────────────────────────

businessFinanceRouter.get("/settings", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  respond.ok(res, { settings: getSettings(business.ownerEmail, business.id), currencyLocked: hasFinancialData(business.ownerEmail, business.id), categories: BIZ_CATEGORIES, productCategories: PRODUCT_CATEGORIES });
});

businessFinanceRouter.patch("/settings", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  const owner = business.ownerEmail;
  const patch = req.body ?? {};
  if (patch.currency !== undefined) {
    const currency = String(patch.currency).toUpperCase();
    if (!SUPPORTED_CURRENCIES.has(currency)) return respond.error(res, 400, "invalid_input", `currency must be one of: ${[...SUPPORTED_CURRENCIES].join(", ")}`);
    if (currency !== getSettings(owner, business.id).currency && hasFinancialData(owner, business.id)) {
      return respond.error(res, 409, "currency_locked", "Currency cannot be changed after products or financial records exist, because existing amounts are stored in that currency.");
    }
    patch.currency = currency;
  }
  if (patch.businessName !== undefined && typeof patch.businessName !== "string") return respond.error(res, 400, "invalid_input", "businessName must be a string");
  if (typeof patch.businessName === "string" && listBusinesses(owner).some(b => b.id !== business.id && b.name.toLowerCase() === patch.businessName.trim().toLowerCase())) return respond.error(res, 409, "business_exists", "A business with that name already exists");
  respond.ok(res, { settings: updateSettings(owner, patch, business.id), currencyLocked: hasFinancialData(owner, business.id) });
});

businessFinanceRouter.get("/summary", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  respond.ok(res, { summary: summarizeBiz(business.ownerEmail, { from: req.query.from as string, to: req.query.to as string, businessId: business.id }) });
});

businessFinanceRouter.get("/leaks", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  respond.ok(res, { leaks: findLeaks(business.ownerEmail, business.id) });
});

businessFinanceRouter.get("/forecast", (req, res) => {
  const business = businessOf(req, res);
  if (!business) return;
  respond.ok(res, { forecast: forecastBiz(business.ownerEmail, business.id) });
});
