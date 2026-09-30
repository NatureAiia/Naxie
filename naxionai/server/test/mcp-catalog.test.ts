// Regression test for the curated MCP server catalog. Every entry here is
// hand-verified against github.com/modelcontextprotocol/servers — this test
// locks in the invariants that make that verification meaningful (no
// archived/deprecated entries slip back in, every entry stays addMcpServer-
// compatible) rather than re-deriving the list.

import { describe, expect, it } from "vitest";
import { MCP_CATALOG, listMcpCatalog, getMcpCatalogEntry } from "../src/lib/mcp-catalog.js";

describe("MCP_CATALOG", () => {
  it("has at least one entry and every id is unique", () => {
    expect(MCP_CATALOG.length).toBeGreaterThan(0);
    const ids = MCP_CATALOG.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry is addMcpServer-compatible: non-empty label + command, args is an array", () => {
    for (const e of MCP_CATALOG) {
      expect(e.label.trim().length).toBeGreaterThan(0);
      expect(e.command.trim().length).toBeGreaterThan(0);
      expect(Array.isArray(e.args)).toBe(true);
    }
  });

  it("no entry links to an archived/deprecated servers repo", () => {
    for (const e of MCP_CATALOG) {
      expect(e.homepage).not.toMatch(/servers-archived/i);
      expect(e.homepage).not.toMatch(/\/archive\//i);
    }
  });

  it("every entry links to a real homepage URL", () => {
    for (const e of MCP_CATALOG) {
      expect(e.homepage).toMatch(/^https:\/\//);
    }
  });

  it("required env vars are described, not left blank", () => {
    for (const e of MCP_CATALOG) {
      for (const v of e.env ?? []) {
        expect(v.name.trim().length).toBeGreaterThan(0);
        expect(v.description.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("listMcpCatalog / getMcpCatalogEntry", () => {
  it("listMcpCatalog returns the full catalog", () => {
    expect(listMcpCatalog()).toBe(MCP_CATALOG);
  });

  it("getMcpCatalogEntry finds a known entry by id", () => {
    expect(getMcpCatalogEntry("filesystem")?.label).toBe("Filesystem");
  });

  it("getMcpCatalogEntry returns undefined for an unknown id", () => {
    expect(getMcpCatalogEntry("not-a-real-server")).toBeUndefined();
  });
});
