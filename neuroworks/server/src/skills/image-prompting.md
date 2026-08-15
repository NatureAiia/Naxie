---
name: image-prompting
description: How to write a strong text-to-image prompt and drive the media.image studio tool (logos, posters, hero images, illustrations, mockups).
applies_to: [image, logo, poster, banner, hero, illustration, artwork, mockup, visual]
---

# Skill: Image prompting (studio generation)

## Goal

Turn a vague "make an image / logo / poster / hero" request into a specific,
high-quality generated image via the `media.image` tool — not a flat, generic
render.

## Tools

- `media.studio_models` — list the available image models (id, provider, kind,
  aspect ratios). Call this first when the look matters, so you pick the right
  model.
- `media.image` — generate. Args: `prompt` (required), `model` (optional id from
  the catalog), `aspect_ratio` (e.g. `1:1`, `16:9`, `4:5`, `9:16`), `provider`
  (`ideogram` | `muapi`). Returns `{ path, bytes, provider, model }` — a local
  PNG. Attach it with `email.send` `attach_paths`, or reference the path.

## Pick the model to the job

- **Text / typography / logos / posters / any image with readable words** →
  Ideogram (best-in-class text rendering). Omit `model` and let the provider
  default to Ideogram, or pass `provider: "ideogram"`.
- **Photoreal / product shots / people** → `flux-dev`, `bytedance-seedream-v4`,
  `google-imagen4`, or `nano-banana-pro`.
- **Illustration / anime / stylised** → `ai-anime-generator`, `flux-krea-dev`,
  a Stability model.
- Unsure? Call `media.studio_models` and choose by provider/name.

## Write the prompt: five layers, always concrete

A weak prompt ("a logo for a coffee shop") gives a weak image. Specify:

1. **Subject** — exactly what's in frame, with attributes (count, material,
   pose, expression). "A single espresso cup on a walnut counter", not "coffee".
2. **Style / medium** — photograph, 3D render, flat vector, watercolour,
   isometric illustration, editorial poster, etc.
3. **Composition** — framing and viewpoint: close-up, wide shot, eye-level,
   top-down, rule-of-thirds, centered hero, negative space for text.
4. **Lighting** — soft morning light, golden hour, studio softbox, dramatic
   rim light, neon. Lighting is what makes an image read as "expensive".
5. **Colour / mood** — a small named palette ("warm terracotta, cream, deep
   green") and a mood ("calm, premium, minimal").

**Typography rule:** put the exact words to render **in quotes** in the prompt,
e.g. `a bold poster with the headline "AIIA SUMMIT 2026" in a modern sans-serif`.
State font feel (serif/sans, weight), placement, and that text must be spelled
exactly. Use Ideogram for anything text-heavy.

**Aspect ratio to the use:** `1:1` avatars/icons, `16:9` slides/hero banners,
`4:5` or `9:16` social/mobile, `3:2` photography, `2:3` posters.

## Output shape (what you hand back)

After generating, tell the user in one or two lines what you made and where it
is (the returned `path`), and offer the obvious next step (attach it, iterate on
style, try another model). Do NOT paste the raw file path as the whole answer.

## Worked example

Request: "make us a hero image for the Aiia summit landing page"

1. `media.studio_models { kind: "text-to-image" }` → confirm Ideogram is
   available (typography-heavy hero).
2. `media.image`:
   - `prompt`: `Editorial hero image for a technology summit. A diverse group of
     African professionals collaborating around a glowing holographic data
     globe in a bright modern atrium. Photographic, shallow depth of field,
     eye-level wide shot with clean negative space on the left for a headline.
     Soft morning light, warm rim light. Palette: deep sapphire, warm cream,
     electric teal. Premium, optimistic, cinematic. Include the headline text
     "AIIA SUMMIT 2026" in a bold modern sans-serif, top-left, spelled exactly.`
   - `aspect_ratio`: `16:9`
   - `provider`: `ideogram`
3. Reply: "Generated the summit hero (16:9, Ideogram) — saved to
   `<path>`. Want it attached to an email, or a variant in a different palette?"

## Guardrails

- If `media.image` returns an error about no provider configured, tell the user
  image generation needs `IDEOGRAM_API_KEY` or `MUAPI_API_KEY` in Integrations —
  don't pretend an image was made.
- Never invent a file path or claim success the tool didn't return.
- One image per call; for variations, call again with a tweaked prompt/model.
