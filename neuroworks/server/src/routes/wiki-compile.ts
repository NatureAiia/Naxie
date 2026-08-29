import { Router } from "express";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { config } from "../config.js";
import { runWikiCompile, lastCompileResult } from "../lib/wiki-compile.js";
import { WIKI_DIR, ARCHIVE_DIR } from "../lib/vault.js";
import { requireLayer } from "../lib/access.js";

export const wikiCompileRouter = Router();

// List compiled wiki entries (mirrors reflectionRouter's list-with-preview
// shape) plus the archive's raw-capture count, so a UI card can show both
// halves of the Archive → Wiki pipeline at a glance.
wikiCompileRouter.get("/", (_req, res) => {
  try {
    const wikiRoot = resolve(config.vaultPath, WIKI_DIR);
    const archiveRoot = resolve(config.vaultPath, ARCHIVE_DIR);
    const entries: { path: string; title: string; compiled?: string; source?: string }[] = [];
    function walk(dir: string, root: string) {
      let items: any[] = [];
      try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of items) {
        const full = resolve(dir, e.name);
        if (e.isDirectory()) { walk(full, root); continue; }
        if (!e.name.endsWith(".md")) continue;
        try {
          const body = readFileSync(full, "utf8");
          const fm = body.match(/^---\n([\s\S]*?)\n---/);
          const title = fm?.[1].match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? e.name.replace(/\.md$/, "");
          const compiled = fm?.[1].match(/^compiled:\s*(.+)$/m)?.[1]?.trim();
          const source = fm?.[1].match(/^source:\s*(.+)$/m)?.[1]?.trim();
          entries.push({ path: `${WIKI_DIR}/${relative(root, full).split(sep).join("/")}`, title, compiled, source });
        } catch { /* tolerate one bad file */ }
      }
    }
    if (existsSync(wikiRoot)) walk(wikiRoot, wikiRoot);
    entries.sort((a, b) => (b.compiled ?? "").localeCompare(a.compiled ?? ""));

    let archiveCount = 0;
    function countArchive(dir: string) {
      let items: any[] = [];
      try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of items) {
        const full = resolve(dir, e.name);
        if (e.isDirectory()) countArchive(full);
        else if (e.name.endsWith(".md")) archiveCount++;
      }
    }
    if (existsSync(archiveRoot)) countArchive(archiveRoot);

    res.json({ entries: entries.slice(0, 50), archiveCount, last: lastCompileResult() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Trigger a compile on demand — admin-only, same posture as reflection's
// manual "Reflect now".
wikiCompileRouter.post("/run", requireLayer("admin"), async (_req, res) => {
  try {
    const r = await runWikiCompile();
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Read one compiled wiki entry's full body.
wikiCompileRouter.get("/entry", (req, res) => {
  try {
    const rel = String(req.query.path ?? "").trim();
    if (!rel.startsWith(`${WIKI_DIR}/`)) return res.status(400).json({ error: `path must be inside ${WIKI_DIR}/` });
    const full = resolve(config.vaultPath, rel);
    const root = resolve(config.vaultPath, WIKI_DIR);
    if (!full.startsWith(root + sep)) return res.status(400).json({ error: "path escapes wiki folder" });
    if (!existsSync(full) || !statSync(full).isFile()) return res.status(404).json({ error: "not found" });
    res.json({ path: rel, body: readFileSync(full, "utf8") });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});
