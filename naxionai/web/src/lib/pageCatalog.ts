/** Canonical labels and paths for the app's primary navigation pages. */
export const PAGE_CATALOG = {
  naxie: { label: "Naxie", path: "/naxie", keywords: "home overview voice assistant" },
  office: { label: "Office", path: "/office", keywords: "agents personas roles workforce roster" },
  inbox: { label: "My Inbox", path: "/my-work", keywords: "approvals handoffs assignments review" },
  council: { label: "Council", path: "/council", keywords: "board meeting orchestrate debate" },
  schedules: { label: "Schedules", path: "/schedules", keywords: "recurring automations cadence" },
  dailyReports: { label: "Daily Reports", path: "/daily-reports", keywords: "digest rollup" },
  command: { label: "Command Center", path: "/command", keywords: "organization dashboard" },
  brands: { label: "Brands", path: "/brands", keywords: "brand voice marketing" },
  planner: { label: "Planner", path: "/planner", keywords: "personal tasks reminders calendar" },
  myFinances: { label: "My Finances", path: "/my-finances", keywords: "personal budget income expenses" },
  businessFinance: { label: "Business Finance", path: "/business-finance", keywords: "Varity Vault business cashflow price book runway" },
  memory: { label: "Naxie Memory", path: "/naxie/memory", keywords: "teach personalization learned memory" },
  library: { label: "Library", path: "/library", keywords: "vault notes search files knowledge" },
  templates: { label: "Templates", path: "/templates", keywords: "presets" },
  skills: { label: "Skills", path: "/skills", keywords: "skill forge" },
  extensions: { label: "Extensions", path: "/extensions", keywords: "integrations plugins" },
  connectors: { label: "Connectors", path: "/connectors", keywords: "accounts api email calendar" },
  mcp: { label: "MCP Servers", path: "/mcp-servers", keywords: "model context protocol tools" },
  hermes: { label: "Hermes", path: "/hermes", keywords: "research executor bridge" },
  github: { label: "GitHub Accounts", path: "/github-accounts", keywords: "repositories authorization" },
  automation: { label: "Automation", path: "/automation", keywords: "webhooks triggers events" },
  ide: { label: "Naxion IDE", path: "/ide", keywords: "shell console code editor" },
  models: { label: "Models", path: "/models", keywords: "AI providers deployments" },
  cost: { label: "Cost", path: "/cost", keywords: "usage spend tokens" },
  policies: { label: "Policies", path: "/policies", keywords: "governance guardrails compliance" },
  security: { label: "Security Scan", path: "/pentest", keywords: "security test pentest" },
  whatsapp: { label: "WhatsApp", path: "/whatsapp", keywords: "messaging channel" },
} as const;

export type PageId = keyof typeof PAGE_CATALOG;
export function pageInfo(id: PageId) {
  return PAGE_CATALOG[id];
}
