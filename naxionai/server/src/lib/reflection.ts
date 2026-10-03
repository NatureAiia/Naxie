// Nightly self-reflection. Once a day, Naxie looks back at the
// tasks it ran in the last 24 hours, aggregates raw stats (success rates, slow
// steps, failure patterns, employee attribution, tool reliability), and asks
// the LLM to produce a structured reflection: what went well, what went
// wrong, what to try differently. The output lands in
// `_naxion/reflections/<YYYY-MM-DD>.md` as a daily journal entry the
// customer can read in their vault.
//
// This is the learning loop: stats + LLM synthesis + persisted insight. We
// don't auto-apply changes (that would surprise the customer), but the
// reflections accumulate over time and surface patterns the customer can
// act on — "tool X fails 40% of the time; switch to Y" — and that future
// agent runs can read via vault.search.

import { listJobs, type Job } from "./jobs.js";
import { writeVaultFile } from "./vault.js";
import { enqueueVaultCommit } from "./commit-queue.js";
import { llmGenerate } from "./llm.js";
import { loadJobsInWindow, asJob, type PersistedJob } from "./job-store.js";
import { config } from "../config.js";
import { gradeDecision, type DecisionGrade } from "./decision-grader.js";

const REFLECTION_DIR = "_naxion/reflections";

// Pulled stats — what the LLM reflects on. Kept structured so future tooling
// (charts, trend lines) can read the raw shape without re-parsing prose.
export type DailyStats = {
  date: string;            // YYYY-MM-DD, the day this reflection covers
  windowStart: string;     // ISO timestamp
  windowEnd: string;       // ISO timestamp
  totalTasks: number;
  succeeded: number;
  failed: number;
  rejected: number;
  cancelled: number;       // operator-cancelled runs — NOT counted as failures
  successRate: number;     // 0..1
  byKind: Record<string, { total: number; ok: number; failed: number }>;
  byTemplate: Record<string, { total: number; ok: number; failed: number; avgDurationSec: number }>;
  byPersona: Record<string, number>;
  byPeer: Record<string, number>;
  topFailures: { error: string; count: number; templates: string[] }[];
  slowestSteps: { tool: string; durationSec: number; jobId: string }[];
  toolStats: { tool: string; runs: number; ok: number; failed: number; avgDurationSec: number; failureRate: number }[];
  retries: { jobId: string; title?: string }[];
  // Continuation lineage — tasks that resumed from an earlier "needs context"
  // turn. Distinct from `retries` (which replay a failed task) because a
  // continuation ADDS context to a task that asked for it. Chains can be
  // multi-step (a → b → c where b continues a and c continues b); we record
  // each link so the reflection narrative can call out the longest chain
  // and the original ask that drove it.
  continuations: { jobId: string; title?: string; continuesJobId: string; summary?: string; originalText?: string }[];
  // Skill picker telemetry — surfaces which playbook guided each task and
  // how often picks correlated with success. Reflection uses this to spot
  // patterns like "skill X chosen N times but only succeeded M". Skills
  // with avgScore < 20 are keyword-only matches (no intent agreement),
  // which is the weakest signal the picker offers.
  skillStats: { skill: string; runs: number; ok: number; failed: number; successRate: number; avgScore: number }[];
};

export type ReflectionResult = {
  date: string;
  path: string;
  stats: DailyStats;
  reflection: string;       // markdown body
  generatedAt: string;
  modelUsed?: string;
  qualityGrade?: DecisionGrade; // model-free grade of `reflection` itself — see decision-grader.ts
};

let lastResult: ReflectionResult | null = null;
let inFlight: Promise<ReflectionResult> | null = null;

// Pull every job that falls inside the window.
//
// Sources, in this order of trust:
//   1. .naxion/jobs/<date>.jsonl — local disk, durable.
//   2. listJobs() in-memory cap — local jobs not yet flushed.
//   3. Each peer's /api/peers/jobs?since=&until= — the secondary's work
//      that a delegation routed there. Without this, the reflection
//      only sees what the primary handled and dramatically undercounts
//      fleet activity on busy days.
//
// Dedupe by id. Disk wins over memory wins over peers, since disk
// reflects FINAL status; in-memory may be mid-run; peer responses are a
// snapshot in time.
export async function collectJobsInWindow(windowStartMs: number, windowEndMs: number): Promise<Job[]> {
  const seen = new Set<string>();
  const out: Job[] = [];
  // LAST record per id wins. The journal is append-only: a job persists once
  // early (often mid-run, steps still placeholder) and again at completion.
  // Taking the FIRST record captured the early snapshot — so a finished run's
  // real steps were dropped and its mid-flight "0ms ok=false" placeholders
  // were counted as failures (the phantom "research.multiperspective fails at
  // 0s" in the tool stats). Collapse to the newest record per id, matching
  // how tasks.ts / templates.ts read the same journal.
  const latest = new Map<string, ReturnType<typeof loadJobsInWindow>[number]>();
  for (const rec of loadJobsInWindow(windowStartMs, windowEndMs)) latest.set(rec.id, rec);
  for (const rec of latest.values()) {
    if (seen.has(rec.id)) continue;
    seen.add(rec.id);
    out.push(asJob(rec));
  }
  for (const j of listJobs()) {
    if (seen.has(j.id)) continue;
    const t = j.startedAt ? new Date(j.startedAt).getTime() : 0;
    if (t < windowStartMs || t >= windowEndMs) continue;
    seen.add(j.id);
    out.push(j);
  }
  // Fan out to peers in parallel. 5s per-peer timeout — reflection runs
  // nightly, no rush, but we don't want one slow peer to stall the whole
  // pipeline. Errors are swallowed: a missing peer just means we
  // aggregate less, not that we crash the run.
  if (config.peers.length > 0) {
    const since = new Date(windowStartMs).toISOString();
    const until = new Date(windowEndMs).toISOString();
    const peerResults = await Promise.allSettled(
      config.peers.map(async (base) => {
        const url = `${base.replace(/\/+$/, "")}/api/peers/jobs?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5_000);
        try {
          const r = await fetch(url, { signal: ctrl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const data = (await r.json()) as { jobs?: PersistedJob[] };
          return data.jobs ?? [];
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    for (const r of peerResults) {
      if (r.status !== "fulfilled") continue;
      for (const rec of r.value) {
        if (seen.has(rec.id)) continue;
        seen.add(rec.id);
        out.push(asJob(rec));
      }
    }
  }
  return out;
}

export function aggregate(jobs: Job[], windowStartMs: number, windowEndMs: number): DailyStats {
  const date = new Date(windowStartMs).toISOString().slice(0, 10);
  const byKind: DailyStats["byKind"] = {};
  const byTemplate: Record<string, { total: number; ok: number; failed: number; totalSec: number }> = {};
  const byPersona: Record<string, number> = {};
  const byPeer: Record<string, number> = {};
  const failureBuckets: Record<string, { count: number; templates: Set<string> }> = {};
  const slowSteps: { tool: string; durationSec: number; jobId: string }[] = [];
  const toolBuckets: Record<string, { runs: number; ok: number; failed: number; totalSec: number }> = {};
  // Which templates each tool ran under — lets step-level tool failures feed
  // topFailures with template attribution (Fix 3). Without this, a failing
  // step inside an otherwise-succeeded job was invisible to the reflection.
  const toolTemplates: Record<string, Set<string>> = {};
  const retries: { jobId: string; title?: string }[] = [];
  const continuations: DailyStats["continuations"] = [];
  const skillBuckets: Record<string, { runs: number; ok: number; failed: number; totalScore: number }> = {};

  let succeeded = 0, failed = 0, rejected = 0, cancelled = 0;

  for (const j of jobs) {
    // Operator cancellations are stored as status="failed" (see jobs.cancelJob),
    // but they are NOT quality failures — counting them tanked the apparent
    // success rate and made general-task look like it "fails often" when 56% of
    // its failures were just cancels (live audit 2026-07-28). Treat them as a
    // separate `cancelled` bucket everywhere below.
    const isCancel = j.status === "failed" && /cancell?ed by the operator/i.test(String(j.error ?? ""));
    const k = j.kind ?? "unknown";
    byKind[k] = byKind[k] ?? { total: 0, ok: 0, failed: 0 };
    byKind[k].total++;
    if (j.status === "succeeded") { succeeded++; byKind[k].ok++; }
    else if (isCancel) { cancelled++; }
    else if (j.status === "failed") { failed++; byKind[k].failed++; }
    else if (j.status === "rejected") { rejected++; byKind[k].failed++; }

    const tpl = j.template ?? j.kind ?? "unknown";
    byTemplate[tpl] = byTemplate[tpl] ?? { total: 0, ok: 0, failed: 0, totalSec: 0 };
    byTemplate[tpl].total++;
    if (j.status === "succeeded") byTemplate[tpl].ok++;
    if (!isCancel && (j.status === "failed" || j.status === "rejected")) byTemplate[tpl].failed++;
    if (j.startedAt && j.finishedAt) {
      const sec = (new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 1000;
      byTemplate[tpl].totalSec += sec;
    }

    const r: any = j.result ?? {};
    // Persona attribution priority: the canonical job.personaName set at
    // dispatch (chat / team), then legacy result fields kept for back-
    // compat with old persisted records (pre-B5 fix).
    const personaName = (j as any).personaName
      ?? r.activePersona?.name
      ?? (j.inputs as any)?.activePersona?.name
      ?? r.persona?.name
      ?? r.peer?.name;
    if (personaName) byPersona[personaName] = (byPersona[personaName] ?? 0) + 1;
    const peerName = r.peer?.name;
    if (peerName) byPeer[peerName] = (byPeer[peerName] ?? 0) + 1;
    if ((j.inputs as any)?.retryOf) retries.push({ jobId: j.id, title: j.title });
    // Continuation lineage: when this job carries `continuesJobId` on its
    // inputs (set by chat.ts / team.ts when the user replied to a
    // "needs context" prompt), record the link so the report can re-stitch
    // the chain. We keep originalText short — a thumbnail of the original
    // ask — so the reflection narrative doesn't bloat with long bodies.
    const continuesJobId = (j.inputs as any)?.continuesJobId;
    if (typeof continuesJobId === "string" && continuesJobId.length > 0) {
      continuations.push({
        jobId: j.id,
        title: j.title,
        continuesJobId,
        summary: (j.inputs as any)?.continuesSummary,
        originalText: typeof (j.inputs as any)?.continuesOriginalText === "string"
          ? String((j.inputs as any).continuesOriginalText).slice(0, 200)
          : undefined,
      });
    }

    // Skill picker telemetry. We bucket every job that had a skill pick
    // — including failed ones — so the reflection can spot patterns like
    // "skill X chosen 12 times but only succeeded 4". avgScore tracks
    // how confident the picker was: < 20 means keyword-only, 20+ means
    // intent agreement, 30+ means both signals fired.
    const skill = typeof r.skillUsed === "string" ? r.skillUsed : undefined;
    if (skill) {
      skillBuckets[skill] = skillBuckets[skill] ?? { runs: 0, ok: 0, failed: 0, totalScore: 0 };
      skillBuckets[skill].runs++;
      if (j.status === "succeeded") skillBuckets[skill].ok++;
      else if (!isCancel && (j.status === "failed" || j.status === "rejected")) skillBuckets[skill].failed++;
      if (typeof r.skillScore === "number") skillBuckets[skill].totalScore += r.skillScore;
    }

    if (j.status === "failed" && j.error && !isCancel) {
      // Bucket failures by a normalised prefix so similar errors merge.
      const norm = j.error.slice(0, 80).replace(/\d+/g, "N").replace(/[a-f0-9]{8,}/gi, "<hash>");
      failureBuckets[norm] = failureBuckets[norm] ?? { count: 0, templates: new Set() };
      failureBuckets[norm].count++;
      failureBuckets[norm].templates.add(tpl);
    }

    // Count tool runs where they EXECUTED. A delegated task produces two job
    // records carrying the SAME runs array: the delegating side's job (which
    // mirrors the peer's runs back and sets r.peer) and the peer's own
    // peer:delegate record. Aggregating both doubled every delegated step —
    // 2026-07-11's reflection reported 2 × 124s research.deep runs (248s of
    // "wall time") for what was a single call, and flagged the tool's latency
    // off inflated numbers. Skip the mirrored copy (r.peer set); the peer's
    // own record — read from local disk for a managed worker, or fetched via
    // /api/peers/jobs for a remote one — supplies the single true count.
    const runs = !r.peer && Array.isArray(r.runs) ? r.runs : [];
    for (const run of runs) {
      const tool = run?.step?.tool ?? "unknown";
      toolTemplates[tool] = toolTemplates[tool] ?? new Set();
      toolTemplates[tool].add(tpl);
      toolBuckets[tool] = toolBuckets[tool] ?? { runs: 0, ok: 0, failed: 0, totalSec: 0 };
      toolBuckets[tool].runs++;
      if (run.ok) toolBuckets[tool].ok++;
      else toolBuckets[tool].failed++;
      const sec = (run.durationMs ?? 0) / 1000;
      toolBuckets[tool].totalSec += sec;
      if (sec >= 30) slowSteps.push({ tool, durationSec: Math.round(sec), jobId: j.id });
    }
  }

  // Merge step-level tool failures into the job-level buckets (Fix 3): a step
  // can fail (ok:false) while its parent job still lands "succeeded" (e.g. a
  // peer.review rejection that fell back to a draft), which previously left
  // topFailures empty despite toolStats showing failures.
  for (const [tool, v] of Object.entries(toolBuckets)) {
    if (v.failed <= 0) continue;
    const key = `tool:${tool} step failed ${v.failed}/${v.runs} runs`;
    failureBuckets[key] = failureBuckets[key] ?? { count: 0, templates: new Set() };
    failureBuckets[key].count += v.failed;
    for (const t of toolTemplates[tool] ?? []) failureBuckets[key].templates.add(t);
  }
  const topFailures = Object.entries(failureBuckets)
    .map(([error, v]) => ({ error, count: v.count, templates: [...v.templates] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  slowSteps.sort((a, b) => b.durationSec - a.durationSec);
  const toolStats = Object.entries(toolBuckets).map(([tool, v]) => ({
    tool,
    runs: v.runs,
    ok: v.ok,
    failed: v.failed,
    avgDurationSec: v.runs > 0 ? Math.round((v.totalSec / v.runs) * 10) / 10 : 0,
    failureRate: v.runs > 0 ? Math.round((v.failed / v.runs) * 100) / 100 : 0,
  })).sort((a, b) => b.runs - a.runs);
  const skillStats = Object.entries(skillBuckets).map(([skill, v]) => ({
    skill,
    runs: v.runs,
    ok: v.ok,
    failed: v.failed,
    successRate: v.runs > 0 ? Math.round((v.ok / v.runs) * 100) / 100 : 0,
    avgScore: v.runs > 0 ? Math.round((v.totalScore / v.runs) * 10) / 10 : 0,
  })).sort((a, b) => b.runs - a.runs);

  return {
    date,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    totalTasks: jobs.length,
    succeeded,
    failed,
    rejected,
    cancelled,
    // Success rate over ATTEMPTED runs — operator-cancelled runs are excluded
    // from the denominator so a busy operator cancelling runs doesn't read as
    // the agent failing.
    successRate: (jobs.length - cancelled) > 0 ? Math.round((succeeded / (jobs.length - cancelled)) * 100) / 100 : 0,
    byKind,
    byTemplate: Object.fromEntries(Object.entries(byTemplate).map(([t, v]) => [
      t,
      { total: v.total, ok: v.ok, failed: v.failed, avgDurationSec: v.total > 0 ? Math.round((v.totalSec / v.total) * 10) / 10 : 0 },
    ])),
    byPersona,
    byPeer,
    topFailures,
    slowestSteps: slowSteps.slice(0, 8),
    toolStats: toolStats.slice(0, 12),
    retries,
    continuations,
    skillStats: skillStats.slice(0, 12),
  };
}

// Ask the LLM to synthesize a reflection. Uses complexity:"normal" + capped
// maxTokens so the call routes to the fast tier (Fix 1): a daily digest does
// not need the large reasoning tier, and the large tier is what kept tripping
// the synthesis budget. When the LLM is unavailable, a deterministic
// heuristic digest lands instead — same headings, numbers-grounded.
async function synthesizeReflection(stats: DailyStats): Promise<{ text: string; modelUsed?: string }> {
  if (stats.totalTasks === 0) {
    return {
      text: `_No tasks ran on ${stats.date}. Nothing to reflect on yet — start a task in Chat and the next reflection will have material to work with._`,
    };
  }

  const sys = `You are Naxie's daily reflection writer. The operator runs AI employees and the agent fleet ran their tasks yesterday. Your job is to look at the raw stats and produce a HONEST, CONCISE reflection in markdown.

Output sections — use these EXACT headings:
## What went well
2-4 bullet points. Concrete wins from yesterday. Reference real numbers from the stats.

## What went wrong
2-4 bullet points. Real failure patterns. Name the tool, error, or template. If nothing went wrong, say so plainly — don't invent problems.

## What I notice
1-3 observations about how the system is being used. Tool preferences, persona patterns, peer load — whatever's interesting from the data.

## What to try next
2-4 specific, actionable changes the customer or the system could make. Each MUST be concrete (a tool to prefer, a config to flip, a persona to retire). Avoid vague advice like "improve quality".

Rules:
- Be terse. The customer reads this in 60 seconds.
- Numbers always. "Failed 4 of 6 runs" beats "often failed".
- No filler ("Overall, today was…"). No emoji.
- If the stats are thin, say so honestly — don't pad.
- avgDurationSec near 0 is NOT automatically suspicious: security.scan and
  governance.check are synchronous local pattern-matching (regex over the
  text), not network/LLM calls — sub-millisecond is their CORRECT, expected
  speed. Only flag near-zero duration as a possible no-op for tools that
  normally do I/O or an LLM call (db.*, research.*, web.*, ollama.generate,
  connector.call, email.send, etc.) where near-0s means something skipped
  the real work. (2026-07-09 reflection flagged security.scan as a possible
  no-op purely on its 0s average — verified against the source, it's a
  correctly-fast synchronous scanner, not a bug.)`;

  const prompt = `Date: ${stats.date}
Window: ${stats.windowStart} → ${stats.windowEnd}

## Raw stats

Total tasks: ${stats.totalTasks} (${stats.succeeded} succeeded, ${stats.failed} failed, ${stats.rejected} rejected${stats.cancelled ? `, ${stats.cancelled} cancelled by operator — not failures` : ""})
Success rate: ${(stats.successRate * 100).toFixed(0)}%

### By kind
${Object.entries(stats.byKind).map(([k, v]) => `- ${k}: ${v.total} (${v.ok} ok, ${v.failed} failed)`).join("\n") || "_(none)_"}

### By template
${Object.entries(stats.byTemplate).map(([t, v]) => `- ${t}: ${v.total} total, ${v.failed} failed, avg ${v.avgDurationSec}s`).join("\n") || "_(none)_"}

### Employees on the clock
${Object.entries(stats.byPersona).map(([p, n]) => `- ${p}: ${n} tasks`).join("\n") || "_(none recorded)_"}

### Peer attribution
${Object.entries(stats.byPeer).map(([p, n]) => `- ${p}: ${n} delegations`).join("\n") || "_(no delegations — all local)_"}

### Top failures
${stats.topFailures.map(f => `- "${f.error}" — ${f.count}x (templates: ${f.templates.join(", ")})`).join("\n") || "_(no failures)_"}

### Slowest steps
${stats.slowestSteps.map(s => `- ${s.tool} — ${s.durationSec}s (job ${s.jobId.slice(0, 8)})`).join("\n") || "_(no slow steps)_"}

### Tool reliability
${stats.toolStats.map(t => `- ${t.tool}: ${t.runs} runs, ${(t.failureRate * 100).toFixed(0)}% failure rate, avg ${t.avgDurationSec}s`).join("\n") || "_(no tool runs)_"}

### Skill picker correlations
${stats.skillStats.length > 0
  ? stats.skillStats.map(s => `- ${s.skill}: ${s.runs} runs (${s.ok} ok, ${s.failed} failed) — ${(s.successRate * 100).toFixed(0)}% success, avg picker score ${s.avgScore} (${s.avgScore >= 30 ? "intent + keyword" : s.avgScore >= 20 ? "intent only" : "keyword only — weak match"})`).join("\n")
  : "_(no skill picks recorded)_"}
${stats.skillStats.some(s => s.runs >= 3 && s.successRate < 0.5) ? "_Note: at least one skill has 3+ runs and a sub-50% success rate — investigate whether the playbook needs revision or the picker is misrouting._" : ""}

${stats.retries.length > 0 ? `### Retried tasks\n${stats.retries.map(r => `- ${r.title ?? r.jobId} (${r.jobId.slice(0, 8)})`).join("\n")}` : ""}

${stats.continuations.length > 0 ? `### Continuation chains _(tasks that picked up an earlier ask after the user supplied missing context)_\n${stats.continuations.map(c => `- **${c.summary ?? c.title ?? c.jobId.slice(0,8)}** — continues \`${c.continuesJobId.slice(0,8)}\`${c.originalText ? `\n    > _Original ask: ${c.originalText.replace(/\s+/g," ").trim().slice(0,140)}${c.originalText.length > 140 ? "…" : ""}_` : ""}`).join("\n")}` : ""}

Write the reflection. Honest, terse, numerically grounded.`;

  // Overall wall-clock budget for the synthesis (Fix 1 root cause: the old
  // code passed the FULL 8-min budget as each attempt's per-call timeout AND
  // raced the whole thing against the same 8-min cap with complexity:"high"
  // forcing the slowest large-tier model — so attempt 1 alone could consume
  // the cap and the retry never had room to succeed).
  const rawReflectionTimeoutMs = Number(process.env.NAXION_REFLECTION_SYNTH_TIMEOUT_MS ?? String(8 * 60_000));
  const SYNTH_TIMEOUT_MS = Math.max(60_000, Number.isFinite(rawReflectionTimeoutMs) ? rawReflectionTimeoutMs : 8 * 60_000);
  // Two attempts must fit inside the cap with a 2s backoff between them.
  const PER_ATTEMPT_MS = Math.max(60_000, Math.floor((SYNTH_TIMEOUT_MS - 5_000) / 2));

  // Single retry before falling back. Uses complexity:"normal" + a bounded
  // maxTokens so the call routes to the fast tier instead of the large model
  // (Fix 1) — a daily digest does not need the heaviest reasoning tier, and
  // the large tier is what kept tripping the cap on 2026-09-27/28.
  const attemptSynthesis = async (): Promise<{ text: string; modelUsed?: string }> => {
    let lastErr: any;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const meta = await import("./llm.js").then(m => m.llmGenerateWithMeta(prompt, sys, { profile: "synthesis", complexity: "normal", maxTokens: 1500, timeoutMs: PER_ATTEMPT_MS } as any));
        if (attempt > 0) {
          console.log(`[reflection] LLM call succeeded on retry`);
        }
        return { text: meta.text.trim(), modelUsed: meta.model };
      } catch (e: any) {
        lastErr = e;
        if (attempt === 0) {
          const msg = String(e?.message ?? e).slice(0, 100);
          console.warn(`[reflection] LLM call failed (${msg}) — retrying once in 2s`);
          await new Promise(r => setTimeout(r, 2_000));
          continue;
        }
      }
    }
    // Fallback: deterministic heuristic digest so the file still lands WITH
    // insight (Fix 2), not a "review manually" stub.
    return { text: await buildHeuristicFallback(stats, `LLM synthesis failed after retry (\`${String(lastErr?.message ?? lastErr).slice(0, 100)}\`)`) };
  };

  // Race the synthesis against the single budget so a wedged backend costs
  // minutes, not hours; the heuristic fallback still lands a usable file.
  // The abandoned attemptSynthesis() promise keeps running against its own
  // per-call caps in the background — harmless for a nightly job — but the
  // reflection RUN no longer waits on it.
  const capReason = `LLM synthesis exceeded its ${Math.round(SYNTH_TIMEOUT_MS / 60_000)}min budget on ${stats.date} (per-attempt cap ${Math.round(PER_ATTEMPT_MS / 1000)}s, complexity:normal, 1 retry)`;
  let capTimer: NodeJS.Timeout | undefined;
  const cap = new Promise<{ text: string; modelUsed?: string }>((resolve) => {
    capTimer = setTimeout(() => {
      console.warn(`[reflection] synthesis exceeded budget — writing heuristic fallback`);
      void buildHeuristicFallback(stats, capReason).then(text => resolve({ text }));
    }, SYNTH_TIMEOUT_MS);
    if (typeof capTimer.unref === "function") capTimer.unref();
  });
  try {
    return await Promise.race([attemptSynthesis(), cap]);
  } finally {
    if (capTimer) clearTimeout(capTimer);
  }
}

// Templates averaging at or above this are flagged as perf bottlenecks (Fix 4).
const PERF_BUDGET_SEC = 600;

export function slowTemplatesOf(stats: DailyStats) {
  return Object.entries(stats.byTemplate)
    .map(([template, v]) => ({ template, avgDurationSec: v.avgDurationSec, total: v.total, failed: v.failed }))
    .filter(t => t.avgDurationSec >= PERF_BUDGET_SEC)
    .sort((a, b) => b.avgDurationSec - a.avgDurationSec);
}

// Day-over-day deltas from the last few landed reflection files (Fix 5).
// Best-effort: unparsable/missing history yields an empty list, never a throw.
export async function trendLines(excludeDate: string, take = 3): Promise<string[]> {
  try {
    const { existsSync, readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(config.vaultPath, REFLECTION_DIR);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && !f.startsWith(excludeDate))
      .sort()
      .slice(-take);
    const out: string[] = [];
    for (const f of files) {
      try {
        const raw = readFileSync(join(dir, f), "utf8");
        const fm = raw.match(/^---\n([\s\S]*?)\n---/);
        const total = fm?.[1].match(/^totalTasks:\s*(\d+)/m)?.[1] ?? "?";
        const rate = fm?.[1].match(/^successRate:\s*([\d.]+)/m)?.[1];
        const pct = rate !== undefined ? `${Math.round(Number(rate) * 100)}% success` : "rate n/a";
        out.push(`- ${f.slice(0, 10)}: ${total} tasks, ${pct}`);
      } catch { /* one bad file must not kill the trend */ }
    }
    return out;
  } catch { return []; }
}

// Deterministic, numbers-grounded digest used when the LLM is unavailable
// (Fixes 2 + 6). Same four headings the lessons extractor looks for, so the
// lessons loop keeps working on fallback nights; copy names the date, the
// reason, and concrete next steps instead of a stale incident reference.
export async function buildHeuristicFallback(stats: DailyStats, reason: string): Promise<string> {
  const pct = Math.round(stats.successRate * 100);
  const slow = slowTemplatesOf(stats);
  const weakSkills = stats.skillStats.filter(s => s.avgScore < 20);
  const failingTools = [...stats.toolStats].sort((a, b) => b.failureRate - a.failureRate).filter(t => t.failed > 0);
  const trends = await trendLines(stats.date);
  const trendAvg = trends.length
    ? (trends.map(t => Number(t.match(/(\d+) tasks/)?.[1] ?? NaN)).filter(Number.isFinite) as number[])
    : [];
  const avgVol = trendAvg.length ? Math.round(trendAvg.reduce((a, b) => a + b, 0) / trendAvg.length) : null;

  const well: string[] = [];
  well.push(`Held a ${pct}% success rate across ${stats.totalTasks} tasks (${stats.succeeded} ok, ${stats.failed} failed, ${stats.rejected} rejected${stats.cancelled ? `, ${stats.cancelled} operator-cancelled` : ""}).`);
  if (stats.topFailures.length === 0) well.push(`Zero recorded failures at job or step level — clean night.`);
  else if (stats.failed === 0 && stats.rejected === 0) well.push(`Zero job-level failures — the ${stats.topFailures.length} flagged item(s) are step-level issues inside otherwise-succeeded jobs.`);
  const busiest = Object.entries(stats.byTemplate).sort((a, b) => b[1].total - a[1].total)[0];
  if (busiest) well.push(`Busiest template \`${busiest[0]}\`: ${busiest[1].total} runs, ${busiest[1].failed} failed.`);

  const wrong: string[] = [];
  for (const f of stats.topFailures.slice(0, 4)) {
    wrong.push(`"${f.error}" — ${f.count}x (templates: ${f.templates.join(", ") || "n/a"}).`);
  }
  for (const s of slow) {
    wrong.push(`\`${s.template}\` averaged ${s.avgDurationSec}s over ${s.total} run(s) — over the ${PERF_BUDGET_SEC}s perf budget.`);
  }
  for (const sk of weakSkills.slice(0, 3)) {
    wrong.push(`Skill picker weak on \`${sk.skill}\`: avg score ${sk.avgScore} (keyword-only) over ${sk.runs} run(s).`);
  }
  if (wrong.length === 0) wrong.push(`No failures, slow templates, or weak skill picks recorded — quiet night.`);

  const notice: string[] = [];
  if (avgVol !== null) {
    const delta = stats.totalTasks - avgVol;
    notice.push(`Volume ${stats.totalTasks} vs trailing avg ${avgVol} (${delta >= 0 ? "+" : ""}${delta}) across ${trends.length} prior night(s).`);
  } else {
    notice.push(`No prior reflection history to trend against yet.`);
  }
  const topPersona = Object.entries(stats.byPersona).sort((a, b) => b[1] - a[1])[0];
  if (topPersona) notice.push(`Persona concentration: \`${topPersona[0]}\` handled ${topPersona[1]}/${stats.totalTasks} tasks.`);
  else notice.push(`No persona attribution recorded — attribution may be missing on these jobs.`);
  if (Object.keys(stats.byPeer).length === 0) notice.push(`No peer delegations — all work ran locally.`);
  if (stats.continuations.length > 0) notice.push(`${stats.continuations.length} continuation chain(s) — users supplying follow-up context mid-task.`);
  if (stats.retries.length > 0) notice.push(`${stats.retries.length} retried task(s).`);

  const next: string[] = [];
  if (slow.length > 0) next.push(`Split \`${slow[0].template}\` into parallel sub-agents or trim its heaviest steps — it is the fleet bottleneck at ~${Math.round(slow[0].avgDurationSec / 60)} min/run.`);
  if (failingTools.length > 0) next.push(`Investigate tool \`${failingTools[0].tool}\`: ${failingTools[0].failed}/${failingTools[0].runs} step runs failed — check its error output before the next scheduled run.`);
  if (weakSkills.length > 0) next.push(`Enrich the \`${weakSkills[0].skill}\` skill metadata (intent phrases) so the picker stops matching on keywords alone.`);
  next.push(`Re-run \`POST /api/reflection/run\` once the LLM backend is healthy to replace this deterministic digest with a full synthesis.`);
  if (next.length > 4) next.length = 4;

  const sections = [
    `_Deterministic digest for ${stats.date} — ${reason}. Computed directly from run stats with no model involved._`,
    ``,
    `## What went well`,
    ...well.map(b => `- ${b}`),
    ``,
    `## What went wrong`,
    ...wrong.map(b => `- ${b}`),
    ``,
    `## What I notice`,
    ...notice.map(b => `- ${b}`),
    ``,
    `## What to try next`,
    ...next.map(b => `- ${b}`),
    ``,
    `## Trend (prior nights)`,
    ...(trends.length > 0 ? trends : [`- _(no prior reflections on disk)_`]),
  ];
  if (slow.length > 0) {
    sections.push(
      ``,
      `## Bottlenecks (≥${PERF_BUDGET_SEC}s avg)`,
      ...slow.map(s => `- \`${s.template}\`: avg ${s.avgDurationSec}s × ${s.total} run(s), ${s.failed} failed — over budget, candidate for parallelisation.`),
    );
  }
  return sections.join("\n");
}

function renderMarkdown(result: { stats: DailyStats; text: string; generatedAt: string; modelUsed?: string }): string {
  const s = result.stats;
  const header = `---
type: reflection
date: ${s.date}
totalTasks: ${s.totalTasks}
successRate: ${s.successRate}
continuationChains: ${s.continuations.length}
retries: ${s.retries.length}
generated: ${result.generatedAt}
${result.modelUsed ? `model: ${result.modelUsed}\n` : "synthesis: heuristic-fallback\n"}---

# Daily reflection — ${s.date}

_${s.totalTasks} tasks · ${s.succeeded} succeeded · ${s.failed} failed · ${(s.successRate * 100).toFixed(0)}% success rate · ${s.continuations.length} continuation${s.continuations.length === 1 ? "" : "s"} · ${s.retries.length} ${s.retries.length === 1 ? "retry" : "retries"}_

`;
  const footer = `

---

<details><summary>Raw stats snapshot</summary>

\`\`\`json
${JSON.stringify(s, null, 2)}
\`\`\`

</details>
`;
  return header + result.text.trim() + footer;
}

// Run the reflection NOW. Idempotent across concurrent calls — a second
// invocation while one's in flight returns the same promise. Result is
// cached in `lastResult` for the /api endpoint.
export async function runReflection(opts: { windowHours?: number; force?: boolean } = {}): Promise<ReflectionResult> {
  if (inFlight) return inFlight;
  const windowHours = opts.windowHours ?? 24;
  const windowEndMs = Date.now();
  const windowStartMs = windowEndMs - windowHours * 3600_000;
  inFlight = (async () => {
    // Capture the true start so the registered Job carries a real duration.
    // newJob() stamps startedAt at CREATION time — but the reflection job is
    // registered AFTER the work finishes, so startedAt≈finishedAt and every
    // reflection:daily showed ~0s ("timing blind spot" in the 07-03 report).
    const runStartedAtIso = new Date().toISOString();
    // Peer fan-out makes collectJobsInWindow async; resolve inside the
    // promise so concurrent runReflection() callers share the same
    // peer-fetch wave rather than each issuing their own.
    const jobs = await collectJobsInWindow(windowStartMs, windowEndMs);
    const stats = aggregate(jobs, windowStartMs, windowEndMs);
    const { text, modelUsed } = await synthesizeReflection(stats);
    // Grade the synthesized reflection BEFORE it's persisted/delivered as
    // final (decision-grader.ts) — model-free, so this never adds latency or
    // an extra LLM call. Non-blocking: a bad grade still lands the reflection
    // (this is a nightly informational report, not a user-facing gate), but
    // a fail is worth knowing about — e.g. a "What to try next" section that
    // never got past "consider improving quality" (the exact failure mode
    // the synth prompt above already tries to forbid).
    const qualityGrade = gradeDecision(text);
    if (qualityGrade.verdict === "fail") {
      console.warn(`[reflection] decision-quality grade FAILED for ${stats.date}: ${qualityGrade.summary}`);
    }
    const generatedAt = new Date().toISOString();
    const path = `${REFLECTION_DIR}/${stats.date}.md`;
    const body = renderMarkdown({ stats, text, generatedAt, modelUsed });
    try {
      writeVaultFile(path, body);
      // Best-effort commit — the queue handles serialisation and the journal
      // gets the same fate as any other vault write.
      void enqueueVaultCommit(`chore(reflection): daily reflection for ${stats.date}`);
    } catch (e: any) {
      console.warn(`[reflection] write failed: ${e?.message ?? e}`);
    }
    // Reflection → lessons loop. We extract the "What to try next" /
    // "What went wrong" sections and append them to _governance/lessons.md
    // which loadGovernancePrefix() prepends to every agent system prompt.
    // This is the actual mechanism that makes reflections IMPROVE the
    // system: yesterday's findings become today's hard rules. Cap kept
    // at the last 30 days of lessons so the prefix doesn't grow unbounded.
    try {
      const { writeLessonsFromReflection } = await import("./reflection-lessons.js");
      writeLessonsFromReflection(stats.date, text);
    } catch (e: any) {
      console.warn(`[reflection] lessons sync failed: ${e?.message ?? e}`);
    }
    // Reflection → structured bottleneck index (Feature B). Same failure/timing
    // data, but written as a machine-readable index the PLANNER reads at plan
    // time (bottleneckHintFor) — so a task type that keeps failing at X gets a
    // concrete "avoid X, do Y" directive on its next run, not just prose in the
    // synth prompt.
    try {
      const { updateBottlenecksFromStats, noteSlowTemplates } = await import("./reflection-bottlenecks.js");
      updateBottlenecksFromStats(stats);
      // Slow-but-green templates also enter the planner-visible index (Fix 4).
      noteSlowTemplates(stats.date, slowTemplatesOf(stats));
    } catch (e: any) {
      console.warn(`[reflection] bottleneck index update failed (non-fatal): ${e?.message ?? e}`);
    }
    // Reflection -> living persona profiles. Only personas that actually ran
    // a task today get considered (stats.byPersona) — see persona-profile.ts.
    try {
      const { maybeUpdatePersonaProfiles } = await import("./persona-profile.js");
      await maybeUpdatePersonaProfiles(stats.byPersona, text);
    } catch (e: any) {
      console.warn(`[reflection] persona profile update failed (non-fatal): ${e?.message ?? e}`);
    }
    const result: ReflectionResult = { date: stats.date, path, stats, reflection: text, generatedAt, modelUsed, qualityGrade };
    lastResult = result;
    // Surface the reflection on the Calendar by registering a Job record.
    // /api/calendar/activity reads from listJobs() + the persisted journal;
    // without a Job entry the daily reflection wouldn't appear next to the
    // operator's other activity for the day. Tagged with kind=reflection:daily
    // so the Calendar's filter can pick it out.
    try {
      const { newJob } = await import("./jobs.js");
      const { persistJobRecord } = await import("./job-store.js");
      const j = newJob(`reflection:daily`);
      j.title = `Daily reflection — ${stats.date} (${stats.totalTasks} tasks, ${Math.round(stats.successRate * 100)}% success)`;
      j.status = "succeeded";
      j.startedAt = runStartedAtIso;
      j.finishedAt = generatedAt;
      j.result = {
        answer: text,
        plan: { summary: `Reflection over ${windowHours}h window` },
        stats,
        reflectionPath: path,
        qualityGrade,
      };
      try { persistJobRecord(j); } catch { /* tolerate */ }
    } catch (e: any) {
      console.warn(`[reflection] job registration failed: ${e?.message ?? e}`);
    }
    return result;
  })();
  try { return await inFlight; }
  finally { inFlight = null; }
}

export function lastReflection(): ReflectionResult | null {
  return lastResult;
}

// Bundles the last result with a computed next-fire time (same env var/default
// as the scheduler below) so the Daily Rhythm view can show this daemon
// alongside user Schedules without duplicating the scheduler itself.
export async function reflectionStatus(): Promise<{ last: ReflectionResult | null; nextFireAt: number | null }> {
  const { nextFireAt } = await import("./schedules.js");
  const REFLECTION_HOUR = Number(process.env.NAXION_REFLECTION_HOUR ?? "20");
  return { last: lastReflection(), nextFireAt: nextFireAt({ daysOfWeek: [], hour: REFLECTION_HOUR, minute: 0 }) };
}

// Hourly tick. Fires the reflection once a day at REFLECTION_HOUR (default 2
// AM local). We use setInterval (1h) plus a "have we run today?" guard so a
// long-running server only runs the reflection once per day even if the
// scheduler fires at non-precise intervals.
let scheduler: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;

// Best-effort push of the finished reflection to Telegram — never throws,
// never blocks the scheduler. Silently no-ops if Telegram isn't connected
// (same "optional delivery" posture as schedules.ts's email delivery).
// 8pm push also includes tomorrow's preview (item 3).
async function getTomorrowPreview(): Promise<string> {
  try {
    const { existsSync, readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const storePath = resolve(__dirname, "../../../.naxion/my-tasks.json");
    if (!existsSync(storePath)) return "";
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    const items: any[] = Array.isArray(parsed?.items) ? parsed.items : [];
    const lists: any[] = Array.isArray(parsed?.lists) ? parsed.lists : [];
    const open = items.filter((x: any) => !x.completed);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const ymd = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,"0")}-${String(tomorrow.getDate()).padStart(2,"0")}`;
    const nice = tomorrow.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    const dueTomorrow = open.filter((x: any) => x.dueDate === ymd);
    if (!dueTomorrow.length) return `\n\n---\n\n## 🔮 Tomorrow — ${nice}\n_No tasks due tomorrow — clear runway!_`;
    const lines = dueTomorrow.slice(0, 8).map((t: any) => {
      const l = lists.find((x: any) => x.id === t.listId)?.name ?? "Tasks";
      return `- ☐ **${String(t.title).slice(0,90)}**${t.important ? " ⭐" : ""} \`${l}\``;
    }).join("\n");
    const more = dueTomorrow.length > 8 ? `\n_…+${dueTomorrow.length-8} more_` : "";
    return `\n\n---\n\n## 🔮 Tomorrow — ${nice} · ${dueTomorrow.length} task${dueTomorrow.length===1?"":"s"}\n\n${lines}${more}`;
  } catch { return ""; }
}
async function deliverToTelegram(result: ReflectionResult): Promise<void> {
  try {
    const { sendTelegramMessage } = await import("./telegram-bridge.js");
    const s = result.stats;
    const niceDate = new Date(s.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const header = `🌙 *Daily Reflection — ${niceDate}*\n📊 ${s.totalTasks} task(s): ✅ ${s.succeeded} ok · ❌ ${s.failed} failed · 🚫 ${s.rejected} rejected (${Math.round(s.successRate * 100)}% success)`;
    const preview = await getTomorrowPreview();
    const text = `${header}\n\n${result.reflection.slice(0, 2800)}${preview.slice(0, 900)}\n\n— _Full report in vault: ${result.path}_`;
    const r = await sendTelegramMessage(text);
    if (!r.ok) console.warn(`[reflection] Telegram delivery skipped: ${r.error}`);
  } catch (e: any) { console.warn(`[reflection] Telegram delivery failed: ${e?.message ?? e}`); }
}

export function startReflectionScheduler(): void {
  if (scheduler) return;
  // Default 8 PM local — end-of-day reflection for *that day's* report (user
  // request 2026-09-12). Innovation scan stays at 8am; todo brief at 6am.
  // They are offset so they don't compete for the LLM backend at once.
  const REFLECTION_HOUR = Number(process.env.NAXION_REFLECTION_HOUR ?? "20");
  const tick = async () => {
    const now = new Date();
    // LOCAL date — toISOString() is UTC and put late-evening runs on the wrong
    // day for any non-UTC timezone (same off-by-one the Calendar had).
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (now.getHours() < REFLECTION_HOUR || lastRunDate === today) return;
    // CATCH-UP, not exact-hour: the old `getHours() === REFLECTION_HOUR` guard
    // silently skipped any night the server was down at 2 AM — which is exactly
    // when a locally-run server is most likely to be off (2026-06-10/11 were
    // lost this way). Now any tick after the reflection hour runs it, once per
    // day, with the on-disk note as the restart-proof guard.
    try {
      const { existsSync, readdirSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { config } = await import("../config.js");
      const dir = join(config.vaultPath, REFLECTION_DIR);
      // Restart-proof guard: skip if ANY reflection file was WRITTEN today.
      // The old check looked for `${today}.md`, but reflections are NAMED by
      // the window's stats.date (usually yesterday) — so the file never
      // matched and every tsx-watch restart after the reflection hour fired
      // another run (5 duplicates on 2026-07-04). mtime is the honest
      // "did we already reflect today" signal and also respects a manual
      // "Reflect now" earlier in the day.
      if (existsSync(dir)) {
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const ranToday = readdirSync(dir).some(f => {
          if (!f.endsWith(".md")) return false;
          try { return statSync(join(dir, f)).mtimeMs >= midnight; } catch { return false; }
        });
        if (ranToday) { lastRunDate = today; return; }
      }
    } catch { /* vault unreachable — fall through; runReflection will surface it */ }
    lastRunDate = today;
    console.log(`[reflection] firing daily reflection (hour>=${REFLECTION_HOUR}, catch-up)`);
    try {
      const result = await runReflection();
      void deliverToTelegram(result);
    }
    catch (e: any) { console.warn(`[reflection] scheduler run failed: ${e?.message ?? e}`); }
  };
  // Check every 10 minutes; with catch-up the precise boot time no longer matters.
  scheduler = setInterval(tick, 10 * 60_000);
  void tick(); // also check immediately on boot
}

export function stopReflectionScheduler(): void {
  if (scheduler) { clearInterval(scheduler); scheduler = null; }
}

// Stay tree-shake-friendly — referenced only when the route imports it.
void llmGenerate;
