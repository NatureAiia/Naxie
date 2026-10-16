import { Router } from "express";
import { ollamaGenerate } from "../lib/ollama.js";
import { templates } from "../lib/templates.js";
import { newJob, runJob, getJobAbortSignal } from "../lib/jobs.js";
import { callerOf, callerLayer } from "../lib/access.js";
import { isLocalMachineTask } from "../lib/task-restrictions.js";
import { config } from "../config.js";
import { searchVault } from "../lib/vault.js";
import { getActivePersona, personaSystemSuffix, PA_IDENTITY } from "../lib/personas.js";
import { autoRoutePersona } from "../lib/persona-router.js";
import { checkLaneFit, buildOutOfLaneRefusal, resolveHireToPersona } from "../lib/lane.js";
import { localInflightCount, pickLightestIdlePeer, pickPeerByRole, pickExecutor, delegateToPeer, pollPeers, crosscheckAnswers, type PeerInfo, type RoutingDecision } from "../lib/peers.js";
import { curatePeerOutput } from "../lib/curation.js";
import { ensureWorker, ensureExtraWorker } from "../lib/worker-manager.js";
import { isHermesPrimary, isHermesCodeTask, getHermesModelOverride, isCrosscheckEnabled } from "../lib/executor-mode.js";
import { detectsShonaOrNdebele, shonaLanguageDirective, getShonaNdebeleMatches } from "../lib/shona-glossary.js";
import { recordChatExchange, listChatHistory } from "../lib/chat-history.js";
import { noteFact, recallSubject } from "../lib/memory.js";
import { parseRememberCommand } from "../lib/remember-command.js";
import { loadJobById } from "../lib/job-store.js";
import { SENSITIVE_APPROVAL_TOOLS, planSensitiveTools } from "../lib/agent.js";

// Below this answer length (chars), a Hermes result is treated as "couldn't do
// it" and offloaded to naxie-agent. Catches empty / no-final-response / stub replies.
const HERMES_MIN_ANSWER = Number(process.env.NAXION_HERMES_MIN_ANSWER ?? "40");
// Master switch for the Hermes→naxie-agent offload (default on).
const HERMES_FALLBACK = process.env.NAXION_HERMES_FALLBACK !== "0";
// Quality gate — also offload a present-but-WEAK Hermes answer (one that runs
// naxie-agent's quality.check and doesn't pass), not just hard failures. Default on;
// time-bounded + fail-safe (a scorer error/timeout keeps the Hermes answer).
const HERMES_QUALITY_GATE = process.env.NAXION_HERMES_QUALITY_GATE !== "0";
const HERMES_QUALITY_TIMEOUT_MS = Number(process.env.NAXION_HERMES_QUALITY_TIMEOUT_MS ?? "45000");

// Run naxie-agent's quality.check on a Hermes answer. Returns { pass, score } or
// null when the gate can't run (no primitive / scorer error / timeout) — in
// which case the caller KEEPS the Hermes answer rather than offloading blind.
async function scoreHermesAnswer(task: string, answer: string, personaContext?: string): Promise<{ pass: boolean; score: number } | null> {
  try {
    const { findPrimitive } = await import("../lib/primitives.js");
    const { taskWantsResearch } = await import("../lib/deliverable.js");
    const prim = findPrimitive("quality.check");
    if (!prim) return null;
    // Hermes answers from its own knowledge (no retrieval), so unless the task
    // explicitly asks for grounding (sources / current / company data), grade
    // it as an ungrounded conversational answer — otherwise the research rubric
    // inflates factuality_risk on every uncited claim and a correct answer
    // fails the gate. If the task DOES want grounding, keep the strict rubric:
    // Hermes can't ground it, so failing → offload to naxie-agent is the right call.
    const grounded = taskWantsResearch(task);
    const res: any = await Promise.race([
      prim.handler({ task, answer, grounded, ...(personaContext ? { context: personaContext } : {}) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("quality-gate timeout")), HERMES_QUALITY_TIMEOUT_MS)),
    ]);
    if (!res || typeof res !== "object") return null;
    return { pass: res.pass !== false, score: typeof res.score === "number" ? res.score : NaN };
  } catch {
    return null; // scorer failed/timed out — don't penalize Hermes on our own gate's failure
  }
}

// In-flight delegations not yet reflected in the peers' polled inflight counts.
// A burst of concurrent chat requests all read the SAME cached poll (every
// worker at 0), so without this they'd all pick the first worker and pile up —
// the load test showed 4 concurrent tasks all landing on one agent. Counting
// our own pending delegations per worker URL spreads the burst across the pool.
const pendingByPeer = new Map<string, number>();
function bumpPending(url: string, d: number) {
  pendingByPeer.set(url, Math.max(0, (pendingByPeer.get(url) ?? 0) + d));
}
// Lightest persona-shifter worker by EFFECTIVE load (polled inflight + our
// not-yet-visible pending delegations). Returns null when no worker is reachable.
async function pickLeastLoadedWorker(): Promise<PeerInfo | null> {
  const all = await pollPeers();
  const workers = all.filter(p => p.ok && p.ready && (p.role ?? "").toLowerCase() === "persona-shifter");
  if (workers.length === 0) return null;
  const load = (p: PeerInfo) => (p.inflightJobs ?? 0) + (pendingByPeer.get(p.url) ?? 0);
  workers.sort((a, b) => load(a) - load(b));
  return workers[0];
}

// Local naxie-agent is "overloaded" when at least this many general-task jobs are
// already running. Configurable via env so single-naxie-agent users can crank it up
// to never delegate. Default 2 — when you've already queued one task and start
// another, delegation kicks in if a peer is idle.
const OVERLOAD_THRESHOLD = Number(process.env.NAXION_OVERLOAD_THRESHOLD ?? "2");

// When true (default), the primary naxie-agent delegates ALL ad-hoc general tasks
// to the persona-shifter peer when one is reachable, then curates the result —
// scoring quality, scanning for secrets, and capturing context-rooted answers
// to the vault. The primary becomes the editor; the persona-shifter is the
// worker. Set NAXION_DELEGATE_ALL=0 to fall back to the old "only delegate
// when overloaded or persona-shifted" routing.
const DELEGATE_ALL = process.env.NAXION_DELEGATE_ALL !== "0";

export const chatRouter = Router();

// Tasks that will likely plan a sensitive side-effecting tool (email.send,
// db.query, connector.call) must run on the PRIMARY, never a delegated worker.
// planAndExecute's approval checkpoint parks such a plan in awaiting-approval,
// and only THIS process's Approvals page can resume it (a parked worker job
// would leave the primary polling something it can't approve). This is a
// ROUTING hint only — the real enforcement is the tool-level checkpoint in
// planAndExecute, so a miss here still can't run the action unapproved; it just
// means the worker would park and the poll would stall, which we avoid.
const SENSITIVE_TASK_RE = /\b(?:send|shoot|broadcast|blast|fire\s+off|draft\s+and\s+send)\b[^.\n]{0,40}\be[- ]?mails?\b|\be[- ]?mail\s+(?:it|this|that|them|me|all|everyone|every|each|the\s+team|the\s+staff|all\s+users)\b|\bwelcome\s+e[- ]?mail\b|e[- ]?mail\s+[a-zA-Z0-9._%+-]+@|\b(?:query|run\s+a?\s*sql|look\s+up|pull|fetch|read|check)\b[^.\n]{0,40}\b(?:database|db|sql|data\s+source|table)\b|\bconnector\b|\bcall\s+(?:the\s+)?[\w-]+\s+(?:api|connector|endpoint)\b/i;

type ChatMessage = { role: "user" | "assistant" | "system"; content: string; jobId?: string; templateId?: string };

// Regex-based action routing. More forgiving than substring matching — handles
// articles ("add a note"), question-style ("can you summarize…"), and synonyms.
const ACTION_PATTERNS: { re: RegExp; templateId: string }[] = [
  { re: /\b(?:sync|mirror|copy|pull)\s+(?:my\s+)?downloads?\b/i, templateId: "sync-downloads" },
  { re: /\b(?:add|save|capture|create|drop|jot(?:\s+down)?|note)\s+(?:a\s+|an\s+|the\s+|new\s+)?note\b/i, templateId: "add-note" },
  { re: /^\s*note\s+that\b/i, templateId: "add-note" },
  { re: /\b(?:run|trigger|kick\s+off|start|do)\s+(?:the\s+)?(?:daily\s+)?digest\b/i, templateId: "run-digest" },
  { re: /\bdigest(?:\s+(?:scan|run))?\s+(?:my\s+)?(?:repos?|projects?|github)/i, templateId: "run-digest" },
  // Only route to summarize-repo when the user clearly names a *repo* (slash form,
  // or words like "repo"/"repository"/"github"). Bare "summarize X" or
  // "summary on X" falls through to general-task, which has a vault-first plan.
  { re: /\b(?:summari[sz]e|summary\s+of|recap|tldr|brief\s+me\s+on)\s+(?:the\s+)?[\w-]+\/[\w.-]+/i, templateId: "summarize-repo" },
  { re: /\b(?:summari[sz]e|summary\s+of|recap|brief\s+me\s+on)\s+(?:the\s+)?[\w.-]+\s+(?:repo(?:sitory)?|project)\b/i, templateId: "summarize-repo" },
  { re: /\b(?:summari[sz]e|summary\s+of|recap)\s+(?:the\s+)?(?:[\w.-]+\s+)?(?:repo(?:sitory)?|project)\s+[\w./-]+/i, templateId: "summarize-repo" },
  { re: /\b(?:publish|push|upload|create\s+(?:a\s+)?repo\s+from)\s+(?:the\s+)?folder\b/i, templateId: "publish-folder" },
  { re: /\b(?:publish|upload)\s+["'`]?[a-zA-Z]:[\\/]/i, templateId: "publish-folder" },
  { re: /\b(?:search|find|look\s*up|look\s+for|hunt|grep)\s+(?:my\s+|the\s+)?(?:notes?|vault|brain|knowledge|second\s+brain)\b/i, templateId: "search-brain" },
  { re: /\b(?:what\s+do\s+I\s+know\s+about|do\s+I\s+have\s+(?:any\s+)?notes?\s+(?:about|on))\b/i, templateId: "search-brain" },
  { re: /\b(?:browse|open|show)\s+(?:my\s+)?vault\b/i, templateId: "browse-vault" },
];

chatRouter.post("/", async (req, res) => {
  // Per-user history capture. Resolve the human caller; for single-operator
  // local use (no sign-in) fall back to "local" so the prompt history still
  // works without a session token. Token-less machine callers are rare on
  // /api/chat itself, and recording them as "local" is harmless — the UI
  // benefits from no-auth history.
  const human = callerOf(req);
  const historyUserId = human?.id ?? "local";
  const originalJson = res.json.bind(res);
  (res as any).json = (body: any) => {
    try {
      const isError = body?.kind === "error" || (typeof res.statusCode === "number" && res.statusCode >= 400);
      if (!isError && body && typeof body === "object" && typeof body.text === "string") {
        const msgs = (req.body?.messages ?? []) as { role: string; content: string }[];
        const lastUser = [...msgs].reverse().find(m => m?.role === "user")?.content?.trim();
        if (lastUser) {
          recordChatExchange(historyUserId, {
            prompt: lastUser,
            response: body.text,
            kind: typeof body.kind === "string" ? body.kind : undefined,
            jobId: typeof body.jobId === "string" ? body.jobId : undefined,
            persona: typeof body.activePersona?.name === "string" ? body.activePersona.name : undefined,
            sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined,
          });
          void (async () => {
            try { const { maybeUpdateConversationSummary } = await import("../lib/chat-history.js"); await maybeUpdateConversationSummary(historyUserId); } catch {}
          })();
        }
      }
    } catch { /* history must never break the chat response */ }
    return originalJson(body);
  };
  try {
    await handleChat(req, res);
  } catch (e: any) {
    // Catch-all so a thrown error in the routing layer never becomes Express's
    // generic 500. We surface the error as JSON the chat UI can render, and
    // include a short reason so the user knows where to look.
    const message = e?.message ?? String(e);
    console.error("[chat] handler error:", message, e?.stack ?? "");
    if (!res.headersSent) {
      return res.status(500).json({
        kind: "error",
        error: message,
        text: `Sorry — something went wrong before I could start the task. ${message.slice(0, 200)}`,
      });
    }
  }
});

async function handleChat(req: any, res: any) {
  const human = callerOf(req);
  const historyUserId = human?.id ?? "local";
  const messages = (req.body?.messages ?? []) as ChatMessage[];
  if (messages.length === 0) return res.status(400).json({ error: "messages required" });
  const last = messages[messages.length - 1];
  if (last.role !== "user" || !last.content?.trim()) return res.status(400).json({ error: "last message must be a non-empty user turn" });
  const text = last.content.trim();
  // Naxie interaction clock — any user turn counts for the idle nudge.
  try { const { touchInteraction } = await import("../lib/naxie-interactions.js"); touchInteraction(); } catch { /* best-effort */ }

  // Local-machine gate (HARD default, not an opt-in restriction). The fs.* /
  // system.notepad / terminal primitives read and act on the SERVER OPERATOR's
  // own PC — not the requesting user's. In a multi-user install a staff/member
  // could otherwise ask "what's in my notepad" or "read C:\Users\...\.env" and
  // exfiltrate the OPERATOR's local files/secrets. So local-machine access is
  // superadmin-only; token-less machine/loopback callers (the operator's own
  // automation) still pass. This runs BEFORE the opt-in restriction gate below.
  {
    const layer = callerLayer(req); // null = machine/loopback (operator) — allowed
    if (layer !== null && layer !== "superadmin" && isLocalMachineTask(text)) {
      return res.status(403).json({
        error: "That reads the operator's local machine (files, Notepad, or terminal), which only a super-admin can do — it isn't your device. Ask the operator, or work with your vault/knowledge instead.",
        restrictedCapability: "local-machine",
      });
    }
  }

  // Company-structure gate: a restricted human can't ask the workforce to do a
  // capability their role/department/user scope denies (payments, email, db…).
  // Machine callers and superadmins pass.
  {
    const { checkTaskAllowed } = await import("../lib/task-restrictions.js");
    const check = checkTaskAllowed(callerOf(req), text);
    if (!check.allowed) {
      return res.status(403).json({
        error: `Your role can't run ${check.capability} tasks${check.note ? ` — ${check.note}` : ""}. Ask an admin or someone in the right department to handle this.`,
        restrictedCapability: check.capability,
      });
    }
  }

  // 2.S EXPLICIT MEMORY FAST-PATH. Check for "remember this: <fact>" commands.
  // These are processed as a high-priority a-priori action before routing,
  // allowing the operator to store durable facts without involving the
  // full planning/execution cycle.
  if (process.env.NAXION_EXPLICIT_REMEMBER !== "0") {
    const fact = parseRememberCommand(text);
    if (fact) {
      try {
        const existing = recallSubject("operator", 100).map(f => f.fact.toLowerCase());
        if (existing.includes(fact.toLowerCase())) {
          recordChatExchange(historyUserId, {
            prompt: text,
            response: `I already remember that: "${fact}"`,
            kind: "message",
          });
          return res.json({
            kind: "message",
            text: `I already remember that: "${fact}"`,
          });
        }
        noteFact({ subject: "operator", fact, source: "explicit-remember" });
        recordChatExchange(historyUserId, {
          prompt: text,
          response: `Remembered: "${fact}"`,
          kind: "message",
        });
        return res.json({
          kind: "message",
          text: `Remembered: "${fact}"`,
        });
      } catch (e: any) {
        console.warn(`[chat] explicit-remember failed: ${e?.message ?? e}`);
      }
    }
  }

  // Continuation support. When naxie-agent previously responded with
  // needsContext: true, the client preserves the original task text +
  // optional original job id and sends them back with the next message.
  // We don't stitch into `text` (early routing layers still see the bare
  // reply) — instead we set `continuationContext` which the general-task
  // path picks up when building the enriched task for the planner. The
  // clarification gates are short-circuited when a continuation is in
  // play because the user has, by definition, already responded to one.
  const continuation = (req.body?.continuesTaskRef && typeof req.body.continuesTaskRef === "object")
    ? {
        originalText: String(req.body.continuesTaskRef.originalText ?? "").trim(),
        originalJobId: typeof req.body.continuesTaskRef.originalJobId === "string" ? req.body.continuesTaskRef.originalJobId : undefined,
        summary: typeof req.body.continuesTaskRef.summary === "string" ? req.body.continuesTaskRef.summary : undefined,
      }
    : null;
  const isContinuation = !!(continuation && continuation.originalText);

  // Pre-compute the conversation slice the planner will see. We default to
  // INCLUDING recent context (last 2 user turns + last assistant turn) unless
  // the current message clearly opens a new topic (greeting, "new task:",
  // explicit reset). The previous heuristic — "include history only on
  // pronouns" — missed most real follow-ups, which often continue a topic
  // implicitly without saying "it" or "that". Conversational AI should
  // assume continuity; that's how humans converse.
  const recentUserTurns = messages
    .slice(0, -1)
    .filter(m => m.role === "user")
    .slice(-2)
    .map(m => m.content.trim())
    .filter(Boolean);
  // Last assistant response so "rewrite the second paragraph" or "make it
  // shorter" can resolve to actual content. Capped to keep prompt cost in
  // check; the LLM doesn't need every word, just the gist.
  const lastAssistantTurn = [...messages].reverse().find(m => m.role === "assistant")?.content?.trim() ?? "";

  // Markers that explicitly open a NEW topic. When we see one of these we
  // skip the history — the customer is consciously resetting. Order matters
  // a little: check greetings first since they should never inherit thread.
  const GREETINGS = /^\s*(?:hi|hey|hello|yo|sup|good\s+(?:morning|afternoon|evening)|gm|gn)\b[\s!,.?]*$/i;
  const NEW_TOPIC_PREFIX = /^\s*(?:new\s+(?:task|question|topic|thing)|switch:|switching:|switching\s+gears|different\s+(?:thing|topic|question)|on\s+a\s+different\s+note|completely\s+different|let'?s\s+talk\s+about\s+something\s+(?:else|different)|forget\s+(?:that|what\s+i\s+said|the\s+previous))\b/i;
  const isExplicitReset = GREETINGS.test(text) || NEW_TOPIC_PREFIX.test(text);
  const hasThread = recentUserTurns.length > 0;
  // Continuity is the default when there's a thread AND no explicit reset.
  const useThreadContext = hasThread && !isExplicitReset;

  // 1. Try regex-based action routing — fastest, deterministic.
  // BUT: when there's an active thread, regex routing is risky — a word
  // like "digest" or "search" can hijack a continuation message into a
  // one-shot template. Only run regex routing on FIRST turns (no thread
  // yet) or on explicit resets ("new task: run a digest").
  //
  // Multi-clause guard: queries like "search my vault for X and write a
  // roll-up to 0-Inbox" need the multi-step planner, NOT a single-step
  // template. We detect WRITE-action tails — "and write/save/capture/
  // create/add/append/draft/file/store" — and let those fall through to
  // general-task. Pure read-and-report tails ("and tell me what they
  // say") stay with the template because search-brain already returns
  // numbered matches with previews, which IS the user's report.
  const hasWriteActionTail =
    /\s+(?:and|then)\s+(?:write|save|capture|create|add|append|draft|file|store|put|drop|push|sync|commit|publish)\b/i.test(text);
  let templateId: string | null = null;
  if (!useThreadContext && !hasWriteActionTail) {
    for (const p of ACTION_PATTERNS) {
      if (p.re.test(text)) { templateId = p.templateId; break; }
    }
  }

  // 2. If keyword routing matched and inputs can be inferred, run the task
  if (templateId) {
    const tpl = templates.find(t => t.id === templateId);
    if (tpl) {
      const inputs = inferInputs(tpl.id, text);
      // Treat a present-but-empty/whitespace required input as MISSING (was:
      // key-presence only) so a blank value re-prompts instead of dispatching.
      const missing = tpl.inputs.filter(i => {
        if (!i.required) return false;
        if (!(i.name in inputs)) return true;
        const v = (inputs as any)[i.name];
        return typeof v === "string" ? v.trim() === "" : v == null;
      });
      if (missing.length === 0) {
        const job = newJob(`${tpl.role.toLowerCase()}:${tpl.id}`);
        job.template = tpl.id;
        job.title = tpl.title;
        job.inputs = inputs;
        job.createdByEmail = callerOf(req)?.email;
        job.requiresApproval = tpl.requiresApproval;
        if (tpl.requiresApproval) {
          job.status = "awaiting-approval";
          job.log.push(`[${new Date().toISOString()}] task created from chat · waiting on human approval`);
          return res.json({
            kind: "task",
            jobId: job.id,
            templateId: tpl.id,
            requiresApproval: true,
            text: `I've queued a **${tpl.title}** task — it needs your approval before running. Open the Approvals page.`,
          });
        }
        // Fire and reply with handle
        void runJob(job, async (push) => runTemplateInline(tpl.id, inputs, push));
        return res.json({
          kind: "task",
          jobId: job.id,
          templateId: tpl.id,
          requiresApproval: false,
          text: `On it — running **${tpl.title}**${friendlyInputs(tpl.id, inputs)}. I'll surface the result on the Tasks page when it's done.`,
        });
      }
      // Missing required inputs — ask back conversationally.
      // Tag with needsContext so the UI surfaces a "Continue this task"
      // button; the user's reply gets stitched into the original task and
      // re-dispatched as a continuation.
      const ask = missing.map(m => `**${m.label}**`).join(", ");
      return res.json({
        kind: "message",
        text: `I can run **${tpl.title}**, but I need: ${ask}. Reply with the value(s), or use the Templates page to fill the form.`,
        needsContext: true,
        clarification: {
          originalText: text,
          templateId: tpl.id,
          missing: missing.map(m => ({ name: m.name, label: m.label })),
          summary: `${tpl.title} — missing ${missing.map(m => m.label).join(", ")}`,
        },
      });
    }
  }

  // 2.5. INTENT EXTRACTION + CLARIFICATION GATE. Classify the user's request
  //      into a concrete intent (draft-email, summarize, review, code, plan,
  //      etc.) and pull out the slots that intent needs (recipient, target,
  //      topic). Two outputs:
  //        a) When a required slot is missing AND there's no thread to fall
  //           back on, send a TAILORED follow-up question right now — not a
  //           generic "be more specific", but the exact slot we need filled
  //           ("who's the email for?", "what should I summarize?").
  //        b) A deliverable-format hint that gets appended to the enriched
  //           task so the synth produces output in the right shape (email
  //           headers for emails, memo structure for memos, code blocks for
  //           code, etc.) — the same task without the hint would default to
  //           generic "one-page report" prose.
  //      Combined with the existing detectAmbiguity for residual shape
  //      catches (bare pronouns, bare confirmations).
  const intentDetection = extractIntent(text, useThreadContext);
  // Detect whether the request carries attached documents. The clarification
  // gates below ask for a "target" slot when the verb is summarize/review/
  // extract/etc. — but if the user uploaded a doc and said "summarize this",
  // the target IS the attachment. Without this check the gate fires asking
  // "what should I summarize?" while the upload sits unused, and (worse)
  // when the user retries with the doc named, the planner falls back to
  // vault.search because no attachment was ever folded into the task.
  const hasAttachments = Array.isArray(req.body?.attachments) && req.body.attachments.some((a: any) => a?.contextId);
  // Some intents are "transform inline content" by nature — summarize,
  // review, extract, edit, translate. When an attachment is present these
  // are already fully specified; skip the target-slot follow-up.
  const transformIntents = new Set(["summarize", "review", "edit", "extract", "translate", "explain"]);
  const skipTargetGate = hasAttachments && (
    transformIntents.has(intentDetection.intent ?? "") ||
    !intentDetection.intent ||
    (intentDetection as any).followUpKind === "slot"
  );
  // Self-contained message guard. A request that PASTES its own content
  // (a ``` code fence, a quoted block, a colon-introduced block) or is long
  // and detailed already carries everything we'd ask for — bouncing it to a
  // "what should I work on?" clarification is the wrong move and infuriating.
  // The slot extractors can still miss (e.g. a recipient mid-sentence, or a
  // target that follows a newline), so this is the safety net that keeps a
  // fully-specified ask from ever hitting a gate. Genuinely sketchy short
  // inputs ("draft an email", "review this") stay gated — they're < 200 chars
  // with no pasted block.
  const hasCodeFence = /```|~~~/.test(text);
  const hasPastedBlock = /:\s*\n[\s\S]{30,}/.test(text) || /["'""][\s\S]{60,}["""']/.test(text);
  const isLongDetailed = text.length >= 200;
  const isSelfContained = hasCodeFence || hasPastedBlock || isLongDetailed;
  // Skip the clarification gates entirely when the user is responding to
  // a prior "needs context" prompt — they have, by definition, already
  // satisfied a slot we asked about, so re-asking would loop. Also skip
  // them when an attachment fills the missing slot, or when the message is
  // self-contained (see above).
  if (!useThreadContext && !isContinuation && !skipTargetGate && !isSelfContained && intentDetection.followUp) {
    return res.json({
      kind: "message",
      text: intentDetection.followUp,
      needsContext: true,
      clarification: {
        originalText: text,
        intent: intentDetection.intent,
        followUpKind: (intentDetection as any).followUpKind ?? "slot",
        summary: `${intentDetection.intent ?? "request"} — need: ${intentDetection.followUp.replace(/[?!.]+$/, "").slice(0, 80)}`,
      },
    });
  }
  if (!useThreadContext && !isContinuation && !hasAttachments && !isSelfContained) {
    const clarification = detectAmbiguity(text);
    if (clarification.ambiguous) {
      return res.json({
        kind: "message",
        text: clarification.question,
        needsContext: true,
        clarification: {
          originalText: text,
          ambiguityKind: "shape",
          summary: clarification.question.slice(0, 80),
        },
      });
    }
  }

  // 2.6 ARITHMETIC SHORT-CIRCUIT. Pure-arithmetic queries ("2+2",
  // "what is 12 * (7-3)") have a deterministic answer and don't
  // benefit from the LLM agent at all. The old path routed them
  // through templates.ts → planAndExecute → triage → direct-answer
  // with the small model, costing 15-25s of LLM time + agent
  // overhead. Short-circuiting here makes the response sub-50ms.
  //
  // Safe eval: the whitelist regex restricts the input to digits,
  // whitespace, and the 6 arithmetic operators + parentheses +
  // comma/decimal point. No identifiers, no globals — Function
  // constructor on that sanitized string can't reach out.
  const arithMatch = text.trim().match(/^\s*(?:what(?:'?s|\s+is)\s+)?([\d\s+\-*/().,]+?)\s*\??\s*$/i);
  if (arithMatch && /\d/.test(arithMatch[1]) && /[+\-*/]/.test(arithMatch[1])) {
    const expr = arithMatch[1].replace(/,/g, "").trim();
    if (/^[\d\s+\-*/().]+$/.test(expr)) {
      try {
        const result = new Function(`"use strict"; return (${expr});`)();
        if (typeof result === "number" && Number.isFinite(result)) {
          const pretty = Number.isInteger(result)
            ? String(result)
            : (Math.round(result * 1e10) / 1e10).toString();
          return res.json({
            kind: "message",
            text: `${expr.replace(/\s+/g, " ").trim()} = ${pretty}`,
          });
        }
      } catch { /* fall through to agent */ }
    }
  }

  // 2.7 DATE / TIME SHORT-CIRCUIT. "what's the date today", "what day is
  // it", "what time is it", "what year is it" all have deterministic
  // answers from the server clock. Routing them through the agent burned
  // ~20s of research.deep + risked a synth 429 (round-2 harness showed a
  // research.deep step that found the right date but the rescue summary
  // bled into the answer). Sub-50ms direct response is what the customer
  // actually wants here.
  if (/^\s*(?:what(?:'s|\s+is|\s+'s)?\s+(?:the\s+)?(?:date|day|time|year|month)(?:\s+(?:today|now|currently|is\s+it))?|what(?:'s|\s+is)\s+today(?:'s\s+date)?|what\s+day\s+(?:of\s+the\s+week\s+)?is\s+(?:it|today)|today's\s+date)\s*\??\s*$/i.test(text)) {
    const now = new Date();
    const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
    const monthName = now.toLocaleDateString("en-US", { month: "long" });
    const dayNum = now.getDate();
    const year = now.getFullYear();
    const lower = text.toLowerCase();
    let answer: string;
    if (/\btime\b/.test(lower)) {
      const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      const tzShort = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").slice(-1)[0] ?? "";
      answer = `It's ${timeStr}${tzShort ? ` ${tzShort}` : ""} on ${dayName}, ${monthName} ${dayNum}, ${year}.`;
    } else if (/\byear\b/.test(lower)) {
      answer = `${year}.`;
    } else if (/\bmonth\b/.test(lower) && !/today/.test(lower)) {
      answer = `${monthName} ${year}.`;
    } else {
      answer = `Today is ${dayName}, ${monthName} ${dayNum}, ${year}.`;
    }
    return res.json({ kind: "message", text: answer });
  }

  // 2.8 FOLLOW-UP SHORT-CIRCUIT. When the current message is a pronoun-
  // anchored edit ("shorten it", "make it shorter"), a summary-of-prior
  // ("summarise it", "tldr it"), a count-extraction from prior ("give me
  // 3 key components"), or a topic-shift continuation ("what about X"),
  // the agent's planner kept searching for the LITERAL pronoun phrase
  // and got junk evidence (multi-turn harness showed "shorten it" →
  // research.deep on "it" → refuse). Far better path: call the LLM
  // directly with the prior assistant content as input plus a clear
  // edit instruction. Sub-30s and reliable.
  //
  // Only fires when useThreadContext = true AND there's an actual prior
  // assistant turn to operate on. Falls through to the agent if the LLM
  // call throws so we don't trade a planner error for an LLM error.
  if (useThreadContext && lastAssistantTurn) {
    const editVerbMatch = text.match(/^\s*(shorten|expand|rewrite|polish|tighten|simplify|elaborate(?:\s+on)?|edit|revise|improve|condense|reformat|format|trim|clean\s+up)\s+(?:it|that|this|them|the\s+(?:above|prior|previous|response|reply|answer|content|text|draft))\s*[.?!]?\s*$/i);
    const makeItMatch = text.match(/^\s*make\s+(?:it|that|this|them|the\s+(?:above|response|reply|answer))\s+(shorter|longer|simpler|clearer|punchier|brief|terse|verbose|tighter|crisper|more\s+\S+|less\s+\S+)\s*[.?!]?\s*$/i);
    const summariseMatch = text.match(/^\s*(summari[sz]e|recap|tldr|brief\s+me\s+on|give\s+me\s+the\s+gist\s+of)\s+(?:it|that|this|them|the\s+(?:above|prior|previous|response|reply|answer))(\s+in\s+[^.?!]+)?\s*[.?!]?\s*$/i);
    const countMatch = text.match(/^\s*(?:give\s+me|list|show\s+me|name|tell\s+me)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(.+?)\s*[.?!]?\s*$/i);
    const whatAboutMatch = text.match(/^\s*(?:what\s+about|how\s+about|and\s+what\s+about)\s+(.+?)\s*[.?!]?\s*$/i);

    // Map edit verbs to their grammatical adjective form. Naive
    // ${verb}+"er" produced "shortener" / "rewriteer" / "elaborateer" —
    // confusing for the LLM. A small map keeps the instruction clean.
    const VERB_TO_DIRECTION: Record<string, string> = {
      shorten: "shorter and more concise",
      expand: "longer and more detailed",
      rewrite: "in a clearer, more polished form",
      polish: "more polished",
      tighten: "tighter and more concise",
      simplify: "simpler and easier to read",
      elaborate: "more detailed",
      "elaborate on": "more detailed",
      edit: "with better clarity and flow",
      revise: "with better clarity and flow",
      improve: "with better clarity, structure, and accuracy",
      condense: "more concise",
      reformat: "with cleaner formatting",
      format: "with cleaner formatting",
      trim: "shorter and trimmed",
      "clean up": "cleaner",
    };

    let followUpInstruction: string | null = null;
    let followUpKind = "edit";
    if (editVerbMatch) {
      const verb = editVerbMatch[1].toLowerCase();
      const direction = VERB_TO_DIRECTION[verb] ?? verb;
      followUpInstruction = `Rewrite the prior assistant response to be ${direction}. Keep the meaning and key points intact; adjust style/length as requested. Output the edited version directly with no preamble.`;
    } else if (makeItMatch) {
      followUpInstruction = `Rewrite the prior assistant response to make it ${makeItMatch[1].toLowerCase()}. Keep the meaning intact; adjust as requested. Output the edited version directly with no preamble.`;
    } else if (summariseMatch) {
      const scope = (summariseMatch[2] ?? " in one or two sentences").trim();
      followUpInstruction = `Summarise the prior assistant response ${scope}. Keep the most important points; drop the rest. Output the summary directly with no preamble.`;
      followUpKind = "summarise";
    } else if (countMatch) {
      const n = countMatch[1];
      const what = countMatch[2];
      followUpInstruction = `From the prior assistant response, give me a numbered list of EXACTLY ${n} ${what}. Each item one or two short sentences. Output starts with "1." on the first line. No preamble, no trailing summary.`;
      followUpKind = "count-extract";
    } else if (whatAboutMatch) {
      const entity = whatAboutMatch[1];
      const lastUserQuestion = recentUserTurns[recentUserTurns.length - 1] ?? "";
      followUpInstruction = `The user just asked about "${entity}" as a follow-up. Their previous question was: "${lastUserQuestion}". Apply the SAME question shape to "${entity}" and answer concisely (one or two sentences). For example: previous "what is the capital of France" + follow-up "what about Germany" → answer "The capital of Germany is Berlin."`;
      followUpKind = "topic-shift";
    }

    if (followUpInstruction) {
      // Bound prior content so the prompt stays small. 1200 chars is
      // ~300 tokens of content + ~150 tokens of instruction — well under
      // any model's context window.
      const priorContent = lastAssistantTurn.slice(0, 1200);
      const prompt = `${followUpInstruction}\n\nPrior assistant response (the content to work from):\n\n${priorContent}`;
      const sys = "You are continuing a conversation. The user's most recent message is a follow-up that depends on the prior assistant response (shown below). Apply the requested transformation directly to that content. Do NOT search for new information; use only what's provided. Output the result with no preamble.";
      // Force LOCAL Ollama (profile=undefined) so OR free-tier rate-limits
      // don't take this fast path down. Local takes ~15-25s vs OR's ~5s
      // when available, but is reliable. A previous run had this routing
      // through synthesis profile → OR 429 → handler threw → agent ran
      // and produced a 5-minute timeout answer about Robert Wyatt's "Sea
      // Song" for a "shorten the RAG explanation" follow-up.
      try {
        const out = await ollamaGenerate(prompt, sys, { profile: undefined, maxTokens: 384 });
        const cleaned = out.trim();
        if (cleaned.length >= 5) {
          return res.json({ kind: "message", text: cleaned, followUpKind });
        }
        // Fall through if the LLM returned nothing usable.
      } catch (e: any) {
        // Fall through to the agent — the planner can try.
        console.warn(`[chat] follow-up direct-LLM failed: ${String(e?.message ?? e).slice(0, 100)}`);
      }
    }
  }

  // 3. No template matched — route to general-task agent. The agent plans + executes
  //    using primitives, optionally saves the plan as a custom template for next time.
  const tpl = templates.find(t => t.id === "general-task")!;
  // Persona resolution:
  //   a) If the user (or upstream caller) supplied req.body.persona, honour it.
  //   b) Else use the active persona from the dashboard.
  //   c) Else, if nothing is active OR the active persona is the generalist
  //      "naxie-agent", auto-route the task to a specialized built-in persona via
  //      pattern matching. The auto-route only fires when the pattern catalog
  //      yields a confident single winner; otherwise we stay on naxie-agent.
  let persona = getActivePersona();
  let personaAutoRouted: { matched: string[]; score: number } | null = null;
  const explicitPersonaId = typeof req.body?.persona === "string" ? req.body.persona.trim() : "";
  if (explicitPersonaId) {
    try {
      const { loadPersonas } = await import("../lib/personas.js");
      const store = loadPersonas();
      const found = store.personas.find(p => p.id === explicitPersonaId);
      if (found) persona = found;
    } catch { /* fall back to active */ }
  } else if (!persona || persona.id === "naxie-agent") {
    const routed = autoRoutePersona(text);
    if (routed) {
      persona = routed.persona;
      personaAutoRouted = { matched: routed.matched, score: routed.score };
    }
  }

  // ─── Lane gate ───
  // BEFORE invoking the planner, check whether the active persona is the
  // right hire for this task. If a non-naxie-agent persona is on the clock and
  // the task is clearly outside their lane, return an inline refusal + hand-
  // off recommendation. This is the gate the ho1 + ho2 hand-off harnesses
  // exposed as missing: prompt-level lane rules get ignored once the planner
  // has run tools, so the model writes fake SQL "with apologies" instead of
  // refusing. The gate runs ~1-2s LLM check and short-circuits the entire
  // plan-execute-synth pipeline when it fires.
  //
  // Skipped for:
  //   • Naxie Agent (catch-all generalist by design — no lane to police)
  //   • Very short queries (< 25 chars) that are usually pleasantries or
  //     date/time questions handled upstream
  //   • Continuation turns (useThreadContext + lastAssistantTurn set) — the
  //     prior turn already committed the lane; switching mid-thread is the
  //     customer's job, not ours.
  // Handoff note surfaced to the customer when the lane gate REROUTES the
  // task instead of refusing it — set below, read when the job is built.
  let laneHandoff: { fromPersona: string; toPersona: string; reason: string } | null = null;
      if (persona && persona.id !== "naxie-agent" && text.length >= 25 && !(useThreadContext && lastAssistantTurn.length > 0)) {
    try {
      const lane = await checkLaneFit(persona, text);
      if (!lane.inLane) {
        // AUTO-HANDOFF: resolve the gate's suggested hire to an actual
        // registered persona and just run the task AS them, instead of
        // making the human switch personas and resend. This is the point of
        // having a roster — "wrong employee picked it up" should self-correct,
        // not dead-end in a refusal (caught live 2026-07-20: a task landed on
        // a persona outside its lane and the only response was "switch and
        // resend yourself").
        const handoffTarget = resolveHireToPersona(lane.suggestedHire);
        if (handoffTarget && handoffTarget.id !== persona.id) {
          laneHandoff = { fromPersona: persona.name, toPersona: handoffTarget.name, reason: lane.reason };
          persona = handoffTarget;
        } else {
          // No resolvable hire (or it resolved back to the same persona,
          // which can't be right) — fall back to the refusal so the customer
          // isn't silently left on a mismatched employee.
          const refusal = buildOutOfLaneRefusal(persona, lane);
          return res.json({
            kind: "message",
            text: refusal,
            activePersona: { id: persona.id, name: persona.name, role: persona.role },
            laneRefusal: { reason: lane.reason, suggestedHire: lane.suggestedHire ?? null },
          });
        }
      }
    } catch (e: any) {
      // Lane gate failures are non-fatal — fall through to the normal path
      // and rely on the persona's prompt-level rule as the second line.
      console.warn(`[chat] lane gate error: ${String(e?.message ?? e).slice(0, 100)}`);
    }
  }

  // Routing rules (in order):
  //   1. Default (NAXION_DELEGATE_ALL=1): the primary delegates EVERY ad-hoc
  //      task to the persona-shifter peer if one is reachable. The primary
  //      then curates the peer's output — quality + security gates, decides
  //      what gets captured to the vault. Worker/editor split.
  //   2. Persona-shifted task (active persona ≠ built-in naxie-agent) → still
  //      prefers a peer tagged role=persona-shifter (same as default path —
  //      this is just the legacy code path when DELEGATE_ALL is off).
  //   3. Local overloaded → delegate to the lightest idle peer regardless of
  //      role. Only used when DELEGATE_ALL is off.
  //   4. Otherwise run locally.
  // We keep the FULL PeerInfo on hand so we can delegate to that *specific*
  // peer later. Earlier versions re-picked via pickLightestIdlePeer at delegate
  // time, which sometimes returned null (e.g. when the peer's inflight count
  // raced with our own job counting as "pending") — and that null surfaced as
  // an unhandled exception. Keeping the picked peer pinned eliminates that.
  let delegatedPeer: PeerInfo | null = null;
  let delegationReason: "worker" | "persona-shifter" | "overload" | null = null;
  // Captured snapshot of the routing decision so we can log it verbatim into
  // the job log. Customer can then see "peer worker@7473 inflight=0 vs local
  // inflight=2 — peer wins" instead of guessing why a task went where.
  let routingDecision: RoutingDecision | null = null;

  // Keep sensitive tasks on the primary so the approval checkpoint parks where
  // the operator can approve (see SENSITIVE_TASK_RE). All the delegation
  // branches below are skipped when this is set.
  const sensitiveLikely = SENSITIVE_TASK_RE.test(text);

  if (sensitiveLikely) {
    routingDecision = {
      decision: "local",
      localInflight: localInflightCount(),
      candidates: [],
      reason: "task may send email, query the database, or call a connector — running on the primary so the approval checkpoint lands here",
    };
  } else if (DELEGATE_ALL) {
    // Chain of command: naxie triages, the sub-agent org (persona-shifter
    // pool) gets first shot when a worker is reachable, Hermes is the
    // local-execution arm when no worker is reachable, and naxie-agent's own
    // pipeline is the last-resort fallback (see the HERMES block below).
    // Hermes being the configured executor no longer skips this — both run,
    // each catching what the other can't.
    try {
      // First pass: see if a persona-shifter is reachable. If yes, use the
      // load-aware picker so a busy persona-shifter doesn't suck up work
      // while local sits idle. If NO persona-shifter at all, fall through
      // to auto-spawn the worker so the route is at least set up.
      let workerPeer = await pickLeastLoadedWorker();
      if (!workerPeer && process.env.NAXION_AUTO_SPAWN_WORKER !== "0") {
        try {
          const handle = await Promise.race([
            ensureWorker({ waitForReady: true }),
            new Promise<{ url: string; spawned: boolean }>((_, reject) =>
              setTimeout(() => reject(new Error("spawn wait timeout")), 8_000),
            ),
          ]);
          if (handle?.url) workerPeer = await pickLeastLoadedWorker();
        } catch (e: any) {
          console.warn("[chat] worker spawn timed out:", e?.message ?? e);
        }
      }
      // DELEGATE_ALL contract: the primary is the EDITOR/curator — every ad-hoc
      // task runs on a persona-shifter WORKER whenever one is reachable, so work
      // actually lands on the pool and concurrent tasks fan out across it. The
      // old code routed through pickExecutor, whose tie-break prefers LOCAL
      // unless a worker is strictly lighter — so an idle primary kept everything
      // and the workers sat at 0 inflight ("only one agent working", confirmed
      // by the load test: 4 concurrent tasks → primary=4, workers=0). Delegate
      // to the lightest worker directly; only run locally if none is reachable.
      if (workerPeer) {
        delegatedPeer = workerPeer;
        delegationReason = persona && persona.id !== "naxie-agent" ? "persona-shifter" : "worker";
        bumpPending(workerPeer.url, +1); // reserve a slot so a concurrent request picks a different worker
        const eff = (workerPeer.inflightJobs ?? 0) + (pendingByPeer.get(workerPeer.url) ?? 0);
        routingDecision = {
          decision: "peer", peer: workerPeer,
          localInflight: localInflightCount(), peerInflight: workerPeer.inflightJobs ?? 0,
          candidates: [], reason: `DELEGATE_ALL → lightest worker ${workerPeer.name ?? workerPeer.url} (effective load ${eff})`,
        };
        // PARALLEL-SCALE: if the chosen worker already has work, spawn an extra
        // (up to the pool cap) so the next concurrent task hits a fresh worker.
        const chosenInflight = workerPeer.inflightJobs ?? 0;
        if (chosenInflight >= 1) {
          void ensureExtraWorker({
            reason: `chosen worker ${workerPeer.name ?? workerPeer.url} has ${chosenInflight} inflight, scaling pool`,
            waitForReady: false,
          }).catch(() => { /* tolerate — task still runs on the chosen peer */ });
        }
      }
    } catch (e: any) {
      console.warn("[chat] delegation pick failed:", e?.message ?? e);
    }
  } else {
    if (persona && persona.id !== "naxie-agent") {
      try {
        routingDecision = await pickExecutor({ preferRole: "persona-shifter" });
        if (routingDecision.decision === "peer" && routingDecision.peer) {
          delegatedPeer = routingDecision.peer;
          delegationReason = "persona-shifter";
        }
      } catch (e: any) {
        console.warn("[chat] pickExecutor failed:", e?.message ?? e);
      }
    }
    if (!delegatedPeer && localInflightCount() >= OVERLOAD_THRESHOLD) {
      try {
        const peer = await pickLightestIdlePeer();
        if (peer) {
          delegatedPeer = peer;
          delegationReason = "overload";
          routingDecision = { decision: "peer", peer, localInflight: localInflightCount(), peerInflight: peer.inflightJobs ?? 0, candidates: [], reason: `local overloaded (≥${OVERLOAD_THRESHOLD}) — handing to ${peer.name ?? peer.url}` };
        }
      } catch (e: any) {
        console.warn("[chat] pickLightestIdlePeer failed:", e?.message ?? e);
      }
    }
  }

  // Build the enriched task the planner actually plans against. We include
  // the recent conversation slice by default — the previous "only on pronoun"
  // heuristic was too narrow. Customers continue topics implicitly all the
  // time ("make it shorter", "what about Q4 too"); explicitly opting out is
  // the rarer case and is detected via the NEW_TOPIC / greeting markers.
  //
  // Attachments support: when the chat body includes
  //   attachments: [{ contextId: "<uuid>" }]
  // we resolve each one via the uploads context store and fold the
  // extracted text into the enriched task as an "Attached document"
  // block. The planner / synth sees it the same way it sees any other
  // evidence. The 8k-char cap per attachment keeps the prompt budget
  // sane; longer docs should be vault-imported via /api/uploads
  // target=vault instead, where vault.read can serve them on demand.
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  let attachmentBlock = "";
  let attachmentMeta: { filename: string; chars: number }[] = [];
  if (attachments.length > 0) {
    const { resolveContextAttachment } = await import("./uploads.js");
    const resolved = (await Promise.all(attachments.map(async (a: any) => {
      if (!a?.contextId) return null;
      const r = await resolveContextAttachment(String(a.contextId));
      if (!r) return null;
      return { filename: r.filename, text: r.text.slice(0, 8000) };
    }))).filter(Boolean) as { filename: string; text: string }[];
    if (resolved.length > 0) {
      attachmentBlock = "\n\nAttached documents (user uploaded as context for THIS task — read them carefully and use them as primary evidence):\n" +
        resolved.map((a, i) => `[Attachment ${i + 1}: ${a.filename}]\n${a.text}`).join("\n\n---\n\n");
      attachmentMeta = resolved.map(r => ({ filename: r.filename, chars: r.text.length }));
    }
  }
  // Continuation block — when this turn is the user's reply to a prior
  // "needs context" prompt, we prepend the original request so the
  // planner sees both halves as one request. The bare reply alone
  // ("Sarah, head of Eng") would re-trigger ambiguity; with the
  // original task stitched in, the planner has everything it needs.
  let continuationBlock = "";
  if (isContinuation) {
    continuationBlock =
      `**This is a continuation of a prior request.** The previous response paused for missing context; below is the original request and the context the user just provided. Treat them as a single combined task.\n\n` +
      `--- Original request ---\n${continuation!.originalText}\n\n` +
      `--- Additional context the user just provided ---\n${text}\n\n` +
      `Proceed with the combined request. Do NOT pause again for the same missing slot.`;
  }
  const baseTask = isContinuation
    ? continuationBlock
    : buildEnrichedTask(text, useThreadContext, recentUserTurns, lastAssistantTurn, persona, intentDetection, hasAttachments);
  let enrichedTask = baseTask + attachmentBlock;
  // RAG + MAG injection — so every worker (and Naxie via chat fallback) remembers
  // who Nature is, who Naxie is, and what subagents exist. RAG hits are folded
  // into the task so the planner sees them; MAG core is durable memory.
  try {
    const { buildNaxieContext } = await import("../lib/naxie-context.js");
    // When this turn continues a prior job, key the mission-log lookup on
    // that job's id so the model sees its own working notes from earlier in
    // the same task instead of whatever scope was most recently touched.
    const ctx = await buildNaxieContext(text, {
      ragLimit: 5,
      scopeId: isContinuation ? continuation!.originalJobId : undefined,
      // Session-scoped RAG memory — follow-ups ("that file") resolve against
      // this conversation's last retrieval, keyed by user + chat session.
      sessionId: `${callerOf(req)?.id ?? "local"}:${typeof req.body?.sessionId === "string" && req.body.sessionId.trim() ? req.body.sessionId.trim().slice(0, 60) : "default"}`,
    });
    if (ctx.rag) enrichedTask += "\n\n" + ctx.rag;
    // Keep MAG hints lightweight here — full CAG prefix is system-side, but a
    // one-line operator reminder ensures even a 3b local model doesn't forget.
    if (ctx.mag) {
      const magSnippet = ctx.mag.split("\n").slice(0, 6).join("\n");
      enrichedTask += "\n\n[Memory — do not forget]\n" + magSnippet;
    }
    if (ctx.missionLog) enrichedTask += "\n\n" + ctx.missionLog;
    // Conversation summary (>10 turns): keep older context beyond 20-msg window
    try {
      const humanForSummary = callerOf(req);
      if (humanForSummary) {
        const { getConversationSummary } = await import("../lib/chat-history.js");
        const summary = getConversationSummary(humanForSummary.id);
        if (summary) enrichedTask += `\n\n[Conversation summary — older context beyond last 20 turns]\n${summary}`;
      }
    } catch { /* best-effort */ }
  } catch { /* RAG/MAG/mission-log is best-effort — never break chat on retrieval hiccup */ }
  const job = newJob(`insights:general-task`);
  job.template = tpl.id;
  job.title = isContinuation
    ? `Continuation: ${(continuation!.summary ?? continuation!.originalText).slice(0, 60)}`
    : `Ad-hoc: ${text.slice(0, 60)}`;
  // Stamp the dispatch-time persona so reflection.byPersona aggregates.
  // Worker re-attribution still happens via personaIdUsed but this is
  // the canonical name for the run. When no persona was hired, attribute
  // the run to Naxie herself (PA_IDENTITY) rather than leaving it blank —
  // previously these jobs were invisible to reflection.byPersona entirely,
  // silently undercounting how much work Naxie does directly.
  if (persona) { job.personaId = persona.id; job.personaName = persona.name; }
  else { job.personaId = PA_IDENTITY.id; job.personaName = PA_IDENTITY.name; }
  job.createdByEmail = callerOf(req)?.email;
  // `task` (what the planner consumes) is the enriched version. `userText`
  // (the bare user message) is kept on the job for UI display, retry, and
  // the journal record. The detected intent is stamped on inputs so the
  // Results page / journal can show how the system interpreted the request
  // ("interpreted as: draft-email · to=Sarah · re=Q4 launch slip").
  job.inputs = {
    task: enrichedTask,
    userText: text,
    save_as_template: true,
    threadContextUsed: useThreadContext,
    priorTurnsUsed: useThreadContext ? recentUserTurns.length : 0,
    assistantTurnUsed: useThreadContext && lastAssistantTurn.length > 0,
    intent: intentDetection.intent,
    intentTarget: intentDetection.target,
    intentRecipient: intentDetection.recipient,
    intentTone: intentDetection.tone,
    intentScope: intentDetection.scope,
    ...(delegatedPeer ? { delegatedTo: delegatedPeer.url } : {}),
    ...(personaAutoRouted ? { personaAutoRouted: persona?.id ?? null, autoRouteMatches: personaAutoRouted.matched } : {}),
    ...(persona ? { personaId: persona.id } : {}),
    ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
    ...(isContinuation ? {
      continuesOriginalText: continuation!.originalText,
      ...(continuation!.originalJobId ? { continuesJobId: continuation!.originalJobId } : {}),
      ...(continuation!.summary ? { continuesSummary: continuation!.summary } : {}),
    } : {}),
  };
  if (personaAutoRouted && persona) {
    job.log.push(`[${new Date().toISOString()}] auto-routed to persona "${persona.id}" (score=${personaAutoRouted.score}, matched=${personaAutoRouted.matched.slice(0, 3).join(", ")})`);
  }
  if (laneHandoff) {
    job.log.push(`[${new Date().toISOString()}] lane handoff: ${laneHandoff.fromPersona} was outside scope (${laneHandoff.reason}) — reassigned to ${laneHandoff.toPersona}`);
  }
  if (attachmentMeta.length > 0) {
    job.log.push(`[${new Date().toISOString()}] folded ${attachmentMeta.length} attachment${attachmentMeta.length === 1 ? "" : "s"} into task: ${attachmentMeta.map(a => `${a.filename} (${a.chars} chars)`).join(", ")}`);
  }
  if (isContinuation) {
    const prevRef = continuation!.originalJobId ? ` (continues job ${continuation!.originalJobId.slice(0, 8)})` : "";
    job.log.push(`[${new Date().toISOString()}] continuation${prevRef} · original task: ${continuation!.originalText.slice(0, 120)}`);
  }
  job.requiresApproval = false;
  // Chat blurb is always spoken as Naxie (the PA) — the customer's single
  // point of contact. Which persona actually did the work is carried
  // separately as `handledBy` metadata (see res.json below) rather than
  // becoming the primary voice, so hiring a specialist doesn't change who
  // appears to be answering.
  const delegationBlurb = delegatedPeer
    ? `On it — I've handed this to a worker to execute. I'll review the result before anything lands in your vault. Track live progress on the Tasks page.`
    : `On it — I'll plan the steps and report back here. I'll capture anything worth keeping to your vault.`;
  const handoffPrefix = laneHandoff
    ? `Handed off from **${laneHandoff.fromPersona}** to **${laneHandoff.toPersona}** — ${laneHandoff.reason}\n\n`
    : "";
  // Heads-up when the task looks like it will hit a gated action — the job will
  // plan, then pause at awaiting-approval instead of finishing. Set the
  // expectation so the pause reads as intended, not as a stall.
  const approvalNotice = sensitiveLikely
    ? `\n\n_Heads-up: this may need to send an email, query the database, or call a connector — I'll draft the plan and pause for your approval before running it._`
    : "";

  res.json({
    kind: "task",
    jobId: job.id,
    templateId: tpl.id,
    requiresApproval: false,
    text: handoffPrefix + delegationBlurb + approvalNotice,
    // Who actually did the work — surfaced as a transparent attribution tag
    // on the bubble, not as the visible speaker. Naxie is always the voice;
    // this is metadata about who Naxie delegated to, if anyone.
    handledBy: persona ? { personaId: persona.id, personaName: persona.name, role: persona.role } : null,
    activePersona: persona ? { id: persona.id, name: persona.name, role: persona.role } : null,
    personaAutoRouted: personaAutoRouted ? { ...personaAutoRouted, personaId: persona?.id ?? null } : null,
    laneHandoff,
    delegatedPeer,
    delegationReason,
  });

  if (delegatedPeer) {
    const pinnedPeer = delegatedPeer;
    const pinnedDecision = routingDecision;
    void runJob(job, async (push, progress) => {
     try {
      push(pinnedDecision?.reason ?? `Delegating this to ${pinnedPeer.name ?? pinnedPeer.url}.`);
      push(`Why I delegated: ${delegationReason}.`);
      // Use delegateToPeer (specific) instead of delegateToBestPeer (re-picks)
      // so we always send the work to the peer we already chose. Avoids races
      // where the lightest-idle pick changes between routing and delegating.
      // onProgress fires per worker poll — we mirror the worker's log lines
      // into our own log AND patch the worker's plan/runs/phase into our
      // result so the UI's InlineJob shows live "3 sub-agents working" /
      // "step 2/4" badges instead of a frozen "running" pill.
      const r = await delegateToPeer(pinnedPeer, {
        // The PLANNER sees the enriched task — full conversation context
        // when relevant + persona framing. The chat bubble + journal keep
        // the bare userText so the customer's view stays clean.
        task: enrichedTask,
        persona: persona?.id,
        // Send the full snapshot so the worker can become the customer's
        // hired employee even if it doesn't have that persona installed
        // locally. Without this, custom personas silently fall through
        // to the worker's default identity.
        personaSnapshot: persona ?? undefined,
        // Forward the initiating human so the worker's journal record carries
        // the same owner — the per-user task/calendar slice depends on it.
        createdByEmail: job.createdByEmail,
        // Operator cancel — stops the poll loop (and best-effort tells the
        // worker to cancel its own job) when the user hits Cancel Run.
        signal: getJobAbortSignal(job.id),
        onProgress: (snap) => {
          for (const line of snap.newLogLines) {
            // The worker already timestamps lines with [ISO] — strip that
            // prefix so our push() doesn't double-stamp.
            push(line.replace(/^\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s*/, `[peer] `));
          }
          // Forward shape so the chat bubble's InlineJob renders a real
          // progress bar based on the worker's plan + run completions.
          if (snap.plan || snap.runs || snap.phase || snap.partialAnswer) {
            progress({
              plan: snap.plan,
              runs: snap.runs,
              phase: snap.phase,
              partialAnswer: snap.partialAnswer,
              delegatedJobStatus: snap.status,
            });
          }
        },
      });
      push(`${pinnedPeer.name ?? "Peer worker"} returned in ${(r.elapsedMs / 1000).toFixed(1)}s — ${r.status === "succeeded" ? "succeeded" : `status: ${r.status}`}.`);

      // PERSONA VERIFICATION — the worker now echoes back which persona it
      // actually scoped the run to (personaIdUsed). If it differs from what
      // we sent (or is null when we expected one), surface that immediately
      // so the customer knows the worker didn't adopt the hired employee.
      const expectedPersonaId = persona?.id ?? null;
      const actualPersonaId = (r as any)?.personaIdUsed ?? null;
      if (expectedPersonaId && actualPersonaId !== expectedPersonaId) {
        const warnMsg = `⚠ Persona mismatch — I expected the worker to operate as "${expectedPersonaId}" but it ran as "${actualPersonaId ?? "<none>"}". The output may not reflect the hired employee's framing.`;
        push(warnMsg);
        console.warn(`[chat] ${warnMsg} (peer=${pinnedPeer.url}, jobId=${r.jobId})`);
      } else if (expectedPersonaId && actualPersonaId === expectedPersonaId) {
        push(`Worker confirmed it operated as "${(r as any).personaNameUsed ?? expectedPersonaId}".`);
      }

      // Sensitive-action checkpoint on a DELEGATED plan. The worker planned a
      // db.query / connector.call / email.send and either parked itself
      // (status awaiting-approval) or — against an older worker — returned a
      // hollow "succeeded" with the plan but no executed run. Either way the
      // action must NOT have run unapproved, and a worker's job can't be
      // approved from here. Re-park on the PRIMARY carrying the worker's plan;
      // approving replays it locally (the primary has the same primitives, and
      // outbound actions should run from the audited primary anyway).
      const sensitiveInPlan = await planSensitiveTools(r.plan);
      const sensitiveRan = Array.isArray(r.runs) && r.runs.some((rn: any) => SENSITIVE_APPROVAL_TOOLS.has(rn.step?.tool) && rn.ok === true);
      if ((r.approvalRequired || (sensitiveInPlan.length > 0 && !sensitiveRan))) {
        const tools = (r.approvalRequired?.tools?.length ? r.approvalRequired.tools : sensitiveInPlan);
        push(`The plan ${tools.join(", ")} needs your approval before running. Parking it here — approve on the Approvals page and I'll run the reviewed plan.`);
        return {
          task: enrichedTask, plan: r.plan, runs: [], answer: "", hadWrites: false, delegated: true, delegationReason,
          approvalRequired: { tools, steps: (r.plan?.steps ?? []).length, task: enrichedTask, personaSuffix: personaSystemSuffix(persona) },
        };
      }

      // Primary acts as the editor: score quality, scan for secrets, decide
      // whether the answer is rooted enough to keep. If it passes the gates,
      // a distilled note is written to 0-Inbox/ as the second-brain capture.
      //
      // FAST-PATH: skip curation entirely on direct-answer outputs (plan has
      // no steps). The answer is conversational prose with no evidence runs,
      // so quality.check would score citation_coverage=0 and refuse capture
      // anyway — running it just burns 30-60s for a guaranteed reject. Same
      // for context-rooting (nothing to root in).
      let curation: any = undefined;
      const isDirectAnswer = Array.isArray(r.plan?.steps) ? r.plan.steps.length === 0 : false;
      const peerAllFailed = Array.isArray(r.runs) && r.runs.length > 0 && r.runs.every((rn: any) => !rn.ok);
      if (isDirectAnswer) {
        push(`Skipping vault capture — direct answers have no sourced evidence to file away (saves ~30-60s).`);
      } else if (peerAllFailed) {
        push(`Skipping vault capture — every step failed on the worker, so there's nothing to file.`);
      } else if (r.status === "succeeded" && typeof r.answer === "string" && r.answer.trim().length > 0) {
        try {
          push(`Curating the result — quality + security check, then deciding whether to file to your second brain.`);
          curation = await curatePeerOutput({
            task: text,
            answer: r.answer,
            runs: r.runs,
            personaId: persona?.id,
            // Hand the worker's QA results to the curator so it can fast-path
            // the redundant quality+security re-check when the worker already
            // produced a clean pass. Saves ~5-15s on every confident draft.
            workerQuality: r.quality,
            workerSecurity: r.security,
          });
          if (curation.captured) push(`Filed to your second brain → ${curation.path}.`);
          else push(`Not filed to the vault — ${curation.reason ?? "didn't pass capture criteria"}.`);
        } catch (e: any) {
          push(`Curation hit an error: ${String(e?.message ?? e)}.`);
          curation = { captured: false, reason: `curation error: ${String(e?.message ?? e)}` };
        }
      }
      return { ...r, delegated: true, delegationReason, curation };
     } finally {
       // Release the reserved slot so the worker's effective load drops back
       // and the next request can pick it again.
       bumpPending(pinnedPeer.url, -1);
     }
    });
  } else {
    // Local execution path — primary handles the work itself. This happens
    // when (a) no peer is reachable, (b) primary is the lightest executor
    // right now, or (c) we tried to spawn a worker and it didn't come up.
    // We still run the curation gate on the primary's own output so the
    // customer sees the same QA layer they get with a worker peer.
    const pinnedDecision = routingDecision;
    void runJob(job, async (push, progress) => {
      push(pinnedDecision?.reason ?? "Handling this myself — no peer workers are reachable.");

      // HERMES PRIMARY (with OFFLOAD) — run the task through Hermes first,
      // injecting the persona-shifter's PROMPT features (lane/voice +
      // governance). Hermes also has naxie-agent's grounding tools via the MCP
      // bridge. If Hermes CAN'T do it — errors, "no final response", or a
      // too-thin answer — we OFFLOAD to naxie-agent's full pipeline below. Each
      // agent does what it's best at; naxie-agent catches the rest.
      let offloadedFromHermes = false;
      // Captured ONLY on a quality-fail offload (not a hard-fail — a hard-failed
      // Hermes run has no usable answer to compare). Used below, after naxie-agent's
      // runFromChat produces its own answer, to cross-check the two instead of
      // unconditionally taking naxie-agent's — see crosscheckAnswers() in peers.ts.
      let hermesQualityFailAnswer: string | undefined;
      // If OpenRouter's circuit is open (a recent outage), Hermes — which runs
      // on an OpenRouter model — would just burn its full 220s timeout before
      // failing and offloading anyway. Skip it and go straight to naxie-agent, which
      // can plan/synth on the local model. This alone avoids ~220s of dead wait
      // per task during an OpenRouter outage.
      let skipHermesForOutage = false;
      const useHermes = isHermesPrimary() || isHermesCodeTask(text);
      if (useHermes) {
        try {
          const { openrouterCircuitOpen } = await import("../lib/openrouter.js");
          if (openrouterCircuitOpen()) {
            skipHermesForOutage = true;
            offloadedFromHermes = true;
            push("OpenRouter is unavailable right now — skipping the Hermes attempt and running on the local pipeline.");
          }
        } catch { /* probe optional */ }
      }
      // Sensitive tasks skip Hermes entirely: Hermes reaches email.send/db/
      // connectors through the MCP bridge, which is NOT behind the approval
      // checkpoint. Route them straight to naxie-agent's gated plan pipeline.
      if (useHermes && sensitiveLikely) {
        push("This task may send email, query the database, or call a connector — routing it through the gated pipeline so it pauses for your approval first.");
      }
      if (useHermes && !skipHermesForOutage && !sensitiveLikely) {
        const { runHermesAgent } = await import("../lib/hermes.js");
        let governance = "";
        try { const { loadGovernancePrefix } = await import("../lib/governance.js"); governance = loadGovernancePrefix(); } catch { /* optional */ }
        // Inject the matched SKILL playbook so Hermes (the primary executor) gets
        // the same task-shaping guidance naxie-agent's synth does. Without this the
        // skill library was dead weight under Hermes — a reconciliation came back
        // with the adjustment directions wrong because the playbook never loaded.
        let skillText = "";
        try {
          const { suggestSkillsForTask } = await import("../lib/skills.js");
          const sk = suggestSkillsForTask(text, undefined, 1);
          if (sk.length > 0) { skillText = sk[0].body; push(`Loaded the **${sk[0].name}** skill playbook for this task.`); }
        } catch { /* skills are optional guidance */ }
        const hr = await runHermesAgent(enrichedTask, {
          personaSuffix: personaSystemSuffix(persona),
          governance,
          skillText,
          personaId: persona?.id ?? null,
          model: getHermesModelOverride(),
          push,
        });
        const answerLen = (hr.answer ?? "").trim().length;
        const hardFail = !hr.ok || answerLen < HERMES_MIN_ANSWER;

        // QUALITY GATE — for a present answer, run naxie-agent's quality.check; a
        // non-passing verdict offloads to naxie-agent too (catches weak-but-not-
        // empty answers, e.g. ignored-the-format). Skipped on hard fails (no
        // point scoring an error string) and when the gate is off.
        let qualityFail = false;
        if (!hardFail && HERMES_FALLBACK && HERMES_QUALITY_GATE) {
          const ctx = persona ? `${persona.name}, ${persona.role}` : undefined;
          const q = await scoreHermesAnswer(text, hr.answer, ctx);
          if (q && q.pass === false) {
            qualityFail = true;
            push(`Quality gate: Hermes answer didn't pass naxie-agent's quality.check${Number.isFinite(q.score) ? ` (score ${q.score.toFixed(2)})` : ""} — offloading to naxie-agent.`);
          } else if (q) {
            push(`Quality gate: Hermes answer passed${Number.isFinite(q.score) ? ` (score ${q.score.toFixed(2)})` : ""}.`);
          }
        }

        const canDo = hr.ok && answerLen >= HERMES_MIN_ANSWER && !qualityFail;
        if (canDo || !HERMES_FALLBACK) {
          // Hermes handled it (or fallback disabled) — direct answer, skip
          // curation (no sourced plan), same as a chat reply.
          progress({ phase: "done", partialAnswer: hr.answer });
          return hr;
        }
        offloadedFromHermes = true;
        if (hardFail) push(`Hermes couldn't complete this (${hr.error ?? `answer too thin — ${answerLen}c`}) — offloading to naxie-agent for maximum coverage.`);
        // Only the quality-fail case has a usable Hermes answer worth cross-
        // checking — a hard fail means Hermes errored or came back too thin.
        else if (qualityFail) hermesQualityFailAnswer = hr.answer;
      }

      const result = await runFromChat("general-task", { task: enrichedTask, save_as_template: true, _signal: getJobAbortSignal(job.id) }, push, progress);
      // Tag offloaded results so the UI / tests can see the Hermes→naxie-agent handoff.
      if (offloadedFromHermes && result && typeof result === "object") (result as any).offloadedFromHermes = true;

      // CROSS-CHECK — quality-fail offload only (a hard fail has no usable
      // Hermes answer to compare), and only when the operator turned it on
      // (executor-mode's `crosscheck` flag). Hard-fail behavior and the
      // crosscheck-disabled path are UNCHANGED: straight to naxie-agent's answer,
      // no added latency. naxie-agent's pipeline already ran above regardless —
      // this only changes what happens with its output, not whether it runs.
      if (hermesQualityFailAnswer !== undefined && isCrosscheckEnabled() && result && typeof result === "object") {
        const workerAnswer = (result as any).answer;
        if (typeof workerAnswer === "string" && workerAnswer.trim().length > 0) {
          try {
            push("Cross-checking Hermes's answer against naxie-agent's before picking a final response.");
            const verdict = await crosscheckAnswers({
              task: text,
              answerA: hermesQualityFailAnswer,
              answerB: workerAnswer,
              labelA: "hermes",
              labelB: "naxie-agent",
            });
            const winnerAgent: "hermes" | "naxie-agent" | "tie" = verdict.winner === "a" ? "hermes" : verdict.winner === "b" ? "naxie-agent" : "tie";
            (result as any).crosschecked = true;
            (result as any).crosscheckWinner = winnerAgent;
            if (verdict.winner === "a") {
              (result as any).answer = hermesQualityFailAnswer;
              push(`Cross-check picked Hermes's answer over naxie-agent's${verdict.reason ? ` (${verdict.reason})` : ""}.`);
            } else if (verdict.winner === "tie") {
              push(`Cross-check called it a tie${verdict.reason ? ` (${verdict.reason})` : ""} — keeping naxie-agent's answer.`);
            } else {
              push(`Cross-check confirmed naxie-agent's answer${verdict.reason ? ` (${verdict.reason})` : ""}.`);
            }
          } catch (e: any) {
            // Fail open toward keeping naxie-agent's already-computed answer —
            // mirrors the quality gate's own fail-safe philosophy.
            push(`Cross-check failed (${String(e?.message ?? e)}) — keeping naxie-agent's answer.`);
          }
        }
      }
      const answer = (result as any)?.answer;
      const planSteps = (result as any)?.plan?.steps;
      const allRuns = (result as any)?.runs;
      const isDirectAnswer = Array.isArray(planSteps) ? planSteps.length === 0 : false;
      // Skip curation if the plan produced ZERO successes — the answer is a
      // fallback rescue summary (an honest "X failed because Y"), not real
      // content. Curation would score it as trash anyway and burn 30-60s.
      const allWorkFailed = Array.isArray(allRuns) && allRuns.length > 0 && allRuns.every((r: any) => !r.ok);
      if (isDirectAnswer) {
        push(`Skipping vault capture — direct answers have no sourced evidence to file (saves ~30-60s).`);
        return result;
      }
      if (allWorkFailed) {
        push(`Skipping vault capture — every step failed, so there's only a failure summary to return (nothing to file).`);
        return result;
      }
      if (typeof answer === "string" && answer.trim().length > 0) {
        try {
          push(`Self-curating — no peer reachable, so I'm acting as both worker and editor for this one.`);
          const curation = await curatePeerOutput({
            task: text,
            answer,
            runs: (result as any)?.runs,
            personaId: persona?.id,
            // Local path: the agent's own QA wave already produced these, so
            // pass them through to avoid a second pass when they're clean.
            workerQuality: (result as any)?.quality,
            workerSecurity: (result as any)?.security,
          });
          if (curation.captured) push(`Filed to your second brain → ${curation.path}.`);
          else push(`Not filed to the vault — ${curation.reason ?? "didn't pass capture criteria"}.`);
          return { ...(result as any), curation };
        } catch (e: any) {
          push(`Curation hit an error: ${String(e?.message ?? e)}.`);
          return result;
        }
      }
      return result;
    });
  }
}

// helper for plain Ollama path (kept for potential future use)
void personaSystemSuffix;

// Intent + slot extraction. Heuristic only (no LLM cost) — classifies the
// user's message into a high-level intent and pulls out structured slots
// (deliverable format, recipient, topic). This drives three things:
//   1. Smarter clarification questions when required slots are missing
//      ("draft an email" → "who's it for?", not generic "tell me more")
//   2. An output-format hint appended to the enriched task so the synth
//      shapes the deliverable like an employee would (email format for
//      emails, memo header for memos, code blocks for code, etc.)
//   3. Intent gets stamped on the job for audit so the user can see how
//      the system interpreted their request.
//
// Intents covered (each maps to a deliverable shape the synth recognises):
//   draft-email, draft-memo, draft-report, draft-brief, draft-other,
//   summarize, research, review, explain, edit, code, plan, list, table,
//   answer (default — no format override)
export type Intent =
  | "draft-email" | "draft-memo" | "draft-report" | "draft-brief" | "draft-other"
  | "summarize" | "research" | "review" | "explain" | "edit" | "code" | "plan"
  | "list" | "table" | "answer";

export type IntentDetection = {
  intent: Intent;
  target?: string;       // What the action is on (topic, file, path).
  recipient?: string;     // Who the deliverable is for (drafts).
  tone?: string;          // formal / casual / blunt — biases synth tone.
  scope?: string;         // brief / detailed / one-pager.
  missingSlots: string[]; // Slot names that still need a value.
  followUp?: string;       // Generated question when missingSlots is non-empty.
  formatHint?: string;     // Deliverable-shape guidance for the synth.
};

function extractIntent(text: string, hasThread: boolean): IntentDetection {
  const t = text.trim();
  const lower = t.toLowerCase();
  let intent: Intent = "answer";
  let target: string | undefined;
  let recipient: string | undefined;
  let tone: string | undefined;
  let scope: string | undefined;
  const missingSlots: string[] = [];

  // Tone qualifiers — pulled regardless of intent so the synth can match
  // register.
  const toneMatch = lower.match(/\b(formal|casual|blunt|friendly|professional|warm|terse|concise|detailed|brief)\b/);
  if (toneMatch) tone = toneMatch[1];

  // Scope qualifiers — "brief", "detailed", "one-pager", "in 3 bullets".
  const scopeMatch = lower.match(/\b(brief|detailed|short|long|one[\s-]?pager|tldr|in\s+\d+\s+(?:bullets?|sentences?|words?|paragraphs?))\b/);
  if (scopeMatch) scope = scopeMatch[1];

  // Explicit-count requests — "give me 3 X" / "list 3 X" / "3 best Y" /
  // "3 trade-offs each way". The customer wants a counted list, not a
  // table or prose. Stash the count in scope (preempts the looser
  // qualifier above) so buildFormatHint can emit a numbered-list shape.
  // Number-word forms ("three", "five") are accepted to match how
  // people actually phrase the ask.
  const countMatch = lower.match(/\b(?:give\s+me|list|show\s+me|provide|share|name)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten)\b|\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(?:best|worst|top|main|key|biggest|most|reasons?|trade[- ]?offs?|tips|points?|examples?|ways?|things?|pros?|cons?|benefits?|risks?|steps?|items?|principles?|practices?|patterns?|use[\s-]cases?|advantages?|disadvantages?)\b/);
  if (countMatch) {
    const raw = countMatch[1] ?? countMatch[2];
    const word2num: Record<string, string> = { two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10" };
    const n = word2num[raw] ?? raw;
    const eachWay = /\beach\s+(?:way|side|direction)|\bfor\s+and\s+against\b/i.test(lower);
    scope = eachWay ? `count-${n}-each-way` : `count-${n}`;
  }

  // 1. DRAFT family — "draft / write / compose / prepare / create" + artifact.
  //    Specific sub-intents based on the artifact word.
  const draftMatch = lower.match(/^\s*(?:draft|write|compose|prepare|create)\s+(?:a\s+|an\s+|the\s+|some\s+)?(.+)$/);
  if (draftMatch) {
    const body = draftMatch[1].trim();
    // Detect deliverable type from the HEAD NOUN of the artifact, not anywhere
    // in the body. The old "match `email` anywhere" version misfired badly:
    // "write a test plan for a flow where the user enters their email" was
    // routed to draft-email and the agent asked "who's the recipient?". The
    // fix walks past common adjective modifiers ("quick", "short",
    // "1-page", "150-word") to find the actual artifact noun.
    const headMatch = body.match(/^(?:(?:quick|short|brief|fast|simple|one|new|formal|casual|polite|friendly|[\d-]+(?:-?(?:page|word|paragraph|line|sentence))?|[\d-]+)\s+){0,3}([\w-]+)/i);
    const head = headMatch ? headMatch[1].toLowerCase() : "";
    if (/^(?:emails?|reply|replies|message|messages?)$/.test(head)) intent = "draft-email";
    else if (/^memos?$/.test(head)) intent = "draft-memo";
    else if (/^reports?$/.test(head)) intent = "draft-report";
    else if (/^(?:briefs?|one-?pagers?|onepagers?)$/.test(head)) intent = "draft-brief";
    else intent = "draft-other";

    // Pull topic first ("about X" / "on X" / "regarding X" / "re: X"), then
    // strip it so the recipient extraction below doesn't greedily eat it.
    // Old: "to Sarah about Q4 launch" → recipient="Sarah about Q4 launch".
    // New: topic="Q4 launch slipping", recipient="Sarah".
    const topicMatch = body.match(/\b(?:about|on|regarding|re:?)\s+(.{3,120})$/i);
    if (topicMatch) target = topicMatch[1].trim();

    let bodyForRecip = body;
    if (topicMatch && topicMatch.index !== undefined) {
      bodyForRecip = body.slice(0, topicMatch.index).trim();
    }

    // Recipient: "to X" / "for X". The addressee can sit mid-sentence
    // ("email to a customer, Dr. Patel, apologizing…") or at the end
    // ("email to Sarah"). Try, in order: a titled/proper name (optionally
    // after an "a customer," lead-in), then a role ("the team", "customers"),
    // then the old end-anchored remainder. End-anchoring alone missed every
    // detailed request whose body continued past the name.
    const recipMatch =
      bodyForRecip.match(/\b(?:to|for)\s+(?:an?\s+[a-z]+,\s*)?((?:Dr|Mr|Mrs|Ms|Prof|Sir|Dame)\.?\s+[A-Z][\w'-]+|[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,2})/)
      ?? bodyForRecip.match(/\b(?:to|for)\s+((?:the|our|my)\s+[a-z]+(?:\s+[a-z]+)?|customers?|clients?|users?|investors?|stakeholders?|the\s+(?:team|board|leads?))\b/i)
      ?? bodyForRecip.match(/\b(?:to|for)\s+([A-Za-z][\w\s.'-]{1,40}?)\s*$/);
    if (recipMatch) recipient = recipMatch[1].trim().replace(/[.,;]+$/, "");

    // Fallback target: if no "about" clause, use the artifact phrase itself
    // (e.g. "draft a memo" → target="memo" is fine, no missing slot).
    if (!target && bodyForRecip.length > 3) {
      target = bodyForRecip.replace(/\s+(?:to|for)\s+[\w\s.'-]+$/i, "").trim();
    }

    // Required slots per draft sub-intent.
    if (intent === "draft-email" && !recipient && !hasThread) missingSlots.push("recipient");
    if ((!target || target.length < 4) && !hasThread) {
      missingSlots.push("topic");
    }
  }

  // 2. SUMMARIZE — "summarize X" / "recap X" / "tl;dr X".
  else if (/^\s*(?:summari[sz]e|recap|tldr|tl;dr|brief\s+me\s+on)\b/i.test(t)) {
    intent = "summarize";
    const m = t.match(/^\s*(?:summari[sz]e|recap|tldr|tl;dr|brief\s+me\s+on)\s+(?:the\s+|a\s+|my\s+)?([^\n]+)/i);
    if (m) target = m[1].trim().replace(/[.?!]+$/, "");
    if (!target && !hasThread) missingSlots.push("target");
  }

  // 3. REVIEW / CRITIQUE — "review X" / "critique X" / "evaluate X".
  else if (/^\s*(?:review|critique|evaluate|assess|check|audit)\s+/i.test(t)) {
    intent = "review";
    const m = t.match(/^\s*(?:review|critique|evaluate|assess|check|audit)\s+(?:the\s+|a\s+|my\s+)?([^\n]+)/i);
    if (m) target = m[1].trim().replace(/[.?!]+$/, "");
    if (!target && !hasThread) missingSlots.push("target");
  }

  // 4. EDIT / REWRITE — "edit X" / "polish X" / "rewrite X".
  else if (/^\s*(?:edit|revise|polish|rewrite|improve|tighten|clean\s+up|reformat|format|proofread)\s+/i.test(t)) {
    intent = "edit";
    const m = t.match(/^\s*(?:edit|revise|polish|rewrite|improve|tighten|clean\s+up|reformat|format|proofread)\s+(?:the\s+|a\s+|my\s+)?([^\n]+)/i);
    if (m) target = m[1].trim().replace(/[.?!]+$/, "");
    if (!target && !hasThread) missingSlots.push("target");
  }

  // 5. CODE — "implement X" / "build a Y component" / mentions of code/function.
  else if (/^\s*(?:implement|build|code|write\s+(?:a\s+|the\s+)?(?:function|class|component|script|test))\b/i.test(t) ||
           /\b(?:in\s+(?:typescript|javascript|python|rust|go|java|c\+\+))\b/i.test(t)) {
    intent = "code";
    if (t.length < 15 && !hasThread) missingSlots.push("spec");
  }

  // 6. PLAN / PROPOSE — "plan X" / "outline Y" / "propose Z".
  else if (/^\s*(?:plan|outline|propose|recommend|suggest|design|map\s+out|lay\s+out)\s+/i.test(t)) {
    intent = "plan";
    const m = t.match(/^\s*(?:plan|outline|propose|recommend|suggest|design|map\s+out|lay\s+out)\s+(?:a\s+|the\s+|an?\s+)?([^\n]+)/i);
    if (m) target = m[1].trim().replace(/[.?!]+$/, "");
    if (!target && !hasThread) missingSlots.push("topic");
  }

  // 7. RESEARCH / ANALYZE — "research X" / "investigate Y" / "compare A and B".
  else if (/^\s*(?:research|investigate|analy[sz]e|explore|look\s+into|examine|study|compare|contrast)\b/i.test(t)) {
    intent = "research";
    const m = t.match(/^\s*(?:research|investigate|analy[sz]e|explore|look\s+into|examine|study|compare|contrast)\s+([^\n]+)/i);
    if (m) target = m[1].trim().replace(/[.?!]+$/, "");
    if (!target && !hasThread) missingSlots.push("topic");
  }

  // 8. EXPLAIN — "explain X" / "what is X" / "how does X". These often land
  //    on the direct-answer path; we still tag the intent so the synth uses
  //    a tight prose format with no preamble.
  else if (/^\s*(?:explain|describe|clarify|tell\s+me\s+about|what(?:'s|\s+is|\s+are|\s+does|\s+do)|how\s+(?:do|does|can|should|would)|why\s+|when\s+|where\s+)/i.test(t)) {
    intent = "explain";
  }

  // 9. LIST / TABLE — "list X" / "show me a list of Y" / "table of Z".
  else if (/^\s*(?:list|enumerate|show\s+me\s+(?:a\s+)?list\s+of)\b/i.test(t)) {
    intent = "list";
    const m = t.match(/^\s*(?:list|enumerate|show\s+me\s+(?:a\s+)?list\s+of)\s+([^\n]+)/i);
    if (m) target = m[1].trim();
    if (!target && !hasThread) missingSlots.push("topic");
  }
  else if (/^\s*(?:table|tabulate|show\s+me\s+(?:a\s+)?table\s+of)\b/i.test(t)) {
    intent = "table";
    const m = t.match(/^\s*(?:table|tabulate|show\s+me\s+(?:a\s+)?table\s+of)\s+([^\n]+)/i);
    if (m) target = m[1].trim();
    if (!target && !hasThread) missingSlots.push("topic");
  }

  // Generate intent-aware follow-up + deliverable-shape hint.
  const formatHint = buildFormatHint(intent, tone, scope);
  const followUp = missingSlots.length > 0 ? buildFollowUp(intent, missingSlots) : undefined;

  return { intent, target, recipient, tone, scope, missingSlots, followUp, formatHint };
}

function buildFollowUp(intent: Intent, missing: string[]): string {
  // Tailored asks per (intent, missing-slot) pair. Keep each question short
  // and concrete — give the customer one or two examples of what to drop
  // in their reply so they don't bounce a second time.
  if (intent === "draft-email") {
    if (missing.includes("recipient") && missing.includes("topic")) {
      return "Happy to draft that email — who's it for, and what's the gist? A line like \"to Sarah, about the Q4 launch slipping a week\" gives me enough to write a solid first cut.";
    }
    if (missing.includes("recipient")) {
      return "Got the topic — who's the recipient? Drop a name or role and I'll pitch the tone right.";
    }
    if (missing.includes("topic")) {
      return "Sure — what's the email about? A line on the subject and the 1-2 key points is enough.";
    }
  }
  if (intent === "draft-memo" && missing.includes("topic")) {
    return "Got it — what's the memo about, and who's it for? I'll draft a header (To/From/Date/Re) and body.";
  }
  if (intent === "draft-report" && missing.includes("topic")) {
    return "Sure — what should the report cover? Topic, audience (e.g. board / team / customer), and any data sources I should use are all I need.";
  }
  if (intent === "draft-brief" && missing.includes("topic")) {
    return "Happy to write a brief — what's the topic? A line on the audience helps me pitch it right.";
  }
  if (intent === "draft-other" && missing.includes("topic")) {
    return "What should I draft, and what's the topic? A short line on each is enough.";
  }
  if (intent === "summarize" && missing.includes("target")) {
    return "Got it — what should I summarize? Paste the text, drop a file path or URL, or name the topic and I'll dig it out of your vault.";
  }
  if (intent === "review" && missing.includes("target")) {
    return "Sure — what should I review? Paste the content, share a file path / URL, or name the artifact (e.g. \"the auth middleware\" + repo).";
  }
  if (intent === "edit" && missing.includes("target")) {
    return "Happy to edit — share the text, the file path, or paste a draft and I'll pick it up.";
  }
  if (intent === "code" && missing.includes("spec")) {
    return "What should I build? A short spec is enough — what it does, language, and any constraints (e.g. \"a TypeScript debounce, with cancel support, 0 deps\").";
  }
  if (intent === "plan" && missing.includes("topic")) {
    return "What should I plan? Goal + audience is enough (e.g. \"a 2-week migration off Postgres 14 → 16\", or \"a launch plan for the v2 dashboard\").";
  }
  if (intent === "research" && missing.includes("topic")) {
    return "What topic should I research? I'll start with your vault and pull web sources if it's thin there.";
  }
  if (intent === "list" && missing.includes("topic")) {
    return "What should the list cover? A topic or scope is enough.";
  }
  if (intent === "table" && missing.includes("topic")) {
    return "What should the table compare or summarise? Tell me the items / columns you want and I'll build it.";
  }
  return "I need a bit more context — what specifically should I work on?";
}

function buildFormatHint(intent: Intent, tone?: string, scope?: string): string | undefined {
  // Per-intent deliverable shape. These get appended to the enriched task as
  // a "Deliverable:" block — the synth's POLISHED_SYNTH default is generic
  // ("one-page report"), so for any non-default intent we override with a
  // shape that matches what the customer asked for. No hint = synth keeps
  // its default.

  // Explicit-count scope (count-3, count-5-each-way, etc.) overrides the
  // per-intent shape entirely. The customer asked for a counted list — the
  // synth's default (one-page prose with optional bullets) and table-heavy
  // comparison shapes would both miss the ask. Emit a strict numbered-list
  // shape that the synth can't accidentally reshape into a table.
  if (scope && scope.startsWith("count-")) {
    const parts = scope.split("-");
    const n = parts[1];
    const eachWay = scope.endsWith("-each-way");
    let shape: string;
    if (eachWay) {
      shape = `TWO numbered lists, each containing EXACTLY ${n} items. Use bold subheadings to label the two sides (e.g. "**For local inference**" and "**For cloud APIs**"). Each item is ONE or TWO short sentences. NO tables. NO nested bullets. NO TL;DR paragraph. NO trailing summary. Just the two numbered lists, in order. Output starts with the first subheading.`;
    } else {
      shape = `ONE numbered list containing EXACTLY ${n} items. Each item is ONE or TWO short sentences. NO tables. NO nested bullets. NO preamble paragraph. NO trailing summary. Output starts with "1." on the first line.`;
    }
    const annotations: string[] = [];
    if (tone) annotations.push(`Tone: ${tone}.`);
    return `Deliverable shape: ${shape}${annotations.length ? "\n\n" + annotations.join(" ") : ""}`;
  }

  let shape: string | undefined;
  switch (intent) {
    case "draft-email":
      shape = "Email format. Start with `Subject:` on its own line, then a blank line, then the body. Include a greeting and a sign-off using the persona's first name (or \"Best\" if no persona). No preamble like \"Here's the email\" — output the email itself.";
      break;
    case "draft-memo":
      shape = "Memo format. Header first (TO:, FROM:, DATE:, RE:), then a blank line, then the body in tight paragraphs or numbered points. No preamble.";
      break;
    case "draft-report":
      shape = "One-page report. Use `## Overview`, `## Findings`, `## Recommendations` (and `## Next steps` if relevant). Each section 2-5 sentences or 3-6 bullets. No preamble.";
      break;
    case "draft-brief":
      shape = "1-page brief. Start with a 1-line **Bottom line:** (bold label, then the sentence), then 3-5 short bulleted sections with clear subheadings. Do NOT use the literal heading \"TL;DR\" — say what it actually IS. No preamble.";
      break;
    case "draft-other":
      shape = "Direct, finished prose. No \"Here's the draft\" preamble — output the content itself. Sign off with the persona's first name if it's correspondence.";
      break;
    case "summarize":
      shape = "Summary format. Start with a 1-sentence **Bottom line:** (bold label, then the sentence), then 3-7 short bullets covering the key points, then a `## Sources` block if any sources were used. Do NOT use the literal heading \"TL;DR\" — say what it actually IS. No preamble.";
      break;
    case "review":
      shape = "Review format. `## Verdict` (1-2 sentence judgement), `## Strengths` (3-5 bullets), `## Issues` (3-5 bullets, severity-ordered), `## Recommendations` (numbered actions). No preamble.";
      break;
    case "edit":
      shape = "Output the EDITED version directly. Don't quote the original, don't explain changes unless they're material — just deliver the polished text. If the change is substantive, add one trailing `_Note: <one-line rationale>_` italic line.";
      break;
    case "code":
      shape = "Code format. 1-2 sentence description first, then a fenced code block tagged with the right language. If multiple files are needed, separate each with its own ### filename heading. No \"Here's the code\" preamble.";
      break;
    case "plan":
      shape = "Plan format. `## Goal` (1-line), `## Steps` (numbered, actionable), `## Risks` (bulleted), `## Definition of done` (numbered checks). Each step concrete and assignable.";
      break;
    case "list":
      shape = "Markdown bullet list, no preamble, no trailing summary. Each item terse.";
      break;
    case "table":
      shape = "Markdown table with a header row. No preamble — output the table directly. If a short caption helps, add one italic line above.";
      break;
    case "research":
    case "explain":
    case "answer":
      shape = undefined; // Use synth default (one-page report style).
      break;
  }
  if (!shape) return undefined;
  const annotations: string[] = [];
  if (tone) annotations.push(`Tone: ${tone}.`);
  if (scope) annotations.push(`Scope: ${scope}.`);
  return `Deliverable shape: ${shape}${annotations.length ? "\n\n" + annotations.join(" ") : ""}`;
}

// Detect messages that are too under-specified for the planner to act on, and
// return a short follow-up question instead of spinning up a task. The check
// is heuristic-only (no LLM call) so it adds zero latency; we only fire it
// when there's no thread context to fall back on (continuations resolve
// pronouns via the previous turn, so we trust those cases).
//
// Patterns we catch (each one yields a tailored ask, not a generic "be more
// specific" — the question itself nudges the customer toward the missing
// piece):
//   • bare pronoun action ("summarize it") — ask which artifact
//   • bare confirmation ("yes", "go ahead") with no pending suggestion
//   • generic verb only ("run", "do it") — ask what
//   • bare "the X" reference where X is a generic noun and no qualifier
//   • too short / non-actionable message ("?", "...", single noun)
//   • "tell me more" / "continue" with no thread
//
// Returns { ambiguous: false } when the task is self-sufficient.
function detectAmbiguity(text: string): { ambiguous: boolean; question: string } {
  const t = text.trim();
  // Empty / punctuation-only messages.
  if (t.length < 2 || /^[?.!,…\s-]+$/.test(t)) {
    return { ambiguous: true, question: "I caught your message but couldn't read what you'd like me to do — could you spell out the task or ask a question?" };
  }
  // Greetings, thanks, farewells — return a warm one-liner instead of
  // demanding clarification. The previous catch-all turned "hi" into
  // "hi on its own doesn't tell me what to do" which felt cold.
  // Matches the same shapes the agent's isTriviallyDirectAnswer
  // recognises so the surface is consistent.
  if (/^(?:hi|hello|hey|yo|sup|hiya|howdy|good\s+(?:morning|afternoon|evening)|gm|ga|ge)\b[\s!,.?]*$/i.test(t)) {
    const hour = new Date().getHours();
    const tod = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    return { ambiguous: true, question: `Hey — good ${tod}. What can I help with? Drop a task (e.g. "summarise my vault on X" or "save the resume.pdf in my downloads to my vault") and I'll get going.` };
  }
  if (/^(?:thanks?|thank\s+you|ty|thx|appreciate(?:\s+it)?|cheers)\b[\s!,.?]*$/i.test(t)) {
    return { ambiguous: true, question: "Anytime. Send another task whenever you're ready." };
  }
  if (/^(?:bye|goodbye|see\s+ya|later|cya|gn|good\s+night)\b[\s!,.?]*$/i.test(t)) {
    return { ambiguous: true, question: "Catch you later — I'll be here when you need me." };
  }
  // Bare confirmation with no pending action. Checked before the single-word
  // catch-all so confirmations get the dedicated "no pending suggestion" copy.
  if (/^\s*(?:yes|yeah|yep|sure|ok(?:ay)?|sounds?\s+good|go(?:\s+ahead)?|do\s+it|let'?s\s+go|fine|alright)\s*[.?!]*\s*$/i.test(t)) {
    return { ambiguous: true, question: "I don't have a pending suggestion to confirm — what would you like me to do? Drop me a task or a question and I'll get on it." };
  }
  // Bare dismissal.
  if (/^\s*(?:no|nope|nah|stop|cancel|never\s*mind)\s*[.?!]*\s*$/i.test(t)) {
    return { ambiguous: true, question: "Got it — nothing to cancel right now. Send me a task whenever you're ready." };
  }
  // "Continue" / "go on" / "tell me more" with no thread.
  if (/^\s*(?:continue|carry\s+on|go\s+on|keep\s+going|tell\s+me\s+more|more\s+please|and\s+then|what\s+else|next)\s*[.?!]*\s*$/i.test(t)) {
    return { ambiguous: true, question: "Continue from where? I don't see a previous thread to pick up — share the topic or paste what we were working on." };
  }
  // Bare verb action on a pronoun: "summarize it", "fix that", "review this",
  // "update the file/doc/note/report/email/draft/spec/brief/code".
  if (/^\s*(?:do|fix|update|review|summari[sz]e|recap|describe|explain|polish|rewrite|expand|shorten|finish|continue|edit|revise|improve|clean(?:\s+up)?|tighten|reformat|format|translate|proofread)\s+(?:it|that|this|them|those|these|the\s+(?:report|file|doc(?:ument)?|note|spec|brief|email|draft|task|thing|stuff|code|page|article|post|message|content|text))\s*[.?!]*\s*$/i.test(t)) {
    return { ambiguous: true, question: "Happy to — which file, note, or topic do you want me to work on? Drop the path, name, or URL and I'll pick it up." };
  }
  // Generic verb without object: "run", "go", "start", "do it".
  if (/^\s*(?:run|launch|start|do|fix|update|review|prepare|build|make|generate|create|send|deliver)\s*[.?!]*\s*$/i.test(t)) {
    return { ambiguous: true, question: "What would you like me to do? A topic, a target file, or a name of the workflow is enough — e.g. \"run the daily digest\", \"summarize my repo X\", or \"review the auth code\"." };
  }
  // Bare pronoun-only message.
  if (/^\s*(?:it|that|this|them|those|these|the\s+(?:one|same|other))\s*[.?!]*\s*$/i.test(t)) {
    return { ambiguous: true, question: "I'm not sure what you're referring to — could you name the file, topic, or task you'd like me to work on?" };
  }
  // Single short word that isn't a clear question — runs LAST so dedicated
  // shapes above (yes/no/run/continue) get their tailored copy first.
  if (/^[a-zA-Z]+\??$/.test(t) && t.length <= 8 && !/^(?:why|how|when|who|what|where)\??$/i.test(t)) {
    return { ambiguous: true, question: `"${t}" on its own doesn't tell me what to do. What would you like me to work on?` };
  }
  return { ambiguous: false, question: "" };
}

import { runFromChat } from "./templates.js";
import { journal } from "../lib/journal.js";

// Save the current chat session to the vault as a session journal. The chat
// UI calls this on demand ("Save session" button) or automatically when the
// conversation is paused for a while. Each save writes ONE markdown file per
// session id; subsequent saves of the same session overwrite, so the user
// always ends up with a single coherent record per chat thread.
// The caller's OWN chat history — prompts + the output each produced. The
// user is resolved from the session token; there is no way to request another
// user's history (no id parameter on purpose). Entries whose prompt became a
// background job are joined against the job store at read time, so a task
// that finished after the "working on it" acknowledgement shows its real
// deliverable here.
chatRouter.get("/history", (req, res) => {
  const human = callerOf(req);
  const userId = human?.id ?? "local";
  const limitRaw = Number(req.query?.limit ?? 50);
  const entries = listChatHistory(userId, Number.isFinite(limitRaw) ? limitRaw : 50);
  const history = entries.map(e => {
    if (!e.jobId) return { ...e, jobStatus: undefined };
    const job = loadJobById(e.jobId);
    if (!job) return { ...e, jobStatus: undefined };
    // Prefer the finished job's synthesised answer over the queued-task
    // acknowledgement the chat endpoint returned at submit time.
    const response = job.status === "succeeded" && job.answer ? job.answer : e.response;
    return { ...e, response, jobStatus: job.status };
  });
  res.json({ history });
});

chatRouter.post("/save-session", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId ?? "").trim() || `adhoc-${Date.now()}`;
    const messages = (req.body?.messages ?? []) as { role: string; content: string; jobId?: string }[];
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages required" });
    }
    // Derive a slug from the first user message — gives the file a meaningful
    // name in the vault instead of a UUID.
    const firstUser = messages.find(m => m.role === "user")?.content ?? "session";
    const slug = sessionId.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40);
    const title = firstUser.slice(0, 80).replace(/\s+/g, " ").trim();
    const persona = getActivePersona();

    const body = renderSessionBody(messages, persona);
    const r = await journal({
      kind: "session",
      slug,
      title: title || "Chat session",
      frontmatter: {
        sessionId,
        messageCount: messages.length,
        persona: persona?.id ?? "none",
        personaName: persona?.name ?? "",
        savedAt: new Date().toISOString(),
      },
      body,
    });
    if ("skipped" in r) return res.status(500).json({ error: r.skipped });
    res.json({ saved: true, path: r.path, sessionId });
  } catch (e: any) {
    console.error("[chat/save-session] error:", e?.message ?? e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

function renderSessionBody(messages: { role: string; content: string; jobId?: string }[], persona: { id: string; name: string; role: string } | null): string {
  const lines: string[] = [];
  if (persona) lines.push(`*Persona: **${persona.name}** (${persona.role})*\n`);
  lines.push(`*${messages.length} message${messages.length === 1 ? "" : "s"} · saved ${new Date().toLocaleString()}*\n`);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const who = m.role === "user" ? "🟣 You" : "⌬ Naxie Agent";
    lines.push(`---`);
    lines.push(`### ${who}`);
    lines.push("");
    lines.push(m.content.trim());
    if (m.jobId) lines.push(`\n*Linked task:* [[_naxion/jobs/${m.jobId.slice(0, 8)}]] (\`${m.jobId}\`)`);
    lines.push("");
  }
  return lines.join("\n");
}

// Build the task string the planner actually plans against. The CHAT UI
// shows the customer's bare message; the planner gets:
//
//   • Persona framing — "You are operating as Maya, the Marketing Manager."
//     Biases tool choice toward the role's conventions.
//   • Conversation context — recent user turns + last assistant turn, joined
//     in chronological order so the planner can resolve implicit references
//     ("make it shorter", "what about Q4", "rewrite the second paragraph").
//     Included by DEFAULT when a thread exists — the caller decides whether
//     to opt out via the useThreadContext flag (greetings / explicit resets).
//   • An explicit "current request" pointer so the planner doesn't confuse
//     prior text with the action it should plan against.
//
// Each turn is capped at 280 chars so a very long prior message doesn't
// dominate the prompt. The last assistant turn is capped at 400 chars (a
// little richer because it usually contains the content the user is now
// pointing at).
// Retry-intent detection. When the user's current message asks us to TRY
// AGAIN with a different approach (and a prior assistant turn exists), we
// build the planner task with explicit "don't repeat the prior approach"
// framing. The synth then loads the retry-different-approach skill and is
// pushed toward a fundamentally different angle.
//
// Patterns are deliberately tight — false-positives here would derail
// normal follow-ups ("shorten it", "elaborate on X") that are NOT retries
// but refinements. A retry says "that's wrong / didn't work / try
// differently". A refinement says "build on what you had".
const RETRY_PATTERN = /\b(?:try (?:again |a |another )(?:approach|angle|take|way|differently|different)|different (?:approach|angle|take)|(?:that('?| i)s|this is)\s+not\s+(?:quite |what )?(?:it|right|what i wanted|the right (?:angle|approach))|(?:that|this)\s+(?:missed|isn't right|doesn't work)|missed (?:the )?(?:point|mark)|wrong (?:approach|angle|tack)|redo (?:this|it|that)|do (?:it |this )?(?:again|over) (?:but )?differently|rethink (?:this|it)|another (?:take|go|attempt)|start over|scrap (?:that|this) and)\b/i;

function detectRetryIntent(text: string, hasLastAssistant: boolean): boolean {
  if (!hasLastAssistant) return false;
  return RETRY_PATTERN.test(text);
}

function buildEnrichedTask(
  text: string,
  useThreadContext: boolean,
  priorUserTurns: string[],
  lastAssistantTurn: string,
  persona: { name: string; role: string } | null,
  intent?: IntentDetection,
  hasAttachments: boolean = false,
): string {
  const parts: string[] = [];
  if (persona) {
    parts.push(`(You are operating as ${persona.name}, the ${persona.role}. Bias tool choices, output shape, and depth toward this role's conventions.)`);
  }

  // ─── Zimbabwean-language support ───
  // Detected on the CURRENT message text so it fires even on a first-turn
  // greeting ("Mhoro") before any thread context exists. See shona-
  // glossary.ts for provenance (adapted from ZimVoice's static vocabulary).
  if (detectsShonaOrNdebele(text)) {
    try {
      const matches = getShonaNdebeleMatches(text);
      console.info(`[chat] Shona/Ndebele detector fired — matches=${JSON.stringify(matches)} textSnippet="${String(text).slice(0,120).replace(/\n/g, " ")}"`);
    } catch (err) {
      console.info(`[chat] Shona/Ndebele detector fired`);
    }
    parts.push(shonaLanguageDirective());
  }

  // ─── Retry path ───
  // If the customer said "try again differently" (or similar) AND we have a
  // prior assistant turn, build a retry-shaped task that gives the planner
  // explicit "avoid the prior approach" context. The PRIOR USER TASK becomes
  // the actual task to plan against — the retry signal itself isn't the work.
  if (useThreadContext && lastAssistantTurn && detectRetryIntent(text, true)) {
    // Use the most recent prior user turn as the original task. If there's
    // no prior user turn (rare — retry on first turn would be impossible),
    // fall back to treating the retry text itself as the task.
    const originalTask = priorUserTurns.length > 0 ? priorUserTurns[priorUserTurns.length - 1] : text;
    const flatPrior = lastAssistantTurn.replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ").trim().slice(0, 600);
    parts.push(
      `**RETRY — different approach required.**\n` +
      `Original task: ${originalTask}\n\n` +
      `The previous attempt produced:\n"${flatPrior}${lastAssistantTurn.length > 600 ? "…" : ""}"\n\n` +
      `The customer said: "${text}"\n\n` +
      `Instructions for THIS attempt:\n` +
      `- Do NOT repeat the prior approach's structure, angle, or framing.\n` +
      `- Pick ONE axis to change: structure (memo→table→checklist), angle (engineering→user→business), scope (zoom in or zoom out), first move (problem→solution swap), or deliverable shape (long→short, dense→scannable).\n` +
      `- Open with one acknowledgment line that names the new angle (e.g. "Take 2 — leading with the user view this time").\n` +
      `- Then deliver the new answer. Do NOT polish the prior; produce something that looks fundamentally different.\n` +
      `- If the persona's lane discipline applies, still honour it — the new angle has to stay in lane.`,
    );
    return parts.join("\n\n");
  }

  if (useThreadContext && (priorUserTurns.length > 0 || lastAssistantTurn)) {
    const lines: string[] = ["Recent conversation (chronological):"];
    // Interleave so the planner sees the actual back-and-forth, not just
    // a list of user turns. Pattern: each user turn followed by the
    // assistant's reply that came AFTER it — but we only kept the LAST
    // assistant turn (cost-bounded), so we attach it after the most recent
    // user turn for accuracy.
    for (let i = 0; i < priorUserTurns.length; i++) {
      const t = priorUserTurns[i];
      lines.push(`  User: "${t.slice(0, 280)}${t.length > 280 ? "…" : ""}"`);
    }
    if (lastAssistantTurn) {
      // Strip code fences / heavy markdown for the assistant snippet — the
      // planner reads it as plain prose. 400-char window.
      const flat = lastAssistantTurn.replace(/```[\s\S]*?```/g, "[code]").replace(/\s+/g, " ").trim();
      lines.push(`  You (assistant): "${flat.slice(0, 400)}${flat.length > 400 ? "…" : ""}"`);
    }
    parts.push(lines.join("\n"));
    parts.push(`Current request (treat as a continuation of the conversation above unless it clearly opens a new topic — resolve any implicit references like "it", "that", "the previous one", "make it shorter" against the recent turns): ${text}`);
  } else {
    parts.push(text);
  }
  // Append the detected-intent line so the planner sees how we read the
  // request (target / recipient / tone / scope) and the synth knows the
  // deliverable shape to produce. Keep this last so it's the freshest
  // context in the prompt window.
  if (intent && (intent.target || intent.recipient || intent.tone || intent.scope || intent.intent !== "answer")) {
    const intentBits: string[] = [`intent=${intent.intent}`];
    if (intent.target) {
      // If the target is a bare pronoun ("this", "that", "it") AND we have
      // an attachment, rewrite to point AT the attachment so the planner
      // doesn't take "this" as a literal research topic. Without this fix
      // "summarize this" + uploaded doc planned research.deep on the word
      // "this" — exactly the failure mode the user reported.
      const bareReferent = /^\s*(?:this|that|it|the(?:\s+(?:above|attached|document|doc|file|pdf|note))?)\s*$/i.test(intent.target);
      if (bareReferent && hasAttachments) {
        intentBits.push(`target="the attached document(s) below"`);
      } else {
        intentBits.push(`target="${intent.target.slice(0, 120)}"`);
      }
    } else if (hasAttachments) {
      intentBits.push(`target="the attached document(s) below"`);
    }
    if (intent.recipient) intentBits.push(`recipient="${intent.recipient.slice(0, 60)}"`);
    if (intent.tone) intentBits.push(`tone=${intent.tone}`);
    if (intent.scope) intentBits.push(`scope=${intent.scope}`);
    parts.push(`Interpretation: ${intentBits.join(", ")}.`);
  }
  // Strong directive when attachments are present — sits closest to the
  // planner's read of the request so it overrides the default "search
  // first" instinct.
  if (hasAttachments) {
    parts.push(`**Source-of-truth notice.** Attached documents follow this block. They are the SOURCE for this task. Do NOT plan vault.search / vault.read / fs.find_in / fs.read_text — the content is already inline below. Operate directly on the attached text.`);
  }
  if (intent?.formatHint) {
    parts.push(intent.formatHint);
  }

  // ─── Alignment directive ───
  // The quality harness (q1) found 7/14 probes at B+ floor. Most misses were
  // alignment misses: the LLM dropped concrete elements the user explicitly
  // requested (named counts like "5 steps" / "top 3 risks", named people,
  // specific dates, named SOP steps, scale numbers like "1200 employees").
  // The synth was treating these as soft hints. This block makes them
  // mandatory: scan the user's text for concrete asks and cross-check the
  // final answer against each one.
  //
  // Skipped for short tasks (< 80 chars) — there's nothing to cross-check.
  // The retry path returns early above, so this only applies to first-turn
  // and continuation tasks.
  if (text.length >= 80 && !detectRetryIntent(text, !!lastAssistantTurn)) {
    parts.push(
      `**Alignment check — required before responding.** Before producing the final answer, scan the user's request for CONCRETE elements and make sure each one is addressed in the output:\n` +
      `- Named counts ("5 steps", "top 3 risks", "4-stage loop", "3 social variants") → produce exactly that many items.\n` +
      `- Named people, roles, accounts, vendors → reference each by name.\n` +
      `- Specific dates, deadlines, scale numbers ("by 2026-06-15", "1200 employees", "$99/mo") → echo verbatim.\n` +
      `- Named sections / deliverable shape ("Title, Symptoms, Root cause, Resolution, Prevention" or "must-haves vs nice-to-haves") → produce each named section.\n` +
      `- Named steps in a process ("paging on-call → scoping impact → status page → comms → escalation → post-mortem") → cover every step.\n` +
      `- Output format directives ("numbered list", "table", "≤4 bullets") → honour exactly.\n` +
      `\n` +
      `If the user asked for N items, produce N items. If they named items A/B/C, the output must reference A, B, AND C. Do NOT silently drop or substitute. If you cannot address one, say so explicitly with the reason — never omit silently.`,
    );
  }

  // Single-part = just bare text. Skip the join overhead.
  if (parts.length === 1) return text;
  return parts.join("\n\n");
}

function inferInputs(templateId: string, text: string): Record<string, any> {
  const out: Record<string, any> = {};
  if (templateId === "summarize-repo") {
    // Extract repo name: look for "the X project" / "summarize X" / "summary of X"
    const m = text.match(/(?:summari[sz]e(?:\s+the)?|summary of|summarise)\s+([^\s,.!?]+)/i);
    if (m) out.repo = m[1];
  } else if (templateId === "search-brain") {
    // Strip the verb AND any "my/the/your vault/notes/brain (for) notes (mentioning|about|on)"
    // chrome so the actual topic ends up in the query. Previously the regex
    // captured "my vault for notes mentioning typescript" verbatim, which
    // searchVault then matched against literal file contents (zero hits).
    const m = text.match(
      /(?:search|find|look\s+up|look\s+for|hunt|grep)\s+(?:(?:my|the|your)\s+(?:notes?|vault|brain|knowledge|second\s+brain)\s+)?(?:for\s+)?(?:(?:notes?|info|stuff|things?|anything|something)\s+(?:about|on|mentioning|with|containing|regarding|that\s+mention)\s+)?(.+?)[.!?]?$/i,
    );
    let q = m ? m[1].trim() : text;
    // Strip "and tell me / and show me / and explain ..." tail so multi-
    // clause queries ("search my vault for typescript and tell me what
    // the top 3 say") search for just the topic ("typescript"). Without
    // this strip the searchVault content-match looks for the whole tail
    // verbatim and returns zero hits.
    q = q.replace(/\s+(?:and|then)\s+(?:tell|show|explain|describe|summari[sz]e|find\s+out|let\s+me\s+know|see|hear|look\s+at)\s.+$/i, "").trim();
    out.query = q;
  } else if (templateId === "run-digest") {
    const m = text.match(/(\d+)\s*days?/);
    out.lookbackDays = m ? Number(m[1]) : 7;
  } else if (templateId === "add-note") {
    // "add (a) note: <title> — <body>", "note that <body>", "save a note about <body>"
    let rest = "";
    let m = text.match(/(?:add|save|capture|create|drop|jot(?:\s+down)?)\s+(?:a\s+|an\s+|the\s+|new\s+)?note(?:\s+(?:that|saying|about|titled|on|for|re))?\s*[:\-—]?\s*(.+)/i);
    if (m) rest = m[1].trim();
    if (!rest) { m = text.match(/^\s*note\s+that\s+(.+)/i); if (m) rest = m[1].trim(); }
    if (rest) {
      // Split title/body on first " — " or " - " or ": "
      const split = rest.match(/^(.+?)\s+[—\-:]\s+(.+)$/);
      if (split) { out.title = split[1].trim(); out.body = split[2].trim(); }
      else { out.title = rest.slice(0, 80); out.body = rest; }
    }
  } else if (templateId === "publish-folder") {
    const m = text.match(/publish\s+(?:the\s+)?(?:folder\s+)?["']?([^"']+?)["']?(?:\s+to\s+github|$)/i);
    if (m) out.path = m[1].trim();
  }
  return out;
}

function friendlyInputs(templateId: string, inputs: Record<string, any>): string {
  if (templateId === "summarize-repo" && inputs.repo) return ` for **${inputs.repo}**`;
  if (templateId === "search-brain" && inputs.query) return ` — query: *${inputs.query}*`;
  if (templateId === "run-digest" && inputs.lookbackDays) return ` (lookback ${inputs.lookbackDays}d)`;
  if (templateId === "add-note" && inputs.title) return ` titled *${inputs.title}*`;
  return "";
}

async function runTemplateInline(templateId: string, inputs: Record<string, unknown>, push: (m: string) => void) {
  return runFromChat(templateId, inputs, push);
}
void config; void searchVault; void ollamaGenerate;

// POST /api/chat/team
//
// Multi-persona parallel team-task endpoint. Accepts an array of tasks, each
// with its own persona (or auto-routed if omitted). Dispatches each in
// parallel — different specialists working the same problem from different
// angles, or working independent slices of a larger workstream.
//
// Body:
//   { tasks: [{ persona?: string, content: string, attachments?: [{contextId}] }] }
//
// Returns:
//   { jobs: [{ jobId, persona: {id,name,role}, autoRouted, title }] }
//
// Each task runs as its own job through the standard planAndExecute path,
// with personaSystemSuffix injected so the persona's lane + voice apply.
// Jobs fire concurrently — limited by the worker pool ceiling already in
// place (NAXION_MAX_WORKERS), so 6 team tasks against a 3-worker pool will
// queue the last 3 behind the first 3.
chatRouter.post("/team", async (req, res) => {
  try {
    const rawTasks = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
    const testMode = req.body?.testMode === true;
    if (rawTasks.length === 0) {
      return res.status(400).json({ error: "tasks: [] required (at least one task)" });
    }
    if (rawTasks.length > 12) {
      return res.status(400).json({ error: `too many tasks (${rawTasks.length}); max 12 per team call` });
    }

    const { loadPersonas } = await import("../lib/personas.js");
    const { planAndExecute, crownBypassesApproval } = await import("../lib/agent.js");
    const { commitAndPush } = await import("../lib/vault.js");
    const personaStore = loadPersonas();

    type ResolvedTask = {
      jobId: string;
      persona: import("../lib/personas.js").Persona | null;
      autoRouted: boolean;
      autoMatches: string[];
      title: string;
      content: string;
      attachments: Array<{ contextId?: string }>;
    };
    const resolved: ResolvedTask[] = [];

    // Same gates as the single-task chat route — the team endpoint is another
    // task-submission entry and must not bypass the local-machine (operator-PC)
    // and capability restrictions.
    const teamLayer = callerLayer(req);
    const { checkTaskAllowed } = await import("../lib/task-restrictions.js");
    for (const t of rawTasks) {
      const content = String(t?.content ?? "").trim();
      if (!content) {
        return res.status(400).json({ error: "each task must have non-empty 'content'" });
      }
      if (teamLayer !== null && teamLayer !== "superadmin" && isLocalMachineTask(content)) {
        return res.status(403).json({ error: "That reads the operator's local machine, which only a super-admin can do.", restrictedCapability: "local-machine" });
      }
      const allowed = checkTaskAllowed(callerOf(req), content);
      if (!allowed.allowed) {
        return res.status(403).json({ error: `Your role can't run ${allowed.capability} tasks${allowed.note ? ` — ${allowed.note}` : ""}.`, restrictedCapability: allowed.capability });
      }
      let persona: import("../lib/personas.js").Persona | null = null;
      let autoRouted = false;
      let autoMatches: string[] = [];
      const explicit = typeof t?.persona === "string" ? t.persona.trim() : "";
      if (explicit) {
        const found = personaStore.personas.find(p => p.id === explicit);
        if (!found) {
          return res.status(400).json({ error: `unknown persona id: ${explicit}` });
        }
        persona = found;
      } else {
        const routed = autoRoutePersona(content);
        if (routed) {
          persona = routed.persona;
          autoRouted = true;
          autoMatches = routed.matched;
        }
      }
      const job = newJob(`insights:general-task`);
      job.title = `Team: ${persona?.name ?? "auto"} · ${content.slice(0, 50)}`;
      job.inputs = {
        task: content,
        userText: content,
        teamTask: true,
        ...(persona ? { personaId: persona.id } : {}),
        ...(autoRouted ? { personaAutoRouted: persona?.id ?? null, autoRouteMatches: autoMatches } : {}),
      };
      job.log.push(`[${new Date().toISOString()}] team-task · persona=${persona?.id ?? "generalist"}${autoRouted ? ` (auto-routed, matched=${autoMatches.slice(0, 3).join(", ")})` : ""}`);

      const attachments = Array.isArray(t?.attachments) ? t.attachments : [];

      resolved.push({
        jobId: job.id,
        persona,
        autoRouted,
        autoMatches,
        title: job.title,
        content,
        attachments,
      });

      // Fire the job. Each runs independently — Promise execution begins now
      // but we don't await; the response returns the handles immediately.
      void runJob(job, async (push, progress) => {
        // Fold attached document text into the task if any.
        let attachmentBlock = "";
        if (attachments.length > 0) {
          try {
            const { resolveContextAttachment } = await import("./uploads.js");
            const parts: string[] = [];
            for (const a of attachments) {
              if (!a?.contextId) continue;
              const r = await resolveContextAttachment(String(a.contextId));
              if (r) parts.push(`[Attachment: ${r.filename}]\n${r.text.slice(0, 8000)}`);
            }
            if (parts.length > 0) attachmentBlock = "\n\nAttached documents (user uploaded as context):\n" + parts.join("\n\n---\n\n");
          } catch (e: any) {
            push(`Attachment resolution warning: ${String(e?.message ?? e).slice(0, 120)}`);
          }
        }
        const enriched = persona
          ? `(You are operating as ${persona.name}, the ${persona.role}. Bias tool choices, output shape, and depth toward this role's conventions.)\n\n${content}${attachmentBlock}`
          : content + attachmentBlock;
        const personaSuffix = personaSystemSuffix(persona);
        if (persona) push(`Working as ${persona.name} — ${persona.role}.`);
        const r = await planAndExecute(enriched, push, (patch) => progress(patch as Record<string, unknown>), { personaSystemSuffix: personaSuffix, workMode: persona?.workMode, testMode, taskKind: job.kind, persona: persona?.name, personaId: persona?.id, scopeId: job.id, skipApprovalGate: crownBypassesApproval(job.priority) });
        if (r.hadWrites) {
          push("Wrote to second brain — committing.");
          try {
            const c = await commitAndPush(`naxie-agent team-task: ${content.slice(0, 60)}`);
            push(`Vault commit: ${(c as any)?.ok === false ? "failed" : "done"}.`);
          } catch (e: any) { push(`Commit didn't go through (non-fatal): ${e?.message ?? e}.`); }
        }
        return r;
      });
    }

    return res.json({
      ok: true,
      count: resolved.length,
      jobs: resolved.map(r => ({
        jobId: r.jobId,
        title: r.title,
        persona: r.persona
          ? { id: r.persona.id, name: r.persona.name, role: r.persona.role }
          : null,
        autoRouted: r.autoRouted,
        autoMatches: r.autoMatches,
      })),
    });
  } catch (e: any) {
    console.error("[chat/team] error:", e?.message ?? e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
