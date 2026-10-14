// System-audit detector contracts (2026-10-12 fixes): same-namespace stale
// checks, structural-reference-aware template dormancy, built-in persona
// guardrails. Guards against the 20-false-positive "decoupling" incident.
import { describe, expect, it } from "vitest";
import {
  deriveFindings,
  structurallyReferencedTemplates,
  type FileInventory,
  type UsageSignals,
} from "../src/lib/system-audit.js";

function baseUsage(): UsageSignals {
  return {
    totalJobs30d: 1, succeeded30d: 1, failed30d: 0, successRate30d: 1,
    byTemplate: {}, byPersona: {},
    auditEvents30d: 5, auditByActor: {},
    orgTasks: { total: 1, byStatus: {}, byRole: {}, staleApprovals: 0, blocked: 0 },
    schedulesEnabled: 1, schedulesDisabled: 0,
    vaultNotes: 100, vaultSizeMb: 10,
    pageViewPaths: new Set<string>(),
  };
}

function baseInventory(): FileInventory {
  return {
    pages: [], routes: [], libFiles: [], components: [],
    templates: [], personas: [],
    schedules: 0, connectors: 0, integrations: 0,
    totalServerFiles: 1, totalWebFiles: 1,
  };
}

describe("structurallyReferencedTemplates", () => {
  it("includes department/sector-referenced templates", () => {
    const refs = structurallyReferencedTemplates();
    for (const id of ["run-digest", "daily-briefing", "search-brain", "summarize-repo"]) {
      expect(refs.has(id), id).toBe(true);
    }
  });
});

describe("deriveFindings template dormancy", () => {
  it("marks referenced-but-unrun templates keep/do-not-retire", () => {
    const inv = baseInventory();
    inv.templates = [
      { id: "run-digest", role: "Engineering", title: "Run daily digest" },
      { id: "zzz-orphan-template", role: "Insights", title: "Orphan" },
    ];
    const { dormant } = deriveFindings(inv, baseUsage());
    const kept = dormant.find(d => d.name.startsWith("run-digest"));
    const plain = dormant.find(d => d.name.startsWith("zzz-orphan-template"));
    expect(kept, "referenced flagged").toBeDefined();
    expect(plain, "unreferenced flagged").toBeDefined();
    expect(kept!.reason).toContain("do not retire");
    expect(plain!.reason).not.toContain("do not retire");
  });
});

describe("deriveFindings persona dormancy", () => {
  it("tags built-ins as never-auto-retire, customs plainly", () => {
    const inv = baseInventory();
    inv.personas = ["Sam", "CustomHire"];
    const usage = baseUsage();
    usage.byTemplate = { "general-task": { total: 1, ok: 1, failed: 0 } };
    usage.byPersona = { SomeoneElse: 1 };
    const { dormant } = deriveFindings(inv, usage);
    const builtin = dormant.find(d => d.kind === "persona" && d.name === "Sam");
    const custom = dormant.find(d => d.kind === "persona" && d.name === "CustomHire");
    expect(builtin, "Sam flagged").toBeDefined();
    expect(custom, "CustomHire flagged").toBeDefined();
    expect(builtin!.reason).toContain("never auto-retire");
    expect(custom!.reason).not.toContain("never auto-retire");
  });
});

describe("deriveFindings page dormancy", () => {
  it("counts an embedded tab as used when its host page was visited", () => {
    // Real web tree: MyWork.tsx does `import { Runs } from "./Runs"` (capital
    // R) — the import-graph match was case-sensitive and never fired.
    const inv = baseInventory();
    inv.pages = [
      { file: "pages/MyWork.tsx", route: "mywork" },
      { file: "pages/Runs.tsx", route: "runs" },
      { file: "pages/AgentApprovals.tsx", route: "agentapprovals" },
    ];
    const usage = baseUsage();
    usage.pageViewPaths = new Set(["/my-work"]);
    const { dormant } = deriveFindings(inv, usage);
    const pages = dormant.filter(d => d.kind === "page").map(d => d.name);
    expect(pages).not.toContain("runs");
    expect(pages).not.toContain("agentapprovals");
  });
});

describe("deriveFindings route checks", () => {
  it("never flags cross-namespace page-vs-API mismatches", () => {
    const inv = baseInventory();
    // Page slug "agentapprovals" vs API files "org-tasks"/"templates": the old
    // detector flagged this as a stale route. Same-namespace logic must not.
    inv.pages = [{ file: "pages/AgentApprovals", route: "agentapprovals" }];
    inv.routes = ["org-tasks", "templates"];
    const { dormant } = deriveFindings(inv, baseUsage());
    expect(dormant.some(d => d.reason.includes("doesn't match any registered route"))).toBe(false);
    expect(dormant.some(d => d.kind === "route" && d.name === "agentapprovals")).toBe(false);
  });
});
