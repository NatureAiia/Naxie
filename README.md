# NaxionAI Powered by Neuroworks

NaxionAI Powered by Neuroworks, inspired by Mr Magaya and Javaris.

## NeuroWorks Shell

An **empty-state, UAT-ready** package of the NeuroWorks platform. Full
functionality, **none of the operator's data** — no users, no connectors, no
knowledge vault, no company personas, no API keys. Hand this to a tester and
they stand up their own clean instance.

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
# set JWT_SECRET_KEY + ENCRYPTION_KEY in digital-force-py/.env (see AI-STARTUP.md §2.2)
docker compose up --build
```

Then open the app and **create the first account** — it becomes the workspace
**owner (superadmin)**. That is the entire onboarding.

## What "shell" means here

| Stripped out                                  | Kept (functionality)                                  |
|-----------------------------------------------|-------------------------------------------------------|
| All users (seeded owner removed)              | Full auth + first-run owner bootstrap                 |
| Connectors, integrations, API keys            | The connector/integration framework (add your own)    |
| Knowledge vault / "second brain" content      | Vault engine (points at a local empty `./vault`)      |
| Company personas, datasets, job history       | The built-in generic skills + persona engine          |
| Every real secret (`.env`, tokens, DB dumps)  | `.env.example` templates                              |

No `.git` history is included (so no embedded tokens travel with the bundle).

## License

See `neuroworks-ts/LICENSE`.
