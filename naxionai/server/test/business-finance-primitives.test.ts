// finance.biz_* primitive handlers — thin wrappers over lib/business-finance.ts.
// The store seam keeps these hermetic; only direct-post paths are exercised
// here. Parking an over-threshold expense would write the real org-task
// store (no seam there), so that composition is covered by route behavior
// instead — see routes/business-finance.ts + the org-tasks settle hook.

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPrimitive } from "../src/lib/primitives.js";
import { _setStateFileForTests } from "../src/lib/business-finance.js";

beforeEach(() => {
  _setStateFileForTests(join(mkdtempSync(join(tmpdir(), "business-finance-prim-")), "store.json"));
});

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const prim = findPrimitive(name);
  expect(prim, `${name} registered`).toBeDefined();
  return await prim!.handler(args);
}

describe("finance.biz_* primitives", () => {
  it("records a sale, linking a price-book product by name", async () => {
    await call("finance.biz_product_add", { name: "Screen", cost: 25, sell: 50 });
    const r = await call("finance.biz_sale", { label: "Screen job", amount: 50, product: "screen" });
    expect(r.ok).toBe(true);
    expect(r.productLinked).toBe(true);
    expect(r.txn.type).toBe("income");
  });

  it("records a sub-threshold expense directly", async () => {
    const r = await call("finance.biz_expense", { label: "Fuel", amount: 20, category: "Transport" });
    expect(r.ok).toBe(true);
    expect(r.parked).toBe(false);
    expect(r.txn.type).toBe("expense");
  });

  it("looks up prices and scans leaks + forecast", async () => {
    await call("finance.biz_product_add", { name: "Charger", cost: 5, sell: 15 });
    const price = await call("finance.biz_price", { query: "charg" });
    expect(price.products).toHaveLength(1);
    expect(price.products[0].margin).toEqual({ amount: 10, pct: 10 / 15 });
    const leaks = await call("finance.biz_leaks", {});
    expect(leaks.ok).toBe(true);
    expect(Array.isArray(leaks.leaks)).toBe(true);
    const forecast = await call("finance.biz_forecast", {});
    expect(forecast.ok).toBe(true);
    expect(forecast.forecast.monthsOfData).toBe(0);
  });

  it("rejects bad input without writing", async () => {
    expect((await call("finance.biz_sale", { label: "", amount: 10 })).error).toBeTruthy();
    expect((await call("finance.biz_expense", { label: "X", amount: -5 })).error).toBeTruthy();
    expect((await call("finance.biz_price", { query: "" })).error).toBeTruthy();
  });
});
