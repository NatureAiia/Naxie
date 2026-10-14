// Template-subsystem integrity contract: built-in definitions, curated
// persona coverage, classifier drift, and department references. Guards the
// 2026-10-12 cleanups (SI feed removal, CURATED prune, ghost-team hiding).
import { describe, expect, it } from "vitest";
import { templates } from "../src/lib/templates.js";
import { BUILTIN_PERSONAS } from "../src/lib/personas.js";
import { listCuratedPersonaIds, buildStarterTemplates } from "../src/lib/persona-templates.js";
import { PERSONA_ID_TO_ROLE, classifyCustomTemplate } from "../src/lib/template-classifier.js";
import { DEPARTMENT_TEMPLATES } from "../src/lib/department-templates.js";
import { SECTORS } from "../src/lib/sector-packs.js";

const VALID_ROLES = new Set(["Engineering", "Knowledge", "Operations", "Insights"]);
const VALID_INPUT_TYPES = new Set(["text", "number", "boolean", "repo-picker", "textarea"]);

describe("built-in templates", () => {
  it("have unique ids and valid roles", () => {
    const ids = templates.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of templates) {
      expect(VALID_ROLES.has(t.role as string), `${t.id} role`).toBe(true);
    }
  });

  it("has no super-intelligence-news (removed feed)", () => {
    expect(templates.some(t => t.id === "super-intelligence-news")).toBe(false);
    expect(templates.some(t => t.id === "africa-ai-news")).toBe(true);
    expect(templates.some(t => t.id === "world-ai-news")).toBe(true);
  });

  it("uses hidden only for board-meeting", () => {
    expect(templates.filter(t => t.hidden).map(t => t.id)).toEqual(["board-meeting"]);
  });

  it("has well-formed inputs with boolean required flags", () => {
    for (const t of templates) {
      expect(t.estimateSeconds).toBeGreaterThan(0);
      const names = (t.inputs ?? []).map(i => i.name);
      expect(new Set(names).size, `${t.id} dup inputs`).toBe(names.length);
      for (const i of t.inputs ?? []) {
        expect(i.name, `${t.id} input name`).toMatch(/^[a-zA-Z0-9_]+$/);
        expect(VALID_INPUT_TYPES.has(i.type as string), `${t.id}.${i.name} type`).toBe(true);
        expect(typeof i.required === "boolean" || i.required === undefined, `${t.id}.${i.name} required`).toBe(true);
      }
    }
  });

  it("keeps Telegram chatId optional on all news templates", () => {
    for (const id of ["africa-ai-news", "world-ai-news", "events-competition-scan", "deadline-reminders", "evening-recap", "weekend-digest"]) {
      const t = templates.find(x => x.id === id);
      expect(t, id).toBeDefined();
      const chat = (t!.inputs ?? []).find(i => i.name === "chatId");
      expect(chat, `${id} chatId`).toBeDefined();
      expect(chat!.required, `${id} chatId required`).not.toBe(true);
    }
  });
});

describe("persona-template coverage", () => {
  it("CURATED keys are all live built-in persona ids (no dead entries)", () => {
    const live = new Set(BUILTIN_PERSONAS.map(p => p.id));
    for (const id of listCuratedPersonaIds()) {
      expect(live.has(id), `curated ${id} has no built-in persona`).toBe(true);
    }
  });

  it("buildStarterTemplates works for curated and generic personas", () => {
    const curated = buildStarterTemplates({ id: "researcher", name: "R", role: "Researcher", description: "", jobDescription: "", tone: "", responsibilities: [], createdAt: "" } as any);
    expect(curated.length).toBeGreaterThan(0);
    expect(curated.every(t => t.id.startsWith("custom-researcher-"))).toBe(true);
    const generic = buildStarterTemplates({ id: "some-new-hire", name: "N", role: "Analyst", description: "", jobDescription: "", tone: "", responsibilities: ["Do analysis"], createdAt: "" } as any);
    expect(generic.length).toBeGreaterThan(0);
  });
});

describe("template classifier", () => {
  it("map keys are all live built-in persona ids (no drift)", () => {
    const live = new Set(BUILTIN_PERSONAS.map(p => p.id));
    for (const id of Object.keys(PERSONA_ID_TO_ROLE)) {
      expect(live.has(id), `classifier ${id} has no built-in persona`).toBe(true);
    }
  });

  it("routes persona prefixes and falls back to Custom", () => {
    expect(classifyCustomTemplate({ id: "custom-software-engineer-fix-bug", title: "", description: "" })).toBe("Engineering");
    expect(classifyCustomTemplate({ id: "custom-naxie-agent-daily-focus", title: "", description: "" })).toBe("Custom");
    expect(classifyCustomTemplate({ id: "custom-whatever", title: "Write a runbook for deploys", description: "" })).toBe("Engineering");
    expect(classifyCustomTemplate({ id: "custom-whatever", title: "Random musing", description: "no keywords here xyz" })).toBe("Custom");
  });
});

describe("department templates", () => {
  it("references only existing built-in template ids", () => {
    const known = new Set(templates.map(t => t.id));
    for (const d of DEPARTMENT_TEMPLATES) {
      for (const id of d.recommendedTemplates ?? []) {
        expect(known.has(id), `${d.id} recommended ${id}`).toBe(true);
      }
      if (d.schedule) {
        expect(known.has(d.schedule.templateId), `${d.id} schedule ${d.schedule.templateId}`).toBe(true);
      }
    }
  });

  it("has unique department ids", () => {
    const ids = DEPARTMENT_TEMPLATES.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("sector packs", () => {
  it("suggest only existing built-in template and department ids", () => {
    const knownTemplates = new Set(templates.map(t => t.id));
    const knownDepts = new Set(DEPARTMENT_TEMPLATES.map(d => d.id));
    for (const s of SECTORS) {
      for (const id of s.suggestedTemplates ?? []) {
        expect(knownTemplates.has(id), `${s.id} suggested template ${id}`).toBe(true);
      }
      for (const id of s.suggestedDepartments ?? []) {
        expect(knownDepts.has(id), `${s.id} suggested department ${id}`).toBe(true);
      }
    }
  });
});
