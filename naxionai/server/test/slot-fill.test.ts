import { describe, expect, it, beforeEach } from "vitest";
import { registerFlow, advanceFlow, activeFlow, cancelFlow, _resetFlowsForTests } from "../src/lib/slot-fill.js";

beforeEach(() => {
  _resetFlowsForTests();
  registerFlow({
    id: "signup",
    order: ["name", "email"],
    slots: {
      name: (text) => {
        const m = text.match(/name is (\w+)/i);
        return m?.[1];
      },
      email: (text) => {
        const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
        return m?.[0];
      },
    },
    prompt: (slot) => `What's your ${slot}?`,
  });
});

describe("advanceFlow", () => {
  it("returns no_flow when nothing is active and no flowId given", () => {
    expect(advanceFlow("s1", "hello")).toEqual({ status: "no_flow" });
  });

  it("starts a flow and asks for the first missing slot", () => {
    const r = advanceFlow("s1", "hi there", "signup");
    expect(r).toMatchObject({ status: "started", flowId: "signup", missing: ["name", "email"] });
  });

  it("fills multiple slots from one utterance", () => {
    advanceFlow("s1", "irrelevant", "signup");
    const r = advanceFlow("s1", "my name is Tatenda, email tatenda@example.com");
    expect(r).toMatchObject({ status: "complete", collected: { name: "Tatenda", email: "tatenda@example.com" } });
    expect(activeFlow("s1")).toBeUndefined();
  });

  it("advances one slot at a time when only one is answered per turn", () => {
    advanceFlow("s1", "start", "signup");
    const r1 = advanceFlow("s1", "name is Siyabonga");
    expect(r1).toMatchObject({ status: "advanced", missing: ["email"] });
    const r2 = advanceFlow("s1", "siyabonga@example.com");
    expect(r2.status).toBe("complete");
  });

  it("never overwrites an already-collected slot with a later match", () => {
    advanceFlow("s1", "name is First", "signup");
    advanceFlow("s1", "actually name is Second, still no email though");
    const state = activeFlow("s1");
    expect(state?.collected.name).toBe("First");
  });

  it("keeps separate sessions independent", () => {
    advanceFlow("a", "start", "signup");
    advanceFlow("b", "start", "signup");
    advanceFlow("a", "name is Alice");
    expect(activeFlow("a")?.collected).toEqual({ name: "Alice" });
    expect(activeFlow("b")?.collected).toEqual({});
  });

  it("cancelFlow clears an active session", () => {
    advanceFlow("s1", "start", "signup");
    expect(cancelFlow("s1")).toBe(true);
    expect(activeFlow("s1")).toBeUndefined();
    expect(cancelFlow("s1")).toBe(false);
  });

  it("returns no_flow for an unknown flowId", () => {
    expect(advanceFlow("s2", "hi", "does-not-exist")).toEqual({ status: "no_flow" });
  });
});
