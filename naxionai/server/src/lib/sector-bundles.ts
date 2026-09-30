// Sector → one-click bundle install ("AI Employee"-style packaging). Wires
// together two things that already exist but nothing previously connected:
// sector-packs.ts's SECTORS metadata (suggestedDepartments/Integrations were
// descriptive only) and department-templates.ts's persona-creation. Used to
// also install a per-sector knowledge pack (static generic markdown) — that
// generator was removed along with the Knowledge Packs page; this step just
// dropped rather than being replaced.

import { SECTORS } from "./sector-packs.js";
import { getDepartmentTemplate, applyResolvedTemplate } from "./department-templates.js";
import { listConnectorTemplates } from "./connectors.js";

export type SectorBundleResult = {
  sectorId: string;
  departments: { id: string; departmentName: string; personaCount: number }[];
  suggestedConnectors: { label: string; hasTemplate: boolean }[];
};

// Best-effort — one failing piece (e.g. an unknown department id) never
// blocks the others. Idempotent: applyResolvedTemplate is itself safe to
// re-run (personas are addressed by a stable slugified id).
export function applySectorBundle(sectorId: string): SectorBundleResult {
  const sector = SECTORS.find(s => s.id === sectorId);
  if (!sector) throw new Error(`unknown sector "${sectorId}"`);

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

  return { sectorId, departments, suggestedConnectors };
}
