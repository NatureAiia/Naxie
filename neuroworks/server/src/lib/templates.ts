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
  agent: "clawbot";
};

export const templates: Template[] = [
  {
    id: "summarize-repo",
    role: "Engineering",
    title: "Summarize a project",
    description: "Generate a concise project summary (purpose, stack, state, recent direction) and save it to your knowledge base.",
    icon: "sparkles",
    agent: "clawbot",
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
    agent: "clawbot",
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
    agent: "clawbot",
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
    agent: "clawbot",
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
    agent: "clawbot",
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
    agent: "clawbot",
    inputs: [],
    requiresApproval: false,
    estimateSeconds: 1,
  },
  {
    id: "general-task",
    role: "Insights",
    title: "Anything else (ad-hoc task)",
    description: "Describe a task in plain English. Clawbot plans steps using its primitive tools (vault search/read/write, GitHub fetch, local LLM) and executes them. Successful runs auto-save as reusable templates.",
    icon: "spark",
    agent: "clawbot",
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
    description: "R&D sweep for the org: ways to improve NeuroWorks — new agent-AI techniques, AI innovations, useful APIs, and GitHub repos worth adopting. Produces a sourced report; the next daily briefing attaches the latest scan automatically. Pair with a Schedule for a daily cadence.",
    icon: "spark",
    agent: "clawbot",
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
    agent: "clawbot",
    inputs: [
      { name: "focus", label: "Focus area (optional)", type: "text", placeholder: "leave blank for a general briefing" },
    ],
    requiresApproval: false,
    estimateSeconds: 60,
  },
  {
    id: "buffer-story-post",
    role: "Operations",
    title: "Draft a social post from email stories",
    description: "Scans a source mailbox for recent stories, picks the strongest fresh one, drafts a platform-native post, and sends it to the Telegram group and email FOR REVIEW before anything is published. Stages it on Buffer as a DRAFT (turn on Auto-queue to let Buffer publish automatically). Reads the learned posting strategy so drafts improve over time. Runs 3×/day when scheduled — dedupes against the last 3 days so it never repeats a story.",
    icon: "broadcast",
    agent: "clawbot",
    inputs: [
      { name: "sender", label: "Source email address", type: "text", default: "", placeholder: "who the stories come from" },
      { name: "days", label: "Look back (days)", type: "number", default: 3 },
      { name: "channels", label: "Channels (blank = all)", type: "text", placeholder: "e.g. twitter,linkedin — blank for all connected" },
      { name: "slot", label: "Slot label (morning/midday/evening)", type: "text", placeholder: "optional — for 3×/day variety" },
      { name: "reviewTelegram", label: "Send to Telegram group for review", type: "boolean", default: true },
      { name: "reviewEmail", label: "Email for review", type: "text", default: "" },
      { name: "autoQueue", label: "Auto-queue on Buffer (else save as draft)", type: "boolean", default: false },
    ],
    requiresApproval: false,
    estimateSeconds: 180,
  },
  {
    id: "social-optimize",
    role: "Operations",
    title: "Optimise social strategy (self-improving)",
    description: "Reviews what's been posted on Buffer (and engagement, when the Buffer insights scope is granted) and rewrites the posting-strategy note that the drafting agent follows — a self-improving loop. Pair with a weekly Schedule.",
    icon: "spark",
    agent: "clawbot",
    inputs: [
      { name: "days", label: "Review window (days)", type: "number", default: 30 },
    ],
    requiresApproval: false,
    estimateSeconds: 90,
  },
  {
    id: "sync-downloads",
    role: "Knowledge",
    title: "Sync downloads to vault",
    description: "Mirror new files from your Downloads folder into the vault. Source files are never moved or deleted — clawbot only copies.",
    icon: "download",
    agent: "clawbot",
    inputs: [
      { name: "source", label: "Source folder", type: "text", placeholder: "leave blank for ~/Downloads/" },
    ],
    requiresApproval: false,
    estimateSeconds: 60,
  },
];

export const roles = [
  { id: "Engineering", label: "Engineering", description: "Code, projects, GitHub", count: templates.filter(t => t.role === "Engineering").length },
  { id: "Knowledge", label: "Knowledge", description: "Notes, search, capture", count: templates.filter(t => t.role === "Knowledge").length },
  { id: "Operations", label: "Operations", description: "Schedules, integrations", count: templates.filter(t => t.role === "Operations").length },
  { id: "Insights", label: "Insights", description: "Research, analysis", count: templates.filter(t => t.role === "Insights").length },
  { id: "Custom", label: "Custom", description: "Saved from past ad-hoc runs", count: 0 },
];
