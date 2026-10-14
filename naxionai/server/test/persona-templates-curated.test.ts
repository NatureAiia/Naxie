import { describe, expect, it, vi } from "vitest";
import { buildStarterTemplates } from "../src/lib/persona-templates.js";
import { BUILTIN_RESEARCHER_PERSONA, BUILTIN_ENGINEER_PERSONA, BUILTIN_NAXIE_PERSONA, BUILTIN_KNOWITALL_PERSONA } from "../src/lib/personas.js";

vi.mock("../src/lib/custom-templates.js", () => ({
  loadCustomTemplates: vi.fn(() => []),
  saveCustomTemplate: vi.fn(),
  deleteCustomTemplate: vi.fn(),
  slugify: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60),
}));

describe("persona-templates", () => {
  it("builds curated templates for researcher persona", () => {
    const templates = buildStarterTemplates(BUILTIN_RESEARCHER_PERSONA);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0].id).toMatch(/^custom-researcher-/);
    expect(templates[0].role).toBe("Custom");
  });

  it("builds curated templates for software-engineer persona", () => {
    const templates = buildStarterTemplates(BUILTIN_ENGINEER_PERSONA);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0].id).toMatch(/^custom-software-engineer-/);
  });

  it("builds curated templates for naxie-agent persona", () => {
    const templates = buildStarterTemplates(BUILTIN_NAXIE_PERSONA);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates.every(t => t.id.startsWith("custom-naxie-"))).toBe(true);
  });

  it("builds generic templates for knowitall persona (no curated set)", () => {
    const templates = buildStarterTemplates(BUILTIN_KNOWITALL_PERSONA);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0].id).toMatch(/^custom-knowitall-/);
  });
});
