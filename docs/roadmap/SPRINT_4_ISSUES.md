# Sprint 4 Issues — Polish & Launch

## ENG-023: Error Monitoring (Sentry or Self-Hosted)
**Labels:** `sprint-4`, `infra`, `high`, `eng-1`
**Estimate:** 1 day

### Description
Production error visibility with context.

### Tasks
- [ ] Option A: Sentry (free tier: 5k events/mo) — `SENTRY_DSN` env
- [ ] Option B: Self-hosted (GlitchTip on Railway/Render) — no data egress
- [ ] Integrate: `Sentry.init()` in `index.ts`; capture unhandled rejections
- [ ] Context: userId, jobId, requestId, persona, model, vault path
- [ ] Source maps: upload in CI for readable stack traces
- [ ] Alerts: >10 errors/5min → Telegram webhook

### Acceptance Criteria
- Unhandled error appears in dashboard within 30s
- Stack trace shows original source (not transpiled)
- No PII in error payloads (sanitized)

---

## ENG-024: Structured Logging (JSON, Correlation IDs)
**Labels:** `sprint-4`, `infra`, `high`, `eng-1`
**Estimate:** 1 day

### Description
Machine-parseable logs for debugging and analytics.

### Tasks
- [ ] Logger: Pino (fast, JSON, child loggers)
- [ ] Format: `{ level, time, pid, hostname, reqId, userId, jobId, msg, ...meta }`
- [ ] Middleware: generate `reqId` (uuid v7), attach to `res.setHeader('X-Request-Id')`
- [ ] Child loggers per module: `log.child({ module: 'voice' })`
- [ ] Redaction: strip `Authorization`, `Cookie`, `apiKey`, `password` fields
- [ ] Output: stdout (container) + file (`.naxion/logs/app-<date>.log`, rotate daily)

### Acceptance Criteria
- `kubectl logs -f` shows JSON lines with `reqId`
- Grep by `reqId` shows full request trace
- No secrets in logs (verified by `grep -r "sk-" .naxion/logs/`)

---

## ENG-025: Onboarding Flow (Welcome → Vault Path → Model Test → First Chat)
**Labels:** `sprint-4`, `frontend`, `critical`, `eng-2`
**Estimate:** 3 days

### Description
Zero-config first-run experience.

### Tasks
- [ ] Detect first run: `!config.ready || !existsSync(vaultPath)`
- [ ] Step 1: Welcome screen (logo, tagline, "Get Started")
- [ ] Step 2: Vault path picker (browse or create new; default `./vault`)
- [ ] Step 3: Model test — shows Ollama status, pulls default model if missing
- [ ] Step 4: Optional OpenRouter key (skip allowed)
- [ ] Step 5: First chat — pre-filled "Hello, Naxie!" → auto-send → show response
- [ ] Completion: writes `.naxion/onboarding.json` (completedAt, version)
- [ ] Skip: "I'll configure later" → minimal setup, redirect to settings

### Acceptance Criteria
- Fresh install → working chat in <3 minutes
- Each step has clear success/failure feedback
- Skip path still produces functional app

---

## ENG-026: Landing Page (Hero, Features, Deploy Button)
**Labels:** `sprint-4`, `frontend`, `medium`, `eng-2`
**Estimate:** 2 days

### Description
Static marketing page served at `/` when `SERVE_WEB=1`.

### Tasks
- [ ] Hero: logo, headline, subhead, "Deploy to Cloud" button (links to deploy docs)
- [ ] Features: 4 cards (Local-First, Agents, Vault, Extensible) with icons
- [ ] Screenshots: chat, vault, board (use real screenshots from app)
- [ ] Footer: GitHub stars, Discord, docs, license
- [ ] Build: `pnpm -F naxion-web build` → `web/dist/index.html`
- [ ] SEO: meta tags, Open Graph, sitemap.xml

### Acceptance Criteria
- Page loads in <1s (static, cached)
- "Deploy" button links to working deploy guide
- Responsive down to 320px

---

## ENG-027: Deploy Docs (Docker, k8s, Env Checklist)
**Labels:** `sprint-4`, `docs`, `high`, `eng-1`
**Estimate:** 2 days

### Description
Complete deployment guide for fresh machine.

### Tasks
- [ ] `docs/deploy/DOCKER.md`: `docker build`, `docker run --env-file`, health check
- [ ] `docs/deploy/K8S.md`: kubectl apply, ingress, secrets, PVC, scaling
- [ ] `docs/deploy/ENV_CHECKLIST.md`: required vs optional, examples, validation
- [ ] `docs/deploy/TROUBLESHOOTING.md`: common failures (port, vault, ollama, perms)
- [ ] Verify: fresh VM → follow docs → running in <30 min

### Acceptance Criteria
- New contributor deploys successfully without help
- All env vars documented with defaults
- Troubleshooting covers top 10 issues

---

## ENG-028: Security Hardening (Origin Guard, Rate Limits, CSP)
**Labels:** `sprint-4`, `security`, `critical`, `eng-1`
**Estimate:** 2 days

### Description
Production-grade security baseline.

### Tasks
- [ ] Origin guard: `NAXION_ALLOWED_HOSTS` strict; `NAXION_ORIGIN_GUARD=1` default
- [ ] Rate limits: 100 req/min/IP (API), 10 req/min/IP (auth), 200 req/min/IP (static)
- [ ] CSP: `script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:`
- [ ] Headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
- [ ] Helmet.js equivalent (manual for control)
- [ ] Pentest: run `pnpm pentest:scan` — zero critical/high

### Acceptance Criteria
- `pentest` scan passes (no critical/high)
- CSP blocks inline scripts (verified in browser console)
- Rate limit returns 429 with `Retry-After`

---

## ENG-029: Launch Checklist + Rollback Plan
**Labels:** `sprint-4`, `release`, `critical`, `all`
**Estimate:** 1 day (shared)

### Tasks
- [ ] Pre-launch checklist (all sprints):
  - [ ] All ENG-XXX issues closed
  - [ ] CI green on main
  - [ ] Deploy docs verified on clean VM
  - [ ] Pentest scan clean
  - [ ] Cost tracking shows <$50/mo projected
  - [ ] Onboarding completes in <3 min
  - [ ] Backup: vault git push confirmed
- [ ] Rollback plan:
  - [ ] Tag release: `git tag v0.1.0`
  - [ ] Docker image tagged: `naxion:v0.1.0`
  - [ ] k8s rollback: `kubectl rollout undo statefulset/naxion-primary`
  - [ ] Vault rollback: `git revert` + force push (documented)
  - [ ] DNS rollback: TTL <300s, old IP ready
- [ ] Launch day runbook: who, what, when, communication channels

### Acceptance Criteria
- Checklist 100% complete
- Rollback tested in staging (15 min max)
- Launch communicated to stakeholders

---

## ENG-030: Sprint 4 Integration & Launch
**Labels:** `sprint-4`, `integration`, `critical`, `all`
**Estimate:** 1 day (shared)

### Tasks
- [ ] Full E2E regression: all sprints
- [ ] Launch!
- [ ] Post-launch retro (1 week later)
- [ ] Plan v0.2 backlog