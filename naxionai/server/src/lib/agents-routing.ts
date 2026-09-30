// agents.md — a user-editable routing table at the vault root, read into
// planning context. This is the declarative counterpart to the many hardcoded
// regex "hint" blocks in agent.ts (company data, GitHub, email, memory, …):
// those cover cases NeuroWorks already knows about; agents.md lets the
// operator add their OWN routing rules (custom folders, custom skills) without
// touching code — same idea as the "second brain" agents.md + routing table
// pattern (task type → folder/skill, token-efficient because the planner
// isn't told to search everything).
//
// Cached like governance.ts's policy prefix (60s TTL, vault-watcher busts it
// sooner in practice since edits are rare).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { getVaultHealth, writeVaultFile, ARCHIVE_DIR, WIKI_DIR } from "./vault.js";

export const AGENTS_MD_PATH = "agents.md";

const DEFAULT_AGENTS_MD = `# Agents routing table

This file tells Naxie which vault folders, databases, or skills to check
FIRST for a given kind of task — before falling back to a broader search or
the public web. Edit the table below to match how YOUR organization actually
stores things. Naxie reads this file at planning time (cached ~60s, so an
edit takes effect within a minute).

| Task type | Check first | Notes |
|---|---|---|
| Finance / revenue / invoices / expenses | \`_company/\`, a connected finance database (\`db.list_sources\`) | Never guess a number — pull it from the source. |
| Sales / CRM / pipeline / deals | a CRM connector, \`_company/\` | |
| Marketing / campaigns / objections / call themes | \`${WIKI_DIR}/\` (compiled) | Raw call transcripts live in \`${ARCHIVE_DIR}/\`; only the nightly compile writes \`${WIKI_DIR}/\`. |
| Operations / SOPs / how-we-do-X / policies | \`2-Permanent/\`, \`${WIKI_DIR}/\` | |
| "What did we learn from recent calls/videos/notes?" | \`${WIKI_DIR}/\` first, \`${ARCHIVE_DIR}/\` for the source material | |

## Folder ownership

- **\`${ARCHIVE_DIR}/\`** — RAW captures: call transcripts, YouTube transcripts,
  voice notes, pasted documents. You and Naxie's capture primitives
  (\`vault.capture_note\`, \`vault.capture_youtube\`) write here.
- **\`${WIKI_DIR}/\`** — COMPILED, distilled knowledge. Written ONLY by the
  nightly wiki-compile job — a direct write here is refused. Add raw
  material to \`${ARCHIVE_DIR}/\` and let the next compile turn it into a wiki
  entry instead.
- **\`0-Inbox/\` / \`2-Permanent/\`** — your personal Zettelkasten (fleeting →
  permanent notes). Unrelated to the Archive/Wiki split above.

## Identity rule

Always search the vault (\`vault.search\`) before answering from general
knowledge. If the vault or a connected database/connector already has the
answer, use it — never answer a business question from training data when
the operator's own systems cover it.
`;

let cache: { value: string; builtAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function invalidateAgentsRoutingCache(): void {
  cache = null;
}

// Create a starter agents.md the first time the vault is reachable and none
// exists yet — mirrors how other conventions (governance, vault folders)
// bootstrap themselves rather than requiring manual setup. Safe to call on
// every boot; no-ops once the file exists (even if the user emptied it).
export function ensureAgentsMdExists(): void {
  try {
    const health = getVaultHealth();
    if (!health.exists) return;
    const full = resolve(config.vaultPath, AGENTS_MD_PATH);
    if (existsSync(full)) return;
    writeVaultFile(AGENTS_MD_PATH, DEFAULT_AGENTS_MD);
    console.log(`[agents-routing] created starter ${AGENTS_MD_PATH} in the vault`);
  } catch (e: any) {
    console.warn(`[agents-routing] could not create ${AGENTS_MD_PATH}: ${e?.message ?? e}`);
  }
}

// Planning-context block. Empty string when agents.md doesn't exist or the
// vault is unreachable — callers can concat unconditionally.
export function loadAgentsRoutingContext(): string {
  if (cache && Date.now() - cache.builtAt < CACHE_TTL_MS) return cache.value;
  let value = "";
  try {
    const full = resolve(config.vaultPath, AGENTS_MD_PATH);
    if (existsSync(full)) {
      const body = readFileSync(full, "utf8").trim();
      if (body) {
        value = `\n\nAGENTS.MD ROUTING TABLE (operator-authored — supplements the hints above; follow it when it names a specific folder/source for this task's topic):\n${body}\n`;
      }
    }
  } catch { /* tolerate — a bad/missing file just means no extra routing context */ }
  cache = { value, builtAt: Date.now() };
  return value;
}
