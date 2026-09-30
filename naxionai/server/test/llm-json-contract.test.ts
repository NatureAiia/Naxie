import { describe, expect, it } from "vitest";
import { recoverJsonObject, checkContract, parseLlmContract } from "../src/lib/llm-json-contract.js";

describe("recoverJsonObject", () => {
  it("parses a clean JSON object directly", () => {
    expect(recoverJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("recovers from a fenced json code block", () => {
    const raw = 'Sure, here you go:\n```json\n{"a": 1, "b": "x"}\n```\nHope that helps!';
    expect(recoverJsonObject(raw)).toEqual({ a: 1, b: "x" });
  });

  it("recovers the first brace-balanced object amid commentary", () => {
    const raw = 'The answer is {"intent": "SEND_MONEY", "confidence": 0.9} — let me know if you need more.';
    expect(recoverJsonObject(raw)).toEqual({ intent: "SEND_MONEY", confidence: 0.9 });
  });

  it("handles nested braces inside the object correctly", () => {
    const raw = '{"entities": {"amount": 5}, "intent": "x"}';
    expect(recoverJsonObject(raw)).toEqual({ entities: { amount: 5 }, intent: "x" });
  });

  it("returns undefined for unrecoverable text", () => {
    expect(recoverJsonObject("no json here at all")).toBeUndefined();
  });

  it("returns undefined for a bare array, not an object", () => {
    expect(recoverJsonObject("[1,2,3]")).toBeUndefined();
  });
});

describe("checkContract", () => {
  const schema = { intent: "string", confidence: "number", entities: "object" } as const;

  it("passes when every field matches", () => {
    expect(checkContract({ intent: "x", confidence: 0.5, entities: {} }, schema)).toEqual([]);
  });

  it("reports a missing field", () => {
    expect(checkContract({ intent: "x", entities: {} }, schema)).toEqual([`missing required field "confidence"`]);
  });

  it("reports a wrong-type field", () => {
    const violations = checkContract({ intent: "x", confidence: "high", entities: {} }, schema);
    expect(violations).toEqual([`field "confidence" expected number, got string`]);
  });

  it("ignores extra fields not in the schema", () => {
    expect(checkContract({ intent: "x", confidence: 1, entities: {}, reply: "hi" }, schema)).toEqual([]);
  });
});

describe("parseLlmContract", () => {
  const schema = { intent: "string", confidence: "number" } as const;

  it("succeeds on well-formed, contract-matching output", () => {
    const r = parseLlmContract('{"intent":"SEND_MONEY","confidence":0.8}', schema);
    expect(r).toEqual({ ok: true, value: { intent: "SEND_MONEY", confidence: 0.8 } });
  });

  it("fails with the raw text preserved when JSON can't be recovered", () => {
    const r = parseLlmContract("not json", schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.raw).toBe("not json");
      expect(r.reason).toMatch(/no parseable JSON/);
    }
  });

  it("fails when parsed JSON violates the contract", () => {
    const r = parseLlmContract('{"intent":"x"}', schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/confidence/);
  });
});
