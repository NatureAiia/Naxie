// Weekly Self-Improvement Review ("Weekly Reflect") — Sundays, after the
// weekly rollup. Where the daily reflection (reflection.ts) looks at one day
// of jobs and writes lessons, this looks at the WHOLE system over the week —
// reflections, innovation scans, job/tool stats, schedules, background
// engines, MCP servers, retrieval health — and asks: what schedules, code
// improvements, MCP servers, CLI tools or skills should Naxie have, and how
// exactly would we build each one?
//
// Every proposal becomes an OrgTask (role "improver") parked in
// waiting-on-approval. NOTHING auto-applies: approving a proposal runs
// applyImprovementProposal(), which creates the schedule, queues the reindex,
// registers the MCP server (disabled), or hands the code change to the
// architect — whose diff is its own separate approval.
//
// Vault: _neuroworks/weekly-improvements/YYYY-MM-DD.md — Telegram + email optional.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeVaultFile } from "./vault.js";
import {
  createOrgTask, requestApproval, getOrgTask, listOrgTasks, updateOrgTaskStatus,
  type ImprovementKind, type ImprovementProposal, type OrgTask,
} from "./org-tasks.js";
import { readRagTelemetry, summarizeRagTelemetry, type RagTelemetrySummary } from "./rag-telemetry.js";

const REVIEW_DIR = "_neuroworks/weekly-improvements";
const WINDOW_DAYS = 7;
const MAX_PROPOSALS = 8;
const KINDS: readonly ImprovementKind[] = ["schedule", "code", "mcp", "cli", "skill", "retrieval", "other"];

function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── evidence ─────────────────────────────────────────────────────────────

export type ImprovementEvidence = {
  windowStart: string;
  windowEnd: string;
  jobs: { total: number; succeeded: number; failed: number; successRate: number; topFailures: string[]; weakTools: string[]; weakSkills: string[] };
  reflections: { file: string; excerpt: string }[];
  lessons: string;
  scans: { file: string; excerpt: string }[];
  weaknesses: string[];
  schedules: string[];
  engines: string[];
  mcpServers: string[];
  mcpCatalog: string[];
  templates: string[];
  retrieval: RagTelemetrySummary;
  index: { docs: number; ageHours: number };
  priorProposals: { title: string; status: string }[];
};

function readExcerpt(abs: string, max: number): string {
  try {
    const raw = readFileSync(abs, "utf8").replace(/^---[\s\S]*?---\s*/, "");
    return raw.length > max ? raw.slice(0, max) + "\n…" : raw;
  } catch { return ""; }
}

function datedFilesInWindow(dir: string, start: string, end: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.endsWith(".md") && f.slice(0, 10) >= start && f.slice(0, 10) <= end).sort();
  } catch { return []; }
}

export async function gatherEvidence(now = new Date()): Promise<ImprovementEvidence> {
  const endMs = now.getTime();
  const startMs = endMs - WINDOW_DAYS * 86_400_000;
  const start = localYmd(new Date(startMs));
  const end = localYmd(now);
  let vaultPath = "";
  try { const { config } = await import("../config.js"); vaultPath = config.vaultPath; } catch { /* no vault */ }

  const ev: ImprovementEvidence = {
    windowStart: new Date(startMs).toISOString(),
    windowEnd: now.toISOString(),
    jobs: { total: 0, succeeded: 0, failed: 0, successRate: 0, topFailures: [], weakTools: [], weakSkills: [] },
    reflections: [], lessons: "", scans: [], weaknesses: [], schedules: [], engines: [],
    mcpServers: [], mcpCatalog: [], templates: [],
    retrieval: summarizeRagTelemetry(readRagTelemetry(startMs)),
    index: { docs: 0, ageHours: -1 },
    priorProposals: [],
  };

  // Every source below is best-effort: a missing module, file or store just
  // leaves that slice empty rather than failing the whole review.
  try {
    const { collectJobsInWindow, aggregate } = await import("./reflection.js");
    const s = aggregate(await collectJobsInWindow(startMs, endMs), startMs, endMs);
    ev.jobs = {
      total: s.totalTasks, succeeded: s.succeeded, failed: s.failed, successRate: s.successRate,
      topFailures: s.topFailures.slice(0, 6).map(f => `${f.count}× ${f.error.slice(0, 140)} (templates: ${f.templates.slice(0, 3).join(", ")})`),
      weakTools: s.toolStats.filter(t => t.runs >= 3 && t.failureRate >= 0.2).slice(0, 8)
        .map(t => `${t.tool}: ${t.failed}/${t.runs} failed, avg ${t.avgDurationSec.toFixed(1)}s`),
      weakSkills: s.skillStats.filter(k => k.runs >= 2 && k.successRate < 0.7).slice(0, 6)
        .map(k => `${k.skill}: ${k.ok}/${k.runs} ok`),
    };
  } catch { /* job journal unavailable */ }

  if (vaultPath) {
    const refDir = join(vaultPath, "_neuroworks/reflections");
    ev.reflections = datedFilesInWindow(refDir, start, end).slice(-7)
      .map(f => ({ file: f, excerpt: readExcerpt(join(refDir, f), 1200) }));
    const scanDir = join(vaultPath, "_neuroworks/innovation-scans");
    ev.scans = datedFilesInWindow(scanDir, start, end).slice(-3)
      .map(f => ({ file: f, excerpt: readExcerpt(join(scanDir, f), 1000) }));
    ev.lessons = readExcerpt(join(vaultPath, "_governance/learned-from-reflections.md"), 1500);
  }

  try {
    const { identifyOwnWeaknesses } = await import("./innovation-scan.js");
    ev.weaknesses = identifyOwnWeaknesses().map(w => `${w.scope}:${w.key} — ${w.reason}`);
  } catch { /* quality signals unavailable */ }

  try {
    const { listSchedules } = await import("./schedules.js");
    ev.schedules = listSchedules().map(s =>
      `${s.name} [${s.templateId}] ${s.enabled ? "on" : "off"} days=${s.cadence.daysOfWeek.join(",") || "daily"} ${String(s.cadence.hour).padStart(2, "0")}:${String(s.cadence.minute).padStart(2, "0")}${s.lastError ? ` lastError="${s.lastError.slice(0, 80)}"` : ""}`);
  } catch { /* schedules store unavailable */ }

  try {
    const { listEngines } = await import("./scheduler-registry.js");
    ev.engines = listEngines().map(e => `${e.name} every ${e.intervalSeconds}s${e.lastError ? ` lastError="${e.lastError.slice(0, 80)}"` : ""}`);
    ev.engines.push(
      "built-in: daily reflection 20:00, innovation scan 08:00, system audit 07:00, todo brief 06:00, weekly rollup Sun 09:00, weekly board Mon 08:00, wiki compile 03:00, weekly self-improvement (this job)",
    );
    const { getDaemonSettings } = await import("./daemon-settings.js");
    const disabled = getDaemonSettings().disabledLoops;
    if (disabled.length) ev.engines.push(`org-daemon loops disabled by operator: ${disabled.join(", ")}`);
  } catch { /* registry unavailable */ }

  try {
    const { listMcpServers } = await import("./mcp-clients.js");
    ev.mcpServers = listMcpServers().map(m => `${m.label} (${m.command} ${m.args.join(" ")})${m.disabled ? " disabled" : ""}${m.lastError ? ` lastError="${m.lastError.slice(0, 80)}"` : ""}`);
    const { listMcpCatalog } = await import("./mcp-catalog.js");
    ev.mcpCatalog = listMcpCatalog().map(c => `${c.id}: ${c.description.slice(0, 90)}`);
  } catch { /* mcp modules unavailable */ }

  try {
    const { templates } = await import("./templates.js");
    ev.templates = templates.map(t => `${t.id} — ${t.title}${t.inputs.length ? ` (inputs: ${t.inputs.map(i => i.name).join(", ")})` : ""}`);
  } catch { /* templates unavailable */ }

  try {
    const { indexStats } = await import("./vault-index.js");
    const s = indexStats();
    ev.index = { docs: s.docs, ageHours: s.ageMs < 0 ? -1 : Math.round(s.ageMs / 3_600_000) };
  } catch { /* index unavailable */ }

  const sixtyDaysAgo = endMs - 60 * 86_400_000;
  ev.priorProposals = listOrgTasks()
    .filter(t => t.role === "improver" && Date.parse(t.createdAt) >= sixtyDaysAgo)
    .map(t => ({ title: t.title, status: t.status === "blocked" ? "rejected" : t.status }));

  return ev;
}

// ─── synthesis ────────────────────────────────────────────────────────────

export type ImprovementReview = {
  summary: string;
  whatWorked: string[];
  whatDidnt: string[];
  proposals: ImprovementProposal[];
};

const SYSTEM_PROMPT = `You are Naxie, reviewing your own week to improve the WHOLE system you run on.
You are given evidence: job stats, daily reflections, lessons, innovation scans, current schedules,
background engines, MCP servers, templates and retrieval health.

Propose the few changes (at most ${MAX_PROPOSALS}) that would most improve how well you serve the operator.
Consider every kind: new/changed schedules, code improvements, MCP servers to add, CLI tools to install
or wrap, skills/playbooks to write, retrieval fixes. Every proposal MUST cite the evidence behind it and
give concrete implementation steps. Do not repeat proposals listed under "prior proposals" (especially
rejected ones). Prefer small, high-leverage changes.

Reply with ONLY a JSON object, no prose, in this exact shape:
{
  "summary": "2-4 sentence overview of the week",
  "whatWorked": ["..."],
  "whatDidnt": ["..."],
  "proposals": [
    {
      "kind": "schedule" | "code" | "mcp" | "cli" | "skill" | "retrieval" | "other",
      "title": "short imperative title",
      "why": "evidence from this week that motivates it",
      "implementation": ["step 1", "step 2"],
      "effort": "S" | "M" | "L",
      "payload": { }
    }
  ]
}

payload by kind (omit when unsure):
- schedule: {"name": "...", "templateId": "<one of the listed templates>", "inputs": {...}, "cadence": {"daysOfWeek": [0-6, Sun=0; [] = daily], "hour": 0-23, "minute": 0-59}}
  (use templateId "general-task" with inputs {"task": "<plain-English task>"} for anything no template covers)
- mcp: {"catalogId": "<one of the listed catalog ids>"} or {"label": "...", "command": "...", "args": ["..."]}
- retrieval: {"action": "reindex" | "reembed" | "capture-notes", "topics": ["..."]}
- code / cli / skill / other: {"files": ["paths likely touched"]} (optional)`;

function bullet(xs: string[], empty = "(none)"): string {
  return xs.length ? xs.map(x => `- ${x}`).join("\n") : empty;
}

export function buildPrompt(ev: ImprovementEvidence): string {
  const r = ev.retrieval;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return [
    `# Week ${ev.windowStart.slice(0, 10)} → ${ev.windowEnd.slice(0, 10)}`,
    `## Jobs\n${ev.jobs.total} tasks, ${ev.jobs.succeeded} ok, ${ev.jobs.failed} failed (success ${pct(ev.jobs.successRate)})`,
    `### Top failures\n${bullet(ev.jobs.topFailures)}`,
    `### Unreliable tools\n${bullet(ev.jobs.weakTools)}`,
    `### Weak skills\n${bullet(ev.jobs.weakSkills)}`,
    `## Known weaknesses (quality signals / bottlenecks)\n${bullet(ev.weaknesses)}`,
    `## Retrieval health\n${r.totalQueries} queries · zero-hit ${pct(r.zeroHitRate)} · <2 hits ${r.lowHitQueries} · avg ${r.avgLatencyMs}ms · semantic search live ${pct(r.vectorEnabledShare)} · slow vault-walk fallback ${pct(r.fallbackScanShare)}\nIndex: ${ev.index.docs} docs, ${ev.index.ageHours < 0 ? "not built" : `${ev.index.ageHours}h old`}\nTerms that keep missing: ${r.topMissedTerms.map(t => `${t.term}(${t.count})`).join(", ") || "(none)"}\nExample missed queries:\n${bullet(r.sampleMissedQueries)}`,
    `## Current schedules\n${bullet(ev.schedules)}`,
    `## Background engines\n${bullet(ev.engines)}`,
    `## MCP servers registered\n${bullet(ev.mcpServers)}`,
    `## MCP catalog (installable)\n${bullet(ev.mcpCatalog)}`,
    `## Templates (valid schedule templateIds)\n${bullet(ev.templates)}`,
    `## Lessons learned so far\n${ev.lessons || "(none)"}`,
    `## Daily reflections this week\n${ev.reflections.map(x => `### ${x.file}\n${x.excerpt}`).join("\n\n") || "(none)"}`,
    `## Innovation scans this week\n${ev.scans.map(x => `### ${x.file}\n${x.excerpt}`).join("\n\n") || "(none)"}`,
    `## Prior proposals (last 60 days — do not repeat)\n${bullet(ev.priorProposals.map(p => `${p.title} [${p.status}]`))}`,
  ].join("\n\n");
}

function asStringArray(v: unknown, max = 12): string[] {
  if (!Array.isArray(v)) return typeof v === "string" && v.trim() ? [v.trim()] : [];
  return v.map(x => String(x ?? "").trim()).filter(Boolean).slice(0, max);
}

// Tolerant parser — models wrap JSON in fences, add prose, or drift on
// field names. Returns null only when there's no JSON object at all.
export function parseReview(text: string): ImprovementReview | null {
  let body = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fence) body = fence[1].trim();
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  let raw: any;
  try { raw = JSON.parse(body.slice(first, last + 1)); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;

  const proposals: ImprovementProposal[] = [];
  for (const p of Array.isArray(raw.proposals) ? raw.proposals : []) {
    if (!p || typeof p !== "object") continue;
    const title = String(p.title ?? "").trim();
    if (!title) continue;
    const kind = (KINDS as readonly string[]).includes(String(p.kind)) ? (p.kind as ImprovementKind) : "other";
    const effort = p.effort === "S" || p.effort === "M" || p.effort === "L" ? p.effort : "M";
    proposals.push({
      kind,
      title: title.slice(0, 140),
      why: String(p.why ?? "").trim().slice(0, 1200),
      implementation: asStringArray(p.implementation ?? p.steps),
      effort,
      payload: p.payload && typeof p.payload === "object" && !Array.isArray(p.payload) ? p.payload : undefined,
    });
    if (proposals.length >= MAX_PROPOSALS) break;
  }
  return {
    summary: String(raw.summary ?? "").trim(),
    whatWorked: asStringArray(raw.whatWorked),
    whatDidnt: asStringArray(raw.whatDidnt),
    proposals,
  };
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Retrieval proposals derived straight from telemetry, so a clearly broken
// retrieval path gets flagged even if the model misses it.
export function retrievalHeuristics(ev: ImprovementEvidence): ImprovementProposal[] {
  const out: ImprovementProposal[] = [];
  const r = ev.retrieval;
  if (ev.index.docs === 0 || ev.index.ageHours > 48) {
    out.push({
      kind: "retrieval", title: "Rebuild the vault search index", effort: "S",
      why: ev.index.docs === 0 ? "The MiniSearch index is empty, so every lookup falls back to the slow vault walk." : `The search index is ${ev.index.ageHours}h old — recent notes may be invisible to retrieval.`,
      implementation: ["Run buildIndex() over the vault now", "Check index age again in next week's review"],
      payload: { action: "reindex" },
    });
  }
  if (r.totalQueries >= 20 && r.zeroHitRate >= 0.25 && r.topMissedTerms.length) {
    out.push({
      kind: "retrieval", title: `Capture notes on topics retrieval keeps missing`, effort: "M",
      why: `${Math.round(r.zeroHitRate * 100)}% of ${r.totalQueries} lookups returned nothing. Most-missed terms: ${r.topMissedTerms.slice(0, 5).map(t => t.term).join(", ")}.`,
      implementation: ["Research each missed topic (vault first, then web when online)", "Write a short note per topic into 0-Inbox/ so future lookups hit", "Re-check the zero-hit rate in next week's review"],
      payload: { action: "capture-notes", topics: r.topMissedTerms.slice(0, 5).map(t => t.term) },
    });
  }
  return out;
}

// ─── the run ──────────────────────────────────────────────────────────────

export type WeeklyImprovementResult = {
  date: string;
  path: string;
  markdown: string;
  generatedAt: string;
  modelUsed?: string;
  review: ImprovementReview;
  taskIds: string[];
  parseFailed: boolean;
};

let lastResult: WeeklyImprovementResult | null = null;
let inFlight: Promise<WeeklyImprovementResult> | null = null;

export function lastWeeklyImprovement(): WeeklyImprovementResult | null { return lastResult; }

function scheduleConfig(): { dow: number; hour: number } {
  return {
    dow: Number(process.env.NAXION_WEEKLY_IMPROVEMENT_DOW ?? "0"),
    hour: Number(process.env.NAXION_WEEKLY_IMPROVEMENT_HOUR ?? "10"),
  };
}

export async function weeklyImprovementStatus(): Promise<{ last: WeeklyImprovementResult | null; nextFireAt: number | null }> {
  const { nextFireAt } = await import("./schedules.js");
  const { dow, hour } = scheduleConfig();
  return { last: lastWeeklyImprovement(), nextFireAt: nextFireAt({ daysOfWeek: [dow], hour, minute: 0 }) };
}

// Park each proposal on the org board as a pending approval. Skips titles
// that match an earlier improver task (any status) so a rejected idea
// doesn't come back every week.
export function fileProposals(proposals: ImprovementProposal[], reviewDate: string): string[] {
  const existing = new Set(listOrgTasks().filter(t => t.role === "improver").map(t => normTitle(t.title)));
  const ids: string[] = [];
  for (const p of proposals) {
    const key = normTitle(p.title);
    if (existing.has(key)) continue;
    existing.add(key);
    const task = createOrgTask({
      role: "improver",
      title: p.title,
      detail: [p.why, "", "How we'll implement it:", ...p.implementation.map((s, i) => `${i + 1}. ${s}`)].join("\n").slice(0, 4000),
      priority: p.effort === "S" ? "normal" : "low",
      createdBy: "daemon",
    });
    requestApproval(task.id, {
      actionDescription: approvalDescription(p),
      kind: "improvement",
      improvement: { ...p, reviewDate },
    });
    ids.push(task.id);
  }
  return ids;
}

function approvalDescription(p: ImprovementProposal): string {
  switch (p.kind) {
    case "schedule": return `Add a new schedule: ${p.title}`;
    case "code": return `Draft a code change for review: ${p.title} (the diff comes back as its own approval)`;
    case "mcp": return `Register an MCP server (starts disabled until you enable it): ${p.title}`;
    case "retrieval": return `Improve retrieval: ${p.title}`;
    case "cli": return `Track a CLI tool to add: ${p.title}`;
    case "skill": return `Track a skill/playbook to write: ${p.title}`;
    default: return `Track an improvement: ${p.title}`;
  }
}

function renderMarkdown(res: { date: string; ev: ImprovementEvidence; review: ImprovementReview; taskIds: string[]; modelUsed?: string; parseFailed: boolean }): string {
  const { ev, review } = res;
  const r = ev.retrieval;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const rows = review.proposals.map((p, i) => `| ${i + 1} | ${p.kind} | ${p.title.replace(/\|/g, "/")} | ${p.effort} |`).join("\n");
  const details = review.proposals.map((p, i) => [
    `### ${i + 1}. ${p.title}`,
    `**Kind:** ${p.kind} · **Effort:** ${p.effort}`,
    "",
    `**Why:** ${p.why || "_(no evidence given)_"}`,
    "",
    "**How we'll implement it:**",
    ...(p.implementation.length ? p.implementation.map((s, j) => `${j + 1}. ${s}`) : ["_(no steps given)_"]),
    ...(p.payload ? ["", "```json", JSON.stringify(p.payload, null, 2), "```"] : []),
  ].join("\n")).join("\n\n");

  return `---
type: weekly-improvement
week: ${ev.windowStart.slice(0, 10)} → ${ev.windowEnd.slice(0, 10)}
generated: ${new Date().toISOString()}
model: ${res.modelUsed ?? "none"}
proposals: ${review.proposals.length}
---

# 🧠 Weekly Reflect — what Naxie should have next

> _Self-improvement review · ${res.date}_

## Summary

${review.summary || (res.parseFailed ? "_The model's answer couldn't be parsed — stats only this week._" : "_No summary._")}

## ✅ What worked

${bullet(review.whatWorked, "_Nothing recorded._")}

## ⚠️ What didn't

${bullet(review.whatDidnt, "_Nothing recorded._")}

## 🔎 Retrieval health

| Metric | Value |
|---|---|
| Lookups this week | ${r.totalQueries} |
| Zero-hit rate | ${pct(r.zeroHitRate)} |
| Lookups with < 2 hits | ${r.lowHitQueries} |
| Avg latency | ${r.avgLatencyMs} ms |
| Semantic search live | ${pct(r.vectorEnabledShare)} |
| Slow vault-walk fallback | ${pct(r.fallbackScanShare)} |
| Index | ${ev.index.docs} docs, ${ev.index.ageHours < 0 ? "not built" : `${ev.index.ageHours}h old`} |

${r.topMissedTerms.length ? `Most-missed terms: ${r.topMissedTerms.map(t => `\`${t.term}\` (${t.count})`).join(", ")}` : ""}

## 🛠️ Proposals

${review.proposals.length ? `| # | Kind | Proposal | Effort |\n|---|---|---|---|\n${rows}\n\n${details}` : "_No proposals this week._"}

---

> ${res.taskIds.length} new proposal(s) are waiting in **Agent Approvals**. Approving one applies it (schedules, retrieval, MCP) or turns it into tracked work (code goes to the architect as a reviewable diff).
`;
}

export async function runWeeklyImprovement(): Promise<WeeklyImprovementResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const now = new Date();
    const date = localYmd(now);
    const ev = await gatherEvidence(now);

    let review: ImprovementReview = { summary: "", whatWorked: [], whatDidnt: [], proposals: [] };
    let modelUsed: string | undefined;
    let parseFailed = false;
    try {
      const { llmGenerateWithMeta } = await import("./llm.js");
      const out = await llmGenerateWithMeta(buildPrompt(ev), SYSTEM_PROMPT, { profile: "synthesis", complexity: "high", maxTokens: 3000, temperature: 0.3 });
      modelUsed = out.model;
      const parsed = parseReview(out.text);
      if (parsed) review = parsed;
      else parseFailed = true;
    } catch (e: any) {
      parseFailed = true;
      console.warn(`[weekly-improvement] synthesis failed: ${e?.message ?? e}`);
    }

    // Telemetry-driven retrieval fixes the model didn't already cover.
    const haveRetrieval = new Set(review.proposals.filter(p => p.kind === "retrieval").map(p => String(p.payload?.action ?? "")));
    for (const h of retrievalHeuristics(ev)) {
      if (!haveRetrieval.has(String(h.payload?.action ?? ""))) review.proposals.push(h);
    }

    const taskIds = fileProposals(review.proposals, date);
    const markdown = renderMarkdown({ date, ev, review, taskIds, modelUsed, parseFailed });
    const path = `${REVIEW_DIR}/${date}.md`;
    try {
      writeVaultFile(path, markdown);
      const { enqueueVaultCommit } = await import("./commit-queue.js");
      void enqueueVaultCommit(`chore(weekly-improvement): ${date}`);
    } catch (e: any) { console.warn(`[weekly-improvement] vault write failed: ${e?.message ?? e}`); }

    const generatedAt = new Date().toISOString();
    const result: WeeklyImprovementResult = { date, path, markdown, generatedAt, modelUsed, review, taskIds, parseFailed };
    lastResult = result;

    try {
      const { newJob } = await import("./jobs.js");
      const { persistJobRecord } = await import("./job-store.js");
      const j = newJob("weekly-improvement");
      j.title = `🧠 Weekly Reflect — ${review.proposals.length} proposal(s)`;
      j.status = "succeeded"; j.startedAt = generatedAt; j.finishedAt = generatedAt;
      j.result = { answer: markdown, briefPath: path };
      try { persistJobRecord(j); } catch { /* best-effort */ }
    } catch { /* job store unavailable */ }

    void (async () => {
      try {
        const { sendTelegramMessage, stripVaultFrontmatterForTelegram } = await import("./telegram-bridge.js");
        const list = review.proposals.map((p, i) => `${i + 1}. [${p.kind}] ${p.title}`).join("\n");
        const r = await sendTelegramMessage(`🧠 *Weekly Reflect — ${date}*\n${review.summary.slice(0, 600)}\n\n${list || "No proposals this week."}\n\nApprove in Agent Approvals.\n\n${stripVaultFrontmatterForTelegram(markdown).slice(0, 2000)}\n\n— _Full: ${path}_`);
        if (!r.ok) console.warn(`[weekly-improvement] telegram skip: ${r.error}`);
      } catch { /* telegram not configured */ }
      try {
        const { sendEmail, emailConfigured } = await import("./email.js");
        const { config } = await import("../config.js");
        const to = (config as any).operatorEmail ?? "";
        if (emailConfigured() && to) await sendEmail({ to, subject: `Weekly Reflect — ${date}`, body: markdown });
      } catch { /* email not configured */ }
    })();

    return result;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

// ─── approval → implementation ────────────────────────────────────────────

export type ApplyOutcome = { ok: boolean; message: string };

// Test seam — lets tests swap the side-effecting implementations.
export type ApplyDeps = {
  createSchedule: (input: any) => { id: string; name: string };
  templateExists: (id: string) => boolean;
  reindex: () => Promise<void>;
  reembed: () => Promise<{ ok: boolean; error?: string }>;
  architect: (focus: string) => Promise<{ created: boolean; taskId?: string; reason?: string }>;
  addMcp: (input: { label: string; command: string; args: string[]; description?: string }) => { id: string; label: string };
  disableMcp: (id: string) => void;
  mcpCatalogEntry: (id: string) => { label: string; command: string; args: string[]; description: string } | undefined;
};

async function defaultDeps(): Promise<ApplyDeps> {
  const schedules = await import("./schedules.js");
  const { templates } = await import("./templates.js");
  const { findCustomTemplate } = await import("./custom-templates.js");
  const mcp = await import("./mcp-clients.js");
  const { getMcpCatalogEntry } = await import("./mcp-catalog.js");
  return {
    createSchedule: (input) => schedules.createSchedule(input),
    templateExists: (id) => templates.some(t => t.id === id) || !!findCustomTemplate(id),
    reindex: async () => { const { buildIndex } = await import("./vault-index.js"); const { config } = await import("../config.js"); await buildIndex(config.vaultPath); },
    reembed: async () => { const { runReembedNow } = await import("./rag-embed.js"); return runReembedNow(); },
    architect: async (focus) => { const { runArchitectReview } = await import("./architect.js"); return runArchitectReview({ focus }); },
    addMcp: (input) => mcp.addMcpServer(input),
    disableMcp: (id) => { mcp.setMcpServerDisabled(id, true); },
    mcpCatalogEntry: (id) => getMcpCatalogEntry(id),
  };
}

function validCadence(c: any): { daysOfWeek: number[]; hour: number; minute: number } | null {
  if (!c || typeof c !== "object") return null;
  const days = Array.isArray(c.daysOfWeek) ? c.daysOfWeek.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  const hour = Number(c.hour);
  const minute = Number(c.minute ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { daysOfWeek: [...new Set<number>(days)].sort(), hour, minute };
}

export async function applyImprovementProposal(p: ImprovementProposal, deps?: ApplyDeps): Promise<ApplyOutcome> {
  const d = deps ?? await defaultDeps();
  const payload = (p.payload ?? {}) as Record<string, any>;
  switch (p.kind) {
    case "schedule": {
      const cadence = validCadence(payload.cadence);
      const templateId = String(payload.templateId ?? "");
      if (!cadence) return { ok: false, message: "proposal has no valid cadence — create the schedule by hand from the implementation steps" };
      if (!templateId || !d.templateExists(templateId)) return { ok: false, message: `unknown template "${templateId}" — create the schedule by hand from the implementation steps` };
      const inputs = payload.inputs && typeof payload.inputs === "object" ? payload.inputs : {};
      if (templateId === "general-task" && !String(inputs.task ?? "").trim()) {
        inputs.task = [p.title, ...p.implementation].join("\n");
      }
      const s = d.createSchedule({ name: String(payload.name ?? p.title).slice(0, 120), templateId, inputs, cadence });
      return { ok: true, message: `schedule "${s.name}" created (${s.id})` };
    }
    case "retrieval": {
      const action = String(payload.action ?? "");
      if (action === "reindex") { await d.reindex(); return { ok: true, message: "vault search index rebuilt" }; }
      if (action === "reembed") {
        const r = await d.reembed();
        return r.ok ? { ok: true, message: "semantic re-embed finished" } : { ok: false, message: `re-embed failed: ${r.error ?? "unknown"}` };
      }
      return { ok: true, message: "tracked as work — follow the implementation steps" };
    }
    case "code": {
      const focus = [p.title, p.why, ...p.implementation.map((s, i) => `${i + 1}. ${s}`)].join("\n");
      const r = await d.architect(focus);
      return r.created
        ? { ok: true, message: `architect drafted a diff — review it in Agent Approvals (task ${r.taskId})` }
        : { ok: false, message: `architect couldn't draft a diff: ${r.reason ?? "unknown"}` };
    }
    case "mcp": {
      let input: { label: string; command: string; args: string[]; description?: string } | null = null;
      if (payload.catalogId) {
        const entry = d.mcpCatalogEntry(String(payload.catalogId));
        if (!entry) return { ok: false, message: `MCP catalog has no "${payload.catalogId}"` };
        input = { label: entry.label, command: entry.command, args: entry.args, description: entry.description };
      } else if (payload.command) {
        input = { label: String(payload.label ?? p.title), command: String(payload.command), args: Array.isArray(payload.args) ? payload.args.map(String) : [], description: p.why.slice(0, 200) };
      }
      if (!input) return { ok: false, message: "proposal names no MCP server — add it by hand from the implementation steps" };
      const added = d.addMcp(input);
      d.disableMcp(added.id);
      return { ok: true, message: `MCP server "${added.label}" registered DISABLED — add any required keys and enable it in Extensions` };
    }
    default:
      return { ok: true, message: "tracked as work on the org board — follow the implementation steps" };
  }
}

// Kinds whose approval fully applies the change (task → done). The rest stay
// "active" on the board as tracked work until the operator closes them.
const SELF_APPLYING = new Set<ImprovementKind>(["schedule", "mcp", "code"]);

export async function resolveImprovementApproval(id: string, approved: boolean, deps?: ApplyDeps): Promise<{ task: OrgTask; outcome?: ApplyOutcome } | null> {
  const task = getOrgTask(id);
  if (!task || task.role !== "improver" || task.status !== "waiting-on-approval") return null;
  const proposal = task.pendingApproval?.improvement;
  if (!approved) {
    const t = updateOrgTaskStatus(id, "blocked");
    return t ? { task: t } : null;
  }
  if (!proposal) {
    const t = updateOrgTaskStatus(id, "active");
    return t ? { task: t, outcome: { ok: true, message: "approved (no structured proposal attached)" } } : null;
  }
  let outcome: ApplyOutcome;
  try { outcome = await applyImprovementProposal(proposal, deps); }
  catch (e: any) { outcome = { ok: false, message: String(e?.message ?? e) }; }
  const selfApplied = SELF_APPLYING.has(proposal.kind) || (proposal.kind === "retrieval" && ["reindex", "reembed"].includes(String(proposal.payload?.action)));
  const status = !outcome.ok ? "active" : selfApplied ? "done" : "active";
  const t = updateOrgTaskStatus(id, status);
  try {
    const { logAudit } = await import("./audit-log.js");
    logAudit({ level: outcome.ok ? "info" : "warn", actor: "improver", action: "improvement.applied", target: proposal.title, detail: outcome.message.slice(0, 200), result: outcome.ok ? "success" : "failure" });
  } catch { /* best-effort */ }
  return t ? { task: t, outcome } : null;
}

// ─── scheduler ────────────────────────────────────────────────────────────

let scheduler: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;

export function startWeeklyImprovementScheduler(): void {
  if (scheduler) return;
  const { dow, hour } = scheduleConfig();
  const tick = async () => {
    const now = new Date();
    if (now.getDay() !== dow || now.getHours() < hour) return;
    const today = localYmd(now);
    if (lastRunDate === today) return;
    try {
      const { config } = await import("../config.js");
      const dir = join(config.vaultPath, REVIEW_DIR);
      if (existsSync(dir) && readdirSync(dir).some(f => f.startsWith(today))) { lastRunDate = today; return; }
    } catch { /* vault unreachable — the run will surface it */ }
    lastRunDate = today;
    console.log(`[weekly-improvement] firing (dow=${dow} hour>=${hour})`);
    try { await runWeeklyImprovement(); } catch (e: any) { console.warn(`[weekly-improvement] failed: ${e?.message ?? e}`); }
  };
  scheduler = setInterval(tick, 10 * 60_000);
  scheduler.unref?.();
  void tick();
}

export function stopWeeklyImprovementScheduler(): void {
  if (scheduler) { clearInterval(scheduler); scheduler = null; }
}
