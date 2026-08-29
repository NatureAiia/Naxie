# Extensions

> Auto-generated from `server/src/lib/extensions.ts` (EXTENSION_CATALOG) on 2026-08-23T11:56:37.611Z — do not edit by hand; run `tsx tools/gen-extension-docs.ts` after changing the catalog.

The Extensions page (`/extensions`) monitors everything in this catalog plus token-based integrations, BYO connectors, and model providers.

## Core catalog

### infra

#### n8n (`n8n`)

Self-hosted workflow automation — trigger workflows, fire webhooks, chain AI tasks. Powers n8n.* primitives.

- **Enable:** set `N8N_API_KEY` (+ `N8N_BASE_URL`, `N8N_WEBHOOK_BASE_URL`)
- **Docs:** https://docs.n8n.io/api/authentication/
- **Health test:** yes — Test button runs a live check
- **Connect:** Run n8n (docker run -p 5678:5678 n8nio/n8n), open Settings → API → Create API Key, then set N8N_BASE_URL=http://127.0.0.1:5678 + N8N_API_KEY.

### llm

#### OpenRouter (`openrouter`)

Cloud LLM acceleration for planning/synthesis (gpt-4o, Claude, Gemini). Falls back to Ollama on 429/5xx.

- **Enable:** set `OPENROUTER_API_KEY` (+ `OPENROUTER_MODEL`, `OPENROUTER_LARGE_MODEL`, `OPENROUTER_APP_URL`, `OPENROUTER_APP_NAME`)
- **Docs:** https://openrouter.ai/keys
- **Health test:** yes — Test button runs a live check
- **Connect:** Paste your OpenRouter API key (sk-or-v1-…). Set OPENROUTER_MODEL to openai/gpt-4o or openai/gpt-4o-mini.

#### Ollama (local LLM) (`ollama`)

Local inference. No key required — just OLLAMA_HOST + OLLAMA_MODEL.

- **Enable:** set `OLLAMA_HOST` (+ `OLLAMA_MODEL`)
- **Docs:** https://ollama.com
- **Health test:** yes — Test button runs a live check
- **Connect:** Set OLLAMA_HOST (default http://127.0.0.1:11434) and pull a model with `ollama pull llama3.1:8b`.

### media

#### HeyGen (`heygen`)

AI avatar / spokesperson video (media.avatar_video). Async render.

- **Enable:** set `HEYGEN_API_KEY`
- **Docs:** https://app.heygen.com/settings?nav=API
- **Health test:** yes — Test button runs a live check
- **Connect:** Paste your HeyGen API key. Set HEYGEN_BASE_URL if you use a proxy.

#### Ideogram (`ideogram`)

Text-to-image — best for typography/posters. Header is Api-Key.

- **Enable:** set `IDEOGRAM_API_KEY`
- **Docs:** https://ideogram.ai/platform
- **Health test:** no (passive)
- **Connect:** Paste your Ideogram API key (Api-Key header).

#### Muapi (`muapi`)

Unified image catalog (nano-banana, flux, seedream, imagen…). Header x-api-key.

- **Enable:** set `MUAPI_API_KEY`
- **Docs:** https://muapi.ai
- **Health test:** no (passive)
- **Connect:** Paste your Muapi API key (x-api-key header).

### scraping

#### Firecrawl (`firecrawl`)

Third-tier scraping when fetch + Playwright fail (Cloudflare, anti-bot).

- **Enable:** set `FIRECRAWL_API_KEY`
- **Docs:** https://firecrawl.dev
- **Health test:** no (passive)
- **Connect:** Paste your Firecrawl API key (fc-…).

### social

#### Ayrshare (`ayrshare`)

One key fans social.post to X, LinkedIn, Facebook, IG, TikTok, etc.

- **Enable:** set `AYRSHARE_API_KEY`
- **Docs:** https://www.ayrshare.com/docs
- **Health test:** no (passive)
- **Connect:** Paste your Ayrshare API key from ayrshare.com.

### storage

#### Supabase (`supabase`)

pgvector RAG store + MAG memory. Publishable + secret keys, optional direct Postgres URL.

- **Enable:** set `SUPABASE_URL` (+ `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`)
- **Docs:** https://supabase.com/dashboard/project/_/settings/api
- **Health test:** yes — Test button runs a live check
- **Connect:** Paste SUPABASE_URL + keys from Project Settings → API.

## Webhooks (Zapier / Make)

1. Create: `POST /api/extensions/webhooks` with `{"targetId": "<connector-id>", "targetKind": "connector"}`.
2. Call: `POST /api/extensions/webhook/<id>` with header `X-Webhook-Secret: <secret>`.
3. Payloads carrying `task`/`text`/`objective`/`prompt` auto-create an agent job; poll `/api/tasks/jobs/:jobId`.
4. High-severity secrets in payloads are rejected with HTTP 400 before storage (`webhook.blocked` audit).

## Marketplace export

- `POST /api/extensions/export/:id` bundles a connector/integration into a versioned skill at `server/src/skills/_user/<slug>.md` (frontmatter `version:` bumps on each re-export).
- `GET /api/extensions/marketplace` lists exported skills with name/description/version.
- Exported content is security-scanned; high-severity secrets block the export (`marketplace.blocked` audit).

## Security scanning

- Ingress: webhook payloads are scanned (`scanForSecurityRisks`); high-severity findings → HTTP 400 + `webhook.blocked`.
- Egress: connector "try it" responses are scanned; high-severity matches are redacted to `[REDACTED:<type>]` with a warning field + `connector.call.blocked` audit.
- Patterns live in `server/src/lib/security.ts`; keep them precise (anchored prefix + length floor) to avoid false positives.
