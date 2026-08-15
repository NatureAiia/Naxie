// Deterministic-router (heuristicPlan) tests.
//
// heuristicPlan is the regex-anchored fast path that runs BEFORE the LLM
// planner. Every branch here exists because the LLM planner mis-routed a
// phrasing live (each has a "caught live 20xx" comment in agent.ts). Those
// branches are exactly the fragile part most likely to break under real
// user-testing phrasing, so we pin the expected tool per representative
// phrasing — a regex tweak that breaks routing surfaces HERE, not in prod.

import { describe, expect, it } from "vitest";
import { heuristicPlan, planSensitiveTools } from "../src/lib/agent.js";

const tools = (t: string) => (heuristicPlan(t)?.steps ?? []).map(s => s.tool);
const firstTool = (t: string) => heuristicPlan(t)?.steps?.[0]?.tool;

describe("heuristicPlan — deterministic routes", () => {
  it("routes notepad reads to system.notepad", () => {
    expect(firstTool("what's in my notepad")).toBe("system.notepad");
    expect(firstTool("summarise my notepad notes")).toBe("system.notepad");
  });

  it("routes a self-contained email to email.send", () => {
    const p = heuristicPlan('send an email to jane@acme.com with subject "Q3 update" and body "The report is ready"');
    expect(p?.steps?.[0]?.tool).toBe("email.send");
    expect((p?.steps?.[0]?.args as any)?.to).toBe("jane@acme.com");
  });

  it("routes org-structure questions to the org-records plan (users.list first)", () => {
    expect(firstTool("what departments exist in our organization?")).toBe("users.list");
    expect(tools("what departments exist in our organization?")).toContain("personas.list");
  });

  it("routes studio-model discovery to media.studio_models", () => {
    expect(firstTool("list the studio models")).toBe("media.studio_models");
  });

  it("routes image generation to media.image", () => {
    expect(firstTool("generate an image of a mountain at sunrise")).toBe("media.image");
    expect(firstTool("design a logo for a coffee shop")).toBe("media.image");
  });

  it("routes video generation to media.video (and beats media.image)", () => {
    expect(firstTool("make a short promo video of a coffee cup")).toBe("media.video");
    expect(firstTool("generate a clip of the skyline")).toBe("media.video");
    // "video ad" stays with the ad-creative → media.image path, not a raw clip.
    expect(firstTool("make a video ad for instagram")).not.toBe("media.video");
  });

  it("routes recurring-schedule creation to schedule.create", () => {
    const p = heuristicPlan('create a schedule called "Morning digest": every weekday at 08:00 run the daily digest report');
    expect(p?.steps?.[0]?.tool).toBe("schedule.create");
    expect((p?.steps?.[0]?.args as any)?.hour).toBe(8);
  });

  it("routes send-existing-images (with a recipient) to media.list → email.send", () => {
    const t = "email the last 3 generated images to jane@acme.com";
    expect(firstTool(t)).toBe("media.list");
    expect(tools(t)).toContain("email.send");
  });
});

describe("heuristicPlan — false-trigger guards", () => {
  it("does NOT send an email for a topic that merely mentions email", () => {
    expect(tools("email marketing best practices")).not.toContain("email.send");
    expect(tools("draft an email campaign strategy")).not.toContain("email.send");
  });

  it("does NOT hit notepad for a plain note request", () => {
    expect(tools("make a note that the client called")).not.toContain("system.notepad");
  });

  it("routes a plain factual question to research, not a side-effecting tool", () => {
    const t = tools("what is the capital of France");
    // A short lookup goes to research.deep — the point is it must NOT trip any
    // of the deterministic side-effecting branches.
    expect(t).not.toContain("email.send");
    expect(t).not.toContain("system.notepad");
    expect(t).not.toContain("media.image");
    expect(t).not.toContain("schedule.create");
  });
});

describe("planSensitiveTools", () => {
  it("reports only the gated tools present in a plan", () => {
    const plan = { steps: [{ tool: "vault.search" }, { tool: "email.send" }, { tool: "db.query" }] } as any;
    expect(planSensitiveTools(plan).sort()).toEqual(["db.query", "email.send"]);
  });
  it("returns [] for a plan with no sensitive tools", () => {
    expect(planSensitiveTools({ steps: [{ tool: "vault.search" }] } as any)).toEqual([]);
    expect(planSensitiveTools(null)).toEqual([]);
  });
});
