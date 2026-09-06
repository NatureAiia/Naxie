// Board Meeting — an LLM council (github.com/karpathy/llm-council), built on
// personas already in the system: no new model/provider keys, just distinct
// system-prompt "voices" on the same underlying LLM, exactly like /api/team.
//
// Three stages, run inside a normal job so it shows in Activity like a
// hand-off relay does:
//   1. Opinions — every council member answers the topic independently, in
//      parallel.
//   2. Review — every member re-reads the FULL set of opinions, ANONYMIZED
//      (shuffled "Member A/B/C" labels) so nobody can play favorites toward
//      their own or a known peer's answer, and ranks them on accuracy and
//      insight.
//   3. Final response — Naxie, as chairman, reads every real (de-anonymized)
//      opinion plus every ranking and compiles one final answer for the user.
//
// Deliberately NOT using personaSystemSuffix() here: that helper prepends the
// LANE_DISCIPLINE_PREAMBLE, which trains a persona to refuse work outside its
// job function (e.g. QA refusing a product-strategy question). A council
// needs every member's genuine opinion on the SAME topic regardless of lane —
// so members are framed as board members giving their professional
// perspective, not employees being handed a deliverable to execute.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadPersonas, type Persona } from "./personas.js";
import { llmGenerateWithMeta } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.neuroworks");
const FILE = join(STATE_DIR, "board-meetings.json");
const MAX_RUNS = 50;

export const DEFAULT_COUNCIL = ["researcher", "knowitall", "product-manager", "qa-engineer", "data-analyst"];
export const MIN_MEMBERS = 3;
const MAX_MEMBERS = 8;

export type BoardMember = { personaId: string; name: string; role: string };
export type BoardOpinion = {
  personaId: string;
  name: string;
  role: string;
  label: string; // anonymized "Member A" etc, assigned for the review stage
  text: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  error?: string;
};
export type BoardRanking = {
  personaId: string;
  name: string;
  label: string;
  rankingText: string; // free text — ranked order + rationale, not force-parsed
  error?: string;
};
export type BoardRunStatus = "running" | "completed" | "failed";
export type BoardRun = {
  id: string;
  topic: string;
  roster: BoardMember[];
  status: BoardRunStatus;
  opinions: BoardOpinion[];
  rankings: BoardRanking[];
  chairmanSynthesis: string;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
};

// ─── persistence (in-memory authoritative, mirrored to disk) ───
const runs = new Map<string, BoardRun>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, "utf8"));
      if (Array.isArray(parsed)) {
        let recovered = false;
        for (const r of parsed as BoardRun[]) {
          // A run persisted as "running" belonged to a process that's since
          // exited (restart/crash) — nothing is actually still working on
          // it, so close it out instead of leaving the UI spinning forever.
          if (r.status === "running") {
            r.status = "failed";
            r.chairmanSynthesis = r.chairmanSynthesis || "Interrupted by a server restart before the meeting finished.";
            recovered = true;
          }
          runs.set(r.id, r);
        }
        if (recovered) persist();
      }
    }
  } catch { /* start empty */ }
}

function persist(): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    const recent = [...runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_RUNS);
    if (recent.length < runs.size) {
      const keep = new Set(recent.map(r => r.id));
      for (const id of [...runs.keys()]) if (!keep.has(id)) runs.delete(id);
    }
    writeFileSync(FILE, JSON.stringify(recent, null, 2), "utf8");
  } catch { /* best-effort */ }
}

export function getBoardRun(id: string): BoardRun | undefined { load(); return runs.get(id); }
export function listBoardRuns(): BoardRun[] {
  load();
  return [...runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ─── roster resolution ───
function resolvePersona(id: string): Persona | null {
  try { return loadPersonas().personas.find(p => p.id === id) ?? null; }
  catch { return null; }
}

function buildRoster(personaIds?: string[]): BoardMember[] {
  const ids = (personaIds && personaIds.length > 0 ? personaIds : DEFAULT_COUNCIL).slice(0, MAX_MEMBERS);
  const roster: BoardMember[] = [];
  for (const id of ids) {
    const p = resolvePersona(id);
    if (!p) continue;
    roster.push({ personaId: p.id, name: p.name, role: p.role });
  }
  return roster;
}

// A light, non-lane-policed voice: reuse the persona's identity/expertise/tone
// so members sound distinct, but frame this as an opinion in a brainstorm —
// not a deliverable that must stay inside the persona's job lane.
function councilVoiceSystemPrompt(p: Persona): string {
  return [
    `You are ${p.name}, the ${p.role}. ${p.description || ""}`.trim(),
    p.tone ? `Voice: ${p.tone}.` : "",
    "You are one member of a board / brainstorming council convened to discuss a topic. Give your own honest, independent opinion or analysis, drawing on your professional background and the lens your role gives you — even if the topic isn't strictly your day job. This is a discussion, not a work order: don't refuse or redirect to another specialist, just weigh in as yourself.",
    "Be direct and substantive. A few tight paragraphs beats a hedge-everything essay.",
  ].filter(Boolean).join("\n");
}

// Naxie as chairman: borrow the identity/voice, but skip
// BUILTIN_NAXIE_PERSONA's tool-triage instructions verbatim (calendar.*,
// memory.*, hand off to a specialist, etc.) — none of that applies to a
// pure-text synthesis call with no tool loop. This is Naxie's chairman hat,
// not Naxie's PA hat.
function naxieChairmanSystemPrompt(): string {
  return [
    "You are Naxie, chairing this board meeting. You are not one of the council members — you convened them, and now it's your job to weigh what they said and give the user one clear, final answer.",
    "Voice: warm but decisive, concise, next-step-first — the same Naxie the user talks to everywhere else, now speaking as chairman.",
    "Synthesize, don't summarize: don't just recap each member in turn. Form your own judgement, favor points multiple members converged on or that ranked well in their peer review, and be willing to disagree with the majority if the reasoning doesn't hold up. Flag real, unresolved disagreement rather than papering over it.",
  ].join("\n");
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export type BoardStartOpts = { topic: string; personaIds?: string[]; jobId?: string };

// Create + register a run synchronously (no LLM work yet). Lets a route
// return the runId immediately, then drive execution in the background.
export function createBoardRun(opts: BoardStartOpts): BoardRun {
  load();
  const now = () => new Date().toISOString();
  const run: BoardRun = {
    id: randomUUID(),
    topic: String(opts.topic ?? "").trim(),
    roster: buildRoster(opts.personaIds),
    status: "running",
    opinions: [],
    rankings: [],
    chairmanSynthesis: "",
    jobId: opts.jobId,
    createdAt: now(),
    updatedAt: now(),
  };
  runs.set(run.id, run);
  persist();
  return run;
}

// Mark a run failed without running it (e.g. it failed validation right
// after creation) so it doesn't sit stuck as "running" in storage.
export function failBoardRun(run: BoardRun, reason: string): BoardRun {
  run.status = "failed";
  run.chairmanSynthesis = reason;
  run.updatedAt = new Date().toISOString();
  persist();
  return run;
}

// Drive a previously-created run through all three stages. `push` is the
// job's logger so progress shows in Activity.
export async function executeBoardRun(run: BoardRun, push: (msg: string) => void = () => {}): Promise<BoardRun> {
  load();
  const now = () => new Date().toISOString();

  if (!run.topic) { run.status = "failed"; run.chairmanSynthesis = "No topic provided."; run.updatedAt = now(); persist(); return run; }
  if (run.roster.length < MIN_MEMBERS) { run.status = "failed"; run.chairmanSynthesis = `Need at least ${MIN_MEMBERS} valid council members.`; run.updatedAt = now(); persist(); return run; }

  try {
    // ─── Stage 1: opinions, in parallel ───
    push(`Convening the board on: ${run.topic.slice(0, 120)}`);
    const opinions = await Promise.all(run.roster.map(async (m): Promise<BoardOpinion> => {
      const persona = resolvePersona(m.personaId);
      const startedAt = now();
      const opinion: BoardOpinion = { personaId: m.personaId, name: m.name, role: m.role, label: "", text: "", startedAt };
      try {
        const t0 = Date.now();
        const { text } = await llmGenerateWithMeta(
          run.topic,
          persona ? councilVoiceSystemPrompt(persona) : undefined,
          { profile: "planning" },
        );
        opinion.text = text.trim();
        opinion.elapsedMs = Date.now() - t0;
      } catch (e: any) {
        opinion.error = String(e?.message ?? e).slice(0, 200);
        opinion.text = "";
      }
      opinion.endedAt = now();
      return opinion;
    }));
    run.opinions = opinions;
    run.updatedAt = now();
    persist();
    push(`Stage 1 done — ${opinions.filter(o => o.text).length}/${opinions.length} member(s) answered.`);

    // ─── Stage 2: anonymize + peer review/ranking, in parallel ───
    const withOpinions = opinions.filter(o => o.text);
    const shuffled = shuffle(withOpinions);
    const labels = shuffled.map((_, i) => `Member ${String.fromCharCode(65 + i)}`); // Member A, B, C…
    shuffled.forEach((o, i) => { o.label = labels[i]; });
    // Keep unlabeled opinions (failed calls) out of the anonymized set but
    // still present in run.opinions for the UI.
    for (const o of opinions) if (!o.label) o.label = "(no answer)";

    const anonymizedBlock = shuffled.map(o => `--- ${o.label} ---\n${o.text.slice(0, 3000)}`).join("\n\n");
    const reviewPrompt = [
      `TOPIC: ${run.topic}`,
      "",
      "Below are every council member's independent opinions, anonymized (you are NOT told which one, if any, is yours):",
      "",
      anonymizedBlock,
      "",
      "Rank ALL of the above from best to worst on ACCURACY and INSIGHT. For each, give its label and a one-line reason. Be honest and critical — this is a private review, not shown to the other members.",
    ].join("\n");

    const rankings = await Promise.all(run.roster.map(async (m): Promise<BoardRanking> => {
      const persona = resolvePersona(m.personaId);
      const ranking: BoardRanking = { personaId: m.personaId, name: m.name, label: "", rankingText: "" };
      const mine = shuffled.find(o => o.personaId === m.personaId);
      ranking.label = mine?.label ?? "(no answer)";
      try {
        const { text } = await llmGenerateWithMeta(
          reviewPrompt,
          persona ? councilVoiceSystemPrompt(persona) : undefined,
          { profile: "planning", maxTokens: 700 },
        );
        ranking.rankingText = text.trim();
      } catch (e: any) {
        ranking.error = String(e?.message ?? e).slice(0, 200);
      }
      return ranking;
    }));
    run.rankings = rankings;
    run.updatedAt = now();
    persist();
    push(`Stage 2 done — ${rankings.filter(r => r.rankingText).length}/${rankings.length} member(s) reviewed the anonymized set.`);

    // ─── Stage 3: chairman synthesis (Naxie), de-anonymized ───
    const opinionsBlock = opinions.filter(o => o.text)
      .map(o => `--- ${o.name} (${o.role}) ---\n${o.text.slice(0, 3000)}`).join("\n\n");
    const rankingsBlock = rankings.filter(r => r.rankingText)
      .map(r => `--- ${r.name}'s ranking (their own answer was ${r.label}) ---\n${r.rankingText.slice(0, 1500)}`).join("\n\n");
    const chairmanPrompt = [
      `TOPIC put to the board: ${run.topic}`,
      "",
      "Each council member's independent opinion:",
      opinionsBlock || "(no opinions collected)",
      "",
      "Each member's ranking of the anonymized set, for accuracy and insight:",
      rankingsBlock || "(no rankings collected)",
      "",
      "As chairman of this board, weigh all of the above — favor points multiple members converged on or that ranked well — and compile ONE final, decisive answer to the topic for the user. Don't just summarize each opinion in turn; synthesize a single coherent recommendation, and note any real disagreement worth flagging.",
    ].join("\n");

    const { text: synthesis } = await llmGenerateWithMeta(
      chairmanPrompt,
      naxieChairmanSystemPrompt(),
      { profile: "synthesis", complexity: "high" },
    );
    run.chairmanSynthesis = synthesis.trim();
    run.status = "completed";
    run.updatedAt = now();
    persist();
    push("Naxie has compiled the board's final response.");
  } catch (e: any) {
    run.status = "failed";
    run.chairmanSynthesis = run.chairmanSynthesis || `Board meeting failed: ${String(e?.message ?? e).slice(0, 200)}`;
    run.updatedAt = now();
    persist();
    push(`Board meeting failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  return run;
}
