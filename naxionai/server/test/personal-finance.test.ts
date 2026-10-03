// "My Finances" — personal savings plans + income/expense tracking
// (lib/personal-finance.ts), ported from KimmyDeku/sebastian's Money
// suite. Points the store at a scratch file per test so nothing touches
// the real .naxion/ state.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createPlan, listPlans, updatePlan, deletePlan, addDeposit, planProgress,
  addTxn, listTxns, deleteTxn, summarize, assessmentSystemPrompt, _setStateFileForTests,
} from "../src/lib/personal-finance.js";

const owner = "operator@example.com";

beforeEach(() => {
  _setStateFileForTests(join(mkdtempSync(join(tmpdir(), "personal-finance-")), "store.json"));
});

describe("savings plans CRUD round-trip", () => {
  it("creates, lists, updates and deletes a plan", () => {
    const plan = createPlan(owner, { name: "New laptop", target: 1000, frequency: "monthly", commitment: 100 });
    expect(listPlans(owner)).toHaveLength(1);
    const updated = updatePlan(owner, plan.id, { commitment: 150 });
    expect(updated?.commitment).toBe(150);
    expect(deletePlan(owner, plan.id)).toBe(true);
    expect(listPlans(owner)).toHaveLength(0);
  });

  it("scopes plans per operator — one owner never sees another's", () => {
    createPlan(owner, { name: "A", target: 100, frequency: "flexible", commitment: 10 });
    createPlan("someone-else@example.com", { name: "B", target: 100, frequency: "flexible", commitment: 10 });
    expect(listPlans(owner)).toHaveLength(1);
    expect(listPlans(owner)[0].name).toBe("A");
  });

  it("archived plans are excluded by default, included on request", () => {
    const plan = createPlan(owner, { name: "Old goal", target: 100, frequency: "flexible", commitment: 10 });
    updatePlan(owner, plan.id, { archived: true });
    expect(listPlans(owner)).toHaveLength(0);
    expect(listPlans(owner, { includeArchived: true })).toHaveLength(1);
  });

  it("tracks deposits and computes progress", () => {
    const plan = createPlan(owner, { name: "Emergency fund", target: 500, frequency: "weekly", commitment: 50 });
    addDeposit(owner, plan.id, 100);
    const updated = addDeposit(owner, plan.id, 150)!;
    const { saved, pct } = planProgress(updated);
    expect(saved).toBe(250);
    expect(pct).toBeCloseTo(0.5);
  });

  it("caps progress at 100% even when deposits exceed the target", () => {
    const plan = createPlan(owner, { name: "Small goal", target: 100, frequency: "flexible", commitment: 10 });
    const updated = addDeposit(owner, plan.id, 500)!;
    expect(planProgress(updated).pct).toBe(1);
  });
});

describe("transactions and summary arithmetic", () => {
  it("round-trips transactions and computes totals/net", () => {
    addTxn(owner, { type: "income", label: "Salary", category: "Income", amount: 2000, date: "2026-01-01" });
    addTxn(owner, { type: "expense", label: "Rent", category: "Housing", amount: 800, date: "2026-01-02" });
    addTxn(owner, { type: "expense", label: "Groceries", category: "Groceries", amount: 300, date: "2026-01-03" });
    const s = summarize(owner);
    expect(s.income).toBe(2000);
    expect(s.expenses).toBe(1100);
    expect(s.net).toBe(900);
  });

  it("category breakdown sums exactly match total expenses", () => {
    addTxn(owner, { type: "expense", label: "Rent", category: "Housing", amount: 800, date: "2026-01-02" });
    addTxn(owner, { type: "expense", label: "Electricity", category: "Housing", amount: 100, date: "2026-01-05" });
    addTxn(owner, { type: "expense", label: "Groceries", category: "Groceries", amount: 300, date: "2026-01-03" });
    const s = summarize(owner);
    const total = s.byCategory.reduce((sum, c) => sum + c.amount, 0);
    expect(total).toBe(s.expenses);
    expect(s.byCategory[0]).toEqual({ category: "Housing", amount: 900 });
  });

  it("computes the 50/30/20 split from income alone", () => {
    addTxn(owner, { type: "income", label: "Salary", category: "Income", amount: 1000, date: "2026-01-01" });
    const s = summarize(owner);
    expect(s.fiftyThirtyTwenty).toEqual({ needs: 500, wants: 300, save: 200 });
  });

  it("filters by date range", () => {
    addTxn(owner, { type: "income", label: "Jan pay", category: "Income", amount: 100, date: "2026-01-15" });
    addTxn(owner, { type: "income", label: "Feb pay", category: "Income", amount: 200, date: "2026-02-15" });
    expect(summarize(owner, { from: "2026-02-01", to: "2026-02-28" }).income).toBe(200);
    expect(listTxns(owner, { from: "2026-01-01", to: "2026-01-31" })).toHaveLength(1);
  });

  it("deletes a transaction", () => {
    const t = addTxn(owner, { type: "expense", label: "Coffee", category: "Other", amount: 5, date: "2026-01-01" });
    expect(deleteTxn(owner, t.id)).toBe(true);
    expect(listTxns(owner)).toHaveLength(0);
    expect(deleteTxn(owner, "nope")).toBe(false);
  });
});

describe("assessmentSystemPrompt — the non-advice framing, every call", () => {
  it("always states this is guidance, not regulated advice, and never promises returns", () => {
    const prompt = assessmentSystemPrompt();
    expect(prompt).toMatch(/not regulated financial advice/i);
    expect(prompt).toMatch(/never promise returns/i);
    expect(prompt).toMatch(/licensed professional/i);
  });

  it("is deterministic — routes/personal-finance.ts can never send a caller-supplied override", () => {
    expect(assessmentSystemPrompt()).toBe(assessmentSystemPrompt());
  });
});
