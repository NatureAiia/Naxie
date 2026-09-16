// Pre-configured department bundles. Each bundle defines the persona(s),
// starter templates, recommended integrations, and workflows for a department.
// Applying a department template creates the personas and templates in one step.

import { addPersona, slugifyId, type Persona } from "./personas.js";

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
    id: "sales-marketing",
    name: "Sales & Marketing",
    tagline: "Content creation, brand compliance, lead qualification, pipeline tracking",
    description: "Combined sales and marketing team: drafts content, monitors brand mentions and enforces brand voice, qualifies leads, updates CRM records, drafts follow-up emails, and produces weekly content and pipeline reports. Integrates with HubSpot and Google.",
    icon: "TrendingUp",
    color: "coral",
    agents: [
      {
        name: "Content Strategist",
        role: "Knowledge",
        jobDescription: "Draft blog posts, social media content, and newsletters. Research industry trends and competitors. Ensure all content follows brand voice guidelines. Produce weekly content performance reports.",
        tone: "engaging, professional, on-brand",
      },
      {
        name: "Sales Analyst",
        role: "Operations",
        jobDescription: "Qualify incoming leads from CRM. Update deal stages and contact records. Draft personalized follow-up emails. Generate weekly pipeline reports with win/loss analysis.",
        tone: "professional, persuasive, concise",
      },
    ],
    recommendedIntegrations: ["slack", "google", "webhook", "hubspot"],
    recommendedTemplates: ["search-brain", "add-note", "daily-briefing"],
    schedule: {
      name: "Weekly sales & marketing report",
      templateId: "daily-briefing",
      cadence: { daysOfWeek: [5], hour: 16, minute: 0 },
    },
    workflow: [
      { persona: "Content Strategist", task: "Research trending topics in the industry" },
      { persona: "Content Strategist", task: "Draft content aligned with brand voice" },
      { persona: "Sales Analyst", task: "Review new leads and qualify by priority" },
      { persona: "Sales Analyst", task: "Update deal stages in CRM" },
      { persona: "Sales Analyst", task: "Draft follow-up sequence for warm leads" },
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
    id: "communications",
    name: "Communications",
    tagline: "Ticket triage, response drafting, press releases, announcements, media & inbound response",
    description: "Combined communications and customer-service team: triages incoming support tickets, drafts responses, tracks resolution SLAs and satisfaction trends, drafts press releases and announcements, and monitors/responds to media and public inquiries — keeping messaging consistent under normal operations and during a crisis. All agents can be pinned to Shona or Ndebele independently (Personas page) for a local-language desk.",
    icon: "Megaphone",
    color: "teal",
    agents: [
      {
        name: "Ticket Responder",
        role: "Operations",
        jobDescription: "Triage incoming support tickets by urgency and category. Draft customer-facing responses that resolve the underlying issue, not just the surface complaint. Match the customer's tone — acknowledge frustration before troubleshooting.",
        tone: "helpful, patient, solution-focused",
      },
      {
        name: "Support Summariser",
        role: "Operations",
        jobDescription: "Track resolution times against SLAs. Summarize weekly support trends, recurring issues, and escalation patterns into a digest for the team lead.",
        tone: "concise, pattern-focused, actionable",
      },
      {
        name: "Comms Writer",
        role: "Knowledge",
        jobDescription: "Draft press releases, announcements, and public statements. Keep messaging consistent with brand voice and, where relevant, crisis-communications guidelines. Prepare statements ahead of known sensitive dates or events.",
        tone: "clear, on-message, calm under pressure",
      },
      {
        name: "Comms Responder",
        role: "Knowledge",
        jobDescription: "Monitor and respond to media and public inquiries. Route sensitive or high-risk questions for human review rather than answering them directly. Log inbound requests and their outcomes.",
        tone: "measured, accurate, non-committal on anything unconfirmed",
      },
    ],
    recommendedIntegrations: ["slack", "google", "webhook"],
    recommendedTemplates: ["daily-briefing"],
    workflow: [
      { persona: "Ticket Responder", task: "Triage new tickets and prioritize" },
      { persona: "Ticket Responder", task: "Draft responses for pending tickets" },
      { persona: "Support Summariser", task: "Generate weekly support metrics report" },
      { persona: "Comms Writer", task: "Draft a release or statement for a pending announcement" },
      { persona: "Comms Responder", task: "Triage and respond to inbound media/public inquiries" },
      { persona: "Comms Writer", task: "Review outgoing statements for consistency before publishing" },
    ],
  },
  {
    id: "operations",
    name: "Operations & Admin",
    tagline: "Process automation, reporting, vendor management",
    description: "Operations team that automates recurring processes, manages vendor relationships, generates operational reports, and keeps the business running smoothly.",
    icon: "Settings",
    color: "red",
    agents: [
      {
        name: "Operations Manager",
        role: "Operations",
        jobDescription: "Automate recurring operational processes. Track vendor contracts and renewals. Generate daily operations status reports. Monitor key operational metrics and flag deviations.",
        tone: "efficient, systematic, proactive",
      },
    ],
    recommendedIntegrations: ["slack", "google", "webhook"],
    recommendedTemplates: ["daily-briefing", "run-digest", "search-brain"],
    schedule: {
      name: "Daily ops briefing",
      templateId: "daily-briefing",
      cadence: { daysOfWeek: [1, 2, 3, 4, 5], hour: 7, minute: 0 },
    },
    workflow: [
      { persona: "Operations Manager", task: "Review overnight alerts and system status" },
      { persona: "Operations Manager", task: "Check vendor deliverables against SLAs" },
      { persona: "Operations Manager", task: "Publish daily operations status report" },
    ],
  },
];

export function listDepartmentTemplates(): DepartmentTemplate[] {
  return DEPARTMENT_TEMPLATES;
}

export function getDepartmentTemplate(id: string): DepartmentTemplate | undefined {
  return DEPARTMENT_TEMPLATES.find(d => d.id === id);
}

// Creates the persona(s) a resolved department template (built-in or custom —
// see routes/departments.ts's resolveDepartment) describes. Shared by the
// /:id/apply route and the sector-bundle installer (sector-packs.ts) so
// there's exactly one code path that turns a template into real personas.
export function applyResolvedTemplate(tpl: DepartmentTemplate): {
  department: string; departmentName: string; personas: { name: string; role: string; id: string }[];
  recommendedIntegrations: string[]; recommendedTemplates: string[]; workflow: DepartmentTemplateStep[]; schedule: DepartmentTemplate["schedule"] | null;
} {
  const created: { name: string; role: string; id: string }[] = [];
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
    created.push({ name: persona.name, role: persona.role, id: persona.id });
  }
  return {
    department: tpl.id,
    departmentName: tpl.name,
    personas: created,
    recommendedIntegrations: tpl.recommendedIntegrations,
    recommendedTemplates: tpl.recommendedTemplates,
    workflow: tpl.workflow,
    schedule: tpl.schedule ?? null,
  };
}
