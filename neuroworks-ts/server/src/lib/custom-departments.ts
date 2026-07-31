// Custom departments — operator-created departments that live alongside the
// built-in DEPARTMENT_TEMPLATES catalog. A built-in department is a rich
// template (agents, workflow, schedule); a custom one is lighter: a name,
// description, and an optional starter set of roles the operator types in.
// Both surface through the same /api/departments listing so the Departments
// page and the org's department picker treat them uniformly.
//
// Persisted under .neuroworks/custom-departments.json (gitignored).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { DepartmentTemplate } from "./department-templates.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const STORE = resolve(CONFIG_DIR, "custom-departments.json");

export type CustomDepartment = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  icon: string;
  color: string;
  roles: string[];       // role titles the operator wants in this department
  createdAt: string;
  createdBy?: string;
};

function load(): CustomDepartment[] {
  try { if (existsSync(STORE)) return JSON.parse(readFileSync(STORE, "utf8")) as CustomDepartment[]; }
  catch { /* corrupt → empty */ }
  return [];
}
function save(list: CustomDepartment[]): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STORE, JSON.stringify(list, null, 2), { encoding: "utf8", mode: 0o600 });
}

const slug = (s: string) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

export function listCustomDepartments(): CustomDepartment[] {
  return load();
}

export function createCustomDepartment(input: {
  name: string; tagline?: string; description?: string; icon?: string; color?: string;
  roles?: string[]; createdBy?: string;
}): CustomDepartment {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("department name is required");
  const list = load();
  let id = slug(name) || `dept-${Date.now().toString(36)}`;
  if (list.some(d => d.id === id)) id = `${id}-${randomUUID().slice(0, 4)}`;
  const dept: CustomDepartment = {
    id,
    name: name.slice(0, 80),
    tagline: String(input.tagline ?? "").trim().slice(0, 160) || "Custom department",
    description: String(input.description ?? "").trim().slice(0, 1000) || `The ${name} department.`,
    icon: String(input.icon ?? "Building2").trim().slice(0, 40) || "Building2",
    color: String(input.color ?? "violet").trim().slice(0, 40) || "violet",
    roles: (Array.isArray(input.roles) ? input.roles : [])
      .map(r => String(r).trim()).filter(Boolean).slice(0, 20),
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  };
  list.push(dept);
  save(list);
  return dept;
}

export function deleteCustomDepartment(id: string): boolean {
  const list = load();
  const next = list.filter(d => d.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

// Shape a custom department to match the built-in listing row so the API can
// concatenate the two lists without the frontend caring which is which.
export function customToListRow(d: CustomDepartment) {
  return {
    id: d.id, name: d.name, tagline: d.tagline, description: d.description,
    icon: d.icon, color: d.color,
    agentCount: d.roles.length,
    integrationCount: 0,
    hasSchedule: false,
    workflowSteps: 0,
    custom: true,
  };
}

// Adapt a custom department into the full DepartmentTemplate shape (empty
// workflow/schedule) so getDepartmentTemplate/apply can treat it uniformly.
export function customToTemplate(d: CustomDepartment): DepartmentTemplate {
  return {
    id: d.id, name: d.name, tagline: d.tagline, description: d.description,
    icon: d.icon, color: d.color,
    agents: d.roles.map(role => ({
      name: role,
      role,
      jobDescription: `${role} in the ${d.name} department. ${d.description}`,
    })),
    recommendedIntegrations: [],
    recommendedTemplates: [],
    workflow: [],
  };
}
