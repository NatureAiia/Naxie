# Vault instructions for Claude

This vault is my **second brain**. It runs two coexisting layers:

1. **Operational-state layer** — what's actually maintained day to day: `_progress/` (dated engineering/session logs, one file per day of real work) and `_naxion/reflections/` (automated nightly reflection on agent activity). This replaced an earlier hand-maintained `active-context.md`/`decisions.md`/`progress.md`/`_tasks/*` protocol that was retired 2026-07-10 after being found frozen since 2026-04-25 — it was never actually wired into Naxie's autonomous agent loop, so it just stopped updating while the vault kept evolving. Don't recreate those files; use `_progress/` instead.
2. **Zettelkasten layer** — atomic, durable knowledge notes with stable IDs and dense linking. The actual "thinking" lives here.

The Naxie also writes into `_naxie/` from the cloud — treat those as raw input, not finished knowledge.

## Session protocol

### On session START
1. Read `CLAUDE.md` (this file).
2. Skim the most recent file in `_progress/` for current state.
3. Skim `_naxie/latest.md` if it exists — fresh cloud info.
4. Silently load this. Do not summarize back unless asked.

### During the session
- Temporary files / drafts → `_scratch/`.
- Reusable patterns / gotchas → append to `_knowledge/<topic>.md` (create if missing).
- New atomic insight worth keeping forever → new Zettel in `2-Permanent/` (see Zettelkasten rules below).
- Real client/venture work → `4-Projects/<project-name>/` (added 2026-07-10 — PARA's missing "Projects" bucket; previously everything piled into `0-Inbox` with nowhere else to go).

### On session END (when I say "wrap up", "end session", or "save memory")
1. Write a dated log to `_progress/YYYY-MM-DD-<topic>.md` — what shipped, what's open, gotchas.
2. Promote anything in `0-Inbox/` that has matured into atomic insight to `2-Permanent/`, or into `4-Projects/<name>/` if it's project-specific rather than a durable general claim.
3. Clean `_scratch/` — move useful files to the right folder or delete.
4. Commit: `git add -A && git commit -m "session: <topic>"`.
5. Tell me: "Memory saved."

## Zettelkasten rules

- **Atomicity**: one idea per note. If you find yourself using "and" in the title, split it.
- **IDs**: filename starts with `YYYYMMDDHHmm` timestamp (e.g. `202604251430-claim-decoupled-from-evidence.md`). Never reuse or rename an ID.
- **Linking**: every permanent note links to at least one other. Orphan = work-in-progress.
- **Folders**:
  - `0-Inbox/` — fleeting / unprocessed thoughts. Capture cheaply, process later.
  - `1-Literature/` — notes about external sources (books, papers, talks). One file per source. Quote sparingly; rephrase in your own words.
  - `2-Permanent/` — atomic Zettel notes. The body of the brain.
  - `3-MOCs/` — Maps of Content. Structure notes that group permanent notes by theme; act as entry points.
  - `4-Projects/<name>/` — active client/venture work-in-progress. Not atomic knowledge — project artifacts (meeting notes, comparisons, roadmaps) that belong to a specific effort, not a durable claim.
- **Frontmatter** for permanent notes:
  ```
  ---
  id: 202604251430
  title: <claim or insight>
  tags: [<topic>, <topic>]
  created: 2026-04-25
  ---
  ```
- **Body shape**: state the claim in the first sentence, then evidence/reasoning, then `## Links` listing the notes it connects to with `[[id-slug]]` and a one-line reason for each link.

## Important rules

- Never rewrite a past `_progress/` entry to look like it knew things it didn't — append a new dated entry instead.
- Always use ISO dates (`YYYY-MM-DD`) in filenames and logs.
- Never edit anything inside `_naxie/` by hand — the cloud bot owns it. Promote insights from there into `0-Inbox/` or `2-Permanent/` instead.
- If a folder in this scaffold is missing, create it; don't ask.

