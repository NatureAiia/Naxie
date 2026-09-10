// Sector → one-click bundle install ("AI Employee"-style packaging). Wires
// together three things that already exist but nothing previously connected:
// sector-packs.ts's SECTORS metadata (suggestedDepartments/Integrations were
// descriptive only), knowledge-packs.ts's per-sector pack generator, and
// department-templates.ts's persona-creation. Lives in its own file (not
// sector-packs.ts) to avoid a cycle: knowledge-packs.ts already imports
// SECTORS from sector-packs.ts, so sector-packs.ts importing back into
// knowledge-packs.ts would be circular.

import { SECTORS } from "./sector-packs.js";
import { installKnowledgePack } from "./knowledge-packs.js";
import { getDepartmentTemplate, applyResolvedTemplate } from "./department-templates.js";
import { listConnectorTemplates } from "./connectors.js";

export type SectorBundleResult = {
  sectorId: string;
  knowledgePack: { installed: boolean; files: string[] };
  departments: { id: string; departmentName: string; personaCount: number }[];
  suggestedConnectors: { label: string; hasTemplate: boolean }[];
};

// Best-effort — one failing piece (e.g. an unknown department id) never
// blocks the others. Idempotent: installKnowledgePack/applyResolvedTemplate
// are themselves safe to re-run (knowledge packs overwrite their own files;
// personas are addressed by a stable slugified id).
export function applySectorBundle(sectorId: string): SectorBundleResult {
  const sector = SECTORS.find(s => s.id === sectorId);
  if (!sector) throw new Error(`unknown sector "${sectorId}"`);

  let knowledgePack: SectorBundleResult["knowledgePack"] = { installed: false, files: [] };
  try {
    const r = installKnowledgePack(sectorId);
    knowledgePack = { installed: r.ok, files: r.files };
  } catch (e: any) { console.warn(`[sector-bundles] knowledge pack install failed: ${e?.message ?? e}`); }

  const departments: SectorBundleResult["departments"] = [];
  for (const deptId of sector.suggestedDepartments) {
    try {
      const tpl = getDepartmentTemplate(deptId);
      if (!tpl) { console.warn(`[sector-bundles] sector "${sectorId}" suggests unknown department "${deptId}"`); continue; }
      const applied = applyResolvedTemplate(tpl);
      departments.push({ id: applied.department, departmentName: applied.departmentName, personaCount: applied.personas.length });
    } catch (e: any) { console.warn(`[sector-bundles] applying department "${deptId}" failed: ${e?.message ?? e}`); }
  }

  const templateLabels = new Set(listConnectorTemplates().map(t => t.label.toLowerCase()));
  const suggestedConnectors = sector.suggestedIntegrations.map(label => ({
    label, hasTemplate: templateLabels.has(label.toLowerCase()),
  }));

  return { sectorId, knowledgePack, departments, suggestedConnectors };
}
