import { Router } from "express";
import { callerOf } from "../lib/access.js";
import { respond } from "../lib/respond.js";
import {
  listPlans, createPlan, updatePlan, deletePlan, addDeposit, planProgress,
  listTxns, addTxn, deleteTxn, summarize, EXPENSE_CATEGORIES, assessmentSystemPrompt,
} from "../lib/personal-finance.js";

// "My Finances" — the operator's OWN budget (savings plans + income/expense
// tracking). Distinct from routes/public-finance.ts (Aria's company/market
// finance feed) — unrelated stores, never merged. Same per-caller ownerEmail
// scoping as routes/my-tasks.ts.

export const personalFinanceRouter = Router();

function ownerOf(req: any): string {
  return callerOf(req)?.email?.trim().toLowerCase() || "local";
}

personalFinanceRouter.get("/categories", (_req, res) => {
  respond.ok(res, { categories: EXPENSE_CATEGORIES });
});

personalFinanceRouter.get("/plans", (req, res) => {
  const owner = ownerOf(req);
  const plans = listPlans(owner, { includeArchived: req.query.archived === "1" }).map(p => ({ ...p, progress: planProgress(p) }));
  respond.ok(res, { plans });
});

personalFinanceRouter.post("/plans", (req, res) => {
  const { name, target, frequency, commitment } = req.body ?? {};
  if (!name || typeof name !== "string") return respond.error(res, 400, "invalid_input", "name is required");
  if (!["weekly", "monthly", "flexible"].includes(frequency)) return respond.error(res, 400, "invalid_input", "frequency must be weekly, monthly or flexible");
  const plan = createPlan(ownerOf(req), { name, target: Number(target) || 0, frequency, commitment: Number(commitment) || 0 });
  respond.ok(res, { plan: { ...plan, progress: planProgress(plan) } }, 201);
});

personalFinanceRouter.patch("/plans/:id", (req, res) => {
  const plan = updatePlan(ownerOf(req), req.params.id, req.body ?? {});
  if (!plan) return respond.empty(res, "plan not found");
  respond.ok(res, { plan: { ...plan, progress: planProgress(plan) } });
});

personalFinanceRouter.delete("/plans/:id", (req, res) => {
  const ok = deletePlan(ownerOf(req), req.params.id);
  if (!ok) return respond.empty(res, "plan not found");
  respond.ok(res, {});
});

personalFinanceRouter.post("/plans/:id/deposits", (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return respond.error(res, 400, "invalid_input", "amount must be a positive number");
  const plan = addDeposit(ownerOf(req), req.params.id, amount, req.body?.note);
  if (!plan) return respond.empty(res, "plan not found");
  respond.ok(res, { plan: { ...plan, progress: planProgress(plan) } });
});

personalFinanceRouter.get("/txns", (req, res) => {
  const owner = ownerOf(req);
  const txns = listTxns(owner, { from: req.query.from as string, to: req.query.to as string });
  respond.ok(res, { txns });
});

personalFinanceRouter.post("/txns", (req, res) => {
  const { type, label, category, amount, date } = req.body ?? {};
  if (!["income", "expense"].includes(type)) return respond.error(res, 400, "invalid_input", "type must be income or expense");
  if (!label || typeof label !== "string") return respond.error(res, 400, "invalid_input", "label is required");
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return respond.error(res, 400, "invalid_input", "amount must be a positive number");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return respond.error(res, 400, "invalid_input", "date must be YYYY-MM-DD");
  const txn = addTxn(ownerOf(req), { type, label, category: category || "Other", amount: Number(amount), date });
  respond.ok(res, { txn }, 201);
});

personalFinanceRouter.delete("/txns/:id", (req, res) => {
  const ok = deleteTxn(ownerOf(req), req.params.id);
  if (!ok) return respond.empty(res, "transaction not found");
  respond.ok(res, {});
});

personalFinanceRouter.get("/summary", (req, res) => {
  const owner = ownerOf(req);
  const summary = summarize(owner, { from: req.query.from as string, to: req.query.to as string });
  respond.ok(res, { summary });
});

// Explicitly user-triggered (a button, never automatic) — non-advice framing
// carried at every layer: here in the system prompt, again as a persistent
// Notice under the result in the UI, and again in the page subtitle.
personalFinanceRouter.post("/assess", async (req, res) => {
  const owner = ownerOf(req);
  const summary = summarize(owner, { from: req.query.from as string, to: req.query.to as string });
  try {
    const { llmGenerateWithMeta } = await import("../lib/llm.js");
    const system = assessmentSystemPrompt();
    const prompt = `Review this period's recorded income/expenses: ${JSON.stringify(summary)}`;
    const out = await llmGenerateWithMeta(prompt, system, { profile: "synthesis", maxTokens: 800 });
    const first = out.text.indexOf("{");
    const last = out.text.lastIndexOf("}");
    const parsed = first >= 0 && last > first ? JSON.parse(out.text.slice(first, last + 1)) : null;
    if (!parsed) return respond.error(res, 502, "ai_unavailable", "Could not parse an assessment from the model's answer.");
    respond.ok(res, {
      assessment: {
        headline: String(parsed.headline ?? ""),
        savingsPlan: Array.isArray(parsed.savingsPlan) ? parsed.savingsPlan.map(String) : [],
        cutBack: Array.isArray(parsed.cutBack) ? parsed.cutBack.map(String) : [],
      },
    });
  } catch (e: any) {
    respond.error(res, 502, "ai_unavailable", String(e?.message ?? e));
  }
});
