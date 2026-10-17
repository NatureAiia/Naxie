import { Router } from "express";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
import { planAndExecute, executePlan, crownBypassesApproval } from "../lib/agent.js";
import { requireLayer, callerOf, callerLayer } from "../lib/access.js";
import { ORG_TASK_PRIORITIES, type OrgTaskPriority } from "../lib/org-tasks.js";
import { filterJobsForCaller, canSeeJob } from "../lib/job-visibility.js";
import { checkTaskAllowed } from "../lib/task-restrictions.js";
import { loadCustomTemplates, saveCustomTemplate, findCustomTemplate, bumpRunCount, slugify, type CustomTemplate } from "../lib/custom-templates.js";
import { loadPersonas, getActivePersona, personaSystemSuffix } from "../lib/personas.js";
import { classifyCustomTemplate, type TemplateRole } from "../lib/template-classifier.js";
import { findPrimitive } from "../lib/primitives.js";
import { createBoardRun, executeBoardRun, failBoardRun, MIN_MEMBERS } from "../lib/board.js";
import { runBrandSignalScan } from "../lib/brand-signals.js";
import { logAudit } from "../lib/audit-log.js";
import { listRecentEmails, readEmail } from "../lib/email.js";
import { shouldKeep, renderEmailNote, emailNotePath, EMAIL_NOTES_DIR, type MailForNote, type MailVerdict } from "../lib/email-notes.js";

export const templatesRouter = Router();

const NEEDS_GITHUB = new Set(["summarize-repo", "run-digest", "publish-folder"]);

// ── Telegram chatId resolution ──
// Every Telegram-posting runner (africa/world/si/events/deadline-recap/
// evening/weekend) used to throw "missing 'chatId' input" when the caller
// didn't pass one. Schedules fired without inputs then failed outright.
// Now: explicit input wins, otherwise fall back to the configured default
// (integration's chatId, then NAXION_TELEGRAM_GROUP_CHAT /
// NAXION_TELEGRAM_NOTIFY_CHAT) — the same order telegram-bridge uses.
// Throws only when NO destination exists at all.
async function resolveTemplateChatId(inputs: Record<string, unknown>): Promise<string> {
  const explicit = String((inputs as any)?.chatId ?? "").trim();
  if (explicit) return explicit;
  try {
    const { getConnectionByProvider } = await import("../lib/integrations.js");
    const connChat = (getConnectionByProvider("telegram") as any)?.config?.chatId?.trim?.() ?? "";
    const group = (process.env.NAXION_TELEGRAM_GROUP_CHAT ?? "").trim();
    const notify = (process.env.NAXION_TELEGRAM_NOTIFY_CHAT ?? "").trim();
    const resolved = group || notify || connChat;
    if (resolved) return resolved;
  } catch { /* integrations optional */ }
  throw new Error("missing 'chatId' input (no Telegram default chat configured — set one on the Integrations page or via NAXION_TELEGRAM_GROUP_CHAT)");
}

// ── News config API (per-feed tuning, history, threshold) ───────────────
// GET /api/templates/news/config — effective config (env + file + defaults)
// PATCH /api/templates/news/config — admin UI writes .naxion/news-config.json
templatesRouter.get("/news/config", (req, res) => {
  const file = loadNewsFileConfig();
  res.json({
    effective: {
      africaQueries: effectiveAfricaQueries(),
      worldQueries: effectiveWorldQueries(),
      authorityDomains: [...effectiveAuthorityDomains()],
      breakingThreshold: effectiveBreakingThreshold(),
      historyDays: effectiveHistoryDays(),
    },
    file, // what's persisted (null fields = using env/default)
    env: {
      NEWS_AFRICA_QUERIES: process.env.NEWS_AFRICA_QUERIES ?? null,
      NEWS_WORLD_QUERIES: process.env.NEWS_WORLD_QUERIES ?? null,
      NEWS_AUTHORITY_DOMAINS: process.env.NEWS_AUTHORITY_DOMAINS ?? null,
      NEWS_BREAKING_THRESHOLD: process.env.NEWS_BREAKING_THRESHOLD ?? null,
      NEWS_HISTORY_DAYS: process.env.NEWS_HISTORY_DAYS ?? null,
    },
    defaults: { africaQueries: DEFAULT_AFRICA_QUERIES, worldQueries: DEFAULT_WORLD_QUERIES, authorityDomains: DEFAULT_HIGH_AUTHORITY, breakingThreshold: 8, historyDays: 7 },
    feeds: { curated: 24, africaHints: AFRICA_TECH_RSS_HINTS }, // 19 global + 6 Africa (incl. iAfrica)
  });
});
templatesRouter.patch("/news/config", requireLayer("admin"), (req, res) => {
  const body = req.body ?? {};
  const patch: any = {};
  if (Array.isArray(body.africaQueries)) patch.africaQueries = body.africaQueries.map((s:any)=>String(s).trim()).filter(Boolean).slice(0,20);
  if (Array.isArray(body.worldQueries)) patch.worldQueries = body.worldQueries.map((s:any)=>String(s).trim()).filter(Boolean).slice(0,20);
  if (Array.isArray(body.authorityDomains)) patch.authorityDomains = body.authorityDomains.map((s:any)=>String(s).trim().toLowerCase()).filter(Boolean).slice(0,50);
  if (body.breakingThreshold !== undefined) { const n=Number(body.breakingThreshold); if (Number.isFinite(n)) patch.breakingThreshold = Math.max(0, Math.min(10, n)); }
  if (body.historyDays !== undefined) { const n=Number(body.historyDays); if (Number.isFinite(n)) patch.historyDays = Math.max(1, Math.min(30, Math.round(n))); }
  // merge with existing file so PATCH is partial
  const existing = loadNewsFileConfig();
  const merged = { ...existing, ...patch };
  // allow clearing a field by sending null
  if (body.africaQueries === null) delete (merged as any).africaQueries;
  if (body.worldQueries === null) delete (merged as any).worldQueries;
  if (body.authorityDomains === null) delete (merged as any).authorityDomains;
  try {
    const p = NEWS_CONFIG_FILE;
    _mks(resolve(p, ".."), { recursive: true } as any);
    _wfs(p, JSON.stringify(merged, null, 2));
    // also clear alt path if exists to avoid divergence
    try { if (_exs(NEWS_CONFIG_FILE_ALT) && NEWS_CONFIG_FILE_ALT !== p) _wfs(NEWS_CONFIG_FILE_ALT, JSON.stringify(merged, null, 2)); } catch {}
  } catch (e:any) { return res.status(500).json({ error: String(e?.message ?? e) }); }
  res.json({ ok: true, config: merged, effective: { africaQueries: effectiveAfricaQueries(), worldQueries: effectiveWorldQueries(), authorityDomains: [...effectiveAuthorityDomains()], breakingThreshold: effectiveBreakingThreshold(), historyDays: effectiveHistoryDays() } });
});
templatesRouter.get("/news/metrics", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50)));
    const metricsPath = resolve(config.vaultPath, "_naxion/news/metrics.jsonl");
    if (!_exs(metricsPath)) return res.json({ metrics: [], total: 0 });
    const lines = _rfs(metricsPath, "utf8").trim().split("\n").filter(Boolean).slice(-limit).reverse();
    const metrics = lines.map(l=>{ try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json({ metrics, total: metrics.length });
  } catch (e:any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

templatesRouter.get("/", (req, res) => {
  // Custom templates persist with role: "Custom" because save-time didn't
  // know which lane they belonged to. We re-classify on read so the UI
  // shows them under Engineering / Knowledge / Operations / Insights
  // when the id + title + description match a known lane. Unclassifiable
  // saves still fall through to "Custom" for discoverability.
  const includeHidden = req.query.includeHidden === "1";
  // Hidden customs (e.g. Calendar's auto-created one-off task templates)
  // stay runnable via /run/:id but don't clutter the general gallery,
  // mirroring the built-in Template.hidden convention just below.
  const custom = loadCustomTemplates()
    .filter(c => includeHidden || !c.hidden)
    .map(c => ({
      id: c.id,
      role: classifyCustomTemplate(c),
      title: c.title,
      description: c.description,
      icon: "saved",
      agent: "naxie-agent",
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
  // Hidden built-in templates (e.g. board-meeting) stay runnable via
  // /run/:id — a schedule can still fire them — but don't clutter the
  // general gallery unless explicitly asked for (Schedules.tsx's template
  // picker passes this).
  const visibleTemplates = includeHidden ? templates : templates.filter(t => !t.hidden);
  res.json({ roles: allRoles, templates: [...visibleTemplates, ...custom] });
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
  const MAX_FEED = Number(process.env.NAXION_TASKS_FEED_LIMIT ?? "150");
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
  // A retry of a crown job stays crown-tier (queue priority + approval bypass).
  job.priority = old.priority;
  res.json({ jobId: job.id, retryOf: req.params.id });

  void runJob(job, async (push, progress) => {
    push(`retry of job ${req.params.id} (${old.status})`);
    const persona = getActivePersona();
    const suffix = personaSystemSuffix(persona);
    const r = await planAndExecute(task, push, (patch) => progress(patch as Record<string, unknown>), { personaSystemSuffix: suffix, workMode: persona?.workMode, taskKind: job.kind, persona: persona?.name, personaId: persona?.id, skipApprovalGate: crownBypassesApproval(job.priority) });
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
      tpl = { id: custom.id, role: "Insights", title: custom.title, description: custom.description, icon: "saved", agent: "naxie-agent", inputs: [], requiresApproval: false, estimateSeconds: 30 } as Template;
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
    return res.status(412).json({ error: "GitHub token not configured. Set GITHUB_TOKEN in naxionai/.env and restart." });
  }

  const job = newJob(`${tpl.role.toLowerCase()}:${tpl.id}`);
  job.template = tpl.id;
  job.title = tpl.title;
  job.inputs = inputs;
  // Crown Job priority — the one place today a caller can actually ask for a
  // Job (not just an OrgTask) to run at crown tier. "crown" is admin+ only;
  // anyone below that (a staff-layer human) is silently downgraded to
  // "urgent" rather than rejected, same posture as other layer-gated fields
  // in this codebase. A token-less machine/operator caller (layer === null,
  // see access.ts's scope note) is trusted with crown same as admin.
  const requestedPriority = typeof inputs.priority === "string" ? inputs.priority.trim() : "";
  if (requestedPriority === "crown") {
    const layer = callerLayer(req);
    job.priority = (layer === null || layer === "admin" || layer === "superadmin") ? "crown" : "urgent";
  } else if (requestedPriority && (ORG_TASK_PRIORITIES as readonly string[]).includes(requestedPriority)) {
    job.priority = requestedPriority as OrgTaskPriority;
  }
  // A "needs my OK" schedule forces approval on its fired job regardless of
  // the template's own default — set alongside x-naxie-scheduled by
  // schedules.ts's fireSchedule() when Schedule.requireApproval is true.
  // Crown skips the TEMPLATE's own default approval requirement, but never
  // this explicit schedule-level opt-in — a narrower human "review this one
  // recurring schedule" choice always wins over crown's bypass.
  const forceApproval = req.get("x-naxie-force-approval") === "1";
  job.requiresApproval = (tpl.requiresApproval && job.priority !== "crown") || forceApproval;
  // Attribute to the initiating human (staff feeds show only own tasks).
  job.createdByEmail = callerOf(req)?.email;
  // Schedule-fired runs carry a marker header; the tag routes their results
  // into the vault journal (scheduled progress reports belong in the brain).
  const scheduledBy = req.get("x-naxie-scheduled");
  if (scheduledBy) job.scheduledBy = scheduledBy;

  if (job.requiresApproval) {
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
        skipApprovalGate: crownBypassesApproval(job.priority),
      });
      return { ...r, fromCustom: custom.id };
    }
    return runner(tpl.id, inputs, push, progress, { jobId: job.id, scheduledBy: job.scheduledBy });
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

  // Plan-approval job: execute the EXACT plan the user reviewed (no re-planning),
  // then let planAndExecute finish the loop (synthesise → answer). Empty plans
  // fall through to the normal plan/synth path.
  if (j.plan) {
    const task = j.task ?? j.title ?? "";
    void runJob(j, async (push, progress) =>
      planAndExecute(task, push, (patch) => progress(patch as Record<string, unknown>), {
        personaSystemSuffix: j.personaSuffix,
        preplan: j.plan && j.plan.steps.length > 0 ? j.plan : undefined,
        personaId: j.personaId,
        skipApprovalGate: crownBypassesApproval(j.priority),
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
      templates.filter(t => !t.hidden).map(t => `- ${t.id}: ${t.title}. Inputs: ${t.inputs.length === 0 ? "(none)" : t.inputs.map(i => `${i.name}(${i.type}${i.required ? ",required" : ""})`).join(", ")}`).join("\n") +
      "\nReturn shape: {\"templateId\":\"<id>\",\"inputs\":{<name>:<value>}}. If you cannot determine, return {\"templateId\":null}.";
    const out = await ollamaGenerate(text, sys);
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      const matched = templates.find(t => t.id === parsed.templateId);
      if (parsed.templateId && matched && !matched.hidden) {
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
  for (const t of templates.filter(t => !t.hidden)) {
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

async function runner(templateId: string, inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void, meta?: { jobId?: string; scheduledBy?: string }): Promise<unknown> {
  switch (templateId) {
    case "summarize-repo": return summarizeRepoRunner(inputs, push);
    case "run-digest":     return runDigestRunner(inputs, push);
    case "publish-folder": return publishFolderRunner(inputs, push);
    case "search-brain":   return searchBrainRunner(inputs, push);
    case "add-note":       return addNoteRunner(inputs, push);
    case "browse-vault":   return { redirect: "/knowledge" };
    case "sync-downloads": return syncDownloadsRunner(inputs, push);
    case "daily-briefing": return dailyBriefingRunner(inputs, push, progress);
    case "email-to-vault": return emailToVaultRunner(inputs, push);
    case "innovation-scan": return innovationScanRunner(inputs, push, progress);
    case "africa-ai-news":   return africaAiNewsRunner(inputs, push, progress);
    case "africa-tech-alerts": return africaAlertsRunner(inputs, push, progress);
    case "world-ai-news":    return worldAiNewsRunner(inputs, push, progress);
    case "super-intelligence-news": throw new Error("template 'super-intelligence-news' was removed — use 'africa-ai-news' or 'world-ai-news' instead");
    case "events-competition-scan": return eventsCompetitionScanRunner(inputs, push, progress);
    case "deadline-reminders": return deadlineRemindersRunner(inputs, push, progress);
    case "evening-recap": return eveningRecapRunner(inputs, push, progress);
    case "weekend-digest": return weekendDigestRunner(inputs, push, progress);
    case "brand-signal-scan": return brandSignalScanRunner(inputs, push, progress);
    case "analyze-spreadsheet": return analyzeSpreadsheetRunner(inputs, push, progress);
    case "stock-check": return stockCheckRunner(inputs, push, progress);
    case "general-task":   return generalTaskRunner(inputs, push, progress);
    case "board-meeting":  return boardMeetingRunner(inputs, push, progress, meta);
    default: throw new Error(`no runner for ${templateId}`);
  }
}

// Feature D — lets a Board Meeting run on the existing generic Schedules
// pipeline (a schedule just POSTs { templateId: "board-meeting", inputs } to
// /run/:id on its cadence) without teaching schedules.ts anything new. Hidden
// from the general Templates gallery (see templates.ts) because its result —
// stage tabs, rankings — needs Board Meeting's own page, not the generic
// Tasks/Reports view; still fully runnable through this same pipeline.
async function boardMeetingRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void, meta?: { jobId?: string; scheduledBy?: string }) {
  const topic = String(inputs.topic ?? "").trim().slice(0, 2000);
  if (!topic) throw new Error("missing 'topic' input");
  if (topic.length < 10) throw new Error("'topic' too short — describe the decision in 10+ characters");
  const rawIds: string[] = Array.isArray((inputs as any).personaIds)
    ? (inputs as any).personaIds.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
    : (typeof inputs.personaIds === "string" && inputs.personaIds.trim()
      ? inputs.personaIds.split(",").map(s => s.trim()).filter(Boolean)
      : []);
  let personaIds: string[] | undefined = rawIds.length ? rawIds : undefined;
  try {
    const known = new Set((loadPersonas().personas ?? []).flatMap((p: any) => [p.id, String(p.name ?? "").toLowerCase()]));
    const dropped = (personaIds ?? []).filter(id => !known.has(id) && !known.has(id.toLowerCase()));
    if (dropped.length) push(`⚠ unknown council member(s) ignored: ${dropped.join(", ").slice(0, 160)}`);
  } catch { /* persona list optional */ }
  const run = createBoardRun({ topic, personaIds, jobId: meta?.jobId, scheduleId: meta?.scheduledBy });
  if (run.roster.length < MIN_MEMBERS) {
    failBoardRun(run, `need at least ${MIN_MEMBERS} valid council members`);
    return { kind: "board-meeting", boardRunId: run.id, status: "failed" as const, error: `need at least ${MIN_MEMBERS} valid council members`, answer: `Board meeting could not start — need at least ${MIN_MEMBERS} valid council members.` };
  }
  progress?.({ boardRunId: run.id, status: "running" });
  let finished;
  try {
    finished = await executeBoardRun(run, push);
  } catch (e: any) {
    return { kind: "board-meeting", boardRunId: run.id, status: "failed" as const, error: String(e?.message ?? e).slice(0, 300), answer: `Board meeting failed: ${String(e?.message ?? e).slice(0, 160)}` };
  }
  progress?.({ boardRunId: finished.id, status: finished.status });
  return { kind: "board-meeting", boardRunId: finished.id, status: finished.status, answer: finished.chairmanSynthesis };
}

async function summarizeRepoRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const rawRepo = String(inputs.repo ?? "").trim();
  if (!rawRepo) throw new Error("missing 'repo' input (owner/name or repo name)");
  const [ownerRaw, nameRaw] = rawRepo.includes("/") ? rawRepo.split("/", 2) : [config.githubOwner, rawRepo];
  const owner = ownerRaw.trim();
  const name = (nameRaw ?? "").trim();
  if (!/^[a-z0-9_.-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(name)) {
    throw new Error(`invalid 'repo' "${rawRepo.slice(0, 120)}" — expected owner/name`);
  }
  const sinceDays = Math.min(90, Math.max(1, parseInt(String((inputs as any).sinceDays ?? "90"), 10) || 90));
  push(`fetching activity for ${owner}/${name}`);
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const settled = await Promise.allSettled([
    readme(owner, name), recentCommits(owner, name, since), openPRs(owner, name), openIssues(owner, name),
  ]);
  const [rd, commits, prs, issues] = settled.map((s, i) => {
    if (s.status === "fulfilled") return (s as any).value;
    push(`⚠ source ${["readme", "commits", "PRs", "issues"][i]} unavailable: ${String((s as any).reason?.message ?? (s as any).reason).slice(0, 120)}`);
    return i === 0 ? "" : [];
  }) as [string, any[], any[], any[]];
  const parts: string[] = [`Repository: ${owner}/${name}`];
  if (rd) parts.push(`\nREADME (truncated):\n${String(rd).slice(0, 4000)}`);
  if (commits.length) parts.push(`\nRecent commits (${commits.length}):\n` + commits.slice(0, 30).map(c => `- ${c.sha} ${c.message}`).join("\n"));
  if (prs.length) parts.push(`\nOpen PRs (${prs.length}):\n` + prs.slice(0, 20).map(p => `- #${p.number} ${p.title}`).join("\n"));
  if (issues.length) parts.push(`\nOpen issues (${issues.length}):\n` + issues.slice(0, 20).map(i => `- #${i.number} ${i.title}`).join("\n"));
  push(`calling ollama (${config.ollamaModel})`);
  let summary: string;
  try {
    summary = await ollamaGenerate(parts.join("\n"),
      "You are a senior engineer summarizing a repository for an Obsidian second brain. Output concise markdown with sections: ## Purpose (one sentence), ## Stack, ## State, ## Recent direction, ## Notable open work. No filler."
    );
  } catch (e: any) {
    const partial = parts.join("\n").slice(0, 4000);
    return { path: null, error: `summarizer unavailable: ${String(e?.message ?? e).slice(0, 160)}`, answer: `Could not summarize ${owner}/${name} — model unavailable. Activity fetched (${commits.length} commits, ${prs.length} PRs, ${issues.length} issues).`, partial };
  }
  const today = new Date().toISOString().slice(0, 10);
  const md = `---\nrepo: ${owner}/${name}\ngenerated: ${today}\nmodel: ${config.ollamaModel}\n---\n\n# ${owner}/${name}\n\n${summary}\n`;
  const rel = `_naxie/summaries/${owner}-${name}.md`;
  push(`writing ${rel}`);
  writeVaultFile(rel, md);
  push("committing + pushing vault");
  try {
    const r = await commitAndPush(`naxie: summary ${owner}/${name}`);
    return { path: rel, answer: `Summarized ${owner}/${name} → ${rel}`, ...r };
  } catch (e: any) {
    push(`commit failed (summary kept at ${rel}): ${String(e?.message ?? e).slice(0, 120)}`);
    return { path: rel, commitOk: false, error: String(e?.message ?? e).slice(0, 200), answer: `Summarized ${owner}/${name} → ${rel} (commit failed)` };
  }
}

async function runDigestRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const lookbackDays = Math.min(90, Math.max(1, parseInt(String(inputs.lookbackDays ?? "7"), 10) || 7));
  const lookback = String(lookbackDays);
  push(`dispatching daily-digest workflow (lookback=${lookback})`);
  try {
    await dispatchWorkflow(config.githubOwner, "NaxionAI-Powered-by-Neuroworks", "daily-digest.yml", "main", { lookback_days: lookback });
  } catch (e: any) {
    const msg = `GitHub dispatch failed: ${String(e?.message ?? e).slice(0, 200)}`;
    push(`⚠ ${msg}`);
    return { dispatched: false, lookbackDays, error: msg, answer: msg };
  }
  push("workflow_dispatch sent — track progress on GitHub Actions");
  const answer = `Digest dispatched (last ${lookback} days) — track it on GitHub Actions.`;
  return { dispatched: true, lookbackDays, answer };
}

async function publishFolderRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const path = String((inputs as any).path ?? "").trim();
  const isPublic = Boolean(inputs.public);
  let repoName = String(inputs.name ?? "").trim();
  if (!path) throw new Error("missing 'path'");
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`folder not found: ${full}`);
  if (!repoName) repoName = sanitizeName(basename(full));
  if (!/^[a-z0-9._-]{1,100}$/i.test(repoName)) throw new Error(`invalid repo name "${repoName.slice(0, 60)}" — use letters/numbers/.-_ (max 100)`);
  // Publish-roots allowlist: when NAXION_PUBLISH_ROOTS is set (comma list),
  // the source must sit inside one entry. Refuse system/secret locations always.
  const _lower = full.toLowerCase().replace(/\//g, "\\");
  if (_lower.includes("\\windows\\system32") || _lower.endsWith("\\windows") || _lower.includes("\\.ssh\\") || /(^|\\)\.env$/i.test(full)) {
    throw new Error(`refusing to publish system/secret location: ${full.slice(0, 160)}`);
  }
  const _roots = String(process.env.NAXION_PUBLISH_ROOTS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (_roots.length) {
    const _ok = _roots.some(r => {
      try {
        const _rr = resolve(r).toLowerCase();
        return _lower === _rr || _lower.startsWith(_rr.endsWith("\\") ? _rr : _rr + "\\");
      } catch { return false; }
    });
    if (!_ok) throw new Error(`source outside NAXION_PUBLISH_ROOTS: ${full.slice(0, 160)}`);
  }
  try {
    const { statSync: _st } = await import("node:fs");
    if (!_st(full).isDirectory()) throw new Error(`not a folder: ${full}`);
  } catch (e: any) {
    if (String(e?.message ?? "").startsWith("not a folder")) throw e;
  }
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
      await git.commit("naxie: snapshot before publish");
    }
  }

  let cloneUrl: string;
  try {
    push(`creating repo ${config.githubOwner}/${repoName}`);
    const { data } = await octokit.repos.createForAuthenticatedUser({
      name: repoName, private: !isPublic,
      description: `Auto-published by Naxie from local folder: ${basename(full)}`,
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
  try {
    await git.push(["-u", "origin", branch]);
  } finally {
    // Never leave the token in .git/config
    try { await git.remote(["set-url", "origin", cloneUrl]); } catch { /* best-effort */ }
  }
  const answer = `Published ${basename(full)} → ${config.githubOwner}/${repoName} (${branch})`;
  return { repo: `${config.githubOwner}/${repoName}`, branch, public: isPublic, answer };
}

async function searchBrainRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const q = String(inputs.query ?? "").trim().slice(0, 500);
  if (!q) throw new Error("missing 'query' input");
  const limit = Math.min(50, Math.max(1, parseInt(String((inputs as any).limit ?? "50"), 10) || 50));
  push(`searching vault for "${q.slice(0, 120)}"`);
  const esc = (s: string) => String(s ?? "").replace(/[*_`[\]]/g, "").slice(0, 200);
  let results;
  try {
    results = searchVault(q).slice(0, limit);
  } catch (e: any) {
    if (e instanceof VaultUnreachable) {
      push(`vault unreachable: ${e.vaultPath}`);
      const answer = `I couldn't search your vault — the configured path **${e.vaultPath}** doesn't resolve on this machine. Common causes: the drive is unmounted (e.g. D: was unplugged on Windows), the folder was renamed, or \`VAULT_PATH\` in \`.env\` doesn't match your actual vault. Mount the drive (or fix the path) and try again.`;
      return { query: q, results: [], count: 0, vaultUnreachable: true, vaultPath: e.vaultPath, answer };
    }
    const msg = `Search failed: ${String(e?.message ?? e).slice(0, 160)}`;
    push(`⚠ ${msg}`);
    return { query: q, results: [], count: 0, error: msg, answer: msg };
  }
  push(`${results.length} match${results.length === 1 ? "" : "es"}`);
  // Build a human-readable `answer` so consumers (chat UI, harness, journal)
  // get a real summary instead of just a raw results array. Without this,
  // anything that read `result.answer` saw `undefined` and fell back to the
  // "On it — running..." chat ack.
  let answer: string;
  if (results.length === 0) {
    answer = `No notes in your vault match **${esc(q)}**. Try a broader term, check the spelling, or add a note on this topic and search again.`;
  } else {
    const top = results.slice(0, 8);
    const list = top.map((r, i) => {
      const preview = esc(String((r as any).preview ?? "").replace(/\s+/g, " ").trim().slice(0, 160));
      return `${i + 1}. **${esc((r as any).path)}**${(r as any).line ? ` (line ${(r as any).line})` : ""} — ${preview}`;
    }).join("\n");
    const remaining = results.length - top.length;
    const more = remaining > 0 ? `\n\n_… and ${remaining} more match${remaining === 1 ? "" : "es"}._` : "";
    answer = `Found **${results.length}** note${results.length === 1 ? "" : "s"} mentioning **${esc(q)}**:\n\n${list}${more}`;
  }
  return { query: q, results, count: results.length, answer };
}

async function addNoteRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const title = String(inputs.title ?? "").trim().slice(0, 200);
  const body = String(inputs.body ?? "").trim().slice(0, 50000);
  if (!title) throw new Error("missing 'title' input");
  if (!body) throw new Error("missing 'body' input");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";
  let rel = `0-Inbox/${stamp}-${slug}.md`;
  try {
    const { existsSync: _ex } = await import("node:fs");
    const { resolve: _res } = await import("node:path");
    if (_ex(_res(config.vaultPath, rel))) rel = `0-Inbox/${stamp}-${slug}-${Date.now().toString(36)}.md`;
  } catch { /* dedupe best-effort */ }
  const today = new Date().toISOString().slice(0, 10);
  const safeTitle = JSON.stringify(title);
  const md = `---\ntitle: ${safeTitle}\ncreated: ${today}\nsource: neuroworks\n---\n\n# ${title.replace(/[\r\n]+/g, " ")}\n\n${body}\n`;
  push(`writing ${rel}`);
  writeVaultFile(rel, md);
  push("committing vault");
  const answer = `Saved note "${title.slice(0, 80)}" → ${rel}`;
  try {
    const r = await commitAndPush(`note: ${title.slice(0, 80)}`);
    return { path: rel, answer, ...r };
  } catch (e: any) {
    push(`commit failed (note kept at ${rel}): ${String(e?.message ?? e).slice(0, 120)}`);
    return { path: rel, commitOk: false, error: String(e?.message ?? e).slice(0, 200), answer: `${answer} (commit failed)` };
  }
}

// Analyze-spreadsheet + stock-check runners — thin wrappers over
// generalTaskRunner. The playbook itself lives in the data-analysis /
// inventory-analysis skills (auto-loaded by the planner via skill
// matching); the runner's job is only to build a self-contained task so
// the agent starts with file + goal + output conventions pinned, instead
// of a bare "analyze X" that meanders. Template autosave is off — the
// template already exists, no need to mint a custom copy per run.
async function analyzeSpreadsheetRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void) {
  const file = String(inputs.file ?? "").trim();
  if (!file) throw new Error("missing 'file' input (vault path, upload, or local path to the CSV/XLSX)");
  const goal = String(inputs.goal ?? "").trim().slice(0, 2000) || "profile, clean, explore, and report the key findings";
  const task = `Analyze the spreadsheet at "${file}" and answer: ${goal}\n\n` +
    `Follow the data-analysis skill playbook: locate the file (vault.read, upload context, or local folder — for .xlsx pick the right sheet, never assume sheet 1); ` +
    `profile it (shape, dtypes, nulls, dupes, ranges) and print a compact profile; clean it per the HR checklist (drop redundant columns, rename headers, drop exact dupes, decide per-column what NaNs mean) and save a cleaned copy as <name>.cleaned.csv next to the original — never modify the source file; ` +
    `explore with pandas (distributions, top-N categoricals, trends if dated, correlation map) — compute every number with executed Python (the \`python\` binary has pandas/sklearn/matplotlib), never eyeball aggregates; ` +
    `save 2-4 charts (one message per chart, matplotlib Agg backend — headless, no display) as PNGs under _naxion/analysis/<slug>/; ` +
    `if the goal asks for prediction, train the simplest model that beats a naive baseline, report the comparison honestly, and persist model + rerun script under _naxion/models/<slug>/; ` +
    `finish with a findings memo (headline numbers, drivers with evidence, chart list, caveats/assumptions, recommended actions) written to the vault. ` +
    `Keep raw rows out of the prompt — summaries and profiles only, at most ~20 sample rows for illustration.`;
  return generalTaskRunner({ ...inputs, task, save_as_template: false }, push, progress);
}

async function stockCheckRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void) {
  const file = String(inputs.file ?? "").trim();
  if (!file) throw new Error("missing 'file' input (vault path, upload, or local path to the stock CSV)");
  const coverDays = Math.min(365, Math.max(1, parseInt(String((inputs as any).coverDays ?? "14"), 10) || 14));
  const task = `Stock level check on "${file}". Alert threshold: reorder when days-of-cover drops below ${coverDays} days.\n\n` +
    `Follow the inventory-analysis skill math: per SKU compute average daily usage (units sold / days in period), days-of-cover (on-hand / daily usage), and where lead-time data exists, reorder point = (daily usage × lead-time days) + safety stock. ` +
    `Read the CSV with pandas (the \`python\` binary has pandas/openpyxl), resolve column names flexibly (SKU/item/product/code, qty/on-hand/stock, sold/sales/usage, lead-time). ` +
    `Output the skill's action-list shape: REORDER NOW table (SKU, on hand, daily usage, days cover, order qty, by when), a WATCH table (will breach within ~2× threshold), and overstock/dead-stock flags. ` +
    `State assumptions (usage period, lead times used). Write the report to the vault. Compute, don't estimate — every number from executed code.`;
  return generalTaskRunner({ ...inputs, task, save_as_template: false }, push, progress);
}

export async function generalTaskRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void) {  const task = String(inputs.task ?? "").trim().slice(0, 8000);
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
  // Internal callers (e.g. daily-briefing) pass `_skipPeerReview` to opt a
  // fixed-format, non-user-facing output out of the QA wave's slowest phase.
  const skipPeerReview = inputs._skipPeerReview === true;
  const r = await planAndExecute(task, push, (patch) => progress?.(patch as Record<string, unknown>), { personaSystemSuffix: personaSuffix, workMode: persona?.workMode, testMode, signal, taskKind: "insights:general-task", persona: persona?.name, personaId: persona?.id, skipPeerReview });

  // If the agent wrote anything to the vault, also commit + push
  if (r.hadWrites) {
    push("Wrote to your second brain — committing the changes.");
    try {
      const c = await commitAndPush(`naxie: agent task — ${task.slice(0, 60)}`);
      push(`Vault commit: ${(c as any)?.ok === false ? "failed" : "done"}${(c as any)?.sha ? ` (${String((c as any).sha).slice(0, 7)})` : ""}.`);
    } catch (e: any) { push(`Commit didn't go through (non-fatal): ${e.message ?? e}.`); }
  }

  let savedTemplateId: string | undefined;
  const allOk = r.runs.length > 0 && r.runs.every(x => x.ok);
  if (saveAs && allOk && r.plan.steps.length > 0) {
    let id = `custom-${slugify(task).slice(0, 60) || "task"}`;
    try {
      if (findCustomTemplate(id)) id = `${id}-${Date.now().toString(36)}`;
      const tpl: CustomTemplate = {
        id, role: "Custom",
        title: r.plan.summary || task.slice(0, 80),
        description: `Saved from chat: "${task.slice(0, 200)}"`,
        origin: { task, createdAt: new Date().toISOString() },
        plan: r.plan,
        runCount: 1, lastRunAt: new Date().toISOString(),
      };
      saveCustomTemplate(tpl);
      savedTemplateId = id;
      push(`Saved this workflow as a reusable template: ${id}.`);
    } catch (e: any) {
      push(`Template autosave skipped (non-fatal): ${String(e?.message ?? e).slice(0, 120)}`);
    }
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
// sourced report on ways to improve Naxie: agent-AI techniques, AI
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
// _naxion/session/. The innovation scan mines these so its report is
// grounded in (and can cite) what the org has actually been asking the agents,
// not just web headlines — and so "summarise the innovation scan" has real
// session signal to reference instead of timing out on fresh web research.
function gatherRecentSessionNotes(sinceMs: number, cap = 8): { path: string; mtime: string; text: string }[] {
  return gatherRecentNotesUnder(["_naxion/session", "_naxion/sessions", "session", "sessions"], sinceMs, cap);
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

async function innovationScanRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: ProgressFn) {
  const focus = String(inputs.focus ?? "").trim().slice(0, 300);
  const today = new Date().toISOString().slice(0, 10);
  const staged = stagedProgress(progress, ["Read inbox signal", "Read session signal", "Write report", "Story leads"]);

  // Local signal — recent 0-Inbox notes read as PRIMARY evidence. Grounds the
  // scan in what's actually landing in the vault instead of leaning entirely on
  // web search (which returned nothing for our private product name — the "zero
  // results" failure the last scan hit). Window: last 10 days by default, which
  // covers the inbox files the briefing flagged as unread.
  const sinceDays = Math.min(30, Math.max(1, Number(inputs.inboxDays ?? 10) || 10));
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
  staged.completeStep(0);

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
  staged.completeStep(1);

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
  staged.completeStep(2);

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
  staged.completeStep(3);
  staged.setPhase("done");
  return result;
}

// ─── Social content loop (email → Buffer draft) + self-improving optimiser ───
const SOCIAL_DIR = "_naxion/social";



function readVaultText(rel: string): string | null {
  try {
    const abs = resolve(config.vaultPath, rel);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8");
  } catch { return null; }
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

type StorySource = { title: string; url?: string; text: string; links?: string[]; score?: number; reason?: string; publishedAt?: string };

// ─────────────────────────────────────────────────────────────────────────────
// News scraping config — QUALITY-FIRST pipeline for daily AI/Tech news
//
// Design: multi-tier sourcing + dedupe + enrichment + LLM quality scoring
// Tiers:  (1) Curated RSS (high-authority, ≤48h, never hallucinated)
//         (2) Live web search (Tavily/Firecrawl → DDG/Bing fallback, quality queries)
//         (3) Innovation-scan leads (vault, Africa only)
// All tiers carry a REAL url; LLM never invents one.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_AFRICA_QUERIES = [
  "Zimbabwe AI startup funding tech news",
  "South Africa artificial intelligence startup policy news",
  "Africa tech summit AI conference 2026",
  "African tech startup AI innovation Nairobi Lagos Cape Town Johannesburg",
  "Africa AI policy regulation Africa Tech Summit",
  "Zimbabwe AI technology deployment TechZim",
  "African machine learning research healthcare agriculture fintech",
  "Africa artificial intelligence breakthrough funding 2026",
  // Added 2026-10-16: the scan missed a North-Africa AI-breach story because no
  // query covered security or North Africa — keep at least one of each live.
  "Africa AI cybersecurity breach hacking government database",
  "North Africa AI technology news Morocco Algeria Tunisia Egypt",
];
// NOTE: SI coverage lives here, inside global AI news — the standalone
// super-intelligence-news feed was removed 2026-10-12. The first query below
// keeps frontier/SI stories surfacing in the World AI edition, and existing
// `_naxion/news/<date>-si.md` vault cards are kept as history.
const DEFAULT_WORLD_QUERIES = [
  '"Super Intelligence" SI AI technology news policy',
  "AI breakthrough model release 2026",
  "generative AI funding acquisition startup",
  "AI infrastructure chip hardware NVIDIA OpenAI",
  "artificial intelligence research paper arXiv",
  "global AI regulation policy",
  "tech AI product launch enterprise",
  // Added 2026-10-16: direct lab + enterprise angles so primary sources
  // (lab blogs) and deployment news surface instead of only press rewrites.
  "Anthropic OpenAI DeepMind model release announcement safety research",
  "enterprise AI deployment regulation funding acquisition",
];

// Queries for the Africa Tech Alerts scan (africa-tech-alerts): dangerous OR
// amazing tech in, around and to Africa — threats (breaches, AI-enabled crime,
// scams, surveillance) and breakthroughs (first-of-its-kind launches, record
// funding, major rollouts). Separate from the main Africa feed so the daily
// edition stays broad while alerts stay sharp.
const DEFAULT_ALERTS_QUERIES = [
  "Africa AI cyberattack data breach hacking government",
  "Africa AI breakthrough record funding major launch 2026",
  "AI fraud deepfake scam surveillance Africa",
  "Africa first-of-its-kind AI milestone data center satellite",
];

const DEFAULT_EVENTS_QUERIES = [
  "site:devpost.com hackathon AI",
  "site:lablab.ai hackathon",
  "GDG Harare DevFest tech events",
  "Meetup Harare technology events",
  "Eventbrite Harare tech conference",
  "Zimbabwe tech events hackathon 2026",
  "South Africa AI hackathon technology events",
  "Africa startup pitch competition technology",
  "Devpost AI hackathon online remote",
  "Africa tech conference summit expo 2026",
  "startup competition Africa prize technology innovation",
  "Cape Town Johannesburg tech summit AI 2026",
];
const AFRICA_TECH_RSS_HINTS = ["africa", "african", "zimbabwe", "nairobi", "lagos", "kenya", "nigeria", "south africa", "rwanda", "ethiopia", "morocco", "algeria", "tunisia", "libya", "egypt", "north africa", "maghreb", "mena", "cybersecurity", "breach", "hack", "iss", "iafrica"];
const DEFAULT_HIGH_AUTHORITY = [
  "arxiv.org","openai.com","deepmind.google","ai.google","blog.google","huggingface.co",
  "microsoft.com","research.microsoft.com","nvidia.com","blogs.nvidia.com","aws.amazon.com",
  "github.blog","github.com","techcrunch.com","theverge.com","wired.com","arstechnica.com",
  "technologyreview.com","reuters.com","bloomberg.com","nature.com","science.org",
  "simonwillison.net","techzim.co.zw","disrupt-africa.com","ventureburn.com","techcabal.com","techinafrica.com",
  // Added 2026-10-16: African AI portals/policy sources + lab/newsletter domains
  "iafrica.com","issafrica.org","aiafricanews.co.za","africaainews.com","itweb.africa","cioafrica.co","ai4d.ai",
  "aimagazine.com","artificialintelligence-news.com","therundown.ai","tldr.tech","every.to","anthropic.com","lastweekin.ai"
];
const SPAM_HINTS = ["seo","content farm","sponsored","clickbait","/tag/","/category/"];

// ── Per-feed tuning via env + file (admin UI) ──────────────────────────────
// Env overrides (deployment-level):
//   NEWS_AFRICA_QUERIES="q1|q2|q3"  (pipe-separated, or JSON array)
//   NEWS_WORLD_QUERIES="q1|q2"
//   NEWS_AUTHORITY_DOMAINS="arxiv.org,openai.com,..." (comma or |)
//   NEWS_BREAKING_THRESHOLD=8
//   NEWS_HISTORY_DAYS=7
// File override (admin UI persistence): .naxion/news-config.json
//   { africaQueries:[], worldQueries:[], authorityDomains:[], breakingThreshold:8, historyDays:7 }
// Effective = file > env > default
const _rfs = readFileSync; const _wfs = writeFileSync; const _exs = existsSync; const _mks = mkdirSync;
const NEWS_CONFIG_FILE = resolve(process.cwd(), ".naxion/news-config.json");
// also try server-local .naxion when running from server dir
const NEWS_CONFIG_FILE_ALT = resolve(resolve(config.vaultPath, ".."), ".naxion/news-config.json");
function envList(name: string): string[] | null {
  const v = process.env[name]?.trim();
  if (!v) return null;
  if (v.startsWith("[")) { try { const arr = JSON.parse(v); if (Array.isArray(arr)) return arr.map(String).map(s=>s.trim()).filter(Boolean); } catch {} }
  return v.split(/[|,]/).map(s=>s.trim()).filter(Boolean);
}
function loadNewsFileConfig(): { africaQueries?: string[]; worldQueries?: string[]; eventsQueries?: string[]; authorityDomains?: string[]; breakingThreshold?: number; historyDays?: number } {
  for (const p of [NEWS_CONFIG_FILE, NEWS_CONFIG_FILE_ALT]) {
    try { if (_exs(p)) return JSON.parse(_rfs(p, "utf8")); } catch {}
  }
  return {};
}
function effectiveAfricaQueries(): string[] {
  const f = loadNewsFileConfig();
  if (f.africaQueries?.length) return f.africaQueries;
  const e = envList("NEWS_AFRICA_QUERIES"); if (e?.length) return e;
  return DEFAULT_AFRICA_QUERIES;
}
function effectiveWorldQueries(): string[] {
  const f = loadNewsFileConfig();
  if (f.worldQueries?.length) return f.worldQueries;
  const e = envList("NEWS_WORLD_QUERIES"); if (e?.length) return e;
  return DEFAULT_WORLD_QUERIES;
}

function effectiveEventsQueries(): string[] {
  const f = loadNewsFileConfig();
  if (f.eventsQueries?.length) return f.eventsQueries;
  const e = envList("NEWS_EVENTS_QUERIES"); if (e?.length) return e;
  return DEFAULT_EVENTS_QUERIES;
}
function effectiveAuthorityDomains(): Set<string> {
  const f = loadNewsFileConfig();
  if (f.authorityDomains?.length) return new Set(f.authorityDomains.map(s=>s.toLowerCase()));
  const e = envList("NEWS_AUTHORITY_DOMAINS"); if (e?.length) return new Set(e.map(s=>s.toLowerCase()));
  return new Set(DEFAULT_HIGH_AUTHORITY);
}
function effectiveBreakingThreshold(): number {
  const f = loadNewsFileConfig();
  if (typeof f.breakingThreshold === "number") return f.breakingThreshold;
  const e = Number(process.env.NEWS_BREAKING_THRESHOLD); if (Number.isFinite(e)) return e;
  return 8;
}
function effectiveHistoryDays(): number {
  const f = loadNewsFileConfig();
  if (typeof f.historyDays === "number") return f.historyDays;
  const e = Number(process.env.NEWS_HISTORY_DAYS); if (Number.isFinite(e)) return Math.max(1, Math.min(30, e));
  return 7;
}
// Thin wrappers so existing call-sites keep reading the same names (now functions)
const AFRICA_NEWS_QUERIES = effectiveAfricaQueries();
const WORLD_NEWS_QUERIES = effectiveWorldQueries();
const HIGH_AUTHORITY_DOMAINS = effectiveAuthorityDomains();

// ── Cross-feed dedupe (shared picked-today memory) ────────────────────────
// Africa/World/Events must never post the same story on the same day.
// Each runner claims its picked URLs into a per-day file; dedupeAndFilter
// below honours every feed's claims, so whichever edition runs first wins
// and later editions pick something else.
function claimedTodayPath(date = new Date().toISOString().slice(0, 10)): string {
  return resolve(config.vaultPath, "_naxion/news", `claimed-${date}.json`);
}
function loadClaimedToday(): Set<string> {
  try {
    const p = claimedTodayPath();
    if (!_exs(p)) return new Set();
    const arr = JSON.parse(_rfs(p, "utf8"));
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}
function claimUrlsToday(urls: (string | undefined)[]): void {
  try {
    const set = loadClaimedToday();
    let added = 0;
    for (const u of urls) {
      const key = normalizeUrlForDedup(u);
      if (key && !set.has(key)) { set.add(key); added++; }
    }
    if (!added) return;
    const p = claimedTodayPath();
    _mks(resolve(p, ".."), { recursive: true } as any);
    _wfs(p, JSON.stringify([...set].slice(-500), null, 1));
  } catch { /* best-effort — a claim failure must never block a post */ }
}

// ── Events deadline tracker ───────────────────────────────────────────────
// The events scan writes machine-readable {name, deadline, url} rows here;
// the deadline-reminders schedule reads them and nudges at 7/3/1 days out.
// Merge by URL (latest scan wins), drop entries whose deadline passed >7d
// ago to keep the file small.
type TrackedDeadline = { name: string; deadline: string; url: string };
function eventsTrackerPath(): string {
  return resolve(config.vaultPath, "_naxion/news", "events-tracker.json");
}
function loadEventsTracker(): TrackedDeadline[] {
  try {
    const p = eventsTrackerPath();
    if (!_exs(p)) return [];
    const arr = JSON.parse(_rfs(p, "utf8"));
    if (!Array.isArray(arr)) return [];
    return arr.filter(e => e && typeof e.name === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(e.deadline ?? "") && typeof e.url === "string");
  } catch { return []; }
}
function saveEventsTracker(rows: TrackedDeadline[], push?: (m: string) => void): void {
  try {
    const byUrl = new Map<string, TrackedDeadline>();
    for (const e of loadEventsTracker()) byUrl.set(normalizeUrlForDedup(e.url), e);
    for (const e of rows) byUrl.set(normalizeUrlForDedup(e.url), e);
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    const kept = [...byUrl.values()].filter(e => new Date(e.deadline + "T12:00:00").getTime() >= cutoff).slice(-200);
    const p = eventsTrackerPath();
    _mks(resolve(p, ".."), { recursive: true } as any);
    _wfs(p, JSON.stringify(kept, null, 1));
    push?.(`[tracker] ${kept.length} deadlines tracked`);
  } catch { /* best-effort */ }
}

// Fallback deadline miner for the events card: finds explicit calendar dates
// near URLs ("Oct 30, 2026", "30 October 2026", "2026-10-30") and resolves
// them to ISO. Names come from the nearest preceding emoji-led row header.
function extractDeadlinesFromText(postText: string): { name: string; deadline: string; url: string }[] {
  const MONTHS: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const out: { name: string; deadline: string; url: string }[] = [];
  const seen = new Set<string>();
  const urlRe = /https?:\/\/[^\s)>\]]+/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(postText))) {
    const url = m[0].replace(/[.,;]+$/, "");
    const key = normalizeUrlForDedup(url);
    if (!key || seen.has(key)) continue;
    const window = postText.slice(Math.max(0, m.index - 500), m.index + 50);
    const dm = window.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:\s*,?\s*(20\d{2}))?/i)
      ?? window.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s*,?\s*(20\d{2}))?/i)
      ?? window.match(/(20\d{2})-(\d{2})-(\d{2})/);
    if (!dm) continue;
    let y = 0, mo = 0, d = 0;
    if (dm[0].includes("-") && /^20\d{2}$/.test(dm[1] ?? "")) {
      y = Number(dm[1]); mo = Number(dm[2]); d = Number(dm[3]); // ISO YYYY-MM-DD
    } else if (MONTHS[(dm[1] ?? "").toLowerCase()]) {
      mo = MONTHS[dm[1].toLowerCase()]; d = Number(dm[2]); y = dm[3] ? Number(dm[3]) : new Date().getFullYear(); // Month DD [, YYYY]
    } else if (MONTHS[(dm[2] ?? "").toLowerCase()]) {
      d = Number(dm[1]); mo = MONTHS[dm[2].toLowerCase()]; y = dm[3] ? Number(dm[3]) : new Date().getFullYear(); // DD Month [, YYYY]
    } else continue;
    if (!mo || d < 1 || d > 31) continue;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (new Date(iso + "T12:00:00").getTime() < Date.now() - 86400_000) continue; // past
    const nameM = window.match(/(?:^|\n)\s*(?:💻|🚀|🎪|🌍|🎯|⭐)[^\n]{4,120}/);
    const name = (nameM?.[0] ?? "Tech event").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s*\|.*$/, "").trim().slice(0, 120) || "Tech event";
    seen.add(key);
    out.push({ name, deadline: iso, url });
    if (out.length >= 10) break;
  }
  return out;
}

function normalizeUrlForDedup(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = ""; u.searchParams.delete("utm_source"); u.searchParams.delete("utm_medium");
    u.searchParams.delete("utm_campaign"); u.searchParams.delete("utm_content");
    // strip trailing slash, lowercase host
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, "")}${u.search}`.toLowerCase();
  } catch { return url.toLowerCase().replace(/\/$/, ""); }
}
function domainOf(url: string | undefined): string {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}
function authorityBoost(url: string | undefined): number {
  const d = domainOf(url);
  if (!d) return 0;
  const auth = effectiveAuthorityDomains();
  for (const h of auth) if (d === h || d.endsWith("."+h)) return 2;
  return 0;
}
function isSpammy(s: StorySource): boolean {
  const hay = `${s.title} ${s.text} ${s.url}`.toLowerCase();
  if (SPAM_HINTS.some(h => hay.includes(h))) return true;
  if (s.title.length < 15) return true;
  // RSS items have short initial text (source+date+title) but get enriched later — allow down to 25 chars
  if (s.text.length < 25) return true;
  return false;
}

// Low-level web sweep for a given query set. Returns real-URL stories, deduped.
async function scrapeStoriesForQueries(queries: string[], push: (m: string) => void, label: string): Promise<StorySource[]> {
  const out: StorySource[] = []; const seen = new Set<string>();
  try {
    const prim = findPrimitive("web.search");
    if (prim) {
      for (const q of queries) {
        const r: any = await prim.handler({ query: q, limit: 5 });
        for (const it of (r?.results ?? [])) {
          const url = it?.url ? String(it.url).replace(/[.,]$/, "") : "";
          if (!url || seen.has(normalizeUrlForDedup(url))) continue; seen.add(normalizeUrlForDedup(url));
          const title = String(it.title ?? "Untitled").slice(0, 160);
          const text = String(it.snippet ?? it.content ?? "").slice(0, 600);
          if (!title || isSpammy({ title, url, text })) continue;
          // Prefer items with a publish hint in snippet or those that will be enriched later
          out.push({ title, url, text });
          // also store soft authority hint in text tail for the scorer (stripped before display)
        }
        if (out.length >= 14) break;
      }
      if (out.length) push(`[${label}] web search gathered ${out.length} candidates (quality-filtered).`);
    }
  } catch (e: any) { push(`[${label}] web search skipped: ${String(e?.message ?? e).slice(0, 80)}`); }
  return out;
}

async function fetchRssTier(push: (m: string) => void, forAfrica: boolean): Promise<StorySource[]> {
  try {
    const { fetchCuratedRss } = await import("../lib/rss-client.js");
    const items = await fetchCuratedRss(); // already ≤48h, sorted newest-first
    const filtered = forAfrica
      ? items.filter(it => {
          // Keep all high-quality AI/tech, but boost African items to the top
          const hay = `${it.title} ${it.source}`.toLowerCase();
          const isAfrica = AFRICA_TECH_RSS_HINTS.some(k => hay.includes(k));
          return true; // keep all; scorer will rank Africa higher for Africa feed
        }).map(it => ({ title: it.title.slice(0,160), url: it.url, text: `[${it.source} · ${it.publishedAt.slice(0,10)}] ${it.title}` }))
      : items.map(it => ({ title: it.title.slice(0,160), url: it.url, text: `[${it.source} · ${it.publishedAt.slice(0,10)}] ${it.title}` }));
    // Africa feed: bubble Africa-tagged RSS to front
    if (forAfrica) {
      filtered.sort((a,b) => {
        const aAfrica = AFRICA_TECH_RSS_HINTS.some(k => a.text.toLowerCase().includes(k)) ? 1 : 0;
        const bAfrica = AFRICA_TECH_RSS_HINTS.some(k => b.text.toLowerCase().includes(k)) ? 1 : 0;
        return bAfrica - aAfrica;
      });
    }
    const slice = filtered.slice(0, 8);
    if (slice.length) push(`[rss/${forAfrica?"africa":"world"}] curated feeds: ${slice.length} fresh items (≤48h).`);
    return slice;
  } catch (e:any) { push(`[rss] skipped: ${String(e?.message??e).slice(0,80)}`); return []; }
}

async function enrichTopStories(stories: StorySource[], push: (m:string)=>void, topN=6): Promise<StorySource[]> {
  // Enrich the most promising N with full-page text so the quality scorer has substance, not just snippets
  try {
    const { smartFetch } = await import("../lib/web-client.js");
    const toEnrich = stories.slice(0, topN).filter(s => !!s.url && /^https?:\/\//i.test(s.url!));
    await Promise.all(toEnrich.map(async (s) => {
      try {
        const r = await smartFetch(s.url!, { maxBytes: 8000, timeoutMs: 8000 });
        const clean = r.text.replace(/\s+/g," ").trim().slice(0, 900);
        if (clean.length > 80 && clean.length > s.text.length * 0.3) {
          const before = s.text.length;
          s.text = `${s.text}\n${clean}`.slice(0, 1100);
          push(`[enrich] ${domainOf(s.url)} ${before} → ${s.text.length} chars`);
        }
      } catch { /* keep snippet */ }
    }));
  } catch {}
  return stories;
}

function loadRecentPostedUrls(days: number, push?: (m:string)=>void): Set<string> {
  const cutoff = Date.now() - days*24*3600_000;
  const urls = new Set<string>();
  const roots = [
    resolve(config.vaultPath, "_naxion/news"),
    resolve(config.vaultPath, "_naxion/social"),
    resolve(config.vaultPath, "_naxion/news/drafts"),
  ];
  const urlRe = /https?:\/\/[^\s"')\]]+/gi;
  for (const root of roots) {
    try {
      const walk = (dir: string) => {
        let ents: any[] = [];
        try { ents = readdirSync(dir, { withFileTypes: true }) as any[]; } catch { return; }
        for (const e of ents) {
          const p = join(dir, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          if (!/\.(md|json|jsonl)$/i.test(e.name)) continue;
          try {
            const st = statSync(p);
            if (st.mtimeMs < cutoff) continue;
            const txt = readFileSync(p, "utf8");
            for (const m of txt.matchAll(urlRe)) urls.add(normalizeUrlForDedup(m[0].replace(/[.,;]+$/, "")));
          } catch {}
        }
      };
      walk(root);
    } catch {}
  }
  if (push && urls.size) push(`[history] ${urls.size} URLs posted in last ${days}d`);
  return urls;
}

async function dedupeAndFilter(stories: StorySource[], push: (m:string)=>void): Promise<StorySource[]> {
  const history = loadRecentPostedUrls(effectiveHistoryDays(), push);
  const claimed = loadClaimedToday();
  const seen = new Set<string>(); const out: StorySource[] = [];
  for (const s of stories) {
    const key = normalizeUrlForDedup(s.url);
    if (!key) continue;
    if (seen.has(key)) continue; seen.add(key);
    if (history.has(key)) { push(`[history] skip already-posted ${domainOf(s.url)}`); continue; }
    if (claimed.has(key)) { push(`[claimed] skip picked-by-earlier-edition ${domainOf(s.url)}`); continue; }
    if (isSpammy(s)) continue;
    out.push(s);
  }
  // Keep most authoritative + longest text first before scoring
  out.sort((a,b) => (authorityBoost(b.url) - authorityBoost(a.url)) || (b.text.length - a.text.length));
  if (stories.length !== out.length) push(`[filter] deduped ${stories.length} → ${out.length} (spam/history removed)`);
  return out;
}

async function scoreStoriesQuality(stories: StorySource[], push: (m:string)=>void, forAfrica: boolean): Promise<StorySource[]> {
  if (stories.length <= 1) {
    // still attach a score so urgency gate can read it
    for (const s of stories) s.score = 5 + authorityBoost(s.url);
    return stories;
  }
  // Single LLM triage call scores every candidate 0-10 on quality dimensions
  const numbered = stories.slice(0, 12).map((s,i) => `[${i+1}] ${s.title} (${domainOf(s.url)}) — ${s.text.slice(0,400)} [authority:${authorityBoost(s.url)}]`).join("\n\n");
  const rubric = forAfrica
    ? "African angle FIRST (a Zimbabwe/South Africa/pan-African story outranks a bigger global one), then AI/Tech core vs tangential, recency ≤48h > ≤7d > older, source credibility, factual substance (names/numbers specifics), impact/novelty. A story with no African substance scores at most 5 no matter how big globally"
    : "Global AI/Tech relevance, recency ≤48h, source credibility (lab/tier1 press), factual substance, impact/novelty";
  try {
    const raw = (await llmGenerate(
      `Score each candidate 0-10 for QUALITY AI/Tech news. Rubric: ${rubric}. Return ONLY JSON array [{"idx":1,"score":8,"reason":"one line"}] ordered by idx. Candidates:\n\n${numbered.slice(0,6500)}`,
      "You are a strict quality ranker for AI/Tech news. No hype, no invented facts, JSON only.",
      { maxTokens: 700 }
    )).trim().replace(/```json?\s*/gi,"").replace(/```/g,"").trim();
    const scores: {idx:number;score:number;reason:string}[] = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    const map = new Map(scores.map(s=>[s.idx, s.score]));
    const reasonMap = new Map(scores.map(s=>[s.idx, s.reason]));
    const scored = stories.map((s,i)=>{
      let sc = map.get(i+1) ?? 5 + authorityBoost(s.url);
      // Africa feed: hard Africa-angle re-rank so a global story can never
      // top an African one (live 2026-10-07: a US DOJ memo outranked every
      // African candidate). +2 for a genuine African angle, capped at 10.
      if (forAfrica) {
        const hay = `${s.title} ${s.text}`.toLowerCase();
        if (AFRICA_TECH_RSS_HINTS.some(k => hay.includes(k))) sc = Math.min(10, sc + 2);
      }
      s.score = sc; s.reason = reasonMap.get(i+1) ?? "";
      return {s, score: sc};
    });
    scored.sort((a,b)=> b.score - a.score);
    push(`[quality] scored ${scores.length} candidates — top: ${scored.slice(0,3).map(x=>`#${stories.indexOf(x.s)+1}:${x.score} ${x.s.reason?.slice(0,40)??""}`).join(" | ")}`);
    return scored.map(x=>x.s);
  } catch (e:any) {
    push(`[quality] scoring skipped: ${String(e?.message??e).slice(0,80)} — keeping authority-sorted order`);
    for (const s of stories) if (s.score === undefined) s.score = 5 + authorityBoost(s.url);
    return stories;
  }
}

  function logNewsMetrics(feed: "africa"|"world"|"events"|"weekend"|"alerts", candidates: StorySource[], picked: StorySource | null, push?: (m:string)=>void) {
  const breakdown = candidates.slice(0, 8).map((c,i)=> ({ idx:i+1, domain: domainOf(c.url), score: c.score, title: c.title.slice(0,60) }));
  const detail = `${feed} candidates=${candidates.length} picked=${picked?.url ?? "none"} score=${picked?.score ?? "?"} domains=${breakdown.map(b=>b.domain).join(",")}`;
  try { logAudit({ level: "info", actor: "news", action: `${feed}.pick`, target: picked?.url ?? "none", detail, result: picked ? "success" : "failure" }); } catch {}
  // vault metrics line for dashboard (_naxion/news/metrics.jsonl)
  try {
    const metricsPath = resolve(config.vaultPath, "_naxion/news/metrics.jsonl");
    _mks(resolve(metricsPath, ".."), { recursive: true } as any);
    const rec = JSON.stringify({ ts: new Date().toISOString(), feed, candidates: candidates.length, picked: picked ? { url: picked.url, domain: domainOf(picked.url), score: picked.score, title: picked.title } : null, breakdown }) + "\n";
    _wfs(metricsPath, rec, { flag: "a" } as any);
  } catch {}
  if (push) push(`[metrics] ${detail}`);
}

function writeNewsVault(feed: "africa"|"world"|"events"|"weekend"|"alerts", card: { postText: string; story: string }, picked: StorySource) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const stamp = new Date().toISOString().slice(0, 16).replace(/:/, "");
    const dir = `_naxion/news`;
    const path = `${dir}/${date}-${feed}.md`;
    const body = `---\nfeed: ${feed}\ndate: ${date}\nurl: ${picked.url ?? ""}\nscore: ${picked.score ?? ""}\ndomain: ${domainOf(picked.url)}\n---\n\n${card.postText}\n`;
    writeVaultFile(path, body);
    // also append to drafts history for dedupe already covers this path
  } catch (e:any) { console.warn(`[news] vault write failed: ${e?.message}`); }
}
function writeNewsDraft(feed: "africa"|"world"|"events"|"weekend"|"alerts", candidates: StorySource[], reason: string) {
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace(/:/, "");
    const path = `_naxion/news/drafts/${stamp}-${feed}-below-threshold.md`;
    const body = `---\nfeed: ${feed}\ndraft: true\nreason: ${reason}\n---\n\n# Draft — ${feed} ${stamp} (below threshold)\n\nTop candidates were below BREAKING threshold (${effectiveBreakingThreshold()}).\n\n${candidates.slice(0,5).map((c,i)=>`${i+1}. [${c.score}] ${c.title} — ${c.url} — ${c.reason??""}`).join("\n")}\n`;
    writeVaultFile(path, body);
  } catch {}
}

// Staged-pipeline progress for template runners that DON'T go through
// planAndExecute (news cards, briefing evidence, scan preambles). Those
// runners previously never called progress(), so their Runs page row sat
// frozen on "running" with no steps until the job completed — "no progress
// showing while in progress". This seeds a step plan up front (steps render
// immediately) and marks steps done as stages complete, in the exact
// {plan.steps[], runs[{step,runs,ok}]} shape the Runs UI reads.
type ProgressFn = (p: Record<string, unknown>) => void;
function stagedProgress(progress: ProgressFn | undefined, labels: string[]) {
  const steps = labels.map(label => ({ label, tool: "pipeline" }));
  const done: { tool: string; label: string; ms: number }[] = [];
  const t0 = Date.now();
  const emit = (phase: string) => {
    try {
      progress?.({
        phase,
        plan: { steps },
        runs: done.map(d => ({ step: { tool: d.tool, label: d.label }, ok: true, durationMs: d.ms })),
      });
    } catch { /* progress is best-effort — never break the run */ }
  };
  emit("executing");
  return {
    // Mark one planned step complete (by index) plus optional extra labels.
    completeStep: (index: number, tool = "pipeline") => {
      if (steps[index] && !done.some(d => d.label === steps[index].label)) {
        done.push({ tool, label: steps[index].label, ms: Date.now() - t0 });
      }
      emit("executing");
    },
    setPhase: (phase: string) => emit(phase),
  };
}

// Fallback story material when the source mailbox has nothing fresh: a live web
// sweep for African-AI news (each result carries a REAL url), plus any story
// leads saved by the innovation scan. Returns real stories so the draft always
// has a genuine link to reference. Guarantees there's always something to post.
// Kept as the public name for backwards-compat (buffer-story-post calls it).
async function gatherFallbackStories(push: (m: string) => void): Promise<StorySource[]> {
  return gatherAfricaStories(push);
}
async function gatherAfricaStories(push: (m: string) => void, onStage?: (stage: "sweep" | "dedupe" | "enrich" | "rank") => void): Promise<StorySource[]> {
  push("[africa] quality pipeline: RSS (≤48h) + web search + innovation leads → dedupe → enrich → quality rank");
  const [rss, web] = await Promise.all([
    fetchRssTier(push, true),
    scrapeStoriesForQueries([...new Set([...effectiveAfricaQueries(), '"Super Intelligence" Africa SI AI research policy news'])], push, "africa"),
  ]);
  onStage?.("sweep");
  let merged: StorySource[] = [...rss, ...web];
  // Innovation-scan leads as extra candidates (bullet lines → title + optional url).
  const leads = readVaultText(`${SOCIAL_DIR}/story-leads.md`);
  if (leads && leads.trim().length > 80) {
    let added = 0;
    const seen = new Set(merged.map(s=>normalizeUrlForDedup(s.url)));
    for (const line of leads.split("\n")) {
      const t = line.replace(/^\s*[-*]\s*/, "").trim();
      if (t.length < 25 || /^#/.test(line)) continue;
      const url = (t.match(/https?:\/\/[^\s)>\]]+/) ?? [""])[0].replace(/[.,]$/, "");
      if (url && seen.has(normalizeUrlForDedup(url))) continue; if (url) seen.add(normalizeUrlForDedup(url));
      merged.push({ title: t.replace(/https?:\/\/\S+/g, "").replace(/[()]/g, "").slice(0, 160).trim(), url: url || `lead:${added}`, text: t.slice(0, 500) });
      added++;
      if (merged.length >= 20) break;
    }
    if (added) push(`[africa] +${added} innovation-scan leads`);
  }
  merged = await dedupeAndFilter(merged, push);
  onStage?.("dedupe");
  merged = await enrichTopStories(merged, push, 6);
  onStage?.("enrich");
  merged = await scoreStoriesQuality(merged, push, true);
  onStage?.("rank");
  return merged.slice(0, 12);
}
async function gatherWorldStories(push: (m: string) => void, onStage?: (stage: "sweep" | "dedupe" | "enrich" | "rank") => void): Promise<StorySource[]> {
  push("[world] quality pipeline: RSS (≤48h) + web search → dedupe → enrich → quality rank");
  const [rss, web] = await Promise.all([
    fetchRssTier(push, false),
    scrapeStoriesForQueries([...new Set(effectiveWorldQueries())], push, "world"),
  ]);
  onStage?.("sweep");
  let merged: StorySource[] = [...rss, ...web];
  merged = await dedupeAndFilter(merged, push);
  onStage?.("dedupe");
  merged = await enrichTopStories(merged, push, 6);
  onStage?.("enrich");
  merged = await scoreStoriesQuality(merged, push, false);
  onStage?.("rank");
  return merged.slice(0, 12);
}

// Africa Tech Alerts pool (africa-tech-alerts): same quality pipeline as the
// main Africa feed (RSS + web + dedupe + enrich + Africa-weighted rank) but
// swept with threat/breakthrough queries so dangerous or amazing tech gets its
// own card instead of competing with the daily edition's broad startup/policy
// mix. Shares claimed-today dedupe so the two editions never post one story.
async function gatherAlertsStories(push: (m: string) => void, onStage?: (stage: "sweep" | "dedupe" | "enrich" | "rank") => void): Promise<StorySource[]> {
  push("[alerts] quality pipeline: RSS (≤48h) + threat/breakthrough search → dedupe → enrich → quality rank");
  const [rss, web] = await Promise.all([
    fetchRssTier(push, true),
    scrapeStoriesForQueries([...new Set(DEFAULT_ALERTS_QUERIES)], push, "alerts"),
  ]);
  onStage?.("sweep");
  let merged: StorySource[] = [...rss, ...web];
  merged = await dedupeAndFilter(merged, push);
  onStage?.("dedupe");
  merged = await enrichTopStories(merged, push, 6);
  onStage?.("enrich");
  merged = await scoreStoriesQuality(merged, push, true);
  onStage?.("rank");
  return merged.slice(0, 12);
}


async function gatherEventsStories(push: (m: string) => void, onStage?: (stage: "sweep" | "dedupe" | "enrich") => void): Promise<StorySource[]> {
  push("[events] pipeline: RSS (≤48h) + events web search → dedupe → enrich");
  const [rss, web] = await Promise.all([
    fetchRssTier(push, false),
    scrapeStoriesForQueries([...new Set(effectiveEventsQueries())], push, "events"),
  ]);
  onStage?.("sweep");
  let merged: StorySource[] = [...rss, ...web];
  merged = await dedupeAndFilter(merged, push);
  onStage?.("dedupe");
  merged = await enrichTopStories(merged, push, 8);
  onStage?.("enrich");
  return merged.slice(0, 20);
}

// Build a single BREAKING NEWS card from a pool of real stories. The model
// picks the single most newsworthy story and returns structured fields; we
// assemble the exact user-requested format so the link is always real.
async function buildBreakingNewsCard(opts: {
  stories: StorySource[];
  header: string;            // e.g. "🚨 BREAKING NEWS — Africa AI 🚨"
  whyHeader: string;         // e.g. "Why it matters for Africa"
  defaultHashtags: string;   // e.g. "#AI #Africa #AINews"
  sourceLabel: string;       // e.g. "web + innovation leads"
  videoUrl?: string;
  push: (m: string) => void;
  systemPrompt: string;
}): Promise<{ postText: string; story: string; videoScript: string; raw: any }> {
  if (!opts.stories.length) throw new Error("no stories to build from");
  // Candidates are already quality-ranked (RSS ≤48h + enriched + LLM-scored), so #1 is best by default
  const numbered = opts.stories.slice(0, 10).map((s, i) => `[${i + 1}] ${s.title}${s.url ? ` (${s.url})` : ""}\n${(s.text ?? "").slice(0, 650)}`).join("\n\n---\n\n");
  const prompt =
    `Candidates below are PRE-RANKED by quality (1 = highest quality: fresh ≤48h, high-authority source, strong AI/Tech substance). Prefer #1 unless another is clearly more newsworthy/impactful.\n` +
    `Pick the SINGLE best story for a BREAKING NEWS card. Summarise ONLY that story using facts from its text — do not invent, do not hallucinate names/numbers/URLs.\n\n` +
    `Quality bar: reject candidates with vague titles, <80-char substance, or no concrete detail — pick the next one instead.\n\n` +
    `Output EXACTLY these labelled lines (plain text, no markdown, no angle brackets):\n` +
    `PICK: <source number 1..N>\n` +
    `TITLE: <short title, max 80 chars, factual>\n` +
    `SUMMARY: <3-5 sentences, factual, what happened / who / key details / implication - use enriched text>\n` +
    `WHY_IT_MATTERS: <2-3 sentences: why this matters for the audience — grounded, no hype>\n` +
    `HASHTAGS: <4-6 hashtags space-separated, include the defaults plus story-specific ones>\n` +
    `VIDEO_SCRIPT: <20-35s spoken narration, first person plural ("we"), no URLs/hashtags, narrates the summary>\n\n` +
    `Defaults to weave in: ${opts.defaultHashtags}\n` +
    `WHY header is "${opts.whyHeader}" — use that framing.\n\n` +
    `CANDIDATES (pre-ranked):\n\n${numbered.slice(0, 6500)}`;
  const raw = (await llmGenerate(prompt, opts.systemPrompt, { maxTokens: 900 })).trim();
  const grab = (label: string) => {
    const m = raw.match(new RegExp(`^[\\s>*#-]*${label}\\s*:?\\s*([\\s\\S]*?)(?=\\n[\\s>*#-]*(?:PICK|TITLE|SUMMARY|WHY_IT_MATTERS|HASHTAGS|VIDEO_SCRIPT)\\s*:|$)`, "im"));
    return (m?.[1] ?? "").replace(/```[a-z]*\n?/gi, "").replace(/\*\*/g, "").trim().replace(/^["']|["']$/g, "").trim();
  };
  const pickN = parseInt((grab("PICK").match(/\d+/) ?? ["1"])[0], 10);
  const chosen = opts.stories[Math.min(Math.max(1, pickN), opts.stories.length) - 1] ?? opts.stories[0];
  const title = grab("TITLE") || chosen.title;
  const summary = grab("SUMMARY") || (chosen.text ?? "").slice(0, 400);
  // The card template already prints the why-header line above this text, but
  // the model often echoes it ("Why it matters for Africa: ...") producing a
  // doubled header (live 2026-10-07). Strip any such echo.
  const why = (grab("WHY_IT_MATTERS") || "").replace(/^\s*why it matters[^:]*:\s*/i, "").trim();
  let hashtags = grab("HASHTAGS") || opts.defaultHashtags;
  if (hashtags && !hashtags.includes("#")) hashtags = hashtags.split(/\s+/).filter(Boolean).map(h => `#${h.replace(/^#/, "")}`).join(" ");
  const videoScript = grab("VIDEO_SCRIPT") || toVideoScript(summary);
  const rawUrl = String((chosen as any)?.url ?? "");
  // Innovation-lead pseudo-URLs ("lead:0") are not postable — drop them so
  // cards never print "Read more: lead:0" and never pollute claimed-*.json.
  const readMore = /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
  const lines: string[] = [];
  lines.push(opts.header);
  lines.push("");
  lines.push(title);
  lines.push("");
  lines.push(summary);
  lines.push("");
  lines.push(opts.whyHeader);
  lines.push(why);
  lines.push("");
  if (readMore) lines.push(`📰 Read more: ${readMore}`);
  lines.push("");
  lines.push(hashtags);
  if (opts.videoUrl) { lines.push(""); lines.push(`\uD83C\uDFAC Video: ${opts.videoUrl}`); }
  lines.push("");
  lines.push(`Source: ${opts.sourceLabel}`);
  const storyLine = `**${title}:** ${(chosen.text ?? summary).slice(0, 160).replace(/\s+/g, " ").trim()} — ${readMore || "(no link)"}`;
  lines.push(`Story: ${storyLine}`);
  const postText = lines.join("\n");
  const story = `${title} — ${readMore || (chosen as any)?.title}`.slice(0, 220);
  return { postText, story, videoScript, raw: { pickN, title, summary, why, hashtags, chosenUrl: readMore || undefined } };
}

// Shared breaking-news pipeline — africa/world/si differ only in feed config
// (queries, headers, prompts). Single place for gate → card → vault → post → claim.
type BreakingFeed = "africa" | "world" | "alerts";
async function breakingNewsPipeline(opts: {
  kind: string; feed: BreakingFeed; chatId: string; videoUrl?: string; dailyDigest: boolean;
  stages: string[]; sweepMessage: string;
  gather: (push: (m: string) => void, onStage: (s: string) => void) => Promise<any[]>;
  emptyNote: string; headerBreaking: string; headerDaily: string;
  whyHeader: string; hashtagsBreaking: string; hashtagsDaily: string;
  sourceLabel: string; systemPrompt: string; postedMessage: string;
  push: (m: string) => void; progress?: ProgressFn;
}) {
  const staged = stagedProgress(opts.progress, opts.stages as any);
  const stageToStep: Record<string, number> = { sweep: 0, dedupe: 1, enrich: 1, rank: 2 };
  opts.push(opts.sweepMessage);
  const stories = await opts.gather(opts.push, (s) => staged.completeStep((stageToStep as any)[s] ?? 0));
  if (!stories.length) {
    opts.push(opts.emptyNote);
    logNewsMetrics(opts.feed as any, stories, null, opts.push);
    return { kind: opts.kind, posted: false, note: opts.emptyNote };
  }
  const threshold = effectiveBreakingThreshold();
  const topScore = stories[0]?.score ?? 5;
  if (topScore < threshold && !opts.dailyDigest) {
    const reason = `top score ${topScore} < threshold ${threshold} — not breaking enough`;
    opts.push(`[gate] ${reason} — queuing as draft, not posting to Telegram`);
    writeNewsDraft(opts.feed as any, stories, reason);
    logNewsMetrics(opts.feed as any, stories, stories[0] ?? null, opts.push);
    return { kind: opts.kind, posted: false, draft: true, note: reason, topScore, threshold };
  }
  opts.push(opts.dailyDigest
    ? `Picked ${stories.length} fresh candidates (top score ${topScore}) — drafting the daily card.`
    : `Picked ${stories.length} candidates (top score ${topScore}) — drafting the BREAKING NEWS card.`);
  const card = await buildBreakingNewsCard({
    stories,
    header: opts.dailyDigest ? opts.headerDaily : opts.headerBreaking,
    whyHeader: opts.whyHeader,
    defaultHashtags: opts.dailyDigest ? opts.hashtagsDaily : opts.hashtagsBreaking,
    sourceLabel: opts.sourceLabel,
    videoUrl: opts.videoUrl,
    push: opts.push,
    systemPrompt: opts.systemPrompt,
  });
  staged.completeStep(3);
  const pickedIdx = (card.raw?.pickN ?? 1) - 1;
  const picked = stories[Math.min(Math.max(0, pickedIdx), stories.length - 1)] ?? stories[0];
  logNewsMetrics(opts.feed as any, stories, picked, opts.push);
  writeNewsVault(opts.feed as any, card, picked);
  const tg = findPrimitive("telegram.send");
  if (!tg) throw new Error("telegram.send primitive unavailable");
  staged.setPhase("posting");
  const sent = await tg.handler({ text: card.postText, chatId: opts.chatId });
  staged.completeStep(4);
  staged.setPhase("done");
  if (sent?.ok) claimUrlsToday([picked?.url, (card as any)?.raw?.chosenUrl, ...[...card.postText.matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m: any) => m[0].replace(/[.,;]+$/, ""))]);
  opts.push(sent?.ok ? `${opts.postedMessage} Telegram chat ${opts.chatId}.` : `Telegram post failed: ${sent?.error ?? "unknown error"}`);
  return { kind: opts.kind, posted: !!sent?.ok, chatId: opts.chatId, answer: card.postText, story: card.story, videoScript: card.videoScript, topScore, threshold, error: sent?.ok ? undefined : sent?.error };
}

// Africa news — BREAKING NEWS card for AI Institute Africa (with urgency gate + metrics + vault)
async function africaAiNewsRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: ProgressFn) {
  const chatId = await resolveTemplateChatId(inputs);
  const videoUrl = String(inputs.videoUrl ?? "").trim() || undefined;
  const dailyDigest = inputs.dailyDigest === true;
  return breakingNewsPipeline({
    kind: "africa-ai-news", feed: "africa", chatId, videoUrl, dailyDigest, push, progress,
    stages: ["Sweep RSS + web + leads", "Dedupe + enrich", "Quality rank", "Build news card", "Post to Telegram"],
    sweepMessage: "Sweeping for today's Africa/AI news (web + innovation leads).",
    gather: gatherAfricaStories,
    emptyNote: "No fresh Africa/AI news found today — skipping the post.",
    headerBreaking: "🚨 BREAKING NEWS — Africa AI 🚨", headerDaily: "🧠 DAILY AI NEWS — Africa",
    whyHeader: "Why it matters for Africa",
    hashtagsBreaking: "#AI #Africa #AINews", hashtagsDaily: "#AI #Africa #AINews",
    sourceLabel: "web + innovation leads (RSS ≤48h + web + leads)",
    systemPrompt: "You are the editor for an Africa AI and Super Intelligence news channel. Pick a fresh, newsworthy Africa/technology story and write a factual Telegram card. Use 'Super Intelligence (SI)' when reporting the US executive-branch terminology in Executive Order 14434; for the broader global field, keep the terminology used by the source (often AI/artificial intelligence). Do not imply the US directive renames technology or usage outside its stated executive-branch scope. No hype or invented facts/links; keep it warm and credible.",
    postedMessage: "Posted Africa BREAKING NEWS to",
  });
}

// Africa Tech Alerts — BREAKING card for dangerous OR amazing tech in, around
// and to Africa as a whole (breaches, AI-enabled crime, surveillance scares on
// one side; first-of-its-kind breakthroughs, record funding, major rollouts on
// the other). Same gate → card → vault → post → claim pipeline as Africa/World.
async function africaAlertsRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: ProgressFn) {
  const chatId = await resolveTemplateChatId(inputs);
  const videoUrl = String(inputs.videoUrl ?? "").trim() || undefined;
  const dailyDigest = inputs.dailyDigest === true;
  return breakingNewsPipeline({
    kind: "africa-tech-alerts", feed: "alerts", chatId, videoUrl, dailyDigest, push, progress,
    stages: ["Sweep threats + breakthroughs", "Dedupe + enrich", "Quality rank", "Build alerts card", "Post to Telegram"],
    sweepMessage: "Sweeping for dangerous or amazing tech in, around and to Africa.",
    gather: gatherAlertsStories,
    emptyNote: "No fresh Africa tech alerts today — skipping the post.",
    headerBreaking: "🚨 BREAKING — Africa Tech Alerts 🚨", headerDaily: "⚡ AFRICA TECH ALERTS — Daily",
    whyHeader: "Why it matters",
    hashtagsBreaking: "#Africa #TechAlerts #Breaking", hashtagsDaily: "#Africa #TechAlerts #AINews",
    sourceLabel: "RSS ≤48h + web search (threats + breakthroughs)",
    systemPrompt: "You are the alerts editor for an Africa tech channel. Pick the single most urgent or most astonishing story — a DANGEROUS one (breach, hack, AI-enabled crime, scam, surveillance abuse, outage) or an AMAZING one (breakthrough, first-of-its-kind launch, record funding, major rollout) happening in, around or to Africa — and write a factual Telegram card. No hype or invented facts/links; keep it sharp and credible.",
    postedMessage: "Posted Africa Tech Alerts to",
  });
}

// World news — BREAKING NEWS card for global AI/world stories (with urgency gate + metrics + vault)
async function worldAiNewsRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: ProgressFn) {
  const chatId = await resolveTemplateChatId(inputs);
  const videoUrl = String(inputs.videoUrl ?? "").trim() || undefined;
  const dailyDigest = inputs.dailyDigest === true;
  const _worldCfg = {
    kind: "world-ai-news", feed: "world" as BreakingFeed, chatId, videoUrl, dailyDigest, push, progress,
    stages: ["Sweep RSS + web", "Dedupe + enrich", "Quality rank", "Build news card", "Post to Telegram"],
    sweepMessage: "Sweeping for today's World AI news (RSS + web search).",
    gather: gatherWorldStories,
    emptyNote: "No fresh World news found today — skipping the post.",
    whyHeader: "Why it matters",
    sourceLabel: "RSS ≤48h + web search",
    postedMessage: "Posted World BREAKING NEWS to",
  };
  const _worldCard = await breakingNewsPipeline({
    ..._worldCfg,
    headerBreaking: "🚨 BREAKING NEWS - World News 🚨", headerDaily: "🧠 DAILY SUPER INTELLIGENCE / AI NEWS — World",
    hashtagsBreaking: "#WorldNews #AI #BreakingNews", hashtagsDaily: "#WorldNews #AI #AINews",
    systemPrompt: "You are a world news editor covering AI, technology and Super Intelligence. Pick a fresh, newsworthy global story and write a factual Telegram card.",
  });
  return _worldCard;
}

// REMOVED: super-intelligence-news — standalone SI feed deleted per operator
// request ("just keep AI news"). The `case` above throws a clear error so old
// schedules/jobs fail loudly instead of 404ing. Africa + World remain via
// breakingNewsPipeline; weekend/evening now cover Africa + World only.

// Events & Competition Scan — daily table of tech events, hackathons,
// innovation challenges/expos, startup pitch and corporate software
// competitions (Zimbabwe, South Africa, pan-African + minimum 2 global
// remote hackathons). ~80% free / ~20% paid. A listing, not a single story,
// so there is no breaking-news gate: it posts whenever candidates exist.
// Posts wherever the caller points it (the 07:30 schedule targets the
// operator DM, not the news group).
async function eventsCompetitionScanRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: ProgressFn) {
  const chatId = await resolveTemplateChatId(inputs);
  const staged = stagedProgress(progress, ["Sweep event sources", "Dedupe + enrich", "Build events table", "Post to Telegram"]);
  const stageToStep: Record<string, number> = { sweep: 0, dedupe: 1, enrich: 1 };

  push("Sweeping tech events, hackathons and competitions (ZW + SA + pan-African + global remote).");
  const stories = await gatherEventsStories(push, (s) => staged.completeStep(stageToStep[s]));
  if (!stories.length) {
    const skip = "No tech events or competitions found today — skipping the post.";
    push(skip);
    logNewsMetrics("events", stories, null, push);
    return { kind: "events-competition-scan", posted: false, note: skip };
  }

  push(`Formatting ${stories.length} event candidates into the scan table.`);
  const numbered = stories.slice(0, 20).map((s, i) => `[${i + 1}] ${s.title}${s.url ? ` (${s.url})` : ""}\n${(s.text ?? "").slice(0, 650)}`).join("\n\n---\n\n");
  const date = new Date().toISOString().slice(0, 10);
  const raw = (await llmGenerate(
    `From the event candidates below, build a rich EVENTS & COMPETITION SCAN for ${date} — this must read like an insider briefing, not a bare list.\n\n` +
    `Rules:\n` +
    `- Pick up to 10 entries: tech summits/conferences, hackathons, innovation challenges/expos, startup pitch competitions, corporate software competitions, tech challenges.\n` +
    `- Geography: Zimbabwe first, then South Africa, then pan-African (incl. virtual). Then append AT LEAST 2 global fully-remote hackathons from the candidates (prefer Devpost / lablab.ai listings).\n` +
    `- Substance filter: PREFER candidates with concrete dates, venues, prizes or deadlines. At most 2 entries may carry TBA dates; drop vague candidates when dated ones exist. Include at least 1 paid entry whenever any candidate shows a price or ticket.\n` +
    `- Mix: roughly 80% free, 20% paid. Mark each Free or Paid (verify from the text; when unsure say Free).\n` +
    `- For EVERY entry dig out: organiser/host, deadline (registration or event date), prize or stakes if any (cash, funding, trip, exposure), who it's for (students, founders, developers…), and one punchy WHY-ATTEND line (what you concretely get: money, network, skills, visibility).\n` +
    `- Dates are URGENT info: today is ${date}. Write every date/deadline as "Oct 30 (23 days left)" — count the days from today, never write a bare date. Skip entries already over before today.\n` +
    `- Drop candidates with no usable detail (no date AND no prize AND no clear venue/audience) unless Zimbabwe-based. At most 2 entries may carry TBA dates; a card of all-TBA rows is a failure: prefer entries with money, deadlines and names attached.\n` +
    `- Lead each row with the category emoji: 💻 hackathon/coding challenge, 🚀 pitch/startup competition, 🎪 conference/summit/expo, 🌍 fully-remote global hackathon.\n` +
    `- Use ONLY facts from the candidate texts — never invent dates, venues, links, prizes or deadlines. If a detail is absent, write "TBA" rather than guessing. Drop candidates with no usable detail instead of guessing.\n\n` +
    `Output EXACTLY these labelled sections (plain text, no markdown, no angle brackets):\n` +
    `HEADER: 📅 EVENTS & COMPETITION SCAN — ${date}\n` +
    `TOPPICK: the single highest-value event, format "Event name — why it is the one not to miss (prize/deadline hook) | URL"\n` +
    `ROWS: one block per event, exactly this shape:\n` +
    `<category emoji> Event name\n` +
    `📅 Date (start–end, with days-left countdown) | 📍 Location or Remote | Free/Paid\n` +
    `🏆 Prize/stakes (or "—") | ⏰ Deadline (with days-left countdown, or TBA)\n` +
    `👥 Who: audience | 🔗 URL\n` +
    `💡 Why attend: one punchy line\n` +
    `Separate event blocks with a blank line.\n` +
    `FOOTER: one line with the free/paid counts, e.g. "8 free · 2 paid · 2 remote global"\n` +
    `TRACKER: one line per event that HAS a concrete deadline, format "Event name | YYYY-MM-DD | URL" (deadline = registration close, else event start; ISO date only, no countdown text). Skip TBA entries here.\n\n` +
    `CANDIDATES:\n\n${numbered.slice(0, 8000)}`,
    "You are an events-desk editor for African tech. Rich, concrete briefings only — every entry must carry prize, deadline and a why-attend hook. No hype, no invented facts or links.",
    { maxTokens: 2000 },
  )).trim();
  // The model misspells or decorates labels (live: "TOPICK:", "**HEADER:**",
  // echoed "FOOTER:" inside ROWS). Match fuzzily, then strip ANY surviving
  // label echo from the assembled card so raw "LABEL:" text never posts.
  const LABELS = "(?:HEADER|TOPP?ICK|TOP PICK|ROWS|FOOTER|TRACKER)";
  const grab = (label: string) => {
    const alt = label === "TOPPICK" ? "(?:TOPPICK|TOPICK|TOP PICK)" : label;
    const m = raw.match(new RegExp(`^[\\s>*#-]*${alt}\\s*:?\\s*([\\s\\S]*?)(?=\\n[\\s>*#-]*(?:${LABELS})\\s*:|$)`, "im"));
    return (m?.[1] ?? "").replace(/```[a-z]*\n?/gi, "").trim().replace(/^["']|["']$/g, "").trim();
  };
  const stripLabelEchoes = (text: string) =>
    text.split("\n")
      .map(l => l.replace(new RegExp(`^[\\s>*#-]*${LABELS}\\s*:?\\s*`, "i"), "").trimEnd())
      .filter(l => !new RegExp(`^[\\s>*#-]*${LABELS}\\s*:?\\s*$`, "i").test(l))
      .join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const header = grab("HEADER") || `📅 EVENTS & COMPETITION SCAN — ${date}`;
  const toppick = grab("TOPPICK");
  const rows = grab("ROWS") || raw.slice(0, 4000);
  const footer = grab("FOOTER");
  const postText = stripLabelEchoes([header, "", ...(toppick ? [`⭐ TOP PICK: ${toppick}`, ""] : []), rows, ...(footer ? ["", footer] : []), "", "Source: web sweep (RSS ≤48h + event listings + hackathon hubs)"].join("\n"));
  // Machine-readable deadline tracker (powers the deadline-reminders
  // schedule). Parsed strictly — bad lines are dropped, never posted.
  const tracker: { name: string; deadline: string; url: string }[] = [];
  const _todayNoon = new Date(date + "T12:00:00").getTime();
  for (const line of grab("TRACKER").split("\n")) {
    const parts = line.split("|").map(s => s.trim());
    if (parts.length < 3) continue;
    const [name, deadline, url] = parts;
    if (!name || !/^20\d{2}-\d{2}-\d{2}$/.test(deadline)) continue;
    const t = new Date(deadline + "T12:00:00").getTime();
    if (!Number.isFinite(t)) continue;
    // Drop past deadlines (LLM hallucinates last year's dates) and absurdly
    // far futures (>400d — usually a year typo). Computed in code, not LLM.
    const daysOut = Math.round((t - _todayNoon) / 86400_000);
    if (daysOut < 0 || daysOut > 400) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    tracker.push({ name: name.slice(0, 120), deadline, url });
  }
  if (tracker.length) {
    saveEventsTracker(tracker, push);
  } else {
    // Fallback: the model often skips TRACKER even when rows carry real
    // dates ("Oct 30 (23 days left)"). Mine explicit Month-DD-YYYY dates
    // near URLs straight from the posted table.
    const mined = extractDeadlinesFromText(postText);
    if (mined.length) saveEventsTracker(mined, push);
    else push("[tracker] no machine-readable deadlines this run");
  }
  staged.completeStep(2);

  // Frontmatter should point at a real event link from the card — stories[0]
  // is just pipeline order (often a news article), so lift the first URL out
  // of the posted table instead.
  const firstUrl = (postText.match(/https?:\/\/[^\s)>\]]+/) ?? [""])[0].replace(/[.,;]+$/, "");
  const picked = firstUrl ? { ...stories[0], url: firstUrl } : stories[0];
  logNewsMetrics("events", stories, picked, push);
  writeNewsVault("events", { postText, story: rows.split("\n")[0]?.slice(0, 220) ?? "" }, picked);

  const tg = findPrimitive("telegram.send");
  if (!tg) throw new Error("telegram.send primitive unavailable");
  staged.setPhase("posting");
  const sent = await tg.handler({ text: postText, chatId });
  staged.completeStep(3);
  staged.setPhase("done");
  if (sent?.ok) {
    const urls = [...postText.matchAll(/https?:\/\/[^\s)>\]]+/g)].map(m => m[0].replace(/[.,;]+$/, ""));
    claimUrlsToday(urls);
  }
  push(sent?.ok ? `Posted Events & Competition Scan to Telegram chat ${chatId}.` : `Telegram post failed: ${sent?.error ?? "unknown error"}`);
  return { kind: "events-competition-scan", posted: !!sent?.ok, chatId, answer: postText, topScore: undefined, threshold: undefined, error: sent?.ok ? undefined : sent?.error };
}

// Deadline reminders — reads the events-tracker file and posts one reminder
// card for anything due in 7, 3 or 1 days. Quiet (posted:false) when nothing
// is due, so the schedule never spams. Urgency ordering: due-tomorrow first.
async function deadlineRemindersRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: ProgressFn) {
  const chatId = await resolveTemplateChatId(inputs);
  const staged = stagedProgress(progress, ["Read deadline tracker", "Post reminders"]);
  const tracked = loadEventsTracker();
  staged.completeStep(0);
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const due: { entry: { name: string; deadline: string; url: string }; daysLeft: number }[] = [];
  for (const e of tracked) {
    const t = new Date(e.deadline + "T12:00:00").getTime();
    if (!Number.isFinite(t)) continue;
    const daysLeft = Math.round((t - today.getTime()) / 86400_000);
    if (daysLeft === 7 || daysLeft === 3 || daysLeft === 1 || daysLeft === 0) due.push({ entry: e, daysLeft });
  }
  // Same-day dedupe: a retry/re-fire must not double-post. Marker file
  // _naxion/news/reminded-<date>.json holds already-sent name|deadline keys.
  const dateKey = today.toISOString().slice(0, 10);
  const remindedPath = resolve(config.vaultPath, "_naxion/news", `reminded-${dateKey}.json`);
  let reminded: Set<string> = new Set();
  try {
    if (_exs(remindedPath)) {
      const arr = JSON.parse(_rfs(remindedPath, "utf8"));
      if (Array.isArray(arr)) reminded = new Set(arr.map(String));
    }
  } catch { /* best-effort */ }
  const fresh = due.filter(d => !reminded.has(`${d.entry.name}|${d.entry.deadline}`));
  if (fresh.length !== due.length) push(`[reminders] skipped ${due.length - fresh.length} already sent today`);
  due.length = 0; due.push(...fresh);
  if (!tracked.length) push(`[tracker] empty — events scan hasn't produced machine-readable deadlines yet`);
  if (!due.length) {
    const skip = reminded.size
      ? `All due reminders already sent today (${reminded.size} sent, ${tracked.length} tracked) — staying quiet.`
      : `No event deadlines due in 7/3/1 days (${tracked.length} tracked) — staying quiet.`;
    push(skip);
    return { kind: "deadline-reminders", posted: false, note: skip, tracked: tracked.length };
  }
  due.sort((a, b) => a.daysLeft - b.daysLeft);
  const line = (d: typeof due[number]) =>
    d.daysLeft <= 0
      ? `🔴 <b>${d.entry.name}</b> — due TODAY (${d.entry.deadline}): ${d.entry.url}`
      : d.daysLeft === 1
        ? `🔴 <b>${d.entry.name}</b> — tomorrow (${d.entry.deadline}): ${d.entry.url}`
        : d.daysLeft <= 3
          ? `🟡 <b>${d.entry.name}</b> — ${d.daysLeft} days left (${d.entry.deadline}): ${d.entry.url}`
          : `🟢 <b>${d.entry.name}</b> — ${d.daysLeft} days left (${d.entry.deadline}): ${d.entry.url}`;
  // sendTelegramMessage takes markdown and converts to Telegram HTML itself.
  const postText = [`⏰ **Event deadlines approaching**`, ``, ...due.map(d => line(d).replace(/<\/?b>/g, "**")), ``, `_${due.length} reminder${due.length === 1 ? "" : "s"} from the tracked events scan_`].join("\n");
  const tg = findPrimitive("telegram.send");
  if (!tg) throw new Error("telegram.send primitive unavailable");
  const sent = await tg.handler({ text: postText, chatId });
  staged.completeStep(1);
  staged.setPhase("done");
  if (sent?.ok) {
    try {
      for (const d of due) reminded.add(`${d.entry.name}|${d.entry.deadline}`);
      _mks(resolve(remindedPath, ".."), { recursive: true } as any);
      _wfs(remindedPath, JSON.stringify([...reminded].slice(-200), null, 1));
    } catch { /* marker best-effort */ }
  }
  push(sent?.ok ? `Posted ${due.length} deadline reminder(s) to Telegram chat ${chatId}.` : `Telegram post failed: ${sent?.error ?? "unknown error"}`);
  return { kind: "deadline-reminders", posted: !!sent?.ok, chatId, answer: postText, error: sent?.ok ? undefined : sent?.error };
}

// Evening recap — stitches today's edition cards (Africa, World,
// events) into one "Today in AI" digest. No web sweep: it reuses the vault
// cards the morning pipeline already wrote, so it costs one LLM call.
async function eveningRecapRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: ProgressFn) {
  const chatId = await resolveTemplateChatId(inputs);
  const staged = stagedProgress(progress, ["Read today's cards", "Stitch evening digest", "Post to Telegram"]);
  const date = new Date().toISOString().slice(0, 10);
  const sections: { feed: string; body: string }[] = [];
  for (const feed of ["africa", "alerts", "world", "events"]) {
    try {
      const p = resolve(config.vaultPath, "_naxion/news", `${date}-${feed}.md`);
      if (!_exs(p)) { push(`[recap] no ${feed} card today — skipping section`); continue; }
      const raw = _rfs(p, "utf8").replace(/^---\n[\s\S]*?\n---\n+/, "").trim();
      if (raw) sections.push({ feed, body: raw.slice(0, 2500) });
    } catch { /* one missing card never sinks the recap */ }
  }
  staged.completeStep(0);
  if (!sections.length) {
    const skip = "No edition cards found for today — skipping the evening recap.";
    push(skip);
    return { kind: "evening-recap", posted: false, note: skip };
  }
  push(`Stitching ${sections.length} edition(s) into the evening digest.`);
  const digest = (await llmGenerate(
    `Stitch these daytime edition cards into ONE evening digest for a Telegram group audience that may have missed them. ` +
    `Format (plain text, no markdown, no angle brackets):\n` +
    `HEADER: 🌙 TODAY IN AI — ${date}\n` +
    `AFRICA: one line (top Africa story + link)\n` +
    `ALERTS: one line (top threat/breakthrough + link), or "no alerts today"\n` +
    `WORLD: one line (top world story + link)\n` +
    `EVENTS: one line (most urgent deadline/event + link), or "no events today"\n` +
    `SIGNOFF: one short warm line (e.g. see you tomorrow 07:30)\n\n` +
    `Keep every URL exactly as given — never invent or shorten links.\n\n` +
    sections.map(s => `== ${s.feed.toUpperCase()} ==\n${s.body}`).join("\n\n"),
    "You are an evening news editor writing a tight same-day recap. Links verbatim, no hype.",
    { maxTokens: 800 },
  )).trim();
  const grab = (label: string) => {
    const m = digest.match(new RegExp(`^[\\s>*#-]*${label}\\s*:?\\s*([\\s\\S]*?)(?=\\n[\\s>*#-]*(?:HEADER|AFRICA|ALERTS|WORLD|EVENTS|SIGNOFF)\\s*:|$)`, "im"));
    return (m?.[1] ?? "").replace(/```[a-z]*\n?/gi, "").trim().replace(/^["']|["']$/g, "").trim();
  };
  const clean = (t: string) => t.split("\n").map(l => l.replace(/^\s*(?:HEADER|AFRICA|ALERTS|WORLD|EVENTS|SIGNOFF)\s*:?\s*/i, "").trimEnd()).filter(l => !/^\s*(?:HEADER|AFRICA|ALERTS|WORLD|EVENTS|SIGNOFF)\s*:?\s*$/i.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const postText = clean([
    grab("HEADER") || `🌙 TODAY IN AI — ${date}`, "",
    grab("AFRICA"), grab("ALERTS"), grab("WORLD"), grab("EVENTS"), "",
    grab("SIGNOFF"),
  ].filter(Boolean).join("\n"));
  staged.completeStep(1);
  if (!postText) {
    push("Digest came back empty — skipping the post.");
    return { kind: "evening-recap", posted: false, note: "empty digest" };
  }
  // Drop hallucinated links: only URLs already present in this morning's
  // cards may go out (and into tomorrow's dedupe). Extras are stripped.
  const knownUrls = new Set([...sections.map(s => s.body).join("\n").matchAll(/https?:\/\/[^\s)>\]]+/g)].map(m => m[0].replace(/[.,;]+$/, "")));
  let safeText = postText;
  const found = [...postText.matchAll(/https?:\/\/[^\s)>\]]+/g)].map(m => m[0].replace(/[.,;]+$/, ""));
  const unknown = found.filter(u => !knownUrls.has(u));
  if (unknown.length) {
    push(`[recap] stripped ${unknown.length} hallucinated link(s)`);
    for (const u of unknown) safeText = safeText.split(u).join("(link in morning card)");
  }
  const tg = findPrimitive("telegram.send");
  if (!tg) throw new Error("telegram.send primitive unavailable");
  staged.setPhase("posting");
  const sent = await tg.handler({ text: safeText, chatId });
  staged.completeStep(2);
  staged.setPhase("done");
  if (sent?.ok) {
    claimUrlsToday([...safeText.matchAll(/https?:\/\/[^\s)>\]]+/g)].map(m => m[0].replace(/[.,;]+$/, "")));
    try { writeVaultFile(`_naxion/news/${date}-evening.md`, `---\nkind: evening-recap\ndate: ${date}\n---\n\n${safeText}\n`); } catch { /* audit best-effort */ }
  }
  push(sent?.ok ? `Posted evening recap to Telegram chat ${chatId}.` : `Telegram post failed: ${sent?.error ?? "unknown error"}`);
  return { kind: "evening-recap", posted: !!sent?.ok, chatId, answer: safeText, error: sent?.ok ? undefined : sent?.error };
}

// Weekend digest — ONE combined Africa + World AI card for Saturday/Sunday
// mornings, replacing the two weekday editions (which run Mon–Fri only).
async function weekendDigestRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: ProgressFn) {
  const chatId = await resolveTemplateChatId(inputs);
  const staged = stagedProgress(progress, ["Sweep all feeds", "Dedupe + rank", "Build weekend card", "Post to Telegram"]);
  push("Weekend sweep: Africa + World queries in one pass.");
  // Round-robin across the two AI feeds, capped at 12 queries.
  const _aq = effectiveAfricaQueries(); const _wq = effectiveWorldQueries();
  const _mixed: string[] = [];
  for (let i = 0; i < Math.max(_aq.length, _wq.length) && _mixed.length < 12; i++) {
    for (const q of [_aq[i], _wq[i]]) if (q && !_mixed.includes(q) && _mixed.length < 12) _mixed.push(q);
  }
  const [rss, web] = await Promise.all([
    fetchRssTier(push, false),
    scrapeStoriesForQueries(_mixed, push, "weekend"),
  ]);
  staged.completeStep(0);
  let merged: StorySource[] = [...rss, ...web];
  merged = await dedupeAndFilter(merged, push);
  merged = await enrichTopStories(merged, push, 6);
  merged = await scoreStoriesQuality(merged, push, false);
  staged.completeStep(1);
  if (!merged.length) {
    const skip = "No fresh stories for the weekend digest — skipping the post.";
    push(skip);
    logNewsMetrics("weekend", merged, null, push);
    return { kind: "weekend-digest", posted: false, note: skip };
  }
  // Top 3 from distinct domains for variety.
  const picks: StorySource[] = [];
  for (const s of merged) {
    if (picks.length >= 3) break;
    if (picks.some(p => domainOf(p.url) === domainOf(s.url))) continue;
    picks.push(s);
  }
  push(`Picked ${picks.length} stories for the weekend card.`);
  const numbered = picks.map((s, i) => `[${i + 1}] ${s.title}${s.url ? ` (${s.url})` : ""}\n${(s.text ?? "").slice(0, 500)}`).join("\n\n---\n\n");
  const date = new Date().toISOString().slice(0, 10);
  const raw = (await llmGenerate(
    `Build a WEEKEND AI DIGEST for ${date} from these ${picks.length} pre-ranked stories (1 = best).\n\n` +
    `Output EXACTLY these labelled lines (plain text, no markdown, no angle brackets):\n` +
    `HEADER: 🌴 WEEKEND AI DIGEST — ${date}\n` +
    `STORIES: one block per story: "Title"\n"2-sentence factual summary"\n"🔗 URL"\n"Why it matters in one line", blocks separated by a blank line\n` +
    `FOOTER: one relaxed weekend sign-off line\n\n` +
    `Use ONLY facts from the texts — never invent dates, links or details.\n\n${numbered.slice(0, 5000)}`,
    "You are a weekend news editor. Relaxed but factual, links verbatim, no hype.",
    { maxTokens: 1200 },
  )).trim();
  const grab = (label: string) => {
    const m = raw.match(new RegExp(`^[\\s>*#-]*${label}\\s*:?\\s*([\\s\\S]*?)(?=\\n[\\s>*#-]*(?:HEADER|STORIES|FOOTER)\\s*:|$)`, "im"));
    return (m?.[1] ?? "").replace(/```[a-z]*\n?/gi, "").trim().replace(/^["']|["']$/g, "").trim();
  };
  const clean = (t: string) => t.split("\n").map(l => l.replace(/^\s*(?:HEADER|STORIES|FOOTER)\s*:?\s*/i, "").trimEnd()).filter(l => !/^\s*(?:HEADER|STORIES|FOOTER)\s*:?\s*$/i.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const postText = clean([grab("HEADER") || `🌴 WEEKEND AI DIGEST — ${date}`, "", grab("STORIES") || raw.slice(0, 3000), "", grab("FOOTER")].filter(Boolean).join("\n"));
  staged.completeStep(2);
  if (!postText) {
    push("Digest came back empty — skipping the post.");
    return { kind: "weekend-digest", posted: false, note: "empty digest" };
  }
  logNewsMetrics("weekend", merged, picks[0] ?? null, push);
  if (picks[0]) writeNewsVault("weekend", { postText, story: picks[0].title.slice(0, 220) }, picks[0]);
  const tg = findPrimitive("telegram.send");
  if (!tg) throw new Error("telegram.send primitive unavailable");
  staged.setPhase("posting");
  const sent = await tg.handler({ text: postText, chatId });
  staged.completeStep(3);
  staged.setPhase("done");
  if (sent?.ok) claimUrlsToday(picks.map(p => p.url));
  push(sent?.ok ? `Posted weekend digest to Telegram chat ${chatId}.` : `Telegram post failed: ${sent?.error ?? "unknown error"}`);
  return { kind: "weekend-digest", posted: !!sent?.ok, chatId, answer: postText, error: sent?.ok ? undefined : sent?.error };
}

// Thin wrapper so brand-signal scanning (lib/brand-signals.ts) is reachable
// through the normal template/schedule pipeline — schedule.create can point a
// recurring cadence at this the same way it already does for buffer-story-post.
async function brandSignalScanRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: ProgressFn) {
  const brandId = String(inputs.brandId ?? "").trim().slice(0, 80);
  if (!brandId) return { answer: "brandId is required", ok: false };
  const staged = stagedProgress(progress, ["Load brand", "Scan signals", "File drafts"]);
  push(`Scanning brand signals for "${brandId}"…`);
  staged.completeStep(0);
  let run: any;
  try {
    run = await runBrandSignalScan(brandId);
  } catch (e: any) {
    const msg = `Brand scan failed: ${String(e?.message ?? e).slice(0, 200)}`;
    push(`⚠ ${msg}`);
    return { answer: msg, ok: false, error: msg };
  }
  staged.completeStep(1);
  if (run.error) { push(`Scan refused: ${run.error}`); return { answer: run.error, ok: false, run }; }
  const answer = `Scanned ${run.candidateCount} candidate${run.candidateCount === 1 ? "" : "s"} for "${brandId}" — ${run.signalCount} new draft signal${run.signalCount === 1 ? "" : "s"} filed, ${run.refusedCount} refused. Review with GET /api/brand-signals?brandId=${brandId}&status=draft or the Signals panel on the Brands page.`;
  push(answer);
  staged.completeStep(2);
  staged.setPhase("done");
  return { answer, ok: true, run };
}

// Email-to-vault digest — classifies recent inbox mail one message at a
// time (a whole-batch JSON request failed outright against a local model in
// testing, and a parse failure there would silently zero out every
// message's verdict; one request per message means a failure costs just
// that message's verdict) and files the ones judged worth attention as a
// searchable vault note — email.ts's fileAttachmentsToVault only ever files
// ATTACHMENTS, never the message text itself, so a text-only mail (no
// attachment) was previously unfindable no matter what it said.
async function emailToVaultRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const limit = Math.max(1, Math.min(50, Number(inputs.limit ?? 20)));
  const { emails } = await listRecentEmails(limit);
  if (emails.length === 0) {
    push("No recent mail to scan.");
    return { answer: "No recent mail to scan.", filed: 0, skipped: 0, scanned: 0 };
  }
  push(`${emails.length} message${emails.length === 1 ? "" : "s"} to classify.`);

  let filed = 0;
  let skipped = 0;
  let readFailed = 0;
  let unclassified = 0;
  // Phase 1 — classify concurrently (pool of 3): read + LLM verdict per
  // message. Phase 2 below files serially (vault writes must stay ordered).
  // Time budget: 8 min total for the classify phase so a 50-mail run can't
  // hang the schedule slot.
  const classifyOne = async (e: any): Promise<{ e: any; body: string; v: MailVerdict; readError?: string }> => {
    let body = "";
    try {
      const full = await readEmail(e.accountId, e.uid);
      body = full.body;
    } catch (err: any) {
      return { e, body: "", v: {}, readError: `Could not read "${String(e.subject).slice(0, 50)}": ${String(err?.message ?? err).slice(0, 120)}` };
    }
    let v: MailVerdict = {};
    try {
      const raw = await llmGenerate(
        `From: ${e.sender}\nSubject: ${e.subject}\n\n${body.slice(0, 1500)}`,
        `You triage the operator's email. Reply with ONE JSON object and nothing else:\n` +
        `{"who":"<who sent it, plainly>","wants":"<what they want, one sentence>","urgency":"high|normal|low",` +
        `"needsReply":true or false}\n\n` +
        `Rules: use only what the message says — never invent names, numbers, commitments, dates or prices. ` +
        `Automated mail (newsletters, notifications, verification codes, receipts, no-reply senders) is needsReply=false.`,
        { maxTokens: 300, profile: "extraction" },
      );
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) v = JSON.parse(raw.slice(start, end + 1));
    } catch { /* fall through to the heuristic below */ }
    if (!v || typeof v !== "object" || Object.keys(v).length === 0) {
      // Deterministic fallback so an unparseable verdict never silently
      // becomes "no reply needed" for a real person's message.
      const automated = /no[-_]?reply|noreply|notification|newsletter|mailer|do[-_]?not[-_]?reply|billing|receipt/i.test(`${e.sender} ${e.subject}`);
      v = { who: e.sender, wants: e.subject, urgency: "normal", needsReply: !automated, _unclassified: true };
    }
    return { e, body, v };
  };
  const classified: { e: any; body: string; v: MailVerdict; readError?: string }[] = new Array(emails.length);
  const deadline = Date.now() + 8 * 60_000;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, emails.length) }, async () => {
    while (cursor < emails.length && Date.now() < deadline) {
      const i = cursor++;
      try {
        classified[i] = await classifyOne(emails[i]);
      } catch (err: any) {
        classified[i] = { e: emails[i], body: "", v: {}, readError: String(err?.message ?? err).slice(0, 120) };
      }
    }
  });
  await Promise.all(workers);
  // Phase 2 — file serially, in original order.
  for (let i = 0; i < emails.length; i++) {
    const c = classified[i];
    if (!c) { readFailed++; continue; } // hit the time budget
    if (c.readError) { readFailed++; push(`⚠ ${c.readError}`); continue; }
    const { e, body, v } = c;
    if ((v as any)?._unclassified) unclassified++;
    const decision = shouldKeep(v);
    if (!decision.keep) { skipped++; continue; }
    try {
      const note: MailForNote = { from: e.sender, identity: e.accountId, subject: e.subject, date: String(e.date ?? new Date().toISOString()), body };
      const rel = emailNotePath(note.date, note.subject, slugify);
      // Never overwrite: a second message with the same subject on the same
      // day is a different message, and the first one is somebody's evidence.
      const path = existsSync(resolve(config.vaultPath, rel)) ? rel.replace(/\.md$/, `-${String(e.uid)}.md`) : rel;
      writeVaultFile(path, renderEmailNote(note, v, decision.why));
      filed++;
    } catch (err: any) {
      readFailed++;
      push(`⚠ Could not file "${String(e.subject).slice(0, 50)}": ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }

  const summary = `Filed ${filed} of ${emails.length} message${emails.length === 1 ? "" : "s"} to ${EMAIL_NOTES_DIR}/ (${skipped} skipped, ${readFailed} failed${unclassified ? `, ${unclassified} unclassified` : ""}).`;
  push(summary);
  if (filed > 0) {
    try {
      const { enqueueVaultCommit } = await import("../lib/commit-queue.js");
      void enqueueVaultCommit(`chore(email): file ${filed} triaged message(s)`);
    } catch { /* commit queue optional */ }
  }
  return { answer: summary, filed, skipped, readFailed, unclassified, scanned: emails.length };
}

// Daily briefing — a thin wrapper over the general-task agent with a fixed,
// briefing-shaped prompt. Runs against the active persona so a hired EA (Evie)
// gives an EA-flavoured briefing. Doesn't auto-save as a template (it's already
// a built-in) and never re-asks for clarification — it's a scheduled, headless
// run. The optional `focus` input narrows the briefing to one area.
async function dailyBriefingRunner(inputs: Record<string, unknown>, push: (m: string) => void, progress?: (p: Record<string, unknown>) => void) {
  const focus = String(inputs.focus ?? "").trim().slice(0, 300);
  const now = new Date();
  const today = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const from = ymd(new Date(now.getTime() - 5 * 24 * 3600_000));
  const to = ymd(now);

  // The briefing gathers its OWN evidence and hands it to the writer as an
  // inline context block, rather than leaning on the LLM planner. Two prior
  // failures forced this: (1) the "look at _naxion/jobs" phrasing routed
  // the planner to research.deep, whose web sources were generic sign-in
  // pages, so the briefing reported "vault is quiet" no matter what actually
  // ran; (2) the innovation scan, injected as a bespoke "ATTACHED —" block,
  // reached the planner but NOT synthesis (synth trusts evidence runs, not
  // raw task text), so every briefing said "scan could not be accessed". By
  // pulling activity + the scan here and formatting them as the recognised
  // "Attached documents (user uploaded as context…)" block, the runner routes
  // to the direct-synth path, which reads the block as primary evidence.
  const contextParts: string[] = [];
  const staged = stagedProgress(progress, ["Pull activity", "Day shape", "Inbox triage", "Approvals + scan", "Write briefing"]);

  // Steps 1-5 below are independent reads (job store, calendar, inbox,
  // approvals, memory) with no data dependency on each other — they were
  // previously five sequential `await`s, which was most of what pushed
  // daily-briefing's wall-clock past its 600s perf budget (678.3s avg,
  // 2026-10-14 reflection). Running them concurrently via Promise.all costs
  // nothing (each result is pushed/ordered afterward exactly as before) and
  // collapses their cost to the slowest single one instead of the sum.
  const [activityResult, dayShapeResult, inboxResult, approvalsResult, top3Result, scanResult] = await Promise.all([
    (async () => {
      try {
        const prim = findPrimitive("calendar.activity");
        if (!prim) return null;
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
          return { part: `### Activity — ${from} → ${to} (${total} jobs across ${sorted.length} days)\n${perDay.join("\n")}`, msg: `Pulled ${total} jobs across ${sorted.length} days.` };
        }
        return { part: `### Activity — last 5 days (${from} → ${to})\nNo agent jobs ran in this window.`, msg: "No activity in the last 5 days." };
      } catch (e: any) { return { err: `Activity lookup failed: ${String(e?.message ?? e).slice(0, 100)}` }; }
    })(),
    // Today's shape — meetings, Naxie runs, dated commitments, carryover —
    // via calendar.plan_day's single structured call (it already joins iCal +
    // schedules + memory + yesterday's failed/awaiting jobs).
    (async () => {
      try {
        const prim = findPrimitive("calendar.plan_day");
        if (!prim) return null;
        const day: any = await prim.handler({ date: to });
        const { formatDayShape } = await import("../lib/briefing-evidence.js");
        const n = (day?.meetings ?? []).length;
        return { part: formatDayShape(day, to), msg: n ? `${n} meeting(s) on today's calendar.` : "Nothing on today's calendar." };
      } catch (e: any) { return { err: `Day-shape lookup failed: ${String(e?.message ?? e).slice(0, 100)}` }; }
    })(),
    // Inbox triage — pending items only (snoozed/resolved stay out). The
    // brief must never claim "inbox is quiet" without looking here first.
    (async () => {
      try {
        const { listTriage } = await import("../lib/email.js");
        const { formatInboxTriage } = await import("../lib/briefing-evidence.js");
        const store = listTriage() as Record<string, any>;
        const { count, block } = formatInboxTriage(store);
        return { part: block || undefined, count, msg: count ? `${count} email(s) waiting in triage.` : "Inbox triage is clear." };
      } catch (e: any) { return { err: `Inbox lookup failed: ${String(e?.message ?? e).slice(0, 100)}` }; }
    })(),
    // Waiting on you — approval-parked jobs + OrgTasks. Read directly (not
    // via the org.approvals_pending primitive, which is master-employee-gated
    // and would refuse this headless caller).
    (async () => {
      try {
        const awaiting = listJobs().filter((j: any) => j.status === "awaiting-approval").slice(0, 8);
        const { listOrgTasks } = await import("../lib/org-tasks.js");
        const waiting = (listOrgTasks({ status: "waiting-on-approval" } as any) as any[]).slice(0, 8);
        const { formatWaiting } = await import("../lib/briefing-evidence.js");
        const block = formatWaiting(awaiting, waiting);
        return block ? { part: block, msg: `${awaiting.length + waiting.length} item(s) waiting on approval.` } : null;
      } catch (e: any) { return { err: `Approvals lookup failed: ${String(e?.message ?? e).slice(0, 100)}` }; }
    })(),
    // Yesterday's Top 3 — follow-through check. The prior briefing's focus
    // items return as evidence; the synthesiser judges each kept / carried /
    // dropped against the activity above, so unkept promises resurface.
    (async () => {
      try {
        const { previousTop3 } = await import("../lib/briefing-memory.js");
        const prior = previousTop3(to);
        if (!prior.length) return null;
        return {
          part: `### Yesterday's Top 3\n${prior.map((t) => `  - ${t}`).join("\n")}`,
          followup: `\n- Under "## Open loops", FIRST account for each of yesterday's Top 3 (kept / carried / dropped — judge from the activity evidence, never assume). Carried items reappear in today's Top 3 only if still genuinely top-3.`,
        };
      } catch { return null; /* first run (or a failed read) simply has no follow-up */ }
    })(),
    // Latest innovation scan (48h) — the research employee's daily R&D report.
    (async () => {
      try {
        const { latestJobByTemplate } = await import("../lib/job-store.js");
        const scan = latestJobByTemplate("innovation-scan", Date.now() - 48 * 3600_000);
        if (scan?.answer && looksLikeInnovationReport(scan.answer)) {
          return {
            part: `### Innovation scan (job ${scan.id}, by ${scan.persona ?? "research"}, finished ${scan.finishedAt ?? scan.startedAt})\n${scan.answer.slice(0, 6000)}`,
            msg: `Attaching the latest innovation scan (${scan.id.slice(0, 8)}, ${scan.persona ?? "research"}).`,
            scanJobId: scan.id, scanInvalid: false,
          };
        } else if (scan?.answer) {
          // The latest scan exists but its content ISN'T an opportunities report
          // (e.g. a drafted welcome email — live 2026-07-27). Do NOT surface it as
          // "opportunities"; flag it so the brief tells the reader to re-run rather
          // than presenting off-topic content as R&D findings.
          return { msg: `Latest innovation scan (${scan.id.slice(0, 8)}) isn't a valid opportunities report — flagging, not summarising.`, scanJobId: scan.id, scanInvalid: true };
        }
        return { msg: "No innovation scan in the last 48h." };
      } catch { return null; /* briefing must never fail on the attachment */ }
    })(),
  ]);

  if (activityResult?.part) contextParts.push(activityResult.part);
  push(activityResult?.msg ?? activityResult?.err ?? "Activity lookup produced nothing.");
  staged.completeStep(0);

  if (dayShapeResult?.part) contextParts.push(dayShapeResult.part);
  if (dayShapeResult?.msg ?? dayShapeResult?.err) push(dayShapeResult?.msg ?? dayShapeResult!.err!);
  staged.completeStep(1);

  let inboxCount = 0;
  if (inboxResult?.err) push(inboxResult.err);
  else if (inboxResult) {
    inboxCount = inboxResult.count ?? 0;
    if (inboxResult.part) contextParts.push(inboxResult.part);
    if (inboxResult.msg) push(inboxResult.msg);
  }
  staged.completeStep(2);

  if (approvalsResult?.err) push(approvalsResult.err);
  else if (approvalsResult?.part) {
    contextParts.push(approvalsResult.part);
    push(approvalsResult.msg ?? "");
  }

  let followupInstruction = "";
  if (top3Result) {
    contextParts.push(top3Result.part);
    followupInstruction = top3Result.followup;
  }

  let scanJobId = "";
  let scanInvalid = false;
  if (scanResult) {
    if (scanResult.part) contextParts.push(scanResult.part);
    if (scanResult.msg) push(scanResult.msg);
    scanJobId = scanResult.scanJobId ?? "";
    scanInvalid = scanResult.scanInvalid ?? false;
  }
  staged.completeStep(3);

  const attachmentBlock = contextParts.length
    ? `\n\nAttached documents (user uploaded as context — treat as the primary evidence, do NOT web-search):\n\n${contextParts.join("\n\n")}`
    : "";

  const innovationInstruction = scanInvalid
    ? `\n- "## Innovation scout" — ONE line only: the latest innovation scan (job ${scanJobId}) did not produce a valid opportunities report and should be re-run. Do NOT invent opportunities.`
    : scanJobId
    ? `\n- "## Innovation scout" — 3-5 lines summarising the Top 3 opportunities from the attached innovation scan; cite job ${scanJobId} once so the reader can open the full report.`
    : "";

  // Inbox section exists only when triage is non-empty — an empty inbox gets
  // no section at all (no-filler rule), never a "nothing to report" line.
  const inboxInstruction = inboxCount > 0
    ? `\n- "## Inbox — needs you" — one line per waiting email (sender/subject + what they're asking); only mail with an implicit ask, never newsletters.`
    : "";

  // Section names are given as exact headings to REPRODUCE; the guidance sits
  // on the instruction lines so the model doesn't echo it into the heading
  // text (an earlier version put guidance after an em-dash IN the heading and
  // the synth printed "## Focus today — the 3-5 things that matter…" verbatim).
  const task =
    `Produce my briefing for ${today}.${focus ? ` Focus area: ${focus}.` : ""}\n\n` +
    `Using ONLY the attached context below (activity, today's shape, inbox, approvals + the latest innovation scan), write a short, scannable briefing. Use these EXACT section headings, nothing after them:\n` +
    `- "## Focus today" — open with one line on the day's shape (meetings load, first/last commitment, focus blocks or "none"), then the 3-5 things that matter most, each one line with WHY it matters.\n` +
    `- "## Open loops" — anything waiting on me or flagged for follow-up (approvals, carryover, dated commitments).` +
    followupInstruction +
    `- "## Worth knowing" — short notes on recent changes or context.` +
    inboxInstruction +
    innovationInstruction + `\n\n` +
    `Keep it tight — 150-300 words, a morning glance, not a report. If a window is empty, say so plainly in one line rather than padding or inventing items. Output ONLY the finished briefing (the headings above and their bullets) — never your reasoning, the guidance, or these instructions.` +
    attachmentBlock;
  // `_personaId` passes through so a scheduled briefing can pin the right
  // employee instead of inheriting whoever happens to be the org-wide active
  // hire that morning (a Procurement Officer gave one run a
  // procurement-slanted briefing during live verification; an HR Manager
  // lane-refused an entire briefing on 2026-07-19 — both roles were pruned
  // 2026-09-21). When the schedule pins nobody, default to Naxie — calendar +
  // inbox triage / morning briefings are explicitly her lane (personas.ts),
  // and inheriting a random specialist produces refusals.
  const personaId = (typeof inputs._personaId === "string" && inputs._personaId.trim()) || "naxie";
  staged.setPhase("synthesizing");
  // Skip peer.review (30-90s+) for this template: it's a fixed-format
  // internal digest, not user-facing prose that needs a second opinion, and
  // it was the single slowest step pushing daily-briefing over its perf
  // budget (678.3s avg vs. 600s, 2026-10-14 reflection).
  const brief = await generalTaskRunner({ task, save_as_template: false, _personaId: personaId, _skipPeerReview: true }, push, progress);
  // Remember today's Top 3 for tomorrow's follow-through check. Best-effort:
  // memory must never fail a briefing that already succeeded.
  try {
    const { recordBriefing } = await import("../lib/briefing-memory.js");
    const ans = (brief as any)?.answer;
    if (typeof ans === "string" && ans.trim()) recordBriefing(to, ans);
  } catch { /* ignore */ }
  return brief;
}

async function syncDownloadsRunner(inputs: Record<string, unknown>, push: (m: string) => void) {
  const source = String((inputs as any).source ?? "").trim();
  if (source) {
    try {
      const { existsSync: _ex2, statSync: _st2 } = await import("node:fs");
      if (!_ex2(source)) throw new Error(`source folder not found: ${source.slice(0, 160)}`);
      if (!_st2(source).isDirectory()) throw new Error(`source is not a folder: ${source.slice(0, 160)}`);
    } catch (e: any) {
      if (/source (folder not found|is not a folder)/.test(String(e?.message ?? ""))) throw e;
    }
  }
  push("running download sync (read-only on sources)");
  let r: any;
  try {
    r = syncDownloads({ source }, push);
  } catch (e: any) {
    const msg = `Download sync failed: ${String(e?.message ?? e).slice(0, 200)}`;
    push(`⚠ ${msg}`);
    return { error: msg, answer: msg, copiedThisRun: [], copyErrors: [] };
  }
  const copied = (r as any)?.copiedThisRun?.length ?? 0;
  if (!copied) {
    const answer = `Downloads in sync — 0 new files.`;
    push(answer);
    return { ...r, answer, commit: { ok: true, skipped: true } as any };
  }
  push("committing inventory + state to vault");
  try {
    const commit = await commitAndPush(`naxie: downloads sync (${copied} new)`);
    return { ...r, commit, answer: `Synced ${copied} new file(s) from Downloads.` };
  } catch (e: any) {
    push(`commit failed (files kept): ${String(e?.message ?? e).slice(0, 120)}`);
    return { ...r, commitOk: false, error: String(e?.message ?? e).slice(0, 200), answer: `Synced ${copied} file(s) (commit failed)` };
  }
}

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

