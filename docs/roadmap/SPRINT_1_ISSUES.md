# Sprint 1 Issues — Foundation & Core Chat

## ENG-001: Stabilize Server Boot (Fix 502s, Config Validation)
**Labels:** `sprint-1`, `backend`, `critical`, `eng-1`
**Estimate:** 2 days

### Description
Server returns 502 on `/api/voice/realtime-session` and other routes when upstream services fail. Config validation exits on missing env in production.

### Tasks
- [ ] Audit all 502 responses in `routes/` — distinguish nginx vs app-level
- [ ] Increase readiness probe `initialDelaySeconds: 30` in `k8s/03-primary.yaml`
- [ ] Ensure `config.ready` reflects actual service health (Ollama reachable, vault writable)
- [ ] Add graceful degradation: return 503 with retry-after for transient upstream failures
- [ ] Verify `/api/health` never throws — wrap in try/catch

### Acceptance Criteria
- `/api/health` returns 200 within 5s of container start
- No fatal config errors in production mode
- Transient upstream failures return 503 with `Retry-After` header

---

## ENG-002: Chat UI — Message List, Input, Streaming Responses
**Labels:** `sprint-1`, `frontend`, `critical`, `eng-2`
**Estimate:** 3 days

### Description
Core chat interface with streaming token display, message history, persona context.

### Tasks
- [ ] Create `ChatView` component with virtualized message list
- [ ] Implement streaming response via SSE (`/api/chat/stream`)
- [ ] Add message persistence (localStorage + server sync)
- [ ] Keyboard shortcuts: Enter=send, Shift+Enter=newline, Escape=stop
- [ ] Loading states, error toasts, retry button

### Acceptance Criteria
- User sees tokens appear in real-time as model generates
- Message history survives page refresh
- Works on mobile viewport (375px)

---

## ENG-003: Persona Selector (Naxie + 2 Built-ins)
**Labels:** `sprint-1`, `frontend`, `high`, `eng-2`
**Estimate:** 2 days

### Description
Dropdown to switch active persona; updates system prompt and model params.

### Tasks
- [ ] Fetch `/api/personas` on mount; cache in React context
- [ ] Selector in chat header (avatar + name + model badge)
- [ ] On change: POST `/api/chat/persona` + reset conversation context
- [ ] Built-ins: Naxie (PA), Executive Assistant, Research Analyst
- [ ] Persist selection in session

### Acceptance Criteria
- Switching persona changes response style visibly
- Active persona shown in message metadata
- Selection persists across sessions

---

## ENG-004: Model Provider Abstraction (Ollama + OpenRouter Fallback)
**Labels:** `sprint-1`, `backend`, `critical`, `eng-1`
**Estimate:** 3 days

### Description
Unified interface for local (Ollama) and cloud (OpenRouter) with automatic fallback.

### Tasks
- [ ] Create `ModelProvider` interface: `generate()`, `stream()`, `health()`
- [ ] Implement `OllamaProvider` (existing `lib/llm.ts` logic)
- [ ] Implement `OpenRouterProvider` (existing `lib/openrouter.ts` logic)
- [ ] Router: try primary → on transient failure (429, 5xx, timeout) → fallback
- [ ] Config: `OPENROUTER_PROFILES` to control which tasks use cloud
- [ ] Metrics: track provider used per request for cost dashboard

### Acceptance Criteria
- `OPENROUTER_API_KEY` set → cloud used for configured profiles
- Fallback triggers on 429/5xx/timeout within 30s
- `/api/status/llm` shows both providers' health

---

## ENG-005: Basic Auth (Session Cookie + API Key)
**Labels:** `sprint-1`, `backend`, `high`, `eng-1`
**Estimate:** 2 days

### Description
Browser session auth + machine-to-machine API keys.

### Tasks
- [ ] Session middleware: signed cookie, 30-day TTL, refresh on activity
- [ ] API key format: `nax_<prefix>_<random>` with scopes (read, write, admin)
- [ ] `/api/auth/login` (email/password → session), `/api/auth/logout`
- [ ] `/api/auth/keys` CRUD (superadmin only)
- [ ] Origin guard exemption for valid API keys

### Acceptance Criteria
- Browser gets session cookie on login; subsequent requests authenticated
- `X-Api-Key: nax_full_xxx` works for curl/scripts
- Invalid/expired keys return 401 with `WWW-Authenticate`

---

## ENG-006: Health Dashboard (LLM, Vault, Peers)
**Labels:** `sprint-1`, `frontend`, `high`, `eng-2`
**Estimate:** 2 days

### Description
Single-page status view for all subsystems.

### Tasks
- [ ] Poll `/api/status` every 30s; show green/yellow/red badges
- [ ] LLM: Ollama model loaded, OpenRouter reachable, circuit breaker state
- [ ] Vault: path writable, git sync status, last commit
- [ ] Peers: list, last heartbeat, job capacity
- [ ] Click row → detail modal (recent errors, latency p95)

### Acceptance Criteria
- All subsystems visible at a glance
- Degraded state shows actionable error message
- Auto-refresh without full page reload

---

## ENG-007: CI Pipeline (Lint, Typecheck, Unit Tests)
**Labels:** `sprint-1`, `infra`, `medium`, `eng-1`
**Estimate:** 1 day

### Description
GitHub Actions workflow for PR validation.

### Tasks
- [ ] `.github/workflows/ci.yml`: checkout → setup-node → pnpm install → lint → typecheck → test
- [ ] Cache `node_modules` and `~/.cache/typescript`
- [ ] Fail on any error; annotate PR with failures
- [ ] Run on push to main + PRs

### Acceptance Criteria
- PR shows red/green check within 5 minutes
- TypeScript errors block merge
- Test coverage reported (target: 70% lib/)

---

## ENG-008: Sprint 1 Integration & Demo Prep
**Labels:** `sprint-1`, `integration`, `critical`, `all`
**Estimate:** 1 day (shared)

### Tasks
- [ ] End-to-end test: login → select persona → chat → see health dashboard
- [ ] Record 2-min demo video for stakeholders
- [ ] Update `docs/roadmap/SPRINT_1_RETRO.md` with velocity, blockers
- [ ] Sprint planning for Sprint 2