// Weekly self-improvement review — pure logic only: the tolerant JSON
// parser, telemetry-driven retrieval heuristics, and applying an approved
// proposal through injected deps (no disk, no LLM, no real schedules).

import { describe, expect, it, vi } from "vitest";
import {
  parseReview, retrievalHeuristics, applyImprovementProposal, buildPrompt,
  type ApplyDeps, type ImprovementEvidence,
} from "../src/lib/weekly-improvement.js";
import { summarizeRagTelemetry } from "../src/lib/rag-telemetry.js";
import { forceApprovalForRole } from "../src/lib/org-tasks.js";

function deps(over: Partial<ApplyDeps> = {}): ApplyDeps {
  return {
    createSchedule: vi.fn((input: any) => ({ id: "s1", name: input.name })),
    templateExists: (id: string) => ["general-task", "daily-briefing"].includes(id),
    reindex: vi.fn(async () => {}),
    reembed: vi.fn(async () => ({ ok: true })),
    architect: vi.fn(async () => ({ created: true, taskId: "a1" })),
    addMcp: vi.fn((input: any) => ({ id: "m1", label: input.label })),
    disableMcp: vi.fn(),
    mcpCatalogEntry: (id: string) => id === "filesystem" ? { label: "Filesystem", command: "npx", args: ["-y", "fs"], description: "files" } : undefined,
    ...over,
  };
}

function evidence(over: Partial<ImprovementEvidence> = {}): ImprovementEvidence {
  return {
    windowStart: "2026-09-18T00:00:00.000Z", windowEnd: "2026-09-25T00:00:00.000Z",
    jobs: { total: 10, succeeded: 8, failed: 2, successRate: 0.8, topFailures: [], weakTools: [], weakSkills: [] },
    reflections: [], lessons: "", scans: [], weaknesses: [], schedules: [], engines: [],
    mcpServers: [], mcpCatalog: [], templates: [],
    retrieval: summarizeRagTelemetry([]), index: { docs: 500, ageHours: 2 }, priorProposals: [],
    ...over,
  };
}

describe("improver role", () => {
  it("always requires approval", () => expect(forceApprovalForRole("improver")).toBe(true));
});

describe("parseReview", () => {
  it("parses fenced JSON and normalises fields", () => {
    const r = parseReview("Here you go:\n```json\n" + JSON.stringify({
      summary: "Good week.",
      whatWorked: ["briefings"],
      whatDidnt: "web search flaky",
      proposals: [
        { kind: "schedule", title: "Friday inbox sweep", why: "inbox piled up", implementation: ["add schedule"], effort: "S", payload: { templateId: "general-task" } },
        { kind: "weird", title: "Something", steps: ["a", "b"], effort: "XL" },
        { kind: "code", title: "" },
      ],
    }) + "\n```");
    expect(r).not.toBeNull();
    expect(r!.summary).toBe("Good week.");
    expect(r!.whatDidnt).toEqual(["web search flaky"]);
    expect(r!.proposals).toHaveLength(2);
    expect(r!.proposals[1]).toMatchObject({ kind: "other", effort: "M", implementation: ["a", "b"] });
  });

  it("returns null when there's no JSON", () => {
    expect(parseReview("I could not do it")).toBeNull();
    expect(parseReview("{ not json")).toBeNull();
  });

  it("caps the number of proposals", () => {
    const proposals = Array.from({ length: 20 }, (_, i) => ({ kind: "cli", title: `tool ${i}` }));
    expect(parseReview(JSON.stringify({ proposals }))!.proposals.length).toBeLessThanOrEqual(8);
  });
});

describe("retrievalHeuristics", () => {
  it("proposes a reindex when the index is stale or empty", () => {
    expect(retrievalHeuristics(evidence({ index: { docs: 0, ageHours: -1 } }))[0].payload).toEqual({ action: "reindex" });
    expect(retrievalHeuristics(evidence({ index: { docs: 10, ageHours: 72 } }))).toHaveLength(1);
    expect(retrievalHeuristics(evidence())).toHaveLength(0);
  });

  it("proposes capturing notes when many lookups miss", () => {
    const recs = Array.from({ length: 30 }, (_, i) => ({
      ts: "", query: i < 12 ? "cognify roadmap" : "strategy", hitCount: i < 12 ? 0 : 3,
      sources: { index: 0, memory: 0, vaultScan: 0, vector: 0 }, topScore: 0, ms: 1, vectorEnabled: false,
    }));
    const out = retrievalHeuristics(evidence({ retrieval: summarizeRagTelemetry(recs) }));
    expect(out).toHaveLength(1);
    expect(out[0].payload).toMatchObject({ action: "capture-notes" });
    expect((out[0].payload as any).topics).toContain("cognify");
  });
});

describe("buildPrompt", () => {
  it("includes templates and prior proposals so the model can avoid repeats", () => {
    const p = buildPrompt(evidence({ templates: ["general-task — Anything else"], priorProposals: [{ title: "Add Slack MCP", status: "rejected" }] }));
    expect(p).toContain("general-task");
    expect(p).toContain("Add Slack MCP [rejected]");
  });
});

describe("applyImprovementProposal", () => {
  const base = { title: "Friday inbox sweep", why: "inbox piled up", implementation: ["triage unread", "draft replies"], effort: "S" as const };

  it("creates a schedule from a valid payload", async () => {
    const d = deps();
    const out = await applyImprovementProposal({ ...base, kind: "schedule", payload: { templateId: "general-task", inputs: {}, cadence: { daysOfWeek: [5, 5], hour: 16, minute: 0 } } }, d);
    expect(out.ok).toBe(true);
    expect(d.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      name: "Friday inbox sweep", templateId: "general-task", cadence: { daysOfWeek: [5], hour: 16, minute: 0 },
      inputs: { task: expect.stringContaining("triage unread") },
    }));
  });

  it("refuses unknown templates or bad cadences", async () => {
    const d = deps();
    expect((await applyImprovementProposal({ ...base, kind: "schedule", payload: { templateId: "nope", cadence: { daysOfWeek: [], hour: 9, minute: 0 } } }, d)).ok).toBe(false);
    expect((await applyImprovementProposal({ ...base, kind: "schedule", payload: { templateId: "general-task", cadence: { hour: 30 } } }, d)).ok).toBe(false);
    expect(d.createSchedule).not.toHaveBeenCalled();
  });

  it("runs retrieval actions", async () => {
    const d = deps();
    expect((await applyImprovementProposal({ ...base, kind: "retrieval", payload: { action: "reindex" } }, d)).ok).toBe(true);
    expect(d.reindex).toHaveBeenCalled();
    await applyImprovementProposal({ ...base, kind: "retrieval", payload: { action: "reembed" } }, d);
    expect(d.reembed).toHaveBeenCalled();
  });

  it("hands code changes to the architect with the plan as focus", async () => {
    const d = deps();
    const out = await applyImprovementProposal({ ...base, kind: "code" }, d);
    expect(out.ok).toBe(true);
    expect(d.architect).toHaveBeenCalledWith(expect.stringContaining("2. draft replies"));
  });

  it("registers MCP servers disabled", async () => {
    const d = deps();
    const out = await applyImprovementProposal({ ...base, kind: "mcp", payload: { catalogId: "filesystem" } }, d);
    expect(out.ok).toBe(true);
    expect(d.addMcp).toHaveBeenCalledWith(expect.objectContaining({ label: "Filesystem", command: "npx" }));
    expect(d.disableMcp).toHaveBeenCalledWith("m1");
    expect((await applyImprovementProposal({ ...base, kind: "mcp", payload: { catalogId: "missing" } }, d)).ok).toBe(false);
  });

  it("tracks cli/skill/other proposals without side effects", async () => {
    const d = deps();
    const out = await applyImprovementProposal({ ...base, kind: "cli" }, d);
    expect(out.ok).toBe(true);
    expect(d.createSchedule).not.toHaveBeenCalled();
    expect(d.architect).not.toHaveBeenCalled();
  });
});
