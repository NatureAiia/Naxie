// Voice API — the employees' spoken presence over their reports.
//
// GET  /api/voice/status            → which tiers are live (edge / openai /
//                                     local TTS sidecar / realtime); client
//                                     falls back to the browser's Web Speech
//                                     when all are dark.
// POST /api/voice/ask               → report-grounded Q&A: {jobId, question,
//                                     personaId?, history?} → the employee's
//                                     answer text (client speaks it via its
//                                     best tier).
// POST /api/voice/tts               → {text, personaId?} → audio bytes, Edge
//                                     (Libby) first, then OpenAI, then the
//                                     local sidecar.
// POST /api/voice/realtime-session  → {jobId, personaId?} → short-lived
//                                     client secret; the browser opens a
//                                     WebRTC duplex conversation with the
//                                     provider, report preloaded as context
//                                     (tier A).

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { voiceStatus, voiceForPersona, synthesizeWithVoice, mintRealtimeSession } from "../lib/voice.js";
import { loadJobById } from "../lib/job-store.js";
import { getJob } from "../lib/jobs.js";

export const voiceRouter = Router();

// Streamed TTS — a POST can't be an <audio> element's `src` (only GET can),
// so the client posts the text once, gets back a short-lived one-time GET
// URL, and points <audio> at that. In-memory only (a stream token is
// meaningless across a restart), same ephemeral-map idiom
// connectors.ts's OAuth device-code flow already uses.
const TTS_STREAM_TOKEN_TTL_MS = 60_000;
const ttsStreamTokens = new Map<string, { text: string; personaId?: string; purpose: "main" | "readaloud"; createdAt: number }>();
function sweepExpiredTtsTokens() {
  const cutoff = Date.now() - TTS_STREAM_TOKEN_TTL_MS;
  for (const [token, entry] of ttsStreamTokens) if (entry.createdAt < cutoff) ttsStreamTokens.delete(token);
}

voiceRouter.get("/status", async (_req, res) => {
  try { res.json(await voiceStatus()); }
  catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

// GET /api/voice/wake-status — offline wake-word availability probe (no mic needed)
voiceRouter.get("/wake-status", async (_req, res) => {
  try {
    const { wakeWordStatus } = await import("../lib/wake-word.js");
    res.json(wakeWordStatus());
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/voice/wake — check one transcript chunk for the wake phrase (regex gate)
// Body: { text: string, phrase?: string } — no audio, just the already-transcribed text.
// Returns { wake: boolean, phrase: string } — the WS/PCM path below is the offline Vosk variant.
voiceRouter.post("/wake", async (req, res) => {
  const text = String(req.body?.text ?? "");
  const phrase = req.body?.phrase ? String(req.body.phrase) : undefined;
  try {
    const { isWakePhrase, buildGrammar } = await import("../lib/wake-word.js");
    // When a custom phrase is supplied, build its grammar and test membership;
    // otherwise use the regex gate (covers the "hey, naxie" tolerance + phonetics via grammar).
    let wake = isWakePhrase(text);
    if (phrase) {
      const variants = new Set(buildGrammar(phrase).map(s => s.toLowerCase()));
      wake = variants.has(text.trim().toLowerCase()) || isWakePhrase(text);
    }
    res.json({ wake, phrase: phrase ?? "hey naxie", text: text.slice(0, 200) });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/voice/wake-pcm — offline Vosk check for one raw PCM chunk (16kHz mono 16-bit LE)
// Body: raw Buffer (Content-Type: application/octet-stream), query ?phrase=hey%20naxie
// Returns { wake: boolean } — true the moment the chunk completes a grammar hit.
// Degrades to 503 when the Vosk model isn't installed (see wake-word.ts's model dir).
voiceRouter.post("/wake-pcm", async (req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", c => chunks.push(c as Buffer));
  req.on("end", async () => {
    const pcm = Buffer.concat(chunks);
    if (!pcm.length) return res.status(400).json({ error: "empty PCM body" });
    const phrase = String(req.query.phrase ?? "hey naxie").slice(0, 80);
    try {
      const { createWakeWordSession, voskAvailable } = await import("../lib/wake-word.js");
      if (!voskAvailable()) {
        return res.status(503).json({ error: "Vosk model not installed — see docs/naxie-wakeword-proactive-spike.md §1.3", wake: false });
      }
      const sess = createWakeWordSession(phrase);
      if (!sess) return res.status(503).json({ error: "Wake-word session unavailable (vosk binding or model missing)", wake: false });
      const wake = sess.accept(pcm);
      sess.close();
      res.json({ wake, phrase });
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });
});

// Report + persona context shared by ask + realtime-session.
async function reportContext(jobId: string, personaId?: string): Promise<{ report: string; title: string; personaName: string; personaSuffix: string; personaKey: string }> {
  let title = "the report";
  let report = "";
  const live = getJob(jobId);
  if (live?.result && typeof (live.result as any).answer === "string") {
    report = (live.result as any).answer;
    title = live.title ?? title;
  } else {
    const rec = loadJobById(jobId);
    if (rec?.answer) { report = rec.answer; title = rec.title ?? title; }
  }
  if (!report) throw new Error("job not found or has no report to discuss");

  const { loadPersonas, getActivePersona, personaSystemSuffix } = await import("../lib/personas.js");
  const all = loadPersonas().personas ?? [];
  const wanted = personaId
    ? all.find((p: any) => p.id === personaId || p.name?.toLowerCase() === personaId.toLowerCase())
    : undefined;
  // Fall back to the job's own author, then the active persona.
  const byAuthor = !wanted && live?.personaName ? all.find((p: any) => p.name === live.personaName) : undefined;
  const persona = wanted ?? byAuthor ?? getActivePersona();
  return {
    report: report.slice(0, 9000),
    title,
    personaName: persona?.name ?? "Naxie",
    personaSuffix: personaSystemSuffix(persona ?? null),
    personaKey: persona?.id ?? persona?.name ?? "default",
  };
}

// POST /api/voice/converse — Naxie (PA master) general conversation.
// Side effect: touches .naxion/naxie-interactions.json so the proactive
// daemon can compute "hours since last chat" without guessing.
// Unlike /api/chat (task/template/planner for specific neuros/agents/workers),
// this is Naxie's own conversational channel. The caller does NOT pick a
// model — Naxie decides via naxie-router.ts:
//
//   • Online + simple  → fast free-tier cloud model (small tier, no local load)
//   • Online + complex  → large cloud model (large tier)
//   • Offline           → Ollama ordered by size (small/fast for simple, larger for complex)
//
// The response includes `routing` so the UI can show "quick free" vs "deep"
// vs "local" visibly (task 1). Reachability is probed live (task 2), not just
// "key is set".
//
// Chat (/api/chat) remains the surface for talking to a specific persona/
// worker — Naxie is the PA master that delegates there when needed.
// Naxie's chat bar. Used to be a single direct-passthrough LLM call — now
// routes through the real agent/tool loop (planAndExecute, same system
// /api/chat and template runs use) via a Job, so a reply that needs a tool
// (calendar, vault search, memory) actually calls it instead of guessing,
// and the Workbench view (Naxie.tsx) has real step-by-step progress to show
// via the job's SSE stream. Returns {jobId} immediately; the caller polls
// /api/tasks/jobs/:id or opens jobStream(jobId) for the answer.
//
// The delegate-intent short-circuit below is UNCHANGED and stays instant —
// it's already fire-and-forget with its own OrgTask tracking, no reason to
// wrap that in a job too.
voiceRouter.post("/converse", async (req, res) => {
  const messages: { role: string; content: string }[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const trimmed = messages.slice(-16).map(m => ({
    role: m?.role === "assistant" ? "NaxionAI" : "User",
    content: String(m?.content ?? "").slice(0, 3000),
  }));
  const last = trimmed.pop();
  if (!last || !last.content.trim()) return res.status(400).json({ error: "messages required" });
  // Record interaction before generation — counts even if delegation short-circuits or the job fails.
  try { const { touchInteraction } = await import("../lib/naxie-interactions.js"); touchInteraction(); } catch { /* best-effort */ }
  try {
    const { injectLanguagePrompt } = await import("../lib/language-prompts.js");
    const { classifyChatIntent } = await import("../lib/naxie-router.js");
    const { buildNaxieContext } = await import("../lib/naxie-context.js");
    const baseSystem = injectLanguagePrompt(
      "You are Naxie, the personal assistant master of the whole system. Speak naturally, the way a person would say it out loud — " +
      "short sentences, no markdown, no headings, no bullet lists, no code fences unless the user explicitly asks for code. " +
      "Answer directly from your own knowledge; use a tool when you genuinely need to (calendar, vault, memory) rather than guessing. " +
      "You route more complex or specialized work to the appropriate worker/agent when needed — the Chat surface is for those direct worker conversations.",
      "direct",
    );
    // RAG + MAG + CAG injection — so Naxie never forgets who she is, who Nature is, and what subagents do
    const { callerOf: callerOfVoice } = await import("../lib/access.js").catch(() => ({ callerOf: undefined as any }));
    let voiceSession = "voice:default";
    try {
      const c = callerOfVoice ? callerOfVoice(req) : undefined;
      voiceSession = `voice:${c?.id ?? "local"}`;
    } catch { /* best-effort */ }
    const naxieCtx = await buildNaxieContext(last.content, { ragLimit: 6, includeDated: true, sessionId: voiceSession });
    const system = baseSystem + "\n\n" + naxieCtx.combinedSystemAddendum;
    const convo = trimmed.map(m => `${m.role}: ${m.content}`).join("\n");
    const convoTokens = Math.ceil(convo.length / 4);
    // 1) triage: is this actually a piece of work for a role's backlog, or
    // just a turn to answer directly? (See naxie-router.ts's classifyChatIntent
    // doc comment — this is chat's counterpart to naxie.ts's /ask endpoint,
    // reachable from ordinary conversation instead of only the widget's
    // `/task ` prefix.)
    // MD audit queries must never be delegated — Naxie IS the managing
    // director, she answers system-health / dormant / useless directly from
    // the injected [MD System Audit] context in buildNaxieContext.
    const isMdQuery = /\b(md audit|system audit|managing director|system health|system update|what.*dormant|what.*useless|what.*needs.*improv|audit.*system|health.*system)\b/i.test(last.content)
      || /\b(dormant|useless|needs improv)\b/i.test(last.content) && /\b(system|feature|page|file)\b/i.test(last.content);
    // Model/cost health queries — same "answer from data already on hand"
    // shortcut as MD audit above, so asking "how are the models doing" or
    // "what's failing" doesn't need a tool call for something Naxie already
    // has (see innovation-scan.ts's deriveModelHealthFindings).
    const isModelHealthQuery = /\b(model|models).{0,20}\b(doing|health|failing|failure|status)\b|\bwhat.{0,10}(failing|broken)\b|\bhow much.{0,15}(spent|cost|paid)\b/i.test(last.content);
    const rawIntent = (isMdQuery || isModelHealthQuery) ? { action: "answer" as const, role: undefined as any, reason: "answer directly from injected system/model context" } : classifyChatIntent(last.content, convoTokens) as any;
    const intent: any = rawIntent;
    if (!isMdQuery && !isModelHealthQuery && intent.action === "delegate" && intent.role) {
      const { createOrgTask } = await import("../lib/org-tasks.js");
      const task = createOrgTask({
        role: intent.role,
        title: last.content.slice(0, 100),
        detail: last.content,
        priority: "normal",
        createdBy: "user",
      });
      // Templated ack instead of a full generation call — cheaper, and the
      // reply can never accidentally narrate the internal role name.
      res.json({
        text: "I'll take care of that and follow up.",
        delegated: { taskId: task.id, role: intent.role },
      });
      return;
    }
    let modelHealthBlock = "";
    if (isModelHealthQuery) {
      try {
        const { deriveModelHealthFindings } = await import("../lib/innovation-scan.js");
        const findings = deriveModelHealthFindings();
        modelHealthBlock = findings.length
          ? `\n\n[Model & cost health]\n${findings.map(f => `- ${f.area}: ${f.issue} — ${f.recommendation}`).join("\n")}`
          : "\n\n[Model & cost health]\nNo notable findings — either not enough call volume yet, or everything's healthy.";
      } catch { /* best-effort */ }
    }
    const historyBlock = convo ? `Recent conversation:\n${convo}\n\n` : "";
    const task = `${historyBlock}${naxieCtx.rag ? naxieCtx.rag + "\n\n" : ""}${modelHealthBlock ? modelHealthBlock.trim() + "\n\n" : ""}The user just said: "${last.content}"\n\nRespond as Naxie — speak naturally, use a tool only if you genuinely need one.`;

    const { newJob, runJob } = await import("../lib/jobs.js");
    const { planAndExecute, crownBypassesApproval } = await import("../lib/agent.js");
    const { PA_IDENTITY } = await import("../lib/personas.js");
    const job = newJob("naxie:converse");
    job.title = last.content.slice(0, 80);
    job.personaId = PA_IDENTITY.id;
    job.personaName = PA_IDENTITY.name;
    job.inputs = { task, userText: last.content, sourceNoteId: naxieCtx.sourceNoteId };
    res.json({ jobId: job.id });

    void runJob(job, async (push, progress) => {
      const r = await planAndExecute(task, push, (patch) => progress(patch as Record<string, unknown>), {
        personaSystemSuffix: system,
        persona: PA_IDENTITY.name,
        personaId: PA_IDENTITY.id,
        scopeId: job.id,
        taskKind: job.kind,
        skipApprovalGate: crownBypassesApproval(job.priority),
      });
      return { ...r, sourceNoteId: naxieCtx.sourceNoteId };
    });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

voiceRouter.post("/ask", async (req, res) => {
  const jobId = String(req.body?.jobId ?? "").trim();
  const question = String(req.body?.question ?? "").trim().slice(0, 2000);
  if (!jobId || !question) return res.status(400).json({ error: "jobId and question are required" });
  const history: { q: string; a: string }[] = Array.isArray(req.body?.history)
    ? req.body.history.slice(-6).map((h: any) => ({ q: String(h?.q ?? "").slice(0, 500), a: String(h?.a ?? "").slice(0, 1000) }))
    : [];
  try {
    const ctx = await reportContext(jobId, req.body?.personaId ? String(req.body.personaId) : undefined);
    const { llmGenerate } = await import("../lib/llm.js");
    const { injectLanguagePrompt } = await import("../lib/language-prompts.js");
    const system = injectLanguagePrompt(
      `You are ${ctx.personaName}, the employee who produced the report below, talking it through OUT LOUD with a colleague. ` +
      `Answer their question conversationally — 2-5 spoken sentences, no markdown, no headings, no bullet lists, no URLs read out character by character (say "the link is in the written report" instead). ` +
      `Ground every answer in the report; if the report doesn't cover it, say so plainly and suggest what you'd research next. Numbers and names must match the report exactly.`,
      "direct",
    ) + (ctx.personaSuffix ? "\n\n" + ctx.personaSuffix : "");
    const convo = history.map(h => `Colleague: ${h.q}\n${ctx.personaName}: ${h.a}`).join("\n");
    const prompt =
      `REPORT — "${ctx.title}":\n---\n${ctx.report}\n---\n\n` +
      (convo ? `Conversation so far:\n${convo}\n\n` : "") +
      `Colleague: ${question}\n${ctx.personaName}:`;
    const text = (await llmGenerate(prompt, system, { profile: "synthesis" })).trim();
    res.json({ text, personaName: ctx.personaName });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

voiceRouter.post("/tts", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  // Persona-aware: each persona hashes to a stable local sidecar voice.
  // purpose "readaloud" selects Naxie's af_heart (read-alouds/sent audios);
  // anything else uses her bf_emma main voice. Defaults to main.
  try {
    const pid = req.body?.personaId ? String(req.body.personaId) : undefined;
    const purpose = req.body?.purpose === "readaloud" ? "readaloud" as const : "main" as const;
    const out = await synthesizeWithVoice(text, pid, undefined, purpose);
    res.set("Content-Type", out.contentType);
    res.set("Cache-Control", "no-store");
    res.send(out.audio);
  } catch (e: any) {
    // 503 tells the client to drop to Web Speech for this utterance.
    res.status(503).json({ error: String(e?.message ?? e) });
  }
});

// POST /api/voice/tts/token → {text, personaId?} → { streamUrl }. Step 1 of
// streamed playback (see the comment near ttsStreamTokens above).
voiceRouter.post("/tts/token", (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "text is required" });
  sweepExpiredTtsTokens();
  const token = randomUUID();
  const purpose = req.body?.purpose === "readaloud" ? "readaloud" as const : "main" as const;
  ttsStreamTokens.set(token, { text, personaId: req.body?.personaId ? String(req.body.personaId) : undefined, purpose, createdAt: Date.now() });
  res.json({ streamUrl: `/api/voice/tts/stream/${token}` });
});

// GET /api/voice/tts/stream/:token → audio bytes, forwarded to the client as
// they arrive from the provider (chunked transfer — no Content-Length) so an
// <audio src="..."> element starts playing before the whole clip is
// synthesized. Single-use: the token is consumed on first request.
voiceRouter.get("/tts/stream/:token", async (req, res) => {
  const entry = ttsStreamTokens.get(req.params.token);
  if (!entry) return res.status(404).json({ error: "stream token not found or expired" });
  ttsStreamTokens.delete(req.params.token);
  res.set("Content-Type", "audio/mpeg");
  res.set("Cache-Control", "no-store");
  try {
    await synthesizeWithVoice(entry.text, entry.personaId, chunk => res.write(chunk), entry.purpose ?? "main");
  } catch (e: any) {
    // Headers (audio/mpeg, 200) are already committed once the first chunk
    // writes — there's no clean way to switch to a JSON error mid-stream.
    // Ending the response here makes the <audio> element fire its own error
    // event, which useNaxieAssistant's speak() already treats as "fall back
    // to Web Speech for this utterance", same as a 503 from /tts does today.
    console.warn(`[voice] tts stream failed: ${String(e?.message ?? e).slice(0, 160)}`);
  } finally {
    res.end();
  }
});

// The browser reports realtime token usage here (read off the WebRTC data
// channel's response.done events) so live-call spend is tracked in the Cost
// monitor — the server can't see it otherwise, the audio streams direct to the
// provider. Best-effort: a bad body records nothing rather than erroring.
voiceRouter.post("/usage", async (req, res) => {
  try {
    const model = String(req.body?.model ?? "gpt-realtime").slice(0, 80);
    const inputTokens = Number(req.body?.inputTokens ?? 0);
    const outputTokens = Number(req.body?.outputTokens ?? 0);
    if ((!Number.isFinite(inputTokens) || inputTokens <= 0) && (!Number.isFinite(outputTokens) || outputTokens <= 0)) {
      return res.json({ ok: true, recorded: false });
    }
    const { recordRealtimeVoiceCost } = await import("../lib/cost-tracker.js");
    const costUsd = recordRealtimeVoiceCost(model, inputTokens, outputTokens, "voice-call");
    res.json({ ok: true, recorded: true, costUsd });
  } catch (e: any) {
    res.status(200).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// jobId is optional: when present, behavior is unchanged from before (a
// report-discussion call, VoiceDiscussion.tsx's only caller today). When
// absent, this mints a live call with Naxie herself — no report to ground
// in, just her own persona — for the Naxie page's "Start live call" button.
voiceRouter.post("/realtime-session", async (req, res) => {
  const jobId = String(req.body?.jobId ?? "").trim();
  try {
    let instructions: string;
    let personaName: string;
    let openaiVoice: string;
    if (jobId) {
      const ctx = await reportContext(jobId, req.body?.personaId ? String(req.body.personaId) : undefined);
      openaiVoice = voiceForPersona(ctx.personaKey).openaiVoice;
      personaName = ctx.personaName;
      instructions =
        `You are ${ctx.personaName}, the employee who produced the report below. You're on a live voice call with a colleague to talk it through. ` +
        `Open by greeting them in one short sentence and offering the headline finding. Keep answers conversational and short (a few sentences), let them interrupt, ` +
        `and stay grounded in the report — if something isn't covered, say so honestly. Numbers and names must match the report exactly.\n\n` +
        `${ctx.personaSuffix ? ctx.personaSuffix + "\n\n" : ""}` +
        `REPORT — "${ctx.title}":\n---\n${ctx.report}\n---`;
    } else {
      const { BUILTIN_NAXIE_PERSONA, personaSystemSuffix } = await import("../lib/personas.js");
      openaiVoice = voiceForPersona("naxie").openaiVoice;
      personaName = BUILTIN_NAXIE_PERSONA.name;
      instructions =
        `You're on a live voice call with Nature (the operator). Open with a brief, warm greeting and ask what they need. ` +
        `Keep answers conversational and short (a few sentences), let them interrupt.\n\n` +
        personaSystemSuffix(BUILTIN_NAXIE_PERSONA);
    }
    const sess = await mintRealtimeSession(instructions, openaiVoice);
    res.json({ ...sess, personaName });
  } catch (e: any) {
    res.status(502).json({ error: String(e?.message ?? e) });
  }
});
