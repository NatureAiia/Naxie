# Business Model — GitHub Issue Templates

---

## BM-001: Tier Gating System (Feature Flags by Plan)
**Labels:** `business-model`, `backend`, `critical`, `sprint-3`
**Assignee:** @eng-1
**Estimate:** 2 days

### Description
Enforce Pro/Team/Enterprise feature limits at the API layer.

### Files to Change
- `naxionai/server/src/lib/access.ts` (extend with tier logic)
- `naxionai/server/src/lib/billing.ts` (new — Stripe integration)
- All route handlers with feature limits

### Tasks
- [ ] Define tier configs: `community`, `pro`, `team`, `enterprise`
- [ ] `getUserTier(userId)` from billing DB / `.naxion/billing.json`
- [ ] `enforceTier(userId, feature)` middleware for gated routes
- [ ] Return 402 Payment Required with `upgradeUrl` for blocked features
- [ ] Gate: personas, scheduled runs, concurrent jobs, cloud sync, Telegram
- [ ] Team: shared vault, RBAC, audit log
- [ ] Enterprise: SSO, SCIM, air-gap, SLA

### Acceptance Criteria
- [ ] Free user hitting Pro feature → 402 with upgrade link
- [ ] Pro user → all Pro features work, Team features blocked
- [ ] Tier checked on every gated request (not just UI)

---

## BM-002: Stripe Billing Integration
**Labels:** `business-model`, `backend`, `critical`, `sprint-4`
**Assignee:** @eng-1
**Estimate:** 2 days

### Description
Stripe subscriptions for Pro and Team tiers.

### Files to Change
- `naxionai/server/src/routes/billing.ts` (new)
- `naxionai/server/src/lib/stripe.ts` (new)
- `naxionai/web/src/pages/Settings/Billing.tsx`

### Tasks
- [ ] Stripe customer creation on signup
- [ ] Checkout session: Pro ($15/mo), Team ($50/mo), annual (20% off)
- [ ] Webhook handler: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`
- [ ] Sync subscription status to local user record
- [ ] Portal: `billingPortal.sessions.create` for self-service (cancel, update card)
- [ ] Invoice history (past 12 months)
- [ ] Grace period: 7 days after failed payment before downgrade
- [ ] Test mode support (`STRIPE_TEST_MODE=1`)

### Acceptance Criteria
- [ ] User can subscribe with test card (4242...)
- [ ] Webhook updates tier within 30s
- [ ] Cancel → downgrade at period end
- [ ] Failed payment → retry + grace period + downgrade

---

## BM-003: Pricing Page (Public Marketing)
**Labels:** `business-model`, `frontend`, `high`, `sprint-4`
**Assignee:** @eng-2
**Estimate:** 1 day

### Description
Public pricing comparison page on landing site.

### Tasks
- [ ] 4-column comparison table (Community, Pro, Team, Enterprise)
- [ ] Feature matrix with ✅/❌/number badges
- [ ] Monthly/annual toggle (show 20% savings)
- [ ] CTA buttons: "Start Free" (Community), "Start Pro Trial" (Pro), "Contact Sales" (Enterprise)
- [ ] FAQ: billing, refunds, data privacy, self-host
- [ ] SEO: `meta title`, `og:image`, schema.org pricing markup
- [ ] Responsive: 4-col → stacked cards on mobile

### Acceptance Criteria
- [ ] Page loads in <1s (static)
- [ ] Annual toggle updates prices correctly
- [ ] "Start Pro" → Stripe checkout

---

## BM-004: Usage Metering & Quota Enforcement
**Labels:** `business-model`, `backend`, `high`, `sprint-4`
**Assignee:** @eng-1
**Estimate:** 1 day

### Description
Track feature usage per user; enforce tier quotas.

### Tasks
- [ ] Usage table: `userId, feature, count, period, limit`
- [ ] Increment on: scheduled run, concurrent job, persona create, cloud sync
- [ ] Check quota before action → 402 if exceeded
- [ ] `/api/usage` endpoint: current usage vs limit per feature
- [ ] Dashboard: "You've used 8/10 concurrent jobs (Pro)"
- [ ] Alert: 80% quota reached → in-app + email

### Acceptance Criteria
- [ ] Quota enforced server-side (not just UI)
- [ ] Usage visible in settings
- [ ] Over-limit → clear 402 with upgrade link

---

## BM-005: Customer Onboarding Funnel Analytics
**Labels:** `business-model`, `growth`, `medium`, `sprint-3`
**Assignee:** @eng-2
**Estimate:** 0.5 day

### Description
Track signup → activation → conversion funnel.

### Tasks
- [ ] Event tracking: `signup`, `onboarding_step_1..5`, `first_chat`, `vault_created`, `pro_trial_started`, `pro_converted`
- [ ] Attribution: referrer, UTM params, landing page
- [ ] Funnel dashboard: conversion rates per step
- [ ] Cohort analysis: users who complete onboarding → conversion rate
- [ ] Tools: Plausible (privacy-friendly) or PostHog (self-hosted)

### Acceptance Criteria
- [ ] Funnel visible: signup → activation → paid
- [ ] Cohort analysis: onboarding completion → conversion correlation
- [ ] No PII in analytics (privacy-first)

---

## BM-006: Churn Prevention & Retention Emails
**Labels:** `business-model`, `growth`, `medium`, `v0.2`
**Assignee:** @eng-2
**Estimate:** 1 day

### Description
Automated emails to reduce churn.

### Flows

| Trigger | Email | Timing |
|---------|-------|--------|
| Signup | Welcome + quickstart guide | Day 0 |
| No activity | "We miss you" + feature highlight | Day 3 |
| Onboarding incomplete | "Finish setup" | Day 1 |
| Pro trial ending | "Your trial ends in 3 days" | Day 4 |
| Pro cancelled | "Sorry to see you go" + feedback survey | Day 0 |
| Inactive 30 days | "What went wrong?" | Day 30 |
| Usage spike | "You're getting a lot done!" + upgrade prompt | Day 7 |

### Tasks
- [ ] Email templates (Resend/Postmark)
- [ ] Event-driven triggers (signup, inactivity, trial end)
- [ ] Unsubscribe management
- [ ] Open/click tracking
- [ ] A/B test subject lines

### Acceptance Criteria
- [ ] Emails send within 5 min of trigger
- [ ] Unsubscribe works (CAN-SPAM compliant)
- [ ] Open rate >25%, click rate >3%

---

## BM-007: Enterprise Sales Playbook
**Labels:** `business-model`, `enterprise`, `medium`, `v0.2`
**Assignee:** @founder
**Estimate:** 2 hours

### Description
Process for landing first enterprise contracts.

### Playbook Steps

| Step | Action | Owner | Timeline |
|------|--------|-------|----------|
| 1 | Identify 10 target companies (compliance-heavy, tech-forward) | @founder | Week 1 |
| 2 | Research: tech stack, decision maker, pain points | @founder | Week 1 |
| 3 | Outreach: personalized LinkedIn + email | @founder | Week 2 |
| 4 | Discovery call: understand requirements | @founder | Week 2-3 |
| 5 | Demo: tailored to their use case | @founder + eng | Week 3-4 |
| 6 | Pilot: free 30-day trial with onboarding | eng | Week 4-8 |
| 7 | Proposal: pricing, SOW, SLA | @founder | Week 8 |
| 8 | Negotiate: legal, security review | @founder | Week 8-12 |
| 9 | Close: contract signed | @founder | Week 12 |

### Deliverables
- [ ] Target list (10 companies with contacts)
- [ ] Outreach templates (LinkedIn, email)
- [ ] Demo script (15 min, tailored)
- [ ] Pilot onboarding checklist
- [ ] Proposal template
- [ ] Contract template (with legal review)

### Acceptance Criteria
- [ ] 10 targets identified
- [ ] 5 discovery calls booked (Month 7)
- [ ] 3 pilots started (Month 9)
- [ ] 1 contract signed (Month 10)

---

## BM-008: Annual Plan + Discount Implementation
**Labels:** `business-model`, `backend`, `medium`, `sprint-4`
**Assignee:** @eng-1
**Estimate:** 0.5 day

### Description
Annual billing with 20% discount.

### Tasks
- [ ] Stripe: annual price IDs ($144 Pro, $480 Team)
- [ ] Checkout: monthly/annual toggle
- [ ] Proration: switch from monthly → annual (credit remaining)
- [ ] Renewal reminder: 30 days before annual renewal
- [ ] Dashboard: show "Next billing: Jan 15, 2027" or "Renews Oct 4, 2027"

### Acceptance Criteria
- [ ] Annual toggle shows correct price ($144 vs $180)
- [ ] 20% discount applied correctly
- [ ] Renewal reminder sends 30 days prior

---

## BM-009: Refund Policy & Self-Service
**Labels:** `business-model`, `support`, `low`, `v0.2`
**Assignee:** @eng-1
**Estimate:** 2 hours

### Description
Transparent refund policy with self-service refunds.

### Policy
- **Pro:** Full refund within 14 days of first charge; prorated refund for cancellation within 48 hours of renewal
- **Team:** Full refund within 14 days; prorated thereafter
- **Enterprise:** Per contract terms

### Tasks
- [ ] Refund policy page (public)
- [ ] Self-service: "Request refund" button in billing portal
- [ ] Auto-approve: first charge <14 days + no excessive usage
- [ ] Manual review: otherwise → email to support
- [ ] Refund processed via Stripe API within 48 hours

### Acceptance Criteria
- [ ] Refund policy published on pricing page
- [ ] Self-service refund works for qualifying requests
- [ ] Manual requests routed to support with context

---

## BM-010: Investor Update Template (Monthly)
**Labels:** `business-model`, `founder`, `low`, `v0.2`
**Assignee:** @founder
**Estimate:** 1 hour/month

### Description
Monthly update for advisors/investors (if raising).

### Template

```markdown
# NaxionAI Update — [Month Year]

## Highlights
- [3 bullet points of key wins]

## Metrics
| Metric | This Month | Last Month | Trend |
|--------|------------|------------|-------|
| GitHub stars | | | ↑↓ |
| DAU | | | ↑↓ |
| MRR | | | ↑↓ |
| Churn | | | ↑↓ |

## Product
- [Shipped features]
- [Next month's focus]

## Learnings
- [Key insight from customers/data]

## Asks
- [Specific introductions, feedback, help needed]
```

### Acceptance Criteria
- [ ] Template created
- [ ] Monthly cadence set (first Friday)