<div align="center">

# Naxie

**Naxie** is Nature's (Mark's) personal AI assistant system — built on the open-source NeuroWorks platform.

</div>

## What this is

This is a **personal, non-commercial project**, owned and run by one person. It
is not a product, it is not for sale, and it is not distributed to anyone
else — the running instance holds Mark's own operator data, connected
accounts, and credentials, which is exactly why it stays private. If you're
looking at this expecting a general-purpose product or a multi-tenant SaaS,
this isn't that: it's one person's own AI staff.

It contains two systems that can run independently or together:

- **`neuroworks-ts/`** — the TypeScript build (Express API + React SPA), one
  port, `http://localhost:7471`.
- **`digital-force-py/`** — the Python build (FastAPI backend + Next.js
  frontend + Qdrant + Postgres), `http://localhost:8000` / `:3000`.

## Start here

Read **[AI-STARTUP.md](AI-STARTUP.md)** — a step-by-step, copy-pasteable startup
runbook designed so an **AI assistant or a human** can bring the stack up from
zero. The short version:

```bash
cp neuroworks-ts/.env.example    neuroworks-ts/.env
cp digital-force-py/.env.example digital-force-py/.env
# set JWT_SECRET_KEY + ENCRYPTION_KEY in digital-force-py/.env (see AI-STARTUP.md §2)
# Run the components locally per AI-STARTUP.md (no Docker)
```

## History

This started as **Digital Force**, an autonomous social-media-agency
multi-agent platform, with a voice-assistant page internally named **Jarvis**.
Both were renamed once the project became Mark's own personal assistant
rather than a product:

| Old name | New name | Scope |
|---|---|---|
| Digital Force | **NaxionAI** | The overall codebase |
| Jarvis | **Naxie** | The voice-assistant persona/page (`/naxie` in both the `neuroworks/` and `naxionai/` frontends) |

**NeuroWorks** is unaffected by this rename and keeps its name — it's the
open-source platform this personal system is built on top of, not the
personal system itself. Early design inspiration for the voice-assistant
concept drew loosely from the "build your own AI assistant" open-source
community — a single-user, single-machine loop that listens, thinks, and
acts on your behalf — scaled here into a multi-agent workforce with memory,
governance, and network reach.

## License

See `neuroworks/LICENSE`.
