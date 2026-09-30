import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordTrace, readTrace, summariseTrace, hashPrompt, classifyError, _traceFilePath,
  type TraceRow,
} from "../src/lib/llm-trace.js";

beforeEach(() => {
  process.env.NAXION_STATE_DIR = mkdtempSync(join(tmpdir(), "llm-trace-"));
  delete process.env.NAXION_TRACE;
});

function row(over: Partial<TraceRow> = {}): TraceRow {
  return {
    at: new Date().toISOString(), job: "job-1", call: "llmGenerateWithMeta",
    backend: "ollama", model: "qwen2.5:3b", promptChars: 100, systemChars: 20,
    estTokens: 30, ms: 500, outcome: "ok", promptHash: hashPrompt("x"),
    ...over,
  };
}

describe("recordTrace / readTrace", () => {
  it("writes and reads back a row", () => {
    recordTrace(row());
    const rows = readTrace();
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("qwen2.5:3b");
  });

  it("never stores prompt or response text — only the fields TraceRow declares", () => {
    recordTrace(row());
    const raw = readTrace()[0] as any;
    expect(Object.keys(raw).sort()).toEqual(
      ["at", "backend", "call", "estTokens", "job", "model", "ms", "outcome", "promptChars", "promptHash", "systemChars"].sort(),
    );
  });

  it("filters by job and by sinceMs", () => {
    recordTrace(row({ job: "job-a", at: new Date(Date.now() - 100000).toISOString() }));
    recordTrace(row({ job: "job-b" }));
    expect(readTrace({ job: "job-a" })).toHaveLength(1);
    expect(readTrace({ sinceMs: Date.now() - 1000 })).toHaveLength(1);
  });

  it("respects NAXION_TRACE=0 (disabled)", () => {
    process.env.NAXION_TRACE = "0";
    recordTrace(row());
    expect(readTrace()).toHaveLength(0);
  });

  it("skips a malformed line without losing the rest", () => {
    recordTrace(row({ job: "good-1" }));
    appendFileSync(_traceFilePath(), "not json\n");
    recordTrace(row({ job: "good-2" }));
    const rows = readTrace();
    expect(rows.map(r => r.job)).toEqual(["good-1", "good-2"]);
  });
});

describe("classifyError", () => {
  it("classifies an abort", () => {
    expect(classifyError(new Error("request aborted")).outcome).toBe("aborted");
  });
  it("classifies context-window errors distinctly from timeouts", () => {
    expect(classifyError(new Error("maximum context length exceeded")).errorClass).toBe("context");
  });
  it("classifies a timeout", () => {
    expect(classifyError(new Error("section exceeded 150s")).errorClass).toBe("timeout");
  });
  it("classifies credit/quota errors", () => {
    expect(classifyError(new Error("insufficient credit balance")).errorClass).toBe("credit");
  });
  it("classifies rate limits", () => {
    expect(classifyError(new Error("429 rate limited")).errorClass).toBe("rate-limit");
  });
  it("classifies network errors", () => {
    expect(classifyError(new Error("fetch failed: ECONNRESET")).errorClass).toBe("network");
  });
  it("falls back to other", () => {
    expect(classifyError(new Error("something weird")).errorClass).toBe("other");
  });
});

describe("summariseTrace", () => {
  it("aggregates calls, failures, overflows and fallbacks by model and by job", () => {
    const rows: TraceRow[] = [
      row({ job: "j1", model: "a", ms: 100, outcome: "ok" }),
      row({ job: "j1", model: "a", ms: 200, outcome: "error", errorClass: "timeout" }),
      row({ job: "j2", model: "b", ms: 50, outcome: "ok", overflow: true }),
      row({ job: "j2", model: "b", ms: 300, outcome: "ok", reason: "fell back to local after credit exhausted" }),
    ];
    const s = summariseTrace(rows);
    expect(s.calls).toBe(4);
    expect(s.failures).toBe(1);
    expect(s.overflows).toBe(1);
    expect(s.fallbacks).toBe(1);
    expect(s.byModel.find(m => m.model === "a")?.calls).toBe(2);
    expect(s.byJob.find(j => j.job === "j2")?.calls).toBe(2);
    expect(s.slowest[0].ms).toBe(300);
  });
});
