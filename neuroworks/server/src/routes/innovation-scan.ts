import { Router } from "express";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { runInnovationScan, lastInnovationScan } from "../lib/innovation-scan.js";
import { requireLayer } from "../lib/access.js";

export const innovationScanRouter = Router();

const SCAN_DIR_REL = "_neuroworks/innovation-scans";

// List past scans found in the vault. Mirrors routes/reflection.ts's list
// endpoint: date + path + a short preview pulled from the body, plus the
// frontmatter as lightweight stats for the list UI.
innovationScanRouter.get("/", (_req, res) => {
  try {
    const root = resolve(config.vaultPath, SCAN_DIR_REL);
    if (!existsSync(root)) return res.json({ scans: [] });
    const files = readdirSync(root).filter(f => f.endsWith(".md")).sort().reverse();
    const scans = files.slice(0, 30).map(f => {
      const date = f.replace(/\.md$/, "");
      let preview = "";
      let stats: any = undefined;
      try {
        const body = readFileSync(resolve(root, f), "utf8");
        const stripped = body.replace(/^---[\s\S]*?---\n+/, "");
        const m = stripped.match(/##\s+Fixing our weak spots[\s\S]+?(?=\n##|\n---|$)/i);
        preview = (m ? m[0] : stripped).replace(/^#+\s+.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 240);
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
      return { date, path: `${SCAN_DIR_REL}/${f}`, preview, stats };
    });
    res.json({ scans, last: lastInnovationScan() });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Trigger a scan on demand.
innovationScanRouter.post("/run", requireLayer("admin"), async (req, res) => {
  try {
    const force = Boolean(req.body?.force);
    const r = await runInnovationScan({ force });
    res.json(r);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Get the full markdown body for a specific scan date.
innovationScanRouter.get("/:date", (req, res) => {
  try {
    const date = String(req.params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    const path = resolve(config.vaultPath, SCAN_DIR_REL, `${date}.md`);
    if (!existsSync(path)) return res.status(404).json({ error: "not found" });
    res.json({ date, path: `${SCAN_DIR_REL}/${date}.md`, body: readFileSync(path, "utf8") });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});
