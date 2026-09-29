// Innovation Scan — a self-improvement + tech/AI-news digest, structurally
// mirroring the nightly reflection loop (see reflection.ts): collect →
// aggregate → synthesize (LLM, strict headings, retry + wall-clock cap) →
// renderMarkdown (frontmatter + body + collapsible raw-JSON footer) →
// writeVaultFile + enqueueVaultCommit → register a Job (Calendar) →
// hourly scheduler with a local-date + mtime catch-up guard.
//
// Two passes:
//   1. TARGETED — looks at our own learned weaknesses (quality signals +
//      reflection bottlenecks) and researches concrete fixes for them.
//   2. BROAD — a breadth-only watch of trending AI/ML repos + general tech
//      news, so the operator sees what's new without having to go looking.
//
// The digest is written to `_neuroworks/innovation-scans/<YYYY-MM-DD>.md` —
// same vault, sibling directory to `_neuroworks/reflections/`.

import { writeVaultFile } from "./vault.js";
import { enqueueVaultCommit } from "./commit-queue.js";
import { llmGenerate, llmGenerateWithMeta } from "./llm.js";
import { learnedQualitySignals } from "./quality.js";
import { listBottlenecks } from "./reflection-bottlenecks.js";
import { searchWeb, smartFetch } from "./web-client.js";
import { validateSources } from "./source-validator.js";
import { sanitizeFetchedText } from "./injection-guard.js";
import { fetchCuratedRss, type CuratedRssItem } from "./rss-client.js";
import { searchTrendingRepos } from "./github.js";
import type { FetchedSource, ValidatedSource } from "./source-validator-types.js";
import { getCostSummary } from "./cost-tracker.js";
import { isFreeModelId } from "./model-policy.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanForSecurityRisks } from "./security.js";
import { nextSkillVersion } from "./skill-version.js";
import { logAudit } from "./audit-log.js";
import { isOffline } from "./offline-mode.js";

const SCAN_DIR = "_neuroworks/innovation-scans";

export type Weakness = {
  query: string;
  reason: string;
  scope: "kind" | "persona" | "bottleneck";
  key: string;
};

export type SourceRef = { url: string; title: string; score?: number };

export type TargetedFinding = {
  weaknessQuery: string;
  reason: string;
  summary: string;
  sources: SourceRef[];
};

export type NewsFinding = {
  query: string;
  summary: string;
  sources: SourceRef[];
};

export type TrendingRepo = { name: string; fullName: string; description: string | null; stars: number; url: string };

export type BroadWatch = {
  repos: TrendingRepo[];
  news: NewsFinding[];
  curated: CuratedRssItem[];
};

export type InnovationScanResult = {
  date: string;
  path: string;
  targeted: TargetedFinding[];
  broad: BroadWatch;
  digest: string;      // markdown body (just the digest text, not the whole file)
  generatedAt: string;
  modelUsed?: string;
};

let lastResult: InnovationScanResult | null = null;
let inFlight: Promise<InnovationScanResult> | null = null;

// ─── 1. Identify our own weaknesses ───
//
// Small, honest lookup table: a weak quality axis or a recurring bottleneck
// error pattern → a concrete web-search query. Mirrors reflection-
// bottlenecks.ts's deriveRemedy() in style (pattern-match → directive) but
// aimed at "what should we go read" instead of "what should the planner do
// differently next run".
const AXIS_QUERY: Record<string, string> = {
  factuality_risk: "improving LLM factual accuracy hallucination mitigation techniques 2026",
  citation_coverage: "improving LLM citation grounding RAG source attribution techniques",
  persona_fit: "LLM persona consistency instruction following prompt engineering techniques",
  prompt_alignment: "LLM prompt alignment instruction following evaluation techniques",
};

function queryForBottleneck(topError: string): string {
  const e = (topError || "").toLowerCase();
  if (/timeout|timed out|etimedout|abort|too long|deadline/.test(e)) {
    return "reducing LLM agent task timeouts parallelizing long running agent workflows";
  }
  if (/not configured|no provider|connector|unauthor|401|403|credential|auth/.test(e)) {
    return "robust API credential and connector health checks for AI agents best practices";
  }
  if (/no records|not found|empty|nothing|no results|no data/.test(e)) {
    return "improving retrieval accuracy AI agents picking the right data source";
  }
  if (/\$step_|unresolved|reference|placeholder/.test(e)) {
    return "reliable multi-step LLM agent planning avoiding unresolved step references";
  }
  return "reducing AI agent task failure rates reliability engineering techniques";
}

// Pick the 2-3 weakest signals across quality axes and reflection
// bottlenecks, and map each to a concrete search query. Kept small and
// honest — this is not meant to be exhaustive, just enough to point the
// scan at real, current material.
export function identifyOwnWeaknesses(): Weakness[] {
  const out: Weakness[] = [];

  const signals = learnedQualitySignals(3)
    .filter(s => s.weakestGoodness < 0.7)
    .slice(0, 2);
  for (const s of signals) {
    const query = AXIS_QUERY[s.weakestAxis];
    if (!query) continue;
    out.push({
      query,
      reason: `${s.scope === "kind" ? `Task type "${s.key}"` : `Persona "${s.key}"`} is weakest on ${s.weakestAxis} (goodness ${s.weakestGoodness.toFixed(2)} over ${s.samples} runs).`,
      scope: s.scope,
      key: s.key,
    });
  }

  const bottlenecks = listBottlenecks()
    .filter(b => b.totalRuns >= 4 && b.failureRate >= 0.2)
    .slice(0, 2);
  for (const b of bottlenecks) {
    if (out.length >= 3) break;
    out.push({
      query: queryForBottleneck(b.topError),
      reason: `"${b.template}" fails ${Math.round(b.failureRate * 100)}% of the time (${b.totalFailed}/${b.totalRuns} runs). Most common error: "${b.topError || "unknown"}".`,
      scope: "bottleneck",
      key: b.template,
    });
  }

  return out.slice(0, 3);
}

// ─── Model & cost health — Naxie's model-selection self-improvement ───
// Distinct from identifyOwnWeaknesses() above: those feed the web-research
// pipeline (a weak quality axis → go read about it). This reads our OWN
// cost-tracker data directly — no research needed, the evidence already
// exists — and is reported plainly in the digest, with an OrgTask for
// anything concretely actionable so Naxie can propose a fix via
// system.admin's "switch_model" action (approval-gated, same as every other
// self-improvement loop this session wired up).
export type ModelHealthFinding = { area: string; issue: string; recommendation: string; evidence: string; actionable: boolean };

export function deriveModelHealthFindings(): ModelHealthFinding[] {
  const out: ModelHealthFinding[] = [];
  const { byModel } = getCostSummary();
  for (const m of byModel) {
    if (m.calls < 5) continue; // too little signal to act on
    if (m.failureRate >= 0.2) {
      out.push({
        area: "Model reliability",
        issue: `"${m.model}" is failing ${Math.round(m.failureRate * 100)}% of calls (${m.failed}/${m.calls})`,
        recommendation: `Switch the tier using "${m.model}" to a healthier model via system.admin's switch_model action — prefer a free one (isFreeModelId) unless paid models are separately approved.`,
        evidence: `byModel["${m.model}"]: calls=${m.calls} failed=${m.failed} failureRate=${m.failureRate.toFixed(2)}`,
        actionable: true,
      });
    }
  }
  const paidSpend = byModel.filter(m => m.costUsd > 0 && !isFreeModelId(m.model));
  const totalPaidUsd = paidSpend.reduce((s, m) => s + m.costUsd, 0);
  if (totalPaidUsd > 0) {
    out.push({
      area: "Model cost",
      issue: `$${totalPaidUsd.toFixed(4)} spent on paid models this window (${paidSpend.map(m => m.model).join(", ")})`,
      recommendation: "Review whether a free-tier model would serve these calls just as well — informational only, no auto-switch without checking output quality first.",
      evidence: paidSpend.map(m => `${m.model}: $${m.costUsd.toFixed(4)} (${m.calls} calls)`).join("; "),
      actionable: false,
    });
  }
  return out;
}

// ─── Shared fetch/validate helper — mirrors research.deep's pipeline ───
async function searchFetchValidate(query: string, depth: number): Promise<{ kept: ValidatedSource[]; fetchedCount: number }> {
  const search = await searchWeb(query, depth).catch(() => ({ engine: "none", results: [], tried: [] }));
  const fetched: (FetchedSource & { title: string })[] = await Promise.all(
    search.results.map(async (w) => {
      try {
        const r = await smartFetch(w.url, { maxBytes: 60_000, timeoutMs: 8_000 });
        return {
          url: w.url,
          title: sanitizeFetchedText(r.title ?? w.title),
          text: sanitizeFetchedText(r.text.slice(0, 4_000)),
          ok: true,
          usedBrowser: r.usedBrowser,
          status: (r as any).status,
          engine: ((r as any).engine ?? (r.usedBrowser ? "browser" : "http")) as any,
        };
      } catch (e: any) {
        return { url: w.url, title: w.title, text: "", ok: false, error: String(e?.message ?? e) };
      }
    }),
  );
  const validation = validateSources(fetched, { mode: "strict", query, minRetainedSources: 1 });
  return { kept: validation.kept, fetchedCount: fetched.length };
}

// One LLM call per weakness/query (batched over all its sources) — not
// per-source — to keep cost bounded.
async function summarizeBatch(topic: string, kept: ValidatedSource[]): Promise<string> {
  if (kept.length === 0) return "_No usable sources found for this topic._";
  const evidence = kept
    .map((s, i) => `[${i + 1}] ${s.title ?? s.url}\n${s.url}\n${(s.text ?? "").slice(0, 1500)}`)
    .join("\n\n");
  const sys = "You summarize web research for a busy operator. Two to four plain-language sentences, no jargon dump, cite sources inline as [N]. Be concrete about what's actionable.";
  const prompt = `Topic: ${topic}\n\n${evidence}\n\nWrite the summary.`;
  try {
    const meta = await llmGenerateWithMeta(prompt, sys, { profile: "synthesis", complexity: "low", maxTokens: 300 } as any);
    return meta.text.trim();
  } catch (e: any) {
    return `_Summary unavailable (${String(e?.message ?? e).slice(0, 100)}). Sources: ${kept.map(s => s.url).join(", ")}_`;
  }
}

// ─── 2. Targeted scan — dig into our own weaknesses ───
export async function runTargetedScan(weaknesses: Weakness[]): Promise<TargetedFinding[]> {
  const out: TargetedFinding[] = [];
  for (const w of weaknesses) {
    const { kept } = await searchFetchValidate(w.query, 3);
    const summary = await summarizeBatch(w.query, kept);
    out.push({
      weaknessQuery: w.query,
      reason: w.reason,
      summary,
      sources: kept.map(s => ({ url: s.url, title: s.title ?? s.url, score: s.score })),
    });
  }
  return out;
}

// ─── 3. Broad watch — trending repos + general tech/AI news ───
const BROAD_REPO_QUERIES = [
  "topic:llm stars:>50 created:>7 days ago",
  "topic:ai-agents stars:>30 created:>14 days ago",
  "topic:machine-learning stars:>50 pushed:>3 days ago",
];
const BROAD_NEWS_QUERIES = [
  "AI news this week",
  "trending open source AI developer tools",
];

export async function runBroadWatch(): Promise<BroadWatch> {
  const repoLists = await Promise.all(
    BROAD_REPO_QUERIES.map(q => searchTrendingRepos(q, { limit: 5 }).catch(() => [] as TrendingRepo[])),
  );
  const seen = new Set<string>();
  const repos: TrendingRepo[] = [];
  for (const list of repoLists) {
    for (const r of list) {
      if (seen.has(r.fullName)) continue;
      seen.add(r.fullName);
      repos.push(r);
    }
  }
  repos.sort((a, b) => b.stars - a.stars);

  // Breadth pass: fewer sources per query than the targeted (depth-heavy)
  // pass above — this is meant to be cheap.
  const news: NewsFinding[] = [];
  for (const q of BROAD_NEWS_QUERIES) {
    const { kept } = await searchFetchValidate(q, 2);
    const summary = await summarizeBatch(q, kept);
    news.push({ query: q, summary, sources: kept.map(s => ({ url: s.url, title: s.title ?? s.url, score: s.score })) });
  }

  // Verified-URL supplement, fetched/parsed directly — never handed to
  // summarizeBatch, so nothing here is at risk of an LLM rewriting a
  // headline or link. Best-effort: a feed outage shouldn't sink the scan.
  const curated = await fetchCuratedRss().catch(() => [] as CuratedRssItem[]);

  return { repos: repos.slice(0, 12), news, curated };
}

// ─── 3b. Marketplace sync — surface trending discoveries as skills ───
// Mirrors the manual "Export" flow in routes/extensions.ts (POST
// /export/:id): same skills/_user/*.md destination, same slugging,
// versioning (skill-version.ts) and high-severity secret gate
// (security.ts), so a discovered repo shows up in the Marketplace tab
// exactly like a manually-exported connector/integration. Unlike the
// model-health findings above, this doesn't touch anything live (no
// routing, no credentials) so it writes directly — same posture as the
// scan's own vault-file writes — rather than going through an
// approval-gated OrgTask.
const MIN_STARS_FOR_MARKETPLACE = 30;
const MAX_MARKETPLACE_SYNC = 3;

function slugifyRepoName(fullName: string): string {
  return fullName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "repo";
}

export function syncMarketplaceFromBroadWatch(repos: TrendingRepo[]): { added: string[] } {
  const added: string[] = [];
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const SKILLS_USER = resolve(__dirname, "../skills/_user");
  if (!existsSync(SKILLS_USER)) mkdirSync(SKILLS_USER, { recursive: true });

  const picks = repos.filter(r => r.stars >= MIN_STARS_FOR_MARKETPLACE).slice(0, MAX_MARKETPLACE_SYNC);
  for (const repo of picks) {
    const slug = slugifyRepoName(repo.fullName);
    const filename = `${slug}.md`;
    const dest = join(SKILLS_USER, filename);
    let version = "1.0.0";
    try {
      version = nextSkillVersion(existsSync(dest) ? readFileSync(dest, "utf8") : null);
    } catch { version = "1.0.1"; }
    const description = (repo.description ?? "no description").replace(/"/g, "'");
    const frontmatter = `---\nname: ${slug}\ndescription: "${description} — auto-discovered by Innovation Scan"\napplies_to: ["discovery"]\nversion: ${version}\n---\n`;
    const date = new Date().toISOString().slice(0, 10);
    const body = `# ${repo.fullName}

${description}

> Auto-discovered by **Innovation Scan** on ${date} — ${repo.stars}★ on GitHub.

## Link
${repo.url}

## Notes
- Surfaced because it cleared the trending-repo bar (${MIN_STARS_FOR_MARKETPLACE}+ stars). Resurfacing in a later scan bumps the version instead of duplicating the entry.
- Version: \`${version}\`
`;
    const fullContent = frontmatter + body;
    const findings = scanForSecurityRisks(fullContent, "note");
    const high = findings.filter(f => f.severity === "high");
    if (high.length > 0) {
      logAudit({ level: "error", actor: "innovation-scan", action: "marketplace.blocked", target: `discovery:${slug}`, detail: `blocked high-severity ${high.map(h => h.type).join(",")}`, result: "failure" });
      continue;
    }
    try {
      writeFileSync(dest, fullContent, "utf8");
      logAudit({ level: "info", actor: "innovation-scan", action: "marketplace.autoexport", target: `discovery:${slug}`, detail: `${filename} v${version}`, result: "success" });
      added.push(slug);
    } catch (e: any) {
      console.warn(`[innovation-scan] marketplace sync write failed for ${slug}: ${e?.message ?? e}`);
    }
  }
  return { added };
}

// ─── 4. Synthesize the operator-facing digest ───
export async function synthesizeDigest(targeted: TargetedFinding[], broad: BroadWatch, modelHealth: ModelHealthFinding[] = []): Promise<{ text: string; modelUsed?: string }> {
  if (targeted.length === 0 && broad.repos.length === 0 && broad.news.length === 0 && broad.curated.length === 0 && modelHealth.length === 0) {
    return {
      text: `_Nothing to report yet. Once the system has run enough tasks to learn where it's weak, and/or the web is reachable, this scan will have real material to work with._`,
    };
  }

  const sys = `You are NeuroWorks's Innovation Scan writer — and Naxie, the operator's PA, is delivering this. The operator is NOT deeply technical — plain language, no jargon dump, no wall of acronyms. Your job is to make three things clear: (1) how we're fixing our own weak spots, (2) how the AI models we're actually using are doing (failure rates, cost, free vs paid), and (3) what's new and interesting in AI/tech this week.

Output sections — use these EXACT headings (including the emoji prefix):
## 🔧 Fixing our weak spots
For EACH targeted finding, tie it back to the specific weakness that prompted it — say what's weak, then what the research suggests doing about it. Plain language. If there are no targeted findings, say plainly that nothing weak enough to chase was found.

## 🧠 Model & cost health
State plainly what's happening with the models this week — failure rates, which ones are struggling, how much (if anything) was spent on paid models and whether that seems worth it. If a finding is flagged actionable, say Naxie will propose a fix for the operator to approve. If there's nothing to report, say so.

## ✨ What's new and interesting
Digestible highlights from the trending repos and news findings — what it is and why it might matter to us, in plain terms. If there's nothing, say so.

## 🌍 Why it matters for us
1-2 sentences tying the scan back to "AI for a better Africa" — practical next step the operator could take this week.

Rules:
- Warm, concise, skimmable — short paragraphs or bullets. Use emoji sparingly but do use them: section headings already have one, and 1-2 tasteful emoji per bullet/list item are welcome (e.g. 🚀 💡 🔭 🛠️ 📦). No emoji spam.
- No filler ("In today's fast-moving AI landscape...").
- Keep headings exactly as specified — downstream rendering depends on them.
- Numbers/names/sources always beat vague claims. Cite a source inline where the finding came from.`;

  const targetedBlock = targeted.length > 0
    ? targeted.map(t => `### Weakness: ${t.reason}\nResearch query: "${t.weaknessQuery}"\nFindings: ${t.summary}`).join("\n\n")
    : "_(no weaknesses identified this run — insufficient quality/bottleneck data yet)_";

  const modelHealthBlock = modelHealth.length > 0
    ? modelHealth.map(m => `### ${m.area}${m.actionable ? " (actionable — OrgTask created)" : ""}\n${m.issue}\nRecommendation: ${m.recommendation}\nEvidence: ${m.evidence}`).join("\n\n")
    : "_(no model/cost health findings this run — not enough call volume yet, or everything's healthy)_";

  const reposBlock = broad.repos.length > 0
    ? broad.repos.map(r => `- ${r.fullName} (${r.stars}★) — ${r.description ?? "no description"} — ${r.url}`).join("\n")
    : "_(no trending repos found)_";

  const newsBlock = broad.news.length > 0
    ? broad.news.map(n => `### "${n.query}"\n${n.summary}`).join("\n\n")
    : "_(no news findings)_";

  const prompt = `## Targeted findings (our own weak spots)\n\n${targetedBlock}\n\n## Model & cost health\n\n${modelHealthBlock}\n\n## Trending repos\n\n${reposBlock}\n\n## News findings\n\n${newsBlock}\n\nWrite the digest.`;

  const attemptSynthesis = async (): Promise<{ text: string; modelUsed?: string }> => {
    let lastErr: any;
    // Bounded per-attempt budget — same stall-fast reasoning as the system
    // audit's synthesis (8-min outer cap burned whole scans on slow backends).
    const timeoutMs = Math.max(60_000, Number(process.env.NEUROWORKS_SYNTH_TIMEOUT_MS ?? "180000"));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const meta = await llmGenerateWithMeta(prompt, sys, { profile: "synthesis", complexity: "high", timeoutMs } as any);
        if (attempt > 0) console.log(`[innovation-scan] LLM call succeeded on retry`);
        return { text: meta.text.trim(), modelUsed: meta.model };
      } catch (e: any) {
        lastErr = e;
        if (attempt === 0) {
          const msg = String(e?.message ?? e).slice(0, 100);
          console.warn(`[innovation-scan] LLM call failed (${msg}) — retrying once in 2s`);
          await new Promise(r => setTimeout(r, 2_000));
          continue;
        }
      }
    }
    return {
      text: `_LLM digest synthesis failed after retry (\`${String(lastErr?.message ?? lastErr).slice(0, 100)}\`). The raw findings below are still valid — review them manually.\n\n## Fixing our weak spots\n${targetedBlock}\n\n## Model & cost health\n${modelHealthBlock}\n\n## What's new and interesting\n${reposBlock}\n\n${newsBlock}`,
    };
  };

  // Same defensive wall-clock cap as reflection.ts's synthesizeReflection —
  // a hung backend must cost minutes, not hours, and the scan must still
  // land a usable file via the stat-only fallback.
  const SYNTH_TIMEOUT_MS = Math.max(60_000, Number(process.env.NEUROWORKS_INNOVATION_SCAN_SYNTH_TIMEOUT_MS ?? String(8 * 60_000)));
  let capTimer: NodeJS.Timeout | undefined;
  const cap = new Promise<{ text: string; modelUsed?: string }>((resolve) => {
    capTimer = setTimeout(() => {
      const mins = Math.round(SYNTH_TIMEOUT_MS / 60_000);
      console.warn(`[innovation-scan] synthesis exceeded ${mins}min cap — abandoning the LLM call and writing the findings-only digest`);
      resolve({
        text: `_LLM digest synthesis exceeded the ${mins}min cap and was abandoned so the scan wouldn't stall. The raw findings below are still valid.\n\n## Fixing our weak spots\n${targetedBlock}\n\n## Model & cost health\n${modelHealthBlock}\n\n## What's new and interesting\n${reposBlock}\n\n${newsBlock}`,
      });
    }, SYNTH_TIMEOUT_MS);
    if (typeof capTimer.unref === "function") capTimer.unref();
  });
  try {
    return await Promise.race([attemptSynthesis(), cap]);
  } finally {
    if (capTimer) clearTimeout(capTimer);
  }
}

// ─── 5. Render markdown — mirrors reflection.ts's renderMarkdown shape ───
export function renderMarkdown(result: {
  date: string;
  targeted: TargetedFinding[];
  broad: BroadWatch;
  digest: string;
  generatedAt: string;
  modelUsed?: string;
}): string {
  const niceDate = new Date(result.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  // Degraded runs can hand us partial shapes (today's scan had empty broad
  // sections when the digest cap aborted) — never crash the renderer on a
  // missing array.
  const repos = result.broad.repos ?? [];
  const news = result.broad.news ?? [];
  const curated = result.broad.curated ?? [];
  const header = `---
type: innovation-scan
date: ${result.date}
targetedCount: ${result.targeted.length}
repoCount: ${repos.length}
newsCount: ${news.length}
curatedCount: ${curated.length}
generated: ${result.generatedAt}
${result.modelUsed ? `model: ${result.modelUsed}\n` : ""}---

# 🔭 Innovation Scan — ${niceDate}

> ✨ *Naxie's morning scan — fresh signals, fixes for our weak spots, and what's new in AI.*

| 🔧 Weak spots | 📦 Trending repos | 📰 News | 📡 Curated |
|---|---|---|---|
| **${result.targeted.length}** investigated | **${repos.length}** | **${news.length}** | **${curated.length}** |

---

`;
  // Deliberately NOT run through the digest LLM above — rendered straight
  // from the fetched feed data so every title/link here is exactly what the
  // feed published; the LLM never touches this text.
  const curatedSection = curated.length > 0
    ? `\n\n## 📡 Verified feed roundup (last 48h)\n_Straight from the source feeds — titles and links exactly as published._\n\n${curated.slice(0, 20).map(c => `- [${c.source}] ${c.title} — ${c.url}`).join("\n")}\n`
    : "";
  const footer = `

---

<details><summary>Raw findings snapshot</summary>

\`\`\`json
${JSON.stringify({ targeted: result.targeted, broad: result.broad }, null, 2)}
\`\`\`

</details>
`;
  return header + result.digest.trim() + curatedSection + footer;
}

// ─── 6. Top-level orchestrator — mirrors reflection.ts's runReflection ───
export async function runInnovationScan(opts: { force?: boolean } = {}): Promise<InnovationScanResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const runStartedAtIso = new Date().toISOString();
    const weaknesses = identifyOwnWeaknesses();
    const modelHealth = deriveModelHealthFindings();
    const [targeted, broad] = await Promise.all([
      runTargetedScan(weaknesses),
      runBroadWatch(),
    ]);
    const { text, modelUsed } = await synthesizeDigest(targeted, broad, modelHealth);

    // Model-selection self-improvement loop: an actionable finding (a model
    // with a real failure rate) becomes an OrgTask — same pattern
    // system-audit.ts uses for its improvements[] — so Naxie can propose the
    // fix via system.admin's switch_model action and the operator approves
    // it, instead of the finding just sitting in a digest nobody acts on.
    try {
      const { createOrgTask, listOrgTasks } = await import("./org-tasks.js");
      const openTitles = new Set(listOrgTasks({ role: "admin" }).filter(t => t.status !== "done").map(t => t.title));
      for (const f of modelHealth) {
        if (!f.actionable) continue;
        const title = `Innovation Scan: ${f.area} — ${f.issue}`.slice(0, 160);
        if (openTitles.has(title)) continue;
        createOrgTask({ role: "admin", title, detail: `${f.recommendation}\n\nEvidence: ${f.evidence}`, priority: "high", createdBy: "daemon" });
      }
    } catch (e: any) {
      console.warn(`[innovation-scan] model-health org-task creation failed: ${e?.message ?? e}`);
    }

    try {
      const { added } = syncMarketplaceFromBroadWatch(broad.repos);
      if (added.length > 0) console.log(`[innovation-scan] marketplace sync added/updated: ${added.join(", ")}`);
    } catch (e: any) {
      console.warn(`[innovation-scan] marketplace sync failed: ${e?.message ?? e}`);
    }

    const generatedAt = new Date().toISOString();
    const date = generatedAt.slice(0, 10);
    const path = `${SCAN_DIR}/${date}.md`;
    const body = renderMarkdown({ date, targeted, broad, digest: text, generatedAt, modelUsed });
    try {
      writeVaultFile(path, body);
      void enqueueVaultCommit(`chore(innovation-scan): scan for ${date}`);
    } catch (e: any) {
      console.warn(`[innovation-scan] write failed: ${e?.message ?? e}`);
    }

    const result: InnovationScanResult = { date, path, targeted, broad, digest: text, generatedAt, modelUsed };
    lastResult = result;

    // Surface on the Calendar, same as reflection:daily.
    try {
      const { newJob } = await import("./jobs.js");
      const { persistJobRecord } = await import("./job-store.js");
      const j = newJob("innovation-scan");
      j.title = `Innovation Scan — ${date} (${targeted.length} weak spots, ${broad.repos.length} repos, ${broad.news.length} news)`;
      j.status = "succeeded";
      j.startedAt = runStartedAtIso;
      j.finishedAt = generatedAt;
      j.result = {
        answer: text,
        plan: { summary: `Innovation scan: ${targeted.length} targeted + ${broad.repos.length + broad.news.length} broad findings` },
        targeted,
        broad,
        scanPath: path,
      };
      try { persistJobRecord(j); } catch { /* tolerate */ }
    } catch (e: any) {
      console.warn(`[innovation-scan] job registration failed: ${e?.message ?? e}`);
    }
    return result;
  })();
  try { return await inFlight; }
  finally { inFlight = null; }
}

export function lastInnovationScan(): InnovationScanResult | null {
  return lastResult;
}

// Bundles the last result with a computed next-fire time (same env var/default
// as the scheduler below) so the Daily Rhythm view can show this daemon
// alongside user Schedules without duplicating the scheduler itself.
export async function innovationScanStatus(): Promise<{ last: InnovationScanResult | null; nextFireAt: number | null }> {
  const { nextFireAt } = await import("./schedules.js");
  const SCAN_HOUR = Number(process.env.NEUROWORKS_INNOVATION_SCAN_HOUR ?? "8");
  return { last: lastInnovationScan(), nextFireAt: nextFireAt({ daysOfWeek: [], hour: SCAN_HOUR, minute: 0 }) };
}

// ─── Hourly scheduler — mirrors reflection.ts's exactly, offset by a few
// hours so the two nightly jobs don't compete for the LLM backend at once. ───
let scheduler: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;

// Best-effort push of the finished digest to Telegram — never throws, never
// blocks the scheduler. Silently no-ops if Telegram isn't connected (same
// "optional delivery" posture as schedules.ts's email delivery).
async function deliverToTelegram(result: InnovationScanResult): Promise<void> {
  try {
    const { sendTelegramMessage } = await import("./telegram-bridge.js");
    const niceDate = new Date(result.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const header = `🔭 *Innovation Scan — ${niceDate}*\n✨ Naxie's morning scan\n`;
    const stats = `🔧 ${result.targeted.length} weak spot(s) · 📦 ${result.broad.repos.length} repo(s) · 📰 ${result.broad.news.length} news`;
    const body = result.digest.slice(0, 3300);
    const footer = `\n\n— _Full report in vault: ${result.path}_`;
    const text = `${header}\n${stats}\n\n${body}${footer}`;
    const r = await sendTelegramMessage(text);
    if (!r.ok) console.warn(`[innovation-scan] Telegram delivery skipped: ${r.error}`);
  } catch (e: any) { console.warn(`[innovation-scan] Telegram delivery failed: ${e?.message ?? e}`); }
}

export function startInnovationScanScheduler(): void {
  if (scheduler) return;
  // Default 8 AM local — innovation scan fires at 8am. The todo brief (6am) and
  // daily reflection (8pm) are offset so they don't compete for the LLM backend
  // at once. They may still land in the same catch-up tick; that's fine, each
  // fires and delivers independently.
  const SCAN_HOUR = Number(process.env.NEUROWORKS_INNOVATION_SCAN_HOUR ?? "8");
  const tick = async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (now.getHours() < SCAN_HOUR || lastRunDate === today) return;
    // Offline mode: the scan is web research — wait (it catches up the same
    // day once back online) rather than write an empty scan.
    if (isOffline()) return;
    try {
      const { existsSync, readdirSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { config } = await import("../config.js");
      const dir = join(config.vaultPath, SCAN_DIR);
      if (existsSync(dir)) {
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const ranToday = readdirSync(dir).some(f => {
          if (!f.endsWith(".md")) return false;
          try { return statSync(join(dir, f)).mtimeMs >= midnight; } catch { return false; }
        });
        if (ranToday) { lastRunDate = today; return; }
      }
    } catch { /* vault unreachable — fall through; runInnovationScan will surface it */ }
    lastRunDate = today;
    console.log(`[innovation-scan] firing daily scan (hour>=${SCAN_HOUR}, catch-up)`);
    try {
      const result = await runInnovationScan();
      void deliverToTelegram(result);
    }
    catch (e: any) { console.warn(`[innovation-scan] scheduler run failed: ${e?.message ?? e}`); }
  };
  scheduler = setInterval(tick, 10 * 60_000);
  void tick();
}

export function stopInnovationScanScheduler(): void {
  if (scheduler) { clearInterval(scheduler); scheduler = null; }
}

// Stay tree-shake-friendly — referenced only when the route imports it.
void llmGenerate;
