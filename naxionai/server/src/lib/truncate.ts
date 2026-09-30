/**
 * One truncation marker, in one place. Ported from AI-Institute-Africa/
 * neuroworks.
 *
 * WHY THIS EXISTS — a measured failure, not a tidiness exercise.
 *
 * An agent was handed an RFP and asked to score it. It replied that "the
 * attached RFP cuts off at §4.1.5" and asked the operator to paste the
 * technical evaluation criteria. Those criteria were already in the document
 * it had been given, at character 14,194 of 23,292. The attachment had been
 * inlined with a bare head slice — nothing said a tail existed. The agent's
 * answer was CORRECT given what it was shown; it had no way to know it was
 * looking at a third of the document.
 *
 * A silent cut turns a retrievable gap into a confidently wrong answer. A
 * marked cut turns it into an answerable question — the agent asks for the
 * section by name and gets it. Not more characters: honesty about the ones
 * that were dropped.
 *
 * THE MARKER FITS INSIDE THE CAP: `truncateWithMarker(t, cap).length <= cap`
 * always holds, so a caller with a hard downstream budget never overflows it
 * by appending an honest marker.
 */

/** The marker alone, for a cut of `shown` characters out of `total`. */
function marker(shown: number, total: number): string {
  return `\n\n[... truncated at ${shown} characters of ${total}; ask for a specific section if you need more ...]`;
}

/**
 * Return `text` unchanged when it fits; otherwise cut it and append a marker
 * naming how much was shown and how much exists.
 *
 * NEVER emits a marker when nothing was cut — a marker on an intact document
 * is a lie in the other direction, and teaches the agent to distrust the ones
 * that are real.
 *
 * `cap` that is not a positive finite number means "no cap": the text comes
 * back whole.
 */
export function truncateWithMarker(text: string, cap: number): string {
  if (typeof text !== "string") return text;
  if (!Number.isFinite(cap) || cap <= 0) return text;
  const total = text.length;
  if (total <= cap) return text;

  // The marker's own length depends on the number of characters shown, which
  // depends on the marker's length. Converge: start from an over-estimate,
  // then walk down until the whole thing fits the cap exactly.
  let shown = cap - marker(cap, total).length;
  shown = cap - marker(Math.max(0, shown), total).length;
  while (shown > 0 && shown + marker(shown, total).length > cap) shown--;

  // Cap too small to hold even the marker. Honesty wins over the budget.
  if (shown <= 0) return marker(0, total).trimStart();

  return text.slice(0, shown) + marker(shown, total);
}

/**
 * Whether `truncateWithMarker` would actually cut this text — for callers
 * that need to record the fact (a job log line, a `truncated: true` flag) as
 * well as show it.
 */
export function wouldTruncate(text: string, cap: number): boolean {
  return typeof text === "string" && Number.isFinite(cap) && cap > 0 && text.length > cap;
}
