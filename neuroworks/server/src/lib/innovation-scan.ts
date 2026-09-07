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
import { searchTrendingRepos } from "./github.js";
import type { FetchedSource, ValidatedSource } from "./source-validator-types.js";

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

// ─── Shared fetch/validate helper — mirrors research.deep's pipeline ───
async function searchFetchValidate(query: string, depth: number): Promise<{ kept: ValidatedSource[]; fetchedCount: number }> {
  const search = await searchWeb(query, depth).catch(() => ({ engine: "none", results: [], tried: [] }));
  const fetched: (FetchedSource & { title: string })[] = await Promise.all(
    search.results.map(async (w) => {
      try {
        const r = await smartFetch(w.url, { maxBytes: 60_000, timeoutMs: 8_000 });
        return {
          url: w.url,
          title: r.title ?? w.title,
          text: r.text.slice(0, 4_000),
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

  return { repos: repos.slice(0, 12), news };
}

// ─── 4. Synthesize the operator-facing digest ───
export async function synthesizeDigest(targeted: TargetedFinding[], broad: BroadWatch): Promise<{ text: string; modelUsed?: string }> {
  if (targeted.length === 0 && broad.repos.length === 0 && broad.news.length === 0) {
    return {
      text: `_Nothing to report yet. Once the system has run enough tasks to learn where it's weak, and/or the web is reachable, this scan will have real material to work with._`,
    };
  }

  const sys = `You are NeuroWorks's Innovation Scan writer. The operator is NOT deeply technical — plain language, no jargon dump, no wall of acronyms. Your job is to make two things clear: (1) how we're fixing our own weak spots, and (2) what's new and interesting in AI/tech this week.

Output sections — use these EXACT headings, nothing else:
## Fixing our weak spots
For EACH targeted finding, tie it back to the specific weakness that prompted it — say what's weak, then what the research suggests doing about it. Plain language. If there are no targeted findings, say plainly that nothing weak enough to chase was found.

## What's new and interesting
Digestible highlights from the trending repos and news findings — what it is and why it might matter to us, in plain terms. If there's nothing, say so.

Rules:
- No filler ("In today's fast-moving AI landscape..."). No emoji.
- Keep it skimmable — short paragraphs or bullets.
- Numbers/names always beat vague claims.`;

  const targetedBlock = targeted.length > 0
    ? targeted.map(t => `### Weakness: ${t.reason}\nResearch query: "${t.weaknessQuery}"\nFindings: ${t.summary}`).join("\n\n")
    : "_(no weaknesses identified this run — insufficient quality/bottleneck data yet)_";

  const reposBlock = broad.repos.length > 0
    ? broad.repos.map(r => `- ${r.fullName} (${r.stars}★) — ${r.description ?? "no description"} — ${r.url}`).join("\n")
    : "_(no trending repos found)_";

  const newsBlock = broad.news.length > 0
    ? broad.news.map(n => `### "${n.query}"\n${n.summary}`).join("\n\n")
    : "_(no news findings)_";

  const prompt = `## Targeted findings (our own weak spots)\n\n${targetedBlock}\n\n## Trending repos\n\n${reposBlock}\n\n## News findings\n\n${newsBlock}\n\nWrite the digest.`;

  const attemptSynthesis = async (): Promise<{ text: string; modelUsed?: string }> => {
    let lastErr: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const meta = await llmGenerateWithMeta(prompt, sys, { profile: "synthesis", complexity: "high" } as any);
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
      text: `_LLM digest synthesis failed after retry (\`${String(lastErr?.message ?? lastErr).slice(0, 100)}\`). The raw findings below are still valid — review them manually.\n\n## Fixing our weak spots\n${targetedBlock}\n\n## What's new and interesting\n${reposBlock}\n\n${newsBlock}`,
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
        text: `_LLM digest synthesis exceeded the ${mins}min cap and was abandoned so the scan wouldn't stall. The raw findings below are still valid.\n\n## Fixing our weak spots\n${targetedBlock}\n\n## What's new and interesting\n${reposBlock}\n\n${newsBlock}`,
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
  const header = `---
type: innovation-scan
date: ${result.date}
targetedCount: ${result.targeted.length}
repoCount: ${result.broad.repos.length}
newsCount: ${result.broad.news.length}
generated: ${result.generatedAt}
${result.modelUsed ? `model: ${result.modelUsed}\n` : ""}---

# Innovation Scan — ${result.date}

_${result.targeted.length} weak spot${result.targeted.length === 1 ? "" : "s"} investigated · ${result.broad.repos.length} trending repo${result.broad.repos.length === 1 ? "" : "s"} · ${result.broad.news.length} news finding${result.broad.news.length === 1 ? "" : "s"}_

`;
  const footer = `

---

<details><summary>Raw findings snapshot</summary>

\`\`\`json
${JSON.stringify({ targeted: result.targeted, broad: result.broad }, null, 2)}
\`\`\`

</details>
`;
  return header + result.digest.trim() + footer;
}

// ─── 6. Top-level orchestrator — mirrors reflection.ts's runReflection ───
export async function runInnovationScan(opts: { force?: boolean } = {}): Promise<InnovationScanResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const runStartedAtIso = new Date().toISOString();
    const weaknesses = identifyOwnWeaknesses();
    const [targeted, broad] = await Promise.all([
      runTargetedScan(weaknesses),
      runBroadWatch(),
    ]);
    const { text, modelUsed } = await synthesizeDigest(targeted, broad);
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

// ─── Hourly scheduler — mirrors reflection.ts's exactly, offset by a few
// hours so the two nightly jobs don't compete for the LLM backend at once. ───
let scheduler: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;

export function startInnovationScanScheduler(): void {
  if (scheduler) return;
  // Reflection defaults to hour 2; innovation scan defaults to hour 5 so the
  // two nightly LLM-heavy jobs don't overlap on a typical server.
  const SCAN_HOUR = Number(process.env.NEUROWORKS_INNOVATION_SCAN_HOUR ?? "5");
  const tick = async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (now.getHours() < SCAN_HOUR || lastRunDate === today) return;
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
    try { await runInnovationScan(); }
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
