// routes/org-tasks.ts — pure query-parsing logic only (parseOrgTaskFilter).
// Consistent with this repo's convention (see host-tools.test.ts,
// org-tasks.test.ts) of testing pure decision logic, not the Express
// handlers or lib/org-tasks.ts's disk-backed store.

import { describe, expect, it } from "vitest";
import { parseOrgTaskFilter } from "../src/routes/org-tasks.js";

describe("parseOrgTaskFilter", () => {
  it("passes through a valid role and status", () => {
    expect(parseOrgTaskFilter({ role: "researcher", status: "active" })).toEqual({
      role: "researcher",
      status: "active",
    });
  });

  it("drops an unrecognized role/status rather than throwing", () => {
    expect(parseOrgTaskFilter({ role: "not-a-role", status: "not-a-status" })).toEqual({
      role: undefined,
      status: undefined,
    });
  });

  it("returns no filter when neither param is present", () => {
    expect(parseOrgTaskFilter({})).toEqual({ role: undefined, status: undefined });
  });

  it("ignores a non-string value (e.g. a repeated query param becoming an array)", () => {
    expect(parseOrgTaskFilter({ role: ["scheduler", "admin"] })).toEqual({ role: undefined, status: undefined });
  });
});
