import { Router } from "express";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { runSystemAudit, lastSystemAudit, quickInventoryCounts, scanInventory, getHealthTrend, logPageView, getVaultHygiene, getDeadCode, getPersonaMergeCandidates, getIntegrationHealth, jsonSafeReplacer } from "../lib/system-audit.js";
import { requireLayer } from "../lib/access.js";

export const systemAuditRouter = Router();

const AUDIT_DIR_REL = "_naxion/system-audits";

// GET /api/system-audit — list past MD audits
systemAuditRouter.get("/", (_req, res) => {
  try {
    const root = resolve(config.vaultPath, AUDIT_DIR_REL);
    if (!existsSync(root)) return res.json({ audits: [], inventory: quickInventoryCounts() });
    const files = readdirSync(root).filter(f => f.endsWith(".md")).sort().reverse();
    const audits = files.slice(0, 30).map(f => {
      const date = f.replace(/\.md$/, "");
      let preview = "";
      let stats: any = undefined;
      try {
        const body = readFileSync(resolve(root, f), "utf8");
        const stripped = body.replace(/^---[\s\S]*?---\n+/, "");
        const m = stripped.match(/##\s+🏢 Executive Summary[\s\S]+?(?=\n##\s|\n---|$)/i)
          ?? stripped.match(/##\s+Executive Summary[\s\S]+?(?=\n##\s|\n---|$)/i);
        preview = (m ? m[0] : stripped).replace(/^#+\s+.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 280);
        const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const fm: any = {};
          for (const line of fmMatch[1].split("\n")) {
            const colon = line.indexOf(":");
            if (colon > 0) fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
          }
          stats = fm;
        }
      } catch { /* tolerate */ }
      return { date, path: `${AUDIT_DIR_REL}/${f}`, preview, stats };
    });
    // last: lastSystemAudit() nests stats.usage.pageViewPaths as a Set — plain
    // res.json() would silently serialize it to "{}" (see jsonSafeReplacer).
    res.type("application/json").send(JSON.stringify({ audits, last: lastSystemAudit(), inventory: quickInventoryCounts() }, jsonSafeReplacer));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/system-audit/inventory — lightweight live inventory (no vault read)
systemAuditRouter.get("/inventory", (_req, res) => {
  try { res.json({ inventory: quickInventoryCounts() }); }
  catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// GET /api/system-audit/health-trend — 30d sparkline data
systemAuditRouter.get("/health-trend", (_req, res) => {
  try { res.json({ trend: getHealthTrend() }); }
  catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// GET /api/system-audit/vault-hygiene
systemAuditRouter.get("/vault-hygiene", (_req, res) => {
  try { res.json(getVaultHygiene()); }
  catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// GET /api/system-audit/dead-code
systemAuditRouter.get("/dead-code", (_req, res) => {
  try {
    const inv = scanInventory();
    res.json({ deadCode: getDeadCode(inv) });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// GET /api/system-audit/persona-merges
systemAuditRouter.get("/persona-merges", (_req, res) => {
  try { res.json({ merges: getPersonaMergeCandidates() }); }
  catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// GET /api/system-audit/integration-health
systemAuditRouter.get("/integration-health", async (_req, res) => {
  try { res.json({ health: await getIntegrationHealth() }); }
  catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// POST /api/system-audit/page-view — beacon from frontend (no auth needed, best-effort)
systemAuditRouter.post("/page-view", async (req, res) => {
  try {
    const page = String(req.body?.page ?? req.query.page ?? "").slice(0, 200);
    if (!page) return res.status(400).json({ error: "page required" });
    let userId: string | undefined;
    try {
      const { callerOf } = await import("../lib/access.js");
      userId = (callerOf as any)(req)?.email ?? (callerOf as any)(req)?.id;
    } catch { /* ignore */ }
    logPageView(page, userId);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// POST /api/system-audit/voice-briefing — trigger MD voice briefing now (admin)
systemAuditRouter.post("/voice-briefing", requireLayer("admin"), async (_req, res) => {
  try {
    const { triggerVoiceBriefing } = await import("../lib/system-audit.js");
    const r = await (triggerVoiceBriefing as any)();
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// POST /api/system-audit/architect-pr — one-click Architect PR for a finding (admin)
systemAuditRouter.post("/architect-pr", requireLayer("admin"), async (req, res) => {
  try {
    const finding = String(req.body?.finding ?? "").slice(0, 500);
    if (!finding) return res.status(400).json({ error: "finding required" });
    const { runArchitectReview } = await import("../lib/architect.js");
    const r = await runArchitectReview();
    res.json({ ...r, finding });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? String(e) }); }
});

// POST /api/system-audit/run — trigger a full MD scan now (admin)
systemAuditRouter.post("/run", requireLayer("admin"), async (_req, res) => {
  try {
    const r = await runSystemAudit();
    // r.stats.usage.pageViewPaths is a Set — see jsonSafeReplacer.
    res.type("application/json").send(JSON.stringify(r, jsonSafeReplacer));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/system-audit/:date — full markdown body
systemAuditRouter.get("/:date", (req, res) => {
  try {
    const date = String(req.params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const path = resolve(config.vaultPath, AUDIT_DIR_REL, `${date}.md`);
    if (!existsSync(path)) return res.status(404).json({ error: "not found" });
    res.json({ date, path: `${AUDIT_DIR_REL}/${date}.md`, body: readFileSync(path, "utf8") });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});
