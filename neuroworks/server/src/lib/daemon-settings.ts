// Operator kill switches for org-daemon.ts's individually-named background
// loops. Same JSON-file settings pattern as host-tools.ts's Settings > System
// Access toggles, but these are convenience switches, not a security
// boundary, so isLoopEnabled() fails OPEN on a read error (a corrupt/missing
// settings file should never silently stop the whole daemon).
//
// Deliberately no import from org-daemon.ts (and org-daemon.ts is the only
// place that ever needs the real loop-name list) — keeps this file leaf-only
// and avoids any import-cycle risk. disabledLoops accepts any string; an
// unrecognized or since-renamed entry just sits there harmlessly.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.neuroworks");
const SETTINGS_FILE = join(STATE_DIR, "daemon-settings.json");

export type DaemonSettings = {
  disabledLoops: string[];
};

// maybeExtractZettels (auto-zettel creation) starts disabled — auto-writing
// permanent vault notes is impactful enough to be opt-in, unlike every other
// loop here which is read-only or notify-only and safe to default on.
const DEFAULT_SETTINGS: DaemonSettings = {
  disabledLoops: ["maybeExtractZettels"],
};

let cache: DaemonSettings | null = null;

function load(): DaemonSettings {
  if (cache) return cache;
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(SETTINGS_FILE)) {
    cache = { ...DEFAULT_SETTINGS };
    persist();
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    cache = { ...DEFAULT_SETTINGS, ...parsed };
  } catch (e) {
    console.warn(`[daemon-settings] failed to read ${SETTINGS_FILE}: ${(e as Error).message}. Using defaults.`);
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache!;
}

function persist(): void {
  if (!cache) return;
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2)); }
  catch (e) { console.warn(`[daemon-settings] persist failed: ${(e as Error).message}`); }
}

export function getDaemonSettings(): DaemonSettings {
  return { ...load() };
}

export function updateDaemonSettings(patch: Partial<DaemonSettings>): DaemonSettings {
  const s = load();
  Object.assign(s, patch);
  persist();
  return { ...s };
}

// Fails OPEN — see file header.
export function isLoopEnabled(name: string): boolean {
  try { return !load().disabledLoops.includes(name); }
  catch { return true; }
}
