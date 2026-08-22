// naxie-connectors relay — pure URL-rewrite logic only (toNaxionUrl). The
// actual fetch-forwarding handler isn't unit-tested here, consistent with
// this repo's convention (see host-tools.test.ts, org-tasks.test.ts) of
// testing pure decision logic, not network/process I/O.

import { describe, expect, it } from "vitest";
import { toNaxionUrl } from "../src/routes/naxie-connectors.js";

describe("toNaxionUrl", () => {
  it("rewrites the /naxie-api prefix onto naxionai's own /api prefix", () => {
    expect(toNaxionUrl("http://127.0.0.1:8000", "/naxie-api/connectors/google/")).toBe(
      "http://127.0.0.1:8000/api/connectors/google/",
    );
  });

  it("preserves a query string", () => {
    expect(toNaxionUrl("http://127.0.0.1:8000", "/naxie-api/training/local-folder/browse?sub_path=docs")).toBe(
      "http://127.0.0.1:8000/api/training/local-folder/browse?sub_path=docs",
    );
  });

  it("handles the bare prefix with nothing after it", () => {
    expect(toNaxionUrl("http://127.0.0.1:8000", "/naxie-api")).toBe("http://127.0.0.1:8000/api");
  });
});
