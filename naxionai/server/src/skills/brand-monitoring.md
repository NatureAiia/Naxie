---
name: brand-monitoring
description: How to read and act on brand-signal monitoring results (draft mentions/opportunities awaiting human review). Use when reviewing or explaining brand-signals output.
applies_to: [research, analyze]
---

# Skill: Brand monitoring

## Goal

Support whoever is reviewing brand-signal drafts (via the Telegram/email alert, or the Signals panel on the Brands page) in making a fast, correct validate/reject call — never make that call automatically.

## What a signal is

Each `BrandSignal` (`lib/brand-signals.ts`) already passed 3 gates before a human ever sees it: it matched the brand's watch list, it has a real http source (never an invented URL), and it has actual substantive text. What's left for the human is judgment: is this worth acting on?

## Provenance — read it correctly

Every signal carries a `provenance` score of **0.6 (primary — the brand's own domain/handle) or 0.4 (third-party)**. This is "how directly sourced," full stop — **never** describe it as a confidence score, a probability of truth, or "how likely this is real." A third-party (0.4) mention can be completely accurate; a primary (0.6) one can still be misread. Provenance tells you where it came from, not whether to believe it.

## Process

1. Read the signal text and its source link.
2. Check `seenCount` — a repeat sighting (seenCount > 1) is corroboration, not louder news; don't treat it as more urgent just because it recurred.
3. Decide: **validate** (real, worth knowing/acting on) or **reject** (noise, false match, or not actually about this brand). There is no third option and no auto-resolve — every draft gets an explicit human decision.
4. Only `validated` signals ever appear in the gated export (`GET /api/brand-signals/export`) — a rejected one stays in the store as a record of the call, never deleted.

## Rules

- Never validate a signal to make an alert go away — reject it if it isn't real/relevant.
- Never treat a `rejected` signal as evidence "nothing happened" — check `refusedCount` on recent runs too; some candidates never even became a signal because they failed the source/finding gates, which is a separate (and normal) outcome from an operator rejecting a real one.
- Alerts are for awareness, not verdicts — the critical/notable rules are dumb keyword/first-sighting checks (see `lib/brand-signals.ts`'s `RISK_TERMS`), not a judgment that something is actually a crisis.

## Pitfalls

- Reading "primary source" as "definitely true" — it isn't; it just means the brand's own domain/handle was the origin.
- Piling up unreviewed drafts — an empty watch list or a brand nobody checks in on defeats the point; if a brand's Signals panel has old, stale drafts, say so rather than ignoring them.
