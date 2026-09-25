import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordRagQuery, readRagTelemetry, summarizeRagTelemetry, _setTelemetryFileForTests, type RagQueryRecord,
} from "../src/lib/rag-telemetry.js";

const rec = (query: string, hitCount: number, over: Partial<RagQueryRecord> = {}): RagQueryRecord => ({
  ts: new Date().toISOString(), query, hitCount,
  sources: { index: hitCount, memory: 0, vaultScan: 0, vector: 0 },
  topScore: hitCount ? 3 : 0, ms: 10, vectorEnabled: false, ...over,
});

describe("rag telemetry", () => {
  let file = "";
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), "ragtel-")), "t.jsonl");
    _setTelemetryFileForTests(file);
  });

  it("appends one JSON line per query and reads them back", () => {
    recordRagQuery({ query: "brand guidelines", hitCount: 2, sources: { index: 2, memory: 0, vaultScan: 0, vector: 0 }, topScore: 4, ms: 12, vectorEnabled: false });
    recordRagQuery({ query: "x".repeat(1000), hitCount: 0, sources: { index: 0, memory: 0, vaultScan: 0, vector: 0 }, topScore: 0, ms: 5, vectorEnabled: true });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    const back = readRagTelemetry(0);
    expect(back[0].query).toBe("brand guidelines");
    expect(back[1].query.length).toBe(300); // queries are truncated
  });

  it("filters by time window", () => {
    recordRagQuery({ ...rec("old", 1), ts: "2020-01-01T00:00:00.000Z" });
    recordRagQuery(rec("new", 1));
    expect(readRagTelemetry(Date.parse("2025-01-01")).map(r => r.query)).toEqual(["new"]);
  });

  it("summarises zero-hit rate, low hits, sources and missed terms", () => {
    const s = summarizeRagTelemetry([
      rec("what is the cognify roadmap", 0),
      rec("cognify pricing please", 0),
      rec("brand guidelines", 1, { sources: { index: 0, memory: 0, vaultScan: 1, vector: 0 } }),
      rec("strategic plan", 4, { vectorEnabled: true, sources: { index: 2, memory: 1, vaultScan: 0, vector: 1 } }),
    ]);
    expect(s.totalQueries).toBe(4);
    expect(s.zeroHitQueries).toBe(2);
    expect(s.zeroHitRate).toBe(0.5);
    expect(s.lowHitQueries).toBe(3);
    expect(s.vectorEnabledShare).toBe(0.25);
    expect(s.fallbackScanShare).toBe(0.25);
    expect(s.topMissedTerms[0]).toEqual({ term: "cognify", count: 2 });
    expect(s.topMissedTerms.map(t => t.term)).not.toContain("the");
    expect(s.sourceShare.index + s.sourceShare.memory + s.sourceShare.vaultScan + s.sourceShare.vector).toBeCloseTo(1);
  });

  it("handles an empty window", () => {
    const s = summarizeRagTelemetry([]);
    expect(s.totalQueries).toBe(0);
    expect(s.zeroHitRate).toBe(0);
    expect(s.topMissedTerms).toEqual([]);
  });
});
