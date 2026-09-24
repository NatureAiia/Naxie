// Mail that an agent can find again.
//
// Reading mail was never the gap: listRecentEmails/readEmail return bodies
// and links, and inbox questions already route to them. The gap is that
// nothing an agent reads SURVIVES the run — email.ts's fileAttachmentsToVault
// only files ATTACHMENTS, never the message content itself, so "the
// Zimpapers invoice arrived by email" (no attachment, just text) cannot be
// found by anything, ever, including the run that needs it tomorrow morning.
//
// So the email-to-vault digest (routes/templates.ts's emailToVaultRunner)
// leaves a note per message. Not every message: the ones its own classifier
// judged worth a human's attention. Newsletters and verification codes are
// exactly what a search index does not need more of.
//
// WHERE, and why it matters: `_neuroworks/email/` is deliberately outside
// the agent-journal folders vault.ts treats as noise, so these notes are
// searchable the moment they land. Mail becomes evidence by BEING IN THE
// VAULT — never by being named in a prompt.
//
// Ported from AI-Institute-Africa/neuroworks upstream (server/src/lib/
// email-notes.ts) — this repo's own inbound-email path only ever filed
// attachments, never per-message notes.

export const EMAIL_NOTES_DIR = "_neuroworks/email";

/** What the classifier decided about one message. */
export type MailVerdict = {
  who?: string;
  wants?: string;
  urgency?: string;
  needsReply?: boolean;
  _unclassified?: boolean;
};

export type MailForNote = {
  from: string;
  identity: string;
  subject: string;
  date: string;
  body: string;
  messageId?: string;
  links?: string[];
};

/**
 * Is this message worth a note?
 *
 * Three ways in, and the third matters most: a message the classifier could
 * not read is exactly the one a human should be able to find later. Filing
 * only what a small local model understood would quietly lose the hard cases.
 */
export function shouldKeep(v: MailVerdict): { keep: boolean; why: string } {
  if (v._unclassified) return { keep: true, why: "could not be classified — kept so it is findable" };
  if (v.needsReply === true) return { keep: true, why: "needs a reply" };
  if (String(v.urgency ?? "").toLowerCase() === "high") return { keep: true, why: "urgent" };
  return { keep: false, why: "automated or informational" };
}

/** `_neuroworks/email/2026-08-18-zimpapers-august-invoice.md` */
export function emailNotePath(date: string, subject: string, slugify: (s: string) => string): string {
  const day = /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : new Date(date || Date.now()).toISOString().slice(0, 10);
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10);
  return `${EMAIL_NOTES_DIR}/${stamp}-${slugify(subject || "message")}.md`;
}

const yaml = (v: string) => `"${String(v ?? "").replace(/"/g, "'").replace(/\s+/g, " ").trim().slice(0, 200)}"`;

/**
 * The note itself.
 *
 * Frontmatter carries the things a later search needs to match on and a
 * human needs to trust it — who, when, which address it arrived through, and
 * the message id so a thread can be reassembled. The body is the message,
 * not a summary of it — a summary loses the invoice number.
 */
export function renderEmailNote(m: MailForNote, v: MailVerdict, why: string): string {
  const links = (m.links ?? []).filter(Boolean).slice(0, 20);
  return [
    "---",
    "type: email",
    `from: ${yaml(m.from)}`,
    `to: ${yaml(m.identity)}`,
    `subject: ${yaml(m.subject)}`,
    `date: ${yaml(m.date)}`,
    ...(m.messageId ? [`message_id: ${yaml(m.messageId)}`] : []),
    `urgency: ${yaml(v.urgency ?? "normal")}`,
    `needs_reply: ${v.needsReply === true}`,
    `kept_because: ${yaml(why)}`,
    "---",
    "",
    `# ${m.subject || "(no subject)"}`,
    "",
    `**From** ${m.from} · **to** ${m.identity} · ${m.date || "(no date)"}`,
    ...(v.wants ? ["", `**What they want:** ${v.wants}`] : []),
    "",
    "## Message",
    "",
    m.body.trim() || "_(no body text)_",
    ...(links.length ? ["", "## Links", "", ...links.map(l => `- ${l}`)] : []),
    "",
  ].join("\n");
}
