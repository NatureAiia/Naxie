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
import { voiceStatus, voiceForPersona, synthesizeLocal, synthesizeWithVoice, synthesizeElevenLabs, elevenLabsVoiceForPersona, mintRealtimeSession } from "../lib/voice.js";
import { loadJobById } from "../lib/job-store.js";
import { getJob } from "../lib/jobs.js";

export const voiceRouter = Router();

voiceRouter.get("/status", async (_req, res) => {
  try { res.json(await voiceStatus()); }
  catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
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
  try {
    const { llmGenerateWithMeta } = await import("../lib/llm.js");
    const { injectLanguagePrompt } = await import("../lib/language-prompts.js");
    const { classifyNaxieComplexity, tierFor } = await import("../lib/naxie-router.js");
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
    const naxieCtx = buildNaxieContext(last.content, { ragLimit: 6, includeDated: true });
    const system = baseSystem + "\n\n" + naxieCtx.combinedSystemAddendum;
    const convo = trimmed.map(m => `${m.role}: ${m.content}`).join("\n");
    // RAG block also goes into the user prompt as grounding (citeable)
    const prompt = (convo ? `${convo}\n` : "") + (naxieCtx.rag ? naxieCtx.rag + "\n\n" : "") + `User: ${last.content}\nNaxie:`;
    // 1) classify complexity from the actual user intent (last turn + convo size)
    const convoTokens = Math.ceil(convo.length / 4);
    const cls = classifyNaxieComplexity(last.content, convoTokens);
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
  // Persona-aware: naxie -> T1LJmO1i3U7y9K38NWAy, chat/read-aloud -> qBDvhofpxp92JgXJxDjB, others default.
  // Prefers ElevenLabs cloud (your second-in-command voice), falls back to local sidecar.
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

voiceRouter.post("/realtime-session", async (req, res) => {
  const jobId = String(req.body?.jobId ?? "").trim();
  if (!jobId) return res.status(400).json({ error: "jobId is required" });
  try {
    const ctx = await reportContext(jobId, req.body?.personaId ? String(req.body.personaId) : undefined);
    const v = voiceForPersona(ctx.personaKey);
    const instructions =
      `You are ${ctx.personaName}, the employee who produced the report below. You're on a live voice call with a colleague to talk it through. ` +
      `Open by greeting them in one short sentence and offering the headline finding. Keep answers conversational and short (a few sentences), let them interrupt, ` +
      `and stay grounded in the report — if something isn't covered, say so honestly. Numbers and names must match the report exactly.\n\n` +
      `${ctx.personaSuffix ? ctx.personaSuffix + "\n\n" : ""}` +
      `REPORT — "${ctx.title}":\n---\n${ctx.report}\n---`;
    const sess = await mintRealtimeSession(instructions, v.openaiVoice);
    res.json({ ...sess, personaName: ctx.personaName });
  } catch (e: any) {
    res.status(502).json({ error: String(e?.message ?? e) });
  }
});
