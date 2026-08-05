<div align="center">

# NaxionAI

<img src="assets/jarvis-reference/jarvis-waveform.gif" alt="Voice/agent waveform" height="550" />

**A personal, single-user AI assistant — "Naxie" — inspired by JARVIS.**

</div>

## What this is

NaxionAI (backend: FastAPI + Python; frontend: Next.js) is a personal
assistant that runs on your own machine: a local-first LLM brain (Ollama by
default, with Groq and bring-your-own cloud providers as opt-ins), a voice
pipeline, a knowledge vault, connectors to your own data sources, and a
small set of PA tools (weather, reminders, calendar, downloads, system
control) — all gated behind explicit opt-in settings where they touch the
host or the network.

The code lives under [`naxionai/`](naxionai/):

- [`naxionai/backend/`](naxionai/backend/) — FastAPI app, `http://localhost:8000`
- [`naxionai/frontend/`](naxionai/frontend/) — Next.js app, `http://localhost:3000`

## Getting started

```bash
cp naxionai/.env.example naxionai/.env
# set JWT_SECRET_KEY + ENCRYPTION_KEY in naxionai/.env
```

Then run the backend and frontend locally (see `naxionai/backend/start_backend.bat`
/ `naxionai/frontend` scripts) and open the app — the first account created
becomes the local owner. No Docker required.

## History

This project started as **Digital Force**, an autonomous social-media-agency
multi-agent platform, and was rebranded to **NaxionAI** (its voice-assistant
page renamed **Naxie**, formerly "Jarvis"). It also absorbed a handful of
features — a personal to-do list, a git-backed knowledge vault, security
gates, bring-your-own model providers, OCR, document export, calendar, and
a downloads organizer — from a separate legacy platform called **neuroworks**,
which has since been retired. See [`naxionai/NEUROWORKS_DESCOPE.md`](naxionai/NEUROWORKS_DESCOPE.md)
for exactly what was ported vs. intentionally left behind (most of
neuroworks was a multi-department AI-workforce platform that doesn't apply
to a single-user assistant).

References to the fictional Iron Man **JARVIS** above are attribution to
the "build your own JARVIS" open-source lineage that inspired this project's
look and feel (see the `jarvis-reference`/`jarvis-*` asset filenames) — not
a claim about the old product name.

## Repositories

Code changes go to this repo. Knowledge-vault/operator data is stored
separately — see `CLAUDE.md` for the two-repo split.

## License

Personal project, not currently licensed for redistribution. (The old
`neuroworks/LICENSE` this README used to point to no longer exists — that
folder was retired; add a `LICENSE` file here if you want to formalize one.)

<br>
<img src="assets/jarvis-reference/stark-hud-background.jpg" alt="Stark HUD-style dashboard aesthetic that inspired this project" width="100%" />
