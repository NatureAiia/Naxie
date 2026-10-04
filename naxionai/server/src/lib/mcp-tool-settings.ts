import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.naxion");
const SETTINGS_FILE = join(STATE_DIR, "hermes-mcp-tools.json");

export function getHermesToolOverride(): string[] | undefined {
  if (!existsSync(SETTINGS_FILE)) return undefined;
  try {
    const value = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    if (Array.isArray(value?.tools) && value.tools.every((tool: unknown) => typeof tool === "string")) return value.tools;
  } catch { /* malformed preference: fall back to configured defaults */ }
  return undefined;
}

export function setHermesToolOverride(tools: string[]): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify({ tools: [...new Set(tools)], updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

export function hermesToolOverrideSource(): "saved" | "environment" | "default" {
  if (existsSync(SETTINGS_FILE)) return "saved";
  return (process.env.NAXION_MCP_TOOLS ?? "").split(",").some(tool => tool.trim()) ? "environment" : "default";
}
