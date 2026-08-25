# Naxie storage & memory architecture

Status: **draft — awaiting sign-off**. This doc refines and supersedes §2.4's vault-repo-backup sub-section of `docs/naxie-architecture.md` specifically (the credential-mechanism question it raised is resolved here: fine-grained GitHub PAT). It does not touch that doc's org/role/daemon design otherwise.

## 0. Why this doc exists

Naxie has no real memory architecture today: retrieval is a live wikilink-graph walk (`brain.ts`) plus a keyword index (MiniSearch), and nothing persists beyond the vault's markdown files and a handful of JSON state files. This doc designs a tiered storage/memory system — local drive, Obsidian, a GitHub vault repo, Google Drive, Supabase — with real RAG, CAG, and MAG (Memory- and Graph-Augmented generation), offline resilience, and backup, sized for a single user's personal vault (hundreds of notes, not an enterprise corpus).

## 1. Ground truth

- `neuroworks/server/src/lib/vault.ts` already has a **complete git-sync engine**: debounced `commitAndPush` (via `commit-queue.ts`), retry-with-backoff, stale `.git/index.lock` recovery, a 95MB GitHub-blob-size guard (oversized files are silently kept on disk but never committed), and a periodic `pullFromOrigin` every 5 minutes so edits made directly in Obsidian (or from another machine) sync in. It operates purely via `git push/pull origin` against whatever `origin` remote is already configured on disk in the vault folder's `.git/config` — it does **not** read `VAULT_REPO`/`GITHUB_TOKEN` itself to build that remote (those two vars are informational/used elsewhere — `status.ts`'s display, `templates.ts`'s separate clone flow, `github.ts`'s Octokit client). **On this machine, `neuroworks/vault/` is not yet a git repo at all**, so the real one-time setup is `git init` + `git remote add origin https://x-access-token:<PAT>@github.com/marknature/NaxionAI_Vault-Repo.git` inside that folder (same credential-in-URL convention `templates.ts:528` already uses), alongside setting `VAULT_REPO`/`GITHUB_TOKEN` in `.env` for the other consumers.
- `neuroworks/server/src/lib/vault-index.ts` provides MiniSearch full-text keyword search over the vault. `brain.ts`'s `/api/brain/graph` builds a live wikilink+tag graph on every request by walking the vault's markdown files with regex frontmatter/link parsing.
- **No embeddings/vector store exists anywhere in `neuroworks/`** — confirmed by grep (zero hits for embedding/vector/qdrant/pgvector/pinecone). `naxionai/backend` has a separate local Qdrant+SQLite RAG pipeline (`vault.py`, `rag/pipeline.py`), but that stack is being phased out per `docs/naxie-architecture.md` §1.
- `graphify-out/graph.json` (community detection, god nodes) has **zero code connection** to `brain.ts`'s live graph — two independent graph sources exist today.
- No Google Drive or Supabase integration exists anywhere in this repo.

## 2. Role per backend

Tiered by data type — each backend has one clear job, not a mirror of the others:

| Backend | Role |
|---|---|
| **Local drive** | Hot tier: vault files on disk, the MiniSearch index, JSON state (jobs/schedules/audit), and the local cache for whatever RAG embeddings use before/instead of the remote vector store. |
| **Obsidian** | The note format/UI itself — already the vault's native format via `VAULT_PATH`. No new work; it's the source of truth for knowledge content. |
| **GitHub vault repo** (`marknature/NaxionAI_Vault-Repo`) | Versioned durable backup of the vault + (eventually) audit log / org-task snapshots. ~90% already built — see §1; just needs config + a one-time git-remote setup. |
| **Google Drive** | Off-machine archival for large binaries that can't go through git — `vault.ts`'s existing 95MB blob guard already *skips* committing anything over that size, so Drive is the natural destination for exactly those files — plus an optional periodic full-vault archive export. |
| **Supabase** | (a) pgvector-backed embedding store for RAG — the one piece neither stack has today, and the only backend here suited to durable, queryable vector search; (b) a durable table for MAG long-term memory (facts/preferences/conversation summaries), mirrored from local JSON so memory survives a wiped machine. |

## 3. RAG

Chunk vault markdown → embed → store in Supabase pgvector, as a **third** retrieval path layered *alongside* (not replacing) the existing MiniSearch keyword search and the `brain.ts` graph walk:

1. Try keyword search + graph neighbors first (cheap, already built, zero new infra).
2. Add semantic (pgvector) search when those don't surface enough, or for genuinely fuzzy/conceptual queries keyword matching misses.
3. Inject the top-k results from whichever path(s) fired into the prompt.

Chunking: split by markdown heading, cap chunk size, keep frontmatter/title attached to every chunk from that note. Embedding model: start with whatever the active LLM provider offers cheaply (e.g. an OpenAI/OpenRouter embedding endpoint) rather than standing up a local embedding model — a personal vault's embedding volume is small and infrequent (only changed notes need re-embedding, tracked via the same write hook that already invalidates the search cache).

## 4. CAG

The vault is realistically a few hundred notes — small enough that a cached context prefix (persona system prompt + a curated "core memory" subset) is viable alongside RAG, not instead of it. Check `neuroworks/server/src/lib/llm.ts` for whether the active provider supports prompt/context caching; if so, the prefix rebuilds on vault write (not on a timer) so CAG never serves stale core context. Deferred to Phase 2 — no code lands in this pass.

## 5. MAG — memory

A new durable store for long-term facts/preferences/conversation summaries:

- Written on a cadence (post-conversation summarization), not every turn.
- Stored locally first as JSON (same convention as `handoffs.json`/`schedules.json`), mirrored to a Supabase table for durability across a wiped machine.
- Retrieved by blending recency + relevance, not pure similarity search.
- Deferred to Phase 2.

## 6. MAG — graph

Two extensions, both deferred to Phase 3:

- Retrieval-time graph expansion: when a note is retrieved (by keyword or semantic search), also pull its 1-hop wikilink neighbors from `brain.ts`'s graph before injecting into the prompt.
- Evaluate merging graphify's community/god-node output in as a second graph source — there is no existing wiring between the two graphs today, so this needs either a new ingestion step or a new endpoint that reshapes graphify's output into `brain.ts`'s `{nodes, links}` shape.

## 7. Offline mode

What already works with zero internet, today, with no new code: vault read/write, MiniSearch keyword search, the live wikilink graph, and the local LLM path (Ollama) if configured. `vault.ts`'s design already treats a local commit as durable even when the push to origin fails or times out — that *is* the write-ahead-queue pattern; nothing new is needed there. What degrades gracefully once Phase 2/3 land: Google Drive archival, Supabase RAG/memory, and GitHub push (already retried automatically on the next successful cycle via the existing retry logic).

## 8. Backup / DR

The GitHub push mechanism from §1 is the core of this. Once configured (§9), it commits and pushes on every vault write (debounced) and pulls from origin every 5 minutes. Extending the payload to include audit-log/org-task snapshots depends on `org-daemon.ts` landing (from the *other*, still-pending `naxie-architecture.md` doc) — not on this doc. Google Drive serves as a second, independent archival destination once wired (Phase 2).

## 9. Credentials

- **GitHub — done.** A fine-grained PAT scoped to `marknature/NaxionAI_Vault-Repo` ("Contents: Read and write") is stored in `neuroworks/.env` (`GITHUB_TOKEN`, `VAULT_REPO=marknature/NaxionAI_Vault-Repo`). The real, in-use vault (see the VAULT_PATH note below) is now a git repo tracking that remote with `origin` configured and pushed — `GET /api/storage/status` reports `github: {configured: true, reachable: true}` live.
- **Supabase — credentials received, integration code not written yet.** `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (client-safe), and `SUPABASE_SECRET_KEY` (server-only, never sent to the browser) are stored in `neuroworks/.env`. The direct-Postgres connection string still has a placeholder password — needed only if/when Phase 2 wires the pgvector path directly rather than through the REST API; get the real value from Project Settings → Database when that's ready. Also still needed for Phase 2: enable the `pgvector` extension (Database → Extensions).
- **Google — not yet provided.** In the existing Google Cloud project: enable the Drive API and add scope `https://www.googleapis.com/auth/drive.file` to the OAuth consent screen already used for the Gmail/Calendar connector — least-privilege: only files this app creates/opens, not full-drive access.

## 10. A path-resolution bug this work surfaced

`VAULT_PATH`'s default (`./vault`) resolves relative to `process.cwd()`, which differs by launch method — `pnpm -F neuroworks-server dev` runs with cwd=`server/`, silently landing on `neuroworks/server/vault` (505 real files: governance, reflections, datasets) rather than `neuroworks/vault` (the placeholder CLAUDE.md describes as intentionally empty). Both paths existed simultaneously; only the former was ever real. `VAULT_PATH` is now pinned to an absolute path in `.env` so this is deterministic regardless of launch method. `neuroworks/server/vault` was already a git checkout of the vault repo (missing only its `origin` remote — accumulated local commits had never been pushed); this pass added the remote, committed the accumulated backlog, and pushed. `neuroworks/vault` was reverted back to its original empty-placeholder state after this was discovered.

## 11. Phasing

- **Phase 1 (this pass) — done**: this doc; GitHub vault-repo backup wiring, live and verified against the real vault; the `VAULT_PATH` fix above; boot-startup automation; the storage-universe visualization (status-only for Drive/Supabase — "not configured"); Supabase credentials received and stored.
- **Phase 2 — mostly done (2026-08-24)**: real pgvector RAG pipeline shipped — `lib/pg-client.ts` (Postgres pool over the existing `pg` dependency, no new client library), `lib/rag-chunk.ts` (heading-split vault chunking), `lib/embeddings.ts` (OpenAI `text-embedding-3-small`, independent of the active chat provider), `lib/rag-embed.ts` (debounced re-embed on vault write), migration `0001_vault_chunks.sql` (pgvector schema, applied live). `lib/rag.ts`'s `ragSearch` now merges a `"vault-semantic"` source alongside the existing keyword/memory search, degrading gracefully when Postgres/embeddings are unavailable. MAG's Supabase mirror also shipped — `memory_facts` table (migration `0002_memory_facts.sql`, applied live), write-behind mirroring from `lib/memory.ts`'s fact-writer, plus a boot-time hydrate-if-local-empty (wipe-recovery only, not live two-way sync). **Google Drive connector: still not started** — needs Drive-scope OAuth credentials from the user.
- **Phase 3 — done (2026-08-24)**: graph unification — `routes/brain.ts`'s graph-building logic extracted into `lib/vault-graph.ts`'s `buildVaultGraph()`/`graphNeighbors()` (the route is now a thin wrapper, same response shape); `lib/graphify-import.ts` loads `graphify-out/graph.json` and merges it into the live wikilink graph on a best-effort normalized-label match; RAG hits now carry graph-neighbor annotations. CAG's cacheable-prefix construction was already done pre-2026-08-24; provider-side prompt-cache wiring was evaluated and **deliberately skipped** — the actual active provider (Gemini, confirmed via `.neuroworks/model-providers.json`, not the `.env` `OPENROUTER_API_KEY` fallback) already gets Gemini's implicit prompt caching for free on CAG's stable prefix through the existing OpenAI-compatible client, with zero code changes needed; explicit caching would require breaking the provider-agnostic client for one provider and wasn't judged worth it.

Remaining Phase 2 gap (Google Drive) still needs the user's credentials before it can start; everything else in Phase 2/3 is live pending the Supabase DB password/OpenAI embedding key being valid (see `.env` — as of this pass the OpenAI embedding key is set but the account has an `insufficient_quota` billing block, so semantic search currently degrades to keyword search until that's resolved).
