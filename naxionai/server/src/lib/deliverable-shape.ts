// Summary, the whole thing, or the file itself?
//
// Ported from AI-Institute-Africa/neuroworks. Nothing in the system asked this
// question before — a "summarize" verb at the START of a message triggered
// summary mode, everything else fell to a compressed 80-250-word default with
// no shape hint at all. So "give me all the interested candidates' CVs from
// my email" — a request for FILES — came back as a research summary. The
// recurring operator complaint is "give me the consolidated doc not a
// summary".
//
// Imported by format-check.ts (to catch a summary that came back anyway) and
// usable by the chat route (to shape the deliverable / ask when genuinely
// ambiguous) — the planner and the grader must never disagree about what
// kind of thing was asked for.

/**
 * - `artifact` — the deliverable is bytes: send the file.
 * - `full`     — the deliverable is the whole text, uncompressed.
 * - `summary`  — the deliverable is a précis.
 * - undefined  — not stated; the caller decides whether to ask.
 */
export type Fidelity = "artifact" | "full" | "summary" | undefined;

/** Nouns that name a thing with bytes rather than a topic. */
const FILE_NOUN = /\b(cvs?|resumes?|attachments?|pdfs?|docx?|documents?|files?|invoices?|letters?|reports?|spreadsheets?|decks?|slides?|photos?|images?|scans?|recordings?|videos?)\b/i;

/** Asking for it to arrive somewhere, not to be described. */
const DELIVER_VERB = /\b(send|forward|share|attach|deliver|upload|post|drop|email|telegram|whatsapp)\b/i;

const FULL_MARKER = /\b(?:in\s+full|full\s+(?:document|doc|text|version|report)|entire|complete\s+(?:document|doc|text)|whole\s+(?:document|doc|thing|text)|verbatim|word[\s-]for[\s-]word|unabridged|as[\s-]is|consolidated\s+doc(?:ument)?|original\s+(?:document|text)|(?:don'?t|do\s+not|no|not\s+a)\s+summar(?:y|ise|ize))\b/i;

const SUMMARY_MARKER = /\b(?:summari[sz]e|summary|tl;?dr|recap|brief\s+me|gist|key\s+points|highlights|in\s+a\s+nutshell)\b/i;

/**
 * What shape did they ask for?
 *
 * Order matters. `artifact` outranks `full` (a request to SEND the document
 * is not satisfied by pasting its text), and `full` outranks `summary` so
 * "summarise the whole thing, don't compress it" resolves the way it reads.
 */
export function detectFidelity(task: string): Fidelity {
  const t = String(task ?? "");
  if (!t.trim()) return undefined;
  if (DELIVER_VERB.test(t) && FILE_NOUN.test(t)) return "artifact";
  if (FULL_MARKER.test(t)) return "full";
  if (SUMMARY_MARKER.test(t)) return "summary";
  return undefined;
}

/** The `Deliverable shape:` block for a fidelity. */
export function fidelityShapeHint(f: Fidelity): string | undefined {
  if (f === "artifact") {
    return "The deliverable is the FILE ITSELF, sent by the plan's delivery step. Your written answer is a one-line confirmation naming each file that went out and where it went. Do NOT paste, transcribe or summarise the contents — the user has the file.";
  }
  if (f === "full") {
    return "Reproduce the material IN FULL. No compression, no word limit, no \"Bottom line:\" opener, no bullet digest. Keep the original headings, ordering and wording. If the result is longer than a normal answer, that is correct — the user asked for the whole thing.";
  }
  return undefined;
}

/**
 * Should we ask which one they meant?
 *
 * Deliberately narrow — a gate people learn to ignore is worse than no gate.
 * Fires only when a file-shaped noun appears, nothing settles the fidelity,
 * AND no delivery channel is named ("send them here" names a channel, so it
 * must NOT prompt).
 */
export function isShapeAmbiguous(task: string): boolean {
  const t = String(task ?? "");
  if (!t.trim()) return false;
  if (detectFidelity(t) !== undefined) return false;
  if (!FILE_NOUN.test(t)) return false;
  if (/\b(?:telegram|whatsapp|email|here|this\s+chat)\b/i.test(t)) return false;
  return true;
}

/** The one question to ask when it is genuinely ambiguous. */
export const SHAPE_QUESTION =
  "Do you want the document itself, or a write-up of what's in it? Reply **file** for the document, **summary** for the write-up.";
