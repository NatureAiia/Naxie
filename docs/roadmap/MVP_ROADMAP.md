# Naxie MVP Roadmap — 8 Weeks (Oct 4 – Nov 28, 2026)

**Team:** 2-3 engineers | **Budget:** Bootstrapped | **Target:** Launchable MVP by Sprint 4

---

## Sprint Structure (2 weeks each)

| Sprint | Dates | Theme | Capacity |
|--------|-------|-------|----------|
| 1 | Oct 4–17 | Foundation & Core Chat | 2 eng × 10 days = 20 dev-days |
| 2 | Oct 18–31 | Workspace & Vault Integration | 20 dev-days |
| 3 | Nov 1–14 | Agents & Automation | 20 dev-days |
| 4 | Nov 15–28 | Polish, Docs, Launch Prep | 20 dev-days |

---

## Sprint 1: Foundation & Core Chat (Oct 4–17)

**Goal:** Working chat interface with local LLM, basic persona system, health monitoring

| Task | Owner | Days | Dependencies | Acceptance Criteria |
|------|-------|------|--------------|---------------------|
| Stabilize server boot (fix 502s, config validation) | Eng 1 | 2 | — | `/api/health` returns 200 consistently; no fatal config errors |
| Chat UI: message list, input, streaming responses | Eng 2 | 3 | Server boot | User sends message → sees streaming reply from Ollama |
| Persona selector (Naxie + 2 built-ins) | Eng 2 | 2 | Chat UI | Dropdown switches persona; system prompt changes |
| Model provider abstraction (Ollama + OpenRouter fallback) | Eng 1 | 3 | — | `OPENROUTER_API_KEY` enables cloud fallback automatically |
| Basic auth (session cookie + API key for machine) | Eng 1 | 2 | — | Browser gets session; `X-Api-Key` works for scripts |
| Health dashboard (LLM status, vault, peers) | Eng 2 | 2 | Model abstraction | `/api/status` shows green/red for each subsystem |
| CI: lint, typecheck, unit tests on PR | Eng 1 | 1 | — | GitHub Actions passes on main branch |

**Sprint 1 Definition of Done:** User opens localhost, selects persona, chats with streaming responses, sees system health.

---

## Sprint 2: Workspace & Vault (Oct 18–31)

**Goal:** Persistent knowledge vault with search, file upload, basic RAG

| Task | Owner | Days | Dependencies | Acceptance Criteria |
|------|-------|------|--------------|---------------------|
| Vault file explorer (tree view, open/edit/save .md) | Eng 2 | 3 | Sprint 1 auth | User browses vault, edits note, sees changes persist |
| Vault search (MiniSearch + grep fallback) | Eng 1 | 2 | Vault explorer | Search returns results in <500ms for 1k notes |
| RAG pipeline: chunk → embed → retrieve → inject | Eng 1 | 4 | Search, model abstraction | Chat with `@vault` tag retrieves relevant context |
| File upload (drag-drop → vault/media, base64 <25MB) | Eng 2 | 2 | Vault explorer | PDF/image uploads appear in vault, downloadable |
| Web fetch primitive (smartFetch: fetch → playwright → firecrawl) | Eng 1 | 2 | Model abstraction | Agent can retrieve and cite web sources |
| Git sync (commit queue + push/pull scheduler) | Eng 1 | 2 | Vault explorer | Edits auto-commit; manual push/pull buttons work |

**Sprint 2 Definition of Done:** User manages notes in vault, searches them, chats with vault-grounded answers, uploads files.

---

## Sprint 3: Agents & Automation (Nov 1–14)

**Goal:** Task delegation, background jobs, scheduled runs

| Task | Owner | Days | Dependencies | Acceptance Criteria |
|------|-------|------|--------------|---------------------|
| Job queue (BullMQ/Redis or in-memory fallback) | Eng 1 | 3 | Sprint 1 auth | Long-running tasks return `jobId`; SSE stream shows progress |
| Agent planner (plan → execute → synthesize loop) | Eng 1 | 4 | Job queue, RAG, web fetch | Complex prompt → multi-step plan → tool calls → final answer |
| OrgTask board (Kanban: backlog → in progress → done) | Eng 2 | 3 | Job queue | User creates task, assigns persona, watches execution |
| Scheduler (cron-style: daily brief, weekly rollup) | Eng 1 | 2 | Agent planner | `NAXION_TODO_BRIEF=1` fires at 6am, creates job |
| Telegram bridge (inbound → agent → reply) | Eng 2 | 2 | Agent planner | Message to bot → appears in chat → reply sent back |
| Basic cost tracking (per-model, per-request USD) | Eng 1 | 1 | Model abstraction | `/api/cost` shows spend by model/provider |

**Sprint 3 Definition of Done:** User delegates multi-step work to agents, sees progress, gets scheduled briefings, chats via Telegram.

---

## Sprint 4: Polish & Launch (Nov 15–28)

**Goal:** Production-ready MVP with docs, monitoring, landing page

| Task | Owner | Days | Dependencies | Acceptance Criteria |
|------|-------|------|--------------|---------------------|
| Error monitoring (Sentry or self-hosted) | Eng 1 | 1 | All sprints | Unhandled errors appear in dashboard with context |
| Structured logging (JSON, correlation IDs) | Eng 1 | 1 | All sprints | `kubectl logs` shows request traces |
| Onboarding flow (welcome → vault path → model test → first chat) | Eng 2 | 3 | Sprint 1-3 | New user completes setup in <3 minutes |
| Landing page (hero, features, deploy button) | Eng 2 | 2 | — | `pnpm build` produces static marketing page |
| Deploy docs (Docker, k8s, env checklist) | Eng 1 | 2 | All sprints | Fresh machine follows docs → running in <30 min |
| Security hardening (origin guard, rate limits, CSP) | Eng 1 | 2 | All sprints | `pentest` scan shows no critical/high findings |
| Launch checklist + rollback plan | Both | 1 | All sprints | Checklist signed off; rollback tested |

**Sprint 4 Definition of Done:** Fresh deploy passes smoke tests; new user onboarded; monitoring live; rollback verified.

---

## Cross-Cutting Concerns (ongoing)

| Area | Approach |
|------|----------|
| **Testing** | Unit for lib/ (target 70%); E2E for critical paths (chat, vault, jobs) |
| **Documentation** | Update `docs/` alongside code; ADR for architectural decisions |
| **Tech Debt** | Friday 2pm–4pm: refactor sprint; max 10% capacity |
| **Dependencies** | Pin versions; `pnpm audit` weekly; no new deps without PR approval |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Ollama model load too slow | High | Medium | Pre-warm at boot; `OLLAMA_NUM_PARALLEL=4`; OpenRouter fallback |
| Vault sync conflicts | Medium | High | Optimistic locking; manual resolve UI; `NAXION_AUTO_REBASE_RECOVERY=1` |
| Scope creep | High | High | **Hard rule:** No new features in Sprint 4; icebox for v0.2 |
| Engineer illness | Medium | High | Pair on critical path (job queue, agent loop); docs for bus factor |
| OpenRouter rate limits | Medium | Medium | Circuit breaker; exponential backoff; local-first routing |

---

## Success Metrics (MVP Launch)

| Metric | Target |
|--------|--------|
| Time to first chat response | <3s (local), <5s (cloud) |
| Vault search latency (1k notes) | <500ms p95 |
| Job queue throughput | 50 concurrent jobs |
| Crash-free sessions (7 days) | >99% |
| Deploy success rate (fresh env) | 100% |

---

## Post-MVP (v0.2+, Q1 2027)

- Real-time collaboration (CRDT/Socket.io)
- Multi-user workspaces with RBAC
- Plugin marketplace (skills, connectors, templates)
- Advanced RAG (pgvector, hybrid search)
- Mobile-responsive UI / PWA
- Enterprise SSO (SAML/OIDC)