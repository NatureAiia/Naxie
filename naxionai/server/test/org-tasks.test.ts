// Naxie org-tasks — disk-free core only (ROLE_AUTONOMY, forceApprovalForRole,
// isAutonomousForRole). The CRUD/persistence functions in org-tasks.ts touch
// .neuroworks/org-tasks.json on disk, same as schedules.ts/handoff.ts do —
// consistent with this repo's existing convention (see governance.test.ts),
// those file-store modules aren't unit-tested here, only their pure logic.

import { describe, expect, it } from "vitest";
import {
  ROLE_AUTONOMY,
  forceApprovalForRole,
  isAutonomousForRole,
  classifyOrgRole,
  type OrgRole,
} from "../src/lib/org-tasks.js";

const ALL_ROLES: OrgRole[] = ["scheduler", "researcher", "executor", "admin", "architect"];

describe("ROLE_AUTONOMY", () => {
  it("defines every role with no gaps", () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_AUTONOMY[role]).toBeDefined();
    }
  });

  it("gives every non-architect role read/draft/own-backlog-update autonomy", () => {
    for (const role of ALL_ROLES.filter(r => r !== "architect")) {
      expect(ROLE_AUTONOMY[role].alwaysRequiresApproval).toBe(false);
      expect(ROLE_AUTONOMY[role].autonomous).toEqual(
        expect.arrayContaining(["read", "draft", "own-backlog-update"]),
      );
    }
  });

  it("architect has no autonomous lane beyond reading its own backlog", () => {
    expect(ROLE_AUTONOMY.architect.autonomous).not.toContain("draft");
    expect(ROLE_AUTONOMY.architect.autonomous).toContain("own-backlog-update");
  });
});

describe("forceApprovalForRole", () => {
  it("is true for architect and only architect — the one rule with no override", () => {
    for (const role of ALL_ROLES) {
      expect(forceApprovalForRole(role)).toBe(role === "architect");
    }
  });
});

describe("isAutonomousForRole", () => {
  it("matches a non-architect role's autonomous category list", () => {
    expect(isAutonomousForRole("scheduler", "read")).toBe(true);
    expect(isAutonomousForRole("scheduler", "draft")).toBe(true);
    expect(isAutonomousForRole("scheduler", "own-backlog-update")).toBe(true);
  });

  it("is false for architect on every category, even ones nominally in its own list — forceApprovalForRole always wins", () => {
    expect(isAutonomousForRole("architect", "read")).toBe(false);
    expect(isAutonomousForRole("architect", "own-backlog-update")).toBe(false);
  });
});

describe("classifyOrgRole", () => {
  it("filters out noise jobs the same way jobs.ts's isImportantForVault does", () => {
    expect(classifyOrgRole({ kind: "voice:ask" })).toBeNull();
    expect(classifyOrgRole({ kind: "chat:trivial" })).toBeNull();
    expect(classifyOrgRole({ kind: "db:query" })).toBeNull();
  });

  it("a schedule-fired job is always Scheduler's, regardless of what the fired template does", () => {
    expect(classifyOrgRole({ kind: "insights:general-task", title: "Research competitors", scheduledBy: "sched-1" })).toBe("scheduler");
  });

  it("routes on title/template/task text by keyword", () => {
    expect(classifyOrgRole({ title: "Remind me to call mom tomorrow" })).toBe("scheduler");
    expect(classifyOrgRole({ title: "Daily inbox triage" })).toBe("admin");
    expect(classifyOrgRole({ title: "Research the competitive landscape" })).toBe("researcher");
    expect(classifyOrgRole({ task: "Summarize the attached report" })).toBe("researcher");
  });

  it("defaults anything else that reached this point to Executor — the broad generalist role", () => {
    expect(classifyOrgRole({ title: "Plan and book a trip to Lisbon" })).toBe("executor");
    expect(classifyOrgRole({ title: "Fix the bug in Naxie.tsx" })).toBe("executor");
  });

  it("never classifies chat-originated work as Architect — that role is system-initiated only", () => {
    const titles = ["Remind me", "Triage inbox", "Research X", "Plan a project", "Random ask"];
    for (const title of titles) expect(classifyOrgRole({ title })).not.toBe("architect");
  });
});
