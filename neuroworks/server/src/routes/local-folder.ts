// "My documents" — index a folder under the Local Files sandbox
// (config.localFilesPath, see lib/local-files.ts) into Naxie's knowledge
// base. Native port of naxionai/backend/api/training.py's
// /local-folder/{status,browse,ingest} endpoints, done as part of retiring
// the separate Python service (docs/naxie-architecture.md).
//
// Structural note vs. the Python original: that backend had its own
// dedicated LOCAL_DOCUMENTS_ROOT and a Qdrant-backed ingestion pipeline
// (rag/pipeline.py) with per-item status tracked in a KnowledgeItem table.
// This server already has a sandboxed local-disk root for exactly this kind
// of "files that aren't vault knowledge yet" purpose (the Files explorer's
// Local Files pane) and its own RAG store (lib/rag-embed.ts, pgvector) that
// indexes anything under the vault — so ingestion here is just: extract text
// (lib/doc-extractor.ts, already used for vault documents) and write it into
// the vault as a note (lib/vault.ts's writeVaultFile, which schedules a
// re-embed on its own). No second pipeline, no separate item-tracking table.
//
// Synchronous by design: the UI (NaxiePersonalConnectors.tsx) has no
// per-item status view, it just shows a toast with the final counts — a
// background-job/poll setup would be complexity with nothing to show for it.
// Capped at maxFiles (default 200) to keep a single request bounded.

import { Router } from "express";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { requireLayer } from "../lib/access.js";
import { listLocal, localAbsPath, localFilesRoot } from "../lib/local-files.js";
import { extractDocText } from "../lib/doc-extractor.js";
import { writeVaultFile } from "../lib/vault.js";

export const localFolderRouter = Router();

// Reads (status/browse) are open to any signed-in user, same posture as
// files.ts's list. Ingest writes into the vault, so it's admin territory.
localFolderRouter.use(["/ingest"], requireLayer("admin"));

// Extensions doc-extractor.ts can actually turn into text. Deliberately
// narrower than the Python original's ALLOWED_EXTENSIONS (which also listed
// images/audio/video for a multimodal pipeline this server doesn't have) —
// this reports exactly what indexing here can use.
const SUPPORTED_EXT = new Set(["pdf", "docx", "txt", "md", "markdown", "xlsx", "xls", "csv"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

localFolderRouter.get("/status", (_req, res) => {
  // Always configured — it's the same sandboxed root as the Local Files
  // pane (auto-created on first use), not a separate opt-in env var.
  res.json({ configured: true, rootLabel: localFilesRoot() });
});

localFolderRouter.get("/browse", (req, res) => {
  const subPath = String(req.query.subPath ?? "");
  try {
    const entries = listLocal(subPath).map(e => ({
      name: e.name,
      isDir: e.type === "dir",
      size: e.size ?? null,
      supported: e.type === "file" && SUPPORTED_EXT.has(extOf(e.name)),
    }));
    res.json({ subPath, entries });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

function walkFiles(absDir: string, recursive: boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const full = join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...walkFiles(full, recursive));
      continue;
    }
    if (entry.isFile()) out.push(full);
  }
  return out;
}

// Vault-safe slug for one path segment — collapse anything that isn't
// alnum/dash/dot/underscore/space, keep it readable.
function slugify(segment: string): string {
  return segment.replace(/[^\w.\- ]+/g, "_").trim() || "untitled";
}

localFolderRouter.post("/ingest", async (req, res) => {
  const subPath = String(req.body?.subPath ?? "");
  const recursive = req.body?.recursive !== false;
  const category = String(req.body?.category ?? "other").trim() || "other";
  const tags: string[] = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];
  const maxFiles = Math.max(1, Math.min(1000, Number(req.body?.maxFiles) || 200));

  let rootAbs: string;
  try {
    rootAbs = localAbsPath(subPath);
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? String(e) });
  }
  if (!statSync(rootAbs).isDirectory()) return res.status(400).json({ error: "path is not a directory" });

  const all = walkFiles(rootAbs, recursive);
  const matched: string[] = [];
  let skippedUnsupported = 0;
  for (const abs of all) {
    if (SUPPORTED_EXT.has(extOf(abs))) matched.push(abs);
    else skippedUnsupported++;
  }
  matched.sort();
  const skippedOverCap = Math.max(0, matched.length - maxFiles);
  const toIngest = matched.slice(0, maxFiles);

  let queued = 0;
  const failed: { file: string; error: string }[] = [];
  for (const abs of toIngest) {
    try {
      const extracted = await extractDocText(abs);
      const relFromRoot = abs.split(sep).join("/");
      // Mirror the source's own subfolder structure under _imported/<category>/
      // so same-named files in different folders don't collide, and keep the
      // original extension in the note's filename ("report.pdf.md" vs
      // "report.docx.md") so same-stem-different-format files don't either.
      const relParts = relative(rootAbs, abs).split(sep).map(slugify);
      const vaultRel = `_imported/${slugify(category)}/${relParts.join("/")}.md`;
      const frontmatter = [
        "---",
        `title: ${JSON.stringify(extracted.name)}`,
        `source: ${JSON.stringify(relFromRoot)}`,
        `category: ${JSON.stringify(category)}`,
        `tags: [${tags.map(t => JSON.stringify(t)).join(", ")}]`,
        `imported_at: ${JSON.stringify(new Date().toISOString())}`,
        "---",
        "",
      ].join("\n");
      writeVaultFile(vaultRel, `${frontmatter}\n# ${extracted.name}\n\n${extracted.text}\n`);
      queued++;
    } catch (e: any) {
      failed.push({ file: abs, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  res.json({
    queued,
    skippedUnsupported,
    skippedOverCap,
    root: rootAbs,
    ...(failed.length ? { failed } : {}),
  });
});
