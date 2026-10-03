// Tool DNA — opt-in usage-preference memory (lib/tool-dna.ts). Ported from
// KimmyDeku/sebastian's tripDNA: pure frequency counters, gated at ONE write
// site, viewable/resettable. Points the store at a scratch dir per test
// (_setStateFilesForTests) so nothing touches the real .naxion/ state.

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordUsage, getToolDna, resetToolDna, getToolDnaSettings, setPersonalizationEnabled, toolDnaPromptBlock,
  _setStateFilesForTests,
} from "../src/lib/tool-dna.js";

beforeEach(() => {
  _setStateFilesForTests(mkdtempSync(join(tmpdir(), "tool-dna-")));
});

describe("recordUsage / getToolDna", () => {
  it("increments the right counters and ignores absent fields", () => {
    recordUsage({ template: "general-task", skill: "vault-search-first" });
    recordUsage({ template: "general-task" });
    recordUsage({ personaId: "aria" });
    const dna = getToolDna();
    expect(dna.templates["general-task"]).toBe(2);
    expect(dna.skills["vault-search-first"]).toBe(1);
    expect(dna.personas["aria"]).toBe(1);
  });

  it("write-then-read round-trips through persistence", () => {
    recordUsage({ template: "daily-briefing" });
    expect(getToolDna().templates["daily-briefing"]).toBe(1);
  });
});

describe("personalizationEnabled gate — a true opt-out", () => {
  it("records zero counters when disabled, even though the write site still runs", () => {
    setPersonalizationEnabled(false);
    recordUsage({ template: "general-task", skill: "x", personaId: "y" });
    const dna = getToolDna();
    expect(dna.templates).toEqual({});
    expect(dna.skills).toEqual({});
    expect(dna.personas).toEqual({});
  });

  it("re-enabling resumes counting from where the store was left", () => {
    recordUsage({ template: "a" });
    setPersonalizationEnabled(false);
    recordUsage({ template: "a" }); // dropped
    setPersonalizationEnabled(true);
    recordUsage({ template: "a" });
    expect(getToolDna().templates.a).toBe(2);
  });
});

describe("resetToolDna", () => {
  it("zeroes every counter", () => {
    recordUsage({ template: "a", skill: "b", personaId: "c" });
    resetToolDna();
    expect(getToolDna()).toEqual({ templates: {}, skills: {}, personas: {} });
  });
});

describe("toolDnaPromptBlock", () => {
  it("is empty when nothing is learned yet", () => {
    expect(toolDnaPromptBlock()).toBe("");
  });

  it("is empty when personalization is off, even with data recorded", () => {
    recordUsage({ template: "a" });
    setPersonalizationEnabled(false);
    expect(toolDnaPromptBlock()).toBe("");
  });

  it("includes the top templates/skills as JSON once something is learned", () => {
    recordUsage({ template: "daily-briefing" });
    recordUsage({ skill: "vault-search-first" });
    const block = toolDnaPromptBlock();
    expect(block).toContain("Naxie has noticed you use most");
    expect(block).toContain("daily-briefing");
    expect(block).toContain("vault-search-first");
  });
});

describe("getToolDnaSettings", () => {
  it("defaults to enabled", () => {
    expect(getToolDnaSettings().personalizationEnabled).toBe(true);
  });
});
