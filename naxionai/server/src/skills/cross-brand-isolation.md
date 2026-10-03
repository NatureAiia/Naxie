---
name: cross-brand-isolation
description: Hard rules preventing one brand's voice, audience, offers, or history from leaking into another's output. Load for any brand-facing task.
applies_to: [draft-other, draft-brief, announce, analyze]
---

# Skill: Cross-brand isolation

## Goal

The operator runs three separate brands — Personal, Work, Business (Variety Vault) — precisely because they're meant to stay separate: different audiences, different offers, different voices. This skill is the hard boundary that stops them from bleeding into each other.

## Rules

- **Never blend two brands in one output.** A single post, email, or plan speaks for exactly one brand. If a task genuinely needs content for two brands, produce two separate outputs, each clearly labelled with its brand.
- **When the brand isn't named, ASK — don't guess.** A task like "write a launch post" with no brand specified is ambiguous; resolving it wrong (posting Business content in Work's voice, or vice versa) is a real, visible failure, not a minor style miss.
- **Never carry hashtags, CTAs, or offers across brands.** Each brand's hashtag set, sign-off style, and calls-to-action belong to it alone — check that brand's own recent drafts (`_naxion/social/<brandId>/drafts/`), never another's.
- **Never let one brand's strategy note drive another's drafts.** Each brand has its own `_naxion/social/<brandId>/strategy.md` — a drafting task for Business should never read Work's strategy note or vice versa.
- **Never reuse another brand's audience assumptions.** "Our audience loves X" only holds for the brand whose audience was actually researched — don't transplant Work's audience framing onto Personal or Business content.

## Worked example (bad → corrected)

**Bad**: A Variety Vault promotional post that closes with a line borrowed from Work's mission framing — it will read as confused/inauthentic to Variety Vault's actual audience.

**Corrected**: The same post closes with a line that reflects Variety Vault's own values/audience (once those are filled in on the Brands page) — or, if they aren't filled in yet, the draft flags that explicitly and asks the operator to define Variety Vault's voice/audience before proceeding, rather than borrowing another brand's.

## Pitfalls

- Defaulting to Work content patterns out of habit, since it's the brand with existing history — Personal and Business need their own voice from their own (currently empty) guidelines, not a copy of Work's.
- Treating "brand" as just a label to slap on otherwise-generic content — the isolation is about substance (audience, offers, mission framing), not just a tag.
