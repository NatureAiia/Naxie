import { Router } from "express";
import { buildNaxieContext, naxieMemoryStats } from "../lib/naxie-context.js";
import { getOperatorIdentity } from "../lib/mag.js";
import { cagStats } from "../lib/cag.js";
import { isCloudReachable, isCloudReachableCached } from "../lib/connectivity.js";
import { voiceStatus } from "../lib/voice.js";
import { listSubjects } from "../lib/memory.js";
import { getSubagentRoster } from "../lib/mag.js";
import { callerLayer } from "../lib/access.js";
import { runArchitectReview } from "../lib/architect.js";

export const naxieRouter = Router();

// GET /api/naxie/context — inspector for second-in-command memory
// Returns CAG hash, MAG facts, RAG sample, operator, roster, voice, connectivity
naxieRouter.get("/context", async (req, res) => {
  const q = String(req.query.q ?? "operator and naxie second in command").slice(0, 200);
  try {
    const ctx = await buildNaxieContext(q, { ragLimit: 5, sessionId: "inspector" });
    const op = getOperatorIdentity();
    const cag = cagStats();
    const roster = getSubagentRoster();
    const memSubjects = listSubjects().slice(0, 10);
    const vs = await voiceStatus();
    const cached = isCloudReachableCached();
    res.json({
      operator: op,
      cag: { hash: cag.hash, cached: cag.built ? true : false, ageMs: cag.ageMs, prefixChars: ctx.cag.length },
      magChars: ctx.mag.length,
      rag: ctx.rag ? ctx.rag.slice(0, 1200) : "(no hits for query)",
      ragRaw: ctx.rag,
      roster: { count: roster.length, workers: roster.slice(0, 20) },
      memorySubjects: memSubjects,
      connectivity: { cached, probeNeeded: cached === null },
      voice: { realtime: vs.realtime, openaiTts: vs.openaiTts, localTts: vs.localTts },
      query: q,
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// GET /api/naxie/status — lightweight daemon nudge probe
// Widget polls this (10s) to show pendingNudge without reading org-tasks
naxieRouter.get("/status", async (_req, res) => {
  try {
    const { listOrgTasks } = await import("../lib/org-tasks.js");
    const { getLatestBriefing, DAEMON_CYCLE_SECONDS } = await import("../lib/org-daemon.js");
    const { getOnboardingState } = await import("../lib/sector-packs.js");
    const waiting = listOrgTasks({ status: "waiting-on-approval" } as any).slice(0, 5);
    const vs = await voiceStatus();
    const cached = isCloudReachableCached();
    res.json({
      pendingApprovals: waiting.length,
      waiting,
      voice: { realtime: vs.realtime, openaiTts: vs.openaiTts, localTts: vs.localTts },
      connectivity: { cached, online: cached ?? (await isCloudReachableCached()) },
      cag: cagStats(),
      briefing: getLatestBriefing(),
      onboardingNeeded: false,
      daemonStatus: { cycleSeconds: DAEMON_CYCLE_SECONDS },
    });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/naxie/remember — teach Naxie a fact (so she never forgets who you are)
// Body: { subject?: string, fact: string, date?: YYYY-MM-DD }
naxieRouter.post("/remember", async (req, res) => {
  const fact = String(req.body?.fact ?? "").trim();
  if (!fact) return res.status(400).json({ error: "fact required" });
  const subject = String(req.body?.subject ?? "operator").trim() || "operator";
  const date = req.body?.date ? String(req.body.date).trim() : undefined;
  try {
    const { noteFact } = await import("../lib/memory.js");
    const { invalidateCagCache } = await import("../lib/cag.js");
    const saved = noteFact({ subject, fact, date, source: "naxie-api" });
    invalidateCagCache();
    res.json({ ok: true, saved });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/naxie/ask — second-in-command delegation endpoint.
// Side effect: touches naxie-interactions.json (same idle clock as /voice/converse).
// Nature (or an external system) gives Naxie a task; she classifies it,
// routes to the right org role queue (scheduler/researcher/executor/admin),
// and returns the OrgTask. Complex work lands on a role backlog instead of
// being lost in chat; simple asks still go through /api/voice/converse.
naxieRouter.post("/ask", async (req, res) => {
  const text = String(req.body?.text ?? "").trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: "text required" });
  try { const { touchInteraction } = await import("../lib/naxie-interactions.js"); touchInteraction(); } catch { /* ignore */ }
  try {
    const { classifyOrgRole, createOrgTask, ORG_TASK_PRIORITIES } = await import("../lib/org-tasks.js");
    const priority = ORG_TASK_PRIORITIES.includes(String(req.body?.priority) as any) ? String(req.body.priority) as any : "normal";
    // classifyOrgRole is a Job-shape classifier — wrap the raw ask into that shape.
    const role = classifyOrgRole({ kind: "chat:naxie-delegate", title: text.slice(0, 80), task: text }) ?? "executor";
    const task = createOrgTask({
      role,
      title: text.slice(0, 100),
      detail: text,
      priority,
      createdBy: "user",
    });
    res.json({ ok: true, role, task });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/naxie/architect/review — manually trigger the Architect role's
// self-review pass (docs §7). Admin-gated the same way host-tools.ts gates
// its settings PATCH: a logged-in human below "admin" is rejected; a
// token-less machine/operator caller passes (see access.ts's scope note).
// This is a system-triggered-only surface — Architect is never reachable
// through chat classification (org-tasks.ts's classifyOrgRole/
// matchRoleFromText deliberately never return "architect").
naxieRouter.post("/architect/review", async (req, res) => {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    return res.status(403).json({ error: "Triggering an Architect review requires admin access." });
  }
  try {
    const result = await runArchitectReview();
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Interests — GET/PUT /api/naxie/interests (research topics for proactive research)
naxieRouter.get("/interests", async (_req, res) => {
  try {
    const { readInterests, resolveResearchTopics } = await import("../lib/research-interests.js");
    const interests = readInterests();
    const resolved = resolveResearchTopics({ explicitInterests: interests });
    res.json({ interests, resolved });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});
naxieRouter.put("/interests", async (req, res) => {
  const raw = req.body?.interests;
  const topics: string[] = Array.isArray(raw) ? raw.map((s: any) => String(s).trim()).filter(Boolean) : [];
  if (typeof req.body?.text === "string") {
    // Also accept { text: "line1\nline2" } for simple textarea POSTs.
    const extra = String(req.body.text).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const t of extra) if (!topics.includes(t)) topics.push(t);
  }
  try {
    const { writeInterests, resolveResearchTopics } = await import("../lib/research-interests.js");
    writeInterests(topics);
    const resolved = resolveResearchTopics({ explicitInterests: topics });
    res.json({ ok: true, interests: topics, resolved });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

// GET /api/naxie/tasks?role=&status= — read the role backlogs (diagnostics)
naxieRouter.get("/tasks", async (req, res) => {
  try {
    const { listOrgTasks } = await import("../lib/org-tasks.js");
    const role = req.query.role ? String(req.query.role) : undefined;
    const status = req.query.status ? String(req.query.status) : undefined;
    res.json({ tasks: listOrgTasks({ role, status } as any).slice(0, 100) });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
