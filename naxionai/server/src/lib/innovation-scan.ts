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
// The digest is written to `_naxion/innovation-scans/<YYYY-MM-DD>.md` —
// same vault, sibling directory to `_naxion/reflections/`.

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
import { getCostRecords } from "./cost-tracker.js";
import { isFreeModelId } from "./model-policy.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanForSecurityRisks } from "./security.js";
import { nextSkillVersion } from "./skill-version.js";
import { logAudit } from "./audit-log.js";
import { isOffline } from "./offline-mode.js";
import { registerEngine, unregisterEngine } from "./scheduler-registry.js";
import { withTimeout, cleanSectionText } from "./report-pipeline.js";
import { localSynthBudget } from "./local-budget.js";
import { llmLaneStatus } from "./llm-lane.js";
import { config } from "../config.js";

const SCAN_DIR = "_naxion/innovation-scans";

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
// anything concretely actionable so Naxie can propose a fix (approval-gated,
// same as every other self-improvement loop this session wired up). NOTE the
// fix differs by lane: remote backends get a switch_model proposal, local
// Ollama failures get an `ollama pull`/model-availability check instead —
// switch_model only re-points remote tiers and is a no-op for local models.
// `key` is the STABLE identity for OrgTask dedup below — unlike `issue`
// (which embeds the live failure count/percentage and so is a different
// string every day the rolling window shifts), `key` never changes for the
// same underlying model, so "already have an open task for this" can
// actually match day over day instead of re-triggering on every run.
export type ModelHealthFinding = { area: string; issue: string; recommendation: string; evidence: string; actionable: boolean; key?: string };

// ── Model health: a RECENT-WINDOW view of cost.jsonl ───────────────────
//
// This used to read getCostSummary(), which aggregates the ENTIRE cost.jsonl
// and never decays. A model that had one bad week therefore kept re-firing an
// "actionable, high-priority" OrgTask every single day, forever. On
// 2026-10-14 three of the four models it flagged were already healthy:
//   - qwen2.5:3b          135 failures, EVERY one 404 "model not found" from
//                         a missing `ollama pull`; last failure 2026-10-09
//   - gemma4:31b           6 failures, all 2026-10-04 OpenRouter baseUrl bug
//                         (already fixed)
//   - muse-glimmer:latest 19 failures, zero calls at all since 2026-10-06
// Windowing to 7d drops the long-silent models entirely, and the recency
// rule below demotes the ones whose streak ended a few days ago.
export const MODEL_HEALTH_WINDOW_MS = 7 * 24 * 3600_000;
// A failure only counts as an INCIDENT while it is recent. A streak that
// stopped days ago is history: worth keeping in the digest for visibility
// against a baseline, but it must never keep minting a "switch the model
// NOW" OrgTask.
const MODEL_HEALTH_RECENT_MS = 2 * 24 * 3600_000;

type ModelWindowStats = { calls: number; failed: number; lastFailureAt?: string; lastError?: string; backend?: string };

export function deriveModelHealthFindings(): ModelHealthFinding[] {
  const out: ModelHealthFinding[] = [];
  const since = new Date(Date.now() - MODEL_HEALTH_WINDOW_MS).toISOString();
  const records = getCostRecords(since);
  const byModel = new Map<string, ModelWindowStats>();
  const paidByModel = new Map<string, number>();
  for (const r of records) {
    const m = byModel.get(r.model) ?? { calls: 0, failed: 0 };
    m.calls++;
    m.backend = r.backend;
    if (r.ok === false) {
      m.failed++;
      if (!m.lastFailureAt || r.ts >= m.lastFailureAt) { m.lastFailureAt = r.ts; m.lastError = String(r.error ?? "unknown"); }
    } else if (r.costUsd > 0 && !isFreeModelId(r.model)) {
      paidByModel.set(r.model, (paidByModel.get(r.model) ?? 0) + r.costUsd);
    }
    byModel.set(r.model, m);
  }
  const sorted = [...byModel.entries()].sort((a, b) => (b[1].failed / Math.max(1, b[1].calls)) - (a[1].failed / Math.max(1, a[1].calls)));
  for (const [model, m] of sorted) {
    if (m.calls < 5) continue; // too little signal to act on
    const rate = m.failed / m.calls;
    if (rate < 0.2) continue;
    const live = !!m.lastFailureAt && Date.now() - new Date(m.lastFailureAt).getTime() <= MODEL_HEALTH_RECENT_MS;
    // CostRecord.backend distinguishes "ollama" (the LOCAL install) from
    // "ollama_cloud" and the other remote backends — and the two need
    // DIFFERENT fixes. A local failure is a missing or broken model on this
    // machine, and switch_model cannot reach it at all (it only re-points the
    // remote provider tiers — see the switch_model action in primitives.ts).
    // The old recommendation told the operator to run switch_model for every
    // finding, which was silently a no-op for all 135 qwen2.5:3b failures.
    const isLocal = m.backend === "ollama";
    out.push({
      area: "Model reliability",
      issue: live
        ? `"${model}" failed ${Math.round(rate * 100)}% of calls in the last 7d (${m.failed}/${m.calls}) — still failing as of ${m.lastFailureAt}`
        : `"${model}" failed ${Math.round(rate * 100)}% of calls in the last 7d (${m.failed}/${m.calls}) — streak ENDED ${m.lastFailureAt}, nothing failing since`,
      recommendation: live
        ? (isLocal
          ? `Local Ollama lane: "${model}" is unavailable or broken on this machine (last error: ${m.lastError}). Check \`ollama list\` / \`ollama pull ${model}\` and the runner's model id. switch_model will NOT fix this — it only re-points remote provider tiers.`
          : `Remote provider: switch the tier using "${model}" via system.admin's switch_model action, or check that provider's quota/rate limits. Prefer a free model (isFreeModelId) unless paid models are separately approved.`)
        : `Historical only — the failure streak stopped on ${m.lastFailureAt}. No action needed; kept in the digest so a recurrence is visible against this baseline.`,
      evidence: `cost.jsonl ${since.slice(0, 10)}..now: model="${model}" backend=${m.backend ?? "?"} calls=${m.calls} failed=${m.failed} failureRate=${rate.toFixed(2)} lastFailureAt=${m.lastFailureAt ?? "none"} lastError=${m.lastError ?? "n/a"}`,
      // Only a LIVE failure may generate an OrgTask. A resolved streak has
      // nothing left to approve, and emitting one anyway is exactly the
      // recurring false positive this replaced.
      actionable: live,
      key: `model-reliability:${model}`,
    });
  }

  const totalPaidUsd = [...paidByModel.values()].reduce((s, v) => s + v, 0);
  if (totalPaidUsd > 0) {
    out.push({
      area: "Model cost",
      issue: `$${totalPaidUsd.toFixed(4)} spent on paid models in the last 7d (${[...paidByModel.keys()].join(", ")})`,
      recommendation: "Review whether a free-tier model would serve these calls just as well — informational only, no auto-switch without checking output quality first.",
      evidence: [...paidByModel.entries()].map(([model, c]) => `${model}: $${c.toFixed(4)}`).join("; "),
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
// per-source — to keep cost bounded. Bounded by SUMMARIZE_TIMEOUT_MS so a
// stalled backend can't hang the whole scan (the research loops below await
// these sequentially with no other cap).
const SUMMARIZE_TIMEOUT_MS = Math.max(30_000, Number(process.env.NAXION_INNOVATION_SUMMARIZE_TIMEOUT_MS ?? "90000"));
async function summarizeBatch(topic: string, kept: ValidatedSource[]): Promise<string> {
  if (kept.length === 0) return "_No usable sources found for this topic._";
  const evidence = kept
    .map((s, i) => `[${i + 1}] ${s.title ?? s.url}\n${s.url}\n${(s.text ?? "").slice(0, 1500)}`)
    .join("\n\n");
  const sys = "You summarize web research for a busy operator. Two to four plain-language sentences, no jargon dump, cite sources inline as [N]. Be concrete about what's actionable.";
  const prompt = `Topic: ${topic}\n\n${evidence}\n\nWrite the summary.`;
  try {
    const meta = await withTimeout(
      () => llmGenerateWithMeta(prompt, sys, { profile: "synthesis", complexity: "normal", maxTokens: 300, timeoutMs: SUMMARIZE_TIMEOUT_MS }),
      SUMMARIZE_TIMEOUT_MS,
      `innovation-scan summarize "${topic}"`,
    );
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
//
// MIGRATED onto report-pipeline.ts's core discipline (2026-09): this used to
// be ONE unbounded LLM call writing all four sections at once, with an 8-min
// outer cap that — when it fired — threw away the whole digest and fell back
// to raw, unsynthesised findings. Structurally the same bug report-pipeline.ts
// exists to fix: one monolithic call has no partial-credit mode.
//
// Now each section is its own small, independently-timed-out call (withTimeout,
// cleanSectionText from report-pipeline.ts), so a slow/stuck section becomes a
// named gap in an otherwise-complete digest instead of losing all four. This
// deliberately does NOT route through runReportPipeline's generic
// ReportSchema/evidence-pool machinery — that pipeline's citation-checking
// system prompt would flatten this feature's specific warm, non-technical
// "Naxie is delivering this" voice, and the four sections here each already
// have their own distinct, pre-gathered evidence collection (weakness
// research / cost-tracker data / trending repos+news) rather than one shared
// pool, so the generic single-pool model doesn't fit. What's reused is the
// PATTERN: bounded-per-section, retry-once, partial-credit, total-budget-capped.
const SECTION_RETRY_DELAY_MS = 2_000;

async function draftDigestSection(
  heading: string, sys: string, prompt: string, maxTokens: number, timeoutMs: number,
): Promise<{ heading: string; text: string; ok: boolean; modelUsed?: string; gap?: string }> {
  let lastErr: any;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const meta = await withTimeout(
        () => llmGenerateWithMeta(prompt, sys, { profile: "synthesis", maxTokens, timeoutMs }),
        timeoutMs,
        `innovation-scan section "${heading}"`,
      );
      return { heading, text: cleanSectionText(meta.text.trim(), heading), ok: true, modelUsed: meta.model };
    } catch (e: any) {
      lastErr = e;
      if (attempt === 0) {
        console.warn(`[innovation-scan] "${heading}" failed (${String(e?.message ?? e).slice(0, 100)}) — retrying once in ${SECTION_RETRY_DELAY_MS / 1000}s`);
        await new Promise(r => setTimeout(r, SECTION_RETRY_DELAY_MS));
        continue;
      }
    }
  }
  return { heading, text: "", ok: false, gap: String(lastErr?.message ?? lastErr).slice(0, 160) };
}

const DIGEST_VOICE = `You are Naxie's Innovation Scan writer — and Naxie, the operator's PA, is delivering this. The operator is NOT deeply technical — plain language, no jargon dump, no wall of acronyms. Warm, concise, skimmable — short paragraphs or bullets. Use emoji sparingly but do use a few tasteful ones (e.g. 🚀 💡 🔭 🛠️ 📦) — no emoji spam. No filler ("In today's fast-moving AI landscape..."). Numbers/names/sources beat vague claims. Write the section body only — no heading, it's added separately.`;

export async function synthesizeDigest(targeted: TargetedFinding[], broad: BroadWatch, modelHealth: ModelHealthFinding[] = []): Promise<{ text: string; modelUsed?: string }> {
  if (targeted.length === 0 && broad.repos.length === 0 && broad.news.length === 0 && broad.curated.length === 0 && modelHealth.length === 0) {
    return {
      text: `_Nothing to report yet. Once the system has run enough tasks to learn where it's weak, and/or the web is reachable, this scan will have real material to work with._`,
    };
  }

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

  // Grounding for the "what's new" section: the curated feed is verified
  // titles/links straight from source RSS (the renderer prints them verbatim
  // below the digest for the same reason). Without this, a thin news pass
  // leaves the LLM with nothing to say and it fills the void with stale
  // training-data items (observed 2026-10-04: GPT-4 Turbo, Gemini 1.5 —
  // years out of date). The section prompt may ONLY use the items below.
  const curatedBlock = (broad.curated ?? []).length > 0
    ? (broad.curated ?? []).slice(0, 25).map(c => `- [${c.source}] ${c.title} (${c.url})`).join("\n")
    : "_(no verified feed items this run)_";

  // Per-section budget derived from measured local throughput + the lane's
  // own observed queue wait (local-budget.ts) — each section is a small ask
  // (≤350 tokens), so this lands far below the total cap on a healthy box.
  const sectionTimeoutMs = localSynthBudget({
    maxTokens: 350, inFlight: 1, observedWaitMs: llmLaneStatus().avgWaitMs, cloud: config.openrouterEnabled,
  }).ms;
  // Same defensive TOTAL wall-clock cap as before (env-compatible name kept)
  // — a hung backend must still cost minutes, not hours, across all four
  // sections combined.
  const totalTimeoutMs = Math.max(60_000, Number(process.env.NAXION_INNOVATION_SCAN_SYNTH_TIMEOUT_MS ?? String(8 * 60_000)));
  const t0 = Date.now();
  const remaining = () => Math.max(0, totalTimeoutMs - (Date.now() - t0));

  const specs: { id: string; heading: string; sys: string; prompt: string; maxTokens: number }[] = [
    {
      id: "weak-spots", heading: "🔧 Fixing our weak spots", maxTokens: 300,
      sys: `${DIGEST_VOICE}\nFor EACH targeted finding, tie it back to the specific weakness that prompted it — say what's weak, then what the research suggests doing about it. If there are no targeted findings, say plainly that nothing weak enough to chase was found.`,
      prompt: targetedBlock,
    },
    {
      id: "model-health", heading: "🧠 Model & cost health", maxTokens: 300,
      sys: `${DIGEST_VOICE}\nState plainly what's happening with the models this week — failure rates, which ones are struggling, how much (if anything) was spent on paid models and whether that seems worth it. If a finding is flagged actionable, say Naxie will propose a fix for the operator to approve. If there's nothing to report, say so.`,
      prompt: modelHealthBlock,
    },
    {
      id: "whats-new", heading: "✨ What's new and interesting", maxTokens: 350,
      sys: `${DIGEST_VOICE}\nDigestible highlights from the material below — what it is and why it might matter to us, in plain terms. GROUNDING RULE: write ONLY about the repos, news findings, and verified feed items given here. Never invent tools, model versions, or links, and never reach for older items you "remember" — if a section's data says nothing usable, say so plainly instead of filling the gap.`,
      prompt: `## Trending repos\n\n${reposBlock}\n\n## News findings\n\n${newsBlock}\n\n## Verified feed items (last 48h — prefer these)\n\n${curatedBlock}`,
    },
  ];

  const results: { heading: string; text: string; ok: boolean; gap?: string }[] = [];
  let modelUsed: string | undefined;
  for (const spec of specs) {
    if (remaining() <= 0) {
      results.push({ heading: spec.heading, text: "", ok: false, gap: `not attempted — the digest's total time budget (${Math.round(totalTimeoutMs / 60_000)}min) was already spent` });
      continue;
    }
    const r = await draftDigestSection(spec.heading, spec.sys, spec.prompt, spec.maxTokens, Math.min(sectionTimeoutMs, remaining()));
    results.push(r);
    if (r.modelUsed) modelUsed = r.modelUsed;
  }

  // "Why it matters" ties the other three together — sees their FINAL text,
  // not raw evidence, so it's a small synthesis call, not a research one.
  const priorBlock = results.map(r => `## ${r.heading}\n${r.ok ? r.text : `_Not written: ${r.gap}_`}`).join("\n\n");
  const whyMattersHeading = "🌍 Why it matters for us";
  const whyMatters = remaining() > 0
    ? await draftDigestSection(
        whyMattersHeading,
        `${DIGEST_VOICE}\n1-2 sentences tying the scan back to "AI for a better Africa" — a practical next step the operator could take this week. You'll be shown the digest's other sections already written — build on them, don't repeat them.`,
        priorBlock,
        150,
        Math.min(sectionTimeoutMs, remaining()),
      )
    : { heading: whyMattersHeading, text: "", ok: false as const, gap: `not attempted — the digest's total time budget (${Math.round(totalTimeoutMs / 60_000)}min) was already spent` };
  if (whyMatters.modelUsed) modelUsed = whyMatters.modelUsed;
  results.push(whyMatters);

  const failed = results.filter(r => !r.ok).length;
  const text = results.map(r => `## ${r.heading}\n\n${r.ok ? r.text : `_Not written: ${r.gap}. The findings below are still valid — review them manually._`}`).join("\n\n")
    + (failed > 0 ? `\n\n---\n\n_Digest integrity: ${results.length - failed}/${results.length} sections written._` : "");

  return { text, modelUsed };
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
      const { createOrgTask, listOrgTasks, updateOrgTaskStatus } = await import("./org-tasks.js");
      const open = listOrgTasks({ role: "admin" }).filter(t => t.status !== "done");
      // Match titles DASH-INSENSITIVELY. The separator in this title drifted
      // from "-" to "—" at some point, so tasks written by an older build
      // stopped matching and dedup silently broke — the next run created a
      // fresh duplicate right beside the original. Four model-reliability
      // tasks sat in backlog for a week because of it.
      const normTitle = (s: string) => s.replace(/[\u2010-\u2015\u2212-]/g, "-").trim().toLowerCase();
      const openTitles = new Set(open.map(t => normTitle(t.title)));
      // Live = the finding is still actionable (its failure streak is still
      // ongoing — see deriveModelHealthFindings). Anything else is history.
      const liveKeys = new Set(modelHealth.filter(f => f.actionable && f.key).map(f => f.key!));
      // Auto-resolve. A model-reliability task whose finding is no longer
      // actionable is a false positive left standing — its underlying cause
      // was fixed days ago and nothing is failing now. Close it (audited, via
      // the normal status transition) instead of leaving an operator to
      // discover the admin backlog is full of already-remediated problems.
      for (const t of open) {
        const key = /model-reliability:(.+)$/i.exec(t.title)?.[1];
        if (!key || liveKeys.has(`model-reliability:${key}`)) continue;
        updateOrgTaskStatus(t.id, "done");
        console.log(`[innovation-scan] auto-resolved stale model-health task: ${t.title}`);
      }
      for (const f of modelHealth) {
        if (!f.actionable) continue;
        // The title (the dedup key) must stay STABLE across runs — it used to
        // be built from f.issue, which embeds the live failure count/percent
        // and so is a different string every day the rolling window shifts.
        // That defeated the openTitles check entirely: 7 near-duplicate
        // "gemma4:31b"/"meta/llama-3.3-70b-instruct" reliability tasks piled
        // up in backlog over a week (caught live 2026-09-30) because no two
        // days' titles ever matched. f.key (e.g. "model-reliability:<model>")
        // is the same every day; the live numbers still show up in `detail`.
        const title = `Innovation Scan: ${f.area} — ${f.key ?? f.issue}`.slice(0, 160);
        if (openTitles.has(normTitle(title))) continue;
        createOrgTask({ role: "admin", title, detail: `${f.issue}\n\n${f.recommendation}\n\nEvidence: ${f.evidence}`, priority: "high", createdBy: "daemon" });
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
  const SCAN_HOUR = Number(process.env.NAXION_INNOVATION_SCAN_HOUR ?? "8");
  return { last: lastInnovationScan(), nextFireAt: nextFireAt({ daysOfWeek: [], hour: SCAN_HOUR, minute: 0 }) };
}

// ─── Hourly scheduler — mirrors reflection.ts's exactly, offset by a few
// hours so the two nightly jobs don't compete for the LLM backend at once. ───
const ENGINE_NAME = "innovation-scan";
let lastRunDate: string | null = null;

// Best-effort push of the finished digest to Telegram — never throws, never
// blocks the scheduler. Silently no-ops if Telegram isn't connected (same
// "optional delivery" posture as schedules.ts's email delivery).
async function deliverToTelegram(result: InnovationScanResult): Promise<void> {
  try {
    const { sendTelegramMessage } = await import("./telegram-bridge.js");
    const { digestCard } = await import("./telegram-format.js");
    const niceDate = new Date(result.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const text = digestCard({
      icon: "🔭",
      title: `Innovation Scan — ${niceDate}`,
      meta: `✨ Naxie's morning scan · 🔧 ${result.targeted.length} weak spot(s) · 📦 ${result.broad.repos.length} repo(s) · 📰 ${result.broad.news.length} news`,
      body: result.digest.slice(0, 3300),
      vaultPath: result.path,
    });
    const r = await sendTelegramMessage(text);
    if (!r.ok) console.warn(`[innovation-scan] Telegram delivery skipped: ${r.error}`);
  } catch (e: any) { console.warn(`[innovation-scan] Telegram delivery failed: ${e?.message ?? e}`); }
}

export function startInnovationScanScheduler(): void {
  // Default 8 AM local — innovation scan fires at 8am. The todo brief (6am) and
  // daily reflection (8pm) are offset so they don't compete for the LLM backend
  // at once. They may still land in the same catch-up tick; that's fine, each
  // fires and delivers independently.
  const SCAN_HOUR = Number(process.env.NAXION_INNOVATION_SCAN_HOUR ?? "8");
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
  registerEngine({ name: ENGINE_NAME, intervalSeconds: 10 * 60, run: tick });
}

export function stopInnovationScanScheduler(): void {
  unregisterEngine(ENGINE_NAME);
}

// Stay tree-shake-friendly — referenced only when the route imports it.
void llmGenerate;
