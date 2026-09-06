export const AGENT_VIEWS_ID = "@naxion/agent-views";

export type AgentKind = "claude" | "codex" | "opencode" | "hermes";

export interface AgentDefinition {
  id: string;
  kind: AgentKind;
  label: string;
  description: string;
  color: string;
  iconClass: string;
  apiEndpoint: string;
}

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: "claude-code",
    kind: "claude",
    label: "Claude Code",
    description: "Anthropic's coding assistant with deep reasoning",
    color: "#d4a574",
    iconClass: "naxion-icon-claude",
    apiEndpoint: "/api/agents/claude",
  },
  {
    id: "codex",
    kind: "codex",
    label: "Codex",
    description: "OpenAI's code generation engine",
    color: "#10b981",
    iconClass: "naxion-icon-codex",
    apiEndpoint: "/api/agents/codex",
  },
  {
    id: "opencode",
    kind: "opencode",
    label: "OpenCode",
    description: "Open-source AI coding companion",
    color: "#8b5cf6",
    iconClass: "naxion-icon-opencode",
    apiEndpoint: "/api/agents/opencode",
  },
  {
    id: "hermes",
    kind: "hermes",
    label: "Hermes",
    description: "NeuroWealth's autonomous workflow agent",
    color: "#f59e0b",
    iconClass: "naxion-icon-hermes",
    apiEndpoint: "/api/agents/hermes",
  },
];
