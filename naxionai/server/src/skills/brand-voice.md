---
name: brand-voice
description: How to write in a specific brand's voice from its Brand record and guidelines doc. Use whenever a task names or implies one of the operator's brands.
applies_to: [draft-other, draft-brief, announce]
---

# Skill: Brand voice

## Goal

Every brand-facing piece of content sounds like it came from THAT brand, not a generic assistant and not another brand. The operator runs three: **Personal**, **Work**, and **Business (Variety Vault)** — each with its own voice, audience, and values, managed on the Brands page (`GET /api/brands`).

## Process

1. **Identify the brand.** If the task names one ("post this for Work", "for Variety Vault") or a `brandId` input is present, use it. If it's genuinely ambiguous, ASK — never guess (see `cross-brand-isolation.md`).
2. **Pull the brand's context**: `brand.voice`, `brand.audience`, `brand.values`, and — if `brand.guidelinesVaultPath` is set — read that vault doc directly for the full guidelines. `gatherBrandContext()` (routes/templates.ts) already does this for the two scheduled social templates; for anything else, read the `Brand` record via `GET /api/brands/:id` and the vault doc yourself.
3. **Write in that voice.** Match tone AND substance to the brand — a fact-dense, credible Work post should not read like a punchy Variety Vault promo, and vice versa.
4. **If voice/audience are empty** (a brand still has its placeholder stub filled in), say so plainly and ask the operator to fill in the Brands page or the vault doc — don't invent a voice for them.

## Worked example

| Brand | Voice | Audience | Sample line |
|---|---|---|---|
| Personal | (operator-defined) | (operator-defined) | — fill in via the Brands page |
| Work | (operator-defined — fill in via the Brands page) | (operator-defined) | — |
| Business (Variety Vault) | (operator-defined) | (operator-defined) | — fill in via the Brands page |

## Rules

- Never invent a brand's voice/audience from nothing — pull it from the `Brand` record or ask.
- Never let one brand's phrasing habits (hashtag style, sign-off, CTA pattern) bleed into another's — see `cross-brand-isolation.md` for the hard boundary.
- A brand's `values` block is not decorative — it should visibly shape word choice and framing, not just sit unused in the prompt.

## Pitfalls

- Treating "brand voice" as a cosmetic tone note when the operator's actual ask is about substance (what to say, not just how).
- Reusing one brand's specific framing for another brand — that language belongs to its brand only.
