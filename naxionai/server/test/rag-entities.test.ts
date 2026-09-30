import { describe, it, expect } from "vitest";
import { extractEntities, extractKeywords, entityOverlapBoost, parseFileMeta, riskFlags } from "../src/lib/rag-entities.js";

describe("rag-entities", () => {
  it("extracts emails, phones, amounts, dates", () => {
    const ents = extractEntities("Contact ada@example.com or 0712-345-678 on 2026-09-01 for $1,200 dollars.");
    expect(ents.emails).toContain("ada@example.com");
    expect(ents.dates.length).toBeGreaterThan(0);
    expect(ents.amounts.length).toBeGreaterThan(0);
  });

  it("extracts keywords minus stopwords", () => {
    const kws = extractKeywords("The procurement contract for road construction needs approval", 5);
    expect(kws).toContain("procurement");
    expect(kws).not.toContain("the");
  });

  it("boosts on entity overlap", () => {
    const chunk = { emails: ["ada@example.com"], phones: [], amounts: [], dates: [], keywords: [] };
    expect(entityOverlapBoost("email ada@example.com", chunk as any)).toBeGreaterThan(0);
    expect(entityOverlapBoost("something unrelated entirely", chunk as any)).toBe(0);
  });

  it("parses frontmatter governance meta", () => {
    const meta = parseFileMeta("---\ntitle: Deed\nretention: 7y\ncreated: 2020-01-15\nlocation: Block A / Shelf 3\nsensitivity: Highly Confidential\n---\n\n# Deed\n");
    expect(meta.location).toMatch(/Block A/);
    expect(meta.sensitivity).toMatch(/highly/);
    expect(meta.expiryDate).toBe("2027-01-15");
  });

  it("flags sensitive + expired retention", () => {
    const flags = riskFlags({ sensitivity: "highly confidential", expiryDate: "2020-01-01" }, "hello");
    expect(flags).toContain("sensitive");
    expect(flags).toContain("retention-expired");
  });
});
