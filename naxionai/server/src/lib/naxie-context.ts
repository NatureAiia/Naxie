// Naxie context orchestrator — RAG + MAG + CAG composed into one injection
// Every Naxie turn (and every subagent delegated from Naxie) calls this.

import { buildCagPrefix } from "./cag.js";
import { ragSearch, formatRagBlock } from "./rag.js";
import { buildMagContext, ensureMagIdentityFiles } from "./mag.js";
import { readRecentMissionNotes, mostRecentScopeId, dailyScopeId } from "./mission-log.js";
import { crmContextSummary } from "./crm.js";
import { toolDnaPromptBlock } from "./tool-dna.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

let ensured = false;
function ensureOnce() {
  if (ensured) return;
  try { ensureMagIdentityFiles(); ensured = true; } catch { /* best-effort */ }
}

export type NaxieContext = {
  cag: string;           // stable cached prefix (CAG)
  cagHash: string;
  cagCached: boolean;
  mag: string;           // durable memory block (MAG) — subset of CAG plus fresh facts
  rag: string;           // per-query retrieval block (RAG)
  missionLog: string;    // rolling working-notes for the active (or most recent) task
  crm: string;           // compact contacts/pipeline snapshot — "" when the CRM is empty
  mdAudit: string;        // managing-director system audit snapshot — health + dormant + useless glance
  combinedSystemAddendum: string; // what to append to the base system prompt
  // The vault path of the top-scored vault-sourced RAG hit, if any — the note
  // that most likely answered this query, for the client to highlight in
  // KnowledgeGraph (same "answer highlights its source" pattern as
  // jarvis-claude-code's top_match()/setFocus(), except riding on the RAG
  // scoring Naxie already does rather than a separate keyword pass).
  sourceNoteId: string | null;
};

export async function buildNaxieContext(query: string, opts: { ragLimit?: number; includeDated?: boolean; scopeId?: string; sessionId?: string } = {}): Promise<NaxieContext> {
  ensureOnce();
  const cag = buildCagPrefix();
  // MAG as standalone (fresh) — CAG already contains a mag snapshot but we add a
  // slightly fresher mag slice for recency; dedupe is fine, LLM handles it.
  const mag = buildMagContext({ maxFacts: 8, includeDated: opts.includeDated });

  // Kick ragSearch early so vault walks + pgvector embed run concurrently with
  // the synchronous mission-log / CRM / audit file reads below.
  const hitsPromise = ragSearch(query, opts.ragLimit ?? 6, { sessionId: opts.sessionId });
  // Gather sync context slices while ragSearch is in flight
  const syncSlices = (() => {
    let missionLog = "";
    try {
      const scope = opts.scopeId ?? mostRecentScopeId() ?? dailyScopeId();
      const notes = readRecentMissionNotes(scope);
      if (notes) missionLog = `[Recent working notes for this task]\n${notes}`;
    } catch { /* best-effort */ }
    let crm = "";
    try {
      const summary = crmContextSummary();
      if (summary) crm = `[CRM snapshot]\n${summary}`;
    } catch { /* best-effort */ }
    return { missionLog, crm };
  })();

  const hits = await hitsPromise;
  const rag = formatRagBlock(hits);
  // hits is already sorted score-desc (rag.ts) — first vault/vault-semantic
  // hit is the note the answer most likely drew from.
  const sourceNoteId = hits.find(h => h.source === "vault" || h.source === "vault-semantic")?.path ?? null;
  const { missionLog, crm } = syncSlices;

  // MD system audit snapshot — Naxie as managing director of every inch.
  // Best-effort: read the latest _neuroworks/system-audits/*.md frontmatter +
  // first 800 chars of the Executive Summary so Naxie can answer "what's
  // dormant / useless / needs improving" without a separate tool call.
  let mdAudit = "";
  try {
    const dir = join(config.vaultPath, "_neuroworks/system-audits");
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort().reverse();
      if (files.length > 0) {
        const latest = files[0];
        const abs = join(dir, latest);
        const mtime = statSync(abs).mtimeMs;
        // Only inject if audit is from last 7 days — older audits are stale
        if (Date.now() - mtime < 7 * 24 * 3600_000) {
          const body = readFileSync(abs, "utf8");
          const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
          let fmLine = "";
          if (fmMatch) {
            const fm: Record<string, string> = {};
            for (const line of fmMatch[1].split("\n")) {
              const colon = line.indexOf(":");
              if (colon > 0) fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
            }
            fmLine = `MD Audit ${fm.date ?? latest.replace(/\.md$/, "")} — health ${fm.healthScore ?? "?"}//100 — ${fm.dormantCount ?? "?"} dormant, ${fm.uselessCount ?? "?"} useless, ${fm.improvementsCount ?? "?"} improvements`;
          } else {
            fmLine = `MD Audit ${latest.replace(/\.md$/, "")}`;
          }
          const stripped = body.replace(/^---[\s\S]*?---\n+/, "");
          // Pull Executive Summary + System Map + first MD Directive for context
          const execMatch = stripped.match(/##\s+🏢 Executive Summary[\s\S]{0,800}/i)
            ?? stripped.match(/##\s+Executive Summary[\s\S]{0,800}/i);
          const execSnippet = execMatch ? execMatch[0].slice(0, 800) : stripped.slice(0, 800);
          mdAudit = `[MD System Audit — Naxie as Managing Director]\n${fmLine}\n${execSnippet.trim()}\n(Full report: ${latest} — ask Naxie "show full MD audit" or open Daily Reports → MD System Audit)`;
        }
      }
    }
    if (!mdAudit) {
      // Fallback: at least inject live inventory counts so Naxie knows the scale even without an audit file
      const { quickInventoryCounts } = await import("./system-audit.js");
      const inv = quickInventoryCounts();
      mdAudit = `[MD System Audit — no audit file yet (run one at Daily Reports → MD System Audit). Live inventory: ${inv.pages} pages, ${inv.routes} routes, ${inv.lib} lib modules, ${inv.templates} templates, ${inv.personas} personas. You are the Managing Director of every inch — you can trigger a full scan on demand.]`;
    }
  } catch { /* best-effort — never break context */ }

  const mdDirective = `You are Naxie, the Managing Director of the entire NeuroWorks system — accountable for every file, feature, and page. You have just scanned the whole codebase. When asked about system health, what's dormant, what's useless, or what needs improving, answer from the [MD System Audit] context above, as the MD that never sleeps. If no audit file exists yet, offer to run one.`;

  // Tool DNA (opt-in usage-preference memory, lib/tool-dna.ts) — "" when
  // personalization is off or nothing's been learned yet, so this is a
  // no-op splice most of the time.
  let toolDna = "";
  try { toolDna = toolDnaPromptBlock(); } catch { /* best-effort */ }

  const parts = [cag.prefix, rag, missionLog, crm, mdAudit, mdDirective, toolDna].filter(Boolean).join("\n\n");
  // Avoid duplicating mag verbatim if cag already contains it — but keep a
  // short fresh-facts tail if mag has anything cag didn't (new memory since last cag build)
  const magTail = mag.includes("Recent memory") ? "" : mag;

  const combinedSystemAddendum = [parts, magTail].filter(Boolean).join("\n\n");

  return {
    cag: cag.prefix,
    cagHash: cag.hash,
    cagCached: cag.cached,
    mag,
    rag,
    missionLog,
    crm,
    mdAudit,
    combinedSystemAddendum,
    sourceNoteId,
  };
}

// For subagents: same memory, but preface with "You are <persona> — Naxie's delegate"
export function buildSubagentContext(personaId: string, query: string, opts: { sessionId?: string } = {}): Promise<NaxieContext> {
  // Reuse same RAG/MAG/CAG — subagents share the same durable memory so they
  // also never forget who Nature is. Persona-specific profile is layered by
  // personaSystemSuffix() elsewhere; this just adds the shared memory.
  return buildNaxieContext(query, { ragLimit: 6, sessionId: opts.sessionId ?? `subagent:${personaId}` });
}

// Lightweight probe for /api/status
export function naxieMemoryStats(): { cagHash: string; cagCached: boolean; hasRag: boolean } {
  const cag = buildCagPrefix();
  return { cagHash: cag.hash, cagCached: cag.cached, hasRag: true };
}
