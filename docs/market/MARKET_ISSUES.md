# Market Research — GitHub Issue Templates

---

## MR-001: Competitor Feature Matrix (Living Doc)
**Labels:** `market-research`, `research`, `sprint-1`
**Assignee:** @founder
**Estimate:** 4 hours

### Description
Maintain living comparison of Naxie vs top 10 competitors across 30+ dimensions.

### Deliverable
`docs/market/COMPETITOR_MATRIX.csv` + `docs/market/COMPETITOR_MATRIX.md`

### Dimensions
| Category | Dimensions |
|----------|------------|
| **Model** | Local, cloud, multi-provider, model switching, vision, voice |
| **Agents** | Autonomous, planning, tool use, memory, multi-agent, scheduling |
| **Data** | Vault/notes, RAG, sync, encryption, export, version control |
| **Tools** | Shell, web, APIs, code exec, browser, custom tools |
| **UX** | Chat, canvas, CLI, mobile, PWA, themes, shortcuts |
| **Deploy** | Self-host, cloud, Docker, k8s, binary, mobile |
| **Auth** | Local, OIDC, SAML, API keys, RBAC, teams |
| **Cost** | Free tier, pricing model, local cost, cloud cost |
| **Ecosystem** | Plugins, templates, marketplace, API, community |

### Process
1. Score each competitor 0-5 per dimension
2. Highlight Naxie differentiators (green) / gaps (red)
3. Update monthly; link in README

### Acceptance Criteria
- [ ] Matrix covers 10 competitors × 30 dimensions
- [ ] Published as markdown table in docs
- [ ] Source links for each score

---

## MR-002: Target Segment Validation Survey
**Labels:** `market-research`, `research`, `sprint-2`
**Assignee:** @founder
**Estimate:** 1 day

### Description
Validate primary/secondary segments with real user interviews.

### Method
- 20 interviews (10 solo operators, 5 team leads, 5 knowledge workers)
- 30 min each; structured script
- Record + transcribe (consent)

### Script Outline
1. **Current workflow:** "Walk me through how you handle [research/admin/coding] today"
2. **Pain points:** "What's the most frustrating part?"
3. **Tools:** "What do you use? What's missing?"
4. **AI usage:** "Do you use ChatGPT/Claude/Copilot? For what?"
5. **Local vs cloud:** "Any concerns about data leaving your machine?"
6. **Naxie concept:** Show 2-min demo → "Would you try this? Pay for this?"
7. **Pricing:** "What's fair for Pro? For Team?"

### Deliverable
`docs/market/SEGMENT_VALIDATION.md` with:
- Segment profiles (validated/invalidated)
- Top 10 pain points ranked
- Willingness-to-pay distribution
- Feature priority from users

### Acceptance Criteria
- [ ] 20 interviews completed
- [ ] Themes coded and quantified
- [ ] Segment definitions updated or confirmed

---

## MR-003: Pricing A/B Test Design
**Labels:** `market-research`, `growth`, `sprint-4`
**Assignee:** @founder
**Estimate:** 2 hours

### Description
Design pricing experiment for Pro tier launch.

### Hypothesis
`$15/mo` maximizes revenue (volume × price) vs $20/$25.

### Test Design
| Variant | Price | Traffic % | Success Metric |
|---------|-------|-----------|----------------|
| A | $15/mo | 33% | Revenue per visitor |
| B | $20/mo | 33% | Revenue per visitor |
| C | $25/mo | 34% | Revenue per visitor |

### Implementation
- Feature flag: `PRICING_VARIANT`
- Track: visits → trial start → conversion → revenue
- Minimum sample: 1000 visitors/variant
- Duration: 4 weeks or statistical significance

### Acceptance Criteria
- [ ] Variant assignment persistent (cookie)
- [ ] Analytics events fire correctly
- [ ] Dashboard shows real-time results

---

## MR-004: Launch Content Pack
**Labels:** `market-research`, `marketing`, `sprint-4`
**Assignee:** @founder
**Estimate:** 2 days

### Description
Ready-to-publish launch assets.

### Assets
| Asset | Format | Channel | Owner |
|-------|--------|---------|-------|
| Launch blog post | MD + images | Blog, Dev.to, HN | @founder |
| Demo video 1: Daily brief | MP4 (2 min) | Twitter, YouTube | @founder |
| Demo video 2: Vault → Agent | MP4 (2 min) | Twitter, YouTube | @founder |
| Demo video 3: Parallel agents | MP4 (2 min) | Twitter, YouTube | @founder |
| Twitter thread | 15 tweets | Twitter/X | @founder |
| HN Show HN post | Text | Hacker News | @founder |
| Discord announcement | Embed | Discord | @founder |
| Email to waitlist | HTML | ConvertKit | @founder |
| One-pager PDF | PDF | Sales, investors | @founder |

### Key Messages
1. **"Local-first"** — your data, your machine, your rules
2. **"Agents that do work"** — not just chat
3. **"Free forever locally"** — no lock-in
4. **"Built for operators"** — not demos

### Acceptance Criteria
- [ ] All assets reviewed and approved
- [ ] Scheduled for launch day
- [ ] Tracking links (UTM) on all CTAs

---

## MR-005: Community Growth Plan
**Labels:** `market-research`, `community`, `sprint-3`
**Assignee:** @founder
**Estimate:** 4 hours

### Description
Discord + GitHub community strategy.

### Structure
| Channel | Purpose | Moderation |
|---------|---------|------------|
| #general | Chat, intros | Light |
| #showcase | User demos, templates | Curated |
| #help | Questions, debugging | Community + team |
| #plugins | Custom skills, connectors | Reviewed |
| #announcements | Releases, updates | Team only |
| #feedback | Feature requests, voting | Triaged weekly |

### Growth Tactics
1. **Week 1:** Invite 50 beta users → seed content
2. **Week 2:** "Template Tuesday" — share one agent template
3. **Week 3:** "Office Hours" — live Q&A (recorded)
4. **Week 4:** "Build in Public" — share roadmap decisions
5. **Ongoing:** Monthly "Ship Showcase" — best community agent wins swag

### Metrics
- Members: 500 by Month 3
- Daily active: 50
- Template submissions: 10/month
- Help resolution: <4h median

### Acceptance Criteria
- [ ] Discord server created with channels
- [ ] Welcome flow (roles, rules, resources)
- [ ] First 3 events scheduled

---

## MR-006: SEO / Content Strategy
**Labels:** `market-research`, `marketing`, `sprint-3`
**Assignee:** @founder
**Estimate:** 1 day

### Target Keywords (High Intent, Low Competition)
| Keyword | Volume | Difficulty | Content |
|---------|--------|------------|---------|
| "local AI agent" | 1.2k | 12 | Guide |
| "self-hosted AI assistant" | 800 | 8 | Comparison |
| "Ollama agent framework" | 600 | 10 | Tutorial |
| "AI automation local" | 500 | 15 | Guide |
| "private AI knowledge base" | 400 | 18 | Guide |
| "Naxie vs AnythingLLM" | 50 | 5 | Battlecard |

### Content Calendar (Month 1-3)
| Week | Topic | Keyword | Format |
|------|-------|---------|--------|
| 1 | "Why I built a local-first AI agent" | local AI agent | Blog |
| 2 | "Self-hosted AI: Complete guide 2026" | self-hosted AI assistant | Guide |
| 3 | "Running 10 agents on a $5 VPS" | Ollama agent framework | Tutorial |
| 4 | "Local vs Cloud AI: Decision matrix" | AI automation local | Guide |
| 5 | "Building a private knowledge base with AI" | private AI knowledge base | Guide |
| 6 | "Naxie vs AnythingLLM vs Khoj" | Naxie vs AnythingLLM | Battlecard |

### Acceptance Criteria
- [ ] 6 articles published
- [ ] Each ranks top 20 for target keyword (Month 3)
- [ ] Total organic traffic >500/mo

---

## MR-007: Enterprise Readiness Checklist
**Labels:** `market-research`, `enterprise`, `v0.2`
**Assignee:** @founder
**Estimate:** 4 hours

### Description
Gap analysis for enterprise sales.

### Checklist
| Requirement | Status | Effort | Notes |
|-------------|--------|--------|-------|
| SAML/OIDC SSO | ❌ | 2 weeks | TA-014 |
| SCIM provisioning | ❌ | 1 week | |
| Audit logging (immutable) | ⚠️ Partial | 1 week | Extend auditRouter |
| RBAC (roles, permissions) | ⚠️ Partial | 1 week | Extend enterprise-auth |
| Data residency controls | ✅ Local | — | Core feature |
| Air-gapped deploy | ✅ | — | Docker offline |
| SOC2 Type II | ❌ | 6 months | Post-revenue |
| Penetration test | ❌ | 2 weeks | Third-party |
| DPA / BAA templates | ❌ | 1 week | Legal |
| SLA (99.9%) | ❌ | — | Cloud only |

### Acceptance Criteria
- [ ] Checklist complete with owners
- [ ] Prioritized for v0.2 roadmap
- [ ] Budget estimated

---

## MR-008: Partner / Integration Map
**Labels:** `market-research`, `partnerships`, `v0.2`
**Assignee:** @founder
**Estimate:** 2 hours

### Target Integrations (Priority Order)
| Partner | Value | Contact | Status |
|---------|-------|---------|--------|
| **Ollama** | Local model runtime | @ollama | Community |
| **OpenRouter** | Cloud model marketplace | @openrouter | API partner |
| **Obsidian** | Vault frontend | @obsidian | Plugin |
| **VS Code** | Editor integration | @vscode | Extension |
| **Raycast** | Launcher integration | @raycast | Extension |
| **Railway/Render/Fly** | One-click deploy | BD | Outreach |
| **Supabase** | pgvector backend | @supabase | Tech partner |
| **Cert-manager/Let's Encrypt** | TLS automation | — | k8s native |

### Acceptance Criteria
- [ ] 5+ partnerships with co-marketing
- [ ] Integration docs published
- [ ] Joint webinar / blog post each