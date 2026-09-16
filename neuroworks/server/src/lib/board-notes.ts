// Board Meeting — Feature B: capture each completed meeting as a linked,
// searchable vault note (mirrors primitives.ts's research.deep capture
// convention: same 0-Inbox/<stamp>-<kind>-<slug>.md naming, same frontmatter
// shape, same [[wikilink]] sourcing for whatever was read for grounding).
//
// Before this, a board meeting only lived in .neuroworks/board-meetings.json
// (capped at 50 runs) — invisible to search/RAG and to vault-graph.ts's
// wikilink graph. Writing here is what actually feeds that graph
// board-meeting-sourced links; no changes to vault-graph.ts itself needed.
import { writeVaultFile } from "./vault.js";
import { enqueueVaultCommit } from "./commit-queue.js";
import type { BoardRun } from "./board.js";

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "board-meeting";
}

function renderNote(run: BoardRun): string {
  const today = new Date().toISOString().slice(0, 10);
  const rosterLines = run.roster.map(m => `- ${m.name} (${m.role})`).join("\n") || "_(no roster)_";
  const opinionsBlock = run.opinions.filter(o => o.text)
    .map(o => `### ${o.name} (${o.role})\n${o.text}`).join("\n\n") || "_(no opinions recorded)_";
  const rankingsBlock = run.rankings.filter(r => r.rankingText)
    .map(r => `### ${r.name}'s ranking\n${r.rankingText}`).join("\n\n") || "_(no rankings recorded)_";
  const groundedBlock = (run.groundedIn ?? []).length > 0
    ? run.groundedIn!.map(g => `- [[${g.path}]] — ${g.preview}`).join("\n")
    : "_(no vault matches)_";

  return `---\ntitle: "Board Meeting: ${run.topic.replace(/"/g, "'").slice(0, 120)}"\ncreated: ${today}\nsource: board-meeting\nboardRunId: ${run.id}\nstatus: ${run.status}\n---\n\n` +
    `# Board Meeting: ${run.topic}\n\n` +
    `## Roster\n${rosterLines}\n\n` +
    `## Naxie's final synthesis\n${run.chairmanSynthesis || "_(not yet synthesized)_"}\n\n` +
    `<details><summary>Council opinions (Stage 1)</summary>\n\n${opinionsBlock}\n\n</details>\n\n` +
    `<details><summary>Peer review (Stage 2)</summary>\n\n${rankingsBlock}\n\n</details>\n\n` +
    `## Grounded in\n${groundedBlock}\n`;
}

// Never throws — a note-write failure must not fail an otherwise-completed
// meeting. Idempotent: if run.notePath is already set (a Feature-C revision
// re-saves), overwrites that same path rather than minting a new file.
export async function writeBoardMeetingNote(run: BoardRun): Promise<string | null> {
  try {
    const path = run.notePath ?? (() => {
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
      return `0-Inbox/${stamp}-board-${slugify(run.topic)}.md`;
    })();
    writeVaultFile(path, renderNote(run));
    void enqueueVaultCommit(`neuroworks: board meeting — ${slugify(run.topic)}`);
    return path;
  } catch {
    return null;
  }
}
