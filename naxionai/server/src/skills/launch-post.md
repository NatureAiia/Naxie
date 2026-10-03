---
name: launch-post
description: Drafting a single brand-scoped launch/announcement post plus a short video script.
applies_to: [announce, draft-other]
---

# Skill: Launch post

## Goal

One accurate, platform-native announcement post (plus an optional short video-narration script) for a SPECIFIC brand — used when a human asks for a one-off launch/announcement post directly.

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
3. WHY_IT_MATTERS is where the brand's mission/framing shows up — whatever that brand's own `values`/`audience` imply. Never import another brand's specific framing into a post.
4. Pick hashtags from the brand's own established set where one exists (check recent drafts) rather than inventing new ones each time.

## Rules

- This is a DRAFT for human review — never claim something is "published"; present it for sign-off.

## Pitfalls

- Blending two brands' launches into one post because they happened to land the same week — always separate.
- Skipping the video script when one was asked for, or padding it with hashtags/URLs it shouldn't contain.
