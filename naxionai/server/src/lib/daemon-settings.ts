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

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.naxion");
const SETTINGS_FILE = join(STATE_DIR, "daemon-settings.json");

export type DaemonSettings = {
  disabledLoops: string[];
};

// maybeExtractZettels (auto-zettel creation) starts disabled — auto-writing
// permanent vault notes is impactful enough to be opt-in, unlike every other
// loop here which is read-only or notify-only and safe to default on.
// maybeNudgeChatInactivity (the "just checking in" nudge) also starts
// disabled — content-free check-ins on every idle window are spam, not
// assistance. Opt back in from Schedules > Background loops.
const DEFAULT_SETTINGS: DaemonSettings = {
  disabledLoops: ["maybeExtractZettels", "maybeNudgeChatInactivity"],
};

let cache: DaemonSettings | null = null;
let cacheMtimeMs = 0;

function load(): DaemonSettings {
  // Cross-process freshness: the Schedules-page toggles (or a helper script)
  // may write daemon-settings.json from another process while the daemon
  // runs elsewhere. Re-read when mtime moves, so a kill switch takes effect
  // on the next tick without a restart — same pattern as schedules.ts.
  if (cache) {
    const cached = cache;
    try {
      const m = statSync(SETTINGS_FILE).mtimeMs;
      if (m === cacheMtimeMs) return cached;
      cache = null; // changed under us — fall through to re-read
    } catch { return cached; }
  }
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
  try { cacheMtimeMs = statSync(SETTINGS_FILE).mtimeMs; } catch { cacheMtimeMs = 0; }
  return cache!;
}

function persist(): void {
  if (!cache) return;
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2));
    try { cacheMtimeMs = statSync(SETTINGS_FILE).mtimeMs; } catch { /* next load() re-reads — harmless */ }
  }
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
