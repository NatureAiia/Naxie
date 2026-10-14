// Persona → starter template generator. Each persona's responsibilities become
// one-click custom templates so the dashboard immediately reflects what that
// role does day-to-day.
//
// Two paths:
//   • Generic — one template per responsibility, with an EMPTY plan. Running
//     it re-plans against the active persona's system prompt each time, so the
//     LLM stays in role. Good default — handles every persona out of the box.
//   • Curated — for known built-in personas (Researcher, etc.) we override
//     with hand-crafted templates whose plans pre-wire the right primitive
//     (e.g. research.multiperspective) so the user gets one-click access to
//     the persona's signature tool without paying the planner LLM cost.

import type { Persona } from "./personas.js";
import type { CustomTemplate } from "./custom-templates.js";
import { slugify, loadCustomTemplates, saveCustomTemplate, deleteCustomTemplate } from "./custom-templates.js";

// Curated templates per built-in persona id — kept in sync with
// BUILTIN_PERSONAS in personas.ts (naxie-agent, researcher,
// software-engineer, accountant, it-support). When buildStarterTemplates is
// called for one of these ids, we use this table INSTEAD of the generic
// responsibility-derived templates. Entries for pruned personas were removed
// 2026-10-12; custom personas always use the generic path below.
const CURATED: Record<string, (personaId: string) => Omit<CustomTemplate, "id" | "role">[]> = {
  "naxie-agent": () => [
    {
      title: "Daily focus",
      description: "What should I focus on today? Looks at recent jobs in your vault, open threads, and notes flagged for follow-up.",
      origin: { task: "Look at the last 5 days of journal entries in _naxion/jobs/, any pending follow-ups in 0-Inbox/, and surface a short prioritised list of what I should focus on today. Include why each item matters.", createdAt: new Date().toISOString() },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Weekly vault review",
      description: "Goes through the past week of vault changes, identifies what to promote from 0-Inbox/, what to archive, and any cross-references worth making.",
      origin: { task: "Review what landed in the vault this past week. Surface notes worth promoting from 0-Inbox/ to 2-Permanent/, flag stale items, and suggest 2-3 new links between notes I might have missed.", createdAt: new Date().toISOString() },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Find related notes",
      description: "Given a topic, finds related notes in your vault and explains the connection. Use to surface threads you forgot you had.",
      origin: { task: "Find notes related to the following topic across the vault. For each, summarise the connection in one sentence. Return the most relevant 5-10 with paths.", createdAt: new Date().toISOString() },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Capture and connect",
      description: "Captures a new thought as a note and auto-links it to existing related notes in your vault.",
      origin: { task: "Capture the following thought as a new vault note. Then search the vault for related material and add [[wikilinks]] to the 2-3 most relevant existing notes.", createdAt: new Date().toISOString() },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Quick web look-up",
      description: "Fast factual web search with citations. Use for single questions you don't want to clutter the vault with.",
      origin: { task: "Look up the following question on the web. Give a tight 3-5 sentence answer with cited sources. Do not capture to the vault unless the answer is non-obvious.", createdAt: new Date().toISOString() },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
  ],
  // Researcher is defined by its web access. Every template explicitly
  // invokes the web-fanning tools (research.multiperspective / web.search /
  // smartFetch) so the planner picks them and the user always sees real
  // citations from the live internet rather than model-recalled prose.
  researcher: () => [
    {
      title: "Web investigation (multi-perspective)",
      description: "Full multi-perspective web investigation — parallel sub-agents query the web from mainstream, critical, practitioner, and recent angles, then synthesise a cited report.",
      origin: {
        task: "Use research.multiperspective on the following topic with perspectives 'mainstream, critical, practitioner, recent'. Each sub-agent must hit the live web, fetch top sources, and cite [N]. Produce a structured report with Topic statement → Perspectives → Cross-cutting themes → Open questions → Bottom line. Capture to 0-Inbox/.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Latest news scan (web-only)",
      description: "Tight scan of the last 6-12 months on a topic using ONLY the 'recent' framing. Web-first, no synthesis of older context.",
      origin: {
        task: "Use research.multiperspective with perspectives='recent' to scan the live web for developments in the last 6-12 months on the following topic. Prefer news, blogs, releases, official announcements. Cite every claim with [N]. Note what changed compared to earlier consensus and flag what's still unconfirmed.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Compare two on the web",
      description: "Side-by-side web investigation of two approaches/tools/companies/positions. Parallel sub-agents per side, then a comparison synth.",
      origin: {
        task: "Compare the following two things side by side using web sources. For each side, run research.multiperspective (mainstream + critical + recent). Then write a balanced comparison: trade-offs, hidden costs, contexts each is best in. Cite every claim with [N] including which side it supports.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Fact-check a claim",
      description: "Targeted web search for a specific claim. Pulls supporting AND opposing evidence in parallel, then states whether the claim holds, partially holds, or doesn't.",
      origin: {
        task: "Fact-check the following claim against the live web. Run TWO parallel web searches: one for supporting evidence (the claim phrased as fact), one for opposing evidence (the claim negated or with words like 'debunk', 'false', 'no evidence'). Fetch top sources from both. Report: VERDICT (supported / partially supported / contested / unsupported), key evidence with [N] citations on both sides, and the strongest counter-argument you found.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Find primary sources",
      description: "Hunt for the ORIGINAL sources behind a topic — official docs, papers, press releases, primary datasets — rather than secondary commentary.",
      origin: {
        task: "Find primary sources on the following topic using web search. Prioritise: official documentation, academic papers, government / regulatory filings, press releases from the source, raw datasets. Avoid commentary, opinion pieces, and aggregator summaries unless they cite primary work. For each primary source, give the URL and a one-sentence summary of what it actually says (not what others say about it). Capture as a sources-only note in 0-Inbox/.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Topic landscape map",
      description: "Build a map of a topic: key players, terminology, recent developments, open debates. Wide web sweep, structured output.",
      origin: {
        task: "Map the landscape of the following topic from the live web. Output sections: 1) Key players (people, companies, projects), 2) Core terminology with one-line definitions, 3) Recent developments (last 12 months), 4) Open debates / contested points. Use research.multiperspective with perspectives='mainstream, practitioner, recent, academic'. Cite every player and claim with [N].",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Vault + web bridge",
      description: "Reads what your vault already knows about a topic, identifies the gaps, then uses the live web to fill ONLY those gaps. Captures the bridge as a permanent zettel.",
      origin: {
        task: "Bridge the vault and the live web on the following topic. Step 1: search the vault exhaustively, summarise what it already knows. Step 2: identify the specific gaps or open questions. Step 3: run targeted web searches to answer ONLY those gaps. Step 4: write a brief 'Bridge note' citing both vault sources as [vault:path] and web sources as [N]. Save as a 2-Permanent/ zettel.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
  ],

  "software-engineer": () => [
    {
      title: "Investigate + fix a bug",
      description: "Read the relevant code, identify root cause, propose the smallest correct fix with a test plan.",
      origin: {
        task: "Investigate the following bug. Steps: 1) Read the relevant code using vault.search / github.read_repo to find the implicated files. 2) Identify the root cause (cite file paths and line numbers). 3) Propose the smallest correct fix as a diff sketch. 4) Test plan: what to run, what should pass, edge cases to check. 5) Blast radius: what else this might affect.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Code review on a diff/PR",
      description: "Senior-engineer review of a diff or PR — correctness, maintainability, security, performance.",
      origin: {
        task: "Review the following diff/PR. Use github.read_repo if a PR number is given. Output sections (only if you have something to say): Correctness / Maintainability / Security / Performance. For each finding, cite the file + line and propose the change. End with a verdict: APPROVE / APPROVE-WITH-CHANGES / REQUEST-CHANGES.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Architecture trade-off memo",
      description: "Compare two technical approaches for a real decision. Names trade-offs honestly, picks one.",
      origin: {
        task: "Write a trade-off memo for the following technical decision. Output: 1) The decision (one sentence). 2) Options (A and B, each with one-paragraph description). 3) Trade-off matrix (operability, performance, complexity, blast radius, reversibility). 4) Recommendation with the reason that mattered most. 5) What we'd verify before committing.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Repo orientation",
      description: "Read a repo and produce a senior-engineer orientation: what it does, how it's organised, where to start.",
      origin: {
        task: "Produce a senior-engineer orientation to the following repo. Use github.read_repo. Output: 1) Purpose (one sentence). 2) Stack (languages, frameworks, key libraries). 3) Architecture overview (entry points, main modules, data flow). 4) Where the interesting complexity lives. 5) First three files a new engineer should read, in order. Cite file paths.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
  ],

  "accountant": () => [
    {
      title: "Invoice / statement",
      description: "A professional invoice or account statement, tied out.",
      origin: {
        task: "Draft a professional invoice or account statement from the details provided: line items, quantities, rates, subtotals, tax, terms, and a total that ties out to the cent.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Reconciliation",
      description: "Match two sets of records and explain every discrepancy.",
      origin: {
        task: "Reconcile the two sets of records provided (e.g. bank vs ledger). List matched items, then every discrepancy with its amount and likely cause, and state the closing difference. Don't paper over anything that doesn't tie.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Financial statement summary",
      description: "A P&L / cash-position summary from real figures.",
      origin: {
        task: "Prepare a P&L or cash-position summary from the figures provided. Lead with the headline number, then the make-up by line, then anything unusual. Tie out to the cent and state assumptions about the chart of accounts.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
  ],
  "it-support": () => [
    {
      title: "Fix-it runbook",
      description: "A step-by-step guide for a non-technical user.",
      origin: {
        task: "Write a step-by-step fix-it guide for the IT issue described, for a non-technical user: numbered steps, the expected result after each, and what to do if a step fails. Start with the safe, reversible fix.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Access provisioning plan",
      description: "Least-privilege access for a request, with revoke steps.",
      origin: {
        task: "Draft an access-provisioning plan for the request described, least-privilege: what to grant, to whom, for how long, the approval needed, and exactly how to revoke it later.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
    {
      title: "Device setup checklist",
      description: "A secure device/software setup checklist.",
      origin: {
        task: "Create a secure device and software setup checklist for the scenario described, with secure defaults (disk encryption, MFA, updates, least-privilege accounts) and a verification step for each.",
        createdAt: new Date().toISOString(),
      },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    },
  ],

};

// The id namespace for persona-derived templates: `custom-<personaId>-...`.
// We use this to find and remove templates that belong to a persona.
function templateIdPrefix(personaId: string): string {
  return `custom-${personaId}-`;
}

// Curated-coverage probe (used by templates-integrity.test.ts): every key
// here must match a live BUILTIN_PERSONAS id, or the entry is dead code.
export function listCuratedPersonaIds(): string[] {
  return Object.keys(CURATED);
}

// Generate the full template set for a persona — curated where available,
// generic otherwise. Returns the list without persisting; the caller decides
// when to save.
export function buildStarterTemplates(persona: Persona): CustomTemplate[] {
  const curatedBuilder = CURATED[persona.id];
  if (curatedBuilder) {
    const partials = curatedBuilder(persona.id);
    return partials.map(p => ({
      ...p,
      id: `${templateIdPrefix(persona.id)}${slugify(p.title).slice(0, 40)}`,
      role: "Custom",
    }));
  }
  // Generic path — one template per responsibility, plus a free-form
  // "general task" that's always available. Every persona ends up with at
  // least one template even when responsibility extraction returned nothing.
  const out: CustomTemplate[] = [];
  for (const resp of persona.responsibilities.slice(0, 5)) {
    const task = `As a ${persona.role}, ${resp.toLowerCase().replace(/\.$/, "")}.`;
    out.push({
      id: `${templateIdPrefix(persona.id)}${slugify(resp).slice(0, 40)}`,
      role: "Custom",
      title: resp.length > 80 ? resp.slice(0, 77) + "…" : resp,
      description: `Persona-derived starter task for "${persona.name}".`,
      origin: { task, createdAt: new Date().toISOString() },
      plan: { steps: [], summary: undefined, waves: [] },
      runCount: 0,
    });
  }
  // Universal fallback — always available as a quick prompt, frames the
  // task in the persona's voice without needing a specific responsibility.
  out.push({
    id: `${templateIdPrefix(persona.id)}ask-anything`,
    role: "Custom",
    title: `Ask ${persona.name} anything`,
    description: `Free-form task framed through the ${persona.role} role. Empty plan — re-plans against the persona system prompt each run.`,
    origin: { task: `As a ${persona.role}, respond to the following task in role:`, createdAt: new Date().toISOString() },
    plan: { steps: [], summary: undefined, waves: [] },
    runCount: 0,
  });
  return out;
}

// Boot-time pass.
//
//   • Built-in personas (id has an entry in CURATED) ALWAYS refresh against
//     the latest curated set. Run history is preserved per template id via
//     refreshPersonaTemplates. This lets us improve the platform's starter
//     templates and have those improvements land on the next server boot
//     without the user having to click anything.
//   • Custom personas only get templates generated when they're missing —
//     we don't overwrite a user's customisations.
export function ensureAllPersonasHaveTemplates(personas: Persona[]): { personaId: string; added: number; refreshed?: boolean }[] {
  const summary: { personaId: string; added: number; refreshed?: boolean }[] = [];
  for (const persona of personas) {
    const isBuiltin = CURATED[persona.id] !== undefined;
    if (isBuiltin) {
      const r = refreshPersonaTemplates(persona);
      const changed = r.added + r.removed;
      if (changed > 0) summary.push({ personaId: persona.id, added: r.added, refreshed: true });
      continue;
    }
    const existing = listPersonaTemplates(persona.id);
    if (existing.length > 0) continue;
    const fresh = buildStarterTemplates(persona);
    for (const t of fresh) saveCustomTemplate(t);
    if (fresh.length > 0) summary.push({ personaId: persona.id, added: fresh.length });
  }
  return summary;
}

// List the custom templates that were generated for a given persona. Used by
// the UI to show counts and by refresh to know what to remove first.
export function listPersonaTemplates(personaId: string): CustomTemplate[] {
  const prefix = templateIdPrefix(personaId);
  return loadCustomTemplates().filter(t => t.id.startsWith(prefix));
}

// Refresh = remove old persona-derived templates, generate fresh ones from
// current responsibilities. PRESERVES the runCount/lastRunAt of templates
// whose id survives (e.g. responsibility text unchanged) so the user's usage
// history isn't reset on a no-op refresh.
export function refreshPersonaTemplates(persona: Persona): { kept: number; added: number; removed: number; ids: string[] } {
  const old = listPersonaTemplates(persona.id);
  const oldById = new Map(old.map(t => [t.id, t]));
  const fresh = buildStarterTemplates(persona);
  const freshIds = new Set(fresh.map(t => t.id));

  let kept = 0;
  let added = 0;
  let removed = 0;

  // Carry over runCount + lastRunAt for templates with matching ids.
  for (const f of fresh) {
    const prior = oldById.get(f.id);
    if (prior) {
      f.runCount = prior.runCount;
      f.lastRunAt = prior.lastRunAt;
      kept++;
    } else {
      added++;
    }
    saveCustomTemplate(f);
  }
  // Drop old templates that aren't in the fresh set.
  for (const o of old) {
    if (!freshIds.has(o.id)) {
      if (deleteCustomTemplate(o.id)) removed++;
    }
  }
  return { kept, added, removed, ids: fresh.map(t => t.id) };
}

// Remove every template owned by a persona — used when the persona is deleted.
export function purgePersonaTemplates(personaId: string): number {
  const owned = listPersonaTemplates(personaId);
  let removed = 0;
  for (const t of owned) if (deleteCustomTemplate(t.id)) removed++;
  return removed;
}
