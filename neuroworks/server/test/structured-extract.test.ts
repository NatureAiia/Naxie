import { describe, expect, it } from "vitest";
import { extractJsonLd, findJsonLdByType, extractPriceFromText } from "../src/lib/structured-extract.js";

describe("extractJsonLd", () => {
  it("parses a bare JSON-LD object", () => {
    const html = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Widget"}</script></head></html>`;
    const blocks = extractJsonLd(html);
    expect(blocks).toEqual([{ "@type": "Product", name: "Widget" }]);
  });

  it("flattens an array of JSON-LD objects", () => {
    const html = `<script type="application/ld+json">[{"@type":"Product","name":"A"},{"@type":"Product","name":"B"}]</script>`;
    expect(extractJsonLd(html)).toHaveLength(2);
  });

  it("flattens @graph wrappers", () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"Acme"},{"@type":"WebSite","name":"acme.com"}]}</script>`;
    const blocks = extractJsonLd(html);
    expect(blocks.map(b => b["@type"])).toEqual(["Organization", "WebSite"]);
  });

  it("skips a malformed block without throwing, keeping good ones", () => {
    const html = `
      <script type="application/ld+json">{not valid json}</script>
      <script type="application/ld+json">{"@type":"Article","headline":"Hi"}</script>
    `;
    expect(extractJsonLd(html)).toEqual([{ "@type": "Article", headline: "Hi" }]);
  });

  it("returns [] when there is no JSON-LD at all", () => {
    expect(extractJsonLd("<html><body>plain page</body></html>")).toEqual([]);
  });

  it("findJsonLdByType filters case-insensitively and handles @type arrays", () => {
    const blocks = [
      { "@type": "Product", name: "A" },
      { "@type": ["Thing", "product"], name: "B" },
      { "@type": "Article", name: "C" },
    ];
    expect(findJsonLdByType(blocks, "Product").map(b => b.name)).toEqual(["A", "B"]);
  });
});

describe("extractPriceFromText", () => {
  it("finds a dollar-symbol price", () => {
    expect(extractPriceFromText("Now only $49.99 for the pro plan")).toEqual({ amount: 49.99, currency: "USD", raw: "$49.99" });
  });

  it("applies a k suffix", () => {
    const r = extractPriceFromText("Starting at $1.2k per month");
    expect(r).toMatchObject({ amount: 1200, currency: "USD" });
  });

  it("finds a currency-code price with the number first", () => {
    const r = extractPriceFromText("Total: 450 ZWL for the bundle");
    expect(r).toMatchObject({ amount: 450, currency: "ZWL" });
  });

  it("finds a currency-code price with the code first", () => {
    const r = extractPriceFromText("Price EUR 99 today");
    expect(r).toMatchObject({ amount: 99, currency: "EUR" });
  });

  it("ignores a price-shaped number inside a copyright/footer context", () => {
    expect(extractPriceFromText("Copyright © 2026 Acme Inc. $5 million raised to date.")).toBeNull();
  });

  it("returns null when nothing price-shaped is present", () => {
    expect(extractPriceFromText("No pricing information on this page.")).toBeNull();
  });
});
