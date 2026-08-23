// MAG — Memory-Augmented Generation
// Durable long-term memory that makes Naxie and every subagent remember
// who they are, who Nature (the operator) is, and what each subagent does.
// Storage: vault files + memory.ts JSONL (local-first, survives git sync).
// Supabase mirroring is future — interface already abstracts it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { BUILTIN_NAXIE_PERSONA, loadPersonas, type Persona } from "./personas.js";
import { recallSubject, searchMemory, noteFact, listSubjects, datedFactsInWindow } from "./memory.js";
import { getOnboardingState } from "./sector-packs.js";
import { readPersonaProfileSuffix } from "./persona-profile.js";

const IDENTITY_DIR = "_neuroworks/identity";

function ensureDir(rel: string) {
  const abs = join(config.vaultPath, rel);
  try { mkdirSync(abs, { recursive: true }); } catch { /* tolerate */ }
}

function vaultRead(rel: string): string | null {
  try { return readFileSync(join(config.vaultPath, rel), "utf8"); } catch { return null; }
}
function vaultWrite(rel: string, content: string) {
  ensureDir(rel.split("/").slice(0, -1).join("/"));
  writeFileSync(join(config.vaultPath, rel), content, "utf8");
}

// ── Operator identity ──
// Source of truth: first superadmin in users.json + onboarding state.
// Persisted as vault identity file so RAG can retrieve it and git backs it up.
export type OperatorIdentity = {
  name: string;
  email: string;
  title?: string;
  sector?: string;
  orgName?: string;
  language: string;
  summary: string;
};

export function getOperatorIdentity(): OperatorIdentity {
  let name = "Nature";
  let email = "";
  let title: string | undefined;
  let sector: string | undefined;
  let orgName: string | undefined;
  let language = "en";

  try {
    const onboarding = getOnboardingState();
    sector = onboarding.sector;
    orgName = onboarding.orgName;
    language = onboarding.language || "en";
  } catch { /* ignore */ }

  // users.json is the canonical operator record (oldest superadmin)
  try {
    const { loadPersonas: _unused } = { loadPersonas: () => {} } as any;
    // direct read without importing users.ts circularly — parse file
    const raw = readFileSync(join(config.vaultPath, "..", "..", ".neuroworks", "users.json"), "utf8");
    // Fallback: try server's .neuroworks path
  } catch { /* ignore — try alternate */ }
  try {
    const usersRaw = (() => {
      for (const p of [
        join(config.vaultPath, "../../.neuroworks/users.json"),
        join(process.cwd(), ".neuroworks/users.json"),
        join(config.vaultPath, "..", ".neuroworks/users.json"),
      ]) {
        try { if (existsSync(p)) return readFileSync(p, "utf8"); } catch { /* ignore */ }
      }
      return null;
    })();
    if (usersRaw) {
      const users = JSON.parse(usersRaw) as any[];
      const superadmins = users.filter(u => u.role === "superadmin").sort((a,b)=> String(a.createdAt).localeCompare(String(b.createdAt)));
      const op = superadmins[0] ?? users[0];
      if (op) {
        name = op.name || name;
        email = op.email || email;
        title = op.title || title;
      }
    }
  } catch { /* ignore */ }

  // vault override file — if operator wrote their own identity note, prefer it
  const vaultOp = vaultRead(`${IDENTITY_DIR}/operator.md`);
  if (vaultOp) {
    const mName = vaultOp.match(/^name:\s*(.+)$/m);
    const mEmail = vaultOp.match(/^email:\s*(.+)$/m);
    if (mName) name = mName[1].trim();
    if (mEmail) email = mEmail[1].trim();
  }

  const summary = `${name}${email ? ` <${email}>` : ""}${title ? ` — ${title}` : ""}${orgName ? ` @ ${orgName}` : ""}${sector ? ` [${sector}]` : ""}`.trim();
  return { name, email, title, sector, orgName, language, summary };
}

export function ensureOperatorIdentityFile(): string {
  const rel = `${IDENTITY_DIR}/operator.md`;
  if (vaultRead(rel)) return rel;
  const op = getOperatorIdentity();
  const content = `---
type: identity
role: operator
name: ${op.name}
email: ${op.email || "unknown"}
sector: ${op.sector || "unknown"}
org: ${op.orgName || "unknown"}
language: ${op.language}
updated: ${new Date().toISOString()}
---

# Operator — ${op.name}

This is the human Naxie serves. Naxie must never forget this person.

- **Name:** ${op.name}
- **Email:** ${op.email || "(not set — set via Admin > Users)"}
- **Title:** ${op.title || "(not set)"}
- **Org:** ${op.orgName || "(not set)"}
- **Sector:** ${op.sector || "(not set)"}
- **Language:** ${op.language}

## How Naxie should treat the operator
- Always address by name (${op.name}) when greeting or confirming.
- Remember preferences stored as \`memory.note subject="operator"\`.
- Never ask "who are you?" again — this file is the source of truth.
`;
  vaultWrite(rel, content);
  return rel;
}

// ── Naxie core identity ──
export function getNaxieIdentity(): { persona: Persona; profileSuffix: string; memoryFacts: string[] } {
  const persona = BUILTIN_NAXIE_PERSONA;
  const profileSuffix = readPersonaProfileSuffix("naxie");
  const facts = recallSubject("naxie", 12).map(f => f.fact);
  const operatorFacts = recallSubject("operator", 8).map(f => `operator: ${f.fact}`);
  return { persona, profileSuffix, memoryFacts: [...facts, ...operatorFacts] };
}

export function ensureNaxieIdentityFile(): string {
  const rel = `${IDENTITY_DIR}/naxie.md`;
  if (vaultRead(rel)) return rel;
  const content = `---
type: identity
role: naxie
name: Naxie
updated: ${new Date().toISOString()}
---

# Naxie — Personal Assistant to Nature

${BUILTIN_NAXIE_PERSONA.systemPromptOverride}

## Core duties (never forget)
- You are Nature's PA — triage first, delegate to specialists, report back as Naxie.
- You own calendar + inbox triage, protect deep-work, close loops.
- You remember the operator (see operator.md) and every subagent in subagents.md.
- You adapt tone by question intent and time of day, but always reply AS Naxie.
`;
  vaultWrite(rel, content);
  return rel;
}

// ── Subagent roster ──
export type SubagentSummary = { id: string; name: string; role: string; description: string };

export function getSubagentRoster(): SubagentSummary[] {
  try {
    const { personas } = loadPersonas();
    return personas.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      description: p.description,
    }));
  } catch {
    return [];
  }
}

export function ensureSubagentRosterFile(): string {
  const rel = `${IDENTITY_DIR}/subagents.md`;
  const roster = getSubagentRoster();
  const body = roster.map(r => `- **${r.name}** (\`${r.id}\`) — ${r.role}: ${r.description}`).join("\n") || "- (no personas yet)";
  const content = `---
type: identity
role: subagent-roster
updated: ${new Date().toISOString()}
count: ${roster.length}
---

# Subagents — who Naxie can delegate to

Naxie and every subagent share this roster. Chat is for talking to a specific agent; Naxie is the PA master.

${body}

## Routing note
- \`Chat\` surface = talk directly to a specific persona/worker
- \`Naxie\` (/naxie, widget) = PA master that triages and delegates
`;
  // Always rewrite so new hires appear without manual edit
  vaultWrite(rel, content);
  return rel;
}

// ── MAG context builder ──
// Compiles the durable memory block injected into every Naxie (and subagent) prompt.
export function buildMagContext(opts: { maxFacts?: number; includeDated?: boolean } = {}): string {
  const maxFacts = opts.maxFacts ?? 14;
  const op = getOperatorIdentity();
  const naxie = getNaxieIdentity();
  const roster = getSubagentRoster();

  // Recent memory facts across all subjects, blended by recency
  const subjects = listSubjects().slice(0, 8);
  const recentFacts: string[] = [];
  for (const s of subjects) {
    if (recentFacts.length >= maxFacts) break;
    const facts = recallSubject(s.subject, 3);
    for (const f of facts) {
      if (recentFacts.length >= maxFacts) break;
      // avoid dumping huge facts
      recentFacts.push(`[${s.subject}] ${f.fact.slice(0, 240)}`);
    }
  }

  // Dated facts for today window (today ±1 day) — calendar-linked memory
  let datedBlock = "";
  if (opts.includeDated !== false) {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const dated = datedFactsInWindow(yesterday, tomorrow, 8);
    if (dated.length) {
      datedBlock = `\n**Upcoming dated memory:**\n${dated.map(d => `- ${d.date}: [${d.subject}] ${d.fact}`).join("\n")}\n`;
    }
  }

  // Also pull any searchMemory hits for operator/naxie as fallback if recallSubject was sparse
  if (recentFacts.length < 4) {
    const extra = searchMemory(op.name, 4).map(f => `[${f.subject}] ${f.fact.slice(0, 200)}`);
    for (const e of extra) if (!recentFacts.includes(e)) recentFacts.push(e);
  }

  const rosterLines = roster.slice(0, 18).map(r => `- ${r.name} (${r.role}) — ${r.id}`).join("\n");

  return `## MAG — durable memory (do not forget)

**Operator you serve:** ${op.summary}
**Language:** ${op.language} · **Sector:** ${op.sector || "unknown"} · **Org:** ${op.orgName || "unknown"}

**Who you are:** Naxie — ${naxie.persona.role}. ${naxie.persona.description}
${naxie.memoryFacts.length ? `**What you've learned about this org:**\n${naxie.memoryFacts.slice(0, 6).map(f => `- ${f}`).join("\n")}` : ""}

**Subagent roster (${roster.length}):**
${rosterLines || "- (no subagents yet — you are the only worker)"}
${datedBlock}
${recentFacts.length ? `**Recent memory (recency-blended, top ${recentFacts.length}):**\n${recentFacts.map(f => `- ${f}`).join("\n")}` : "**Recent memory:** (none yet — use memory.note to remember facts)"}
`.trim();
}

// Convenience: remember a fact about the operator (so Naxie never forgets who you are)
export function rememberOperatorFact(fact: string, source = "mag") {
  return noteFact({ subject: "operator", fact, source });
}
export function rememberNaxieFact(fact: string, source = "mag") {
  return noteFact({ subject: "naxie", fact, source });
}

// Ensure all three identity files exist (called at boot)
export function ensureMagIdentityFiles(): { operator: string; naxie: string; subagents: string } {
  return {
    operator: ensureOperatorIdentityFile(),
    naxie: ensureNaxieIdentityFile(),
    subagents: ensureSubagentRosterFile(),
  };
}
