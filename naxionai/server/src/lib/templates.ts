export type TemplateInput = {
  name: string;
  label: string;
  type: "text" | "number" | "boolean" | "repo-picker" | "textarea";
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
};

export type Template = {
  id: string;
  role: "Engineering" | "Knowledge" | "Operations" | "Insights";
  title: string;
  description: string;
  icon: string;
  inputs: TemplateInput[];
  requiresApproval: boolean;
  estimateSeconds: number;
  agent: "naxie-agent";
  // Kept runnable via the generic /run/:id pipeline (so Schedules can fire it
  // on a cadence) but excluded from the general Templates gallery and chat NL
  // routing — for a template whose result needs a dedicated page's UI (stage
  // tabs, rankings, etc.) rather than the generic Tasks/Reports view.
  hidden?: boolean;
};

export const templates: Template[] = [
  {
    id: "summarize-repo",
    role: "Engineering",
    title: "Summarize a project",
    description: "Generate a concise project summary (purpose, stack, state, recent direction) and save it to your knowledge base.",
    icon: "sparkles",
    agent: "naxie-agent",
    inputs: [{ name: "repo", label: "Project", type: "repo-picker", required: true }],
    requiresApproval: false,
    estimateSeconds: 30,
  },
  {
    id: "run-digest",
    role: "Engineering",
    title: "Run daily digest",
    description: "Scan every project for recent activity (commits, PRs, issues) and write a digest to your knowledge base.",
    icon: "broadcast",
    agent: "naxie-agent",
    inputs: [{ name: "lookbackDays", label: "Days back", type: "number", default: 7 }],
    requiresApproval: false,
    estimateSeconds: 60,
  },
  {
    id: "publish-folder",
    role: "Engineering",
    title: "Publish a local folder",
    description: "Take a folder on this machine, create a private GitHub repo, and push it.",
    icon: "upload",
    agent: "naxie-agent",
    inputs: [
      { name: "path", label: "Folder path", type: "text", required: true, placeholder: "D:\\path\\to\\folder" },
      { name: "name", label: "Repo name", type: "text", placeholder: "auto from folder if blank" },
      { name: "public", label: "Public", type: "boolean", default: false },
    ],
    requiresApproval: true,
    estimateSeconds: 30,
  },
  {
    id: "search-brain",
    role: "Knowledge",
    title: "Search the knowledge base",
    description: "Find notes, digests, and summaries across your second brain.",
    icon: "search",
    agent: "naxie-agent",
    inputs: [{ name: "query", label: "What to search for", type: "text", required: true, placeholder: "scraper hub status" }],
    requiresApproval: false,
    estimateSeconds: 1,
  },
  {
    id: "add-note",
    role: "Knowledge",
    title: "Capture a fleeting note",
    description: "Drop a quick thought into your inbox to process later.",
    icon: "pencil",
    agent: "naxie-agent",
    inputs: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "body", label: "Note body", type: "textarea", required: true },
    ],
    requiresApproval: false,
    estimateSeconds: 2,
  },
  {
    id: "browse-vault",
    role: "Knowledge",
    title: "Browse my knowledge base",
    description: "Open the file tree of your Obsidian vault.",
    icon: "folder",
    agent: "naxie-agent",
    inputs: [],
    requiresApproval: false,
    estimateSeconds: 1,
  },
  {
    id: "general-task",
    role: "Insights",
    title: "Anything else (ad-hoc task)",
    description: "Describe a task in plain English. Naxie plans steps using its primitive tools (vault search/read/write, GitHub fetch, local LLM) and executes them. Successful runs auto-save as reusable templates.",
    icon: "spark",
    agent: "naxie-agent",
    inputs: [
      { name: "task", label: "Task description", type: "textarea", required: true, placeholder: "e.g. Find every note that mentions Cognify and write a one-page roll-up to 0-Inbox/cognify-rollup.md" },
      { name: "save_as_template", label: "Save successful plan as a template", type: "boolean", default: true },
    ],
    requiresApproval: true,
    estimateSeconds: 30,
  },
  {
    id: "innovation-scan",
    role: "Insights",
    title: "Innovation scan",
    description: "R&D sweep for the org: ways to improve Naxie — new agent-AI techniques, AI innovations, useful APIs, and GitHub repos worth adopting. Produces a sourced report; the next daily briefing attaches the latest scan automatically. Pair with a Schedule for a daily cadence.",
    icon: "spark",
    agent: "naxie-agent",
    inputs: [
      { name: "focus", label: "Focus area (optional)", type: "text", placeholder: "e.g. voice agents, RAG, orchestration — blank for a broad sweep" },
    ],
    requiresApproval: false,
    estimateSeconds: 240,
  },
  {
    id: "daily-briefing",
    role: "Operations",
    title: "Daily briefing",
    description: "A short morning briefing — pulls recent vault activity, open follow-ups, and anything flagged, then writes a prioritised 'what to focus on today' digest. Pair with a Schedule (and optional email delivery) to get it every morning.",
    icon: "broadcast",
    agent: "naxie-agent",
    inputs: [
      { name: "focus", label: "Focus area (optional)", type: "text", placeholder: "leave blank for a general briefing" },
    ],
    requiresApproval: false,
    estimateSeconds: 60,
  },
  {
    id: "email-to-vault",
    role: "Knowledge",
    title: "File mail to the vault",
    description: "Reads recent inbox mail, classifies each message (who/what they want/urgency/needs a reply), and writes a searchable note per message worth attention — newsletters and automated mail are skipped. Pair with a Schedule to run it hourly.",
    icon: "broadcast",
    agent: "naxie-agent",
    inputs: [
      { name: "limit", label: "Messages to scan", type: "number", default: 20, placeholder: "20" },
    ],
    requiresApproval: false,
    estimateSeconds: 60,
  },
  {
    id: "africa-ai-news",
    role: "Operations",
    title: "Africa AI news — BREAKING",
    description: "Picks the single most newsworthy Africa/AI story (web search + innovation leads), then posts a BREAKING NEWS card to Telegram: title, summary, Why it matters for Africa, Read more link, hashtags, video, and source. Pair with a daily Schedule.",
    icon: "broadcast",
    agent: "naxie-agent",
    inputs: [
      { name: "chatId", label: "Telegram group chat ID to post into", type: "text", required: true, placeholder: "-1004307136262" },
      { name: "videoUrl", label: "HeyGen video URL (optional)", type: "text", placeholder: "https://files2.heygen.ai/... .mp4" },
    ],
    requiresApproval: false,
    estimateSeconds: 90,
  },
  {
    id: "world-ai-news",
    role: "Operations",
    title: "World AI news — BREAKING",
    description: "Picks the single most newsworthy global AI/world story (web search), then posts a BREAKING NEWS card to Telegram: title, summary, Why it matters, Read more, hashtags, video, and source. Pair with a daily Schedule.",
    icon: "broadcast",
    agent: "naxie-agent",
    inputs: [
      { name: "chatId", label: "Telegram group chat ID to post into", type: "text", required: true, placeholder: "-1001234567890" },
      { name: "videoUrl", label: "HeyGen video URL (optional)", type: "text", placeholder: "https://files2.heygen.ai/... .mp4" },
    ],
    requiresApproval: false,
    estimateSeconds: 90,
  },
  {
    id: "brand-signal-scan",
    role: "Operations",
    title: "Scan for brand signals",
    description: "Searches the web for a brand's own-mention watch terms, gates candidates (on watch list, real source, has a finding), and files anything that passes as a draft signal for human review — plus Telegram/email alerts on anything critical or a first-of-its-kind. Pair with a daily/weekly Schedule per brand. Set the brand's watch list first on the Brands page.",
    icon: "broadcast",
    agent: "naxie-agent",
    inputs: [
      { name: "brandId", label: "Brand", type: "text", required: true, default: "work", placeholder: "personal | work | business (see the Brands page)" },
    ],
    requiresApproval: false,
    estimateSeconds: 60,
  },
  {
    id: "sync-downloads",
    role: "Knowledge",
    title: "Sync downloads to vault",
    description: "Mirror new files from your Downloads folder into the vault. Source files are never moved or deleted — Naxie only copies.",
    icon: "download",
    agent: "naxie-agent",
    inputs: [
      { name: "source", label: "Source folder", type: "text", placeholder: "leave blank for ~/Downloads/" },
    ],
    requiresApproval: false,
    estimateSeconds: 60,
  },
  {
    id: "board-meeting",
    role: "Insights",
    title: "Board Meeting",
    description: "Convene the AI council on a topic: independent opinions, anonymous peer review, then Naxie's chaired synthesis.",
    icon: "users",
    agent: "naxie-agent",
    inputs: [
      { name: "topic", label: "Topic", type: "textarea", required: true },
      { name: "personaIds", label: "Council members (comma-separated persona ids; blank = default)", type: "text" },
    ],
    requiresApproval: false,
    estimateSeconds: 90,
    hidden: true,
  },
];

export const roles = [
  { id: "Engineering", label: "Engineering", description: "Code, projects, GitHub", count: templates.filter(t => t.role === "Engineering" && !t.hidden).length },
  { id: "Knowledge", label: "Knowledge", description: "Notes, search, capture", count: templates.filter(t => t.role === "Knowledge" && !t.hidden).length },
  { id: "Operations", label: "Operations", description: "Schedules, integrations", count: templates.filter(t => t.role === "Operations" && !t.hidden).length },
  { id: "Insights", label: "Insights", description: "Research, analysis", count: templates.filter(t => t.role === "Insights" && !t.hidden).length },
  { id: "Custom", label: "Custom", description: "Saved from past ad-hoc runs", count: 0 },
];
