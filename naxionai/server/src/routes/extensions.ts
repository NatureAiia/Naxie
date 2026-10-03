import { Router } from "express";
import { getExtensionsStatus, testExtension, EXTENSION_CATALOG } from "../lib/extensions.js";
import { listConnections, testConnection, testAllConnections } from "../lib/integrations.js";
import { listConnectors, testConnector, getConnectorPublic } from "../lib/connectors.js";
import { listProviders } from "../lib/model-providers.js";
import { getHealthSummaries, getHealthHistory } from "../lib/extension-health.js";
import { getCostRecords, getCostSummary } from "../lib/cost-tracker.js";
import { logAudit } from "../lib/audit-log.js";
import { createWebhook, listWebhooks, getWebhook, rotateWebhookSecret, removeWebhook, recordHit, verifySecret } from "../lib/extension-webhooks.js";
import { getExtensionSchedulerStatus, runExtensionHealthCheckNow } from "../lib/extension-scheduler.js";
import { reembedStats, runReembedNow } from "../lib/rag-embed.js";
import { setRagOverrides, getRagOverridesStatus } from "../lib/rag-config.js";
import { isPgAvailable } from "../lib/pg-client.js";
import { config } from "../config.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanForSecurityRisks } from "../lib/security.js";
import { nextSkillVersion } from "../lib/skill-version.js";
import { listSkills } from "../lib/skills.js";

export const extensionsRouter = Router();

// GET /api/extensions — aggregated monitor snapshot for the Extensions page
extensionsRouter.get("/", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, Number(req.query.days ?? 7)));
    const [core, integrations, connectors, providers, healthSummaries, healthHistory, costSummary] = await Promise.all([
      getExtensionsStatus(),
      Promise.resolve(listConnections()),
      Promise.resolve(listConnectors()),
      Promise.resolve(listProviders()),
      Promise.resolve(getHealthSummaries(days)),
      Promise.resolve(getHealthHistory(new Date(Date.now() - days * 24 * 3600 * 1000).toISOString())),
      Promise.resolve(getCostSummary()),
    ]);
    const coreEnabled = core.filter((c) => c.enabled).length;
    const coreHealthy = core.filter((c) => c.health?.ok).length;

    // Alerts: any extension with alert in healthSummaries + cost anomaly (7d > 2x 30d avg)
    const alerts = healthSummaries.filter(h => h.alert).map(h => ({ id: h.id, alert: h.alert, uptimePct: h.uptimePct }));

    res.json({
      core,
      integrations,
      connectors,
      providers,
      healthSummaries,
      healthHistory: healthHistory.slice(-200),
      costSummary,
      alerts,
      counts: {
        coreTotal: core.length,
        coreEnabled,
        coreHealthy,
        integrations: integrations.length,
        connectors: connectors.length,
        modelProviders: providers.length,
      },
      catalog: EXTENSION_CATALOG,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

extensionsRouter.get("/analytics", async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, Number(req.query.days ?? 14)));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const [costRecords, health] = await Promise.all([
      Promise.resolve(getCostRecords(since)),
      Promise.resolve(getHealthHistory(since)),
    ]);
    // Build date keys
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
      dates.push(d);
    }
    const byDateCost = new Map<string, typeof costRecords>();
    for (const d of dates) byDateCost.set(d, []);
    for (const r of costRecords) {
      const d = r.ts.slice(0, 10);
      if (byDateCost.has(d)) byDateCost.get(d)!.push(r);
    }
    const byDateHealth = new Map<string, typeof health>();
    for (const d of dates) byDateHealth.set(d, []);
    for (const h of health) {
      const d = h.ts.slice(0, 10);
      if (byDateHealth.has(d)) byDateHealth.get(d)!.push(h);
    }
    // Map extension id -> cost per day: use same logic as costByExtension but per day
    const extensionIds = EXTENSION_CATALOG.map(e => e.id);
    const daily = dates.map(date => {
      const dayCosts = byDateCost.get(date) ?? [];
      const dayHealth = byDateHealth.get(date) ?? [];
      const costUsd = dayCosts.reduce((s, r) => s + r.costUsd, 0);
      const calls = dayCosts.length;
      const healthOk = dayHealth.filter(h => h.ok).length;
      const healthFail = dayHealth.filter(h => !h.ok).length;
      const perExt = extensionIds.map(id => {
        const match = (r: any) => {
          const m = (r.model ?? "").toLowerCase();
          const b = (r.backend ?? "").toLowerCase();
          if (id === "openrouter") return b === "openrouter" || b === "anthropic" || m.includes("/");
          if (id === "ollama") return b === "ollama";
          if (id === "ideogram") return b === "ideogram";
          if (id === "muapi") return b === "muapi";
          return false;
        };
        const c = dayCosts.filter(match);
        const h = dayHealth.filter(x => x.id === id);
        return {
          id,
          costUsd: Math.round(c.reduce((s, r) => s + r.costUsd, 0) * 10000) / 10000,
          calls: c.length,
          healthOk: h.filter(x => x.ok).length,
          healthFail: h.filter(x => !x.ok).length,
        };
      });
      return { date, costUsd: Math.round(costUsd * 10000) / 10000, calls, healthOk, healthFail, perExt };
    });
    res.json({ days, daily, totalCostUsd: daily.reduce((s, d) => s + d.costUsd, 0), totalCalls: daily.reduce((s, d) => s + d.calls, 0) });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

// POST /api/extensions/test/:id — test a core extension (openrouter, ollama, supabase, etc.)
extensionsRouter.post("/test/:id", async (req, res) => {
  const id = String(req.params.id ?? "");
  try {
    const r = await testExtension(id);
    logAudit({ level: r.ok ? "info" : "warn", actor: (req as any).user?.email ?? "system", action: "extension.test", target: id, detail: r.detail, result: r.ok ? "success" : "failure" });
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ ok: false, detail: e?.message ?? String(e) });
  }
});

// POST /api/extensions/test-all — run all testable checks in parallel
extensionsRouter.post("/test-all", async (_req, res) => {
  try {
    const coreTests = await Promise.all(
      EXTENSION_CATALOG.filter((c) => c.testable).map(async (c) => {
        const r = await testExtension(c.id);
        return { id: c.id, ...r };
      }),
    );
    const [integrationTests, connectorTests] = await Promise.all([
      testAllConnections().catch(() => [] as any[]),
      Promise.all(
        listConnectors().map(async (c) => {
          try {
            const r: any = await (testConnector as any)(c.id);
            return { id: c.id, ok: !!r?.ok, detail: r?.detail ?? String(r) };
          } catch (e: any) { return { id: c.id, ok: false, detail: e?.message ?? String(e) }; }
        }),
      ),
    ]);
    res.json({ core: coreTests, integrations: integrationTests, connectors: connectorTests });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Convenience proxies so the Extensions page can stay on one base path
extensionsRouter.post("/integrations/:id/test", async (req, res) => {
  try { res.json(await testConnection(String(req.params.id))); } catch (e: any) { res.status(500).json({ ok: false, detail: e?.message ?? String(e) }); }
});
extensionsRouter.post("/connectors/:id/test", async (req, res) => {
  try {
    const r: any = await (testConnector as any)(String(req.params.id));
    res.json(r);
  } catch (e: any) { res.status(500).json({ ok: false, detail: e?.message ?? String(e) }); }
});

// ── Webhook ingress — POST /api/extensions/webhook/:id with X-Webhook-Secret ──
// Mirrors email bridge token gate (index.ts:490) but generic for Zapier/Make → PA.
// Secret is per-webhook (extension-webhooks.json) or fallback EXTENSION_WEBHOOK_SECRET env.
extensionsRouter.get("/webhooks", (_req, res) => {
  res.json({ webhooks: listWebhooks() });
});
extensionsRouter.post("/webhooks", (req, res) => {
  const targetId = String(req.body?.targetId ?? "").trim();
  const targetKind = String(req.body?.targetKind ?? "connector").trim() as "connector" | "integration" | "extension";
  if (!targetId) return res.status(400).json({ error: "targetId required" });
  const wh = createWebhook(targetId, targetKind);
  logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "webhook.create", target: `${targetKind}:${targetId}`, detail: wh.id, result: "success" });
  res.json({ webhook: wh });
});
extensionsRouter.post("/webhooks/:id/rotate", (req, res) => {
  const wh = rotateWebhookSecret(String(req.params.id));
  if (!wh) return res.status(404).json({ error: "webhook not found" });
  logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "webhook.rotate", target: wh.id, detail: wh.targetId, result: "success" });
  res.json({ webhook: wh });
});
extensionsRouter.delete("/webhooks/:id", (req, res) => {
  const ok = removeWebhook(String(req.params.id));
  if (!ok) return res.status(404).json({ error: "webhook not found" });
  logAudit({ level: "warn", actor: (req as any).user?.email ?? "system", action: "webhook.remove", target: String(req.params.id), detail: "removed", result: "success" });
  res.json({ ok: true });
});

// Inbound webhook — token-gated, no requireLayer (external caller). Origin guard exempts /api/v1/* but not this;
// we verify via shared secret header instead. Zapier/Make should send X-Webhook-Secret: <secret>.
extensionsRouter.post("/webhook/:id", async (req, res) => {
  const id = String(req.params.id);
  const provided = String(req.headers["x-webhook-secret"] ?? req.headers["x-api-key"] ?? req.query.token ?? "");
  if (!verifySecret(id, provided)) {
    logAudit({ level: "warn", actor: "webhook", action: "webhook.hit", target: id, detail: "invalid secret", result: "failure" });
    return res.status(401).json({ error: "invalid webhook secret" });
  }
  const wh = getWebhook(id);
  recordHit(id);
  const payload = req.body ?? {};
  // Security scan — block high-severity secrets in webhook payloads (mirrors vault scan)
  const scanStr = JSON.stringify(payload);
  const findings = scanForSecurityRisks(scanStr, "note");
  const high = findings.filter(f => f.severity === "high");
  if (high.length > 0) {
    logAudit({ level: "error", actor: "webhook", action: "webhook.blocked", target: `${wh?.targetKind ?? "unknown"}:${wh?.targetId ?? id}`, detail: `blocked high-severity ${high.map(h=>h.type).join(",")}`, result: "failure" });
    return res.status(400).json({ error: "payload contains secrets", findings: high.map(h => ({ type: h.type, reason: h.reason })) });
  }
  // Audit the payload shape, not full secrets
  const preview = JSON.stringify(payload).slice(0, 2000);
  logAudit({ level: "info", actor: "webhook", action: "webhook.hit", target: `${wh?.targetKind ?? "unknown"}:${wh?.targetId ?? id}`, detail: preview, result: "success" });

  // Webhook → Job: if payload carries a task/text/objective, auto-create a PA job
  const taskText = String(payload.task ?? payload.text ?? payload.objective ?? payload.prompt ?? "").trim();
  let jobId: string | undefined;
  if (taskText) {
    try {
      const { newJob, runJob } = await import("../lib/jobs.js");
      const { planAndExecute, crownBypassesApproval } = await import("../lib/agent.js");
      const { getActivePersona, personaSystemSuffix } = await import("../lib/personas.js");
      const job = newJob(`webhook:${id}`);
      (job as any).title = taskText.slice(0, 80);
      (job as any).task = taskText;
      (job as any).inputs = { task: taskText, webhookId: id, payload };
      jobId = job.id;
      const persona = getActivePersona();
      // Fire-and-forget execution — client gets jobId immediately, polls /api/tasks/jobs/:id
      void runJob(job, async (push, progress) => {
        const r = await planAndExecute(taskText, push, (patch) => progress(patch as any), {
          personaSystemSuffix: personaSystemSuffix(persona),
          workMode: (persona?.workMode as string) === "human" ? "hybrid" as const : persona?.workMode,
          skipApprovalGate: crownBypassesApproval(job.priority),
        });
        return r as any;
      }).catch((e: any) => { logAudit({ level: "error", actor: "webhook", action: "webhook.job", target: id, detail: String(e?.message ?? e).slice(0,300), result: "failure", jobId }); });
      logAudit({ level: "info", actor: "webhook", action: "webhook.job", target: id, detail: `created job ${jobId} for "${taskText.slice(0,60)}"`, result: "success", jobId });
    } catch (e: any) {
      logAudit({ level: "error", actor: "webhook", action: "webhook.job", target: id, detail: String(e?.message ?? e).slice(0,300), result: "failure" });
    }
  }

  res.json({ ok: true, received: true, target: wh ? `${wh.targetKind}:${wh.targetId}` : id, at: new Date().toISOString(), jobId });
});

// Scheduler status + manual trigger
extensionsRouter.get("/scheduler/status", (_req, res) => {
  res.json(getExtensionSchedulerStatus());
});
extensionsRouter.post("/scheduler/run", async (_req, res) => {
  try {
    const r = await runExtensionHealthCheckNow();
    res.json({ ok: true, ...r });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

// ── Vector store (pgvector RAG) — already-running re-embed pipeline,      ──
// ── surfaced here with a status check + a settings-page config/run path.  ──
extensionsRouter.get("/rag/status", async (_req, res) => {
  try {
    const connected = config.pgvectorEnabled ? await isPgAvailable() : false;
    const stats = reembedStats();
    res.json({
      pgvectorEnabled: config.pgvectorEnabled,
      openaiEmbeddingEnabled: config.openaiEmbeddingEnabled,
      connected,
      lastRun: stats.lastRun,
      pending: stats.pending,
      running: stats.running,
      overrides: getRagOverridesStatus(),
    });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

extensionsRouter.post("/rag/config", async (req, res) => {
  try {
    const supabaseDbUrl = req.body?.supabaseDbUrl !== undefined ? String(req.body.supabaseDbUrl) : undefined;
    const openaiEmbeddingApiKey = req.body?.openaiEmbeddingApiKey !== undefined ? String(req.body.openaiEmbeddingApiKey) : undefined;
    if (supabaseDbUrl === undefined && openaiEmbeddingApiKey === undefined) {
      return res.status(400).json({ error: "supabaseDbUrl or openaiEmbeddingApiKey required" });
    }
    await setRagOverrides({ supabaseDbUrl, openaiEmbeddingApiKey });
    logAudit({ level: "info", actor: "operator", action: "rag.config", target: "vector-store", detail: "updated vector store credentials", result: "success" });
    const connected = config.pgvectorEnabled ? await isPgAvailable() : false;
    res.json({ ok: true, pgvectorEnabled: config.pgvectorEnabled, openaiEmbeddingEnabled: config.openaiEmbeddingEnabled, connected, overrides: getRagOverridesStatus() });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

extensionsRouter.post("/rag/reembed", async (_req, res) => {
  try {
    const r = await runReembedNow();
    res.json({ ...r, lastRun: reembedStats().lastRun });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});

// ── Marketplace export — bundle connector/integration → skills/_user/*.md ──
extensionsRouter.post("/export/:id", async (req, res) => {
  try {
    const rawId = String(req.params.id);
    const kind = String(req.body?.kind ?? req.query.kind ?? "connector") as "connector" | "integration";
    let label = rawId;
    let description = "";
    let detailLines: string[] = [];
    if (kind === "integration") {
      const list = listConnections();
      const c = list.find(x => x.id === rawId || x.providerId === rawId);
      if (!c) return res.status(404).json({ error: "integration not found" });
      label = c.label;
      description = `${c.providerName} integration (${c.providerId})`;
      detailLines = [
        `Provider: \`${c.providerId}\` — ${c.providerName}`,
        `Label: \`${c.label}\``,
        `Category: \`${c.category}\``,
        `Created: \`${c.createdAt}\``,
        `Secret fields: \`${c.secretFields.join(", ") || "none"}\``,
        c.expiresAt ? `Expires: \`${c.expiresAt}\`` : "",
      ].filter(Boolean);
    } else {
      const c = getConnectorPublic(rawId);
      if (!c) return res.status(404).json({ error: "connector not found" });
      label = c.label;
      description = c.description ?? `Connector for ${c.baseUrl}`;
      detailLines = [
        `Base URL: \`${c.baseUrl}\``,
        `Auth: \`${c.auth.type}\`${c.auth.name ? ` (${c.auth.name})` : ""}`,
        `Write enabled: \`${c.writeEnabled ? "yes" : "no (read-only)"}\``,
        c.keyExpiresAt ? `Key expires: \`${c.keyExpiresAt}\`` : "",
        `Endpoints: ${c.endpoints?.length ?? 0}`,
        ...(c.endpoints ?? []).slice(0, 8).map(e => `  - \`${e.method} ${e.path}\` — ${e.description ?? e.name}`),
      ].filter(Boolean);
    }

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const SKILLS_USER = resolve(__dirname, "../skills/_user");
    if (!existsSync(SKILLS_USER)) mkdirSync(SKILLS_USER, { recursive: true });
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || rawId.slice(0, 12);
    const filename = `${slug}.md`;
    const dest = join(SKILLS_USER, filename);
    // versioning — if exists, bump patch; else 1.0.0 (logic in lib/skill-version.ts)
    let version = "1.0.0";
    try {
      version = nextSkillVersion(existsSync(dest) ? readFileSync(dest, "utf8") : null, req.body?.version ? String(req.body.version) : undefined);
    } catch { version = "1.0.1"; }
    const frontmatter = `---\nname: ${slug}\ndescription: "${description.replace(/"/g, "'")} — auto-exported from Skills"\napplies_to: [${kind === "integration" ? '"integration"' : '"connector"'}]\nversion: ${version}\n---\n`;
    const body = `# ${label}

${description}

> Auto-exported from **Skills** on ${new Date().toISOString()}. This skill teaches the agent how to use the \`${label}\` ${kind}.

## Connection
${detailLines.map(l => `- ${l}`).join("\n")}

## How to use

${kind === "connector" ? `
The agent should call:

\`\`\`js
// via connector primitives
await connector.describe("${label}")
await connector.call("${label}", { method: "GET", path: "/your/path" })
\`\`\`

Manifest is at \`GET /api/connectors/${rawId}\` (no secrets). Writes are ${detailLines.join(" ").includes("yes") ? "allowed" : "blocked by default — enable per-connector"}.
` : `
Via integration primitives, e.g. for Slack/Telegram:

\`\`\`js
await integration.list() // shows ${label}
await slack.post({ text: "hello from NeuroWorks" }) // if Slack
\`\`\`
`}

## Webhook
If a webhook was created for this ${kind}, Zapier/Make can POST JSON to:

\`\`\`
POST /api/extensions/webhook/<webhookId>
X-Webhook-Secret: <secret>
\`\`\`

Audit is at \`GET /api/audit?action=webhook\`.

 ## Notes
- Secrets are encrypted at rest (\`secret-box.ts\`) and never stored in this file.
- Rotate via **Extensions → Rotate** (updates \`.naxion/${kind === "integration" ? "integrations.json" : "connectors.json"}\` + \`lastRotatedAt\` + audit).
- Version: \`${version}\` — bump on each re-export.
`;
    const fullContent = frontmatter + body;
    const findings = scanForSecurityRisks(fullContent, "note");
    const high = findings.filter(f => f.severity === "high");
    if (high.length > 0) {
      logAudit({ level: "error", actor: (req as any).user?.email ?? "system", action: "marketplace.blocked", target: `${kind}:${rawId}`, detail: `blocked high-severity ${high.map(h=>h.type).join(",")}`, result: "failure" });
      return res.status(400).json({ error: "skill would contain secrets", findings: high.map(h => ({ type: h.type, reason: h.reason })) });
    }
    writeFileSync(dest, fullContent, "utf8");
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "marketplace.export", target: `${kind}:${rawId}`, detail: `${filename} v${version}`, result: "success" });
    res.json({ ok: true, path: dest, filename, skill: slug, version });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// Marketplace listing — DEPRECATED. The Marketplace tab is gone; versioned
// user skills now live on the Skills page (GET /api/skills, which carries
// version + mtime per skill). This endpoint stays as a thin compat shim over
// the same skills lib so old clients don't 404 — same { skills } shape as
// before, sourced from listSkills() instead of a second hand-rolled parser.
extensionsRouter.get("/marketplace", (_req, res) => {
  try {
    const skills = listSkills()
      .filter(s => s.source === "user")
      .map(s => ({
        filename: s.path.split(/[\\/]/).pop() ?? `${s.name}.md`,
        name: s.name,
        description: s.description,
        version: s.version ?? "0.0.0",
        mtime: s.mtime ?? null,
      }));
    res.setHeader("Deprecation", "true");
    res.json({ skills });
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});
