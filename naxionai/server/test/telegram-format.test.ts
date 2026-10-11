// Canonical Telegram layout contract (telegram-format.ts): one card shape,
// single bold-title style, report footers carry the vault path.
import { describe, expect, it } from "vitest";
import { card, digestCard, vaultFooter, signNaxie, deliveryCard } from "../src/lib/telegram-format.js";

describe("card", () => {
  it("renders icon + bold title + body, no ## headers", () => {
    const out = card({ icon: "🔔", title: "Needs your call", body: "2 tasks waiting." });
    expect(out).toBe("🔔 **Needs your call**\n\n2 tasks waiting.");
    expect(out).not.toContain("##");
  });

  it("includes meta and footer when given, skips them when absent", () => {
    const full = card({ icon: "📋", title: "T", meta: "spend · today", body: "B", footer: "— Naxie" });
    expect(full).toBe("📋 **T**\n\nspend · today\n\nB\n\n— Naxie");
    expect(card({ icon: "📋", title: "T", body: "" })).toContain("(no details)");
  });

  it("never emits single-star titles", () => {
    expect(card({ icon: "☀️", title: "Todo Brief", body: "x" })).not.toMatch(/(^|\n)\*[^*]/);
  });
});

describe("digestCard", () => {
  it("joins stats with middots and appends the vault footer", () => {
    const out = digestCard({
      icon: "🌙", title: "Daily Reflection", date: "Tuesday",
      stats: ["3 tasks", "100% success"], body: "Calm day.", vaultPath: "a/b.md",
    });
    expect(out).toContain("🌙 **Daily Reflection — Tuesday**");
    expect(out).toContain("3 tasks · 100% success");
    expect(out).toContain("— Naxie · full report in vault: a/b.md");
  });

  it("falls back to the plain signature without a vault path", () => {
    expect(digestCard({ icon: "🔭", title: "Scan", body: "b" })).toContain(signNaxie());
  });
});

describe("deliveryCard", () => {
  it("signs successes and flags failures without a footer", () => {
    const ok = deliveryCard({ name: "Morning briefing", answer: "Focus: X" });
    expect(ok.startsWith("✅ **Morning briefing**")).toBe(true);
    expect(ok.endsWith("— Naxie")).toBe(true);
    const bad = deliveryCard({ name: "Morning briefing", answer: "could not start", failed: true });
    expect(bad.startsWith("⚠️ **Morning briefing**")).toBe(true);
    expect(bad).not.toContain("— Naxie");
  });

  it("vaultFooter formats the report pointer", () => {
    expect(vaultFooter("x/y.md")).toBe("— Naxie · full report in vault: x/y.md");
  });
});
