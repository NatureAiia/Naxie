import { Router } from "express";
import { listDepartmentTemplates, getDepartmentTemplate, applyResolvedTemplate } from "../lib/department-templates.js";
import { listCustomDepartments, createCustomDepartment, deleteCustomDepartment, customToListRow, customToTemplate } from "../lib/custom-departments.js";
import { requireLayer, callerOf } from "../lib/access.js";

export const departmentsRouter = Router();

// Resolve a department id to a full template — built-ins first, then
// operator-created custom departments.
function resolveDepartment(id: string) {
  const builtin = getDepartmentTemplate(id);
  if (builtin) return builtin;
  const custom = listCustomDepartments().find(d => d.id === id);
  return custom ? customToTemplate(custom) : undefined;
}

// GET /api/departments — built-in templates + operator-created custom ones.
departmentsRouter.get("/", (_req, res) => {
  const templates = listDepartmentTemplates();
  res.json({
    departments: [
      ...templates.map(d => ({
        id: d.id, name: d.name, tagline: d.tagline,
        description: d.description, icon: d.icon, color: d.color,
        agentCount: d.agents.length,
        integrationCount: d.recommendedIntegrations.length,
        hasSchedule: !!d.schedule,
        workflowSteps: d.workflow.length,
        custom: false,
      })),
      ...listCustomDepartments().map(customToListRow),
    ],
  });
});

// POST /api/departments — create a custom department (admin/superadmin only;
// the router mount stays open so staff keep GET, so this verb is gated here).
departmentsRouter.post("/", requireLayer("admin"), (req, res) => {
  try {
    const b = req.body ?? {};
    const dept = createCustomDepartment({
      name: b.name, tagline: b.tagline, description: b.description,
      icon: b.icon, color: b.color,
      roles: Array.isArray(b.roles) ? b.roles : typeof b.roles === "string" ? String(b.roles).split(",") : [],
      createdBy: callerOf(req)?.email,
    });
    res.json({ department: dept });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// DELETE /api/departments/:id — remove a custom department (admin+). Built-ins
// are code and can't be deleted.
departmentsRouter.delete("/:id", requireLayer("admin"), (req, res) => {
  if (getDepartmentTemplate(req.params.id)) {
    return res.status(400).json({ error: "built-in departments can't be deleted" });
  }
  const ok = deleteCustomDepartment(req.params.id);
  if (!ok) return res.status(404).json({ error: "custom department not found" });
  res.json({ ok: true });
});

// GET /api/departments/:id — detailed view (built-in or custom).
departmentsRouter.get("/:id", (req, res) => {
  const tpl = resolveDepartment(req.params.id);
  if (!tpl) return res.status(404).json({ error: "department template not found" });
  res.json({ department: tpl });
});

// POST /api/departments/:id/apply — deploy a department template.
// Creates the persona(s) listed in the template so the operator can
// immediately start hiring workers for this department.
departmentsRouter.post("/:id/apply", requireLayer("admin"), async (req, res) => {
  try {
    const tpl = resolveDepartment(req.params.id);
    if (!tpl) return res.status(404).json({ error: "department template not found" });

    const result = applyResolvedTemplate(tpl);
    res.json({
      ...result,
      message: `Applied "${result.departmentName}" — ${result.personas.length} hires created, ${result.starterTemplatesCreated} starter task templates added, and ${result.scheduleCreated ? "the recurring briefing is scheduled" : "no schedule was needed"}. Review the hires on the Team page and connect any recommended integrations before external work.`,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});
