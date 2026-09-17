---
name: launch-post
description: Drafting a single brand-scoped launch/announcement post plus a short video script, outside the automated buffer-story-post pipeline.
applies_to: [announce, draft-other]
---

# Skill: Launch post

## Goal

One accurate, platform-native announcement post (plus an optional short video-narration script) for a SPECIFIC brand — used when a human asks for a one-off launch/announcement post directly, rather than through the scheduled `buffer-story-post` template.

## Format

```
CAPTION: <one engaging hook line, ~120 chars max, no hype-word clickbait>

SUMMARY: <~8-10 lines — what's launching, who it's for, why it matters, in the brand's voice>

WHY_IT_MATTERS: <2-4 sentences connecting this launch to the brand's actual mission/audience — the one place the brand's own framing belongs>

HASHTAGS: <3-5 tags on one line, space-separated>

VIDEO_SCRIPT: <20-35s spoken narration of the same summary, first person, brand voice, no URLs/hashtags/stage directions>
```

This mirrors the shape the automated pipeline (`draftSocialPost` in `routes/templates.ts`) already produces — reuse it so a manually-drafted post and an automated one read the same way.

## Process

1. Resolve the brand (see `brand-voice.md`) — never draft a launch post without knowing which brand it's for.
2. Fill CAPTION/SUMMARY factually — never invent details about what's launching.
3. WHY_IT_MATTERS is where the brand's mission/framing shows up — for Work (AIIA) this is the Africa-relevance angle; for Personal/Business, whatever that brand's own `values`/`audience` imply. Do not import AIIA's specific framing ("AI for a better Africa") into a non-AIIA brand's post.
4. Pick hashtags from the brand's own established set where one exists (check recent drafts) rather than inventing new ones each time.

## Rules

- This is a DRAFT for human review, same posture as `buffer-story-post` — never claim something is "published"; present it for sign-off.
- Known limitation: the automated `buffer-story-post` template's internal prompt currently hardcodes AIIA's "why it matters for Africa" framing (`draftSocialPost`, `routes/templates.ts`) — for a non-Work brand running through the automated pipeline today, review the WHY section extra carefully until that prompt is generalized per-brand. A manually-run launch post via this skill doesn't have that limitation since you write WHY_IT_MATTERS yourself.

## Pitfalls

- Blending two brands' launches into one post because they happened to land the same week — always separate.
- Skipping the video script when one was asked for, or padding it with hashtags/URLs it shouldn't contain.
