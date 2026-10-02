// Curated MCP server catalog — feeds "suggested servers" for the MCP
// Servers management page (see routes/mcp-servers.ts, web/src/pages/McpServers.tsx).
//
// Hand-verified against github.com/modelcontextprotocol/servers: every entry
// below is a "reference" (maintained by the MCP org) or an actively
// maintained third-party server linked from that list — nothing archived,
// deprecated, or removed from the upstream list is included. Each entry's
// `command`/`args` is the exact invocation upstream documents, so an entry
// can be projected directly into the same shape addMcpServer() accepts
// (McpServerInput: { label, description?, command, args?, env? }).
//
// This is a suggestion list only — adding a server is still an explicit
// operator action via the Add modal. Keep this list short and trustworthy
// rather than exhaustive; re-verify against upstream before adding entries.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type McpCatalogEnvVar = {
  name: string;
  description: string;
  required: boolean;
};

export type McpCatalogEntry = {
  /** Optional tags to help UI grouping or search */
  tags?: string[];
  id: string;
  label: string;
  description: string;
  command: string;
  args: string[];
  env?: McpCatalogEnvVar[];
  homepage: string;
  source: "reference" | "community";
};

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "filesystem",
    label: "Filesystem",
    description: "Read/write access to a directory tree you specify — the path is the only argument, no API key needed.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allow"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    source: "reference",
  },
  {
    id: "fetch",
    label: "Fetch",
    description: "Fetches a URL and converts its content to markdown for the agent to read.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    source: "reference",
  },
  {
    id: "memory",
    label: "Memory (knowledge graph)",
    description: "A simple persistent knowledge-graph store the agent can read/write across sessions.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    source: "reference",
  },
  {
    id: "sequential-thinking",
    label: "Sequential Thinking",
    description: "Structured step-by-step reasoning tool for breaking a problem into an explicit chain of thoughts.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    source: "reference",
  },
  {
    id: "github",
    label: "GitHub",
    tags: ["github","repo"],
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: [{ name: "GITHUB_PERSONAL_ACCESS_TOKEN", description: "A GitHub PAT with the scopes you want the agent to use", required: true }],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    source: "reference",
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    description: "Read-only inspection and querying of a Postgres database (schema browsing, SELECT queries).",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://host:port/db"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    source: "reference",
  },
  {
    id: "puppeteer",
    label: "Puppeteer (browser automation)",
    description: "Headless-browser navigation, screenshots, and page interaction.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    source: "reference",
  },
  {
    id: "browser-use",
    label: "browser-use (AI browser agent)",
    description: "Real-browser control via Playwright with LLM-oriented DOM extraction — navigate, click, type, scroll, screenshot, extract content, plus an autonomous fallback action. Requires Python 3.11+ and uv/uvx on PATH (astral.sh/uv).",
    command: "uvx",
    args: ["--from", "browser-use[cli]", "browser-use", "--mcp"],
    homepage: "https://github.com/browser-use/browser-use",
    source: "community",
  },
  {
    id: "brave-search",
    label: "Brave Search",
    description: "Web and local search via the Brave Search API.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: [{ name: "BRAVE_API_KEY", description: "Brave Search API key", required: true }],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    source: "reference",
  },
  {
    id: "slack",
    label: "Slack",
    description: "Read channels and post messages to a Slack workspace via a bot token.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: [
      { name: "SLACK_BOT_TOKEN", description: "Bot token for the Slack app (xoxb-...)", required: true },
      { name: "SLACK_TEAM_ID", description: "Workspace/team ID", required: true },
    ],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    source: "reference",
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    description: "Web search, single-page scrape-to-markdown, multi-page crawl/map, and structured extraction — stronger than the built-in web.search/web.fetch tools for sites that need JS rendering or bulk crawling.",
    command: "npx",
    args: ["-y", "firecrawl-mcp"],
    env: [{ name: "FIRECRAWL_API_KEY", description: "API key from firecrawl.dev — sign in or create a free account, then copy a key from the dashboard", required: true }],
    homepage: "https://github.com/firecrawl/firecrawl-mcp-server",
    source: "community",
  },
  {
    id: "strix-pentest",
    label: "Strix Pentest (this NeuroWorks instance)",
    // Our own thin proxy (server/mcp/pentest-mcp-server.mjs — same shape as
    // neuroworks-dispatch-mcp.mjs) over the local /api/pentest REST surface,
    // NOT a third-party server. Adding it here lets the agent call scans via
    // the generic mcp.call primitive too, on top of the dedicated
    // pentest.scan/check_run/list_runs primitives already registered in
    // primitives.ts. The same file is also meant for EXTERNAL MCP hosts
    // (Claude Desktop, etc.) to register directly — see the file's own header.
    description: "Trigger and read Strix-backed security scans (real exploit attempts, not static analysis) — proxies this NeuroWorks instance's own /api/pentest routes, no separate credentials needed.",
    command: "node",
    args: [resolve(dirname(fileURLToPath(import.meta.url)), "../../mcp/pentest-mcp-server.mjs")],
    homepage: "https://github.com/usestrix/strix",
    source: "community",
  },
    {
      id: "openclaw",
      label: "OpenClaw",
      description: "Open source AI assistant – will be launched as an MCP stdio server via npm.",
    tags: ["http","fetch"],
    command: "npx",
      args: ["-y", "openclaw@latest", "mcp", "serve"],
    env: [{ name: "OPENCLAW_API_KEY", description: "API key for the LLM provider used by OpenClaw", required: true }],
    homepage: "https://github.com/openclaw/openclaw",
    source: "community",
    tags: ["assistant","cli"]
  },
];

export function listMcpCatalog(): McpCatalogEntry[] {
  return MCP_CATALOG;
}

export function getMcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find(e => e.id === id);
}
