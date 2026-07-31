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

Pick ONE path: **Docker (§2, recommended)** or **bare metal (§4)**.

---

## 2. Docker path (recommended)

### 2.1 Create env files from templates

```bash
cp neuroworks-ts/.env.example      neuroworks-ts/.env
cp digital-force-py/.env.example   digital-force-py/.env
```

### 2.2 Set the required Digital-Force secrets

Digital-Force **refuses to start in production** with placeholder secrets (this
is a security fail-fast, not a bug). Generate strong values and put them in
`digital-force-py/.env`:

```bash
# JWT signing key (any long random string)
echo "JWT_SECRET_KEY=$(openssl rand -hex 32)"        >> digital-force-py/.env
# Encryption key — MUST be exactly 32 bytes for the credential vault
echo "ENCRYPTION_KEY=$(openssl rand -base64 24 | cut -c1-32)" >> digital-force-py/.env
```

> On Windows PowerShell, instead run:
> `-join ((1..32) | % { '{0:x}' -f (Get-Random -Max 16) })` for each, or use any
> 32-char random string. The ENCRYPTION_KEY must be **exactly 32 characters**.

### 2.3 (Optional) Add LLM / provider keys

The apps boot without these, but agents can't call a model until at least one
provider key is set. Add whichever you have:

- **System A** (`neuroworks-ts/.env`): `OPENROUTER_API_KEY=` or point at a local
  Ollama (`OLLAMA_HOST=http://host.docker.internal:11434`). See its `.env.example`.
- **System B** (`digital-force-py/.env`): `GROQ_API_KEY_1=` (primary LLM),
  optional `TAVILY_API_KEY=` (web search), `QDRANT_URL=`/`QDRANT_API_KEY=`
  (else the bundled Qdrant container is used).

### 2.4 Bring the stack up

```bash
# From the neuroworks.shell/ root — builds and starts BOTH systems:
docker compose up --build
```

Or one system at a time:

```bash
docker compose -f neuroworks-ts/docker-compose.yml     up --build
docker compose -f digital-force-py/docker-compose.yml  up --build
```

### 2.5 Verify

```bash
curl -fsS http://localhost:7471/api/health   && echo "  A OK"   # System A
curl -fsS http://localhost:8000/api/health    && echo "  B OK"   # System B
```

Both must return HTTP 200. Then open the UIs (§3).

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
