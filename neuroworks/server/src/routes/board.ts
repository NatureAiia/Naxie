// Board Meeting routes — an LLM council (github.com/karpathy/llm-council).
//
// POST /api/board          start a meeting { topic, personaIds? } → { runId, jobId } (runs async in a job)
// GET  /api/board          list recent meetings (newest first)
// GET  /api/board/:id      one meeting: opinions, rankings, chairman synthesis
//
// The meeting itself lives in lib/board.ts. The route wraps it in a job so it
// also appears in Activity/Reports, and returns immediately so the page can
// poll the structured run as the three stages complete.

import { Router } from "express";
import { newJob, runJob } from "../lib/jobs.js";
import { createBoardRun, executeBoardRun, listBoardRuns, getBoardRun, failBoardRun, correctBoardOpinion, correctBoardSynthesis, MIN_MEMBERS } from "../lib/board.js";

export const boardRouter = Router();

boardRouter.get("/", (_req, res) => {
  res.json({ runs: listBoardRuns() });
});

boardRouter.get("/:id", (req, res) => {
  const run = getBoardRun(String(req.params.id));
  if (!run) return res.status(404).json({ error: "board meeting not found" });
  res.json({ run });
});

boardRouter.post("/", (req, res) => {
  try {
    const topic = String(req.body?.topic ?? "").trim();
    const personaIds: string[] | undefined = Array.isArray(req.body?.personaIds)
      ? req.body.personaIds.filter((id: any) => typeof id === "string")
      : undefined;

    if (!topic) return res.status(400).json({ error: "topic required" });

    const job = newJob("insights:board-meeting");
    job.title = `Board meeting: ${topic.slice(0, 60)}`;
    job.inputs = { topic, memberCount: personaIds?.length };

    // Create the structured run synchronously so we can return its id at once.
    const run = createBoardRun({ topic, personaIds, jobId: job.id });
    if (run.roster.length < MIN_MEMBERS) {
      failBoardRun(run, `need at least ${MIN_MEMBERS} valid council members`);
      return res.status(400).json({ error: `need at least ${MIN_MEMBERS} valid council members` });
    }

    // Drive execution in the background inside the job (shows in Activity).
    void runJob(job, async (push, progress) => {
      const finished = await executeBoardRun(run, push);
      progress({ boardRunId: finished.id, status: finished.status });
      return {
        kind: "board-meeting",
        boardRunId: finished.id,
        status: finished.status,
        answer: finished.chairmanSynthesis,
      };
    });

    res.json({ runId: run.id, jobId: job.id, roster: run.roster });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Feature C — a correction on a completed meeting. Omit targetPersonaId to
// correct the chairman synthesis instead of a specific member's opinion.
// Kept synchronous (one bounded LLM call, not a fan-out) — no job/poll
// plumbing needed the way feedback.ts's /retry has for a full task re-run.
boardRouter.post("/:id/correct", async (req, res) => {
  try {
    const run = getBoardRun(String(req.params.id));
    if (!run) return res.status(404).json({ error: "board meeting not found" });
    if (run.status === "running") return res.status(400).json({ error: "this meeting is still running" });

    const note = String(req.body?.note ?? "").trim();
    if (!note) return res.status(400).json({ error: "note required" });
    if (note.length > 2000) return res.status(400).json({ error: "note is too long (max 2000 characters)" });

    const targetPersonaId = typeof req.body?.targetPersonaId === "string" ? req.body.targetPersonaId.trim() : "";
    if (targetPersonaId) {
      if (!run.opinions.some(o => o.personaId === targetPersonaId)) {
        return res.status(400).json({ error: "no opinion from that persona in this meeting" });
      }
      const updated = await correctBoardOpinion(run, targetPersonaId, note);
      return res.json({ run: updated });
    }
    const updated = await correctBoardSynthesis(run, note);
    res.json({ run: updated });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
