# Sprint 2 Issues — Workspace & Vault

## ENG-009: Vault File Explorer (Tree View, Open/Edit/Save)
**Labels:** `sprint-2`, `frontend`, `critical`, `eng-2`
**Estimate:** 3 days

### Description
Obsidian-compatible file browser with tree navigation, markdown editing, auto-save.

### Tasks
- [ ] Tree component: lazy-load folders, search filter, drag-drop move
- [ ] Editor: Monaco or CodeMirror with markdown preview toggle
- [ ] Auto-save debounced (2s) → PATCH `/api/vault/files/:path`
- [ ] New file/folder modal; delete with confirmation
- [ ] Keyboard nav: arrows, enter=open, cmd+n=new, delete=remove

### Acceptance Criteria
- 10k files loads in <2s (lazy tree)
- Edit → save → refresh shows changes
- Works on mobile (touch-friendly)

---

## ENG-010: Vault Search (MiniSearch + Grep Fallback)
**Labels:** `sprint-2`, `backend`, `critical`, `eng-1`
**Estimate:** 2 days

### Description
Full-text search across vault with instant results.

### Tasks
- [ ] MiniSearch index build at boot + incremental on write
- [ ] GET `/api/vault/search?q=&limit=20` → ranked results with snippets
- [ ] Grep fallback for binary/large files (ripgrep if available)
- [ ] Search highlights in editor when opening result
- [ ] Index rebuild button in health dashboard

### Acceptance Criteria
- Search returns results in <500ms for 1k notes
- Results ranked by relevance (title > headings > body)
- Zero-config: works without MiniSearch (grep-only mode)

---

## ENG-011: RAG Pipeline (Chunk → Embed → Retrieve → Inject)
**Labels:** `sprint-2`, `backend`, `critical`, `eng-1`
**Estimate:** 4 days

### Description
Retrieval-augmented generation using vault content as context.

### Tasks
- [ ] Chunker: split markdown by headings (max 500 tokens, overlap 50)
- [ ] Embedder: `OPENAI_EMBEDDING_API_KEY` → `text-embedding-3-small` (1536 dims)
- [ ] Vector store: in-memory HNSW (dev) / pgvector (prod via `SUPABASE_DB_URL`)
- [ ] Retriever: top-k cosine similarity + keyword boost (RIFTS-X)
- [ ] Injector: `@vault` tag in chat → retrieve → prepend to system prompt
- [ ] Cache: embeddings keyed by content hash; invalidate on file change

### Acceptance Criteria
- Chat with `@vault "project alpha"` returns answer grounded in vault notes
- Citations show source file + line range
- Embedding cost <$0.01 per 1k chunks

---

## ENG-012: File Upload (Drag-Drop → Vault/Media)
**Labels:** `sprint-2`, `frontend`, `high`, `eng-2`
**Estimate:** 2 days

### Description
Upload PDFs, images, markdown to vault with preview.

### Tasks
- [ ] Drop zone in vault explorer (desktop) / FAB (mobile)
- [ ] Client-side validation: type, size (<25MB), sanitize filename
- [ ] POST `/api/uploads` (multipart) → returns vault path
- [ ] PDF: extract text for search index; Image: thumbnail generation
- [ ] Progress bar + cancel; resume on network interruption

### Acceptance Criteria
- Drag PDF → appears in vault tree → searchable content
- Image upload → thumbnail in grid view → click → fullscreen
- Invalid files rejected with clear message

---

## ENG-013: Web Fetch Primitive (SmartFetch Tiers)
**Labels:** `sprint-2`, `backend`, `high`, `eng-1`
**Estimate:** 2 days

### Description
Resilient web fetching with automatic tier escalation.

### Tasks
- [ ] Tier 1: `fetch()` with 10s timeout, no JS
- [ ] Tier 2: Playwright (headless) for JS-rendered pages
- [ ] Tier 3: Firecrawl API (if `FIRECRAWL_API_KEY` set)
- [ ] SmartFetch: try tiers sequentially; cache successful results 24h
- [ ] Return: `{ html, text, title, metadata, sourceUrl, tierUsed }`
- [ ] Respect `robots.txt`, rate limits, `NAXION_WEB_ALLOW_PRIVATE`

### Acceptance Criteria
- Static page → Tier 1 succeeds in <2s
- SPA → Tier 2 renders and extracts text
- Paywall/Cloudflare → Tier 3 (if configured) or graceful failure

---

## ENG-014: Git Sync (Commit Queue + Push/Pull Scheduler)
**Labels:** `sprint-2`, `backend`, `high`, `eng-1`
**Estimate:** 2 days

### Description
Automatic vault synchronization with remote git repo.

### Tasks
- [ ] Commit queue: debounce writes (4s default), batch into single commit
- [ ] `NAXION_COMMIT_DEBOUNCE_MS` configurable; `NAXION_VAULT_WATCH=0` disables
- [ ] Push scheduler: every 5min, push if commits ahead
- [ ] Pull scheduler: every 5min, fetch + merge (fast-forward only)
- [ ] Conflict UI: show diff, accept ours/theirs/manual
- [ ] Metrics: commits queued, pushed, pulled, conflicts

### Acceptance Criteria
- Edit note → appears in git log within 10s
- Remote edit → appears locally within 5min
- Conflict → UI notification with resolve options

---

## ENG-015: Sprint 2 Integration & Demo Prep
**Labels:** `sprint-2`, `integration`, `critical`, `all`
**Estimate:** 1 day (shared)

### Tasks
- [ ] E2E: create note → search → chat with `@vault` → upload PDF → git sync
- [ ] Demo: vault as knowledge base for agent
- [ ] Retro + Sprint 3 planning