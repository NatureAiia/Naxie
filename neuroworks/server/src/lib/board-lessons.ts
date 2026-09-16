// Board Meeting — Feature C: standing-rule corrections, scoped ONLY to
// board-meeting council behavior (deliberately NOT merged into
// persona-profile.ts). Two reasons:
//   - persona-profile.ts regenerates by wholesale LLM rewrite on a >=3-day
//     cadence tied to reflection.ts — a correction filed today could be
//     silently dropped/reworded on the next regen.
//   - readPersonaProfileSuffix() feeds EVERY task that persona ever runs
//     (regular chat, templates, hand-offs); a board-specific correction
//     ("be more skeptical of vendor claims when you're on the board")
//     shouldn't bleed into that persona's day-job work by default.
// Storage here is simple append + cap (no LLM-rewrite), so a recorded rule
// is never silently lost the way a persona-profile.ts regen could lose one.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { llmGenerateWithMeta } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LESSONS_DIR = resolve(__dirname, "../../../.neuroworks/board-lessons");

// Reserved bucket for Naxie's CHAIRMAN hat — deliberately distinct from
// personas.ts's real "naxie" id, so chairman-only lessons never leak into
// naxie.md's PA profile or any other Naxie-as-PA context.
export const CHAIRMAN_BUCKET = "__chairman";
export type LessonBucket = string; // a personaId, or CHAIRMAN_BUCKET

const MAX_RULES = 20;

function bucketFile(bucket: LessonBucket): string {
  const safe = bucket.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(LESSONS_DIR, `${safe}.md`);
}

function readRules(bucket: LessonBucket): string[] {
  const p = bucketFile(bucket);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf8").split(/\r?\n/);
    return lines.filter(l => l.startsWith("- ")).map(l => l.slice(2).trim());
  } catch { return []; }
}

// Sync-safe, "" on any failure/missing file — safe to call unconditionally
// from councilVoiceSystemPrompt()/naxieChairmanSystemPrompt() on every stage.
export function readBoardLessonSuffix(bucket: LessonBucket): string {
  const rules = readRules(bucket);
  if (rules.length === 0) return "";
  return "STANDING RULES FROM PAST BOARD MEETINGS — apply every one of these, every time, without being asked:\n" +
    rules.map(r => `- ${r}`).join("\n");
}

export async function recordBoardCorrection(bucket: LessonBucket, ruleText: string): Promise<void> {
  const clean = ruleText.trim();
  if (!clean) return;
  mkdirSync(LESSONS_DIR, { recursive: true });
  const rules = readRules(bucket);
  rules.push(clean);
  const capped = rules.slice(-MAX_RULES);
  const p = bucketFile(bucket);
  const body = `---\ntype: board-lesson\nbucket: ${bucket}\nupdatedAt: ${new Date().toISOString()}\nrulesCount: ${capped.length}\n---\n\n## Standing rules\n\n${capped.map(r => `- ${r}`).join("\n")}\n`;
  writeFileSync(p, body);
}

export async function classifyCorrection(opts: {
  topic: string; targetLabel: string; originalText: string; note: string;
}): Promise<{ classification: "one-off" | "standing-rule"; ruleText?: string; rationale: string }> {
  const system = "You sort an owner's correction on an AI board-meeting participant's answer. Return ONLY a JSON object, no prose, no code fences.";
  const user = `Board meeting topic: ${opts.topic}\n${opts.targetLabel}'s answer:\n${opts.originalText.slice(0, 1500)}\n\nOwner's correction: "${opts.note}"\n\n` +
    "Is this a ONE-OFF (about this meeting/topic only) or a STANDING RULE (a preference the owner will want applied to every future board meeting this participant sits on)?\n" +
    "Signals of a standing rule: \"always\", \"never\", \"from now on\", a tone/format preference, a red line. Signals of a one-off: a fact about this specific topic, a change to this answer only, \"this time\".\n" +
    "Return: {\"standing\": true|false, \"rule\": \"<if standing: the preference as ONE short imperative sentence, general, no topic-specific names; else empty string>\", \"rationale\": \"<one short sentence>\"}";
  try {
    const { text } = await llmGenerateWithMeta(user, system, { maxTokens: 250 });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no JSON in response");
    const j = JSON.parse(m[0]);
    const standing = !!j.standing && !!String(j.rule ?? "").trim();
    return {
      classification: standing ? "standing-rule" : "one-off",
      ruleText: standing ? String(j.rule).trim().slice(0, 300) : undefined,
      rationale: String(j.rationale ?? "").trim().slice(0, 200),
    };
  } catch (e: any) {
    // Fail safe to one-off — never silently invent a standing rule the
    // operator didn't clearly ask for.
    return { classification: "one-off", rationale: `classification unavailable: ${String(e?.message ?? e).slice(0, 100)}` };
  }
}
