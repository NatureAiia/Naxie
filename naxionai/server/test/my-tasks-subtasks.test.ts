// Focused tests for the scoped-sub-task extension to my-tasks.ts's
// automation model (spawnSubtask/listChildren/runAutomation's "planner"
// handler, task-scope.ts) — NOT a full my-tasks.ts CRUD test (none existed
// before this file; that's a pre-existing gap, out of scope here).
//
// my-tasks.ts persists to a real on-disk path computed from __dirname, with
// no test-time override. A virtual in-memory filesystem (keyed by path) is
// mocked in so these tests never touch the real .naxion/my-tasks.json.
import { describe, expect, it, vi, beforeEach } from "vitest";

const files = new Map<string, string>();

vi.mock("node:fs", () => ({
  existsSync: (p: string) => files.has(p),
  readFileSync: (p: string) => {
    const v = files.get(p);
    if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return v;
  },
  writeFileSync: (p: string, data: string) => { files.set(p, data); },
  mkdirSync: () => {},
  renameSync: (from: string, to: string) => {
    const v = files.get(from);
    files.delete(from);
    if (v !== undefined) files.set(to, v);
  },
}));

const planAndExecuteMock = vi.fn();
vi.mock("../src/lib/agent.js", () => ({
  planAndExecute: (...args: unknown[]) => planAndExecuteMock(...args),
}));

const {
  addItem, setAutomation, spawnSubtask, listChildren, runAutomation, _resetForTests,
} = await import("../src/lib/my-tasks.js");
const { currentTaskItemId, runInTaskScope } = await import("../src/lib/task-scope.js");

const OWNER = "operator@example.com";

beforeEach(() => {
  files.clear();
  planAndExecuteMock.mockReset();
  _resetForTests();
});

function makeScopedParent() {
  const parent = addItem(OWNER, { title: "Weekly research sweep" });
  setAutomation(parent.id, { enabled: true, tools: ["web.search", "vault.write"], data: ["_naxion/research/"], handler: "planner" });
  return parent;
}

describe("spawnSubtask", () => {
  it("errors when the parent has no automation scope", () => {
    const plain = addItem(OWNER, { title: "Buy milk" });
    const r = spawnSubtask(plain.id, { title: "Sub" });
    expect(r).toEqual({ error: expect.stringMatching(/no automation scope/) });
  });

  it("errors when the parent doesn't exist", () => {
    expect(spawnSubtask("does-not-exist", { title: "Sub" })).toEqual({ error: expect.stringMatching(/not found/) });
  });

  it("inherits the parent's full scope when tools/data are omitted", () => {
    const parent = makeScopedParent();
    const r = spawnSubtask(parent.id, { title: "Check one weak spot" });
    expect("item" in r).toBe(true);
    if ("item" in r) {
      expect(r.item.automation?.tools).toEqual(["web.search", "vault.write"]);
      expect(r.item.automation?.data).toEqual(["_naxion/research/"]);
      expect(r.item.parentId).toBe(parent.id);
      expect(r.item.automation?.handler).toBe("planner");
    }
  });

  it("narrows to the requested subset of the parent's scope", () => {
    const parent = makeScopedParent();
    const r = spawnSubtask(parent.id, { title: "Just search", tools: ["web.search"] });
    if ("item" in r) expect(r.item.automation?.tools).toEqual(["web.search"]);
  });

  it("never widens past the parent's scope even if asked to", () => {
    const parent = makeScopedParent();
    const r = spawnSubtask(parent.id, { title: "Escape attempt", tools: ["web.search", "fs.delete", "shell.exec"] });
    if ("item" in r) expect(r.item.automation?.tools).toEqual(["web.search"]);
  });

  it("errors rather than silently granting everything when the requested tools share nothing with the parent's scope", () => {
    const parent = makeScopedParent();
    const r = spawnSubtask(parent.id, { title: "Escape attempt", tools: ["shell.exec"] });
    expect(r).toEqual({ error: expect.stringMatching(/none of the requested tools/) });
  });

  it("filters data paths to those under the parent's own data scope", () => {
    const parent = makeScopedParent();
    const r = spawnSubtask(parent.id, { title: "Sub", data: ["_naxion/research/sub.md", "_naxion/other/"] });
    if ("item" in r) expect(r.item.automation?.data).toEqual(["_naxion/research/sub.md"]);
  });
});

describe("listChildren", () => {
  it("returns only direct children of the given parent, in creation order", () => {
    const parent = makeScopedParent();
    const other = makeScopedParent();
    const c1 = spawnSubtask(parent.id, { title: "First" });
    const c2 = spawnSubtask(parent.id, { title: "Second" });
    spawnSubtask(other.id, { title: "Unrelated" });
    const kids = listChildren(parent.id);
    expect(kids.map(k => k.title)).toEqual(["First", "Second"]);
    if ("item" in c1 && "item" in c2) expect(kids.map(k => k.id)).toEqual([c1.item.id, c2.item.id]);
  });

  it("returns an empty list for a task with no children", () => {
    const parent = makeScopedParent();
    expect(listChildren(parent.id)).toEqual([]);
  });
});

describe("runAutomation — planner handler", () => {
  it("dispatches via planAndExecute with the item's own tool allowlist, inside its task scope", async () => {
    const parent = makeScopedParent();
    const spawned = spawnSubtask(parent.id, { title: "Check one weak spot", notes: "Look into citations." });
    if (!("item" in spawned)) throw new Error("setup failed");
    let seenTaskIdDuringRun: string | undefined;
    planAndExecuteMock.mockImplementation(async () => {
      seenTaskIdDuringRun = currentTaskItemId();
      return { answer: "done", runs: [], hadWrites: false, plan: { steps: [] }, task: "" };
    });
    const result = await runAutomation(spawned.item.id);
    expect(result).toEqual({ ok: true, answer: "done" });
    expect(seenTaskIdDuringRun).toBe(spawned.item.id);
    const [taskText, , , opts] = planAndExecuteMock.mock.calls[0];
    expect(taskText).toContain("Check one weak spot");
    expect(taskText).toContain("Look into citations.");
    expect(opts.toolAllowlist).toEqual(["web.search", "vault.write"]);
  });

  it("records a failed fire when planAndExecute throws", async () => {
    const parent = makeScopedParent();
    const spawned = spawnSubtask(parent.id, { title: "Sub" });
    if (!("item" in spawned)) throw new Error("setup failed");
    planAndExecuteMock.mockRejectedValue(new Error("model unavailable"));
    const result = await runAutomation(spawned.item.id);
    expect(result).toEqual({ ok: false, error: "model unavailable" });
  });
});

describe("task-scope.ts", () => {
  it("is undefined outside any task scope", () => {
    expect(currentTaskItemId()).toBeUndefined();
  });

  it("is visible to everything the scoped function awaits, and clears after", async () => {
    let seen: string | undefined;
    await runInTaskScope("task-1", async () => {
      await Promise.resolve();
      seen = currentTaskItemId();
    });
    expect(seen).toBe("task-1");
    expect(currentTaskItemId()).toBeUndefined();
  });
});
