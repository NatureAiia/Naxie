// Did the answer claim an action that never ran?
//
// Ported from AI-Institute-Africa/neuroworks. Origin incident: a Telegram DM
// asked "Send me Natasha's CV from my email" — the plan was research.deep +
// checkers, no mailbox step, no send step. The answer still read "Files
// Delivered: natasha_cv.pdf ... successfully delivered via Telegram", every
// detail invented, and the job was recorded as SUCCEEDED. Prompts already
// tell the synth not to do this in several places; the fix that holds is
// arithmetic, not persuasion — an outward action either has a successful
// step behind it or the claim comes out.
//
// Bias: FALSE NEGATIVES over false positives. Every rule needs an unambiguous
// past-tense claim about an outward action, so a plan PROPOSING a send, an
// answer QUOTING the request, or a draft written for the operator to send by
// hand all pass untouched (see withoutQuotedDraft / NOT_A_CLAIM below).
//
// Tool names below are Naxie's own (primitives.ts) — Naxie has no separate
// "telegram.send_file"; only telegram.send exists, so the Telegram-file rule
// targets that instead.

export type ClaimRun = { step?: { tool?: string }; tool?: string; ok?: boolean };

export type ActionClaim = {
  /** Operator-readable: what the answer said happened. */
  claim: string;
  /** Any one of these steps, run successfully, would support it. */
  tools: string[];
};

// NOT YET DONE IS NOT DONE. An infinitive or modal immediately before the
// verb means it has not happened ("ready TO BE sent" is a draft, not a claim).
const NOT_YET = String.raw`(?<!\bto\s)(?<!\bbe\s)(?<!\bwill\s)(?<!\bshall\s)(?<!\bshould\s)(?<!\bmust\s)(?<!\bcan\s)(?<!\bcould\s)(?<!\bwould\s)(?<!\bmay\s)(?<!\bbeing\s)(?<!\bnot\s)(?<!\bnot been\s)(?<!\bnever been\s)(?<!\byet to be\s)(?<!\babout to be\s)`;

const RULES: { what: string; tools: string[]; re: RegExp }[] = [
  {
    what: "a file was delivered on Telegram",
    tools: ["telegram.send"],
    re: /\btelegram[.\s_]?send(?:_file)?\b|\b(?:deliver|sent|send)\w*\b[^.\n]{0,60}\b(?:via|on|over|through|to)\s+telegram\b|\btelegram\b[^.\n]{0,40}\b(?:file|document|attachment|pdf|cv|photo)\w*\b[^.\n]{0,30}\b(?:deliver|sent)\w*/i,
  },
  {
    what: "a message was sent on Telegram",
    tools: ["telegram.send"],
    re: /\b(?:message|notification|reply|post|update)\b[^.\n]{0,40}\b(?:sent|posted|delivered)\b[^.\n]{0,30}\btelegram\b|\btelegram[.\s_]?send\b/i,
  },
  {
    what: "an email was sent",
    tools: ["email.send"],
    // The third alternative matters most in practice: "The report has been
    // sent to jane@acme.com" names neither the word "email" nor the tool.
    re: new RegExp(
      String.raw`\b(?:e-?mail(?:ed)?|message)\b[^.\n]{0,50}\b(?:has been |was |been |successfully )?` + NOT_YET + String.raw`(?:sent|delivered|dispatched)\b`
      + String.raw`|\b` + NOT_YET + String.raw`(?:sent|delivered)\b[^.\n]{0,30}\b(?:by|via|over)\s+e-?mail\b`
      + String.raw`|\b` + NOT_YET + String.raw`(?:sent|delivered|e-?mailed|dispatched|forwarded)\b[^.\n]{0,40}\bto\s+[\w.+-]+@[\w-]+\.[\w.-]+`
      + String.raw`|\b(?:i|we)\s+(?:have\s+)?(?:e-?mailed|sent)\b[^.\n]{0,40}\b(?:report|file|document|message|email|note|invoice|draft|it|them)\b`
      + String.raw`|\bemail[.\s]?send\b`,
      "i",
    ),
  },
  {
    what: "a file was attached to an email",
    tools: ["email.send"],
    re: /\b(?:attached|attachment)\b[^.\n]{0,40}\b(?:sent|delivered|included in the email)\b|\b(?:sent|delivered)\b[^.\n]{0,40}\bas an attachment\b/i,
  },
  {
    what: "something was posted to social media",
    tools: ["buffer.post", "social.post"],
    re: /\b(?:posted|published|scheduled)\b[^.\n]{0,40}\b(?:to|on)\s+(?:buffer|linkedin|twitter|x|tiktok|instagram|facebook)\b|\bbuffer[.\s]?post\b/i,
  },
  {
    what: "a message was sent on WhatsApp",
    tools: ["whatsapp.send", "whatsapp.broadcast"],
    re: /\bwhatsapp[.\s_]?(?:send|broadcast)\b|\b(?:sent|delivered|posted)\b[^.\n]{0,40}\b(?:via|on|over|to)\s+whatsapp\b/i,
  },
];

/**
 * Phrasing that mentions a send WITHOUT claiming one happened. Checked per
 * matching sentence, not per answer: an answer may legitimately say "I could
 * not send it" in one sentence and describe real work in the next.
 */
const NOT_A_CLAIM =
  /\b(?:could\s+not|couldn'?t|cannot|can'?t|was\s+not|wasn'?t|were\s+not|weren'?t|not\s+(?:yet\s+)?(?:sent|delivered|posted)|no(?:thing)?\s+(?:file|document|attachment|message)s?\s+(?:were|was)\s+sent|none\s+sent|failed\s+to|unable\s+to|will\s+(?:be\s+)?(?:send|sent|deliver|delivered)|would\s+(?:send|deliver)|to\s+send|ready\s+to\s+send|so\s+you\s+can\s+send|if\s+you\s+want|say\s+the\s+word|shall\s+i|want\s+me\s+to|next\s+step|pending|awaiting|requires?\s+approval|approval\s+(?:is\s+)?(?:needed|required)|draft(?:ed)?\s+for\s+(?:your\s+)?review)\b/i;

/** Split into sentences generously — bullets and headings count as sentences. */
function sentences(answer: string): string[] {
  return answer
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function ranOk(runs: ClaimRun[], tools: string[]): boolean {
  return runs.some(r => {
    const tool = r.step?.tool ?? r.tool;
    return !!tool && tools.includes(tool) && r.ok !== false;
  });
}

/**
 * A QUOTED DRAFT IS NOT A REPORT ABOUT THIS RUN.
 *
 * A "## Message"-style section holds a letter for a person to send. Letters
 * refer to the past ("we sent the invoice on the 10th") without that being a
 * claim about what THIS run did. Only a HEADING counts — a passing mention of
 * the word "message" in prose must not blank the check for everything after.
 */
function withoutQuotedDraft(answer: string): string {
  const m = answer.match(/(^|\n)#{1,6}\s*(?:message|draft|proposed (?:message|email)|email to send)\s*(?:\n|$)/i);
  return m && m.index !== undefined ? answer.slice(0, m.index) : answer;
}

/**
 * Claims of outward action in `answer` that no successful step in `runs`
 * supports. Empty array = nothing to correct (including "no claims found").
 */
export function unsupportedActionClaims(answer: string, runs: ClaimRun[]): ActionClaim[] {
  const text = withoutQuotedDraft(String(answer ?? ""));
  if (!text.trim()) return [];
  const found: ActionClaim[] = [];
  const lines = sentences(text);
  for (const rule of RULES) {
    if (ranOk(runs, rule.tools)) continue;
    const asserted = lines.some(l => rule.re.test(l) && !NOT_A_CLAIM.test(l));
    if (asserted) found.push({ claim: rule.what, tools: rule.tools });
  }
  return found;
}

/**
 * The answer to surface INSTEAD of one that claims work nobody did. Not a
 * banner over the fabrication — an unverifiable claim gets withheld, not
 * footnoted, because a correction above a confident paragraph loses to the
 * paragraph. The operator gets the request back, what actually ran, and the
 * one thing they can do about it.
 */
export function honestNonDelivery(opts: { task: string; claims: ActionClaim[]; runs: ClaimRun[] }): string {
  const tools = [...new Set(opts.runs.map(r => r.step?.tool ?? r.tool).filter(Boolean))] as string[];
  const claimed = opts.claims.map(c => c.claim).join("; ");
  const needed = [...new Set(opts.claims.flatMap(c => c.tools))];
  // Planned-and-failed is a different story from never-planned, and the
  // operator needs to know which: one is a broken transport, the other a
  // broken plan.
  const attempted = opts.runs.filter(r => {
    const tool = r.step?.tool ?? r.tool;
    return !!tool && needed.includes(tool);
  });
  return [
    `**Nothing was sent — and the draft answer said otherwise, so it has been withheld.**`,
    ``,
    `You asked: "${opts.task.replace(/\s+/g, " ").trim().slice(0, 300)}"`,
    ``,
    `The draft reported ${claimed || "an action"}. Nothing in this run did that.`,
    tools.length ? `What actually ran: ${tools.join(", ")}.` : `No tools ran at all.`,
    ``,
    attempted.length
      ? `The delivery step (${needed.join(" / ")}) ran and FAILED, so there is nothing to confirm. Worth retrying — the transport, not the plan, is what broke.`
      : `The delivery step (${needed.join(" / ") || "the send tool"}) was never planned, so there is nothing to confirm.`,
    `Ask again and it will be planned and executed, or say what to change.`,
  ].join("\n");
}
