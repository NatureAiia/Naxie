// Mongo database resolution (data-sources.ts resolveMongoDbName): explicit
// `db` wins, connection-string default next, loud refusal (never a silent
// wrong-DB read) when neither exists. No cluster needed.
import { describe, expect, it } from "vitest";
import { resolveMongoDbName } from "../src/lib/data-sources.js";

describe("resolveMongoDbName", () => {
  it("prefers the explicit db", () => {
    expect(resolveMongoDbName("mongodb+srv://u:p@host/naxionai", "ops")).toBe("ops");
  });

  it("falls back to the connection string default", () => {
    expect(resolveMongoDbName("mongodb+srv://u:p@host/naxionai?retryWrites=true", undefined)).toBe("naxionai");
    expect(resolveMongoDbName("mongodb://u:p@127.0.0.1:27017/shop", null)).toBe("shop");
  });

  it("refuses rather than silently landing on test", () => {
    expect(() => resolveMongoDbName("mongodb+srv://u:p@host/", undefined)).toThrow(/needs a "db"/);
    expect(() => resolveMongoDbName("mongodb+srv://u:p@host", undefined)).toThrow(/needs a "db"/);
  });
});
