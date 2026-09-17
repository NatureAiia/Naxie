---
name: content-calendar
description: Laying out a week/month of content for one brand, respecting its cadence and without touching another brand's slots or history.
applies_to: [draft-brief, plan]
---

# Skill: Content calendar

## Goal

A concrete posting plan for ONE brand over a period (a week, a month), not a vague list of "content ideas." Every slot names a day/time, a topic, and a format.

## Process

1. Read the brand's `calendarCadence` (e.g. "3x/week: Mon/Wed/Fri 9am") from its `Brand` record. If unset, ask the operator for a cadence rather than guessing one.
2. Read that brand's own recent drafts/strategy note (`_neuroworks/social/<brandId>/drafts/`, `_neuroworks/social/<brandId>/strategy.md`) so the plan doesn't repeat a topic covered in the last few weeks and follows whatever the self-improving strategy loop (`social-optimize` template) has already learned.
3. Fill each slot with: day/time, topic/angle, format (single post / thread / video script), and — if relevant — the source it'll draw from (an email digest, a news item, an evergreen brand story).
4. Mix content types: don't fill an entire calendar with the same shape of post. Vary hook style and topic within the brand's voice.

## Rules

- **One brand, one calendar.** Never plan across two brands in a single pass — if the operator wants calendars for both AIIA and Variety Vault, produce two separate outputs, clearly labelled.
- **Respect the cadence.** Don't propose more or fewer slots than `calendarCadence` implies without flagging the change explicitly.
- **Ground topics in real material** where the brand has a source (emails, news digest, vault notes) — don't invent story details to fill a slot; if there's nothing to say for a slot, say so rather than padding.

## Pitfalls

- Silently reusing a topic/angle another brand covered recently — check that brand's own history only, never another's.
- A calendar that's all captions and no substance (see `email-writing.md`'s "substance" section — the same discipline applies here: every slot should answer "so what," not just "post about X").
