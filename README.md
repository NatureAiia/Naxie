<div align="center">

# NaxionAI Powered by Neuroworks

<img src="assets/jarvis-reference/jarvis-waveform.gif" alt="Voice/agent waveform" height="550" />

**NaxionAI Powered by Neuroworks** — inspired by Mr Magaya and JARVIS.

</div>

## Repositories

This project uses **two separate GitHub repositories** — don't mix them up:

- **Main code repo** (this one, `origin`): [NatureAiia/NaxionAI-Powered-by-Neuroworks](https://github.com/NatureAiia/NaxionAI-Powered-by-Neuroworks) — application source code.
- **Vault repo**: [marknature/NaxionAI_Vault-Repo](https://github.com/marknature/NaxionAI_Vault-Repo) — knowledge/data storage (the actual knowledge-vault content and operator data), kept separate from source code.

The local `neuroworks/vault/` folder in this repo is a different thing entirely —
an empty placeholder directory the app reads/writes local notes to at runtime. It
is not the vault repo above. See [CLAUDE.md](CLAUDE.md) for details.

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

<p align="center">
 
  <br/>
  <sub>Voice-assistant lineage — see <a href="#-inspiration">Inspiration</a> below. The live mic-listening
  indicator in the app itself (<code>VoiceDiscussion</code>) is a few CSS-animated bars, not a video asset —
  see <code>MicWaveform</code> in <code>neuroworks-ts/web/src/components/VoiceDiscussion.tsx</code>.</sub>
</p>

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

## 🎬 Inspiration

The look and feel here nods to the "build your own JARVIS" lineage of
open-source voice assistants — a single-user, single-machine loop that
listens, thinks, and talks. NeuroWorks Shell takes that same premise (an AI
that acts on your behalf) and scales it into a multi-agent workforce with
memory, governance, and network reach. The Stark-HUD banner and mascot above
are reference assets from that lineage, not screenshots of this app.

## License

See `neuroworks/LICENSE`.

<br>
<img src="assets/jarvis-reference/stark-hud-background.jpg" alt="Stark HUD-style dashboard aesthetic that inspired this project" width="100%" />


# AI-STARTUP.md — machine-followable startup runbook

> You are an AI assistant (or an operator) bringing up the **NeuroWorks Shell**
> from a clean state. Follow these steps top to bottom. Every command is
> copy-pasteable. When a step says *verify*, do not proceed until the check passes.

This bundle is a **shell**: full functionality, **no data**. It ships with no
users, no connectors, no vault content, no API keys. The **first account you
create becomes the workspace owner (superadmin).**

---

## 0. What's in this bundle

```
neuroworks.shell/
├── docker-compose.yml        ← unified stack (brings up BOTH systems)
├── AI-STARTUP.md             ← this file
├── README.md
├── neuroworks-ts/            ← System A: TypeScript (Express API + React SPA)
│   ├── docker-compose.yml
│   ├── Dockerfile
│   ├── .env.example
│   └── server/ web/ ...
└── digital-force-py/         ← System B: Python (FastAPI backend + Next.js frontend)
    ├── docker-compose.yml
    ├── backend/  (Dockerfile, requirements.txt)
    ├── frontend/ (Dockerfile, package.json)
    └── .env.example
```

| Service            | System         | URL                     | Notes                         |
|--------------------|----------------|-------------------------|-------------------------------|
| NeuroWorks (A)     | neuroworks-ts  | http://localhost:7471   | single port: API + web UI     |
| DF backend (B)     | digital-force  | http://localhost:8000   | FastAPI, `/api/health`        |
| DF frontend (B)    | digital-force  | http://localhost:3000   | Next.js                       |
| Qdrant (B)         | digital-force  | http://localhost:6333   | vector DB                     |
| Postgres (B)       | digital-force  | localhost:5432          | df_user / df_password         |

Ports are disjoint — the two systems can run at the same time.

---

## 1. Prerequisites

- **Docker Desktop** (Compose v2.20+ — required for the top-level `include:`).
  Verify: `docker compose version` → must be **2.20 or newer**.
- OR, for the bare-metal path: **Node 20+ & pnpm 9** (System A) and
  **Python 3.11+** (System B).

Pick the bare-metal path: run the services locally without Docker (see §2).

---

## 2. Local (no Docker)

This repository no longer includes Docker orchestration files. Use the
bare-metal/local instructions to run the components directly on your machine.

Refer to §4 for component-specific local startup steps (Node/pnpm for
`neuroworks`; Python/venv for `digital-force-py`).

---

## 3. First-run: create the owner account

Neither system ships with any users. The **first account created is the sole
superadmin** (the owner); every later signup is a normal/pending account.

- **System A — http://localhost:7471**
  The login screen auto-detects the empty workspace and shows
  **"Create the workspace owner account."** Fill name + email + password →
  you're signed in immediately as owner. (Later signups land as *pending staff*
  awaiting your approval on the Users page.)

- **System B — http://localhost:3000**
  Register the first user via the app (or `POST /api/auth/register` with
  `{username,email,password}`). The first registered user is created as
  `superadmin`; the rest are `operator`.

> Do NOT skip this — with zero users the app has no administrator.

---

## 4. Bare-metal path (no Docker)

### System A — neuroworks-ts

```bash
cd neuroworks-ts
cp .env.example .env                 # then edit keys as in §2.3
pnpm install
pnpm -F neuroworks-web build         # build the SPA (required when SERVE_WEB=1)
pnpm -F neuroworks-server dev        # or: SERVE_WEB=1 pnpm -F neuroworks-server start
# → http://localhost:7470 (dev) — bound to 127.0.0.1 by default.
```

### System B — digital-force-py

```bash
cd digital-force-py
cp .env.example .env                 # set JWT_SECRET_KEY + ENCRYPTION_KEY (§2.2)
python -m venv .venv && . .venv/Scripts/activate   # Windows; use bin/activate on *nix
pip install -r backend/requirements.txt
cd backend && python run_server.py   # → http://localhost:8000
# In another shell, the Next.js frontend:
cd digital-force-py/frontend && npm install && npm run dev   # → http://localhost:3000
```

---

## 5. Troubleshooting (known fail-fasts — these are intentional)

| Symptom                                                             | Cause & fix                                                                                          |
|---------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| DF backend exits: *"Refusing to start … placeholder secret(s)"*     | Set real `JWT_SECRET_KEY` + `ENCRYPTION_KEY` in `digital-force-py/.env` (§2.2).                       |
| System A exits: *"bound to 0.0.0.0 … ENTERPRISE_MODE unset"*         | The container sets `NEUROWORKS_ALLOW_INSECURE_BIND=1` already. On bare metal, keep BIND_HOST=127.0.0.1.|
| System A exits: *"SERVE_WEB is on but no built SPA found"*           | Run `pnpm -F neuroworks-web build` before starting with `SERVE_WEB=1` (Docker does this for you).     |
| `include` not recognized in the top compose                         | Docker Compose < 2.20. Upgrade, or use the per-system compose files (§2.4).                           |
| Agents reply but never call a model / tools error out               | No provider key set — add one (§2.3).                                                                 |
| Port already in use                                                 | Something else owns 7471/8000/3000/6333/5432. Stop it, or remap ports in the relevant compose file.   |

---

## 6. Security notes for whoever runs this

- This is a **UAT shell for local testing**. System A's container opts into
  `NEUROWORKS_ALLOW_INSECURE_BIND=1` and publishes on **localhost only**. Before
  exposing either system on a network, read `neuroworks-ts/docs/DEPLOYMENT-SECRETS.md`
  and enable `NEUROWORKS_ENTERPRISE_MODE=1` (mint a `machine:full` key) or put it
  behind an authenticating reverse proxy.
- No secrets ship in this bundle. Every key is yours to add in `.env`.
- Change `df_user`/`df_password` (Postgres) before any non-local use.
