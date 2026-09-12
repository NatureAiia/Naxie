// Voice API — the employees' spoken presence over their reports.
//
// GET  /api/voice/status            → which tiers are live (realtime / local
//                                     TTS sidecar); client falls back to the
//                                     browser's Web Speech when both are dark.
// POST /api/voice/ask               → report-grounded Q&A: {jobId, question,
//                                     personaId?, history?} → the employee's
//                                     answer text (client speaks it via its
//                                     best tier). Used by tiers B and C.
// POST /api/voice/tts               → {text, personaId?} → audio bytes from
//                                     the local sidecar (tier B).
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
const ttsStreamTokens = new Map<string, { text: string; personaId?: string; createdAt: number }>();
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
    personaName: persona?.name ?? "Neuro",
    personaSuffix: personaSystemSuffix(persona ?? null),
    personaKey: persona?.id ?? persona?.name ?? "default",
  };
}

// POST /api/voice/converse — Naxie (PA master) general conversation.
// Side effect: touches .neuroworks/naxie-interactions.json so the proactive
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
voiceRouter.post("/converse", async (req, res) => {
  const messages: { role: string; content: string }[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const trimmed = messages.slice(-16).map(m => ({
    role: m?.role === "assistant" ? "NaxionAI" : "User",
    content: String(m?.content ?? "").slice(0, 3000),
  }));
  const last = trimmed.pop();
  if (!last || !last.content.trim()) return res.status(400).json({ error: "messages required" });
  // Record interaction before generation — counts even if delegation short-circuits or LLM fails.
  try { const { touchInteraction } = await import("../lib/naxie-interactions.js"); touchInteraction(); } catch { /* best-effort */ }
  try {
    const { llmGenerateWithMeta } = await import("../lib/llm.js");
    const { injectLanguagePrompt } = await import("../lib/language-prompts.js");
    const { classifyNaxieComplexity, classifyChatIntent, tierFor } = await import("../lib/naxie-router.js");
    const { isCloudReachable } = await import("../lib/connectivity.js");
    const { buildNaxieContext } = await import("../lib/naxie-context.js");
    const baseSystem = injectLanguagePrompt(
      "You are Naxie, the personal assistant master of the whole system. Speak naturally, the way a person would say it out loud — " +
      "short sentences, no markdown, no headings, no bullet lists, no code fences unless the user explicitly asks for code. " +
      "Answer directly from your own knowledge; never claim you can't help without actually trying. " +
      "You route more complex or specialized work to the appropriate worker/agent when needed — the Chat surface is for those direct worker conversations.",
      "direct",
    );
    // RAG + MAG + CAG injection — so Naxie never forgets who she is, who Nature is, and what subagents do
    const naxieCtx = await buildNaxieContext(last.content, { ragLimit: 6, includeDated: true });
    const system = baseSystem + "\n\n" + naxieCtx.combinedSystemAddendum;
    const convo = trimmed.map(m => `${m.role}: ${m.content}`).join("\n");
    // RAG block also goes into the user prompt as grounding (citeable)
    const prompt = (convo ? `${convo}\n` : "") + (naxieCtx.rag ? naxieCtx.rag + "\n\n" : "") + `User: ${last.content}\nNaxie:`;
    // 1) classify complexity from the actual user intent (last turn + convo size)
    const convoTokens = Math.ceil(convo.length / 4);
    const cls = classifyNaxieComplexity(last.content, convoTokens);
    // 1b) triage: is this actually a piece of work for a role's backlog, or
    // just a turn to answer directly? (See naxie-router.ts's classifyChatIntent
    // doc comment — this is chat's counterpart to naxie.ts's /ask endpoint,
    // reachable from ordinary conversation instead of only the widget's
    // `/task ` prefix.)
    // MD audit queries must never be delegated — Naxie IS the managing
    // director, she answers system-health / dormant / useless directly from
    // the injected [MD System Audit] context in buildNaxieContext.
    const isMdQuery = /\b(md audit|system audit|managing director|system health|system update|what.*dormant|what.*useless|what.*needs.*improv|audit.*system|health.*system)\b/i.test(last.content)
      || /\b(dormant|useless|needs improv)\b/i.test(last.content) && /\b(system|feature|page|file)\b/i.test(last.content);
    const rawIntent = isMdQuery ? { action: "answer" as const, role: undefined as any, reason: "MD audit query — answer directly from system-audit context" } : classifyChatIntent(last.content, convoTokens) as any;
    const intent: any = rawIntent;
    if (!isMdQuery && intent.action === "delegate" && intent.role) {
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
        model: null,
        routing: {
          tier: "delegated",
          complexity: cls.level,
          reason: intent.reason,
          signals: cls.signals,
          online: null,
          backend: "org-task",
        },
        delegated: { taskId: task.id, role: intent.role },
      });
      return;
    }
    // 2) probe reachability (cached 45s) — real online vs just "key present"
    const online = await isCloudReachable();
    const tier = tierFor(cls.level, online);
    const complexityFlag = cls.level === "complex" ? "high" as const : "normal" as const;
    // Let the LLM router pick the right backend/model for this tier
    const result = await llmGenerateWithMeta(prompt, system, { profile: "balanced", maxTokens: cls.level === "complex" ? 900 : 500, complexity: complexityFlag });
    res.json({
      text: result.text.trim(),
      model: result.model,
      routing: {
        tier,
        complexity: cls.level,
        reason: cls.reason,
        signals: cls.signals,
        online,
        backend: result.model.includes("/") ? "openrouter" : "ollama",
      },
      sourceNoteId: naxieCtx.sourceNoteId,
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
  try {
    const pid = req.body?.personaId ? String(req.body.personaId) : undefined;
    const out = await synthesizeWithVoice(text, pid);
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
  ttsStreamTokens.set(token, { text, personaId: req.body?.personaId ? String(req.body.personaId) : undefined, createdAt: Date.now() });
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
    await synthesizeWithVoice(entry.text, entry.personaId, chunk => res.write(chunk));
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
