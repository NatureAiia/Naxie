# Technical Audit — GitHub Issue Templates

Copy these into GitHub Issues with labels `tech-audit` + sprint label.

---

## TA-001: Standardize Transient Error Responses (503 + Retry-After)
**Labels:** `tech-audit`, `backend`, `critical`, `sprint-1`
**Assignee:** @eng-1
**Estimate:** 4 hours

### Description
Inconsistent error codes for upstream failures. Some routes return 502, some 503, some 500. Clients can't implement proper retry logic.

### Files to Change
- `naxionai/server/src/lib/http-errors.ts` (new)
- `naxionai/server/src/routes/voice.ts:399`
- `naxionai/server/src/routes/personal-finance.ts:100,109`
- `naxionai/server/src/routes/org-tasks.ts:100`
- `naxionai/server/src/routes/my-tasks.ts:164`
- `naxionai/server/src/routes/models.ts:137,140`
- `naxionai/server/src/lib/email.ts:483`
- `naxionai/server/src/index.ts:412-428` (global handler)

### Implementation
1. Create `transientError(message, retryAfter?)` helper returning Error with `.status=503`, `.retryAfter`, `.transient=true`
2. Replace all upstream-failure throws with this helper
3. Global error handler: if `err.transient`, set `Retry-After: err.retryAfter` header

### Acceptance Criteria
- [ ] All upstream failures return 503
- [ ] `Retry-After` header present (default 30s)
- [ ] Global handler doesn't override explicit status
- [ ] Tests: `GET /api/voice/realtime-session` with no OpenRouter → 503 + Retry-After

---

## TA-002: Eliminate Ollama Cold-Start Latency
**Labels:** `tech-audit`, `backend`, `critical`, `sprint-1`
**Assignee:** @eng-1
**Estimate:** 1 day

### Description
First request after model idle pays 5-8s load time. Warmup only runs at boot.

### Files to Change
- Ollama server env: `OLLAMA_NUM_PARALLEL=4`, `OLLAMA_MAX_LOADED_MODELS=2`
- `naxionai/server/src/lib/llm.ts` — add `keep_alive: "10m"` to generate calls
- `naxionai/server/src/index.ts:469-480` — add background re-warm

### Implementation
1. Document required Ollama env vars in deploy checklist
2. Modify `ollamaGenerate()` to include `keep_alive: "10m"`
3. Add `setInterval` (5min) that checks last-used timestamp per model; if >5min idle, fire warm request

### Acceptance Criteria
- [ ] p95 first-request latency <3s after 10min idle
- [ ] No warm request storms (debounced)
- [ ] Works with multiple models (triage, plan, synth)

---

## TA-003: Vault Search Incremental Index + Pagination
**Labels:** `tech-audit`, `backend`, `critical`, `sprint-2`
**Assignee:** @eng-1
**Estimate:** 2 days

### Description
MiniSearch rebuilds full index on every write; no pagination; degrades at scale.

### Files to Change
- `naxionai/server/src/lib/vault-index.ts`
- `naxionai/server/src/routes/vault.ts` (search endpoint)

### Implementation
1. `MiniSearch.add()` / `remove()` / `update()` instead of rebuild
2. Search endpoint: `limit` (default 20, max 100) + `offset` params
3. Return `{ results, total, limit, offset }`
4. Optional: if `SUPABASE_DB_URL` set, use pgvector for >10k notes

### Acceptance Criteria
- [ ] Write latency unchanged (no full rebuild)
- [ ] Search <500ms at 10k notes
- [ ] Pagination works (offset 0, 20, 40...)
- [ ] Total count accurate

---

## TA-004: Structured Logging with Correlation IDs
**Labels:** `tech-audit`, `infra`, `critical`, `sprint-4`
**Assignee:** @eng-1
**Estimate:** 1 day

### Description
Production debugging requires grepping unstructured logs.

### Files to Change
- `naxionai/server/src/index.ts` (middleware + logger setup)
- `naxionai/server/src/lib/logger.ts` (new — Pino wrapper)
- All `console.log/error/warn` calls → `log.info/error/warn()`

### Implementation
1. Add `pino` + `pino-pretty` (dev)
2. Middleware: generate `reqId` (uuid v7), attach to `req`, set `X-Request-Id` header
3. Child loggers per module: `log.child({ module: 'voice' })`
4. Redaction: strip `authorization`, `cookie`, `apiKey`, `password` from logs
5. Output: stdout (JSON) + file rotation (`.naxion/logs/`)

### Acceptance Criteria
- [ ] Every log line has `reqId`, `time`, `level`, `module`
- [ ] `grep <reqId> .naxion/logs/app.log` shows full trace
- [ ] No secrets in logs (verified by audit)
- [ ] Dev mode: pretty-printed; prod: JSON

---

## TA-005: True Parallel Job Execution
**Labels:** `tech-audit`, `backend`, `critical`, `sprint-3`
**Assignee:** @eng-1
**Estimate:** 2 days

### Description
Worker pool shares single Ollama; no true parallelism for local models.

### Files to Change
- Ollama server: `OLLAMA_NUM_PARALLEL=4`, `OLLAMA_MAX_LOADED_MODELS=2`
- `naxionai/server/src/lib/worker-manager.ts` — route to least-loaded Ollama
- `naxionai/server/src/lib/llm-lane.ts` — track per-model concurrency

### Implementation
1. Document Ollama config in deploy docs
2. Worker manager: if multiple Ollama instances (ports 11434, 11435...), round-robin
3. LLM lane: respect `OLLAMA_NUM_PARALLEL` per model; queue excess
4. OpenRouter: no local limit (server-side parallelism)

### Acceptance Criteria
- [ ] 10 concurrent jobs on OpenRouter complete in ~same time as 1
- [ ] 4 concurrent jobs on local complete in ~1/4 time (with NUM_PARALLEL=4)
- [ ] No OOM on Ollama (MAX_LOADED_MODELS respected)

---

## TA-006: WebSocket for Real-Time UI (Replace Polling)
**Labels:** `tech-audit`, `frontend`, `high`, `sprint-2`
**Assignee:** @eng-2
**Estimate:** 2 days

### Description
Health dashboard, job progress, vault sync all poll unnecessarily.

### Files to Change
- `naxionai/server/src/index.ts` — Socket.io server
- `naxionai/server/src/lib/socket.ts` (new — rooms, events)
- `naxionai/web/src/hooks/useSocket.ts` (new)
- Components: `HealthDashboard`, `JobProgress`, `VaultSyncStatus`

### Implementation
1. `npm i socket.io socket.io-client`
2. Server: `io.on('connection', socket => { socket.join('health'); socket.join(`job:${jobId}`); })`
3. Emit events: `job:progress`, `vault:sync`, `health:update`
4. Client: `useSocket('health')` hook with auto-reconnect
5. Fallback: if WS fails, degrade to polling

### Acceptance Criteria
- [ ] Job progress updates <100ms after server emit
- [ ] Zero polling requests in network tab
- [ ] Reconnects automatically on network flap
- [ ] Works behind nginx (proxy ws://)

---

## TA-007: RAG Embedding Cost Control + Visibility
**Labels:** `tech-audit`, `backend`, `high`, `sprint-2`
**Assignee:** @eng-1
**Estimate:** 1 day

### Description
Every vault write triggers re-embed; no cost tracking; silent billing.

### Files to Change
- `naxionai/server/src/lib/embeddings.ts`
- `naxionai/server/src/lib/cost-tracker.ts` (extend)
- `naxionai/server/src/routes/cost.ts`

### Implementation
1. Content-hash cache: `sha256(text)` → cached embedding (reuse `ttsCacheKey` pattern)
2. Batch API: send 100 texts/request to OpenAI embeddings
3. Cost tracker: record embedding tokens × $/1k
4. Dashboard: separate "Embeddings" line item

### Acceptance Criteria
- [ ] Repeated embed of same text = zero cost
- [ ] Batch size 100 reduces API calls 100x
- [ ] `/api/cost?groupBy=type` shows `embeddings` vs `completions`

---

## TA-008: Git Sync Conflict Resolution UI
**Labels:** `tech-audit`, `frontend`, `high`, `sprint-2`
**Assignee:** @eng-2
**Estimate:** 2 days

### Description
Auto-rebase failures leave user with stale data and no resolution path.

### Files to Change
- `naxionai/server/src/lib/vault.ts` — conflict detection
- `naxionai/web/src/components/VaultConflictModal.tsx` (new)
- `naxionai/web/src/hooks/useVaultSync.ts`

### Implementation
1. Detect: `git pull` fails with conflict markers
2. Server: return `{ conflict: true, files: [{ path, ours, theirs, base }] }`
3. Client: toast → click → modal with three-pane diff (ours/theirs/merged)
4. Buttons: "Accept Ours", "Accept Theirs", "Manual Edit" (opens editor)
5. On resolve: `git add` + commit + push

### Acceptance Criteria
- [ ] Conflict → toast within 5s
- [ ] Modal shows correct three-way diff
- [ ] Resolved → sync resumes automatically

---

## TA-009: Tool Schema Versioning
**Labels:** `tech-audit`, `backend`, `high`, `sprint-3`
**Assignee:** @eng-1
**Estimate:** 1 day

### Description
Tool signature changes break existing agents silently.

### Files to Change
- `naxionai/server/src/lib/tools.ts` (registry)
- `naxionai/server/src/lib/agent.ts` (planner)

### Implementation
1. Each tool declares `schemaVersion: "1.0.0"` (semver)
2. Agent planner includes `toolVersions: { toolName: "1.0.0" }` in plan
3. Executor: if tool version mismatch, try compat shim or fail with clear error
4. Registry: `registerTool(name, schema, handler, version)`

### Acceptance Criteria
- [ ] Tool version in plan
- [ ] Breaking change → clear error with migration hint
- [ ] Non-breaking (new optional param) → works without update

---

## TA-010: Database Migrations for Vault Index
**Labels:** `tech-audit`, `backend`, `high`, `sprint-2`
**Assignee:** @eng-1
**Estimate:** 1 day

### Description
Schema changes require manual SQL; no version tracking.

### Files to Change
- `naxionai/server/src/lib/migrate.ts` (new)
- `naxionai/server/migrations/` (directory)
- `naxionai/server/package.json` — add `pnpm migrate` script

### Implementation
1. Migration files: `001_init.sql`, `002_entities.sql` (up + down)
2. Runner: reads `.naxion/migrations.json` (applied list), applies pending
3. `pnpm migrate` — runs all pending
4. `pnpm migrate:down` — rolls back last (with confirmation)
5. CI: run migrations on test DB

### Acceptance Criteria
- [ ] `pnpm migrate` idempotent (re-run safe)
- [ ] Rollback restores previous schema
- [ ] New migration template in 30s

---

## Quick Wins (Do Anytime, <4 hours each)

| Issue | Fix | Files |
|-------|-----|-------|
| TA-021 | Add `X-Request-Id` header | `index.ts` middleware |
| TA-022 | Disk space in health check | `index.ts:238` |
| TA-023 | Rate limit headers | `rate-limiter-flexible` + middleware |
| TA-024 | Disable `x-powered-by` | `app.disable('x-powered-by')` |
| TA-025 | CSP Report-Only mode | `helmet.contentSecurityPolicy({ reportOnly: true })` |