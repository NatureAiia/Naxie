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
