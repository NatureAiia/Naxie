"""
NAXIONAI — Org-modeling static catalog (Phase 3a)

Ported programmatically (not hand-transcribed) from neuroworks/server/src/lib/
department-templates.ts and teams.ts. All of this is read-only reference data,
exactly like persona_catalog.py's BUILTIN_PERSONAS — operator-created
departments/teams/personas live in the database (see database.py's
Department, DepartmentDatum, TeamTemplate, Persona models), not here.
"""

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class DepartmentAgentDef:
    name: str
    role: str
    job_description: str
    tone: Optional[str] = None


@dataclass
class DepartmentTemplateStep:
    persona: str
    task: str


@dataclass
class DepartmentScheduleDef:
    name: str
    template_id: str
    days_of_week: List[int]
    hour: int
    minute: int


@dataclass
class DepartmentTemplateDef:
    id: str
    name: str
    tagline: str
    description: str
    icon: str
    color: str
    agents: List[DepartmentAgentDef]
    recommended_integrations: List[str]
    recommended_templates: List[str]
    workflow: List[DepartmentTemplateStep] = field(default_factory=list)
    schedule: Optional[DepartmentScheduleDef] = None


DEPARTMENT_TEMPLATES: List[DepartmentTemplateDef] = [
    DepartmentTemplateDef(
        id="it-devops", name="IT & DevOps", tagline="Infrastructure monitoring, GitHub automation, deployment workflows",
        description="A complete IT department: monitor repos, triage issues, run deployments, and keep the engineering team aligned. Includes a daily digest of all project activity.", icon="Terminal", color="violet",
        agents=[
            DepartmentAgentDef(name="DevOps Engineer", role="Engineering", job_description="Monitor GitHub repos for new issues, PRs, and commits. Triage incoming issues by priority. Run deployment workflows and flag failures. Summarize weekly engineering velocity.", tone="technical, precise, actionable"),
        ],
        recommended_integrations=["slack","github"],
        recommended_templates=["summarize-repo","run-digest","publish-folder"],
        workflow=[
            DepartmentTemplateStep(persona="DevOps Engineer", task="Scan all repos for new activity and summarize"),
            DepartmentTemplateStep(persona="DevOps Engineer", task="Triage open issues by severity and label"),
            DepartmentTemplateStep(persona="DevOps Engineer", task="Deploy pending changes and report status"),
        ],
        schedule=DepartmentScheduleDef(name="Daily engineering digest", template_id="run-digest", days_of_week=[1,2,3,4,5], hour=8, minute=0),
    ),
    DepartmentTemplateDef(
        id="marketing", name="Marketing & Comms", tagline="Content creation, social media monitoring, brand compliance",
        description="Marketing team that drafts content, monitors brand mentions, enforces brand voice guidelines, and produces weekly performance reports.", icon="Megaphone", color="coral",
        agents=[
            DepartmentAgentDef(name="Content Strategist", role="Knowledge", job_description="Draft blog posts, social media content, and newsletters. Research industry trends and competitors. Ensure all content follows brand voice guidelines. Produce weekly content performance reports.", tone="engaging, professional, on-brand"),
        ],
        recommended_integrations=["slack","google","webhook"],
        recommended_templates=["search-brain","add-note","daily-briefing"],
        workflow=[
            DepartmentTemplateStep(persona="Content Strategist", task="Research trending topics in the industry"),
            DepartmentTemplateStep(persona="Content Strategist", task="Draft content aligned with brand voice"),
            DepartmentTemplateStep(persona="Content Strategist", task="Review for brand compliance and publish"),
        ],
        schedule=DepartmentScheduleDef(name="Weekly content report", template_id="daily-briefing", days_of_week=[5], hour=16, minute=0),
    ),
    DepartmentTemplateDef(
        id="sales", name="Sales & CRM", tagline="Lead qualification, pipeline tracking, follow-up automation",
        description="Sales team that qualifies leads, updates CRM records, drafts follow-up emails, and generates weekly pipeline reports. Integrates with HubSpot and Google.", icon="TrendingUp", color="green",
        agents=[
            DepartmentAgentDef(name="Sales Analyst", role="Operations", job_description="Qualify incoming leads from CRM. Update deal stages and contact records. Draft personalized follow-up emails. Generate weekly pipeline reports with win/loss analysis.", tone="professional, persuasive, concise"),
        ],
        recommended_integrations=["hubspot","google","slack"],
        recommended_templates=["daily-briefing","search-brain"],
        workflow=[
            DepartmentTemplateStep(persona="Sales Analyst", task="Review new leads and qualify by priority"),
            DepartmentTemplateStep(persona="Sales Analyst", task="Update deal stages in CRM"),
            DepartmentTemplateStep(persona="Sales Analyst", task="Draft follow-up sequence for warm leads"),
        ],
        schedule=DepartmentScheduleDef(name="Weekly pipeline report", template_id="daily-briefing", days_of_week=[1], hour=9, minute=0),
    ),
    DepartmentTemplateDef(
        id="hr", name="HR & People Ops", tagline="Employee onboarding, policy management, HR compliance",
        description="HR team that manages employee records, drafts policies, handles onboarding documentation, and ensures HR compliance with labor regulations.", icon="Users", color="blue",
        agents=[
            DepartmentAgentDef(name="HR Coordinator", role="Operations", job_description="Manage employee records and onboarding documentation. Draft and update HR policies. Track leave balances and compliance training. Generate headcount reports.", tone="empathetic, professional, clear"),
        ],
        recommended_integrations=["google","slack"],
        recommended_templates=["add-note","search-brain","daily-briefing"],
        workflow=[
            DepartmentTemplateStep(persona="HR Coordinator", task="Process new employee onboarding documents"),
            DepartmentTemplateStep(persona="HR Coordinator", task="Review and update HR policies for compliance"),
            DepartmentTemplateStep(persona="HR Coordinator", task="Generate monthly headcount and leave report"),
        ],
    ),
    DepartmentTemplateDef(
        id="finance", name="Finance & Accounting", tagline="Expense tracking, financial reporting, budget monitoring",
        description="Finance team that tracks expenses, monitors budgets, generates financial reports, and flags anomalies. Connects to company data sources for live financial querying.", icon="CreditCard", color="amber",
        agents=[
            DepartmentAgentDef(name="Financial Analyst", role="Operations", job_description="Monitor expenses against budgets. Generate weekly financial summaries. Flag unusual transactions. Prepare month-end reports. Query financial data sources for live numbers.", tone="precise, detail-oriented, conservative"),
        ],
        recommended_integrations=["google","webhook"],
        recommended_templates=["daily-briefing","search-brain"],
        workflow=[
            DepartmentTemplateStep(persona="Financial Analyst", task="Review expenses and flag anomalies"),
            DepartmentTemplateStep(persona="Financial Analyst", task="Update budget vs actuals report"),
            DepartmentTemplateStep(persona="Financial Analyst", task="Prepare weekly financial summary"),
        ],
        schedule=DepartmentScheduleDef(name="Weekly finance summary", template_id="daily-briefing", days_of_week=[1], hour=7, minute=30),
    ),
    DepartmentTemplateDef(
        id="legal", name="Legal & Compliance", tagline="Contract review, compliance monitoring, policy drafting",
        description="Legal team that reviews contracts, monitors regulatory compliance, drafts policies, and manages risk assessments. Integrates with governance guardrails.", icon="Scale", color="purple",
        agents=[
            DepartmentAgentDef(name="Legal Counsel", role="Insights", job_description="Review contracts and agreements for compliance risks. Monitor regulatory changes relevant to the business. Draft policies and standard clauses. Conduct compliance assessments of new initiatives.", tone="precise, authoritative, risk-aware"),
        ],
        recommended_integrations=["google","webhook"],
        recommended_templates=["search-brain","add-note","daily-briefing"],
        workflow=[
            DepartmentTemplateStep(persona="Legal Counsel", task="Review documents for compliance risks"),
            DepartmentTemplateStep(persona="Legal Counsel", task="Research regulatory requirements for new initiative"),
            DepartmentTemplateStep(persona="Legal Counsel", task="Draft compliance assessment report"),
        ],
    ),
    DepartmentTemplateDef(
        id="customer-support", name="Customer Service", tagline="Ticket triage, response drafting, satisfaction tracking",
        description="Support team that triages incoming tickets, drafts responses, tracks resolution SLAs, and monitors customer satisfaction trends. Both agents can be pinned to Shona or Ndebele independently (Personas page) for a local-language support desk.", icon="Headphones", color="teal",
        agents=[
            DepartmentAgentDef(name="Ticket Responder", role="Operations", job_description="Triage incoming support tickets by urgency and category. Draft customer-facing responses that resolve the underlying issue, not just the surface complaint. Match the customer's tone — acknowledge frustration before troubleshooting.", tone="helpful, patient, solution-focused"),
            DepartmentAgentDef(name="Support Summariser", role="Operations", job_description="Track resolution times against SLAs. Summarize weekly support trends, recurring issues, and escalation patterns into a digest for the team lead.", tone="concise, pattern-focused, actionable"),
        ],
        recommended_integrations=["slack","google"],
        recommended_templates=["daily-briefing"],
        workflow=[
            DepartmentTemplateStep(persona="Ticket Responder", task="Triage new tickets and prioritize"),
            DepartmentTemplateStep(persona="Ticket Responder", task="Draft responses for pending tickets"),
            DepartmentTemplateStep(persona="Support Summariser", task="Generate weekly support metrics report"),
        ],
    ),
    DepartmentTemplateDef(
        id="communications", name="Communications", tagline="Press releases, announcements, media & inbound response",
        description="Communications team that drafts press releases and announcements, monitors and responds to media/public inquiries, and keeps messaging consistent under normal operations and during a crisis.", icon="Megaphone", color="coral",
        agents=[
            DepartmentAgentDef(name="Comms Writer", role="Knowledge", job_description="Draft press releases, announcements, and public statements. Keep messaging consistent with brand voice and, where relevant, crisis-communications guidelines. Prepare statements ahead of known sensitive dates or events.", tone="clear, on-message, calm under pressure"),
            DepartmentAgentDef(name="Comms Responder", role="Knowledge", job_description="Monitor and respond to media and public inquiries. Route sensitive or high-risk questions for human review rather than answering them directly. Log inbound requests and their outcomes.", tone="measured, accurate, non-committal on anything unconfirmed"),
        ],
        recommended_integrations=["slack","google","webhook"],
        recommended_templates=["daily-briefing"],
        workflow=[
            DepartmentTemplateStep(persona="Comms Writer", task="Draft a release or statement for a pending announcement"),
            DepartmentTemplateStep(persona="Comms Responder", task="Triage and respond to inbound media/public inquiries"),
            DepartmentTemplateStep(persona="Comms Writer", task="Review outgoing statements for consistency before publishing"),
        ],
    ),
    DepartmentTemplateDef(
        id="grant-writing", name="Grant Writing", tagline="Donor proposals, program reports, funder-ready summaries",
        description="Grant writing team for NGOs and development-sector organizations: drafts funding proposals, writes quarterly donor reports, and summarizes program/M&E data into funder-ready narrative. Pairs naturally with the NGO & Civil Society sector.", icon="HandHeart", color="green",
        agents=[
            DepartmentAgentDef(name="Grant Writer", role="Knowledge", job_description="Draft funding proposals and letters of inquiry against a donor's stated priorities and format requirements. Translate program activities into the outcomes language funders expect.", tone="persuasive, evidence-led, funder-aware"),
            DepartmentAgentDef(name="Donor Report Writer", role="Knowledge", job_description="Write quarterly and end-of-grant narrative reports pairing program activities with verifiable indicators. Flag any indicator that's off-track early rather than at report deadline.", tone="precise, indicator-anchored, honest about gaps"),
            DepartmentAgentDef(name="Program Summariser", role="Knowledge", job_description="Summarize beneficiary tracking and M&E data into short digests the Grant Writer and Donor Report Writer can draw on, so every proposal and report is grounded in current program numbers.", tone="concise, numbers-first, current"),
        ],
        recommended_integrations=["slack","google"],
        recommended_templates=["daily-briefing","research-deep"],
        workflow=[
            DepartmentTemplateStep(persona="Program Summariser", task="Digest current program/M&E data"),
            DepartmentTemplateStep(persona="Grant Writer", task="Draft a funding proposal against a donor's priorities"),
            DepartmentTemplateStep(persona="Donor Report Writer", task="Write the quarterly donor narrative report"),
        ],
    ),
    DepartmentTemplateDef(
        id="operations", name="Operations & Admin", tagline="Process automation, reporting, vendor management",
        description="Operations team that automates recurring processes, manages vendor relationships, generates operational reports, and keeps the business running smoothly.", icon="Settings", color="slate",
        agents=[
            DepartmentAgentDef(name="Operations Manager", role="Operations", job_description="Automate recurring operational processes. Track vendor contracts and renewals. Generate daily operations status reports. Monitor key operational metrics and flag deviations.", tone="efficient, systematic, proactive"),
        ],
        recommended_integrations=["slack","google","webhook"],
        recommended_templates=["daily-briefing","run-digest","search-brain"],
        workflow=[
            DepartmentTemplateStep(persona="Operations Manager", task="Review overnight alerts and system status"),
            DepartmentTemplateStep(persona="Operations Manager", task="Check vendor deliverables against SLAs"),
            DepartmentTemplateStep(persona="Operations Manager", task="Publish daily operations status report"),
        ],
        schedule=DepartmentScheduleDef(name="Daily ops briefing", template_id="daily-briefing", days_of_week=[1,2,3,4,5], hour=7, minute=0),
    ),
]


@dataclass
class TeamMemberDef:
    persona_id: str
    role: str


@dataclass
class PreorgTeamDef:
    id: str
    name: str
    description: str
    members: List[TeamMemberDef]


BUILTIN_TEAMS: List[PreorgTeamDef] = [
    PreorgTeamDef(id="product-squad", name="Product squad", description="Feature scoping, builds, and releases.", members=[
        TeamMemberDef(persona_id="product-manager", role="Product Manager"),
        TeamMemberDef(persona_id="software-engineer", role="Software Engineer"),
        TeamMemberDef(persona_id="qa-engineer", role="QA Engineer"),
        TeamMemberDef(persona_id="product-designer", role="Product Designer"),
        TeamMemberDef(persona_id="devops-sre", role="DevOps / SRE"),
    ]),
    PreorgTeamDef(id="launch-marketing", name="Launch & marketing", description="Launches, campaigns, and announcements.", members=[
        TeamMemberDef(persona_id="marketing-manager", role="Marketing Manager"),
        TeamMemberDef(persona_id="aiia-marketing-specialist", role="Aiia Marketing Specialist"),
        TeamMemberDef(persona_id="product-manager", role="Product Manager"),
        TeamMemberDef(persona_id="product-designer", role="Product Designer"),
    ]),
    PreorgTeamDef(id="insurance-desk", name="Insurance desk", description="Quotes, underwriting, and policy/contract review.", members=[
        TeamMemberDef(persona_id="insurance-sales-agent", role="Insurance Sales Agent"),
        TeamMemberDef(persona_id="insurance-underwriter", role="Insurance Underwriter"),
        TeamMemberDef(persona_id="contracts-reviewer", role="Contracts Reviewer"),
        TeamMemberDef(persona_id="financial-analyst", role="Financial Analyst"),
    ]),
    PreorgTeamDef(id="research-gtm", name="Research & GTM", description="Research pods and go-to-market / deal work.", members=[
        TeamMemberDef(persona_id="researcher", role="Investigative analyst"),
        TeamMemberDef(persona_id="data-analyst", role="Data Analyst"),
        TeamMemberDef(persona_id="head-of-ai", role="Head of AI"),
        TeamMemberDef(persona_id="account-executive", role="Account Executive"),
        TeamMemberDef(persona_id="customer-success", role="Customer Success Lead"),
    ]),
]


@dataclass
class TeamTemplateTaskDef:
    persona: str
    content: str


@dataclass
class TeamTemplateDef:
    id: str
    name: str
    tasks: List[TeamTemplateTaskDef]
    description: Optional[str] = None
    team_id: Optional[str] = None
    is_builtin: bool = True


# Seeded team-brief templates. NOTE: a few of these (launch-marketing /
# research-gtm teams) reference persona ids that aren't in persona_catalog.py's
# BUILTIN_PERSONAS (e.g. "aiia-marketing-specialist", "head-of-ai") — this is
# faithfully ported from the neuroworks source, where the same dangling
# references exist (those personas are apparently deployment-specific hires
# in the live instance this was extracted from, not part of the built-in
# catalog). Flagged here rather than silently dropped or invented.
BUILTIN_TEAM_TEMPLATES: List[TeamTemplateDef] = [
    TeamTemplateDef(id="tpl-launch-pack", name="Launch announcement pack", description="Coordinated launch assets across marketing, social, positioning, and visuals.", team_id="launch-marketing", tasks=[
        TeamTemplateTaskDef(persona="marketing-manager", content="Draft a B2B launch announcement (3-4 crisp bullets, no hype) for: {{objective}}"),
        TeamTemplateTaskDef(persona="aiia-marketing-specialist", content="Write 3 short social posts (LinkedIn tone) announcing: {{objective}}"),
        TeamTemplateTaskDef(persona="product-manager", content="Write a one-paragraph positioning statement and the top 3 customer benefits for: {{objective}}"),
        TeamTemplateTaskDef(persona="product-designer", content="Describe a simple visual/hero concept (layout + key message) for the launch of: {{objective}}"),
    ]),
    TeamTemplateDef(id="tpl-feature-kickoff", name="Feature kickoff", description="Problem statement, technical approach, test plan, rollout, and UX for a new feature.", team_id="product-squad", tasks=[
        TeamTemplateTaskDef(persona="product-manager", content="Write a crisp problem statement and 3 measurable success metrics for: {{objective}}"),
        TeamTemplateTaskDef(persona="software-engineer", content="Sketch a technical approach (key components, data flow, 3 edge cases) for: {{objective}}"),
        TeamTemplateTaskDef(persona="qa-engineer", content="Write 6 test cases (Gherkin style, incl. 2 edge cases) for: {{objective}}"),
        TeamTemplateTaskDef(persona="devops-sre", content="Outline a rollout + rollback runbook (5 ordered steps) for shipping: {{objective}}"),
        TeamTemplateTaskDef(persona="product-designer", content="Outline the core UX flow (key screens + states) for: {{objective}}"),
    ]),
    TeamTemplateDef(id="tpl-policy-review", name="New policy review", description="Underwriting risk, sales angle, contract clauses, and pricing for a policy.", team_id="insurance-desk", tasks=[
        TeamTemplateTaskDef(persona="insurance-underwriter", content="Assess the key underwriting risks and required information for: {{objective}}"),
        TeamTemplateTaskDef(persona="insurance-sales-agent", content="Draft a concise customer-facing pitch and 3 FAQs for: {{objective}}"),
        TeamTemplateTaskDef(persona="contracts-reviewer", content="List the 5 clauses to check first and what a red flag looks like in each, for: {{objective}}"),
        TeamTemplateTaskDef(persona="financial-analyst", content="Outline a simple pricing/margin model and the key assumptions for: {{objective}}"),
    ]),
    TeamTemplateDef(id="tpl-market-scan", name="Market scan", description="Landscape, metrics, AI implications, opportunities, and retention angle.", team_id="research-gtm", tasks=[
        TeamTemplateTaskDef(persona="researcher", content="Summarize the current landscape and 3 key players for: {{objective}} (cite sources)"),
        TeamTemplateTaskDef(persona="data-analyst", content="Propose the 3 metrics you'd track and how you'd measure them for: {{objective}}"),
        TeamTemplateTaskDef(persona="head-of-ai", content="Assess the AI implications and 2 build-vs-buy considerations for: {{objective}}"),
        TeamTemplateTaskDef(persona="account-executive", content="Identify the top 3 sales opportunities and the ideal customer profile for: {{objective}}"),
        TeamTemplateTaskDef(persona="customer-success", content="Note the main retention/adoption risks and one mitigation each for: {{objective}}"),
    ]),
]
