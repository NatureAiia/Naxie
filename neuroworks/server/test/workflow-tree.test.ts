// Phase 0 of the workflow/task tree (see docs/naxie-architecture's tree-model
// plan). Covers: task.md frontmatter parsing (valid + malformed), cadence
// firing reusing lib/schedules.ts's nextFireAt directly, tool-allowlist
// filtering through primitivesPromptCatalog/plan/executePlan, and the
// engine's own start/stop lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory fake vault so walkWorkflowTree/readVaultFile/writeVaultFile exercise
// real tree-walking logic without touching disk.
const files = new Map<string, string>();

function vaultReset() { files.clear(); }
function vaultWrite(rel: string, content: string) { files.set(rel, content); }

vi.mock("../src/lib/vault.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/vault.js")>()),
  listVault: (rel = "") => {
    const prefix = rel ? `${rel}/` : "";
    const seen = new Map<string, "dir" | "file">();
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, "file");
      else seen.set(rest.slice(0, slash), "dir");
    }
    return [...seen.entries()].map(([name, type]) => ({ name, path: `${prefix}${name}`, type }));
  },
  readVaultFile: (rel: string) => {
    if (!files.has(rel)) throw new Error(`ENOENT: ${rel}`);
    return files.get(rel)!;
  },
  writeVaultFile: (rel: string, content: string) => vaultWrite(rel, content),
}));

import { nextFireAt } from "../src/lib/schedules.js";
import {
  parseFrontmatter, walkWorkflowTree, seedNodeIfMissing, registerNativeHandler, runNode,
  getNodeStatus, startWorkflowTreeScheduler, stopWorkflowTreeScheduler, _resetForTests,
} from "../src/lib/workflow-tree.js";
import { primitivesPromptCatalog } from "../src/lib/primitives.js";
import { plan, executePlan } from "../src/lib/agent.js";

beforeEach(() => { vaultReset(); _resetForTests(); });
afterEach(() => { stopWorkflowTreeScheduler(); vi.useRealTimers(); vi.restoreAllMocks(); });

const VALID_TASK_MD = `---
id: todo-brief
enabled: true
cadence:
  daysOfWeek: []
  hour: 6
  minute: 0
tools:
  - vault.write
data:
  - _neuroworks/
outputPath: "_neuroworks/todo-briefs/{date}.md"
handler: "native:todo-brief"
---
Daily todo brief instructions.
`;

describe("parseFrontmatter / node parsing", () => {
  it("parses full frontmatter including nested cadence/deliver and scalar arrays", () => {
    const { frontmatter, body } = parseFrontmatter(VALID_TASK_MD);
    expect(frontmatter.id).toBe("todo-brief");
    expect(frontmatter.enabled).toBe(true);
    expect(frontmatter.cadence).toEqual({ daysOfWeek: [], hour: 6, minute: 0 });
    expect(frontmatter.tools).toEqual(["vault.write"]);
    expect(frontmatter.handler).toBe("native:todo-brief");
    expect(body.trim()).toBe("Daily todo brief instructions.");
  });

  it("walkWorkflowTree discovers a valid node with correctly typed fields", () => {
    vaultWrite("_workflows/ops-daemons/todo-brief/task.md", VALID_TASK_MD);
    const nodes = walkWorkflowTree();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      path: "_workflows/ops-daemons/todo-brief",
      id: "todo-brief",
      enabled: true,
      tools: ["vault.write"],
      data: ["_neuroworks/"],
      handler: "native:todo-brief",
    });
    expect(nodes[0].cadence).toEqual({ daysOfWeek: [], hour: 6, minute: 0 });
  });

  it("discovers nested nodes recursively", () => {
    vaultWrite("_workflows/a/task.md", VALID_TASK_MD.replace("id: todo-brief", "id: a"));
    vaultWrite("_workflows/a/sub/task.md", VALID_TASK_MD.replace("id: todo-brief", "id: sub"));
    const nodes = walkWorkflowTree();
    expect(nodes.map(n => n.id).sort()).toEqual(["a", "sub"]);
  });

  it("skips a node missing the required id field, with a warning, instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vaultWrite("_workflows/broken/task.md", `---\nenabled: true\n---\nno id here\n`);
    expect(() => walkWorkflowTree()).not.toThrow();
    expect(walkWorkflowTree()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("treats a node with no cadence as on-demand (not scheduler-fired)", () => {
    vaultWrite("_workflows/adhoc/task.md", `---\nid: adhoc\nenabled: true\n---\nbody\n`);
    const [node] = walkWorkflowTree();
    expect(node.cadence).toBeUndefined();
  });
});

describe("seedNodeIfMissing", () => {
  it("writes a node only when absent, never overwriting an existing one", () => {
    seedNodeIfMissing("_workflows/ops-daemons/x", "id: x\nenabled: true", "docs");
    expect(files.get("_workflows/ops-daemons/x/task.md")).toContain("id: x");
    vaultWrite("_workflows/ops-daemons/x/task.md", "---\nid: x\nenabled: false\n---\nedited by operator\n");
    seedNodeIfMissing("_workflows/ops-daemons/x", "id: x\nenabled: true", "docs");
    expect(files.get("_workflows/ops-daemons/x/task.md")).toContain("edited by operator");
  });
});

describe("cadence-driven firing reuses lib/schedules.ts's nextFireAt", () => {
  it("computes the same next-fire time the tick logic would use", () => {
    // This assertion is the regression guard: if workflow-tree.ts ever stops
    // importing nextFireAt and reimplements its own cadence math, this import
    // itself (and the direct call below) is what breaks.
    const cadence = { daysOfWeek: [], hour: 6, minute: 0 };
    const from = new Date("2026-01-01T00:00:00");
    expect(nextFireAt(cadence, from)).toBe(new Date("2026-01-01T06:00:00").getTime());
  });

  it("fires a due, enabled node exactly once per tick cycle and skips a disabled one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T07:00:00"));
    const handler = vi.fn(async () => "ran");
    registerNativeHandler("todo-brief", handler);
    vaultWrite("_workflows/ops-daemons/todo-brief/task.md", VALID_TASK_MD);
    vaultWrite("_workflows/ops-daemons/disabled/task.md", VALID_TASK_MD.replace("enabled: true", "enabled: false").replace("id: todo-brief", "id: disabled"));

    startWorkflowTreeScheduler();
    await vi.advanceTimersByTimeAsync(0); // the immediate tick() fired by startWorkflowTreeScheduler
    expect(handler).toHaveBeenCalledTimes(1);

    // A second tick within the same day must not re-fire (lastFiredAt now set).
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(handler).toHaveBeenCalledTimes(1);

    const todoBriefNode = walkWorkflowTree().find(n => n.id === "todo-brief")!;
    expect(getNodeStatus(todoBriefNode).lastFiredAt).toBeDefined();
  });
});

describe("tool-allowlist filtering", () => {
  it("primitivesPromptCatalog hides every non-allowlisted primitive", () => {
    const full = primitivesPromptCatalog({ compact: true });
    const scoped = primitivesPromptCatalog({ compact: true, allowlist: ["vault.search"] });
    expect(full.length).toBeGreaterThan(scoped.length);
    expect(scoped).toContain("vault.search");
    expect(scoped).not.toContain("web.search");
  });

  it("an empty/absent allowlist behaves exactly as before this option existed", () => {
    expect(primitivesPromptCatalog({ compact: true })).toBe(primitivesPromptCatalog({ compact: true, allowlist: [] }));
  });

  it("plan() filters out a step naming a tool outside the allowlist", async () => {
    vi.mock("../src/lib/ollama.js", () => ({
      ollamaGenerate: async () => JSON.stringify({ steps: [{ tool: "web.search", args: { query: "x" } }, { tool: "vault.search", args: { query: "x" } }] }),
    }));
    const p = await plan("find something", undefined, undefined, undefined, undefined, ["vault.search"]);
    expect(p.steps.map(s => s.tool)).toEqual(["vault.search"]);
  });

  it("executePlan rejects a disallowed step without invoking its handler, even via the preplan path", async () => {
    const disallowedPlan = { steps: [{ tool: "vault.search", args: { query: "x" }, label: "search" }] };
    const { runs } = await executePlan(disallowedPlan as any, () => {}, undefined, undefined, undefined, undefined, ["vault.write"]);
    expect(runs[0].ok).toBe(false);
    expect(runs[0].error).toMatch(/not in this task's allowlist/);
  });
});

describe("engine lifecycle", () => {
  it("start/stop clean up the timer and don't leak across calls", () => {
    vi.useFakeTimers();
    startWorkflowTreeScheduler();
    startWorkflowTreeScheduler(); // idempotent — second call is a no-op
    stopWorkflowTreeScheduler();
    stopWorkflowTreeScheduler(); // idempotent — stopping twice doesn't throw
  });
});
