# NAXIONAI 🤖

**A personal AI assistant (Naxie) with an autonomous social-media-agency engine underneath**

> Talk to Naxie day-to-day. Give the agency side a goal when you want it to run a campaign.

NAXIONAI started as an autonomous social-media-agency multi-agent
platform and was extended into **Naxie**, a personal single-user
assistant, without removing the original agency capabilities — both
coexist. Brief a goal in plain English and the agency side plans, creates,
publishes, monitors, and improves itself; or just talk to Naxie for
day-to-day assistant tasks (voice, reminders, calendar, your knowledge
vault, your own data sources).

## Core Capabilities

**Personal assistant (Naxie):**
- 🎙️ Voice — wake word, local STT/TTS
- 📓 Knowledge vault — git-backed notes with search, gated by a secret scanner
- 🔌 Connectors & data sources — your own APIs/databases, SSRF-guarded, read-only by default
- 🧠 Local-first LLM — Ollama by default, Groq or a bring-your-own cloud provider as opt-ins
- 🛠️ PA tools — weather, reminders, calendar, downloads organizer, system control (opt-in gated)
- 📄 OCR + markdown → docx/PDF export
- 🔐 Filesystem/SSRF security gates + request-level attack watchdog

**Social-media agency engine:**
- 🎯 **Natural Language Goals** — "Grow LinkedIn from 1K to 10K followers in 30 days"
- 🧠 **Multi-Agent Brain** — Team of specialized AI agents (Strategist, Writer, Designer, Publisher, Monitor)
- 🔍 **Multimodal RAG** — Learns from your PDFs, images, videos, URLs, CSVs, documents
- 🖼️ **Media Library** — Smart asset management with AI tagging and platform adaptation
- 📡 **All Platforms** — LinkedIn, X, TikTok, Instagram, YouTube via Buffer + Facebook Graph API
- ⚡ **SkillForge** — Agent codes its own new capabilities when it needs them
- 👁️ **Human-in-the-Loop** — You approve the plan before anything executes

## Tech Stack

- **Backend:** FastAPI + Python + LangGraph (multi-agent)
- **AI:** Ollama (local default) + Groq + optional BYO providers (OpenAI/Anthropic/OpenRouter/Together/custom)
- **Memory:** Qdrant (vector DB, local or cloud)
- **Database:** SQLite (dev) / PostgreSQL (production)
- **Publishing:** Buffer API + Facebook Graph API
- **Frontend:** Next.js + Tailwind
- **Sandboxing:** E2B (for SkillForge safe code execution)

## Status

In active development. See the repo root `README.md` and
`NEUROWORKS_DESCOPE.md` (this folder) for history — NAXIONAI absorbed a
handful of features (personal to-do list, vault, security gates, BYO model
providers, OCR, document export, calendar, downloads organizer) from a
since-retired legacy platform called neuroworks.
