// Pre-configured department bundles. Each bundle defines the persona(s),
// starter templates, recommended integrations, and workflows for a department.
// Applying a department template creates the personas and templates in one step.

import { addPersona, slugifyId, type Persona } from "./personas.js";
import { buildStarterTemplates, listPersonaTemplates } from "./persona-templates.js";
import { saveCustomTemplate } from "./custom-templates.js";
import { createSchedule, listSchedules } from "./schedules.js";

export type DepartmentTemplateStep = {
  persona: string;         // persona role name
  task: string;            // what this agent does in the workflow
};

export type DepartmentTemplate = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  icon: string;
  color: string;           // tailwind color class
  agents: {
    name: string;
    role: string;
    jobDescription: string;
    tone?: string;
    // Per-agent language pin — falls back to defaultLanguage below when
    // unset. Both are optional: a department with neither set produces
    // agents that follow the org-wide onboarding language (unchanged
    // default behavior for every existing template).
    language?: "en";
  }[];
  // Department-level default language new agents inherit unless they set
  // their own `language` above.
  defaultLanguage?: "en";
  recommendedIntegrations: string[];
  recommendedTemplates: string[];
  schedule?: {             // optional daily briefing
    name: string;
    templateId: string;
    cadence: { daysOfWeek: number[]; hour: number; minute: number };
  };
  workflow: DepartmentTemplateStep[];  // handoff chain
};

export const DEPARTMENT_TEMPLATES: DepartmentTemplate[] = [
  {
    id: "it-devops",
    name: "ICT",
    tagline: "Infrastructure monitoring, GitHub automation, deployment workflows",
    description: "A complete IT department: monitor repos, triage issues, run deployments, and keep the engineering team aligned. Includes a daily digest of all project activity.",
    icon: "Terminal",
    color: "violet",
    agents: [
      {
        name: "DevOps Engineer",
        role: "Engineering",
        jobDescription: "Monitor GitHub repos for new issues, PRs, and commits. Triage incoming issues by priority. Run deployment workflows and flag failures. Summarize weekly engineering velocity.",
        tone: "technical, precise, actionable",
      },
    ],
    recommendedIntegrations: ["slack", "github"],
    recommendedTemplates: ["summarize-repo", "run-digest", "publish-folder"],
    schedule: {
      name: "Daily engineering digest",
      templateId: "run-digest",
      cadence: { daysOfWeek: [1, 2, 3, 4, 5], hour: 8, minute: 0 },
    },
    workflow: [
      { persona: "DevOps Engineer", task: "Scan all repos for new activity and summarize" },
      { persona: "DevOps Engineer", task: "Triage open issues by severity and label" },
      { persona: "DevOps Engineer", task: "Deploy pending changes and report status" },
    ],
  },
  {
    id: "finance-legal",
    name: "Finance and Legal",
    tagline: "Expense tracking, financial reporting, contract review, compliance monitoring",
    description: "Combined finance and legal team: tracks expenses, monitors budgets, generates financial reports and flags anomalies, reviews contracts, monitors regulatory compliance, and manages risk assessments. Connects to company data sources for live financial querying and integrates with governance guardrails.",
    icon: "CreditCard",
    color: "navy",
    agents: [
      {
        name: "Financial Analyst",
        role: "Operations",
        jobDescription: "Monitor expenses against budgets. Generate weekly financial summaries. Flag unusual transactions. Prepare month-end reports. Query financial data sources for live numbers.",
        tone: "precise, detail-oriented, conservative",
      },
      {
        name: "Legal Counsel",
        role: "Insights",
        jobDescription: "Review contracts and agreements for compliance risks. Monitor regulatory changes relevant to the business. Draft policies and standard clauses. Conduct compliance assessments of new initiatives.",
        tone: "precise, authoritative, risk-aware",
      },
    ],
    recommendedIntegrations: ["google", "webhook"],
    recommendedTemplates: ["daily-briefing", "search-brain", "add-note"],
    schedule: {
      name: "Weekly finance & legal summary",
      templateId: "daily-briefing",
      cadence: { daysOfWeek: [1], hour: 7, minute: 30 },
    },
    workflow: [
      { persona: "Financial Analyst", task: "Review expenses and flag anomalies" },
      { persona: "Financial Analyst", task: "Update budget vs actuals report" },
      { persona: "Legal Counsel", task: "Review documents for compliance risks" },
      { persona: "Legal Counsel", task: "Research regulatory requirements for new initiative" },
    ],
  },
  {
    id: "business-administration",
    name: "Business Ops",
    tagline: "A founder's operating team for planning, content, customer inbox, and growth",
    description: "A reusable business operations team, initially tuned for Varity Vault. The Chief Executive turns each business's goals into an owned weekly plan; specialists produce launch creative, short-form scripts, evidence-led SEO articles, inbox triage, and campaign reporting. Every brief must identify its business and audience so brands and customer data stay separate. Work is drafted and checked before anything is published, sent, or paid for. If business context or brand facts are missing, ask instead of inventing them.",
    icon: "Briefcase",
    color: "amber",
    agents: [
      {
        name: "Mark",
        role: "Operations",
        jobDescription: "Act as operating lead across the businesses the operator names. Start each cycle by identifying the business, current goal, audience, due date, and success measure; retrieve the relevant brand notes and prior results, and never mix business contexts. Turn goals into an owner, deliverable, deadline, dependency, and completion check for each task. Delegate work to the named specialists, track handoffs, resolve routine blockers, and report progress and evidence. Escalate decisions that change strategy, make commitments, spend money, disclose sensitive information, or publish/send externally; keep all other work moving within approved limits.",
        tone: "decisive, delegating, outcome-focused",
      },
      {
        name: "Takunda",
        role: "Knowledge",
        jobDescription: "Create launch graphics, thumbnails, and promo visuals from an approved brief. Confirm the business and audience, use only verified brand colors, fonts, logos, and claims, and flag missing assets instead of approximating them. Deliver web-ready files with dimensions, alt text, source assets, and usage notes. Give the Growth Marketer a short handoff describing the intended channel and campaign; do not publish assets.",
        tone: "creative, precise, on-brand",
      },
      {
        name: "Lesley",
        role: "Knowledge",
        jobDescription: "Turn an approved brief into platform-native short-form scripts. Lead with a specific hook, keep beats concise, include a clear but truthful call to action, and label any claim that needs substantiation. Match the named business's voice and audience; do not invent product features, prices, testimonials, or outcomes. Hand over the script, caption, shot list, and source notes to the Growth Marketer. Draft only; scheduling and publication require approval.",
        tone: "punchy, conversational, hook-first",
      },
      {
        name: "Kupakwashe",
        role: "Knowledge",
        jobDescription: "Research the named business's audience and search intent before proposing topics. For each approved cycle, prepare two distinct, useful article drafts with keyword rationale, outline, meta title and description, internal-link suggestions, and reputable citations for factual claims. Separate sourced facts from recommendations, avoid keyword stuffing and unsupported product claims, and hand the drafts plus source list to the Growth Marketer. Do not publish.",
        tone: "clear, helpful, search-aware",
      },
      {
        name: "Tricia",
        role: "Operations",
        jobDescription: "Triage connected business inbox messages as Act-now, Read-later, or FYI, with a reason, sender, date, and next action. Draft replies for Act-now items; never send, forward, delete, or commit the business without explicit approval. Flag payment requests, legal issues, complaints, credentials, and ambiguous requests for the operator. Maintain an honest open-item list and produce a five-hour status report when a five-hour schedule is configured; do not claim that cadence is active unless it is.",
        tone: "organized, responsive, calm under load",
      },
      {
        name: "Roselene",
        role: "Operations",
        jobDescription: "Assemble a campaign pack from approved assets: newsletter draft, channel-specific social copy, links, proposed send/publish times, and a content-calendar entry. Confirm the business, audience, offer, dates, and approved claims; attach a basic KPI plan and tracking links where supported. Repurpose the Designer, Script Writer, and SEO Writer outputs without changing their verified claims. Get human approval before sending email, publishing social content, spending on promotion, or promising delivery. Report measured results with period and data source; distinguish missing data from zero performance.",
        tone: "engaging, professional, data-aware",
      },
    ],
    recommendedIntegrations: ["slack", "google", "ayrshare", "mailjet"],
    recommendedTemplates: ["daily-briefing", "email-to-vault", "search-brain", "add-note"],
    schedule: {
      name: "Weekly goals + delegation briefing",
      templateId: "daily-briefing",
      cadence: { daysOfWeek: [1], hour: 7, minute: 0 },
    },
    workflow: [
      { persona: "Mark", task: "Review this week's goals and break them into assignable tasks" },
      { persona: "Kupakwashe", task: "Research search intent and submit two evidence-backed article briefs" },
      { persona: "Lesley", task: "Draft a short-form script and caption against the approved campaign brief" },
      { persona: "Takunda", task: "Create campaign assets using verified brand references and deliver a channel-ready handoff" },
      { persona: "Tricia", task: "Triage the business inbox, draft urgent replies, and flag approval-required items" },
      { persona: "Kupakwashe", task: "Turn approved briefs into two sourced article drafts with metadata and internal links" },
      { persona: "Roselene", task: "Assemble an approval-ready campaign pack and measurable distribution plan" },
      { persona: "Mark", task: "Verify owners, evidence, deadlines, and approvals; report outcomes and decisions needed" },
    ],
  },
];

export function listDepartmentTemplates(): DepartmentTemplate[] {
  return DEPARTMENT_TEMPLATES;
}

export function getDepartmentTemplate(id: string): DepartmentTemplate | undefined {
  return DEPARTMENT_TEMPLATES.find(d => d.id === id);
}

// Creates the personas and ensures each has usable starter tasks. Reapplying
// preserves existing persona templates rather than overwriting user edits.
export function applyResolvedTemplate(tpl: DepartmentTemplate): {
  department: string; departmentName: string; personas: { name: string; role: string; id: string }[];
  starterTemplatesCreated: number;
  recommendedIntegrations: string[]; recommendedTemplates: string[]; workflow: DepartmentTemplateStep[];
  schedule: DepartmentTemplate["schedule"] | null;
  scheduleCreated: { id: string; name: string } | null;
} {
  const created: { name: string; role: string; id: string }[] = [];
  let starterTemplatesCreated = 0;
  for (const agent of tpl.agents) {
    const persona: Persona = {
      id: slugifyId(agent.name),
      name: agent.name,
      role: agent.role,
      description: `Part of the ${tpl.name} department`,
      jobDescription: agent.jobDescription,
      tone: agent.tone ?? "professional",
      responsibilities: tpl.workflow.filter(w => w.persona === agent.name).map(w => w.task),
      language: agent.language ?? tpl.defaultLanguage,
      // Structured field (see personas.ts) alongside the free-text description
      // above — this is what actually seats the persona in the right Office room.
      department: tpl.id,
      createdAt: new Date().toISOString(),
    };
    addPersona(persona);
    if (listPersonaTemplates(persona.id).length === 0) {
      const starterTemplates = buildStarterTemplates(persona);
      for (const template of starterTemplates) saveCustomTemplate(template);
      starterTemplatesCreated += starterTemplates.length;
    }
    created.push({ name: persona.name, role: persona.role, id: persona.id });
  }
  let scheduleCreated: { id: string; name: string } | null = null;
  if (tpl.schedule) {
    const existing = listSchedules().find(s => s.name === tpl.schedule!.name && s.inputs?.department === tpl.id);
    if (existing) scheduleCreated = { id: existing.id, name: existing.name };
    else {
      const createdSchedule = createSchedule({
        name: tpl.schedule.name,
        templateId: tpl.schedule.templateId,
        inputs: {
          department: tpl.id,
          focus: `${tpl.name}: review current goals, open work, and decisions for this week's plan. Keep this business context separate from other businesses.`,
        },
        cadence: tpl.schedule.cadence,
        enabled: true,
      });
      scheduleCreated = { id: createdSchedule.id, name: createdSchedule.name };
    }
  }
  return {
    department: tpl.id,
    departmentName: tpl.name,
    personas: created,
    starterTemplatesCreated,
    recommendedIntegrations: tpl.recommendedIntegrations,
    recommendedTemplates: tpl.recommendedTemplates,
    workflow: tpl.workflow,
    schedule: tpl.schedule ?? null,
    scheduleCreated,
  };
}
