import express from "express";
import compression from "compression";
import { existsSync } from "node:fs";
import { resolve, basename, sep } from "node:path";
import { MEDIA_DIR } from "./lib/studio-image.js";
import { config, validateConfig } from "./config.js";
import { statusRouter } from "./routes/status.js";
import { securityWatch, securityStatus, unblockIp } from "./lib/security-watch.js";
import { reposRouter } from "./routes/repos.js";
import { brainRouter } from "./routes/brain.js";
import { storageRouter } from "./routes/storage.js";
import { filesRouter } from "./routes/files.js";
import { tasksRouter } from "./routes/tasks.js";
import { myTasksRouter } from "./routes/my-tasks.js";
import { personalFinanceRouter } from "./routes/personal-finance.js";
import { businessFinanceRouter } from "./routes/business-finance.js";
import { templatesRouter } from "./routes/templates.js";
import { chatRouter } from "./routes/chat.js";
import { personasRouter } from "./routes/personas.js";
import { peersRouter } from "./routes/peers.js";
import { localInflightCount } from "./lib/peers.js";
import { modelsRouter } from "./routes/models.js";
import { ollamaGenerate } from "./lib/ollama.js";
import { shutdownCommitQueue } from "./lib/commit-queue.js";
import { startVaultWatcher, stopVaultWatcher, startVaultPullScheduler, stopVaultPullScheduler, getVaultHealth } from "./lib/vault.js";
import { buildIndex, loadPersistedIndex } from "./lib/vault-index.js";
import { autodiscoverLocalPeers } from "./lib/peer-registry.js";
import { ensurePool, shutdownManagedWorker } from "./lib/worker-manager.js";
import { loadPersonas } from "./lib/personas.js";
import { ensureAllPersonasHaveTemplates } from "./lib/persona-templates.js";
import { startReflectionScheduler, stopReflectionScheduler } from "./lib/reflection.js";
import { startInnovationScanScheduler, stopInnovationScanScheduler } from "./lib/innovation-scan.js";
import { startSystemAuditScheduler, stopSystemAuditScheduler, startWeeklyBoardScheduler, stopWeeklyBoardScheduler } from "./lib/system-audit.js";
import { startTodoBriefScheduler, stopTodoBriefScheduler, runTodoBrief } from "./lib/todo-brief.js";
import { startTaskAutomationScheduler, stopTaskAutomationScheduler, registerNativeHandler, seedAutomationIfMissing } from "./lib/my-tasks.js";
import { startWeeklyRollupScheduler, stopWeeklyRollupScheduler } from "./lib/weekly-rollup.js";
import { startWeeklyImprovementScheduler, stopWeeklyImprovementScheduler } from "./lib/weekly-improvement.js";
import { startWikiCompileScheduler, stopWikiCompileScheduler, startWikiDigestScheduler, stopWikiDigestScheduler } from "./lib/wiki-compile.js";
import { ensureAgentsMdExists } from "./lib/agents-routing.js";
import { abortInflightJobs } from "./lib/jobs.js";
import { reflectionRouter } from "./routes/reflection.js";
import { innovationScanRouter } from "./routes/innovation-scan.js";
import { todoBriefRouter } from "./routes/todo-brief.js";
import { weeklyRollupRouter } from "./routes/weekly-rollup.js";
import { weeklyImprovementRouter } from "./routes/weekly-improvement.js";
import { systemAuditRouter } from "./routes/system-audit.js";
import { wikiCompileRouter } from "./routes/wiki-compile.js";
import { skillsRouter } from "./routes/skills.js";
import { uploadsRouter } from "./routes/uploads.js";
import { teamRouter } from "./routes/team.js";
import { teamsRouter } from "./routes/teams.js";
import { handoffRouter } from "./routes/handoff.js";
import { boardRouter } from "./routes/board.js";
import { workforceRouter } from "./routes/workforce.js";
import { schedulesRouter } from "./routes/schedules.js";
import { startScheduleScheduler, stopScheduleScheduler } from "./lib/schedules.js";
import { startApprovalEscalationSweep, stopApprovalEscalationSweep } from "./lib/action-approvals.js";
import { hostToolsRouter } from "./routes/host-tools.js";
import { daemonSettingsRouter } from "./routes/daemon-settings.js";
import { toolDnaRouter } from "./routes/tool-dna.js";
import { offlineModeRouter } from "./routes/offline-mode.js";
import { installOfflineNetworkGuard, onOfflineChange, isOffline } from "./lib/offline-mode.js";
import { orgTasksRouter } from "./routes/org-tasks.js";
import { oauthConnectorsRouter } from "./routes/oauth-connectors.js";
import { localFolderRouter } from "./routes/local-folder.js";
import { startOrgDaemon, stopOrgDaemon } from "./lib/org-daemon.js";
import { hydrateMemoryFromSupabaseIfLocalEmpty } from "./lib/memory.js";
import { governanceRouter } from "./routes/governance.js";
import { emailRouter } from "./routes/email.js";
import { externalAgentsRouter } from "./routes/external-agents.js";
import { feedbackRouter } from "./routes/feedback.js";
import { exportsRouter } from "./routes/exports.js";
import { calendarRouter } from "./routes/calendar.js";
import { dataSourcesRouter } from "./routes/data-sources.js";
import { terminalRouter } from "./routes/terminal.js";
import { integrationsRouter } from "./routes/integrations.js";
import { presetsRouter } from "./routes/presets.js";
import { connectorsRouter } from "./routes/connectors.js";
import { githubAccountsRouter } from "./routes/github-accounts.js";
import { projectsRouter } from "./routes/projects.js";
import { schedulerRouter } from "./routes/scheduler.js";
import { mcpServersRouter } from "./routes/mcp-servers.js";
import { extensionsRouter } from "./routes/extensions.js";
import { pentestRouter } from "./routes/pentest.js";
import { crmRouter } from "./routes/crm.js";
import { naxieRouter } from "./routes/naxie.js";
import { onboardingRouter } from "./routes/onboarding.js";
import { seedAiiAWebsiteConnector, seedPublicApiConnectors } from "./lib/connectors.js";
import { executorRouter } from "./routes/executor.js";
import { primitivesRouter } from "./routes/primitives.js";
import { hermesBridgeRouter } from "./routes/hermes-bridge.js";
import { whatsappBridgeRouter } from "./routes/whatsapp-bridge.js";
import { brandsRouter } from "./routes/brands.js";
import { seedDefaultBrands } from "./lib/brands.js";
import { brandSignalsRouter } from "./routes/brand-signals.js";
import { usersRouter } from "./routes/users.js";
import { assignmentsRouter } from "./routes/assignments.js";
import { voiceRouter } from "./routes/voice.js";
import { authRouter } from "./routes/auth.js";
import { departmentsRouter } from "./routes/departments.js";
import { officeNotesRouter } from "./routes/office-notes.js";
import { dispatchRouter, dispatchKeysRouter } from "./routes/dispatch.js";
import { publicFinanceRouter } from "./routes/public-finance.js";
import { agentIngestRouter } from "./routes/agent-ingest.js";
import { datasetsRouter } from "./routes/datasets.js";
import { omnisignalRouter } from "./routes/omnisignal.js";
import { qualityRouter } from "./routes/quality.js";
import { costRouter } from "./routes/cost.js";
import { auditRouter } from "./routes/audit.js";
import { skillForgeRouter } from "./routes/skill-forge.js";
import { orchestratorRouter } from "./routes/orchestrator.js";
import { startEmailBridge, stopEmailBridge } from "./lib/email.js";
import { startTelegramBridge, stopTelegramBridge } from "./lib/telegram-bridge.js";
import { startWhatsAppBridge, stopWhatsAppBridge } from "./lib/whatsapp-bridge.js";
import { startExtensionHealthScheduler, stopExtensionHealthScheduler } from "./lib/extension-scheduler.js";
import { startGithubWatcher } from "./lib/github-watcher.js";
import { originGuard, ALLOWED_ORIGINS } from "./lib/origin-guard.js";
import { securityHeaders } from "./lib/security-headers.js";
import { enterpriseAuthGuard } from "./lib/enterprise-auth.js";
import { applyRagOverrides } from "./lib/rag-config.js";

// Fail-fast: refuse to boot on a fatal misconfiguration (bad port, SERVE_WEB
// without a build, missing required env in production). No-op warnings locally.
validateConfig();
// Offline mode (header "Go offline" button) — wrap fetch + outbound sockets
// before any background job can open a connection. Local + LAN stay allowed.
installOfflineNetworkGuard();
onOfflineChange((offline) => {
  void (async () => {
    try { const { clearConnectivityCache } = await import("./lib/connectivity.js"); clearConnectivityCache(); } catch { /* best-effort */ }
    if (offline) {
      // Going offline — Hermes must run on the local model too (its cloud
      // path would just fail). The operator can switch it back manually.
      try {
        const { getExecutorConfig, setExecutorConfig } = await import("./lib/executor-mode.js");
        if (!getExecutorConfig().hermesLocal) {
          setExecutorConfig({ hermesLocal: true });
          console.log("[offline-mode] Hermes switched to local model (offline — local models only)");
        }
      } catch { /* best-effort */ }
    } else {
      // Back online — flush vault commits that stayed local while offline.
      try {
        const { pushOnly } = await import("./lib/vault.js");
        const r = await pushOnly();
        console.log(`[offline-mode] back online — vault push ${r.pushed ? "ok" : `deferred (${r.error ?? "unknown"})`}`);
      } catch (e: any) { console.warn(`[offline-mode] vault push after reconnect failed: ${e?.message ?? e}`); }
    }
  })();
});
if (isOffline()) console.log("  ⓘ offline mode is ON — internet disabled, local + LAN only");
// UI-settable vector-store credentials (see routes/extensions.ts's /rag/config)
// win over whatever config.ts already picked from .env — apply them before
// anything reads config.pgvectorEnabled/openaiEmbeddingEnabled.
applyRagOverrides();

const app = express();
// Trust proxy — required so req.ip reflects the real client behind a reverse
// proxy / ingress (security-watch flood/auth scoring would otherwise score the
// proxy IP). Enabled when enterprise-mode or an explicit trust-proxy env is set;
// loopback-only dev needs no proxy and stays 0 for least surprise.
if (config.enterpriseMode || process.env.NEUROWORKS_TRUST_PROXY === "1" || process.env.NEUROWORKS_BEHIND_PROXY === "1") {
  app.set("trust proxy", 1);
}
if (process.env.NEUROWORKS_ALLOW_INSECURE_BIND === "1" && config.bindHost !== "127.0.0.1" && config.bindHost !== "localhost") {
  console.warn(`\n⚠  [security] NEUROWORKS_ALLOW_INSECURE_BIND=1 with bind ${config.bindHost} — API is reachable off-host with no Host/Origin defense beyond what originGuard provides. Only use behind a trusted authenticating reverse proxy.\n`);
}
// CSP + Permissions-Policy (absent before now — see lib/security-headers.ts)
// applied first so every response carries them, including an early error.
app.use(securityHeaders);
// Gzip/brotli every compressible response — the built SPA's JS/CSS, JSON API
// responses, markdown. Only touches the OUTGOING body so it's safe ahead of
// the raw-body webhook parsers below (those need the raw REQUEST body,
// unaffected by response compression). Real transfer-size win on every
// request, not just the initial page load, and stateless per-request so it
// doesn't interact with horizontal scale-out at all.
app.use(compression());
// JSON body, but also accept text/plain (navigator.sendBeacon defaults to
// it when given a plain JSON Blob) so the chat unmount-save reaches us.
// 25 MB limit accommodates base64-encoded document uploads (a 15 MB PDF
// base64-encodes to ~20 MB). Most uploads are <2 MB; the cap exists to
// stop accidental DOS via giant payloads, not to be aspirationally generous.
// Machine-to-machine endpoints (external dispatch + Finance System ingest) take
// small JSON only — reject oversized bodies BEFORE the 25MB parser buffers them.
// The 25MB limit exists for base64 document uploads on the browser API, not here.
const MACHINE_BODY_LIMIT = Number(process.env.NW_MACHINE_BODY_LIMIT_BYTES ?? "262144") || 262144; // 256KB
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/v1/") && !req.path.startsWith("/api/public/")) return next();
  const len = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(len) && len > MACHINE_BODY_LIMIT) {
    return res.status(413).json({ error: "payload_too_large", message: `Body exceeds ${MACHINE_BODY_LIMIT} bytes for this endpoint.` });
  }
  next();
});
app.use(express.json({ limit: "25mb", type: ["application/json", "text/plain"] }));
app.use((req, res, next) => {
  // Reflect the request's Origin only if it's actually in the allow-list
  // (the same one origin-guard enforces below) instead of a single hardcoded
  // dev URL — a second copy of that list here would silently drift from it.
  // Same-origin / non-browser requests carry no Origin and need no CORS
  // header at all.
  const reqOrigin = req.headers.origin;
  if (typeof reqOrigin === "string" && ALLOWED_ORIGINS.has(reqOrigin.toLowerCase())) {
    res.setHeader("Access-Control-Allow-Origin", reqOrigin);
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Api-Key, X-Session-Token, Idempotency-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  // Baseline security headers — no framing, no MIME-sniffing, no referrer
  // leakage, HSTS for the (rare) TLS-terminated-here case. Real defense for
  // this app is origin-guard/enterprise-auth above, not these — but "no
  // security headers at all" fails any basic scan, so ship the free ones.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  next();
});
app.options("*", (_req, res) => res.sendStatus(204));
// Host + Origin allow-list check. Defends against DNS rebinding (Host
// header carries the attacker's domain, not 127.0.0.1:7471) and cross-
// origin browser POSTs (Origin header reveals the source page). Loopback
// bind alone isn't enough — text/plain JSON POSTs skip CORS preflight.
// See origin-guard.ts for the threat model.
app.use(originGuard);
// Attack detection + auto-blocking (scanner probes, traversal, injection
// signatures, auth-failure bursts, floods). Loopback is logged but never
// blocked — see lib/security-watch.ts.
app.use(securityWatch);
// Real authentication for non-browser callers when this instance is
// network-exposed. No-op unless NEUROWORKS_ENTERPRISE_MODE=1 — see
// lib/enterprise-auth.ts for what problem this closes.
app.use(enterpriseAuthGuard);

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  name: config.name,
  role: config.role,
  version: "0.1.0",
  model: config.ollamaModel,
  // Surface OpenRouter capability so peers and the UI can tell whether this
  // clawbot has a cloud accelerator wired up. Just the on/off + default model —
  // health check itself stays at /api/status/llm.
  openrouter: config.openrouterEnabled ? { enabled: true, model: config.openrouterModel } : { enabled: false },
  port: config.port,
  ready: config.ready,
  missing: config.missing,
  inflightJobs: localInflightCount(),
  peers: config.peers,
  // Vault reachability — surfaced here so EVERY dashboard surface can show
  // "vault unreachable" without an extra round-trip. Banner-friendly shape.
  vault: getVaultHealth(),
}));
// Generated media (images/audio/video from media.image, media.tts, …) live in
// .neuroworks/media. Serve them here so the UI and email can offer a real
// DOWNLOAD, not just an on-disk path. Read-only, single flat directory, with a
// hard basename check so no "..%2f" or nested path can escape the media dir.
app.get("/api/media/:file", (req, res) => {
  const raw = String(req.params.file ?? "");
  const safe = basename(raw); // strips any directory component
  if (!safe || safe !== raw || safe.startsWith(".")) {
    return res.status(400).json({ error: "bad filename" });
  }
  const full = resolve(MEDIA_DIR, safe);
  if (!full.startsWith(MEDIA_DIR + sep) || !existsSync(full)) {
    return res.status(404).json({ error: "not found" });
  }
  const download = req.query.download === "1" || req.query.dl === "1";
  if (download) res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
  res.sendFile(full);
});
app.use("/api/status", statusRouter);
app.use("/api/repos", reposRouter);
app.use("/api/brain", brainRouter);
app.use("/api/storage", storageRouter);
app.use("/api/files", filesRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/my-tasks", myTasksRouter); // operator's personal to-do list — distinct from the agent job queue above
app.use("/api/personal-finance", personalFinanceRouter); // operator's own budget — distinct from Aria's company/market finance feed
app.use("/api/business-finance", businessFinanceRouter); // Variety & Co books — price book, leakage, forecast, gated spends
app.use("/api/templates", templatesRouter);
app.use("/api/chat", chatRouter);
app.use("/api/personas", personasRouter);
app.use("/api/peers", peersRouter);
app.use("/api/models", modelsRouter); // provider API keys
app.use("/api/reflection", reflectionRouter);
app.use("/api/innovation-scan", innovationScanRouter);
app.use("/api/todo-brief", todoBriefRouter);
app.use("/api/weekly-rollup", weeklyRollupRouter);
app.use("/api/weekly-improvement", weeklyImprovementRouter);
app.use("/api/system-audit", systemAuditRouter);
app.use("/api/wiki-compile", wikiCompileRouter);
app.use("/api/skills", skillsRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/team", teamRouter);
app.use("/api/teams", teamsRouter);
app.use("/api/handoff", handoffRouter);
app.use("/api/board", boardRouter);
app.use("/api/workforce", workforceRouter);
app.use("/api/schedules", schedulesRouter);
app.use("/api/host-tools", hostToolsRouter);
app.use("/api/daemon-settings", daemonSettingsRouter);
app.use("/api/tool-dna", toolDnaRouter);
app.use("/api/offline-mode", offlineModeRouter);
app.use("/api/org-tasks", orgTasksRouter);
app.use("/api/local-folder", localFolderRouter); // "My documents" indexing — native replacement for naxionai/backend's local-folder endpoints
app.use("/api/governance", governanceRouter);
// Security watchdog readout — recent attack events + currently blocked IPs.
app.get("/api/security/events", (_req, res) => res.json(securityStatus()));
app.post("/api/security/unblock", (req, res) => {
  const ip = String(req.body?.ip ?? "").trim();
  if (!ip) return res.status(400).json({ error: "ip is required" });
  res.json({ ok: true, unblocked: unblockIp(ip) });
});
app.use("/api/email", emailRouter);
app.use("/api/external-agents", externalAgentsRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/exports", exportsRouter);
app.use("/api/calendar", calendarRouter);
app.use("/api/data-sources", dataSourcesRouter); // external DB credentials + department data
app.use("/api/terminal", terminalRouter); // shell access
app.use("/api/integrations", integrationsRouter); // service secrets
app.use("/api/presets", presetsRouter);
// Google/Microsoft OAuth connectors — mounted BEFORE the generic
// connectorsRouter below so its literal /google/* and /microsoft/* paths are
// claimed first; everything else falls through to connectorsRouter unchanged.
app.use("/api/connectors", oauthConnectorsRouter);
app.use("/api/connectors", connectorsRouter); // connector credentials
app.use("/api/github-accounts", githubAccountsRouter); // GitHub PATs, one per account
app.use("/api/projects", projectsRouter); // repos grouped per account, watched for new commits
app.use("/api/scheduler", schedulerRouter); // orchestration-core engine introspection
app.use("/api/mcp-servers", mcpServersRouter); // spawns local processes
app.use("/api/extensions", extensionsRouter); // unified plugins/extensions monitor + connect (webhook is public via secret)
app.use("/api/pentest", pentestRouter); // Strix-backed security scans; scan status/logs reuse the generic job endpoints
app.use("/api/crm", crmRouter); // contacts/deals/activities — local JSON store, no external CRM required
app.use("/api/executor", executorRouter); // flips who/what executes tasks (spend implications)
app.use("/api/primitives", primitivesRouter);
app.use("/api/hermes-bridge", hermesBridgeRouter); // status/register for the clawbot-mcp.mjs ↔ Hermes bridge
app.use("/api/whatsapp", whatsappBridgeRouter); // status/reconnect for the Baileys WhatsApp bridge
app.use("/api/brands", brandsRouter); // marketing brand registry (personal/work/business)
app.use("/api/brand-signals", brandSignalsRouter); // own-brand mention/opportunity monitoring, MAIA-shaped
app.use("/api/users", usersRouter); // directory admin (salary redaction inside)
app.use("/api/assignments", assignmentsRouter); // human-in-the-loop work (My Work page; per-route access checks inside)
app.use("/api/voice", voiceRouter); // employee voices: report Q&A, local TTS proxy, realtime session mint
app.use("/api/naxie", naxieRouter); // RAG/MAG/CAG inspector + remember (second-in-command memory)
app.use("/api/onboarding", onboardingRouter); // wizard: operator identity + sector/org profile; bypasses users.json entirely
app.use("/api/auth", authRouter);
app.use("/api/departments", departmentsRouter);
app.use("/api/office-notes", officeNotesRouter);
// External agent-dispatch surface (API-key auth; originGuard exempts /api/v1/).
app.use("/api/v1/dispatch", dispatchRouter);
// Operator-only API-key management (stays behind originGuard).
app.use("/api/dispatch-keys", dispatchKeysRouter); // mints external machine-dispatch API keys (origin-guard-exempt) — operator-only
// Public Finance System ingest/read surface (server-to-server; origin-guard
// exempts /api/public/, writes optionally gated by FINANCE_SYNC_TOKEN).
app.use("/api/datasets", datasetsRouter);
app.use("/api/omnisignal", omnisignalRouter);
app.use("/api/public", publicFinanceRouter);
// External news ingest (same /api/public origin-guard exemption as above),
// gated by AGENT_INGEST_TOKEN — see routes/agent-ingest.ts.
app.use("/api/public/agent", agentIngestRouter);
app.use("/api/quality", qualityRouter);
app.use("/api/cost", costRouter); // money
app.use("/api/audit", auditRouter); // audit trail (actors, role changes, sensitive-tool calls)
app.use("/api/skill-forge", skillForgeRouter); // writes org-wide agent skill playbooks
app.use("/api/orchestrate", orchestratorRouter);

// ── Production SPA serving ─────────────────────────────────────────────
// When SERVE_WEB=1 (the container), THIS server serves the built, minified
// web/dist directly — no Vite dev server in production. Mounted AFTER every
// /api route so it can never shadow an API path. Static assets are served with
// long-lived immutable caching (Vite fingerprints filenames); index.html is
// always revalidated so a new deploy is picked up. Unknown non-/api GETs fall
// through to index.html for client-side routing (history fallback). An
// unmatched /api path still 404s as JSON rather than returning the SPA shell.
if (config.serveWeb && existsSync(config.webDistPath)) {
  const indexHtml = resolve(config.webDistPath, "index.html");
  app.use(express.static(config.webDistPath, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
      else if (/[.-][a-f0-9]{8,}\.\w+$/i.test(filePath)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next(); // let the API 404 handler own it
    if (req.method !== "GET") return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexHtml);
  });
  console.log(`  ⓘ serving built web SPA from ${config.webDistPath}`);
}

// Unmatched /api/* → stable JSON 404 (not Express's default HTML page) so API
// and dispatch clients always get a parseable body. Mounted after every router
// and the SPA fallback, so it only catches genuinely unknown API paths.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "not_found", message: `No API route for ${req.method} ${req.originalUrl ?? req.url}`, path: req.originalUrl ?? req.url });
});

// Global error handler — every route mounts before this so any throw bubbles
// up here. We log the request method+url for debugability and return a
// stable JSON shape the web client already knows how to render. Stack traces
// stay server-side; only the message goes to the customer.
app.use((err: any, req: any, res: any, _next: any) => {
  const stamp = new Date().toISOString();
  console.error(`[${stamp}] [express-error] ${req.method} ${req.originalUrl ?? req.url}`);
  console.error(err?.stack ?? err);
  if (res.headersSent) return;
  // Scrub credentials / connection strings from the client-facing message. DB
  // and connector driver errors can embed a full DSN (postgres://user:pass@host)
  // or `password=...`; the full detail stays in the server log above.
  const rawMsg = err?.message ?? String(err);
  const leaks = /\b\w+:\/\/[^\s]*@|password\s*[=:]|api[_-]?key\s*[=:]|authorization:\s*bearer/i;
  const clientMsg = leaks.test(rawMsg) ? "Internal error (details in server log)." : rawMsg;
  res.status(500).json({
    error: clientMsg,
    path: req.originalUrl ?? req.url,
    when: stamp,
  });
});

// Process-level safety nets — async work fired with `void` (job runners,
// scheduler ticks) can produce unhandled rejections that crash the server
// silently. We log them but DON'T exit; one bad task shouldn't take the
// fleet down. Same for uncaughtException — log and keep running.
process.on("unhandledRejection", (reason: any) => {
  console.error(`[unhandled-rejection] ${reason?.stack ?? reason}`);
});
process.on("uncaughtException", (err: any) => {
  console.error(`[uncaught-exception] ${err?.stack ?? err}`);
});

const server = app.listen(config.port, config.bindHost, async () => {
  console.log(`\n  ▶ neuroworks server: http://${config.bindHost}:${config.port}`);
  console.log(`    web ui will open at: http://127.0.0.1:7470`);
  console.log(`    vault:  ${config.vaultPath}`);
    console.log(`    ollama: ${config.ollamaHost} (${config.ollamaModel})\n`);

  // Shell build: the workspace ships with NO connectors — UAT operators add
  // their own on the Connectors page. The old demo/company connectors only seed
  // when explicitly asked for via NEUROWORKS_SEED_DEMO_CONNECTORS=1. Idempotent,
  // primary-only (workers share connectors.json and would race on a cold store).
  if (config.role === "primary" && process.env.NEUROWORKS_SEED_DEMO_CONNECTORS === "1") {
    try { const s = seedAiiAWebsiteConnector(); if (s) console.log(`  ✓ seeded connector "${s.label}" (${s.endpoints?.length ?? 0} endpoints)`); }
    catch (e: any) { console.warn(`  ⚠ connector seeding failed: ${e?.message ?? e}`); }
    try { const seeded = seedPublicApiConnectors(); if (seeded.length) console.log(`  ✓ seeded ${seeded.length} free public-API connector(s): ${seeded.join(", ")}`); }
    catch (e: any) { console.warn(`  ⚠ public-API connector seeding failed: ${e?.message ?? e}`); }
  }

  // Re-apply a UI-added active model provider (BYO API key) to the runtime
  // router so it survives restarts without editing .env.
  import("./lib/model-providers.js").then(m => { try { m.loadAndApplyActiveProvider(); } catch { /* tolerate */ } }).catch(() => {});

  // Pre-warm the default model so the first user task doesn't pay model-load
  // tax (5-8s on cold cache). Fire-and-forget — server is already accepting
  // requests; we just want the model resident in Ollama's memory by the time
  // someone clicks Send. Skipped if NEUROWORKS_NO_WARMUP=1.
  //
  // We now warm every UNIQUE model the profile router could pick — default +
  // any profile-specific env pin. Triage on qwen3.5:0.8b + synthesis on
  // qwen2.5:3b means two cold-load hits on the first ad-hoc task; warming
  // both at boot eliminates both.
  if (process.env.NEUROWORKS_NO_WARMUP !== "1") {
    const toWarm = new Set<string>([config.ollamaModel]);
    for (const envKey of ["OLLAMA_TRIAGE_MODEL", "OLLAMA_PLAN_MODEL", "OLLAMA_SYNTH_MODEL", "OLLAMA_EXTRACT_MODEL", "OLLAMA_BALANCED_MODEL"]) {
      const v = process.env[envKey]?.trim();
      if (v) toWarm.add(v);
    }
    for (const model of toWarm) {
      const t0 = Date.now();
      ollamaGenerate("ok", "Reply with a single word.", { model })
        .then(() => console.log(`  ✓ warmed ${model} in ${Math.round((Date.now() - t0) / 1000)}s`))
        .catch((e: any) => console.warn(`  ⚠ warm-up failed for ${model}: ${e?.message ?? e}`));
    }
    // Pre-warm OpenRouter too if configured (skipped offline — Naxie uses
    // local models only). First OR request pays a DNS+TLS
    // round-trip (~500-1000ms) — warming it knocks that off the first user
    // task. We hit the cheap default model; a tiny 5-token prompt is
    // sufficient to establish the TLS session.
    if (config.openrouterEnabled && !isOffline()) {
      const t0 = Date.now();
      void import("./lib/openrouter.js").then(m =>
        m.openrouterGenerate("ok", "Reply with a single word.", { model: config.openrouterModel, maxTokens: 4 })
          .then(() => console.log(`  ✓ warmed OpenRouter (${config.openrouterModel}) in ${Math.round((Date.now() - t0) / 1000)}s`))
          .catch((e: any) => console.warn(`  ⚠ OpenRouter warm-up failed: ${e?.message ?? e}`))
      );
    }
  }

  // Scan localhost for other clawbot instances. Saves the user from having
  // to set NEUROWORKS_PEERS just to wire the primary ↔ secondary loop together.
  // Disabled with NEUROWORKS_NO_AUTODISCOVER=1.
  if (process.env.NEUROWORKS_NO_AUTODISCOVER !== "1") {
    autodiscoverLocalPeers()
      .then(r => { if (r.found > 0) console.log(`  ✓ auto-discovered ${r.found} peer${r.found === 1 ? "" : "s"} on localhost`); })
      .catch(() => { /* swallow */ });
    // Re-scan every 60s so a secondary started AFTER the primary still gets
    // picked up automatically. Cheap (5 ports, 1.2s timeout, parallel).
    setInterval(() => { void autodiscoverLocalPeers().catch(() => {}); }, 60_000).unref();
  }

  // Backfill starter templates for any persona that's missing them — covers
  // built-ins that were seeded before the refresher landed AND custom
  // personas created when the curated table didn't yet have an entry.
  try {
    const store = loadPersonas();
    const filled = ensureAllPersonasHaveTemplates(store.personas);
    for (const f of filled) {
      const verb = f.refreshed ? "refreshed" : "generated";
      console.log(`  ⓘ ${verb} ${f.added} starter template${f.added === 1 ? "" : "s"} for persona "${f.personaId}"`);
    }
  } catch (e: any) {
    console.warn(`  ⚠ persona template backfill failed: ${e?.message ?? e}`);
  }

  // Seed the operator's 3 brands (personal / work=AIIA / business=Variety
  // Vault) on first boot — idempotent (no-ops once .neuroworks/brands.json
  // exists), unlike the demo connectors above: these are real identities, not
  // sample data, so they always seed rather than requiring an opt-in flag.
  try {
    seedDefaultBrands();
  } catch (e: any) {
    console.warn(`  ⚠ brand seeding failed: ${e?.message ?? e}`);
  }

  // Parent-death watchdog (managed workers only). worker-manager.ts sets
  // NEUROWORKS_PARENT_PID when it spawns us; if that primary process vanishes
  // ungracefully (crash/OOM/SIGKILL — graceful shutdown reaps us directly),
  // exit so we don't linger as an orphan holding a port. process.kill(pid, 0)
  // sends no signal, just probes existence: it throws ESRCH once the parent
  // is gone.
  if (config.role !== "primary" && process.env.NEUROWORKS_PARENT_PID) {
    const parentPid = Number(process.env.NEUROWORKS_PARENT_PID);
    if (Number.isFinite(parentPid) && parentPid > 0) {
      const wd = setInterval(() => {
        try { process.kill(parentPid, 0); }
        catch { console.warn(`  ⏻ parent primary (pid ${parentPid}) gone — worker self-terminating`); process.exit(0); }
      }, 5_000);
      wd.unref();
    }
  }

  // Seed Naxie MAG identity files (RAG/MAG/CAG — operator, Naxie, subagents) so
  // Naxie and every subagent remember who they are even after a fresh boot.
  try {
    const { ensureMagIdentityFiles } = await import("./lib/mag.js");
    const seeded = ensureMagIdentityFiles();
    console.log(`  ⓘ MAG identity seeded — ${Object.values(seeded).join(", ")}`);
  } catch (e: any) { console.warn(`  ⚠ MAG seed failed: ${e?.message ?? e}`); }

  // Auto-spawn a managed worker POOL if we are the primary. With >1 worker,
  // concurrent tasks fan out across the pool (least-loaded routing) instead of
  // funnelling to a single agent — the "only one agent working" fix. Pool size
  // is NEUROWORKS_POOL_WORKERS (default 2; capped at NEUROWORKS_MAX_WORKERS). Set
  // NEUROWORKS_AUTO_SPAWN_WORKER=0 to disable spawning entirely, or
  // NEUROWORKS_POOL_WORKERS=1 to keep a single worker. The user gets parallel
  // sub-agents + the curation gate "for free" — no need to know `pnpm secondary`.
  if (process.env.NEUROWORKS_AUTO_SPAWN_WORKER !== "0" && config.role === "primary") {
    const poolTarget = Math.max(1, Number(process.env.NEUROWORKS_POOL_WORKERS ?? "2") || 2);
    setTimeout(() => {
      void ensurePool(poolTarget)
        .then(r => console.log(`  ⓦ worker pool warm — ${r.running} managed worker(s) ready (target ${poolTarget})`))
        .catch(e => console.warn(`  ⚠ worker pool warm-up failed: ${e?.message ?? e}`));
    }, 5_000);
  }

  // Watch the vault for external edits so the search cache busts when
  // the user edits notes in Obsidian directly. Default-on; opt out via
  // NEUROWORKS_VAULT_WATCH=0 if you're on a filesystem where the recursive
  // watcher misbehaves. Fall-back behaviour is the 60s search cache TTL.
  startVaultWatcher();

  // Warm the MiniSearch index at boot so the first vault.search hits a
  // populated index instead of returning zero matches while the build
  // races a 60s lazy timer. Fire-and-forget — the build is idempotent
  // and the search code falls back to grep if the index isn't ready yet.
  // Primary-only because workers proxy vault search through the primary.
  if (config.role === "primary") {
    // Instant readiness: load the persisted snapshot first (serves queries
    // immediately), then kick a background rebuild to fold in any edits made
    // while the server was down. Cold (no snapshot) falls straight to build.
    const warm = loadPersistedIndex();
    void buildIndex(config.vaultPath).catch(e =>
      console.warn(`  ⚠ vault index warm-up failed (non-fatal): ${e?.message ?? e}`)
    );
    console.log(warm ? `  ⓘ vault index ready from snapshot — refreshing in background...` : `  ⓘ vault index warming...`);
  }

  // Periodic git pull from origin so Obsidian edits made on another machine
  // (or via Obsidian's git plugin) sync into the local vault that clawbot
  // reads. Default every 5m; opt out with NEUROWORKS_VAULT_PULL=0.
  startVaultPullScheduler();

  // End-of-day reflection at 8pm (20:00) — the day's report. Only the primary
  // runs the scheduler — secondary clawbots are workers and the reflection
  // covers the whole fleet from the primary's job list anyway. Disable with
  // NEUROWORKS_REFLECTION=0. Override hour with NEUROWORKS_REFLECTION_HOUR.
  if (process.env.NEUROWORKS_REFLECTION !== "0" && config.role === "primary") {
    startReflectionScheduler();
    console.log(`  ⓘ daily reflection scheduler armed (hour=${process.env.NEUROWORKS_REFLECTION_HOUR ?? "20"}, delivers to Telegram if connected)`);
  }

  // Innovation Scan at 8am — Naxie's morning scan with nicer headings & emojis.
  // Same primary-only guard as reflection above. Disable with
  // NEUROWORKS_INNOVATION_SCAN=0. Todo brief (6am) fires just before this
  // so the operator gets todos first, then the scan.
  if (process.env.NEUROWORKS_INNOVATION_SCAN !== "0" && config.role === "primary") {
    startInnovationScanScheduler();
    console.log(`  ⓘ innovation scan scheduler armed (hour=${process.env.NEUROWORKS_INNOVATION_SCAN_HOUR ?? "8"}, delivers to Telegram if connected)`);
  }

  // MD System Audit at 7am — Naxie's daily managing-director scan (every file,
  // feature, page — what's improving, dormant, useless). Fires before the 8am
  // innovation scan so the operator gets MD report first, then the tech watch.
  // Primary-only. Disable with NEUROWORKS_SYSTEM_AUDIT=0.
  if (process.env.NEUROWORKS_SYSTEM_AUDIT !== "0" && config.role === "primary") {
    startSystemAuditScheduler();
    console.log(`  ⓘ MD system-audit scheduler armed (hour=${process.env.NEUROWORKS_SYSTEM_AUDIT_HOUR ?? "7"}, delivers to Telegram if connected)`);
  }

  // Todo brief at 6am — today's tasks + remaining for the week (with weather + 🔥 Top 3 + inline buttons). Fires before
  // the 7am MD audit so the operator starts the day with todos, then the MD
  // report, then the 8am innovation scan.
  // Primary-only. Disable with NEUROWORKS_TODO_BRIEF=0.
  if (process.env.NEUROWORKS_TODO_BRIEF !== "0" && config.role === "primary") {
    // Optional proof migration (formerly the standalone _workflows/ tree
    // engine — retired; its scheduling/tool-allowlist/handler model now
    // lives as an optional `automation` on a regular Planner task, see
    // lib/my-tasks.ts). With NEUROWORKS_PLANNER_AUTOMATION=1, todo-brief
    // shows up as an editable, pausable task in Planner instead of running
    // its own bespoke scheduler. Default stays off so a revert is this one
    // env var, not a code rollback.
    if (process.env.NEUROWORKS_PLANNER_AUTOMATION === "1") {
      registerNativeHandler("todo-brief", () => runTodoBrief());
      seedAutomationIfMissing(
        "local",
        "Daily todo brief",
        {
          enabled: true,
          cadence: { daysOfWeek: [], hour: Number(process.env.NEUROWORKS_TODO_BRIEF_HOUR ?? "6"), minute: 0 },
          tools: ["vault.write"],
          data: ["_neuroworks/"],
          outputPath: "_neuroworks/todo-briefs/{date}.md",
          handler: "native:todo-brief",
        },
        "Today's tasks + remaining for the week, with weather and a Top 3. Edit the automation on this task in Planner to change cadence.",
      );
      startTaskAutomationScheduler();
      console.log(`  ⓘ todo brief now driven by a Planner task automation (edit "Daily todo brief" in Planner to change cadence)`);
    } else {
      startTodoBriefScheduler();
      console.log(`  ⓘ todo brief scheduler armed (hour=${process.env.NEUROWORKS_TODO_BRIEF_HOUR ?? "6"}, delivers to Telegram if connected)`);
    }
  }

  // MD Weekly Board — Monday 08:00, convenes on latest audit's top improvements
  if (process.env.NEUROWORKS_WEEKLY_BOARD !== "0" && config.role === "primary") {
    startWeeklyBoardScheduler();
    console.log(`  ⓘ MD weekly board scheduler armed (Monday 08:00)`);
  }

  // Weekly rollup Sundays 9am — combines todos + reflections + scans.
  if (process.env.NEUROWORKS_WEEKLY_ROLLUP !== "0" && config.role === "primary") {
    startWeeklyRollupScheduler();
    console.log(`  ⓘ weekly rollup scheduler armed (dow=${process.env.NEUROWORKS_WEEKLY_ROLLUP_DOW ?? "0"} hour=${process.env.NEUROWORKS_WEEKLY_ROLLUP_HOUR ?? "9"})`);
  }

  // Weekly self-improvement review ("Weekly Reflect") Sundays 10am — right
  // after the rollup. Proposes schedules/code/MCP/CLI/skills/retrieval fixes
  // as approval cards; nothing auto-applies.
  if (process.env.NEUROWORKS_WEEKLY_IMPROVEMENT !== "0" && config.role === "primary") {
    startWeeklyImprovementScheduler();
    console.log(`  ⓘ weekly self-improvement review armed (dow=${process.env.NEUROWORKS_WEEKLY_IMPROVEMENT_DOW ?? "0"} hour=${process.env.NEUROWORKS_WEEKLY_IMPROVEMENT_HOUR ?? "10"})`);
  }

  // Second-brain wiki compile — distills raw captures (_archive/) into
  // compiled wiki entries (_wiki/) nightly, then emails/toasts a morning
  // digest a few hours later. Same primary-only, opt-out convention as
  // reflection above. Also bootstraps a starter agents.md routing table.
  if (process.env.NEUROWORKS_WIKI_COMPILE !== "0" && config.role === "primary") {
    ensureAgentsMdExists();
    startWikiCompileScheduler();
    startWikiDigestScheduler();
    console.log(`  ⓘ wiki-compile scheduler armed (compile hour=${process.env.NEUROWORKS_WIKI_COMPILE_HOUR ?? "3"}, digest hour=${process.env.NEUROWORKS_WIKI_DIGEST_HOUR ?? "7"})`);
  }

  // User-defined schedules — fires template runs on a friendly day-of-week +
  // time-of-day cadence. Primary-only so the same schedule doesn't run on
  // every worker. Disable with NEUROWORKS_SCHEDULES=0.
  if (process.env.NEUROWORKS_SCHEDULES !== "0" && config.role === "primary") {
    startScheduleScheduler();
    console.log(`  ⓘ schedule tick armed (30s interval)`);
  }

  // Approval escalation — re-nudges the operator over Telegram when a
  // job parked "awaiting-approval" sits unanswered past 15m/1h/4h, instead
  // of relying on them to remember to go check. Primary-only, same
  // reasoning as the schedule tick above. Disable with
  // NEUROWORKS_APPROVAL_ESCALATION=0.
  if (process.env.NEUROWORKS_APPROVAL_ESCALATION !== "0" && config.role === "primary") {
    startApprovalEscalationSweep();
    console.log(`  ⓘ approval escalation sweep armed (5min interval)`);
  }

  // Naxie org-orchestration daemon (docs/naxie-architecture.md §6) — keeps
  // the OrgTask backlog honest between conversations (stale-approval sweep,
  // orphaned-active-task reconciliation). Primary-only, same reasoning as
  // the schedule tick above. Disable with NEUROWORKS_ORG_DAEMON=0.
  if (process.env.NEUROWORKS_ORG_DAEMON !== "0" && config.role === "primary") {
    startOrgDaemon();
    console.log(`  ⓘ org daemon armed (${process.env.NEUROWORKS_ORG_DAEMON_CYCLE_SECONDS ?? "300"}s interval)`);
  }

  // Extension health scheduler — hourly test-all + alert (primary-only).
  if (config.role === "primary") {
    try { startExtensionHealthScheduler(); } catch (e: any) { console.warn(`  ⚠ extension health scheduler failed: ${e?.message ?? e}`); }
  }

  // Git-commit watcher + project-status check — the first two engines
  // registered into the new orchestration core (scheduler-registry.ts).
  // Primary-only, same reasoning as every other scheduler above.
  if (config.role === "primary") {
    try { startGithubWatcher(); console.log(`  ⓘ github watcher armed (${process.env.NEUROWORKS_GITHUB_WATCH_INTERVAL_SECONDS ?? "300"}s interval)`); }
    catch (e: any) { console.warn(`  ⚠ github watcher failed: ${e?.message ?? e}`); }
  }

  // MAG memory wipe-recovery (docs/naxie-storage-architecture.md §5) — only
  // pulls from the Supabase memory_facts mirror when local memory storage is
  // empty (fresh/wiped machine); no-op otherwise. Fire-and-forget, primary-
  // only (same reasoning as the vault index warm-up above).
  if (config.role === "primary") {
    void hydrateMemoryFromSupabaseIfLocalEmpty().catch(e =>
      console.warn(`  ⚠ memory hydration from Supabase failed (non-fatal): ${e?.message ?? e}`)
    );
  }

  // Email bridge — inbound IMAP poll + outbound SMTP so users can drive
  // clawbot over email. Primary-only (one poller for the fleet). No-ops with
  // a log when NEUROWORKS_EMAIL_USER / NEUROWORKS_EMAIL_APP_PASSWORD aren't set.
  if (config.role === "primary") {
    void startEmailBridge().catch(e =>
      console.warn(`  ⚠ email bridge start failed: ${e?.message ?? e}`)
    );
    // Telegram inbound bridge — receives messages from allow-listed chats/groups
    // and replies. No-op (with a log) until Telegram is connected + a chat is
    // allow-listed. Mirrors the email bridge.
    void startTelegramBridge().catch(e =>
      console.warn(`  ⚠ telegram bridge start failed: ${e?.message ?? e}`)
    );
    // WhatsApp bridge (Baileys) — triage-only inbound for the Variety & Co
    // business number. No-op (with a log) until QR-paired. Mirrors the
    // email/Telegram bridges' primary-only, single-connection posture.
    void startWhatsAppBridge().catch(e =>
      console.warn(`  ⚠ whatsapp bridge start failed: ${e?.message ?? e}`)
    );
  }
});

// Graceful shutdown — flush any pending vault commits before exit so a Ctrl+C
// doesn't strand the last batch of writes. The commit queue is debounced; a
// kill mid-debounce would otherwise lose the commit (file is on disk but
// uncommitted). Each handler is idempotent: signals fire once and we tear
// down cleanly.
let shuttingDown = false;
async function gracefulExit(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ⏻ received ${signal} — draining connections + flushing pending vault writes…`);
  // Hard-exit safety net: if any teardown step wedges (a hung socket, a stuck
  // flush), don't hang the container forever — force exit after a bounded grace
  // period so the orchestrator's SIGKILL never has to.
  const graceMs = Number(process.env.NEUROWORKS_SHUTDOWN_GRACE_MS ?? "12000") || 12000;
  const hardKill = setTimeout(() => {
    console.warn(`  ⚠ shutdown grace (${graceMs}ms) elapsed — forcing exit`);
    process.exit(1);
  }, graceMs);
  hardKill.unref();
  // Stop accepting new connections immediately so nothing new starts mid-drain.
  try { server.close(); } catch { /* server may not be listening yet */ }
  // Mark every in-flight job as failed BEFORE we let the process exit.
  // Without this, a tsx-watch reload (very common in dev) would leave
  // pending/running jobs in indeterminate state — the in-memory map dies
  // with the process, the client sees a 404, and the reflection never
  // records the abort. Persisting the abort to the JSONL store keeps the
  // journal honest and lets the client surface a clear "server restarted"
  // message rather than a generic "job not found".
  try {
    const { aborted } = abortInflightJobs(`aborted: server received ${signal}`);
    if (aborted > 0) console.log(`  ⚠ aborted ${aborted} in-flight job(s)`);
  } catch (e: any) { console.warn(`  ⚠ job abort failed: ${e?.message ?? e}`); }
  try { await shutdownCommitQueue(); console.log("  ✓ vault flush complete"); }
  catch (e: any) { console.warn(`  ⚠ vault flush failed: ${e?.message ?? e}`); }
  try { await shutdownManagedWorker(); }
  catch (e: any) { console.warn(`  ⚠ worker shutdown failed: ${e?.message ?? e}`); }
  try { stopReflectionScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopInnovationScanScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopSystemAuditScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopWeeklyBoardScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopTodoBriefScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopTaskAutomationScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopWeeklyRollupScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopWeeklyImprovementScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopWikiCompileScheduler(); stopWikiDigestScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopScheduleScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopApprovalEscalationSweep(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopOrgDaemon(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopExtensionHealthScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  try { stopTelegramBridge(); }
  catch (e: any) { console.warn(`  ⚠ telegram bridge stop failed: ${e?.message ?? e}`); }
  try { stopWhatsAppBridge(); }
  catch (e: any) { console.warn(`  ⚠ whatsapp bridge stop failed: ${e?.message ?? e}`); }
  try { stopEmailBridge(); }
  catch { /* never block shutdown on the email bridge */ }
  try { stopVaultWatcher(); }
  catch { /* never block shutdown on a watcher close */ }
  try { stopVaultPullScheduler(); }
  catch { /* never block shutdown on a scheduler stop */ }
  process.exit(0);
}
process.on("SIGTERM", () => void gracefulExit("SIGTERM"));
process.on("SIGINT", () => void gracefulExit("SIGINT"));
