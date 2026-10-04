# Business Model — Pricing, Revenue & Go-to-Market

**Date:** Oct 2026 | **Status:** Hypothesis — validate with MR-002 survey | **Constraint:** Bootstrapped, 2-3 eng, 8-week MVP

---

## Executive Summary

**Model:** Open-core SaaS with local-first free tier.

**Thesis:** Operators will pay for cloud convenience, team collaboration, and enterprise controls — while keeping the local core free to build trust and adoption.

**Year 1 revenue target:** $350k ARR (based on market research SAM/SOM)

---

## Pricing Tiers

### Tier Comparison

| Feature | Community (Free) | Pro ($15/mo) | Team ($50/mo, 5 seats) | Enterprise (Custom) |
|---------|-----------------|--------------|------------------------|---------------------|
| **Models** | | | | |
| Local Ollama | ✅ | ✅ | ✅ | ✅ |
| OpenRouter fallback | ❌ | ✅ | ✅ | ✅ |
| Dedicated cloud provider | ❌ | ❌ | ✅ | ✅ |
| Custom model endpoints | ❌ | ✅ | ✅ | ✅ |
| **Knowledge** | | | | |
| Vault (local) | ✅ | ✅ | ✅ | ✅ |
| RAG (embeddings) | ✅ (local) | ✅ (local+cloud) | ✅ | ✅ (hybrid) |
| Cloud vault sync | ❌ | ✅ | ✅ (shared) | ✅ (private) |
| Version history | 7 days | 90 days | 1 year | Unlimited |
| **Agents** | | | | |
| Agent planner | ✅ | ✅ | ✅ | ✅ |
| Tool execution | ✅ | ✅ | ✅ | ✅ |
| Scheduled runs | 3 | Unlimited | Unlimited | Unlimited |
| Parallel jobs | 2 | 10 | 50 | Custom |
| Custom tools/skills | ✅ | ✅ | ✅ | ✅ |
| **Automation** | | | | |
| Telegram bridge | ❌ | ✅ | ✅ | ✅ |
| Email bridge | ❌ | ✅ | ✅ | ✅ |
| Webhooks | ❌ | ✅ | ✅ | ✅ |
| API access | Read-only | Full | Full | Full |
| **Collaboration** | | | | |
| Personas | 1 | 5 | 20 | Unlimited |
| Team members | 1 | 1 | 5 | Unlimited |
| Shared vault | ❌ | ❌ | ✅ | ✅ |
| Role-based access | ❌ | ❌ | ✅ | ✅ |
| Audit log | ❌ | ❌ | ✅ | ✅ |
| **Support** | | | | |
| Community Discord | ✅ | ✅ | ✅ | ✅ |
| Email support | ❌ | ✅ | ✅ | ✅ (priority) |
| Onboarding call | ❌ | ❌ | ✅ | ✅ (dedicated) |
| SLA | ❌ | ❌ | ❌ | 99.9% |
| **Deployment** | | | | |
| Self-hosted | ✅ | ✅ | ✅ | ✅ |
| Managed cloud | ❌ | ✅ | ✅ | ✅ (private VPC) |
| Air-gapped | ❌ | ❌ | ❌ | ✅ |
| SSO/SAML | ❌ | ❌ | ❌ | ✅ |
| SCIM provisioning | ❌ | ❌ | ❌ | ✅ |

### Feature Gating Implementation

```typescript
// lib/access.ts
export const TIERS = {
  community: {
    maxPersonas: 1,
    maxScheduledRuns: 3,
    maxConcurrentJobs: 2,
    cloudSync: false,
    telegramBridge: false,
    cloudFallback: false,
    versionHistoryDays: 7,
  },
  pro: {
    maxPersonas: 5,
    maxScheduledRuns: Infinity,
    maxConcurrentJobs: 10,
    cloudSync: true,
    telegramBridge: true,
    cloudFallback: true,
    versionHistoryDays: 90,
  },
  team: {
    maxPersonas: 20,
    maxScheduledRuns: Infinity,
    maxConcurrentJobs: 50,
    cloudSync: true,
    sharedVault: true,
    rbac: true,
    auditLog: true,
    versionHistoryDays: 365,
  },
  enterprise: {
    maxPersonas: Infinity,
    maxScheduledRuns: Infinity,
    maxConcurrentJobs: Infinity,
    everything: true,
    sso: true,
    scim: true,
    airgapped: true,
    sla: 0.999,
  },
};

export function enforceTier(userId: string, feature: string): void {
  const tier = getUserTier(userId);
  const config = TIERS[tier];
  if (!config[feature]) {
    throw new TierError(`Feature '${feature}' requires Pro plan`, {
      upgradeUrl: '/settings/billing?feature=' + feature,
    });
  }
}
```

---

## Revenue Projections (12 Months)

### Assumptions

| Metric | Value | Source |
|--------|-------|--------|
| Month 1 GitHub stars | 500 | Launch target |
| Month 6 GitHub stars | 3,000 | Organic growth |
| Star → signup conversion | 10% | Industry benchmark |
| Signup → free user | 100% | Open core |
| Free → Pro conversion | 3% | SaaS benchmark (2-5%) |
| Pro → Team conversion | 5% | Upsell benchmark |
| Monthly churn (Pro) | 5% | SaaS benchmark (3-7%) |
| Monthly churn (Team) | 3% | Higher commitment |
| ARPU (Pro) | $15 | Pricing |
| ARPU (Team) | $50 | Pricing |

### Monthly Projection

| Month | Stars | Free Users | Pro Users | Team Accounts | MRR | Cumulative |
|-------|-------|------------|-----------|---------------|-----|------------|
| 1 (Oct) | 500 | 50 | 2 | 0 | $30 | $30 |
| 2 (Nov) | 1,000 | 100 | 5 | 1 | $125 | $155 |
| 3 (Dec) | 1,500 | 150 | 8 | 2 | $220 | $375 |
| 4 (Jan) | 2,000 | 200 | 12 | 3 | $330 | $705 |
| 5 (Feb) | 2,500 | 250 | 17 | 4 | $455 | $1,160 |
| 6 (Mar) | 3,000 | 300 | 23 | 5 | $595 | $1,755 |
| 7 (Apr) | 3,500 | 350 | 30 | 7 | $790 | $2,545 |
| 8 (May) | 4,000 | 400 | 38 | 9 | $1,020 | $3,565 |
| 9 (Jun) | 4,500 | 450 | 47 | 11 | $1,295 | $4,860 |
| 10 (Jul) | 5,000 | 500 | 57 | 13 | $1,615 | $6,475 |
| 11 (Aug) | 5,500 | 550 | 68 | 15 | $1,990 | $8,465 |
| 12 (Sep) | 6,000 | 600 | 80 | 18 | $2,410 | $10,875 |

**Year 1 ARR (Month 12):** $28,920
**Year 1 cumulative revenue:** $10,875

> Note: Conservative. Enterprise contracts ($5k-50k/yr) not included — they arrive Year 2.

### Enterprise Revenue (Year 2+)

| Scenario | Accounts | Avg Deal | Annual Revenue |
|----------|----------|----------|----------------|
| Conservative | 3 | $10,000 | $30,000 |
| Moderate | 5 | $15,000 | $75,000 |
| Optimistic | 10 | $20,000 | $200,000 |

---

## Cost Structure (Monthly)

### Fixed Costs

| Item | Cost | Notes |
|------|------|-------|
| Cloud hosting (managed option) | $50-200 | Railway/Render for Pro users |
| Supabase (pgvector) | $25 | Team shared vault |
| Sentry | $0 | Free tier (5k events) |
| Domain + DNS | $2 | Annual amortized |
| Email (Resend/Postmark) | $20 | Transactional |
| **Subtotal** | **$100-300** | |

### Variable Costs (per paying user)

| Item | Cost/User/Month | Notes |
|------|-----------------|-------|
| OpenRouter (user's own key) | $0 | User pays directly |
| Embeddings (user's own key) | $0 | User pays directly |
| Managed hosting (Pro) | $1-3 | Shared instance |
| Payment processing (Stripe) | 2.9% + $0.30 | Per transaction |
| Support (email) | ~$5 | Time cost |

### Infrastructure (Self-Hosted Users — $0 to us)

| Item | Notes |
|------|-------|
| Ollama | Runs on user's machine |
| Model weights | Downloads from Ollama registry |
| Vault storage | User's filesystem |
| **Total cost to us** | **$0** |

### Break-Even Analysis

| Scenario | Fixed Costs | Break-Even (Pro users) |
|----------|-------------|------------------------|
| Low | $100/mo | 7 Pro users |
| Medium | $200/mo | 14 Pro users |
| High | $300/mo | 21 Pro users |

**Target:** Break even by Month 4-6 (12-17 Pro users).

---

## Revenue Streams

### Primary: SaaS Subscriptions (80% Year 1)

- **Pro:** $15/mo individual
- **Team:** $50/mo for 5 seats ($10/seat)
- **Annual discounts:** 20% off (Pro $144/yr, Team $480/yr)
- **Billing:** Stripe, monthly or annual

### Secondary: Managed Hosting (15% Year 1)

- **Pro Managed:** $20/mo ($15 tier + $5 hosting convenience)
- **Team Managed:** $70/mo ($50 tier + $20 hosting)
- **Value prop:** "No server management, automatic updates, daily backups"

### Tertiary: Enterprise Contracts (5% Year 1, 40% Year 2+)

- **Annual contracts:** $10k-50k/yr
- **Includes:** SSO, SCIM, air-gapped, SLA, dedicated support, custom features
- **Sales cycle:** 3-6 months (start conversations Month 6)

### Future: Marketplace (Year 2+)

- **Paid templates:** 70/30 split (developer/NaxionAI)
- **Premium skills/plugins:** 70/30 split
- **Revenue:** $100-1,000 per premium item

---

## Go-to-Market Strategy

### Phase 1: Launch (Weeks 1-8) — "Show, Don't Tell"

**Goal:** 500 GitHub stars, 50 Discord members, 10 DAU

| Week | Action | Channel |
|------|--------|---------|
| 1 | Launch: README, demo videos, blog post | GitHub, Twitter, HN |
| 2 | Show HN post + Reddit r/selfhosted | Hacker News, Reddit |
| 3 | Technical blog: "Building local-first AI agents" | Dev.to, Medium |
| 4 | Twitter thread: 10 things Naxie can automate | Twitter/X |
| 5 | YouTube demo: Full workflow (3 min) | YouTube |
| 6 | Guest post: "Why I moved from Notion AI" | Obsidian forum |
| 7 | Open source showcase: Submit to awesome lists | GitHub |
| 8 | Retrospective + Phase 2 planning | Internal |

**Content themes:**
1. **Privacy:** "Your data never leaves your machine"
2. **Autonomy:** "Agents that do work, not just chat"
3. **Simplicity:** "Deploy in 5 minutes, not 5 hours"
4. **Cost:** "Free forever locally; $15 when you want cloud"

### Phase 2: Traction (Months 2-3) — "Enable Champions"

**Goal:** 2k stars, 200 DAU, 10 Pro subscribers

| Action | Details |
|--------|---------|
| Community Discord | Active channels, weekly events |
| Template marketplace | 10 curated agent templates |
| One-click deploy | Railway, Render, Fly.io buttons |
| Integration docs | Ollama, OpenRouter, Obsidian, Telegram |
| Customer interviews | 20 users → pain points → features |
| Case study: "How X saved 10 hrs/week" | Published on blog |

### Phase 3: Scale (Months 4-6) — "Team + Cloud"

**Goal:** $1k MRR, 5 teams, 500 DAU

| Action | Details |
|--------|---------|
| Team features | Shared vault, RBAC, billing |
| Managed cloud option | $20/mo Pro, $70/mo Team |
| Partnerships | Ollama, OpenRouter co-marketing |
| Enterprise pilots | 3 design partners (free → paid) |
| Content engine | 2 posts/week (blog + social) |

### Phase 4: Revenue (Months 7-12) — "Convert + Expand"

**Goal:** $2.5k MRR, 80 Pro, 18 Team, 3 Enterprise

| Action | Details |
|--------|---------|
| Pricing A/B test | $15 vs $20 vs $25 |
| Annual plans | 20% discount for yearly commitment |
| Expansion revenue | Per-seat pricing for Team |
| Enterprise sales | Direct outreach, demos, pilots |
| Retention | Churn surveys, win-back campaigns |

---

## Key Metrics & Targets

### North Star: Weekly Active Users (WAU)

| Month | WAU Target | Source |
|-------|------------|--------|
| 1 | 10 | Launch spike |
| 3 | 50 | Organic growth |
| 6 | 150 | Content + referrals |
| 12 | 400 | Enterprise + Team |

### Funnel Metrics

| Stage | Metric | Month 3 Target | Month 6 Target |
|-------|--------|----------------|----------------|
| Awareness | GitHub stars | 1,500 | 3,000 |
| Interest | Website visits | 2,000/mo | 5,000/mo |
| Trial | Signups (free) | 150 | 400 |
| Activation | First chat completed | 60% | 70% |
| Conversion | Free → Pro | 5% | 8% |
| Retention | Pro churn (monthly) | <7% | <5% |
| Expansion | Pro → Team | 5% | 10% |
| Revenue | MRR | $330 | $1,615 |

### Health Metrics

| Metric | Target | Frequency |
|--------|--------|-----------|
| Deploy success rate | >90% | Weekly |
| Time to first value | <10 min | Onboarding survey |
| Support response time | <4 hours | Daily |
| NPS | >40 | Monthly survey |
| Crash-free sessions | >99% | Daily (Sentry) |

---

## Risk Mitigation (Business)

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Low conversion rate | Medium | High | Iterate pricing, add free trial of Pro |
| High churn | Medium | High | Onboarding flow, retention emails, usage alerts |
| Competitor copies features | High | Medium | Speed, community moat, open-source trust |
| OpenRouter price increase | Low | Medium | Multi-provider routing, local-first default |
| Enterprise sales cycle too long | High | Low | Focus on Pro/Team; enterprise is Year 2 |
| Payment fraud | Low | Low | Stripe Radar, manual review >$500 |

---

## Financial Milestones

| Milestone | Target Date | Trigger |
|-----------|-------------|---------|
| First paying customer | Month 2 | First Pro subscription |
| Break-even | Month 4-6 | MRR > fixed costs |
| $1k MRR | Month 6 | 67 Pro or mix |
| $5k MRR | Month 9 | Team + Enterprise |
| First enterprise contract | Month 7-9 | $10k+ annual deal |
| $10k MRR | Month 12 | Sustainable growth |
| Hire first employee | Month 12-15 | MRR > $15k |