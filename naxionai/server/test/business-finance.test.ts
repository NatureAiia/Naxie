// "Business Finance" — price book, txns, pending spends, leakage, forecast
// (lib/business-finance.ts). Points the store at a scratch file per test so
// nothing touches the real .neuroworks/ state. Org-task creation is the
// route layer's job, so these tests never touch the org-task store —
// settlePendingSpend() is pure finance-store movement.

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createProduct, listProducts, updateProduct, deleteProduct, marginOf,
  addTxn, listTxns, deleteTxn,
  createPendingSpend, listPending, settlePendingSpend,
  buildFinanceTaskDetail, parseFinancePendingRef,
  getSettings, updateSettings,
  summarizeBiz, findLeaks, forecastBiz,
  _setStateFileForTests,
} from "../src/lib/business-finance.js";

const owner = "operator@example.com";

function monthsAgo(n: number, day = 15): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setDate(Math.min(day, 28));
  return d.toISOString().slice(0, 10);
}

beforeEach(() => {
  _setStateFileForTests(join(mkdtempSync(join(tmpdir(), "business-finance-")), "store.json"));
});

describe("price book CRUD + margin", () => {
  it("creates, lists, updates and deletes a product", () => {
    const p = createProduct(owner, { name: "Screen replacement", category: "Repair", costPrice: 25, sellPrice: 60 });
    expect(listProducts(owner)).toHaveLength(1);
    const updated = updateProduct(owner, p.id, { sellPrice: 70 })!;
    expect(marginOf(updated.costPrice, updated.sellPrice)).toEqual({ amount: 45, pct: 45 / 70 });
    expect(deleteProduct(owner, p.id)).toBe(true);
    expect(listProducts(owner)).toHaveLength(0);
  });

  it("computes margin amount and ratio, zero-safe on free items", () => {
    expect(marginOf(25, 60)).toEqual({ amount: 35, pct: 35 / 60 });
    expect(marginOf(0, 0)).toEqual({ amount: 0, pct: 0 });
  });

  it("deleting a product unlinks (not deletes) its sale rows", () => {
    const p = createProduct(owner, { name: "Charger", costPrice: 5, sellPrice: 15 });
    addTxn(owner, { type: "income", label: "Sold charger", category: "Sales", amount: 15, date: monthsAgo(0), productId: p.id });
    expect(deleteProduct(owner, p.id)).toBe(true);
    const [txn] = listTxns(owner);
    expect(txn.productId).toBeUndefined();
    expect(txn.label).toBe("Sold charger");
  });
});

describe("pending big spends", () => {
  it("parks and posts on approve, drops on reject", () => {
    const pending = createPendingSpend(owner, { label: "Bulk screens", category: "Stock", amount: 500, date: monthsAgo(0), taskId: "task-1" });
    expect(listPending(owner)).toHaveLength(1);
    const posted = settlePendingSpend(owner, pending.id, true)!;
    expect(posted.type).toBe("expense");
    expect(posted.amount).toBe(500);
    expect(listPending(owner)).toHaveLength(0);
    expect(listTxns(owner)).toHaveLength(1);
  });

  it("reject drops without posting", () => {
    const pending = createPendingSpend(owner, { label: "New signage", category: "Marketing", amount: 300, date: monthsAgo(0), taskId: "task-2" });
    expect(settlePendingSpend(owner, pending.id, false)).toBeNull();
    expect(listTxns(owner)).toHaveLength(0);
    expect(listPending(owner)).toHaveLength(0);
  });

  it("unknown ids settle to null without throwing", () => {
    expect(settlePendingSpend(owner, "nope", true)).toBeNull();
    expect(settlePendingSpend("someone-else@example.com", "nope", true)).toBeNull();
  });

  it("round-trips the task-detail link", () => {
    const detail = buildFinanceTaskDetail("pend-123", "Bulk screens — $500");
    expect(parseFinancePendingRef(detail)).toBe("pend-123");
    expect(parseFinancePendingRef("unrelated detail")).toBeNull();
  });
});

describe("leakage detection", () => {
  it("flags a monthly recurring drain across 3+ months", () => {
    for (let i = 0; i < 4; i++) {
      addTxn(owner, { type: "expense", label: "DSTV Business", category: "Utilities", amount: 50, date: monthsAgo(i, 5) });
    }
    const leaks = findLeaks(owner).filter(l => l.kind === "recurring");
    expect(leaks).toHaveLength(1);
    expect(leaks[0].monthlyEstimate).toBeCloseTo(50, 0);
  });

  it("ignores one-offs and dead subscriptions", () => {
    addTxn(owner, { type: "expense", label: "One-off repair tool", category: "Maintenance", amount: 90, date: monthsAgo(0) });
    addTxn(owner, { type: "expense", label: "Old domain", category: "Fees", amount: 12, date: monthsAgo(5) });
    addTxn(owner, { type: "expense", label: "Old domain", category: "Fees", amount: 12, date: monthsAgo(6) });
    addTxn(owner, { type: "expense", label: "Old domain", category: "Fees", amount: 12, date: monthsAgo(7) });
    const recurring = findLeaks(owner).filter(l => l.kind === "recurring");
    expect(recurring).toHaveLength(0);
  });

  it("flags a category spike at 2x baseline", () => {
    for (let i = 1; i <= 3; i++) {
      addTxn(owner, { type: "expense", label: `Fuel ${i}`, category: "Transport", amount: 40, date: monthsAgo(i, 10) });
    }
    addTxn(owner, { type: "expense", label: "Fuel run", category: "Transport", amount: 120, date: monthsAgo(0, 10) });
    const spikes = findLeaks(owner).filter(l => l.kind === "spike" && l.category === "Transport");
    expect(spikes).toHaveLength(1);
  });
});

describe("forecast", () => {
  it("computes burn, runway and a 3-month projection", () => {
    updateSettings(owner, { cashOnHand: 1000 });
    for (let i = 0; i < 3; i++) {
      addTxn(owner, { type: "income", label: "Repairs", category: "Sales", amount: 800, date: monthsAgo(i, 3) });
      addTxn(owner, { type: "expense", label: "Rent", category: "Rent", amount: 500, date: monthsAgo(i, 5) });
    }
    const f = forecastBiz(owner);
    expect(f.monthsOfData).toBe(3);
    expect(f.avgMonthlyIncome).toBeCloseTo(800, 5);
    expect(f.avgMonthlyBurn).toBeCloseTo(500, 5);
    expect(f.runwayMonths).toBeNull(); // cashflow positive — no runway question
    expect(f.projection).toHaveLength(3);
  });

  it("reports runway while burning", () => {
    updateSettings(owner, { cashOnHand: 600 });
    addTxn(owner, { type: "income", label: "Repairs", category: "Sales", amount: 200, date: monthsAgo(0, 3) });
    addTxn(owner, { type: "expense", label: "Rent", category: "Rent", amount: 500, date: monthsAgo(0, 5) });
    const f = forecastBiz(owner);
    expect(f.runwayMonths).toBeCloseTo(2, 5); // 600 / 300 net burn
  });

  it("empty books forecast zeros, not NaN", () => {
    const f = forecastBiz(owner);
    expect(f.monthsOfData).toBe(0);
    expect(f.runwayMonths).toBeNull();
    expect(f.projection).toHaveLength(3);
  });
});

describe("summary + settings", () => {
  it("summarizes net, categories and top products with margin", () => {
    const p = createProduct(owner, { name: "Screen", costPrice: 25, sellPrice: 50 });
    addTxn(owner, { type: "income", label: "Screen job", category: "Sales", amount: 50, date: monthsAgo(0), productId: p.id });
    addTxn(owner, { type: "expense", label: "Rent", category: "Rent", amount: 20, date: monthsAgo(0) });
    const s = summarizeBiz(owner);
    expect(s.net).toBe(30);
    expect(s.byCategory[0]).toEqual({ category: "Rent", amount: 20 });
    expect(s.topProducts[0]).toMatchObject({ name: "Screen", revenue: 50, estMargin: 25 });
  });

  it("stores threshold and cash settings with sane defaults", () => {
    expect(getSettings(owner)).toEqual({ approvalThreshold: 200, cashOnHand: 0 });
    expect(updateSettings(owner, { approvalThreshold: 500, cashOnHand: 1200 })).toEqual({ approvalThreshold: 500, cashOnHand: 1200 });
    expect(updateSettings(owner, { approvalThreshold: -5 })).toMatchObject({ approvalThreshold: 0 });
  });
});
