import { getMcpCatalogEntry } from "../src/lib/mcp-catalog";

describe("MCP catalog sanity checks", () => {
  test("openclaw entry exists and uses npm launch", () => {
    const entry = getMcpCatalogEntry("openclaw");
    expect(entry).toBeDefined();
    expect(entry?.command).toBe("npx");
    expect(entry?.args).toContain("openclaw@latest");
  });

  test("entries have optional tags property", () => {
    const all = ["fetch", "github"]; // sample entries we added tags for
    for (const id of all) {
      const e = getMcpCatalogEntry(id);
      expect(e).toBeDefined();
      expect(e?.tags?.length).toBeGreaterThan(0);
    }
  });
});
