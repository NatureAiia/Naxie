// Inbox-over-Telegram contract (approval-telegram.ts): callback shapes,
// diff-guard, keyboard layout, repeat-nudge suppression signature.
import { describe, expect, it } from "vitest";
import {
  parseApprovalCallback,
  approvalCallback,
  isDiffCarrying,
  toWaitingView,
  approvalKeyboard,
  detailKeyboard,
  jobDetailKeyboard,
  waitingSignature,
} from "../src/lib/approval-telegram.js";

const ID = "123e4567-e89b-12d3-a456-426614174000";

describe("parseApprovalCallback", () => {
  it("parses approve/reject/detail with uuid", () => {
    expect(parseApprovalCallback(`approval:approve:${ID}`)).toEqual({ action: "approve", id: ID });
    expect(parseApprovalCallback(`approval:reject:${ID}`)).toEqual({ action: "reject", id: ID });
    expect(parseApprovalCallback(`approval:detail:${ID}`)).toEqual({ action: "detail", id: ID });
  });

  it("parses job actions with uuid", () => {
    expect(parseApprovalCallback(`approval:jobapprove:${ID}`)).toEqual({ action: "jobapprove", id: ID });
    expect(parseApprovalCallback(`approval:jobreject:${ID}`)).toEqual({ action: "jobreject", id: ID });
    expect(parseApprovalCallback(`approval:jobdetail:${ID}`)).toEqual({ action: "jobdetail", id: ID });
  });

  it("parses bare list", () => {
    expect(parseApprovalCallback("approval:list")).toEqual({ action: "list" });
  });

  it("rejects other prefixes and id-less actions", () => {
    expect(parseApprovalCallback(`email:approve:${ID}`)).toBeNull();
    expect(parseApprovalCallback("approval:approve")).toBeNull();
    expect(parseApprovalCallback("approval:nuke:" + ID)).toBeNull();
  });
});

describe("callback size", () => {
  it("stays under Telegram's 64-byte callback_data limit", () => {
    for (const a of ["approve", "reject", "detail", "jobapprove", "jobreject", "jobdetail"] as const) {
      expect(approvalCallback(a, ID).length).toBeLessThanOrEqual(64);
    }
  });

  it("builds job detail keyboards with job actions", () => {
    const kb = jobDetailKeyboard(ID);
    expect(kb[0].map((b: any) => b.text)).toEqual(["✅ Approve job", "❌ Reject job"]);
    expect(kb[0][0].callback_data).toBe(`approval:jobapprove:${ID}`);
  });
});

describe("isDiffCarrying", () => {
  it("flags diff / proposal.diff / architect-change", () => {
    expect(isDiffCarrying({ pendingApproval: { kind: "other", diff: "--- a" } })).toBe(true);
    expect(isDiffCarrying({ pendingApproval: { kind: "other", proposal: { diff: "@@ x" } } })).toBe(true);
    expect(isDiffCarrying({ pendingApproval: { kind: "architect-change" } })).toBe(true);
    expect(isDiffCarrying({ pendingApproval: { kind: "spend" } })).toBe(false);
    expect(isDiffCarrying({})).toBe(false);
  });
});

describe("keyboards", () => {
  const plain = { id: ID, title: "Send the invoice", actionDescription: "d", kind: "spend", requestedAt: "", hasDiff: false };
  const diffy = { ...plain, id: ID.replace(/0$/, "1"), title: "Refactor auth", hasDiff: true };

  it("gives plain tasks approve+reject, diff tasks review-only", () => {
    const kb = approvalKeyboard([plain, diffy]);
    expect(kb[0].map((b: any) => b.text)).toEqual([`✅ ${plain.title}`, "❌"]);
    expect(kb[1]).toHaveLength(1);
    expect(kb[1][0].text).toContain("review in app");
    expect(JSON.stringify(kb[1])).not.toContain("approve");
  });

  it("detail card drops Approve for diff items", () => {
    expect(detailKeyboard(plain)[0].map((b: any) => b.text)).toEqual(["✅ Approve", "❌ Reject"]);
    expect(JSON.stringify(detailKeyboard(diffy))).not.toContain("approve");
  });

  it("overflow links back to the inbox", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...plain, id: `${ID.slice(0, -1)}${i}` }));
    const kb = approvalKeyboard(many, 3);
    expect(kb).toHaveLength(4);
    expect(kb[3][0].callback_data).toBe("approval:list");
  });
});

describe("toWaitingView / waitingSignature", () => {
  it("projects task fields and detects diffs", () => {
    const v = toWaitingView({ id: ID, title: "T", detail: "fallback", pendingApproval: { actionDescription: "Do X", kind: "spend" } });
    expect(v.actionDescription).toBe("Do X");
    expect(v.hasDiff).toBe(false);
  });

  it("signature is order-insensitive and changes with membership", () => {
    const a = [{ id: "b" }, { id: "a" }];
    expect(waitingSignature(a)).toBe(waitingSignature([{ id: "a" }, { id: "b" }]));
    expect(waitingSignature(a)).not.toBe(waitingSignature([{ id: "a" }]));
  });
});
