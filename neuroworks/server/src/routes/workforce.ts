// Workforce contact book.
//
// One directory of everyone who works in the org — the AI workforce (personas,
// the agents you can hire/dispatch) AND the human team (the Users directory).
// Grouped by department so the operator can see, at a glance, who covers what.
//
// GET /api/workforce → { departments: [ { department, agents[], people[] } ], counts }
//
// AI personas don't carry a department field, so we infer one from the role via
// a keyword classifier (good enough for a contact book; the human Users do
// carry an explicit department).

import { Router } from "express";
import { loadPersonas, BUILTIN_PERSONAS } from "../lib/personas.js";
import { listUsers } from "../lib/users.js";
import { callerLayer } from "../lib/access.js";

export const workforceRouter = Router();

// Map a persona role/id to a department bucket. First match wins; falls back to
// "General". Ordered so more specific buckets are tested before broad ones.
const DEPT_RULES: { dept: string; re: RegExp }[] = [
  { dept: "Executive", re: /\b(chief|ceo|cto|cfo|coo|head of|founder|operator|executive assistant)\b/i },
  { dept: "Finance", re: /\b(financ|account|fp&?a|controller|bookkeep|treasur|payroll)\b/i },
  { dept: "Human Resources", re: /\b(hr|recruit|talent|people|learning|development|l&d)\b/i },
  { dept: "Sales", re: /\b(sales|account executive|sdr|business development|insurance sales)\b/i },
  { dept: "Marketing", re: /\b(marketing|brand|growth|communications|comms|content)\b/i },
  { dept: "Engineering", re: /\b(engineer|developer|devops|sre|software|qa|infrastructure)\b/i },
  { dept: "Product", re: /\b(product manager|product owner|product\b)\b/i },
  { dept: "Design", re: /\b(design|ux|ui|creative)\b/i },
  { dept: "Customer Success", re: /\b(customer success|support|csm|service)\b/i },
  { dept: "Legal & Compliance", re: /\b(legal|counsel|contract|compliance|risk|underwrit|policy)\b/i },
  { dept: "IT Support", re: /\b(it support|help ?desk|systems admin|sysadmin)\b/i },
  { dept: "Procurement", re: /\b(procure|purchasing|vendor|sourcing|buyer)\b/i },
  { dept: "Logistics", re: /\b(logistic|supply|warehouse|fulfilment|fulfillment|shipping)\b/i },
  { dept: "Operations", re: /\b(operations|office manager|coordinator|project manager|admin)\b/i },
  { dept: "Data & Research", re: /\b(research|data analyst|analyst|scientist|insight)\b/i },
  { dept: "AI & Strategy", re: /\b(\bai\b|head of ai|machine learning|strategy|polymath)\b/i },
];

export function personaDepartment(role: string, id: string): string {
  const hay = `${role} ${id}`;
  for (const r of DEPT_RULES) if (r.re.test(hay)) return r.dept;
  return "General";
}

type AgentEntry = {
  kind: "agent";
  id: string;
  name: string;
  role: string;
  description: string;
  responsibilities: string[];
  department: string;
  builtin: boolean;
  // Hybrid-workforce tier — mirrors Persona.workMode; absent means "agent"
  // (fully autonomous), same back-compat convention as Persona itself.
  workMode?: "agent" | "hybrid" | "human";
  // How to reach this worker: activate it, dispatch a chat, or add to a team.
  contact: { activate: string; chat: string };
};

type PersonEntry = {
  kind: "human";
  // User id so the superadmin can MANAGE the person from this page (work
  // mode, salary, department, disable, remove) via the /api/users endpoints.
  id: string;
  name: string;
  email: string;
  role: string;
  title?: string;
  department: string;
  status: string;
  workMode?: string;
  // Present only for superadmin/machine callers — money stays layer-gated.
  salaryMonthly?: number;
};

workforceRouter.get("/", (req, res) => {
  // Layer-aware view: superadmin/machine callers get management fields
  // (salary + disabled/pending people so they can be re-enabled from here);
  // everyone else gets the plain active-people contact book.
  const layer = callerLayer(req);
  const isSuper = layer === null || layer === "superadmin";
  let agents: AgentEntry[] = [];
  try {
    const builtinIds = new Set(BUILTIN_PERSONAS.map(p => p.id));
    agents = loadPersonas().personas.map(p => ({
      kind: "agent" as const,
      id: p.id,
      name: p.name,
      role: p.role,
      description: p.description,
      responsibilities: (p.responsibilities ?? []).slice(0, 4),
      department: personaDepartment(p.role, p.id),
      builtin: builtinIds.has(p.id),
      workMode: p.workMode ?? "agent",
      contact: { activate: `POST /api/personas/${p.id}/activate`, chat: `dispatch via /chat or /team as ${p.name}` },
    }));
  } catch { agents = []; }

  let people: PersonEntry[] = [];
  try {
    people = listUsers()
      .filter(u => isSuper || u.status === "active" || u.status === "invited")
      .map(u => ({
        kind: "human" as const,
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        title: u.title,
        department: u.department?.trim() || "Unassigned",
        status: u.status,
        workMode: u.workMode,
        ...(isSuper && u.salaryMonthly ? { salaryMonthly: u.salaryMonthly } : {}),
      }));
  } catch { people = []; }

  // Group both populations by department.
  const deptNames = new Set<string>([...agents.map(a => a.department), ...people.map(p => p.department)]);
  const departments = [...deptNames].sort().map(dept => ({
    department: dept,
    agents: agents.filter(a => a.department === dept).sort((a, b) => a.name.localeCompare(b.name)),
    people: people.filter(p => p.department === dept).sort((a, b) => a.name.localeCompare(b.name)),
  }));

  res.json({
    departments,
    counts: { agents: agents.length, people: people.length, departments: departments.length },
  });
});
