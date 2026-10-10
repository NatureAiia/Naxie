// Pre-organized teams + reusable team-brief templates.
//
// A PRE-ORGANIZED TEAM is a named group of personas the user dispatches as a
// unit: pick the team + give one objective, and Naxie fans the objective out
// to each member, framed for their role. Built-in / static.
//
// A TEAM TEMPLATE is a saved, reusable brief — a named set of {persona, task}
// pairs for a recurring multi-persona workflow (e.g. "launch announcement
// pack"). Tasks may contain the placeholder {{objective}}, substituted at
// dispatch. A few are seeded per team; users can add/remove their own
// (persisted to .naxion/team-templates.json).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPersonas } from "./personas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.naxion");
const FILE = join(STATE_DIR, "team-templates.json");

export type TeamMember = { personaId: string; role: string };
export type PreorgTeam = { id: string; name: string; description: string; members: TeamMember[] };

// Pruned 2026-09-21 alongside personas.ts's own prune (all built-ins had zero
// recorded activity in 30 days). "Product squad" and "Launch & marketing"
// were removed outright — trimming their now-deleted members left each with
// only a single surviving/unaffected persona, too sparse to call a team (see
// department-templates.ts's same 0-1-survivor threshold). "Insurance desk"
// and "Research & GTM" kept 2 members each after trimming, so they stay.
export const BUILTIN_TEAMS: PreorgTeam[] = [
  {
    id: "insurance-desk",
    name: "Insurance desk",
    description: "Quotes, underwriting, and policy/contract review.",
    members: [
      { personaId: "insurance-sales-agent", role: "Insurance Sales Agent" },
      { personaId: "insurance-underwriter", role: "Insurance Underwriter" },
    ],
  },
  {
    id: "research-gtm",
    name: "Research & GTM",
    description: "Research pods and go-to-market / deal work.",
    members: [
      { personaId: "researcher", role: "Investigative analyst" },
      { personaId: "head-of-ai", role: "Head of AI" },
    ],
  },
  {
    id: "business-ops",
    name: "Business Ops",
    description: "Parallel planning and campaign work for the installed Business Ops department.",
    members: [
      { personaId: "mark", role: "Chief Executive" },
      { personaId: "takunda", role: "Brand Designer" },
      { personaId: "lesley", role: "Script Writer" },
      { personaId: "kupakwashe", role: "SEO Writer" },
      { personaId: "tricia", role: "Inbox Manager" },
      { personaId: "roselene", role: "Growth Marketer" },
    ],
  },
];

export function listTeams(): PreorgTeam[] {
  const installedIds = new Set(loadPersonas().personas.map(p => p.id));
  return BUILTIN_TEAMS.filter(team => team.id !== "business-ops" || team.members.every(m => installedIds.has(m.personaId)));
}
export function getTeam(id: string): PreorgTeam | undefined {
  return listTeams().find(t => t.id === id);
}

export type TeamTemplateTask = { persona: string; content: string };
export type TeamTemplate = {
  id: string;
  name: string;
  description?: string;
  teamId?: string;            // optional link to a pre-org team
  tasks: TeamTemplateTask[];  // content may contain {{objective}}
  builtin?: boolean;
  createdAt: string;
};

// Seeded templates — one recurring brief per team. {{objective}} is replaced
// with the caller's objective at dispatch (left as a generic prompt if absent).
// "tpl-launch-pack" (launch-marketing) and "tpl-feature-kickoff" (product-squad)
// were removed 2026-09-21 along with their now-deleted teams above.
const SEED_TEMPLATES: TeamTemplate[] = [
  {
    id: "tpl-policy-review", name: "New policy review", teamId: "insurance-desk", builtin: true, createdAt: "",
    description: "Underwriting risk and sales angle for a policy.",
    tasks: [
      { persona: "insurance-underwriter", content: "Assess the key underwriting risks and required information for: {{objective}}" },
      { persona: "insurance-sales-agent", content: "Draft a concise customer-facing pitch and 3 FAQs for: {{objective}}" },
    ],
  },
  {
    id: "tpl-market-scan", name: "Market scan", teamId: "research-gtm", builtin: true, createdAt: "",
    description: "Landscape and AI-implications scan for a market or opportunity.",
    tasks: [
      { persona: "researcher", content: "Summarize the current landscape and 3 key players for: {{objective}} (cite sources)" },
      { persona: "head-of-ai", content: "Assess the AI implications and 2 build-vs-buy considerations for: {{objective}}" },
    ],
  },
  {
    id: "tpl-business-ops-weekly-sprint", name: "Business Ops weekly sprint", teamId: "business-ops", builtin: true, createdAt: "",
    description: "Dispatch a bounded weekly business objective to all six specialists in parallel. Each returns a self-contained deliverable and flags dependencies, assumptions, and approval needs.",
    tasks: [
      { persona: "mark", content: "Turn this weekly objective into a short operating brief: business, goal, audience, success measure, deadline, owners, dependencies, and decisions requiring the operator. Ask for missing critical context; do not assume facts. Objective: {{objective}}" },
      { persona: "takunda", content: "For the named business and objective, propose one campaign visual direction with a concrete asset checklist, channel dimensions, accessible alt text, and any brand references needed. Do not invent brand rules or publish. Flag assumptions. Objective: {{objective}}" },
      { persona: "lesley", content: "For the named business and objective, draft one short-form video script with a strong opening hook, concise beats, caption, and truthful CTA. Flag claims needing evidence; do not invent features, results, or testimonials. Objective: {{objective}}" },
      { persona: "kupakwashe", content: "For the named business and objective, identify likely search intent and propose two distinct article briefs with target query, reader need, outline, and sources to verify. Separate observed evidence from hypotheses. Objective: {{objective}}" },
      { persona: "tricia", content: "Review the connected business inbox for items relevant to this objective. Return Act-now / Read-later / FYI with reasons and draft urgent replies only. Do not send or delete anything. If inbox access is unavailable, say so. Objective: {{objective}}" },
      { persona: "roselene", content: "Create an approval-ready distribution plan for this objective: newsletter outline, channel-specific post concepts, proposed timing, measurable KPIs, and tracking needs. Treat other specialist outputs as pending parallel work; state what must be merged before launch. Do not send, publish, or spend. Objective: {{objective}}" },
    ],
  },
];

type Store = { templates: TeamTemplate[] };
let cache: Store | null = null;

function load(): Store {
  if (cache) return cache;
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(FILE)) {
    cache = { templates: [] };
    persist();
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8"));
    cache = { templates: Array.isArray(parsed.templates) ? parsed.templates : [] };
  } catch (e) {
    console.warn(`[teams] failed to read ${FILE}: ${(e as Error).message}. Starting empty.`);
    cache = { templates: [] };
  }
  return cache;
}

function persist() {
  if (!cache) return;
  try { writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
  catch (e) { console.warn(`[teams] persist failed: ${(e as Error).message}`); }
}

// Built-in seeds first, then the user's saved templates.
export function listTeamTemplates(): TeamTemplate[] {
  return [...SEED_TEMPLATES, ...load().templates].filter(t => t.teamId !== "business-ops" || !!getTeam("business-ops"));
}

export function getTeamTemplate(id: string): TeamTemplate | undefined {
  return listTeamTemplates().find(t => t.id === id);
}

export function createTeamTemplate(input: { name: string; description?: string; teamId?: string; tasks: TeamTemplateTask[] }): TeamTemplate {
  const s = load();
  const tpl: TeamTemplate = {
    id: `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: input.name,
    description: input.description,
    teamId: input.teamId,
    tasks: input.tasks,
    createdAt: new Date().toISOString(),
  };
  s.templates.push(tpl);
  persist();
  return tpl;
}

export function deleteTeamTemplate(id: string): boolean {
  const s = load();
  const before = s.templates.length;
  s.templates = s.templates.filter(t => t.id !== id);
  if (s.templates.length === before) return false;
  persist();
  return true;
}

// Expand a pre-org team + objective into per-member tasks, each framed for the
// member's role so they contribute their slice rather than duplicating work.
export function buildTasksForTeam(teamId: string, objective: string): TeamTemplateTask[] {
  const team = getTeam(teamId);
  if (!team) return [];
  const obj = objective.trim();
  return team.members.map(m => ({
    persona: m.personaId,
    content: `${obj}\n\n(Contribute the part that fits your role as ${m.role}. Produce your slice of this objective; assume teammates cover the rest.)`,
  }));
}

// Expand a team template into tasks, substituting {{objective}} when provided.
export function buildTasksForTemplate(templateId: string, objective?: string): TeamTemplateTask[] {
  const tpl = getTeamTemplate(templateId);
  if (!tpl) return [];
  const obj = (objective ?? "").trim();
  return tpl.tasks.map(t => ({
    persona: t.persona,
    content: obj ? t.content.replace(/\{\{\s*objective\s*\}\}/gi, obj) : t.content.replace(/\{\{\s*objective\s*\}\}/gi, "the stated objective"),
  }));
}
