// Passive operator learning — distills durable facts about the operator
// out of their own chat history and files them as memory.ts facts under
// subject "operator" (the subject MAG's operator block hydrates from, see
// mag.ts's recallSubject("operator")). The goal: Naxie learns how the
// operator works WITHOUT them ever filling in a profile form — they just
// talk to it like they already do.
//
// Runs as a post-hook of the nightly reflection (same piggyback pattern as
// persona-profile.ts): one fewer timer, and it fires at most once a day.
// Watermarked: only exchanges newer than the last run are considered, so
// the same conversation is never distilled twice, and an idle day is a
// no-op (zero LLM calls).
//
// Scope discipline — this pass extracts facts about the OPERATOR
// (preferences, recurring context, decisions, how they like work
// delivered). It deliberately does NOT extract facts about other people,
// companies, or transient task state — those belong in zettels
// (zettel-extract.ts, opt-in) or per-task memory, not the operator's
// identity block.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listChatHistory } from "./chat-history.js";
import { noteFact, recallSubject } from "./memory.js";
import { listUsers } from "./users.js";
import { llmGenerate } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dirname, "../../../.naxion/operator-learning.json");

const MAX_EXCHANGES_PER_RUN = 40;     // newest-first cap on what the LLM sees
const MAX_PROMPT_CHARS = 600;         // per exchange, prompt side
const MAX_RESPONSE_CHARS = 400;       // per exchange, response side (it's the *operator* we're learning, not the output)
const MAX_FACTS_PER_RUN = 6;          // hard cap — this block lands in EVERY prompt via MAG; bloat is worse than missed facts
const MIN_PROMPT_CHARS = 12;          // skip trivial "ok"/"yes" exchanges

function operatorUserId(): string | null {
  try {
    const users = listUsers();
    // Same "oldest superadmin is the operator" rule MAG uses (mag.ts).
    const op = users.filter(u => u.role === "superadmin").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] ?? users[0];
    return op?.id ?? null;
  } catch { return null; }
}

type State = { lastAt?: string; lastId?: string };

function loadState(): State {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch { /* corrupt → reprocess from scratch */ }
  return {};
}

function saveState(s: State): void {
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
  } catch { /* best-effort — worst case the next run re-distills a few exchanges */ }
}

/**
 * Called from reflection.ts's post-reflection hook (non-fatal on failure).
 * Returns the number of facts noted, or 0 on a no-op run.
 */
export async function maybeExtractOperatorFacts(): Promise<number> {
  if (process.env.NAXION_OPERATOR_LEARNING === "0") return 0;

  const userId = operatorUserId();
  if (!userId) return 0;

  const state = loadState();
  // listChatHistory returns NEWEST first.
  const all = listChatHistory(userId, 300);
  const fresh = all
    .filter(e => e.kind !== "error")
    .filter(e => !state.lastAt || e.at > state.lastAt)
    .slice(0, MAX_EXCHANGES_PER_RUN)
    .reverse(); // chronological for the LLM
  if (fresh.length < 3) return 0; // nothing (or almost nothing) new since last run

  const transcript = fresh
    .filter(e => e.prompt.trim().length >= MIN_PROMPT_CHARS)
    .map(e => `OPERATOR: ${e.prompt.slice(0, MAX_PROMPT_CHARS).replace(/\s+/g, " ")}\nASSISTANT: ${e.response.slice(0, MAX_RESPONSE_CHARS).replace(/\s+/g, " ")}`)
    .join("\n---\n");
  if (!transcript.trim()) return 0;

  const sys = `You maintain memory facts about the operator — the human who runs this AI workforce. You will receive a transcript of their recent conversations with their AI assistant.

Extract DURABLE facts about the operator as a JSON array of short strings. Durable means: it will still be true next month and shapes how work should be done for them.

EXTRACT: stable preferences ("prefers bullet points over prose"), recurring context ("runs a variety store called Variety Vault"), standing constraints ("works in English and Portuguese"), how they like work delivered, decisions that set future direction.

DO NOT extract: one-off task details, transient state ("currently fixing the login bug"), facts about other people or companies they merely mentioned, anything from the ASSISTANT's side of the conversation, pleasantries, or anything you'd be uncomfortable inferring from a chat log.

Each fact: one sentence, standalone, present tense, no pronouns like "I" or "we" — write it as a third-person note ("the operator prefers X" is fine as just "Prefers X").

Respond with ONLY the JSON array (e.g. ["Prefers X", "Runs Y"]). If nothing durable was said, respond with [].`;

  let text: string;
  try {
    text = await llmGenerate(`Recent conversation transcript:\n\n${transcript.slice(0, 12000)}`, sys, { profile: "synthesis", complexity: "normal" });
  } catch (e: any) {
    console.warn(`[operator-learning] LLM call failed: ${e?.message ?? e}`);
    return 0; // don't advance the watermark — retry next run
  }

  // Parse defensively — the model sometimes wraps JSON in backticks or
  // adds a sentence despite instructions.
  let facts: string[] = [];
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (Array.isArray(parsed)) facts = parsed.map(f => String(f).trim()).filter(f => f.length > 0 && f.length <= 300);
    }
  } catch { /* unparseable → treat as no facts */ }

  // Dedupe against what's already stored — the LLM doesn't see existing
  // facts, so re-stated preferences would otherwise pile up (memory.ts
  // appends unconditionally).
  let noted = 0;
  try {
    const existing = new Set(recallSubject("operator", 100).map(f => f.fact.toLowerCase()));
    for (const fact of facts.slice(0, MAX_FACTS_PER_RUN)) {
      if (existing.has(fact.toLowerCase())) continue;
      noteFact({ subject: "operator", fact, source: "chat-learning" });
      noted++;
    }
  } catch (e: any) {
    console.warn(`[operator-learning] noteFact failed: ${e?.message ?? e}`);
  }

  // Advance the watermark past the newest exchange we considered — even
  // when zero facts were noted (an exchange with nothing durable in it
  // should never be re-examined).
  const newest = fresh[fresh.length - 1];
  saveState({ lastAt: newest?.at ?? state.lastAt, lastId: newest?.id ?? state.lastId });

  if (noted > 0) console.log(`[operator-learning] noted ${noted} operator fact(s) from ${fresh.length} recent exchanges`);
  return noted;
}
