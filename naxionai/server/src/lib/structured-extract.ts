// Structured-data extraction from raw HTML/text — schema.org/JSON-LD parsing
// and a generic price-in-text heuristic. Ported (as a pattern, not code —
// the omnis-signal original is BeautifulSoup/DOM-tree based, this codebase
// has no DOM library, see web-client.ts's own regex-based extractReadable())
// from omnis-signal's "Scraper Hub" BaseExtractor: reading a page's own
// declared structured data is strictly more reliable than guessing from
// visible text, for any page that publishes it (most product pages,
// articles, org/event pages).
//
// Pure functions — no fetching, no SSRF surface of their own. Callers
// (web-client.ts, omnisignal.ts) hand this already-fetched HTML/text.

const JSON_LD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// Flattens a JSON-LD block into a list of plain objects. Handles the three
// shapes actually seen in the wild: a bare object, an array of objects, and
// an object carrying "@graph": [...] (common on WordPress/Yoast output).
function flattenJsonLdValue(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.flatMap(flattenJsonLdValue);
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj["@graph"])) return (obj["@graph"] as unknown[]).flatMap(flattenJsonLdValue);
    return [obj];
  }
  return [];
}

/**
 * Extracts every `<script type="application/ld+json">` block from `html`,
 * parses it, and flattens @graph/array wrappers. Malformed JSON in one block
 * is skipped rather than aborting the whole page — a common real-world case
 * is one broken tracking-pixel schema alongside a perfectly good Product one.
 */
export function extractJsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of html.matchAll(JSON_LD_RE)) {
    const raw = m[1]
      .replace(/^\s*<!--/, "").replace(/-->\s*$/, "") // some sites HTML-comment-wrap the JSON
      .trim();
    if (!raw) continue;
    try {
      out.push(...flattenJsonLdValue(JSON.parse(raw)));
    } catch { /* one broken block must never sink the rest of the page */ }
  }
  return out;
}

/** Convenience: every JSON-LD block whose @type matches (case-insensitive), e.g. "Product" or "Article". */
export function findJsonLdByType(blocks: Record<string, unknown>[], type: string): Record<string, unknown>[] {
  const wanted = type.toLowerCase();
  return blocks.filter(b => {
    const t = b["@type"];
    if (typeof t === "string") return t.toLowerCase() === wanted;
    if (Array.isArray(t)) return t.some(x => typeof x === "string" && x.toLowerCase() === wanted);
    return false;
  });
}

export type ExtractedPrice = { amount: number; currency: string; raw: string };

const CURRENCY_SYMBOLS: Record<string, string> = {
  "$": "USD", "£": "GBP", "€": "EUR", "¥": "JPY", "₹": "INR", "₦": "NGN", "R": "ZAR",
};
// Explicit ISO-ish codes that show up as plain text near a number, distinct
// from the symbol table above (symbols are unambiguous; these three-letter
// codes need a word boundary so "USDA" doesn't match as "USD").
const CURRENCY_CODES = ["USD", "GBP", "EUR", "ZAR", "ZWL", "KES", "NGN", "GHS", "TZS", "UGX", "ZMW", "MWK", "RWF"];

const SUFFIX_MULTIPLIER: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

// Text that looks like a price but is noise in the context this is usually
// run in (nav/footer boilerplate, not an actual product price) — a light
// heuristic, not exhaustive; callers should still sanity-check the result.
const NOISE_CONTEXT_RE = /\b(copyright|©|all rights reserved|terms of (service|use)|privacy policy)\b/i;

/**
 * Finds the first plausible price in `text` — a currency symbol or code
 * adjacent to a number, with optional k/m/b suffix (e.g. "$1.2k", "from
 * ZWL 450", "€99"). Returns null when nothing price-shaped is found, or when
 * the only match sits inside an obvious noise context (footer/legal text).
 */
export function extractPriceFromText(text: string): ExtractedPrice | null {
  const symbolPattern = Object.keys(CURRENCY_SYMBOLS).map(s => `\\${s}`).join("");
  const codePattern = CURRENCY_CODES.join("|");
  const re = new RegExp(
    `(?:([${symbolPattern}])\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s?([kKmMbB])?)` +
    `|(?:\\b(${codePattern})\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s?([kKmMbB])?\\b)` +
    `|(?:(\\d[\\d,]*(?:\\.\\d+)?)\\s?([kKmMbB])?\\s?(${codePattern})\\b)`,
    "g",
  );

  for (const m of text.matchAll(re)) {
    const context = text.slice(Math.max(0, m.index! - 40), m.index! + m[0].length + 10);
    if (NOISE_CONTEXT_RE.test(context)) continue;

    let currency: string | undefined;
    let numberStr: string | undefined;
    let suffix: string | undefined;
    if (m[1]) { currency = CURRENCY_SYMBOLS[m[1]]; numberStr = m[2]; suffix = m[3]; }
    else if (m[4]) { currency = m[4].toUpperCase(); numberStr = m[5]; suffix = m[6]; }
    else if (m[7]) { numberStr = m[7]; suffix = m[8]; currency = m[9]?.toUpperCase(); }
    if (!currency || !numberStr) continue;

    const base = Number(numberStr.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const mult = suffix ? (SUFFIX_MULTIPLIER[suffix.toLowerCase()] ?? 1) : 1;
    return { amount: base * mult, currency, raw: m[0].trim() };
  }
  return null;
}
