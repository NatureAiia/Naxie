import { Router } from "express";
import { callerOf } from "../lib/access.js";
import { respond } from "../lib/respond.js";
import {
  listProducts, createProduct, updateProduct, deleteProduct, marginOf,
  listTxns, addTxn, deleteTxn,
  listPending, createPendingSpend,
  getSettings, updateSettings,
  summarizeBiz, findLeaks, forecastBiz,
  buildFinanceTaskDetail,
  BIZ_CATEGORIES, PRODUCT_CATEGORIES,
} from "../lib/business-finance.js";
import { createOrgTask, requestApproval, setTaskDetail } from "../lib/org-tasks.js";

// "Business Finance" — Variety & Co's books: product price book, business
// income/expense, leakage scan, runway forecast, approval-gated big spends.
// Distinct from routes/personal-finance.ts (operator's own budget) and
// routes/public-finance.ts (Aria's market feed) — unrelated stores, never
// merged. Same per-caller ownerEmail scoping as routes/my-tasks.ts.

export const businessFinanceRouter = Router();

function ownerOf(req: any): string {
  return callerOf(req)?.email?.trim().toLowerCase() || "local";
}

function validDate(date: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ""));
}

// ─── price book ─────────────────────────────────────────────────────

businessFinanceRouter.get("/products", (req, res) => {
  const products = listProducts(ownerOf(req), { includeInactive: req.query.inactive === "1" })
    .map(p => ({ ...p, margin: marginOf(p.costPrice, p.sellPrice) }));
  respond.ok(res, { products });
});

businessFinanceRouter.post("/products", (req, res) => {
  const { name, category, costPrice, sellPrice, unit, notes } = req.body ?? {};
  if (!name || typeof name !== "string") return respond.error(res, 400, "invalid_input", "name is required");
  if (costPrice !== undefined && (!Number.isFinite(Number(costPrice)) || Number(costPrice) < 0)) {
    return respond.error(res, 400, "invalid_input", "costPrice must be a non-negative number");
  }
  if (sellPrice !== undefined && (!Number.isFinite(Number(sellPrice)) || Number(sellPrice) < 0)) {
    return respond.error(res, 400, "invalid_input", "sellPrice must be a non-negative number");
  }
  const product = createProduct(ownerOf(req), {
    name, category,
    costPrice: Number(costPrice) || 0, sellPrice: Number(sellPrice) || 0,
    unit, notes,
  });
  respond.ok(res, { product: { ...product, margin: marginOf(product.costPrice, product.sellPrice) } }, 201);
});

businessFinanceRouter.patch("/products/:id", (req, res) => {
  const product = updateProduct(ownerOf(req), req.params.id, req.body ?? {});
  if (!product) return respond.empty(res, "product not found");
  respond.ok(res, { product: { ...product, margin: marginOf(product.costPrice, product.sellPrice) } });
});

businessFinanceRouter.delete("/products/:id", (req, res) => {
  const ok = deleteProduct(ownerOf(req), req.params.id);
  if (!ok) return respond.empty(res, "product not found");
  respond.ok(res, {});
});

// ─── transactions ───────────────────────────────────────────────────

businessFinanceRouter.get("/txns", (req, res) => {
  const txns = listTxns(ownerOf(req), { from: req.query.from as string, to: req.query.to as string });
  respond.ok(res, { txns });
});

businessFinanceRouter.post("/txns", (req, res) => {
  const owner = ownerOf(req);
  const { type, label, category, amount, date, productId } = req.body ?? {};
  if (!["income", "expense"].includes(type)) return respond.error(res, 400, "invalid_input", "type must be income or expense");
  if (!label || typeof label !== "string") return respond.error(res, 400, "invalid_input", "label is required");
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return respond.error(res, 400, "invalid_input", "amount must be a positive number");
  if (!validDate(date)) return respond.error(res, 400, "invalid_input", "date must be YYYY-MM-DD");

  // Big spends park for approval instead of posting (IntelliRevenue-style
  // approval workflow, routed through the standard OrgTask inbox so the
  // Approvals page and this page share one resolution path —
  // routes/org-tasks.ts settles via settleSpendApproval()).
  if (type === "expense") {
    const { approvalThreshold } = getSettings(owner);
    if (approvalThreshold > 0 && Number(amount) >= approvalThreshold) {
      const cleanLabel = label.trim().slice(0, 80);
      const task = createOrgTask({
        role: "admin",
        title: `Approve expense: ${cleanLabel} ($${Number(amount)})`,
        detail: "finance: composing…",
        priority: Number(amount) >= approvalThreshold * 3 ? "high" : "normal",
        createdBy: "user",
      });
      const pending = createPendingSpend(owner, {
        label, category: category || "Other", amount: Number(amount), date, taskId: task.id,
      });
      // Link both directions (the task detail is what the resolve hook
      // parses — the pending row can't exist before the task does).
      setTaskDetail(task.id, buildFinanceTaskDetail(
        pending.id,
        `${cleanLabel} — $${Number(amount)} (${pending.category}, ${date})`,
      ));
      requestApproval(task.id, {
        actionDescription: `Record a $${Number(amount)} business expense for "${cleanLabel}"?`,
        kind: "spend",
      });
      respond.ok(res, { pending, taskId: task.id, approvalRequired: true }, 202);
      return;
    }
  }

  const txn = addTxn(owner, { type, label, category: category || "Other", amount: Number(amount), date, productId });
  respond.ok(res, { txn }, 201);
});

businessFinanceRouter.delete("/txns/:id", (req, res) => {
  const ok = deleteTxn(ownerOf(req), req.params.id);
  if (!ok) return respond.empty(res, "transaction not found");
  respond.ok(res, {});
});

businessFinanceRouter.get("/pending", (req, res) => {
  respond.ok(res, { pending: listPending(ownerOf(req)) });
});

// ─── settings / insights ────────────────────────────────────────────

businessFinanceRouter.get("/settings", (req, res) => {
  respond.ok(res, { settings: getSettings(ownerOf(req)), categories: BIZ_CATEGORIES, productCategories: PRODUCT_CATEGORIES });
});

businessFinanceRouter.patch("/settings", (req, res) => {
  respond.ok(res, { settings: updateSettings(ownerOf(req), req.body ?? {}) });
});

businessFinanceRouter.get("/summary", (req, res) => {
  const owner = ownerOf(req);
  respond.ok(res, { summary: summarizeBiz(owner, { from: req.query.from as string, to: req.query.to as string }) });
});

businessFinanceRouter.get("/leaks", (req, res) => {
  respond.ok(res, { leaks: findLeaks(ownerOf(req)) });
});

businessFinanceRouter.get("/forecast", (req, res) => {
  respond.ok(res, { forecast: forecastBiz(ownerOf(req)) });
});
