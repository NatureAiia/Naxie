// "Tool DNA" — an opt-in, viewable, resettable usage-preference memory.
// Ported from KimmyDeku/sebastian's tripDNA: pure frequency counters (which
// templates/skills/personas the operator's work actually touches), gated
// entirely at ONE write site (a true opt-out, not just a UI toggle over data
// still being collected), injected into the system prompt, and independently
// viewable + resettable.
//
// Fills a confirmed gap: lib/persona-profile.ts learns a profile from
// reflections, but nothing about it is operator-viewable or resettable, and
// NaxieMemory.tsx has no delete/forget control at all for any learned data.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.neuroworks");
let FILE = join(STATE_DIR, "tool-dna.json");
let SETTINGS_FILE = join(STATE_DIR, "tool-dna-settings.json");

// Test seam — points both stores at a scratch dir so tests never touch the
// real .neuroworks/ state, matching lib/rag-telemetry.ts's own convention.
export function _setStateFilesForTests(dir: string): void {
  FILE = join(dir, "tool-dna.json");
  SETTINGS_FILE = join(dir, "tool-dna-settings.json");
  cache = null;
  settingsCache = null;
}

export type ToolDna = {
  templates: Record<string, number>;
  skills: Record<string, number>;
  personas: Record<string, number>;
};

const EMPTY: ToolDna = { templates: {}, skills: {}, personas: {} };

let cache: ToolDna | null = null;

function load(): ToolDna {
  if (cache) return cache;
  if (!existsSync(FILE)) { cache = { ...EMPTY, templates: {}, skills: {}, personas: {} }; return cache; }
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8"));
    cache = {
      templates: parsed.templates && typeof parsed.templates === "object" ? parsed.templates : {},
      skills: parsed.skills && typeof parsed.skills === "object" ? parsed.skills : {},
      personas: parsed.personas && typeof parsed.personas === "object" ? parsed.personas : {},
    };
  } catch { cache = { templates: {}, skills: {}, personas: {} }; }
  return cache;
}

function persist(): void {
  if (!cache) return;
  try {
    if (!existsSync(dirname(FILE))) mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (e: any) { console.warn(`[tool-dna] persist failed: ${e?.message ?? e}`); }
}

// ─── the single opt-in gate ────────────────────────────────────────────────
// Sebastian's discipline exactly: checked at the one write site below, not
// scattered through callers — so turning this off is a true stop, never a
// "still collecting, just hidden" toggle.

type Settings = { personalizationEnabled: boolean };
const DEFAULT_SETTINGS: Settings = { personalizationEnabled: true };
let settingsCache: Settings | null = null;

function loadSettings(): Settings {
  if (settingsCache) return settingsCache;
  if (!existsSync(SETTINGS_FILE)) { settingsCache = { ...DEFAULT_SETTINGS }; return settingsCache; }
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    settingsCache = { personalizationEnabled: parsed.personalizationEnabled !== false };
  } catch { settingsCache = { ...DEFAULT_SETTINGS }; }
  return settingsCache;
}

export function getToolDnaSettings(): Settings {
  return { ...loadSettings() };
}

export function setPersonalizationEnabled(enabled: boolean): Settings {
  settingsCache = { personalizationEnabled: enabled };
  try {
    if (!existsSync(dirname(SETTINGS_FILE))) mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2));
  } catch (e: any) { console.warn(`[tool-dna] settings persist failed: ${e?.message ?? e}`); }
  return { ...settingsCache };
}

// ─── the single write site ─────────────────────────────────────────────────
// Called once per finished job (lib/jobs.ts's runJob finally-block, right
// alongside the existing audit-log/org-task bookkeeping). Best-effort and
// silent — usage telemetry must never fail a job.
export function recordUsage(input: { template?: string; skill?: string; personaId?: string }): void {
  if (!loadSettings().personalizationEnabled) return;
  try {
    const dna = load();
    if (input.template) dna.templates[input.template] = (dna.templates[input.template] ?? 0) + 1;
    if (input.skill) dna.skills[input.skill] = (dna.skills[input.skill] ?? 0) + 1;
    if (input.personaId) dna.personas[input.personaId] = (dna.personas[input.personaId] ?? 0) + 1;
    persist();
  } catch { /* telemetry must never break the caller */ }
}

export function getToolDna(): ToolDna {
  const d = load();
  return { templates: { ...d.templates }, skills: { ...d.skills }, personas: { ...d.personas } };
}

export function resetToolDna(): void {
  cache = { templates: {}, skills: {}, personas: {} };
  persist();
}

function top(counts: Record<string, number>, n: number): { name: string; count: number }[] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

// Small JSON block for the system prompt — same shape Sebastian's travel
// route injects `dna` as. Returns "" when there's nothing learned yet (or
// personalization is off), so callers can unconditionally splice this in.
export function toolDnaPromptBlock(): string {
  if (!loadSettings().personalizationEnabled) return "";
  const dna = load();
  const templates = top(dna.templates, 5);
  const skills = top(dna.skills, 5);
  if (templates.length === 0 && skills.length === 0) return "";
  return `\n\nNaxie has noticed you use most: ${JSON.stringify({ templates, skills })}\n`;
}
