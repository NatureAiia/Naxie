import { describe, expect, it } from "vitest";
import { renderTemplate, resolveTokenPath } from "../src/lib/flow-mapper.js";

const ctx = {
  trigger: { body: { customer_email: "a@x.com", items: [{ sku: "A1" }, { sku: "B2" }] }, headers: { "x-sig": "abc" } },
  steps: { s1: { body: { url: "https://example.com/1", count: 3 } } },
};

describe("flow-mapper", () => {
  it("resolves a nested trigger token", () => {
    const r = renderTemplate({ to: "{{$.trigger.body.customer_email}}" }, ctx);
    expect(r.resolved).toEqual({ to: "a@x.com" });
    expect(r.warnings).toEqual([]);
  });

  it("preserves raw type for a full-token number", () => {
    const r = renderTemplate("{{$.steps.s1.body.count}}", ctx);
    expect(r.resolved).toBe(3);
  });

  it("indexes arrays and interpolates inside text", () => {
    const r = renderTemplate("sku={{$.trigger.body.items.1.sku}}!", ctx);
    expect(r.resolved).toBe("sku=B2!");
  });

  it("leaves missing paths empty with a warning", () => {
    const r = renderTemplate("hi {{$.trigger.body.nope}}", ctx);
    expect(r.resolved).toBe("hi ");
    expect(r.warnings.length).toBe(1);
  });

  it("treats prototype pollution as inert", () => {
    const r = resolveTokenPath("$.trigger.constructor", ctx);
    expect(r.found).toBe(false);
    const r2 = renderTemplate({ ["__proto__" as string]: "x", ok: "y" }, ctx);
    expect((r2.resolved as any).ok).toBe("y");
    expect(r2.warnings.join()).toMatch(/forbidden/);
  });

  it("honours \\{{ escapes", () => {
    const r = renderTemplate("\\{{$.trigger.body.customer_email}}", ctx);
    expect(r.resolved).toBe("{{$.trigger.body.customer_email}}");
  });

  it("stringifies objects in interpolated position", () => {
    const r = renderTemplate("items={{$.trigger.body.items}}", ctx);
    expect(typeof r.resolved).toBe("string");
    expect(r.resolved as string).toContain("A1");
  });
});
