// CAG — Cache-Augmented Generation
// Small vault → the persona + core-memory prefix is cacheable, not re-derived
// per turn. We build one stable string that rarely changes (identity + roster +
// static knowledge), hash it, and reuse via prompt-cache (OpenRouter/Anthropic).
// Rebuilds only on vault writes or persona/memory changes (mtime-gated).

import { createHash } from "node:crypto";
import { statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { buildMagContext } from "./mag.js";
import { getOnboardingState, getSectorContext } from "./sector-packs.js";
import { readPersonaProfileSuffix } from "./persona-profile.js";

let cached: { hash: string; prefix: string; builtAt: number } | null = null;
let lastMtimes: Map<string, number> = new Map();

// Files whose mtime changes should bust the CAG cache
const WATCHED = [
  "_naxion/identity/operator.md",
  "_naxion/identity/naxie.md",
  "_naxion/identity/subagents.md",
  "_naxion/personas/naxie.md",
];

function mtimesSnapshot(): Map<string, number> {
  const m = new Map<string, number>();
  // The cached MAG portion includes recently written JSONL facts. Track those
  // files too, otherwise memory.note can leave the stable prefix stale forever.
  const memoryDir = join(config.vaultPath, "_naxion/memory");
  try {
    for (const name of readdirSync(memoryDir).filter(f => f.endsWith(".jsonl")).sort()) {
      try { m.set(`memory:${name}`, statSync(join(memoryDir, name)).mtimeMs); } catch { /* concurrent delete */ }
    }
  } catch { /* no memory directory yet */ }
  // A runtime vault switch must never reuse another vault's prefix.
  m.set(`vaultPath:${config.vaultPath}`, 1);
  for (const rel of WATCHED) {
    try {
      const st = statSync(join(config.vaultPath, rel));
      m.set(rel, st.mtimeMs);
    } catch {
      m.set(rel, 0);
    }
  }
  // Also track onboarding state freshness via file mtime
  try {
    const onboardingPath = join(config.vaultPath, "../../.naxion/onboarding.json");
    if (existsSync(onboardingPath)) m.set(onboardingPath, statSync(onboardingPath).mtimeMs);
  } catch { /* ignore */ }
  return m;
}

function mtimesEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function hashOf(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

export function buildCagPrefix(): { prefix: string; hash: string; cached: boolean } {
  const cur = mtimesSnapshot();
  if (cached && mtimesEqual(cur, lastMtimes)) {
    return { prefix: cached.prefix, hash: cached.hash, cached: true };
  }

  // Dated facts belong in live MAG, not a long-lived prompt-cache prefix.
  const mag = buildMagContext({ maxFacts: 10, includeDated: false });

  let sectorCtx = "";
  try {
    const onboarding = getOnboardingState();
    if (onboarding.sector) sectorCtx = getSectorContext(onboarding.sector);
  } catch { /* ignore */ }

  const naxieProfile = readPersonaProfileSuffix("naxie");

  const prefix = [
    "## CAG — cached core (stable identity + roster, do not re-derive)",
    mag,
    sectorCtx ? `**Sector context:** ${sectorCtx}` : "",
    naxieProfile ? naxieProfile.trim() : "",
  ].filter(Boolean).join("\n\n").trim();

  const h = hashOf(prefix);
  cached = { hash: h, prefix, builtAt: Date.now() };
  lastMtimes = cur;
  return { prefix, hash: h, cached: false };
}

export function invalidateCagCache() {
  cached = null;
  lastMtimes = new Map();
}

export function cagStats(): { built: boolean; hash?: string; ageMs: number } {
  if (!cached) return { built: false, ageMs: -1 };
  return { built: true, hash: cached.hash, ageMs: Date.now() - cached.builtAt };
}
