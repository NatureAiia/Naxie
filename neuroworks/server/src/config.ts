import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// .env lives at clawbot/.env (one level above server/). Try repo root first, then server-local fallback.
loadEnv({ path: resolve(__dirname, "../../../.env") });
loadEnv({ path: resolve(__dirname, "../../.env") });

const missing: string[] = [];

function pick(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  missing.push(name);
  return "";
}

const githubToken = pick("GITHUB_TOKEN");
const githubOwner = pick("GITHUB_OWNER", "");
const vaultRepo = pick("VAULT_REPO", "");
// Shell default: a local ./vault folder inside the install. Point VAULT_PATH at
// your own knowledge folder to use one.
const vaultPathRaw = pick("VAULT_PATH", "./vault");
const vaultPath = resolve(vaultPathRaw);
// Dedicated local-disk folder for the Files explorer's "Local Files" pane —
// deliberately NOT the whole C:\ drive. A sandboxed folder we own, so drag-
// and-drop file management can't wander into system directories. Override
// with LOCAL_FILES_PATH; default lands next to the vault convention but on
// C:\ specifically, per the operator's request.
const localFilesPathRaw = pick("LOCAL_FILES_PATH", "C:\\NaxieFiles");
const localFilesPath = resolve(localFilesPathRaw);
const ollamaHost = pick("OLLAMA_HOST", "http://127.0.0.1:11434");
const ollamaModel = pick("OLLAMA_MODEL", "llama3.1:8b-instruct-q8_0");
// Legacy: the separate naxionai/backend (FastAPI, Python) service used to host
// Naxie's personal Google/Microsoft connectors via a proxy at /naxie-api. That
// connector logic now lives natively here (see lib/oauth-connectors.ts,
// routes/oauth-connectors.ts) — this var is kept only for any remaining
// reference during the naxionai/backend retirement pass.
const naxionBaseUrl = pick("NAXION_BASE_URL", "http://127.0.0.1:8000");
// Google/Microsoft OAuth (authorization-code flow) for the personal connectors
// — ported from naxionai/backend/api/{google,microsoft}_connector.py. Optional:
// each platform is simply unavailable (authorize returns 400) until its client
// id/secret are set. Redirect URIs default to this server's own port so an
// existing registered OAuth app just needs repointing, not reconfiguring.
const googleClientId = pick("GOOGLE_CLIENT_ID", "");
const googleClientSecret = pick("GOOGLE_CLIENT_SECRET", "");
const googleRedirectUri = pick("GOOGLE_REDIRECT_URI", `http://localhost:${pick("NEUROWORKS_PORT", "7471")}/api/connectors/google/callback`);
const microsoftClientId = pick("MICROSOFT_CLIENT_ID", "");
const microsoftClientSecret = pick("MICROSOFT_CLIENT_SECRET", "");
const microsoftTenantId = pick("MICROSOFT_TENANT_ID", "common");
const microsoftRedirectUri = pick("MICROSOFT_REDIRECT_URI", `http://localhost:${pick("NEUROWORKS_PORT", "7471")}/api/connectors/microsoft/callback`);
// Where the OAuth callback redirects the browser back to after connecting —
// the web app's own origin (Vite dev server in local dev, or this server's
// own origin when SERVE_WEB=1 serves the built SPA).
const naxieWebUrl = pick("NAXIE_WEB_URL", "http://localhost:7470");
// Effort dial the customer can flip from Settings → Models. "auto" (default)
// keeps the existing per-task capability scoring + size-based OR escalation.
// "high" biases local picks toward reasoning/longForm models and always
// escalates to the large-tier model when OpenRouter is configured; "low"
// biases toward the fastest local model and skips the size-based auto-
// escalation (explicit complexity:"high" call sites — SQL gen, etc. — still
// get their large model, since those are correctness-critical, not a mood).
// Runtime-only (like ollamaModel above) — resets to "auto" on restart.
let effortMode: "auto" | "low" | "high" = "auto";

// OpenRouter — optional cloud LLM provider used to accelerate slow profiles
// (planning/synthesis) when local Ollama can't keep up. Key absent = fully
// local mode (status quo). Profiles routed to OR are picked via OPENROUTER_PROFILES
// or per-profile model env vars (OPENROUTER_PLAN_MODEL etc.). Headers HTTP-Referer
// + X-Title are required by OpenRouter for free-tier requests.
const openrouterApiKey = pick("OPENROUTER_API_KEY", "");
const openrouterBaseUrl = pick("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
// Default model used when a profile is routed to OR but has no explicit model
// override. gpt-4o-mini is fast + cheap and handles all our profiles well.
const openrouterModel = pick("OPENROUTER_MODEL", "openai/gpt-4o-mini");
// LARGE-tier OR model — used automatically when the complexity heuristic
// fires (prompt too big for local context, or caller flags complexity:"high").
// Defaults to gpt-4o (full) but can be set to claude-3.5-sonnet, opus, etc.
// Setting this to the same as OPENROUTER_MODEL disables the tier split.
const openrouterLargeModel = pick("OPENROUTER_LARGE_MODEL", "openai/gpt-4o");
// Comma-separated profile list. When empty BUT OPENROUTER_API_KEY is set, all
// profiles route to OR if they have no Ollama-side env pin. When non-empty,
// only those profiles route to OR (rest stay on Ollama). Example:
//   OPENROUTER_PROFILES=planning,synthesis,triage
const openrouterProfiles = pick("OPENROUTER_PROFILES", "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
// HTTP-Referer / X-Title — OpenRouter wants these to identify the calling app.
// Defaults reflect a local NeuroWorks instance.
const openrouterAppUrl = pick("OPENROUTER_APP_URL", "https://neuroworks.local");
const openrouterAppName = pick("OPENROUTER_APP_NAME", "NeuroWorks Clawbot");

// Firecrawl — optional hosted scraping API used when vanilla fetch + local
// Playwright both fail (Cloudflare challenges, CAPTCHA gates, hard anti-bot).
// When the key is unset we skip Firecrawl entirely and rely on the existing
// fetch → playwright tiers. When set, smartFetch tries Firecrawl as a third
// tier so resilience-tier sites stop tanking the research pipeline.
const firecrawlApiKey = pick("FIRECRAWL_API_KEY", "");
const firecrawlBaseUrl = pick("FIRECRAWL_BASE_URL", "https://api.firecrawl.dev");

// Supabase — credentials only for now (docs/naxie-storage-architecture.md
// Phase 2: pgvector RAG store + MAG memory table). No integration code reads
// these yet; storage.ts's status route uses them for a live reachability
// ping so the storage-universe UI can show "configured, not yet wired" for
// this backend, and every future Phase 2 caller reads the same three vars.
const supabaseUrl = pick("SUPABASE_URL", "");
const supabasePublishableKey = pick("SUPABASE_PUBLISHABLE_KEY", "");
const supabaseSecretKey = pick("SUPABASE_SECRET_KEY", "");
// Direct Postgres connection string for the Supabase project above (Settings →
// Database → Connection string, "URI" tab). Used by lib/pg-client.ts for the
// pgvector RAG store (vault_chunks table — see migrations/0001_vault_chunks.sql).
// Blank = pgvector search is skipped entirely (ragSearch degrades to the
// existing MiniSearch/memory/fallback paths, same posture as every other
// optional integration in this file).
const supabaseDbUrl = pick("SUPABASE_DB_URL", "");

// OpenAI — used ONLY for embeddings (text-embedding-3-small, 1536 dims) to
// back the pgvector RAG store above. Deliberately independent of whichever
// provider is active for chat (Gemini by default) since OpenAI's embeddings
// endpoint is the one clearly OpenAI-compatible embeddings API wired into
// this codebase today. Blank = lib/embeddings.ts throws a clear error that
// callers (rag.ts, the re-embed job) catch and treat as "semantic search
// unavailable" — never a hard failure.
const openaiEmbeddingApiKey = pick("OPENAI_EMBEDDING_API_KEY", "");
const openaiEmbeddingBaseUrl = pick("OPENAI_EMBEDDING_BASE_URL", "https://api.openai.com/v1");
const openaiEmbeddingModel = pick("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small");

// MiniMax removed — image generation goes through OpenRouter (Gemini flash);
// video/music/tts have no configured provider (see media.* primitives).

// HeyGen — hosted AI avatar/spokesperson VIDEO generation (talking-head videos
// from a script + an avatar + a voice). Presenter/explainer style; gated on
// HEYGEN_API_KEY; absent = the
// avatar-video capability simply isn't offered. Async API (create → poll).
const heygenApiKey = pick("HEYGEN_API_KEY", "");
const heygenBaseUrl = pick("HEYGEN_BASE_URL", "https://api.heygen.com");

// n8n — self-hosted workflow automation. When N8N_BASE_URL + N8N_API_KEY are
// set, agents can list/trigger n8n workflows and fire webhooks. Absent = the
// n8n.* primitives and /api/n8n routes return a clear "not configured" error.
// Docker: `docker run -it --rm -p 5678:5678 n8nio/n8n` then set N8N_BASE_URL
// to http://127.0.0.1:5678. The API key is created in n8n → Settings → API.
const n8nBaseUrl = pick("N8N_BASE_URL", "");
const n8nApiKey = pick("N8N_API_KEY", "");
const n8nWebhookBaseUrl = pick("N8N_WEBHOOK_BASE_URL", n8nBaseUrl);

// Studio image generation — text-to-image. Preferred provider is OpenRouter
// (Gemini flash image) on the existing OpenRouter key; Ideogram/Muapi are
// optional env-gated alternatives (absent = not offered):
//   Ideogram (IDEOGRAM_API_KEY) — best-in-class typography/design/posters,
//     structured-JSON prompting. Header auth is "Api-Key", not Bearer.
//   Muapi (MUAPI_API_KEY) — one key, a whole catalog (nano-banana, flux,
//     seedream, …) behind a unified /api/v1/<endpoint> gateway. See
//     lib/studio-models.ts for the catalog this drives.
// Base URLs are overridable so a moved endpoint is a config change, not a
// code change (Ideogram bumped v3→v4; a v5 shouldn't need a redeploy).
// FREE image route: OpenRouter already-configured key can generate images via
// an image-output model (chat/completions + modalities:["image","text"]), so
// agents produce real downloadable visuals with NO new key. Default model is
// Google's Gemini flash image ("nano-banana"); override per deployment.
const openrouterImageModel = pick("OPENROUTER_IMAGE_MODEL", "google/gemini-2.5-flash-image");
const ideogramApiKey = pick("IDEOGRAM_API_KEY", "");
const ideogramBaseUrl = pick("IDEOGRAM_BASE_URL", "https://api.ideogram.ai");
const ideogramModel = pick("IDEOGRAM_MODEL", "ideogram-v4");
const muapiApiKey = pick("MUAPI_API_KEY", "");
const muapiBaseUrl = pick("MUAPI_BASE_URL", "https://api.muapi.ai");
// Default image provider when the caller doesn't name one. "auto" prefers
// Ideogram (quality) then Muapi (breadth); or pin "ideogram" | "muapi".
const studioImageProvider = pick("STUDIO_IMAGE_PROVIDER", "auto").toLowerCase();

// Hermes executor — when the primary executor is switched to Hermes (runtime
// toggle, see executor-mode.ts), tasks run through the Hermes CLI instead of
// clawbot's plan/execute pipeline. Hermes's own configured default model
// (claude-opus-4.6) is broken on the bundled key, so we pin a model that works.
// Override with HERMES_MODEL. Provider is OpenRouter to match.
const hermesModel = pick("HERMES_MODEL", "openai/gpt-oss-20b:free");
const hermesProvider = pick("HERMES_PROVIDER", "openrouter");
// Local Hermes option — run Hermes against the local Ollama daemon instead of
// a cloud provider (no key, no spend, works offline). Toggled at runtime via
// POST /api/executor {hermesLocal:true}; model must exist in `ollama list`.
const hermesLocalModel = pick("HERMES_LOCAL_MODEL", "north-mini-code-10");
const hermesLocalProvider = pick("HERMES_LOCAL_PROVIDER", "ollama");

const port = Number(pick("NEUROWORKS_PORT", "7471"));
// Comma-separated list of peer clawbot base URLs. Each peer is another running
// instance of this same server (different port, optionally different model).
// Empty by default — single-clawbot mode. Example:
//   NEUROWORKS_PEERS=http://127.0.0.1:7472,http://127.0.0.1:7473
const peers = pick("NEUROWORKS_PEERS", "")
  .split(",").map(s => s.trim()).filter(Boolean);
// Optional human-readable name for this clawbot — shows up in /api/health and
// peer roll-call responses so dual-clawbot work can be told apart in logs.
const name = pick("NEUROWORKS_NAME", "primary");
// Functional role for this clawbot. The chat router uses it to decide where
// to delegate persona-shifted work (away from "primary" toward "persona-shifter").
// Free-form, but recommended values are: primary | persona-shifter | general | reviewer.
const role = pick("NEUROWORKS_ROLE", "primary");

// ── Production web serving + network bind ──────────────────────────────
// Locally, `pnpm dev` runs two processes: the Vite dev server (7470, proxies
// /api) and this API (loopback 7471). In the production container we instead
// build the SPA once and let THIS server serve the minified assets, so there's
// a single hardened process and no dev server exposed. All three toggles
// default to the local two-port behaviour so nothing changes for `pnpm dev`.
//   SERVE_WEB=1            → serve web/dist (built SPA) with a history fallback
//   NEUROWORKS_BIND_HOST   → 0.0.0.0 in a container so the port is reachable
//   NODE_ENV=production    → flips fail-fast validation on (see validateConfig)
const bindHost = pick("NEUROWORKS_BIND_HOST", "127.0.0.1");
// Enterprise mode — off by default (current local/loopback trust model is
// unchanged), flip to "1" the moment this instance is network-reachable
// (cloud VM, shared server, behind a proxy that isn't strictly loopback-only).
// Requires every non-exempt request to carry either a human session token or
// a "machine:full"-scoped API key (see lib/enterprise-auth.ts) — closes the
// gap where requireLayer() and origin-guard both explicitly let token-less /
// Origin-less requests through, which is fine for a single trusted machine
// but not once the port is reachable from a wider network. Same-machine
// requests (loopback remoteAddress) stay exempt regardless, so local peers/
// workers keep working with zero extra config.
const enterpriseMode = ["1", "true", "yes"].includes(pick("NEUROWORKS_ENTERPRISE_MODE", "").toLowerCase());
const serveWeb = ["1", "true", "yes"].includes(pick("SERVE_WEB", "").toLowerCase());
// web/dist sits at clawbot/web/dist; __dirname is server/src (tsx) so ../../web/dist.
const webDistPath = resolve(__dirname, "../../web/dist");
const nodeEnv = (process.env.NODE_ENV ?? "development").trim().toLowerCase();
const isProduction = nodeEnv === "production";
// Strict env validation: on in production, or forced with NEUROWORKS_STRICT_ENV=1.
const strictEnv = isProduction || ["1", "true", "yes"].includes((process.env.NEUROWORKS_STRICT_ENV ?? "").toLowerCase());

export const config = {
  githubToken,
  githubOwner,
  vaultRepo,
  vaultPath,
  localFilesPath,
  ollamaHost,
  ollamaModel,
  naxionBaseUrl,
  googleClientId,
  googleClientSecret,
  googleOauthEnabled: googleClientId.length > 0 && googleClientSecret.length > 0,
  googleRedirectUri,
  microsoftClientId,
  microsoftClientSecret,
  microsoftOauthEnabled: microsoftClientId.length > 0 && microsoftClientSecret.length > 0,
  microsoftTenantId,
  microsoftRedirectUri,
  naxieWebUrl,
  effortMode: effortMode as "auto" | "low" | "high",
  openrouterApiKey,
  openrouterBaseUrl,
  openrouterModel,
  openrouterLargeModel,
  openrouterProfiles,
  openrouterAppUrl,
  openrouterAppName,
  openrouterEnabled: openrouterApiKey.length > 0,
  firecrawlApiKey,
  firecrawlBaseUrl,
  firecrawlEnabled: firecrawlApiKey.length > 0,
  supabaseUrl,
  supabasePublishableKey,
  supabaseSecretKey,
  supabaseEnabled: supabaseUrl.length > 0 && supabaseSecretKey.length > 0,
  supabaseDbUrl,
  pgvectorEnabled: supabaseDbUrl.length > 0,
  openaiEmbeddingApiKey,
  openaiEmbeddingBaseUrl,
  openaiEmbeddingModel,
  openaiEmbeddingEnabled: openaiEmbeddingApiKey.length > 0,
  heygenApiKey,
  heygenBaseUrl,
  heygenEnabled: heygenApiKey.length > 0,
  n8nBaseUrl,
  n8nApiKey,
  n8nWebhookBaseUrl,
  n8nEnabled: n8nBaseUrl.length > 0 && n8nApiKey.length > 0,
  openrouterImageModel,
  ideogramApiKey,
  ideogramBaseUrl,
  ideogramModel,
  ideogramEnabled: ideogramApiKey.length > 0,
  muapiApiKey,
  muapiBaseUrl,
  muapiEnabled: muapiApiKey.length > 0,
  studioImageProvider,
  // Init-time hint only — the authoritative, runtime-aware check is
  // availableImageProviders() in lib/studio-image.ts, which also sees the
  // OpenRouter key applied at runtime by an active provider (the zero-config
  // path that makes image generation live out of the box).
  studioImageEnabled: ideogramApiKey.length > 0 || muapiApiKey.length > 0 || openrouterApiKey.length > 0,
  hermesModel,
  hermesProvider,
  hermesLocalModel,
  hermesLocalProvider,
  port,
  peers,
  name,
  role,
  bindHost,
  enterpriseMode,
  serveWeb,
  webDistPath,
  nodeEnv,
  isProduction,
  strictEnv,
  ready: missing.length === 0,
  missing: [...missing],
};

if (missing.length > 0) {
  console.warn(`\n⚠  NeuroWorks server starting with degraded mode — missing: ${missing.join(", ")}`);
  console.warn(`   Copy .env.example -> .env and fill in to unlock GitHub/vault features.\n`);
}

// ── Fail-fast validation ───────────────────────────────────────────────
// Call once at boot BEFORE wiring routes. In strict mode (production, or
// NEUROWORKS_STRICT_ENV=1) any fatal misconfiguration exits with a clear,
// actionable message instead of surfacing as a confusing failure deep in a
// request. In non-strict/local mode these become warnings so `pnpm dev` still
// boots in degraded mode. Returns nothing; calls process.exit(1) on fatal.
export function validateConfig(): void {
  const fatal: string[] = [];
  const warn: string[] = [];

  // Port must be a real listenable number.
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fatal.push(`NEUROWORKS_PORT="${process.env.NEUROWORKS_PORT ?? ""}" is not a valid TCP port (1-65535).`);
  }

  // Serving the built SPA requires the build to exist — otherwise every page
  // load 404s with no hint. Check for the entry file, not just the dir.
  if (serveWeb) {
    const indexHtml = resolve(webDistPath, "index.html");
    if (!existsSync(indexHtml)) {
      fatal.push(`SERVE_WEB is on but no built SPA found at ${webDistPath} — run "pnpm -F neuroworks-web build" first.`);
    }
  }

  // Exposing the server beyond loopback without the origin guard is a DNS-
  // rebinding hole. Allow it only when explicitly overridden.
  if (bindHost !== "127.0.0.1" && bindHost !== "localhost" && process.env.NEUROWORKS_ORIGIN_GUARD === "0") {
    warn.push(`bound to ${bindHost} with NEUROWORKS_ORIGIN_GUARD=0 — the API is reachable off-host with no Host/Origin defense. Put it behind a trusted reverse proxy only.`);
  }
  // Wide bind + enterprise mode off means every route requireLayer() doesn't
  // cover (the majority — see lib/access.ts) has NO auth for non-browser
  // callers; origin-guard only defends the browser vector. This exposes the
  // whole API (incl. superadmin Terminal/Connectors/Cost) to the network, so
  // it is FATAL by default. A deliberate deploy behind a trusted authenticating
  // reverse proxy can opt in with NEUROWORKS_ALLOW_INSECURE_BIND=1.
  const allowInsecureBind = process.env.NEUROWORKS_ALLOW_INSECURE_BIND === "1";
  if (bindHost !== "127.0.0.1" && bindHost !== "localhost" && !enterpriseMode && !allowInsecureBind) {
    fatal.push(`bound to ${bindHost} with NEUROWORKS_ENTERPRISE_MODE unset — most routes have NO authentication for non-browser callers, exposing the entire API to the network. Set NEUROWORKS_ENTERPRISE_MODE=1 (and mint a "machine:full" API key for cross-host peers). If this instance genuinely sits behind a trusted authenticating reverse proxy, set NEUROWORKS_ALLOW_INSECURE_BIND=1 to accept the risk.`);
  }

  // In strict mode the required env (GITHUB_TOKEN etc.) must actually be set.
  if (strictEnv && missing.length > 0) {
    fatal.push(`missing required env in production: ${missing.join(", ")}. Set these in .env or the container environment.`);
  }

  for (const w of warn) console.warn(`⚠  [config] ${w}`);

  if (fatal.length > 0) {
    console.error(`\n✖  NeuroWorks refused to start — fatal configuration ${fatal.length === 1 ? "error" : "errors"}:`);
    for (const f of fatal) console.error(`   • ${f}`);
    console.error(`\n   (strict validation is ${strictEnv ? "ON" : "OFF"}; set NEUROWORKS_STRICT_ENV=0 to downgrade to warnings for local dev.)\n`);
    process.exit(1);
  }
}
