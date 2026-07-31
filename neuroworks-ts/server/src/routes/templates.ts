import { Router } from "express";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { simpleGit } from "simple-git";
import { templates, roles, type Template } from "../lib/templates.js";
import { newJob, getJob, listJobs, runJob, adoptJob, APPROVAL_TTL_MS, SERVER_BOOT_AT } from "../lib/jobs.js";
import { loadJobById, loadJobsInWindow, asJob, persistJobRecord } from "../lib/job-store.js";
import { config } from "../config.js";
import { dispatchWorkflow, recentCommits, openPRs, openIssues, readme, octokit } from "../lib/github.js";
import { writeVaultFile, commitAndPush, searchVault, VaultUnreachable } from "../lib/vault.js";
import { ollamaGenerate } from "../lib/ollama.js";
import { llmGenerate } from "../lib/llm.js";
import { syncDownloads } from "../lib/sync-downloads.js";
import { planAndExecute, executePlan } from "../lib/agent.js";
import { requireLayer, callerOf } from "../lib/access.js";
import { filterJobsForCaller, canSeeJob } from "../lib/job-visibility.js";
import { checkTaskAllowed } from "../lib/task-restrictions.js";
import { loadCustomTemplates, saveCustomTemplate, findCustomTemplate, bumpRunCount, slugify, type CustomTemplate } from "../lib/custom-templates.js";
import { loadPersonas, getActivePersona, personaSystemSuffix } from "../lib/personas.js";
import { classifyCustomTemplate, type TemplateRole } from "../lib/template-classifier.js";
import { findPrimitive } from "../lib/primitives.js";

export const templatesRouter = Router();

const NEEDS_GITHUB = new Set(["summarize-repo", "run-digest", "publish-folder"]);

templatesRouter.get("/", (_req, res) => {
  // Custom templates persist with role: "Custom" because save-time didn't
  // know which lane they belonged to. We re-classify on read so the UI
  // shows them under Engineering / Knowledge / Operations / Insights
  // when the id + title + description match a known lane. Unclassifiable
  // saves still fall through to "Custom" for discoverability.
  const custom = loadCustomTemplates().map(c => ({
    id: c.id,
    role: classifyCustomTemplate(c),
    title: c.title,
    description: c.description,
    icon: "saved",
    agent: "clawbot",
    inputs: [],
    requiresApproval: false,
    estimateSeconds: 30,
    runCount: c.runCount,
    lastRunAt: c.lastRunAt,
  }));
  // Recount every role with the re-classified customs folded in. Built-in
  // templates already have correct roles; we just need to add the custom
  // contribution per bucket.
  const customByRole: Record<TemplateRole, number> = { Engineering: 0, Knowledge: 0, Operations: 0, Insights: 0, Custom: 0 };
  for (const c of custom) customByRole[c.role as TemplateRole]++;
  const allRoles = roles.map(r => ({ ...r, count: (r.count ?? 0) + (customByRole[r.id as TemplateRole] ?? 0) }));
  res.json({ roles: allRoles, templates: [...templates, ...custom] });
});

// Jobs feed for the Tasks / Reports pages. MERGES the in-memory jobs with the
// persisted journal so reports SURVIVE a server restart / tsx-watch reload —
// previously this returned only the in-memory map (RECENT cap, wiped on
// reload), so scheduled runs and any older task had "no report" even though the
// record was on disk. In-memory wins on id collision (it's the freshest state).
// Staff-layer sessions see ONLY their OWN tasks — the work they initiated —
// plus their department's persona work. They must NOT see the superadmin/CEO's
// personal ad-hoc tasks (org-general jobs with no persona), which the old
// department filter let through to everyone. Knowledge stays shared (the vault
// / Knowledge pages are not filtered — only the task + activity feed is).
// Machine callers and admin+ sessions see everything.
// Moved to lib/job-visibility.ts so the tasks router and Calendar apply the
// SAME per-user slice — this feed filtering alone left /api/tasks/jobs and
// /api/calendar/* leaking every user's work to every signed-in user.

// Journal-read cache for the jobs feed. The Tasks page polls every 3s and
// each poll was re-reading 30 days of JSONL from disk (security/perf sweep
// 2026-07-04). In-memory jobs stay LIVE every poll — only the persisted slice
// is cached, and 4s staleness on restart-survived history is invisible.
let jobsFeedCache: { at: number; persisted: ReturnType<typeof asJob>[] } | null = null;
const JOBS_FEED_CACHE_MS = 4000;

templatesRouter.get("/jobs", (_req, res) => {
  const mem = listJobs();
  const seen = new Set(mem.map(j => j.id));
  // Look back 30 days of persisted records — enough for the Reports history
  // without scanning the whole journal. asJob() hydrates answer + plan so each
  // row deep-links to a renderable report.
  const windowStart = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let persisted: ReturnType<typeof asJob>[] = [];
  try {
    if (jobsFeedCache && Date.now() - jobsFeedCache.at < JOBS_FEED_CACHE_MS) {
      persisted = jobsFeedCache.persisted.filter(j => !seen.has(j.id));
    } else {
      const fresh = loadJobsInWindow(windowStart, Date.now() + 60_000).map(asJob);
      jobsFeedCache = { at: Date.now(), persisted: fresh };
      persisted = fresh.filter(j => !seen.has(j.id));
    }
  } catch { /* tolerate — fall back to in-memory only */ }
  // Dedup persisted-vs-persisted too (append-only journal can hold running→
  // succeeded for one id); keep the last (latest status) per id.
  const byId = new Map<string, ReturnType<typeof asJob>>();
  for (const j of persisted) byId.set(j.id, j);
  const all = [...mem, ...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  // Serve only the 150 MOST RECENT to the Tasks/Reports feed — keeps the page
  // fast and focused. Everything older still lives on disk (the job journal) and
  // is surfaced through the vault + Knowledge (reflections + journaled notes),
  // so nothing is lost — it's just not loaded into the live list.
  const MAX_FEED = Number(process.env.NEUROWORKS_TASKS_FEED_LIMIT ?? "150");
  const visible = filterJobsForCaller(_req, all);
  const jobs = visible.slice(0, MAX_FEED);
  res.json({ jobs, total: visible.length, limit: MAX_FEED, truncated: visible.length > MAX_FEED });
});

templatesRouter.get("/jobs/:id", (req, res) => {
  const j = getJob(req.params.id);
  // Staff callers must not read another user's job by id — same slice the
  // feed applies. 404 (not 403) so the response doesn't confirm existence.
  if (j) {
    if (!canSeeJob(req, j)) return res.status(404).json({ error: "not found" });
    return res.json(j);
  }
  // Fallback to the persisted journal — covers the Calendar's day-detail
  // panel linking to old jobs that were evicted from the in-memory cap,
  // server-restart cases, and direct deep-links into /results/<id> for
  // anything older than the last few dozen jobs.
  const rec = loadJobById(req.params.id);
  if (rec) {
    // asJob() hydrates the persisted record into the Job shape the UI
    // expects, including answer + plan summary so the Result page renders
    // the actual report. log[] is empty (we don't persist log lines) and
    // runs[] is minimal (just tool + duration + ok flag).
    const hydrated = asJob(rec);
    if (!canSeeJob(req, hydrated)) return res.status(404).json({ error: "not found" });
    return res.json(hydrated);
  }
  return res.status(404).json({
    error: "not found",
    serverBootAt: SERVER_BOOT_AT,
    hint: "Job not found in memory or in the persisted journal. If this was a recent task, retry it — otherwise the journal may have been rotated.",
  });
});

// Retry a failed job — replays the same task + inputs through the general-task
// pipeline. The original failed job stays in the journal so the customer has
// the audit trail. The new job is fully fresh — plan, execution, synth all
// run again, so transient failures (LLM hiccup, network blip) get a clean
// second shot. We require the original to be in a terminal state (succeeded,
// failed, rejected); replaying a running job would create a duplicate.
templatesRouter.post("/jobs/:id/retry", async (req, res) => {
  const old = getJob(req.params.id);
  if (!old) return res.status(404).json({ error: "job not found" });
  if (old.status !== "failed" && old.status !== "rejected" && old.status !== "succeeded") {
    return res.status(409).json({ error: `cannot retry job in status "${old.status}" — wait for it to finish first` });
  }
  const task = String((old.inputs as any)?.task ?? "").trim();
  if (!task) return res.status(400).json({ error: "original job has no recorded task — cannot retry" });

  // Spin up a fresh job and run the same general-task agent loop. We mark it
  // with `retryOf: <old id>` so the UI / journal can trace the lineage.
  const job = newJob("insights:general-task");
  job.template = "general-task";
  job.title = `Retry: ${task.slice(0, 60)}`;
  job.inputs = { task, save_as_template: false, retryOf: req.params.id };
  job.createdByEmail = callerOf(req)?.email ?? old.createdByEmail;
  res.json({ jobId: job.id, retryOf: req.params.id });

  void runJob(job, async (push, progress) => {
    push(`retry of job ${req.params.id} (${old.status})`);
    const persona = getActivePersona();
    const suffix = personaSystemSuffix(persona);
    const r = await planAndExecute(task, push, (patch) => progress(patch as Record<string, unknown>), { personaSystemSuffix: suffix, workMode: persona?.workMode, taskKind: job.kind, persona: persona?.name });
    return {
      answer: r.answer,
      plan: r.plan,
      runs: r.runs,
      review: r.review,
      quality: r.quality,
      security: r.security,
      budgets: r.budgets,
      subagentTimings: r.subagentTimings,
      skillUsed: r.skillUsed,
      skillScore: r.skillScore,
      humanRequest: r.humanRequest,
    };
  });
});

templatesRouter.post("/run/:id", async (req, res) => {
  let tpl = templates.find(t => t.id === req.params.id);
  let custom: CustomTemplate | undefined;
  if (!tpl) {
    custom = findCustomTemplate(req.params.id);
    if (custom) {
      tpl = { id: custom.id, role: "Insights", title: custom.title, description: custom.description, icon: "saved", agent: "clawbot", inputs: [], requiresApproval: false, estimateSeconds: 30 } as Template;
    }
  }
  if (!tpl) return res.status(404).json({ error: "template not found" });
  const inputs = (req.body ?? {}) as Record<string, unknown>;

  // Company-structure gate: block a restricted human from running a task that
  // calls for a capability they're not allowed (payments, email, db, …).
  // Machine/scheduled callers and superadmins pass. Uses the task text plus
  // the template title so a "Create a Paynow payment" template is caught too.
  {
    const caller = callerOf(req);
    const taskProbe = `${tpl.title} ${String(inputs.task ?? "")} ${String(inputs.focus ?? "")}`;
    const check = checkTaskAllowed(caller, taskProbe);
    if (!check.allowed) {
      return res.status(403).json({
        error: `Your role can't run ${check.capability} tasks${check.note ? ` — ${check.note}` : ""}. Ask an admin or someone in the right department to handle this.`,
        restrictedCapability: check.capability,
      });
    }
  }

  // Validate required inputs. Trim string values so a whitespace-only submission
  // ("   ") is rejected cleanly here (400) rather than slipping through to a job
  // that fails mid-run with "missing 'task' input".
  const missing = tpl.inputs.filter(i => {
    if (!i.required) return false;
    const v = inputs[i.name];
    if (v === undefined || v === null) return true;
    return typeof v === "string" ? v.trim() === "" : v === "";
  }).map(i => i.name);
  if (missing.length) return res.status(400).json({ error: `missing inputs: ${missing.join(", ")}` });

  // Preflight: refuse cleanly if a GitHub-touching template is requested without a token
  if (NEEDS_GITHUB.has(tpl.id) && !config.githubToken) {
    return res.status(412).json({ error: "GitHub token not configured. Set GITHUB_TOKEN in clawbot/.env and restart." });
  }

  const job = newJob(`${tpl.role.toLowerCase()}:${tpl.id}`);
  job.template = tpl.id;
  job.title = tpl.title;
  job.inputs = inputs;
  job.requiresApproval = tpl.requiresApproval;
  // Attribute to the initiating human (staff feeds show only own tasks).
  job.createdByEmail = callerOf(req)?.email;
  // Schedule-fired runs carry a marker header; the tag routes their results
  // into the vault journal (scheduled progress reports belong in the brain).
  const scheduledBy = req.get("x-clawbot-scheduled");
  if (scheduledBy) job.scheduledBy = scheduledBy;

  if (tpl.requiresApproval) {
    job.status = "awaiting-approval";
    job.log.push(`[${new Date().toISOString()}] task created · waiting on human approval (Approvals page)`);
    return res.json({ jobId: job.id, requiresApproval: true, status: "awaiting-approval" });
  }

  res.json({ jobId: job.id, requiresApproval: false, status: "queued" });
  void runJob(job, async (push, progress) => {
    if (custom) {
      bumpRunCount(custom.id);
      // Persona-derived starter templates ship with an empty plan — they re-plan
      // each run against the active persona system suffix so output stays in role.
      // Saved-from-chat templates, by contrast, replay their concrete plan.
      // Optional probe enrichment: callers (e.g. the stress harness) may pass
      // a `contextHint` to give the run more framing than the terse origin.task
      // carries. Absent → behaviour is unchanged. GATED TO PREPLAN BRANCH ONLY:
      // empty-plan templates route through generalTaskRunner which re-plans
      // every run — a longer task there expands planned scope and produced
      // 74/84 timeouts + 4 catastrophic ~5400s outliers in the 2026-05-30
      // sweep. The preplan branch replays a fixed plan, so richer task text
      // there only enriches synthesis, not planning.
      const contextHint = typeof inputs.contextHint === "string" ? inputs.contextHint.trim() : "";
      if (custom.plan.steps.length === 0 && custom.origin?.task) {
        return generalTaskRunner({ task: custom.origin.task, save_as_template: false }, push, progress);
      }
      // Saved-plan customs go through planAndExecute with `preplan` so they
      // get the same execute → synthesise → answer treatment as fresh
      // ad-hoc tasks. Previously this branch returned raw {plan, runs, ...}
      // JSON with no `answer` field, which surfaced to the customer as
      // machine output.
      const persona = getActivePersona();
      const personaSuffix = personaSystemSuffix(persona);
      const baseTask = custom.origin?.task ?? `Replay saved plan: ${custom.title}`;
      const taskText = contextHint ? `${baseTask}\n\nContext: ${contextHint}` : baseTask;
      const r = await planAndExecute(taskText, push, (patch) => progress(patch as Record<string, unknown>), {
        personaSystemSuffix: personaSuffix,
        preplan: custom.plan,
        workMode: persona?.workMode,
      });
      return { ...r, fromCustom: custom.id };
    }
    return runner(tpl.id, inputs, push, progress);
  });
});

// Grade an arbitrary (task, answer) with the deliverable-aware quality grader.
// Used by the all-templates stress harness: template replays go through the
// `preplan` path which skips the in-line QA gate, so we score their output
// here instead. Thin wrapper over the quality.check primitive.
templatesRouter.post("/grade", async (req, res) => {
  try {
    const task = String(req.body?.task ?? "");
    const answer = String(req.body?.answer ?? "");
    const sources = req.body?.sources ? String(req.body.sources) : "";
    const context = req.body?.context ? String(req.body.context) : "";
    if (!task || !answer) return res.status(400).json({ error: "task and answer required" });
    const prim = findPrimitive("quality.check");
    if (!prim) return res.status(500).json({ error: "quality.check primitive not found" });
    const r = await prim.handler({ task, answer, sources, context });
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

templatesRouter.post("/jobs/:id/approve", requireLayer("admin"), async (req, res) => {
  // Fall back to the persisted store when the in-memory job is gone (evicted,
  // or wiped by a restart). Parked-for-approval jobs persist their full plan +
  // task + personaSuffix, so a re-hydrated job can still replay exactly. Adopt
  // it back into the table so streaming + subsequent polls resolve.
  let j = getJob(req.params.id);
  if (!j) {
    const rec = loadJobById(req.params.id);
    if (rec) j = adoptJob(asJob(rec));
  }
  if (!j) return res.status(404).json({ error: "not found" });
  if (j.status !== "awaiting-approval") return res.status(409).json({ error: `cannot approve job in state '${j.status}'` });

  // Stale-park guard: don't replay a plan that has been parked longer than the
  // TTL — its inputs (SQL, recipients, live data) may be well out of date.
  const ageMs = Date.now() - new Date(j.startedAt).getTime();
  if (ageMs > APPROVAL_TTL_MS) {
    j.status = "failed";
    j.error = "Approval expired — this task was parked too long. Re-run it to get a fresh plan.";
    j.finishedAt = new Date().toISOString();
    try { persistJobRecord(j); } catch { /* best-effort */ }
    return res.status(409).json({ error: j.error, expired: true });
  }

  // Edit-before-approve: an admin may tweak the reviewed plan (e.g. fix the SQL
  // or the email body). The preplan replay SKIPS the sensitive-tool checkpoint,
  // so the one hard requirement is that every tool in the edited plan is a real
  // primitive — reject anything that would inject an unknown/renamed tool.
  const editedPlan = (req.body && typeof req.body === "object") ? (req.body as any).plan : undefined;
  if (editedPlan) {
    if (!Array.isArray(editedPlan.steps)) return res.status(400).json({ error: "edited plan must have a steps array" });
    const badStep = editedPlan.steps.find((s: any) => !s?.tool || !findPrimitive(String(s.tool)));
    if (badStep) return res.status(400).json({ error: `edited plan references an unknown tool: ${String(badStep?.tool)}` });
    j.plan = editedPlan;
    j.log.push(`[${new Date().toISOString()}] plan edited by approver before approval (${editedPlan.steps.length} steps)`);
  }

  j.approvedAt = new Date().toISOString();
  j.log.push(`[${j.approvedAt}] approved`);
  res.json({ jobId: j.id, status: "approved" });

  // Agent-requested Paynow payment: money moves ONLY here, after the operator
  // clicked approve. The primitive queued the amount/description; approval
  // executes the real gateway call and the pay link lands in the job result
  // (visible on Reports + pollable via payment.paynow_poll).
  if (j.kind === "payments:paynow-approval") {
    void runJob(j, async (push) => {
      const inputs: any = j.inputs ?? {};
      push(`Approved — creating Paynow payment: ${Number(inputs.amount).toFixed(2)} (${String(inputs.description ?? "")})`);
      const { createPaynowPayment } = await import("../lib/paynow.js");
      const p = await createPaynowPayment({
        amount: Number(inputs.amount),
        description: String(inputs.description ?? ""),
        reference: inputs.reference ? String(inputs.reference) : undefined,
        email: inputs.email ? String(inputs.email) : undefined,
      });
      push(`Payment created — reference ${p.reference}.`);
      return {
        answer: `**Paynow payment created** (approved by operator)\n\n- Pay link (send to the client): ${p.browserUrl}\n- Reference: \`${p.reference}\`\n- Amount: ${p.amount.toFixed(2)}\n\nStatus can be checked any time with payment.paynow_poll or the Payments page.`,
        payment: p,
      };
    });
    return;
  }
  // Plan-approval job: execute the EXACT plan the user reviewed (no re-planning),
  // then let planAndExecute finish the loop (synthesise → answer). Empty plans
  // fall through to the normal plan/synth path.
  if (j.plan) {
    const task = j.task ?? j.title ?? "";
    void runJob(j, async (push, progress) =>
      planAndExecute(task, push, (patch) => progress(patch as Record<string, unknown>), {
        personaSystemSuffix: j.personaSuffix,
        preplan: j.plan && j.plan.steps.length > 0 ? j.plan : undefined,
      }));
    return;
  }
  if (!j.template) return;
  void runJob(j, async (push) => runner(j.template!, j.inputs ?? {}, push));
});

templatesRouter.post("/jobs/:id/reject", requireLayer("admin"), async (req, res) => {
  let j = getJob(req.params.id);
  if (!j) {
    const rec = loadJobById(req.params.id);
    if (rec) j = adoptJob(asJob(rec));
  }
  if (!j) return res.status(404).json({ error: "not found" });
  if (j.status !== "awaiting-approval") return res.status(409).json({ error: `cannot reject job in state '${j.status}'` });
  j.rejectedAt = new Date().toISOString();
  j.status = "rejected";
  j.finishedAt = j.rejectedAt;
  j.log.push(`[${j.rejectedAt}] rejected`);
  res.json({ jobId: j.id, status: "rejected" });
});

// NL → template + extracted params via Ollama (best-effort; falls back to keyword match)
templatesRouter.post("/intent", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text required" });
  const fallback = keywordMatch(text);
  try {
    const sys = "You translate a user task description into a JSON template intent. Respond with JSON only, no prose. Available templates and their inputs:\n" +
      templates.map(t => `- ${t.id}: ${t.title}. Inputs: ${t.inputs.length === 0 ? "(none)" : t.inputs.map(i => `${i.name}(${i.type}${i.required ? ",required" : ""})`).join(", ")}`).join("\n") +
      "\nReturn shape: {\"templateId\":\"<id>\",\"inputs\":{<name>:<value>}}. If you cannot determine, return {\"templateId\":null}.";
    const out = await ollamaGenerate(text, sys);
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed.templateId && templates.find(t => t.id === parsed.templateId)) {
        return res.json({ source: "ollama", templateId: parsed.templateId, inputs: parsed.inputs ?? {} });
      }
    }
  } catch {}
  res.json({ source: "keyword", templateId: fallback?.id ?? null, inputs: {} });
});

// Lightweight stopword set so generic words ("the", "and", "is") don't
// produce false-positive template matches. Without this, "compare X vs Y"
// scored 1 hit against search-brain (because "the" is in "Search the
// knowledge base") and got mis-routed to vault search.
const KEYWORD_STOPWORDS = new Set([
  "the", "and", "for", "with", "but", "not", "you", "this", "that", "from",
  "into", "over", "under", "than", "then", "have", "has", "had", "was", "were",
  "are", "all", "any", "some", "out", "off", "now", "new", "old", "one", "two",
  "what", "when", "where", "why", "how", "who", "which", "let", "let's", "lets",
  "can", "could", "would", "should", "will", "may", "might", "must", "shall",
  "between", "without", "within", "about", "above", "below", "after", "before",
]);

function keywordMatch(text: string): Template | null {
  const q = text.toLowerCase();
  let best: { t: Template; s: number } | null = null;
  for (const t of templates) {
    const hay = (t.title + " " + t.description + " " + t.role).toLowerCase();
    let s = 0;
    for (const w of q.split(/\s+/)) {
      if (w.length > 2 && !KEYWORD_STOPWORDS.has(w) && hay.includes(w)) s++;
    }
    if (!best || s > best.s) best = { t, s };
  }
  // Require at least 2 substantive hits before claiming a match — single-word
  // overlaps (e.g. just "files" hitting summarize-repo's description) are
  // too weak to confidently route. The caller treats null as "let chat fall
  // through to general-task", which is the correct behaviour for ad-hoc
  // questions that don't fit a built-in template.
  return best && best.s >= 2 ? best.t : null;
}

// Exported for chat router (avoids circular re-fetch)
export async function runFromChat(templateId: string, inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void) {
  return runner(templateId, inputs, push, progress);
}

async function runner(templateId: string, inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void): Promise<unknown> {
  switch (templateId) {
    case "summarize-repo": return summarizeRepoRunner(inputs, push);
    case "run-digest":     return runDigestRunner(inputs, push);
    case "publish-folder": return publishFolderRunner(inputs, push);
    case "search-brain":   return searchBrainRunner(inputs, push);
    case "add-note":       return addNoteRunner(inputs, push);
    case "browse-vault":   return { redirect: "/knowledge" };
    case "sync-downloads": return syncDownloadsRunner(inputs, push);
    case "daily-briefing": return dailyBriefingRunner(inputs, push, progress);
    case "innovation-scan": return innovationScanRunner(inputs, push, progress);
    case "buffer-story-post": return bufferStoryPostRunner(inputs, push, progress);
    case "social-optimize": return socialOptimizeRunner(inputs, push, progress);
    case "general-task":   return generalTaskRunner(inputs, push, progress);
    default: throw new Error(`no runner for ${templateId}`);
  }
}

async function summarizeRepoRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const repo = String(inputs.repo);
  const [owner, name] = repo.includes("/") ? repo.split("/") : [config.githubOwner, repo];
  push(`fetching activity for ${owner}/${name}`);
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  const [rd, commits, prs, issues] = await Promise.all([
    readme(owner, name), recentCommits(owner, name, since), openPRs(owner, name), openIssues(owner, name),
  ]);
  const parts: string[] = [`Repository: ${owner}/${name}`];
  if (rd) parts.push(`\nREADME (truncated):\n${rd.slice(0, 4000)}`);
  if (commits.length) parts.push(`\nRecent commits (${commits.length}):\n` + commits.slice(0, 30).map(c => `- ${c.sha} ${c.message}`).join("\n"));
  if (prs.length) parts.push(`\nOpen PRs (${prs.length}):\n` + prs.slice(0, 20).map(p => `- #${p.number} ${p.title}`).join("\n"));
  if (issues.length) parts.push(`\nOpen issues (${issues.length}):\n` + issues.slice(0, 20).map(i => `- #${i.number} ${i.title}`).join("\n"));
  push(`calling ollama (${config.ollamaModel})`);
  const summary = await ollamaGenerate(parts.join("\n"),
    "You are a senior engineer summarizing a repository for an Obsidian second brain. Output concise markdown with sections: ## Purpose (one sentence), ## Stack, ## State, ## Recent direction, ## Notable open work. No filler."
  );
  const today = new Date().toISOString().slice(0, 10);
  const md = `---\nrepo: ${owner}/${name}\ngenerated: ${today}\nmodel: ${config.ollamaModel}\n---\n\n# ${owner}/${name}\n\n${summary}\n`;
  const rel = `_clawbot/summaries/${owner}-${name}.md`;
  push(`writing ${rel}`);
  writeVaultFile(rel, md);
  push("committing + pushing vault");
  const r = await commitAndPush(`clawbot: summary ${owner}/${name}`);
  return { path: rel, ...r };
}

async function runDigestRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const lookback = String(inputs.lookbackDays ?? 7);
  push(`dispatching daily-digest workflow (lookback=${lookback})`);
  await dispatchWorkflow(config.githubOwner, "clawbot", "daily-digest.yml", "main", { lookback_days: lookback });
  push("workflow_dispatch sent — track progress on GitHub Actions");
  return { dispatched: true, lookbackDays: lookback };
}

async function publishFolderRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const path = String(inputs.path).trim();
  const isPublic = Boolean(inputs.public);
  let repoName = String(inputs.name ?? "").trim();
  if (!path) throw new Error("missing 'path'");
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`folder not found: ${full}`);
  if (!repoName) repoName = sanitizeName(basename(full));
  push(`target: ${full} → ${config.githubOwner}/${repoName} (${isPublic ? "public" : "private"})`);

  const git = simpleGit(full);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) {
    push("initializing local git repo");
    await git.init();
    await git.add(".");
    await git.commit("initial import");
  } else {
    const status = await git.status();
    if (status.files.length > 0) {
      push("staging local changes");
      await git.add(".");
      await git.commit("clawbot: snapshot before publish");
    }
  }

  let cloneUrl: string;
  try {
    push(`creating repo ${config.githubOwner}/${repoName}`);
    const { data } = await octokit.repos.createForAuthenticatedUser({
      name: repoName, private: !isPublic,
      description: `Auto-published by clawbot from local folder: ${basename(full)}`,
    });
    cloneUrl = data.clone_url;
  } catch (err: any) {
    if (err.status === 422) {
      push(`repo ${config.githubOwner}/${repoName} already exists, reusing`);
      cloneUrl = `https://github.com/${config.githubOwner}/${repoName}.git`;
    } else { throw err; }
  }

  const remoteUrl = cloneUrl.replace("https://", `https://x-access-token:${config.githubToken}@`);
  const remotes = await git.getRemotes();
  if (remotes.find(r => r.name === "origin")) await git.removeRemote("origin");
  await git.addRemote("origin", remoteUrl);
  const branch = (await git.branchLocal()).current || "main";
  push(`pushing ${branch} to origin`);
  await git.push(["-u", "origin", branch]);
  return { repo: `${config.githubOwner}/${repoName}`, branch, public: isPublic };
}

async function searchBrainRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const q = String(inputs.query);
  push(`searching vault for "${q}"`);
  let results;
  try {
    results = searchVault(q);
  } catch (e: any) {
    if (e instanceof VaultUnreachable) {
      push(`vault unreachable: ${e.vaultPath}`);
      const answer = `I couldn't search your vault — the configured path **${e.vaultPath}** doesn't resolve on this machine. Common causes: the drive is unmounted (e.g. D: was unplugged on Windows), the folder was renamed, or \`VAULT_PATH\` in \`.env\` doesn't match your actual vault. Mount the drive (or fix the path) and try again.`;
      return { query: q, results: [], count: 0, vaultUnreachable: true, vaultPath: e.vaultPath, answer };
    }
    throw e;
  }
  push(`${results.length} match${results.length === 1 ? "" : "es"}`);
  // Build a human-readable `answer` so consumers (chat UI, harness, journal)
  // get a real summary instead of just a raw results array. Without this,
  // anything that read `result.answer` saw `undefined` and fell back to the
  // "On it — running..." chat ack.
  let answer: string;
  if (results.length === 0) {
    answer = `No notes in your vault match **${q}**. Try a broader term, check the spelling, or add a note on this topic and search again.`;
  } else {
    const top = results.slice(0, 8);
    const list = top.map((r, i) => {
      const preview = r.preview.replace(/\s+/g, " ").trim().slice(0, 160);
      return `${i + 1}. **${r.path}**${r.line ? ` (line ${r.line})` : ""} — ${preview}`;
    }).join("\n");
    const remaining = results.length - top.length;
    const more = remaining > 0 ? `\n\n_… and ${remaining} more match${remaining === 1 ? "" : "es"}._` : "";
    answer = `Found **${results.length}** note${results.length === 1 ? "" : "s"} mentioning **${q}**:\n\n${list}${more}`;
  }
  return { query: q, results, answer };
}

async function addNoteRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const title = String(inputs.title);
  const body = String(inputs.body);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";
  const rel = `0-Inbox/${stamp}-${slug}.md`;
  const today = new Date().toISOString().slice(0, 10);
  const md = `---\ntitle: ${title}\ncreated: ${today}\nsource: neuroworks\n---\n\n# ${title}\n\n${body}\n`;
  push(`writing ${rel}`);
  writeVaultFile(rel, md);
  push("committing vault");
  const r = await commitAndPush(`note: ${title}`);
  return { path: rel, ...r };
}

export async function generalTaskRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void) {
  const task = String(inputs.task ?? "").trim();
  if (!task) throw new Error("missing 'task' input");
  const saveAs = inputs.save_as_template !== false;
  const testMode = inputs.testMode === true;
  // Optional persona pin (`_personaId` input) — scheduled runs use it so a
  // dedicated employee (e.g. the innovation-scan researcher) does the work
  // regardless of who happens to be the org-wide ACTIVE persona that morning.
  let persona = getActivePersona();
  const pinId = typeof inputs._personaId === "string" ? inputs._personaId.trim() : "";
  if (pinId) {
    const pinned = (loadPersonas().personas ?? []).find((p: any) => p.id === pinId || p.name?.toLowerCase() === pinId.toLowerCase());
    if (pinned) persona = pinned;
    else push(`Persona "${pinId}" not found — falling back to the active persona.`);
  }
  const personaSuffix = personaSystemSuffix(persona);
  if (persona) push(`Working as ${persona.name} — ${persona.role}.`);
  // Cancellation signal — passed through inputs._signal (runtime-only, not
  // persisted) so the operator's Cancel Run stops the local agent loop too,
  // not just delegated runs.
  const signal = inputs._signal instanceof AbortSignal ? inputs._signal : undefined;
  const r = await planAndExecute(task, push, (patch) => progress?.(patch as Record<string, unknown>), { personaSystemSuffix: personaSuffix, workMode: persona?.workMode, testMode, signal, taskKind: "insights:general-task", persona: persona?.name });

  // If the agent wrote anything to the vault, also commit + push
  if (r.hadWrites) {
    push("Wrote to your second brain — committing the changes.");
    try {
      const c = await commitAndPush(`clawbot: agent task — ${task.slice(0, 60)}`);
      push(`Vault commit: ${(c as any)?.ok === false ? "failed" : "done"}${(c as any)?.sha ? ` (${String((c as any).sha).slice(0, 7)})` : ""}.`);
    } catch (e: any) { push(`Commit didn't go through (non-fatal): ${e.message ?? e}.`); }
  }

  let savedTemplateId: string | undefined;
  const allOk = r.runs.length > 0 && r.runs.every(x => x.ok);
  if (saveAs && allOk && r.plan.steps.length > 0) {
    const id = `custom-${slugify(task)}`;
    const tpl: CustomTemplate = {
      id, role: "Custom",
      title: r.plan.summary || task.slice(0, 80),
      description: `Saved from chat: "${task}"`,
      origin: { task, createdAt: new Date().toISOString() },
      plan: r.plan,
      runCount: 1, lastRunAt: new Date().toISOString(),
    };
    saveCustomTemplate(tpl);
    savedTemplateId = id;
    push(`Saved this workflow as a reusable template: ${id}.`);
  }

  return {
    answer: r.answer,
    plan: r.plan,
    // Preserve the full StepRun shape on the final result — the frontend uses
    // step.label, run.startedAt, and run.modelUsed during render, and the vault
    // journal reads run.modelUsed. Drop run.result to keep the payload small;
    // primitives can return large blobs and we already have the synthesised
    // answer above.
    runs: r.runs.map(x => ({
      step: x.step,
      ok: x.ok,
      durationMs: x.durationMs,
      error: x.error,
      startedAt: x.startedAt,
      modelUsed: x.modelUsed,
    })),
    review: r.review,
    quality: r.quality,
    security: r.security,
    skillUsed: r.skillUsed,
    skillScore: r.skillScore,
    savedTemplateId,
    // Must survive this re-shape: runJob keys the waiting_on_human status off
    // result.humanRequest — dropping it here silently marked paused tasks as
    // succeeded (the bug the first live test caught).
    humanRequest: r.humanRequest,
    // Likewise for the sensitive-action checkpoint — runJob parks the job in
    // awaiting-approval off result.approvalRequired. Dropping it here would let
    // a db/connector/email plan slip straight to "succeeded" with an empty
    // answer, never actually gated.
    approvalRequired: r.approvalRequired,
  };
}

// Innovation scan — the org's R&D employee on a schedule. A researched,
// sourced report on ways to improve NeuroWorks: agent-AI techniques, AI
// innovations, useful APIs, and GitHub repos worth adopting. The next daily
// briefing attaches the latest scan (see dailyBriefingRunner below +
// calendar.plan_day's `innovation` field). `_personaId` pins the run to the
// research employee; `focus` narrows the sweep.
// Read recent notes out of the vault's 0-Inbox (research clippings, captures,
// whatever the user drops in) so the innovation scan has LOCAL signal to mine,
// not just web search. Recursive, newest-first by mtime, capped in both count
// and per-note chars to keep the prompt budget sane. Returns [] (never throws)
// when the vault is unreachable or the folder doesn't exist.
function gatherRecentInboxNotes(sinceMs: number, cap = 10): { path: string; mtime: string; text: string }[] {
  return gatherRecentNotesUnder(["0-Inbox", "0-inbox", "Inbox", "inbox"], sinceMs, cap);
}

// Recent session transcripts — every chat/email/brief run journals a note under
// _neuroworks/session/. The innovation scan mines these so its report is
// grounded in (and can cite) what the org has actually been asking the agents,
// not just web headlines — and so "summarise the innovation scan" has real
// session signal to reference instead of timing out on fresh web research.
function gatherRecentSessionNotes(sinceMs: number, cap = 8): { path: string; mtime: string; text: string }[] {
  return gatherRecentNotesUnder(["_neuroworks/session", "_neuroworks/sessions", "session", "sessions"], sinceMs, cap);
}

// A real innovation scan is an opportunities / techniques / APIs / repos report.
// A mis-run that produced off-topic content (e.g. a drafted welcome email — live
// 2026-07-27) must NOT be surfaced by the daily brief as "opportunities". Guard
// the briefing: only treat the latest scan as valid when its shape matches.
function looksLikeInnovationReport(answer: string): boolean {
  const t = answer.toLowerCase();
  const signals = ["opportunit", "## summary", "top 3", "top three", "technique", "github repo", "watchlist", "adopt", "integrat"];
  const hits = signals.filter(s => t.includes(s)).length;
  return answer.length > 200 && hits >= 2;
}

function gatherRecentNotesUnder(roots: string[], sinceMs: number, cap = 10): { path: string; mtime: string; text: string }[] {
  const out: { path: string; mtime: number; text: string }[] = [];
  const seen = new Set<string>();
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childAbs = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(childAbs, childRel, depth + 1); continue; }
      if (!/\.(md|markdown|txt)$/i.test(e.name)) continue;
      if (seen.has(childRel)) continue;
      try {
        const st = statSync(childAbs);
        if (st.mtimeMs < sinceMs) continue;
        seen.add(childRel);
        out.push({ path: childRel, mtime: st.mtimeMs, text: readFileSync(childAbs, "utf8").slice(0, 2500) });
      } catch { /* skip unreadable */ }
    }
  };
  for (const root of roots) {
    const abs = resolve(config.vaultPath, root);
    if (existsSync(abs)) walk(abs, root, 0);
  }
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, cap)
    .map(n => ({ path: n.path, mtime: new Date(n.mtime).toISOString().slice(0, 10), text: n.text }));
}

async function innovationScanRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void) {
  const focus = String(inputs.focus ?? "").trim();
  const today = new Date().toISOString().slice(0, 10);

  // Local signal — recent 0-Inbox notes read as PRIMARY evidence. Grounds the
  // scan in what's actually landing in the vault instead of leaning entirely on
  // web search (which returned nothing for our private product name — the "zero
  // results" failure the last scan hit). Window: last 10 days by default, which
  // covers the inbox files the briefing flagged as unread.
  const sinceDays = Number(inputs.inboxDays ?? 10);
  let inboxBlock = "";
  try {
    const notes = gatherRecentInboxNotes(Date.now() - sinceDays * 86400_000, 10);
    if (notes.length > 0) {
      push(`Read ${notes.length} recent inbox note${notes.length === 1 ? "" : "s"} from the vault as local signal.`);
      inboxBlock = "\n\nAttached documents (recent 0-Inbox notes — treat these as PRIMARY evidence; they're what's actually landing in the vault):\n\n" +
        notes.map((n, i) => `[Note ${i + 1}: ${n.path} · ${n.mtime}]\n${n.text}`).join("\n\n---\n\n");
    } else {
      push("No recent inbox notes in the window — running a web-only scan.");
    }
  } catch (e: any) { push(`Inbox read skipped (non-fatal): ${String(e?.message ?? e).slice(0, 80)}`); }

  // Session transcripts as SECONDARY local signal — grounds the scan in what the
  // org has actually been asking for and lets the report cite those sessions.
  let sessionBlock = "";
  try {
    const sessions = gatherRecentSessionNotes(Date.now() - sinceDays * 86400_000, 8);
    if (sessions.length > 0) {
      push(`Read ${sessions.length} recent session note${sessions.length === 1 ? "" : "s"} for context.`);
      sessionBlock = "\n\nAttached documents (recent session transcripts — SECONDARY signal; use to ground the scan in real usage and cite the session path when a finding traces to one):\n\n" +
        sessions.map((n, i) => `[Session ${i + 1}: ${n.path} · ${n.mtime}]\n${n.text}`).join("\n\n---\n\n");
    }
  } catch (e: any) { push(`Session read skipped (non-fatal): ${String(e?.message ?? e).slice(0, 80)}`); }

  const task =
    `Produce a professional innovation-scan REPORT (a polished document, not notes) on ways to improve our AI-workforce platform (local-first agents on Ollama plus routed cloud LLMs, deterministic plan builders, a knowledge vault with RAG, connectors/data-sources to external systems, schedules, and a human-in-the-loop layer). Date: ${today}.${focus ? ` Focus this scan on: ${focus}.` : ""}\n\n` +
    `EVIDENCE PRIORITY: the attached inbox + session notes below are PRIMARY evidence — read and mine them first. Keep web research SHALLOW (1-2 focused queries per lane, not a deep crawl) so the report is delivered promptly; the attached local signal plus a light web pass is enough. Do NOT run an exhaustive multi-page search.\n\n` +
    `SEARCH GENERICALLY. Do NOT web-search our product/component names — they're private and return nothing. Search the CAPABILITY topics with broad, current INDUSTRY terms:\n` +
    `1. Agentic-AI techniques — e.g. "LLM agent planning", "tool use", "multi-agent orchestration", "agent memory", "agent evaluation" (favour the last ~60 days).\n` +
    `2. AI/model innovations — new open models, inference/cost/latency wins for a local-first (Ollama) stack.\n` +
    `3. APIs worth integrating — services that extend what local agents can do for a Zimbabwean SME.\n` +
    `4. GitHub repos — actively maintained agent / RAG / orchestration projects to adopt or borrow from (note license + last activity).\n\n` +
    `Write the report as a clean markdown DOCUMENT with these sections, in this order:\n` +
    `## Summary — 3-5 sentence executive summary of the scan: the single biggest opportunity, the overall theme, and what to act on first. Write this FIRST so a reader gets the gist without scrolling.\n` +
    `## Top 3 opportunities — each: what it is, why it helps us specifically, effort guess (S/M/L)\n` +
    `## Agent & AI techniques\n## APIs\n## GitHub repos — name, one-line pitch, license, last-activity signal\n` +
    `## Signals from our own usage — what the attached inbox/session notes reveal we keep asking for; cite the note/session path for each.\n` +
    `## Watchlist — early signals not worth acting on yet\n\n` +
    `Professional tone: full prose, no raw JSON, no plan dumps, no meta-commentary about tools or time limits. Every external claim needs its source cited; every internal signal cites the note/session path. Be selective — 5 strong finds beat 20 headlines. If a lane genuinely turned up nothing, say so in one line.` +
    inboxBlock + sessionBlock;
  const result: any = await generalTaskRunner({ task, save_as_template: false, _personaId: inputs._personaId }, push, progress);

  // Also surface SHAREABLE STORY LEADS for the daily social posts. The scan
  // already researched the field; distil it (plus a light web sweep) into a
  // handful of concrete, linkable leads and save them to the social story-leads
  // file. buffer-story-post reads this as fallback material when the source
  // mailbox has nothing fresh — so the innovation scan feeds the daily posts.
  try {
    const scanText = String(result?.answer ?? "").slice(0, 4000);
    const web = await gatherFallbackStories(push);
    const webBlock = web.map(s => `- ${s.title}: ${s.text}${s.url ? ` (${s.url})` : ""}`).join("\n");
    const material = [scanText ? `INNOVATION SCAN REPORT:\n${scanText}` : "", webBlock].filter(Boolean).join("\n\n");
    if (material.trim()) {
      const leads = (await llmGenerate(
        `From the material below, extract 5-8 SHAREABLE STORY LEADS for AI Institute Africa's social channels — each a real, recent, postable story (AI/tech, ideally African-relevant). For each: a one-line summary of the actual substance + the source URL if one exists in the material. Output a markdown bullet list ONLY, newest/strongest first, no preamble. Never invent a URL — omit the link if none is present.\n\nMATERIAL:\n\n${material.slice(0, 6000)}`,
        "You distil research into concrete, linkable social story leads. Factual, no hype, no invented links.",
        { maxTokens: 700 },
      )).trim();
      if (leads && leads.length > 40) {
        const doc = `---\ntype: social-story-leads\ngenerated: ${new Date().toISOString()}\nsource: innovation-scan\n---\n\n# Story leads for social posts\n\n${leads}\n`;
        writeVaultFile(`${SOCIAL_DIR}/story-leads.md`, doc);
        push(`Saved ${(leads.match(/^\s*[-*]/gm) ?? []).length} story leads for the daily social posts (${SOCIAL_DIR}/story-leads.md).`);
      }
    }
  } catch (e: any) { push(`Story-lead extraction skipped (non-fatal): ${String(e?.message ?? e).slice(0, 100)}`); }
  return result;
}

// ─── Social content loop (email → Buffer draft) + self-improving optimiser ───
// Two scheduled templates that form a feedback loop:
//   buffer-story-post: read a source mailbox → pick the strongest story → draft a
//     platform-native post → put it on Buffer (as a DRAFT for human review by
//     default; auto-queue is an explicit opt-in).
//   social-optimize:  read what's actually been posted (Buffer posts:read) + any
//     engagement (insights:read, if the token grants it) → rewrite a strategy note
//     that the drafter reads next run. That note is the "learning" that closes the
//     loop.
const SOCIAL_DIR = "_neuroworks/social";
const SOCIAL_STRATEGY_REL = `${SOCIAL_DIR}/strategy.md`;

// AIIA brand values — every post + video must reflect these. Stated by the org:
// African unity, Ubuntu, inclusion, and "AI for a better Africa". Kept inline so
// the voice is consistent even before a formal brand-guidelines doc exists; any
// brand doc found in the vault (gatherBrandContext) augments this.
const AIIA_VALUES =
  `AI Institute Africa (AIIA) brand values — reflect ALL of these in tone and framing:\n` +
  `• African unity & pride — celebrate African innovation and shared progress.\n` +
  `• Ubuntu ("I am because we are") — community over individualism; speak WITH people, not down to them.\n` +
  `• Inclusion & accessibility — bring everyone along, especially the underserved; plain, welcoming language.\n` +
  `• AI for a better Africa — practical, ethical technology that uplifts Zimbabwean & African communities.\n` +
  `Voice: warm, hopeful, grounded, credible. Never hype-y, never a colonial/"saviour" framing, no empty buzzwords.`;

// Pull the AIIA brand guidelines from company knowledge so posts + videos match
// the real brand. The guidelines live as a PDF in `_company/`; we read the
// text-extracted companion (created 2026-07-28) directly — vault.search doesn't
// index PDF binaries, so a direct read is the reliable path. Falls back to a
// vault.search sweep if the known files aren't present.
async function gatherBrandContext(push: (m: string) => void): Promise<string> {
  // 1) Known extracted company docs, read directly (most reliable).
  const known = ["_company/aiia_brand_guidlines.extracted.md", "_company/aiia_brand_guidelines.extracted.md"];
  for (const rel of known) {
    const txt = readVaultText(rel);
    if (txt && txt.trim().length > 100) {
      push("Grounded on the AIIA brand guidelines from company knowledge.");
      return `\n\nAIIA BRAND GUIDELINES (from company knowledge — honour these exactly):\n${txt.replace(/^---[\s\S]*?---\n/, "").trim().slice(0, 2600)}`;
    }
  }
  // 2) Fallback: search the vault for a brand/company doc.
  try {
    const prim = findPrimitive("vault.search");
    if (!prim) return "";
    const seen = new Set<string>(); const snippets: string[] = [];
    for (const q of ["AIIA brand guidelines voice values", "AI Institute Africa brand tone", "company profile mission"]) {
      const r: any = await prim.handler({ query: q });
      for (const m of (r?.results ?? r?.matches ?? [])) {
        const path = m.path ?? m.file ?? ""; if (!path || seen.has(path)) continue; seen.add(path);
        const text = String(m.snippet ?? m.excerpt ?? m.text ?? "").replace(/\s+/g, " ").trim();
        if (text) snippets.push(`[${path}] ${text.slice(0, 300)}`);
        if (snippets.length >= 3) break;
      }
      if (snippets.length >= 3) break;
    }
    if (snippets.length) { push(`Grounded on ${snippets.length} brand/company note(s) from the vault.`); return `\n\nAIIA BRAND / COMPANY NOTES from the knowledge base (honour these):\n${snippets.join("\n")}`; }
  } catch { /* non-fatal */ }
  return "";
}

function readVaultText(rel: string): string | null {
  try {
    const abs = resolve(config.vaultPath, rel);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8");
  } catch { return null; }
}

// Pull recent emails from a specific sender. Tries the IMAP mailbox first
// (NEUROWORKS_EMAIL_* — the org inbox), then a Gmail connection if present.
// Filters client-side by sender substring so a display-name or +alias still
// matches. Returns newest-first, deduped by subject+date.
type SenderEmail = { from: string; subject: string; date: string; body: string; links: string[] };
async function gatherSenderEmails(sender: string, days: number, push: (m: string) => void): Promise<SenderEmail[]> {
  const want = sender.toLowerCase();
  const out: SenderEmail[] = [];
  const seen = new Set<string>();
  const add = (from: string, subject: string, date: string, body: string, links: string[] = []) => {
    const key = `${subject}|${date}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from, subject, date, body, links });
  };
  // IMAP mailbox — read recent (not just unread) so we don't miss stories the
  // operator already opened. bodyChars>240 pulls the FULL body + extracted story
  // links so we can summarise the actual story, not a 240-char preview (the old
  // truncation is why drafts drifted onto Aiia's own events instead of the story).
  try {
    const prim = findPrimitive("inbox.read_unread");
    if (prim) {
      const r: any = await prim.handler({ limit: 50, unreadOnly: false, bodyChars: 9000 });
      for (const m of (r?.messages ?? [])) {
        if (String(m.from ?? "").toLowerCase().includes(want)) add(m.from ?? "", m.subject ?? "", m.date ?? "", m.body || m.preview || "", Array.isArray(m.links) ? m.links : []);
      }
    }
  } catch (e: any) { push(`IMAP read skipped (non-fatal): ${String(e?.message ?? e).slice(0, 80)}`); }
  // Gmail connection — server-side sender+recency filter via search query.
  try {
    const prim = findPrimitive("integration.gmail.read");
    if (prim) {
      const r: any = await prim.handler({ query: `from:${sender} newer_than:${Math.max(1, days)}d`, maxResults: 25 });
      for (const m of (r?.messages ?? [])) {
        const snip = String(m.snippet ?? "");
        add(m.from ?? "", m.subject ?? "", m.date ?? "", snip, (snip.match(/https?:\/\/[^\s)>\]]+/g) ?? []).map((u: string) => u.replace(/[.,]$/, "")));
      }
    }
  } catch { /* no gmail connection — fine, IMAP is the primary path */ }
  // Recency filter (best-effort — some providers give unparseable dates; keep those).
  const cutoff = Date.now() - Math.max(1, days) * 86400_000;
  const recent = out.filter(m => { const t = Date.parse(m.date); return Number.isNaN(t) ? true : t >= cutoff; });
  return recent
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    .slice(0, 20);
}

// Strip hashtags, links and surrounding quotes → a clean spoken script for the
// avatar video. Keeps the sentences, drops the social furniture.
function toVideoScript(postText: string): string {
  return postText
    .replace(/https?:\/\/\S+/g, "")
    .replace(/#[\w-]+/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

type StorySource = { title: string; url?: string; text: string; links?: string[] };

// Draft ONE polished post + AIIA-values video script from a NUMBERED list of
// real stories (emails carry the full body + a pool of real links). The model
// PICKS a story, summarises ONLY that story (~10 lines), and names WHICH real
// link (by number) belongs to it — we then validate that link against the
// source's real link pool, so a hallucinated URL is impossible and the summary
// is grounded in the source, never in Aiia's own background events.
async function draftSocialPost(system: string, o: {
  strategy: string | null; targetsLabel: string; slot: string;
  sources: StorySource[]; recentBlock: string; allowNoFresh: boolean;
}): Promise<{ postText: string; videoScript: string; story: string; nofresh: boolean; error?: string }> {
  if (!o.sources.length) return { postText: "", videoScript: "", story: "", nofresh: true };
  // Build a flat, numbered pool of the real links available across all sources,
  // so the model can reference a link by index and we resolve the real URL.
  const linkPool: string[] = [];
  const numbered = o.sources.map((s, i) => {
    const srcLinks = Array.from(new Set([...(s.links ?? []), ...(s.url ? [s.url] : [])]));
    const linkLines = srcLinks.map(u => { linkPool.push(u); return `   L${linkPool.length}: ${u}`; }).join("\n");
    return `[${i + 1}] ${s.title}\n${s.text.replace(/\s+/g, " ").slice(0, 1400)}${linkLines ? `\n  links:\n${linkLines}` : "\n  (no link)"}`;
  }).join("\n\n---\n\n");
  const prompt =
    `You are drafting ONE social post from the NUMBERED sources below${o.slot ? ` (the ${o.slot} post)` : ""}, for ${o.targetsLabel}, plus an avatar-video script.\n\n` +
    `STEP 1 — pick the SINGLE most newsworthy, shareable STORY that appears in the sources (a newsletter/briefing source may contain several stories — pick the best ONE inside it).\n` +
    `STEP 2 — summarise THAT story in about 10 lines using ONLY facts from the source text.\n\n` +
    `HARD RULES:\n` +
    `- Summarise ONLY the chosen story. Do NOT write about Aiia's own events, summits, or programmes from background knowledge — Aiia appears ONLY in the "why it impacts Africa" section as commentary.\n` +
    `- Never invent facts, names, statistics, or URLs. The link MUST be one of the numbered links (Ln) listed under the source; give its number, not a URL you typed.\n\n` +
    `Output EXACTLY these lines, in order, as PLAIN TEXT (no markdown, no angle brackets, do not echo these instructions or label words):\n` +
    `PICK: <source number>\n` +
    `LINKREF: <the Ln number of the story's link, or "none" if the source has no link>\n` +
    `CAPTION: <one engaging line, max ~120 chars, hooking the story itself — no "Incredible!/must-read" hype>\n` +
    `SUMMARY: <about 10 lines summarising the chosen story's substance — what happened, who, the details, the implication. Aiia's brand VOICE, but factual and about the STORY, not about Aiia.>\n` +
    `WHY_AFRICA: <2-4 sentences: why this story matters for Africa and how it connects to Aiia's mission of "AI for a better Africa" — THIS is the only place Aiia is mentioned.>\n` +
    `HASHTAGS: <3-5 Aiia hashtags on one line, space-separated, e.g. "#AIforAfrica #Aiia #AI #Africa">\n` +
    `VIDEO_SCRIPT: <20-35s of spoken narration that NARRATES THE SAME SUMMARY, first person "At Aiia…", in Aiia's voice (inclusion, ethics, innovation, AI for a better Africa). No URLs, no hashtags, no stage directions.>\n\n` +
    (o.allowNoFresh
      ? `Prefer a story NOT in the ALREADY POSTED list. If all are already posted, still PICK the best unused one. Reply exactly "NOFRESH" ONLY if the sources contain no usable story at all.\n\n`
      : `You MUST pick a story — do NOT reply "NOFRESH".\n\n`) +
    (o.strategy ? `POSTING STRATEGY (learned from past performance — follow it):\n${o.strategy.slice(0, 1500)}\n\n` : "") +
    o.recentBlock +
    `\n\nSOURCES:\n\n${numbered}`;
  let raw = "";
  try { raw = (await llmGenerate(prompt, system, { maxTokens: 1100 })).trim(); }
  catch (e: any) { return { postText: "", videoScript: "", story: "", nofresh: false, error: String(e?.message ?? e).slice(0, 160) }; }
  if (/^\s*NOFRESH\b/i.test(raw)) return { postText: "", videoScript: "", story: "", nofresh: true };

  const LABELS = "PICK|LINKREF|CAPTION|SUMMARY|WHY[_ ]?AFRICA|HASHTAGS?|VIDEO[_ ]?SCRIPT|STORY|LINK";
  const grab = (label: string) => {
    // Tolerate the model writing "WHY AFRICA"/"VIDEO SCRIPT" (space) where we
    // asked for underscores — otherwise that section silently drops out.
    const flexLabel = label.replace(/_/g, "[_ ]?");
    const m = raw.match(new RegExp(`^[\\s>*#-]*${flexLabel}\\s*:?\\s*([\\s\\S]*?)(?=\\n[\\s>*#-]*(?:${LABELS})\\s*:|$)`, "im"));
    return (m?.[1] ?? "")
      .replace(/```[a-z]*\n?/gi, "").replace(/\*\*/g, "").replace(/<\/?[^>]+>/g, "")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$2")
      .trim().replace(/^["']|["']$/g, "").trim();
  };
  const pickN = parseInt((grab("PICK").match(/\d+/) ?? ["1"])[0], 10);
  const chosen = o.sources[Math.min(Math.max(1, pickN), o.sources.length) - 1] ?? o.sources[0];
  // Resolve the link: the model gives an Ln index into the real link pool -> we
  // use the actual URL. Fall back to the chosen source's own url. Never a typed URL.
  const linkRef = parseInt((grab("LINKREF").match(/\d+/) ?? [""])[0], 10);
  const chosenLink = (Number.isInteger(linkRef) && linkPool[linkRef - 1]) ? linkPool[linkRef - 1] : (chosen.url ?? "");
  const demeta = (s: string) => s.replace(/^\s*(aiia'?s?\s+)?(angle|caption|summary|hook|story)\s*(on|:|-)?\s*/i, "").trim();
  const caption = demeta(grab("CAPTION").split("\n")[0]).replace(/^["']|["']$/g, "").trim();
  const summary = grab("SUMMARY").replace(/\n{3,}/g, "\n\n").trim();
  const whyAfrica = grab("WHY_AFRICA").replace(/\n{2,}/g, " ").trim();
  let hashtags = grab("HASHTAGS").split("\n")[0].replace(/[,;]/g, " ").replace(/\s+/g, " ").trim();
  if (hashtags && !/#/.test(hashtags)) hashtags = hashtags.split(/\s+/).filter(Boolean).map(h => `#${h.replace(/^#/, "")}`).join(" ");
  const videoScript = grab("VIDEO_SCRIPT").replace(/https?:\/\/\S+/g, "").replace(/#[\w-]+/g, "").trim();
  if (!caption && !summary) return { postText: "", videoScript: "", story: "", nofresh: false, error: "unparseable draft" };
  // Assemble: caption -> ~10-line summary -> real link -> "Why it impacts Africa"
  // (the Aiia section) -> hashtags. The video narrates the same summary.
  const postText = [
    caption,
    summary,
    chosenLink || "",
    whyAfrica ? `Why it impacts Africa\n${whyAfrica}` : "",
    hashtags,
  ].filter(Boolean).join("\n\n").trim();
  const story = `${chosen.title}${chosenLink ? ` — ${chosenLink}` : ""}`.replace(/\s+/g, " ").slice(0, 220);
  return { postText, videoScript, story, nofresh: false };
}

// Fallback story material when the source mailbox has nothing fresh: a live web
// sweep for African-AI news (each result carries a REAL url), plus any story
// leads saved by the innovation scan. Returns real stories so the draft always
// has a genuine link to reference. Guarantees there's always something to post.
async function gatherFallbackStories(push: (m: string) => void): Promise<StorySource[]> {
  const out: StorySource[] = []; const seen = new Set<string>();
  try {
    const prim = findPrimitive("web.search");
    if (prim) {
      for (const q of ["African AI news", "artificial intelligence Africa innovation", "AI policy Africa", "Zimbabwe AI technology", "AI Africa startup funding"]) {
        const r: any = await prim.handler({ query: q, limit: 5 });
        for (const it of (r?.results ?? [])) {
          const url = it?.url ? String(it.url).replace(/[.,]$/, "") : "";
          if (!url || seen.has(url)) continue; seen.add(url);
          out.push({ title: String(it.title ?? "Untitled").slice(0, 160), url, text: String(it.snippet ?? "").slice(0, 400) });
        }
        if (out.length >= 12) break;
      }
      if (out.length) push(`Web-search fallback gathered ${out.length} real candidate stories.`);
    }
  } catch (e: any) { push(`Web-search fallback skipped: ${String(e?.message ?? e).slice(0, 80)}`); }
  // Innovation-scan leads as extra candidates (bullet lines → title + optional url).
  const leads = readVaultText(`${SOCIAL_DIR}/story-leads.md`);
  if (leads && leads.trim().length > 80) {
    for (const line of leads.split("\n")) {
      const t = line.replace(/^\s*[-*]\s*/, "").trim();
      if (t.length < 25 || /^#/.test(line)) continue;
      const url = (t.match(/https?:\/\/[^\s)>\]]+/) ?? [""])[0].replace(/[.,]$/, "");
      if (url && seen.has(url)) continue; if (url) seen.add(url);
      out.push({ title: t.replace(/https?:\/\/\S+/g, "").replace(/[()]/g, "").slice(0, 160).trim(), url: url || undefined, text: t.slice(0, 400) });
      if (out.length >= 16) break;
    }
    push("Added innovation-scan story leads to the candidate pool.");
  }
  return out;
}

async function bufferStoryPostRunner(inputs: Record<string, unknown>, push: (m: string) => void, _progress?: (p: Record<string, unknown>) => void) {
  const sender = String(inputs.sender ?? "").trim();
  const days = Number(inputs.days ?? 3);
  const channels = String(inputs.channels ?? "").trim(); // csv services/ids; blank = all
  const autoQueue = inputs.autoQueue === true; // default false → save as Buffer DRAFT for review
  const makeVideo = inputs.makeVideo !== false; // default true → HeyGen avatar video
  const reviewTelegram = inputs.reviewTelegram !== false; // default true → post to the Telegram group
  const reviewEmail = String(inputs.reviewEmail ?? "").trim();
  const slot = String(inputs.slot ?? "").trim(); // "morning" | "midday" | "evening" — for 3×/day variety
  const stamp = new Date().toISOString().slice(0, 16).replace(":", "");

  push(`Scanning email from ${sender} (last ${days}d) for stories to post${slot ? ` (${slot} slot)` : ""}.`);
  const emails = await gatherSenderEmails(sender, days, push);
  if (emails.length) push(`Found ${emails.length} message${emails.length === 1 ? "" : "s"} from ${sender} — picking the strongest story.`);
  else push(`No emails from ${sender} in the last ${days} days — will fall back to story leads + web search.`);

  // Dedup: this schedule runs 3×/day, so read the recent draft journals and tell
  // the model NOT to repeat a story already turned into a post. Without this the
  // "strongest story" would win every slot and we'd post the same thing thrice.
  // ignoreRecent bypasses this (manual "post anyway" / testing).
  let recentBlock = "";
  if (inputs.ignoreRecent !== true) try {
    const recent = gatherRecentNotesUnder([`${SOCIAL_DIR}/drafts`], Date.now() - 3 * 86400_000, 12);
    const priorPosts = recent
      .map(n => { const m = n.text.match(/##\s*Post\s*\n+([\s\S]*?)\n+##/i); return (m?.[1] ?? "").trim().replace(/\s+/g, " ").slice(0, 160); })
      .filter(Boolean);
    if (priorPosts.length) recentBlock = `\n\nALREADY POSTED in the last 3 days — do NOT repeat any of these stories; choose a DIFFERENT one:\n` + priorPosts.map((p, i) => `${i + 1}. ${p}`).join("\n");
  } catch { /* non-fatal */ }

  const strategy = readVaultText(SOCIAL_STRATEGY_REL);
  const brand = await gatherBrandContext(push);
  const targetsLabel = channels || "all connected channels (twitter, linkedin, tiktok)";
  const system =
    "You are the social-media editor for Aiia — Artificial Intelligence Institute Africa, an NGO whose vision is \"AI for a better Africa\". You turn source material into ONE accurate, platform-native social post PLUS a short avatar-video script. You summarise the actual substance of a story (what happened, who, why it matters for Africa) — never clickbait, never hype, never invented facts. Warm, credible, grounded; inclusive; British/African English.\n\n" +
    AIIA_VALUES + brand;

  // Draft source priority: (1) a fresh email story; (2) any unused email story;
  // (3) innovation-scan leads + a live web sweep — so there is ALWAYS a story.
  let d: { postText: string; videoScript: string; story: string; nofresh: boolean; error?: string } | null = null;
  let sourceUsed = sender;
  if (emails.length) {
    const emailSources: StorySource[] = emails.map(e => ({
      title: e.subject || "(no subject)",
      text: e.body,
      links: e.links ?? [],
    }));
    push("Drafting the post + video script from email.");
    d = await draftSocialPost(system, { strategy, targetsLabel, slot, sources: emailSources, recentBlock, allowNoFresh: true });
  }
  if (!d || d.nofresh || !d.postText) {
    push("No fresh email story — pulling web search + innovation-scan leads as fallback.");
    const fb = await gatherFallbackStories(push);
    if (fb.length) {
      sourceUsed = "web + innovation leads";
      push("Drafting the post + video script from fallback stories.");
      d = await draftSocialPost(system, { strategy, targetsLabel, slot, sources: fb, recentBlock, allowNoFresh: false });
    }
  }
  if (!d || !d.postText) {
    const msg = d?.error ? `Drafting failed: ${d.error}` : `No story to post — ${sender} had nothing fresh and the fallback (innovation leads + web search) returned nothing.`;
    push(msg); return { answer: msg, drafted: false, source: sender };
  }
  const { postText, videoScript, story } = d;

  // ── HeyGen avatar video ──────────────────────────────────────────────
  // Render a short avatar video that reads the story. Async: kick it off, then
  // poll a bounded window (HeyGen can take minutes). Whatever state it's in by
  // the deadline goes into the review so the human can grab the finished video
  // in HeyGen. A missing HeyGen connection just skips this — non-fatal.
  let video: { videoId?: string; status?: string; videoUrl?: string | null; error?: string } = {};
  if (makeVideo) {
    try {
      const createPrim = findPrimitive("heygen.create_video");
      if (createPrim) {
        // Prefer the AIIA-values-aligned spoken script the model wrote; fall back
        // to a cleaned version of the post text if it didn't produce one.
        const script = videoScript && videoScript.length > 20 ? toVideoScript(videoScript) : toVideoScript(postText);
        push("Generating a HeyGen avatar video of the story.");
        const c: any = await createPrim.handler({ script, ...(inputs.avatarId ? { avatarId: String(inputs.avatarId) } : {}), ...(inputs.voiceId ? { voiceId: String(inputs.voiceId) } : {}), title: `Story post — ${stamp}` });
        if (c?.videoId) {
          video.videoId = c.videoId; video.status = "processing";
          const statusPrim = findPrimitive("heygen.video_status");
          // Poll up to ~5 min (20 × 15s). We want the finished videoUrl so it can
          // be attached to the Buffer post — video-only channels (TikTok) need it.
          // If it's still rendering at the deadline we hand the videoId to the
          // reviewer and post text-only where allowed.
          let thumb: string | null = null;
          for (let i = 0; i < 20 && statusPrim; i++) {
            await new Promise(r => setTimeout(r, 15_000));
            const s: any = await statusPrim.handler({ videoId: c.videoId });
            video.status = s?.status ?? video.status;
            if (s?.status === "completed") { video.videoUrl = s.videoUrl ?? null; thumb = s.thumbnailUrl ?? null; push("HeyGen video ready."); break; }
            if (s?.status === "failed") { video.error = s?.videoError?.detail ?? "render failed"; push("HeyGen video failed to render."); break; }
          }
          (video as any).thumbnailUrl = thumb;
          if (video.status === "processing") push("HeyGen video still rendering — its id goes into the review to collect shortly.");
        } else { video.error = c?.error ?? "create failed"; push(`HeyGen skipped: ${String(video.error).slice(0, 100)}`); }
      }
    } catch (e: any) { video.error = String(e?.message ?? e).slice(0, 140); push(`HeyGen skipped (non-fatal): ${video.error}`); }
  }

  // Put it on Buffer. Default = DRAFT (human reviews & schedules inside Buffer);
  // autoQueue opt-in adds it to Buffer's auto-queue (which WILL publish at the
  // channel's next slot — outward-facing, so it's off by default). Nothing goes
  // live here regardless — the review below is the human gate before posting.
  push(autoQueue ? "Adding to the Buffer queue." : "Saving as a Buffer draft for review.");
  const bufferPrim = findPrimitive("buffer.post");
  let buffer: any = { error: "buffer.post primitive missing" };
  if (bufferPrim) buffer = await bufferPrim.handler({
    text: postText,
    ...(channels ? { channels } : {}), // blank = ALL connected channels (same post everywhere)
    draft: !autoQueue,
    ...(video.videoUrl ? { videoUrl: video.videoUrl, ...((video as any).thumbnailUrl ? { thumbnailUrl: (video as any).thumbnailUrl } : {}) } : {}),
  });
  const posted = (buffer?.posted ?? []) as any[];

  // ── Review gate: Telegram group + email BEFORE anything is published ──
  const videoLine = video.videoUrl
    ? `🎬 Video: ${video.videoUrl}`
    : video.videoId
      ? `🎬 Video (${video.status ?? "processing"}) — HeyGen id ${video.videoId}${video.error ? ` (error: ${video.error})` : ""}`
      : (makeVideo ? `🎬 Video: not generated${video.error ? ` (${video.error})` : " (HeyGen not connected?)"}` : "");
  const dispositionShort = autoQueue ? "queued on Buffer" : "saved as a Buffer draft";
  const reviewText =
    `📝 New social post for review (${dispositionShort} — NOT yet published)\n\n` +
    `${postText}\n\n` +
    (videoLine ? `${videoLine}\n\n` : "") +
    `Source: ${sourceUsed}\n` +
    (story ? `Story: ${story.replace(/\s+/g, " ").slice(0, 200)}\n` : "") +
    (posted.length ? `Channels drafted: ${posted.map(p => p.service).join(", ")}\n` : "") +
    (buffer?.errors ? `⚠️ ${buffer.errors.map((e: any) => `${e.service}: ${e.error}`).join(" | ")}\n` : "") +
    `\nReview in Buffer, then publish/schedule it there. Reply here with changes.`;

  const review: { telegram?: any; email?: any } = {};
  if (reviewTelegram) {
    try {
      const tg = findPrimitive("telegram.send");
      if (tg) { review.telegram = await tg.handler({ text: reviewText }); push(review.telegram?.ok ? "Sent the post to the Telegram group for review." : `Telegram review skipped: ${review.telegram?.error ?? "unknown"}`); }
    } catch (e: any) { review.telegram = { error: String(e?.message ?? e).slice(0, 120) }; push(`Telegram review failed: ${review.telegram.error}`); }
  }
  if (reviewEmail) {
    try {
      const em = findPrimitive("email.send");
      if (em) {
        const body = `A new social post was drafted from **${sourceUsed}** and ${dispositionShort} (nothing is published yet).\n\n---\n\n${postText}\n\n${videoLine ? videoLine + "\n\n" : ""}${story ? `_Story: ${story}_\n\n` : ""}Review and schedule it in Buffer — nothing goes live until you do.`;
        review.email = await em.handler({ to: reviewEmail, subject: `Social post for review — ${stamp}`, body });
        push(review.email?.ok ? `Emailed the post to ${reviewEmail} for review.` : `Email review skipped: ${review.email?.error ?? "unknown"}`);
      }
    } catch (e: any) { review.email = { error: String(e?.message ?? e).slice(0, 120) }; push(`Email review failed: ${review.email.error}`); }
  }

  // Journal the draft so the optimiser can see what we produced + the Buffer ids.
  const journal =
    `---\ntype: social-draft\ngenerated: ${new Date().toISOString()}\nsource: ${sourceUsed}\ndisposition: ${buffer?.scheduled ?? "unknown"}\nchannels: ${(posted.map(p => p.service).join(", ")) || targetsLabel}\nbufferPostIds: ${posted.map(p => p.postId).filter(Boolean).join(", ")}\nvideoId: ${video.videoId ?? ""}\nvideoStatus: ${video.status ?? ""}\nvideoUrl: ${video.videoUrl ?? ""}\n---\n\n` +
    `# Social draft — ${stamp}\n\n## Post\n\n${postText}\n\n## Story chosen\n\n${story || "(not stated)"}\n\n## Video\n\n${videoLine || "(none)"}\n\n## Buffer result\n\n\`\`\`json\n${JSON.stringify(buffer, null, 2)}\n\`\`\`\n\n## Review\n\ntelegram: ${review.telegram?.ok ? "sent" : (review.telegram?.error ?? "skipped")} · email: ${review.email?.ok ? `sent → ${reviewEmail}` : (review.email?.error ?? "skipped")}\n`;
  try { writeVaultFile(`${SOCIAL_DIR}/drafts/${stamp}.md`, journal); } catch (e: any) { push(`Draft journal write skipped: ${String(e?.message ?? e).slice(0, 80)}`); }

  const okCount = posted.length;
  const disposition = autoQueue ? "added to the Buffer queue" : "saved as a Buffer draft (review & schedule it in Buffer)";
  const answer =
    `Drafted a post from ${sourceUsed}${video.videoUrl ? ", generated a video," : ""} and sent it to ${[reviewTelegram && review.telegram?.ok ? "the Telegram group" : null, reviewEmail && review.email?.ok ? reviewEmail : null].filter(Boolean).join(" + ") || "no review channel"} for review. ${okCount ? `Also ${disposition} on ${okCount} channel${okCount === 1 ? "" : "s"}` : "Buffer draft hit an error"} — nothing is published yet.\n\n` +
    `**Post**\n\n${postText}\n\n` +
    (videoLine ? `${videoLine}\n\n` : "") +
    (story ? `_Story: ${story}_\n\n` : "") +
    (buffer?.errors ? `⚠️ Buffer errors: ${JSON.stringify(buffer.errors)}\n\n` : "") +
    `Review in Buffer, then publish/schedule it there.`;
  return { answer, drafted: okCount > 0, postText, story, video, buffer, review, source: sourceUsed };
}

async function socialOptimizeRunner(inputs: Record<string, unknown>, push: (m: string) => void, _progress?: (p: Record<string, unknown>) => void) {
  const days = Number(inputs.days ?? 30);
  push(`Reviewing social performance over the last ${days} days.`);

  // Real post record (Buffer posts:read).
  let posts: any[] = []; let byStatus: Record<string, number> = {};
  try {
    const prim = findPrimitive("buffer.history");
    if (prim) { const r: any = await prim.handler({ limit: 100 }); posts = r?.posts ?? []; byStatus = r?.byStatus ?? {}; }
  } catch (e: any) { push(`Buffer history read failed: ${String(e?.message ?? e).slice(0, 100)}`); }

  // Engagement (Buffer insights:read — may be scope-gated).
  let analytics: any = null;
  try {
    const prim = findPrimitive("buffer.analytics");
    if (prim) analytics = await prim.handler({ days });
  } catch (e: any) { push(`Buffer analytics read failed: ${String(e?.message ?? e).slice(0, 100)}`); }
  const engagementAvailable = analytics && analytics.ok === true;
  if (!engagementAvailable && analytics?.needsScope) {
    push(`Engagement metrics need the '${analytics.needsScope}' Buffer scope — optimising on the post record + cadence instead.`);
  }

  const strategy = readVaultText(SOCIAL_STRATEGY_REL) ?? "(no strategy note yet — this run creates the first one.)";
  const sentOrScheduled = posts.filter(p => p.status === "sent" || p.status === "scheduled");
  const channelMix = sentOrScheduled.reduce((acc: Record<string, number>, p) => { acc[p.service] = (acc[p.service] ?? 0) + 1; return acc; }, {});
  const recentTexts = sentOrScheduled.slice(0, 20).map((p: any) => `- [${p.status}·${p.service}] ${(p.text ?? "").slice(0, 140)}`).join("\n");

  const evidence =
    `POST RECORD (last ${posts.length} posts on Buffer):\n` +
    `- status breakdown: ${JSON.stringify(byStatus)}\n` +
    `- channel mix (sent+scheduled): ${JSON.stringify(channelMix)}\n` +
    `- recent post texts:\n${recentTexts || "(none)"}\n\n` +
    `ENGAGEMENT: ${engagementAvailable
      ? JSON.stringify(analytics.metrics)
      : `NOT AVAILABLE — Buffer '${analytics?.needsScope ?? "insights:read"}' scope not granted on the connected token. Optimise on structure/cadence/mix, and recommend reconnecting Buffer with Analytics access to unlock engagement-based tuning.`}\n\n` +
    `CURRENT STRATEGY NOTE:\n${strategy.slice(0, 3000)}`;

  const system =
    "You are a social-media strategist for AI Institute Africa. You turn a post record (and engagement when available) into a concrete, actionable posting strategy that another agent will follow verbatim when drafting posts. Be specific and directive, not generic. No fluff.";
  const prompt =
    `Using the evidence below, REWRITE our posting strategy note. Output a clean markdown document with these sections:\n` +
    `## Summary — 2-3 sentences: the single biggest adjustment to make now.\n` +
    `## What's working / what's not — grounded in the post record (and engagement if present). If engagement is unavailable, say so plainly in one line and proceed on structural signals.\n` +
    `## Drafting guidance — concrete rules the drafter must follow next: topics to lean into, tone, format, hook style, hashtag policy, length per platform.\n` +
    `## Cadence & timing — how often and roughly when to post per channel.\n` +
    `## Channel mix — how to rebalance across ${Object.keys(channelMix).join(", ") || "twitter, linkedin, tiktok"}.\n` +
    `## Experiments to run — 2-3 concrete A/B ideas for next period.\n` +
    (engagementAvailable ? "" : `## Unlock engagement metrics — one line: reconnect Buffer granting the insights:read scope so future runs tune on real impressions/likes/shares.\n`) +
    `\nDirective and specific. This note is READ AND OBEYED by the drafting agent, so write it as instructions, not analysis.\n\nEVIDENCE:\n\n${evidence}`;

  push("Synthesising the updated strategy.");
  let strategyDoc = "";
  try { strategyDoc = (await llmGenerate(prompt, system, { maxTokens: 1400 })).trim(); }
  catch (e: any) { const msg = `Strategy synthesis failed: ${String(e?.message ?? e).slice(0, 160)}`; push(msg); return { answer: msg, updated: false }; }
  if (!strategyDoc) { const msg = "Strategy synthesis returned empty — keeping the previous note."; push(msg); return { answer: msg, updated: false }; }

  const doc = `---\ntype: social-strategy\nupdated: ${new Date().toISOString()}\nwindowDays: ${days}\npostsReviewed: ${posts.length}\nengagementAvailable: ${engagementAvailable}\n---\n\n# Social posting strategy\n\n${strategyDoc}\n`;
  try {
    writeVaultFile(SOCIAL_STRATEGY_REL, doc);
    push(`Updated the posting strategy note (${SOCIAL_STRATEGY_REL}).`);
    try { await commitAndPush("clawbot: update social posting strategy"); } catch { /* non-fatal */ }
  } catch (e: any) { push(`Strategy write failed: ${String(e?.message ?? e).slice(0, 120)}`); }

  const answer =
    `Reviewed ${posts.length} Buffer post${posts.length === 1 ? "" : "s"} (${JSON.stringify(byStatus)}) and ${engagementAvailable ? "their engagement metrics" : "their record (engagement not yet available — Buffer insights:read scope needed)"}, then updated the posting strategy the drafter follows.\n\n${strategyDoc}`;
  return { answer, updated: true, postsReviewed: posts.length, engagementAvailable };
}

// Daily briefing — a thin wrapper over the general-task agent with a fixed,
// briefing-shaped prompt. Runs against the active persona so a hired EA (Evie)
// gives an EA-flavoured briefing. Doesn't auto-save as a template (it's already
// a built-in) and never re-asks for clarification — it's a scheduled, headless
// run. The optional `focus` input narrows the briefing to one area.
async function dailyBriefingRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void) {
  const focus = String(inputs.focus ?? "").trim();
  const now = new Date();
  const today = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const from = ymd(new Date(now.getTime() - 5 * 24 * 3600_000));
  const to = ymd(now);

  // The briefing gathers its OWN evidence and hands it to the writer as an
  // inline context block, rather than leaning on the LLM planner. Two prior
  // failures forced this: (1) the "look at _neuroworks/jobs" phrasing routed
  // the planner to research.deep, whose web sources were generic sign-in
  // pages, so the briefing reported "vault is quiet" no matter what actually
  // ran; (2) the innovation scan, injected as a bespoke "ATTACHED —" block,
  // reached the planner but NOT synthesis (synth trusts evidence runs, not
  // raw task text), so every briefing said "scan could not be accessed". By
  // pulling activity + the scan here and formatting them as the recognised
  // "Attached documents (user uploaded as context…)" block, the runner routes
  // to the direct-synth path, which reads the block as primary evidence.
  const contextParts: string[] = [];

  // Real activity for the window — the agents' own completed jobs, straight
  // from the job store (in-memory + _neuroworks/jobs JSONL).
  try {
    const prim = findPrimitive("calendar.activity");
    if (prim) {
      const act: any = await prim.handler({ from, to });
      const days: any[] = act?.days ?? act?.activity ?? [];
      const total = days.reduce((n, d) => n + (d.jobs?.length ?? d.count ?? 0), 0);
      if (total > 0) {
        // Summarise PER DAY, NEWEST first. The old flat `slice(0,60)` over
        // oldest-first job lines let a busy early day (37+ jobs) fill the cap so
        // recent days — the ones a daily brief cares about most — were silently
        // dropped: the brief reported "activity covers Jul 22-23 only" and "no
        // tasks for Jul 26" while 24-27 actually had 100+ jobs (live 2026-07-27).
        const sorted = [...days].sort((a: any, b: any) => String(b.date).localeCompare(String(a.date)));
        const perDay = sorted.map((d: any) => {
          const jobs = d.jobs ?? [];
          const sample = jobs.slice(0, 6).map((j: any) => `  - ${j.title ?? j.template ?? j.kind ?? "task"} (${j.status ?? "?"})`);
          const more = jobs.length > 6 ? `\n  - …and ${jobs.length - 6} more` : "";
          return `**${d.date} — ${jobs.length} job${jobs.length === 1 ? "" : "s"}**\n${sample.join("\n")}${more}`;
        });
        contextParts.push(`### Activity — ${from} → ${to} (${total} jobs across ${sorted.length} days)\n${perDay.join("\n")}`);
        push(`Pulled ${total} jobs across ${sorted.length} days.`);
      } else {
        contextParts.push(`### Activity — last 5 days (${from} → ${to})\nNo agent jobs ran in this window.`);
        push("No activity in the last 5 days.");
      }
    }
  } catch (e: any) { push(`Activity lookup failed: ${String(e?.message ?? e).slice(0, 100)}`); }

  // Latest innovation scan (48h) — the research employee's daily R&D report.
  let scanJobId = "";
  let scanInvalid = false;
  try {
    const { latestJobByTemplate } = await import("../lib/job-store.js");
    const scan = latestJobByTemplate("innovation-scan", Date.now() - 48 * 3600_000);
    if (scan?.answer && looksLikeInnovationReport(scan.answer)) {
      scanJobId = scan.id;
      push(`Attaching the latest innovation scan (${scan.id.slice(0, 8)}, ${scan.persona ?? "research"}).`);
      contextParts.push(
        `### Innovation scan (job ${scan.id}, by ${scan.persona ?? "research"}, finished ${scan.finishedAt ?? scan.startedAt})\n${scan.answer.slice(0, 6000)}`);
    } else if (scan?.answer) {
      // The latest scan exists but its content ISN'T an opportunities report
      // (e.g. a drafted welcome email — live 2026-07-27). Do NOT surface it as
      // "opportunities"; flag it so the brief tells the reader to re-run rather
      // than presenting off-topic content as R&D findings.
      scanInvalid = true;
      scanJobId = scan.id;
      push(`Latest innovation scan (${scan.id.slice(0, 8)}) isn't a valid opportunities report — flagging, not summarising.`);
    } else {
      push("No innovation scan in the last 48h.");
    }
  } catch { /* briefing must never fail on the attachment */ }

  const attachmentBlock = contextParts.length
    ? `\n\nAttached documents (user uploaded as context — treat as the primary evidence, do NOT web-search):\n\n${contextParts.join("\n\n")}`
    : "";

  const innovationInstruction = scanInvalid
    ? `\n- "## Innovation scout" — ONE line only: the latest innovation scan (job ${scanJobId}) did not produce a valid opportunities report and should be re-run. Do NOT invent opportunities.`
    : scanJobId
    ? `\n- "## Innovation scout" — 3-5 lines summarising the Top 3 opportunities from the attached innovation scan; cite job ${scanJobId} once so the reader can open the full report.`
    : "";

  // Section names are given as exact headings to REPRODUCE; the guidance sits
  // on the instruction lines so the model doesn't echo it into the heading
  // text (an earlier version put guidance after an em-dash IN the heading and
  // the synth printed "## Focus today — the 3-5 things that matter…" verbatim).
  const task =
    `Produce my briefing for ${today}.${focus ? ` Focus area: ${focus}.` : ""}\n\n` +
    `Using ONLY the attached context below (real activity + the latest innovation scan), write a short, scannable briefing. Use these EXACT section headings, nothing after them:\n` +
    `- "## Focus today" — the 3-5 things that matter most, each one line with WHY it matters.\n` +
    `- "## Open loops" — anything waiting on me or flagged for follow-up.\n` +
    `- "## Worth knowing" — short notes on recent changes or context.` +
    innovationInstruction + `\n\n` +
    `Keep it tight — a morning glance, not a report. If the activity window is empty, say so plainly in one line rather than padding or inventing items. Output ONLY the finished briefing (the headings above and their bullets) — never your reasoning, the guidance, or these instructions.` +
    attachmentBlock;
  // `_personaId` passes through so a scheduled briefing can pin the right
  // employee (an EA persona) instead of inheriting whoever happens to be the
  // org-wide active hire that morning (a Procurement Officer gave one run a
  // procurement-slanted briefing during live verification; an HR Manager
  // lane-refused an entire briefing on 2026-07-19). When the schedule pins
  // nobody, default to the Executive Assistant — a briefing is EA work by
  // definition, and inheriting a random specialist produces refusals.
  const personaId = (typeof inputs._personaId === "string" && inputs._personaId.trim()) || "executive-assistant";
  return generalTaskRunner({ task, save_as_template: false, _personaId: personaId }, push, progress);
}

async function syncDownloadsRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const source = (inputs.source as string | undefined) ?? "";
  push("running download sync (read-only on sources)");
  const r = syncDownloads({ source }, push);
  push("committing inventory + state to vault");
  const commit = await commitAndPush(`clawbot: downloads sync (${r.copiedThisRun.length} new)`);
  return { ...r, commit };
}

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

