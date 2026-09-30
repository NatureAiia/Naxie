import { describe, expect, it } from "vitest";
import { classifyIntent, registerDomain, _resetDomainsForTests } from "../src/lib/hier-intent.js";

describe("classifyIntent — built-in zim-mobile-money domain", () => {
  it("resolves a clear Zimbabwe mobile-money phrase", () => {
    const r = classifyIntent("tumira mari kuna Tatenda");
    expect(r.status).toBe("resolved");
    expect(r.intent).toBe("Send money");
    expect(r.domain?.id).toBe("zim-mobile-money");
  });

  it("resolves a buy-airtime phrase distinctly from send-money", () => {
    const r = classifyIntent("tenga airtime");
    expect(r.status).toBe("resolved");
    expect(r.intent).toBe("Buy airtime");
  });
});

describe("classifyIntent — staged behavior with a controlled domain", () => {
  it("returns unknown when no domains are registered at all", () => {
    _resetDomainsForTests();
    expect(classifyIntent("anything")).toMatchObject({ status: "unknown", confidence: 0 });
  });

  it("returns unknown for empty input", () => {
    _resetDomainsForTests();
    registerDomain({ id: "d", examples: ["book a flight"], intents: { BOOK: ["book a flight to paris"] } });
    expect(classifyIntent("")).toMatchObject({ status: "unknown" });
  });

  it("resolves a confident, unambiguous match", () => {
    _resetDomainsForTests();
    registerDomain({
      id: "travel",
      examples: ["book a flight", "cancel a hotel"],
      intents: {
        BOOK_FLIGHT: ["book a flight to paris", "reserve an airline ticket"],
        CANCEL_HOTEL: ["cancel my hotel reservation", "cancel the booking"],
      },
    });
    const r = classifyIntent("book a flight to paris please");
    expect(r.status).toBe("resolved");
    expect(r.intent).toBe("BOOK_FLIGHT");
    expect(r.alternatives[0].intent).toBe("CANCEL_HOTEL");
  });

  it("flags near-tied top intents as ambiguous", () => {
    _resetDomainsForTests();
    registerDomain({
      id: "overlap",
      examples: ["shared words"],
      intents: {
        A: ["send the package now"],
        B: ["send the payment now"],
      },
    });
    const r = classifyIntent("send the thing now");
    expect(r.status).toBe("ambiguous");
    expect(r.reason).toMatch(/margin/);
  });

  it("flags a weak absolute match as unknown even with no competing intent", () => {
    _resetDomainsForTests();
    registerDomain({ id: "d", examples: ["completely unrelated topic"], intents: { X: ["completely unrelated topic here"] } });
    const r = classifyIntent("zzz qqq");
    expect(r.status).toBe("unknown");
    expect(r.reason).toMatch(/weak absolute confidence/);
  });

  it("domain scoring is informational only — low domain score doesn't block a resolved intent", () => {
    _resetDomainsForTests();
    registerDomain({
      id: "narrow-domain-example",
      examples: ["totally different domain wording"],
      intents: { EXACT: ["book a flight to paris please"] },
    });
    const r = classifyIntent("book a flight to paris please");
    expect(r.status).toBe("resolved");
    expect(r.intent).toBe("EXACT");
  });
});
