# Technical Audit — Engineering Upgrades

**Source:** Codebase analysis (Oct 2026) | **Format:** GitHub Issues + this doc | **Prioritization:** ICE (Impact × Confidence × Ease)

---

## Scoring Framework

| Score | Impact | Confidence | Ease |
|-------|--------|------------|------|
| 10 | Revenue-critical / unblocks launch | Proven by data / prod incident | <1 day, no deps |
| 7 | Major UX improvement / cost reduction | Strong evidence | 1-3 days, few deps |
| 5 | Nice-to-have / tech debt | Anecdotal | 1 week, some deps |
| 3 | Low leverage | Speculative | >1 week, many deps |
| 1 | Cosmetic | Guess | Unknown |

**ICE = Impact × Confidence × Ease** (max 1000)

---

## Critical (ICE ≥ 500) — Do in Sprint 1-2

### TA-001: Fix 502/503 Error Handling Consistency
**Labels:** `tech-audit`, `backend`, `critical`, `sprint-1`
**ICE:** 840 (Impact: 10, Confidence: 8, Ease: 10)

**Problem:** Inconsistent error codes — some routes return 502 for upstream failures, others 503, others 500. Clients can't distinguish retryable vs fatal.

**Evidence:**
- `voice.ts:399` returns 502 for OpenAI realtime failure
- `personal-finance.ts:109` returns 502 for AI parse failure
- `email.ts:483` throws on timeout (uncaught → 500)
- `agent.ts:893` treats 502 as transient but not 503

**Fix:** Standardize on 503 for transient upstream failures with `Retry-After` header. Create `transientError()` helper.

```typescript
// lib/http-errors.ts
export function transientError(message: string, retryAfter = 30) {
  const err = new Error(message) as any;
  err.status = 503;
  err.retryAfter = retryAfter;
  err.transient = true;
  return err;
}
```

**Acceptance:** All upstream failures return 503 + `Retry-After`; global handler adds header automatically.

---

### TA-002: Ollama Cold-Start Latency (5-8s First Request)
**Labels:** `tech-audit`, `backend`, `critical`, `sprint-1`
**ICE:** 720 (Impact: 9, Confidence: 9, Ease: 9)

**Problem:** First request after idle pays model load tax. Current warmup only runs at boot.

**Evidence:** `index.ts:469-480` warms models at boot but not after `OLLAMA_NUM_PARALLEL` eviction.

**Fix:**
1. Increase `OLLAMA_NUM_PARALLEL=4` and `OLLAMA_MAX_LOADED_MODELS=2` in Ollama env
2. Add `keep_alive: "10m"` to all Ollama generate calls
3. Background re-warm: if model unused >5min, fire warm request

**Acceptance:** p95 first-request latency <3s after 10min idle.

---

### TA-003: Vault Search Scales Poorly (>5k Notes)
**Labels:** `tech-audit`, `backend`, `critical`, `sprint-2`
**ICE:** 630 (Impact: 9, Confidence: 7, Ease: 10)

**Problem:** MiniSearch rebuilds full index on every write; O(n) search degrades.

**Evidence:** `vault-index.ts` rebuilds on every change; no pagination in results.

**Fix:**
1. Incremental index updates (add/remove single doc)
2. Pagination: `limit` + `offset` params
3. Optional pgvector for >10k notes (`SUPABASE_DB_URL`)

**Acceptance:** Search <500ms at 10k notes; writes don't block reads.

---

### TA-004: No Structured Logging / Correlation IDs
**Labels:** `tech-audit`, `infra`, `critical`, `sprint-4`
**ICE:** 560 (Impact: 8, Confidence: 10, Ease: 7)

**Problem:** Debugging production issues requires grepping unstructured `console.log`.

**Evidence:** `index.ts:414` logs errors but no request ID; no JSON output.

**Fix:** See ENG-024 — Pino + correlation IDs + redaction.

**Acceptance:** Every log line has `reqId`; grep by ID shows full trace.

---

### TA-005: Single-Threaded Job Execution (No Parallelism)
**Labels:** `tech-audit`, `backend`, `critical`, `sprint-3`
**ICE:** 540 (Impact: 8, Confidence: 9, Ease: 7)

**Problem:** `NAXION_MAX_CONCURRENT_JOBS=2` but workers share one Ollama; no true parallelism.

**Evidence:** `index.ts:564` spawns pool but all hit same `OLLAMA_HOST`.

**Fix:**
1. Configure `OLLAMA_NUM_PARALLEL=4` on Ollama server
2. Worker pool routes to least-loaded Ollama instance (if multiple)
3. OpenRouter for true parallel cloud execution

**Acceptance:** 10 concurrent jobs complete in ~same time as 1 (OpenRouter) or 4x faster (local with NUM_PARALLEL=4).

---

## High (ICE 300-500) — Do in Sprint 2-3

### TA-006: WebSocket for Real-Time UI Updates (Replace Polling)
**Labels:** `tech-audit`, `frontend`, `high`, `sprint-2`
**ICE:** 420 (Impact: 7, Confidence: 8, Ease: 7)

**Problem:** Health dashboard, job progress, vault sync all poll (30s, 5s, 60s).

**Fix:** Socket.io server + React hooks; rooms per resource (`job:{id}`, `vault`, `health`).

**Acceptance:** Job progress updates <100ms latency; zero polling.

---

### TA-007: RAG Embedding Cost Uncontrolled
**Labels:** `tech-audit`, `backend`, `high`, `sprint-2`
**ICE:** 392 (Impact: 7, Confidence: 8, Ease: 7)

**Problem:** Every vault write triggers re-embed; no cost visibility.

**Evidence:** No embedding cost tracking; `OPENAI_EMBEDDING_API_KEY` bills silently.

**Fix:**
1. Content-hash cache (already in `voice.ts` for TTS — extend to embeddings)
2. Batch embeddings (100 texts/request)
3. Cost tracker integration (ENG-021)

**Acceptance:** Embedding cost <$5/mo for 10k notes; visible in `/api/cost`.

---

### TA-008: Git Sync Conflict Resolution UX Missing
**Labels:** `tech-audit`, `frontend`, `high`, `sprint-2`
**ICE:** 378 (Impact: 7, Confidence: 9, Ease: 6)

**Problem:** Auto-rebase can fail silently; user sees stale data.

**Evidence:** `NAXION_AUTO_REBASE_RECOVERY=1` but no UI for conflicts.

**Fix:** Conflict detection → notification → three-way diff UI (ours/theirs/merged).

**Acceptance:** Conflict → toast → click → resolve → sync resumes.

---

### TA-009: Agent Tool Schema Not Versioned
**Labels:** `tech-audit`, `backend`, `high`, `sprint-3`
**ICE:** 360 (Impact: 8, Confidence: 6, Ease: 7)

**Problem:** Tool signatures change break existing agents silently.

**Fix:** Semantic versioning in tool registry; agent declares `toolVersion`; compat layer.

**Acceptance:** Agent from v0.1 runs on v0.2 without changes.

---

### TA-010: No Database Migrations for Vault Index
**Labels:** `tech-audit`, `backend`, `high`, `sprint-2`
**ICE:** 336 (Impact: 7, Confidence: 8, Ease: 6)

**Problem:** Schema changes (e.g., adding entity columns) require manual SQL.

**Fix:** Migration runner (like `db/migrate.ts`) with up/down, tracked in `.naxion/migrations.json`.

**Acceptance:** `pnpm migrate` applies pending; idempotent; rollback works.

---

## Medium (ICE 100-300) — Backlog / v0.2

### TA-011: Real-Time Collaboration (CRDT/Socket.io)
**Labels:** `tech-audit`, `frontend`, `medium`, `v0.2`
**ICE:** 280 (Impact: 8, Confidence: 5, Ease: 7)
**From research:** "Missing real-time collaboration feature"

**Fix:** Yjs + WebRTC or Socket.io + Yjs; per-document rooms; presence cursors.

---

### TA-012: Plugin Marketplace (Skills, Connectors, Templates)
**Labels:** `tech-audit`, `fullstack`, `medium`, `v0.2`
**ICE:** 252 (Impact: 7, Confidence: 6, Ease: 6)

**Fix:** Registry API + local install + sandboxed execution (vm2 or WASM).

---

### TA-013: Mobile-Responsive UI / PWA
**Labels:** `tech-audit`, `frontend`, `medium`, `v0.2`
**ICE:** 240 (Impact: 6, Confidence: 8, Ease: 5)

**Fix:** Tailwind responsive utilities; service worker; manifest; install prompt.

---

### TA-014: Enterprise SSO (SAML/OIDC)
**Labels:** `tech-audit`, `backend`, `medium`, `v0.2`
**ICE:** 210 (Impact: 7, Confidence: 5, Ease: 6)

**Fix:** `passport-saml` + `openid-client`; SCIM provisioning; role mapping.

---

### TA-015: Advanced RAG (Hybrid Search, Reranking)
**Labels:** `tech-audit`, `backend`, `medium`, `v0.2`
**ICE:** 200 (Impact: 7, Confidence: 5, Ease: 5)

**Fix:** pgvector + keyword (BM25) + cross-encoder reranker (local or API).

---

## Low (ICE < 100) — Icebox

| ID | Title | ICE | Notes |
|----|-------|-----|-------|
| TA-016 | GraphQL API | 84 | REST sufficient for now |
| TA-017 | Multi-region deploy | 72 | Single-region first |
| TA-018 | Custom model fine-tuning | 60 | Use OpenRouter for now |
| TA-019 | Voice cloning | 48 | Low demand |
| TA-020 | Blockchain integration | 12 | Not aligned |

---

## Quick Wins (ICE > 200, <1 day)

| ID | Title | Fix |
|----|-------|-----|
| TA-021 | Add `X-Request-Id` to all responses | 1-line middleware |
| TA-022 | Health check includes disk space | `df /app` in `/api/health` |
| TA-023 | Rate limit headers on all responses | `rate-limiter-flexible` |
| TA-024 | Disable `x-powered-by` | `app.disable('x-powered-by')` |
| TA-025 | Add `Content-Security-Policy-Report-Only` first | Iterate to enforced |

---

## Dependency Graph

```
TA-001 (502 fix) ──► TA-004 (logging) ──► TA-023 (rate limits)
       │
       ▼
TA-002 (Ollama warm) ──► TA-005 (parallel jobs) ──► TA-006 (WebSocket)
       │
       ▼
TA-003 (vault search) ──► TA-007 (RAG cost) ──► TA-010 (migrations)
       │
       ▼
TA-008 (git conflicts) ──► TA-011 (collab)
```

---

## Recommended Order (by Sprint)

| Sprint | Technical Audit Items |
|--------|----------------------|
| 1 | TA-001, TA-002, TA-004, TA-021-025 |
| 2 | TA-003, TA-006, TA-007, TA-008, TA-010 |
| 3 | TA-005, TA-009, TA-011 (spike) |
| 4 | TA-012-015 (design docs only) |