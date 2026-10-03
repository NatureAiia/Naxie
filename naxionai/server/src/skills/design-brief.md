---
name: design-brief
description: Turn a vague design request into a structured brief — audience, artifact, brand constraints, copy, dimensions — that either drives media.image directly or hands over to OpenDesign for decks, PDFs, prototypes and video.
applies_to: [design, brief, deck, presentation, slides, prototype, landing-page, brand, campaign, pitch]
---

# Skill: Design brief

## Goal

"Make us something for the summit" is not actionable, and guessing at it wastes
a generation and produces something off-brand. Turn the ask into a brief a
person or a tool can execute — then either execute it or hand it over, depending
on what is actually being asked for.

## First: can we make this here?

Decide before you promise anything.

**Yes — `media.image` makes it.** Poster, logo, banner, hero image, social
graphic, illustration, thumbnail, icon, mockup. Still images. Write the brief,
then follow the `image-prompting` playbook and generate.

**No — hand over a brief.** Decks and slides (PPTX), PDFs, multi-page documents,
interactive prototypes, landing pages, video (MP4). Nothing here renders those.
OpenDesign does, if the operator has it running — it exports HTML, PDF, PPTX and
MP4. Say plainly that the artifact needs OpenDesign, and deliver the brief so
nothing is lost.

Never describe a deck or a video as though you produced one.

## The brief

Eight fields. Do not skip one by inventing it — if you do not know, ask, or mark
it `TBC` in the output so the gap is visible.

1. **Artifact** — exactly what is being made, and its format. "A1 print poster,
   CMYK" and "1080×1350 Instagram post" are different jobs.
2. **Audience** — who sees it, where, and in what state of attention. A summit
   delegate holding a programme is not a commuter scrolling a feed.
3. **The one thing** — the single message that must land if nothing else does.
   One sentence. If there are three, the design has already failed.
4. **Action** — what the viewer should do next, and how they do it (URL, QR,
   stand number, date).
5. **Copy** — the exact words on the artifact, written out. Headline, subhead,
   body, call to action. Word counts matter: a headline over about eight words
   will not survive at poster distance.
6. **Brand constraints** — the brand values below, plus anything in the
   guidelines: colour, typography, logo placement, clear space, what is
   forbidden.
7. **Dimensions and medium** — pixel size or print size, aspect ratio, bleed,
   and whether it will be seen on a phone, a screen or paper.
8. **What good looks like** — one or two references, or a plain description of
   the feeling. And explicitly: what to avoid.

## Brand is not optional

Every branded artifact carries these, and a design that misses them is off-brand
even when it is attractive:

- African unity and pride — celebrate African innovation, never import a
  "saviour" framing.
- Ubuntu — speak *with* people, not down to them.
- Inclusion and accessibility — plain, welcoming language; legible contrast.
- AI for a better Africa — practical and ethical, not hype.

Read the brand's guidelines doc (see its `guidelinesVaultPath` on the Brands page) with `vault.read` before
writing the brief. If it doesn't exist, say the brief is grounded on the stated
values alone.

## Accessibility, in the brief and not after

- Text contrast at least 4.5:1 against its actual background, not against white.
- Smallest type readable at the real viewing distance — 24pt at arm's length,
  much larger on a poster.
- Never carry meaning in colour alone.
- Any embedded text must also appear in the accompanying copy, so a screen
  reader and a search index can both reach it.

## Output shape

```
## Design brief — <artifact>

**Artifact**    A1 poster, 594×841mm, print, CMYK, 3mm bleed
**Audience**    Summit delegates, collected at registration
**The one thing** We train teams to build with AI, not just buy it
**Action**      Visit our stand · example.com/summit

**Copy**
  Headline   Build it here.
  Subhead    AI skills for Zimbabwean teams
  Body       Two-day practitioner programme, Harare, March 2026
  CTA        Stand 14

**Brand**       Work values + guidelines: <what they require here>
**Avoid**       Stock "robot brain" imagery, cool blue palettes, saviour framing
**Reference**   <or a plain description>

**Route**       media.image  |  OpenDesign (deck/PDF/prototype/video)
```

## Guardrails

- Ask before inventing. A fabricated date, price or stand number on a printed
  poster is expensive in a way a wrong sentence in a document is not.
- Copy is quoted exactly, never paraphrased — the words in the brief are the
  words that get set in type.
- If the ask needs OpenDesign, say so in one line and deliver the brief. Do not
  substitute a still image for a deck and hope it passes.
- One brief per artifact. A campaign of five things is five briefs sharing one
  brand section.
