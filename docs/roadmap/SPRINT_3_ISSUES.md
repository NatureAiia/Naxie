# Sprint 3 Issues — Agents & Automation

## ENG-016: Job Queue (BullMQ/Redis or In-Memory Fallback)
**Labels:** `sprint-3`, `backend`, `critical`, `eng-1`
**Estimate:** 3 days

### Description
Reliable background job processing with progress streaming.

### Tasks
- [ ] Evaluate: BullMQ (needs Redis) vs in-memory + persistence
- [ ] For MVP: in-memory queue with JSONL persistence (`.naxion/jobs.jsonl`)
- [ ] Job schema: `id, kind, payload, status, progress, result, createdAt, updatedAt`
- [ ] API: POST `/api/jobs` → `{jobId}`, GET `/api/jobs/:id`, SSE `/api/jobs/:id/stream`
- [ ] Workers: config `NAXION_MAX_CONCURRENT_JOBS=2`, per-kind concurrency
- [ ] Retry: exponential backoff (max 3), dead-letter after exhaustion
- [ ] Metrics: queue depth, throughput, p95 latency, failure rate

### Acceptance Criteria
- 50 concurrent jobs processed without memory leak
- SSE stream shows real-time progress updates
- Server restart → pending jobs resume

---

## ENG-017: Agent Planner (Plan → Execute → Synthesize Loop)
**Labels:** `sprint-3`, `backend`, `critical`, `eng-1`
**Estimate:** 4 days

### Description
Core agent loop: decompose task → execute steps → synthesize answer.

### Tasks
- [ ] Planner prompt: output JSON plan with steps (tool, args, dependsOn)
- [ ] Executor: run steps in dependency order; parallelize independent
- [ ] Tools: `vault.search`, `vault.read`, `web.fetch`, `llm.generate`, `fs.*`
- [ ] Synthesizer: combine step outputs → final answer with citations
- [ ] Streaming: emit step start/complete/fail via job SSE
- [ ] Approval gate: steps with `requiresApproval: true` pause job
- [ ] Timeout: per-step (5min) and total (30min) with graceful cancel

### Acceptance Criteria
- "Research competitors and create comparison table" → plan → execute → markdown table
- Failed step → retry or skip (configurable)
- Approval pause → user clicks "Approve" in UI → job continues

---

## ENG-018: OrgTask Board (Kanban: Backlog → In Progress → Done)
**Labels:** `sprint-3`, `frontend`, `high`, `eng-2`
**Estimate:** 3 days

### Description
Visual task management for delegated agent work.

### Tasks
- [ ] Board view: 3 columns, drag-drop between (sortable)
- [ ] Card: title, persona, status, progress bar, ETA, assignee
- [ ] Create task modal: natural language → planner generates plan preview
- [ ] Click card → detail drawer: plan, logs, artifacts, approve/reject buttons
- [ ] Filter: by persona, status, date range
- [ ] Real-time updates via job SSE (no polling)

### Acceptance Criteria
- User creates "Analyze Q3 finances" → appears in Backlog → drag to In Progress → agent runs
- Progress bar reflects actual step completion
- Completed task shows artifact (report, chart, file)

---

## ENG-019: Scheduler (Cron-Style: Daily Brief, Weekly Rollup)
**Labels:** `sprint-3`, `backend`, `high`, `eng-1`
**Estimate:** 2 days

### Description
Time-based job triggering with timezone support.

### Tasks
- [ ] Scheduler engine: node-cron or custom (avoid heavy deps)
- [ ] Built-in schedules: `todo-brief` (6am), `weekly-rollup` (Sun 9am)
- [ ] Config: `NAXION_TODO_BRIEF_HOUR`, `NAXION_WEEKLY_ROLLUP_DOW/HOUR`
- [ ] Timezone: `NAXION_TIMEZONE` (default UTC); store per-user later
- [ ] Manual trigger: POST `/api/scheduler/run/:name`
- [ ] History: last 50 runs with status, duration, output summary

### Acceptance Criteria
- Daily brief fires at configured hour, creates job, delivers via Telegram
- Manual trigger works for testing
- Missed runs (downtime) → catch-up on next tick (optional)

---

## ENG-020: Telegram Bridge (Inbound → Agent → Reply)
**Labels:** `sprint-3`, `backend`, `high`, `eng-2`
**Estimate:** 2 days

### Description
Telegram bot that forwards messages to agent and sends replies.

### Tasks
- [ ] Webhook endpoint: `/api/telegram/webhook` (verify secret token)
- [ ] Inbound: parse message → create chat job with `source=telegram`
- [ ] Persona: `NAXION_TELEGRAM_PERSONA` (default: naxie)
- [ ] Outbound: job result → `sendMessage` with markdown formatting
- [ ] Rate limit: 30 msg/min per chat; queue excess
- [ ] Commands: `/start`, `/help`, `/status`, `/brief`

### Acceptance Criteria
- User messages bot → appears in Naxie chat → reply sent back
- `/brief` triggers daily brief job
- Handles media (photos, documents) → upload to vault

---

## ENG-021: Basic Cost Tracking (Per-Model, Per-Request USD)
**Labels:** `sprint-3`, `backend`, `medium`, `eng-1`
**Estimate:** 1 day

### Description
Track LLM spend for budgeting and optimization.

### Tasks
- [ ] Cost table: model → $/1k input, $/1k output (update quarterly)
- [ ] Middleware: wrap all `llm.generate()` calls → record tokens, cost
- [ ] Store: `.naxion/costs.jsonl` (date, model, provider, inputTok, outputTok, usd, jobId)
- [ ] API: GET `/api/cost?from=&to=&groupBy=model|provider|day`
- [ ] Dashboard: sparkline (7d/30d), top models, projected monthly

### Acceptance Criteria
- Every LLM call logged with USD cost
- `/api/cost` returns aggregated data in <200ms
- Monthly projection within 20% of actual bill

---

## ENG-022: Sprint 3 Integration & Demo Prep
**Labels:** `sprint-3`, `integration`, `critical`, `all`
**Estimate:** 1 day (shared)

### Tasks
- [ ] E2E: create OrgTask → watch agent execute → approve → see artifact
- [ ] Demo: scheduled brief → Telegram → user reads on phone
- [ ] Retro + Sprint 4 planning