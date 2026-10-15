import { Router } from "express";
import { listBrands, getBrand, createBrand, updateBrand, deleteBrand, addBrandChannel } from "../lib/brands.js";
import { getBrandContextStatus, compactBrandContext } from "../lib/brand-context.js";
import { requireLayer, callerOf } from "../lib/access.js";
import { logAudit } from "../lib/audit-log.js";
import { listConnections } from "../lib/integrations.js";

// Brand registry API — CRUD for the operator's marketing identities (personal
// / work / business by default, seeded in lib/brands.ts's seedDefaultBrands).
// Mirrors routes/departments.ts's shape: open GET for any signed-in caller,
// admin-gated writes.

export const brandsRouter = Router();

brandsRouter.get("/", (_req, res) => {
  // Context status rides along (mtime stats only — no LLM) so the card can
  // show "compaction pending" without N extra round-trips.
  const brands = listBrands().map(b => {
    let context: ReturnType<typeof getBrandContextStatus> | undefined;
    try { context = getBrandContextStatus(b.id); } catch { /* vault unreachable — omit */ }
    return { ...b, ...(context ? { context } : {}) };
  });
  res.json({ brands });
});

brandsRouter.get("/:id", (req, res) => {
  const b = getBrand(req.params.id);
  if (!b) return res.status(404).json({ error: "brand not found" });
  // Context status rides along so the Brands page can show the dump path,
  // last compaction time, and whether a compaction is pending — without a
  // second endpoint.
  let context: ReturnType<typeof getBrandContextStatus> | undefined;
  try { context = getBrandContextStatus(b.id); } catch { /* vault unreachable — omit */ }
  res.json({ brand: b, ...(context ? { context } : {}) });
});

// POST /api/brands/:id/compact — manual "Compact now" for this brand's
// context dump. force=true bypasses the settle gate (the operator clicked
// the button, they're not mid-sentence). The hourly scheduler compacts
// pending brands automatically; this is the on-demand path.
brandsRouter.post("/:id/compact", requireLayer("admin"), async (req, res) => {
  const b = getBrand(req.params.id);
  if (!b) return res.status(404).json({ error: "brand not found" });
  try {
    const r = await compactBrandContext(b.id, { force: req.body?.force !== false });
    logAudit({ level: "info", actor: callerOf(req)?.email ?? "system", action: "brand.compact-context", target: b.id, detail: r.changed ? "compacted" : (r.skipped ?? "no change"), result: r.changed ? "success" : "pending" });
    res.json({ result: r, context: getBrandContextStatus(b.id) });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

brandsRouter.post("/", requireLayer("admin"), (req, res) => {
  try {
    const b = req.body ?? {};
    const brand = createBrand({
      id: b.id, name: b.name, tagline: b.tagline, voice: b.voice, audience: b.audience,
      values: b.values, guidelinesVaultPath: b.guidelinesVaultPath, calendarCadence: b.calendarCadence,
      color: b.color, icon: b.icon,
    });
    logAudit({ level: "info", actor: callerOf(req)?.email ?? "system", action: "brand.create", target: brand.id, detail: brand.name, result: "success" });
    res.json({ brand });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

brandsRouter.patch("/:id", requireLayer("admin"), (req, res) => {
  const b = updateBrand(req.params.id, req.body ?? {});
  if (!b) return res.status(404).json({ error: "brand not found" });
  logAudit({ level: "info", actor: callerOf(req)?.email ?? "system", action: "brand.update", target: b.id, detail: Object.keys(req.body ?? {}).join(","), result: "success" });
  res.json({ brand: b });
});

brandsRouter.delete("/:id", requireLayer("admin"), (req, res) => {
  const ok = deleteBrand(req.params.id);
  if (!ok) return res.status(404).json({ error: "brand not found" });
  logAudit({ level: "warn", actor: callerOf(req)?.email ?? "system", action: "brand.delete", target: req.params.id, detail: "removed", result: "success" });
  res.json({ ok: true });
});

// POST /api/brands/:id/channels — bind (or replace) a connector/channel for
// this brand. body: { provider, connectionLabel, platforms? }
brandsRouter.post("/:id/channels", requireLayer("admin"), (req, res) => {
  const b = req.body ?? {};
  const provider = String(b.provider ?? "").trim();
  const connectionLabel = String(b.connectionLabel ?? "").trim();
  if (!provider || !connectionLabel) return res.status(400).json({ error: "provider and connectionLabel are required" });
  // Catch a typo'd/stale label HERE, at bind time — not later, silently, at
  // posting time (getConnectionByLabel now errors rather than falling back to
  // a different connection, but confirming the label exists up front is a
  // clearer failure mode before real accounts are wired up).
  const matches = listConnections().some(c => c.providerId === provider && c.label === connectionLabel);
  if (!matches) {
    const sameProvider = listConnections().filter(c => c.providerId === provider).map(c => c.label);
    return res.status(400).json({
      error: `no "${provider}" connection labelled "${connectionLabel}" on the Integrations page.` +
        (sameProvider.length ? ` Existing ${provider} connections: ${sameProvider.join(", ")}.` : ` No ${provider} connections exist yet — add one first.`),
    });
  }
  const platforms = Array.isArray(b.platforms) ? b.platforms.map(String) : undefined;
  const brand = addBrandChannel(req.params.id, { provider, connectionLabel, platforms });
  if (!brand) return res.status(404).json({ error: "brand not found" });
  res.json({ brand });
});
