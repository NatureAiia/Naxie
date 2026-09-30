import { describe, expect, it } from "vitest";
import { unsupportedActionClaims, honestNonDelivery, type ClaimRun } from "../src/lib/action-claims.js";

describe("unsupportedActionClaims", () => {
  it("catches a fabricated Telegram file delivery with no supporting step", () => {
    const answer = "#### Files Delivered\n- File: natasha_cv.pdf\nThe file was successfully delivered via Telegram.";
    const runs: ClaimRun[] = [{ step: { tool: "research.deep" }, ok: true }];
    const claims = unsupportedActionClaims(answer, runs);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.some(c => c.tools.includes("telegram.send"))).toBe(true);
  });

  it("passes when the send tool actually ran successfully", () => {
    const answer = "The email was sent to jane@acme.com with the report attached.";
    const runs: ClaimRun[] = [{ step: { tool: "email.send" }, ok: true }];
    expect(unsupportedActionClaims(answer, runs)).toEqual([]);
  });

  it("does not flag a hedged / negated sentence", () => {
    const answer = "I could not send the email — no valid address was found.";
    expect(unsupportedActionClaims(answer, [])).toEqual([]);
  });

  it("does not flag a draft written for the operator to send by hand", () => {
    const answer = "## Message\n\nHi Jane, I sent the invoice last week and wanted to follow up.";
    expect(unsupportedActionClaims(answer, [])).toEqual([]);
  });

  it("does not flag future/proposed action (infinitive or modal before the verb)", () => {
    const answer = "The report is ready to be sent to the finance team once you approve.";
    expect(unsupportedActionClaims(answer, [])).toEqual([]);
  });

  it("flags a claimed email send when the actual send step failed", () => {
    const answer = "I emailed the report to finance.";
    const runs: ClaimRun[] = [{ step: { tool: "email.send" }, ok: false }];
    expect(unsupportedActionClaims(answer, runs).length).toBeGreaterThan(0);
  });
});

describe("honestNonDelivery", () => {
  it("distinguishes a failed attempt from a never-planned step", () => {
    const failed = honestNonDelivery({
      task: "send the CV",
      claims: [{ claim: "an email was sent", tools: ["email.send"] }],
      runs: [{ step: { tool: "email.send" }, ok: false }],
    });
    expect(failed).toMatch(/FAILED/);

    const neverPlanned = honestNonDelivery({
      task: "send the CV",
      claims: [{ claim: "an email was sent", tools: ["email.send"] }],
      runs: [{ step: { tool: "research.deep" }, ok: true }],
    });
    expect(neverPlanned).toMatch(/never planned/);
  });
});
