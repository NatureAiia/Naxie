// Unified file-manager API — backs the Files explorer (formerly "Company
// data"'s file section). One surface over every storage backend so the UI
// can drag-and-drop between them like a real file explorer.
//
// Backend ids:
//   "vault"     — the Obsidian vault (config.vaultPath). This one physical
//                 folder is also what /api/storage/status calls "local",
//                 "obsidian", and "github" (three facets of the SAME disk
//                 location: existence, Obsidian index, git-backup state) —
//                 the explorer shows those as badges on the vault pane
//                 rather than three redundant trees of the same files.
//   "localdisk" — a SANDBOXED folder on the local machine (config.localFilesPath,
//                 default C:\NaxieFiles) — deliberately not the whole C:\
//                 drive. A place for files that aren't vault knowledge.
//   "drive"     — Google Drive. Not wired yet (docs/naxie-storage-architecture.md
//                 Phase 2, needs OAuth credentials) — list/move/delete 501.
//   "supabase"  — pgvector/MAG tables, not a filesystem — 501 (browsable only
//                 via /api/naxie's RAG/MAG inspector, not this file manager).
import { Router } from "express";
import { existsSync, statSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { requireLayer } from "../lib/access.js";
import {
  listVault, moveVaultEntry, deleteVaultEntry, mkdirVaultDir, statVaultEntry,
  importBinaryIntoVault, vaultFileLineage, gitStatusForDir,
} from "../lib/vault.js";
import { config } from "../config.js";
import {
  listLocal, moveLocal, deleteLocal, mkdirLocal, statLocal, importIntoLocal, localAbsPath, writeLocalFileBuffer,
} from "../lib/local-files.js";
import { computeStorageBackends } from "./storage.js";
import { enqueueVaultCommit } from "../lib/commit-queue.js";

export const filesRouter = Router();

type Backend = "vault" | "localdisk" | "drive" | "supabase";

// Reads are open to every signed-in user (same posture as Knowledge/brain
// reads). Mutations (move/delete/mkdir/upload) are admin territory — this is
// a file manager that can delete things.
filesRouter.use(["/move", "/delete", "/mkdir", "/upload", "/transfer"], requireLayer("admin"));

function badBackend(res: any, backend: string) {
  res.status(400).json({ error: `unknown backend "${backend}" — expected vault | localdisk | drive | supabase` });
}
function notConnected(res: any, backend: string) {
  res.status(501).json({ error: `${backend} is not connected yet — see docs/naxie-storage-architecture.md §9`, notConnected: true });
}

// GET /api/files/backends — panes for the explorer sidebar, one row per
// backend with configured/reachable so the UI can grey out drive/supabase.
filesRouter.get("/backends", async (_req, res) => {
  const raw = await computeStorageBackends();
  const byId = Object.fromEntries(raw.map(b => [b.id, b]));
  res.json({
    backends: [
      {
        id: "vault", label: "Vault", kind: "filesystem",
        configured: true, reachable: byId.local?.reachable ?? false,
        detail: byId.local?.detail ?? "",
        badges: [
          { label: "Obsidian", reachable: byId.obsidian?.reachable ?? false },
          { label: "GitHub backup", reachable: byId.github?.reachable ?? false, configured: byId.github?.configured ?? false },
        ],
      },
      {
        id: "localdisk", label: "Local Files", kind: "filesystem",
        configured: true, reachable: true, detail: config.localFilesPath,
      },
      {
        id: "drive", label: "Google Drive", kind: "unavailable",
        configured: byId.drive?.configured ?? false, reachable: byId.drive?.reachable ?? false,
        detail: byId.drive?.detail ?? "not configured",
      },
      {
        id: "supabase", label: "Supabase", kind: "unavailable",
        configured: byId.supabase?.configured ?? false, reachable: byId.supabase?.reachable ?? false,
        detail: byId.supabase?.detail ?? "not configured",
      },
    ],
  });
});

// GET /api/files/list?backend=vault|localdisk&path=
filesRouter.get("/list", (req, res) => {
  const backend = String(req.query.backend ?? "vault") as Backend;
  const path = String(req.query.path ?? "");
  try {
    if (backend === "vault") return res.json({ backend, path, entries: listVault(path) });
    if (backend === "localdisk") return res.json({ backend, path, entries: listLocal(path) });
    if (backend === "drive" || backend === "supabase") return notConnected(res, backend);
    return badBackend(res, backend);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/files/lineage?backend=vault&path=... — last commit that touched
// this one file (Library's hover tooltip). Vault-only: every other backend
// either isn't a git repo (localdisk) or isn't a filesystem at all (supabase).
filesRouter.get("/lineage", async (req, res) => {
  const backend = String(req.query.backend ?? "vault") as Backend;
  const path = String(req.query.path ?? "");
  if (backend !== "vault") return res.json({ lineage: null });
  try {
    res.json({ lineage: await vaultFileLineage(path) });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/files/git-status?backend=vault|localdisk — branch + dirty-file
// count for the backend's root directory, if it's a git repo at all. Powers
// the IDE page's toolbar strip; drive/supabase aren't filesystems so they
// always report isRepo:false.
filesRouter.get("/git-status", async (req, res) => {
  const backend = String(req.query.backend ?? "vault") as Backend;
  try {
    if (backend === "vault") return res.json(await gitStatusForDir(config.vaultPath));
    if (backend === "localdisk") return res.json(await gitStatusForDir(config.localFilesPath));
    return res.json({ isRepo: false });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

filesRouter.post("/mkdir", (req, res) => {
  const backend = String(req.body?.backend ?? "") as Backend;
  const path = String(req.body?.path ?? "").trim();
  if (!path) return res.status(400).json({ error: "path required" });
  try {
    if (backend === "vault") { mkdirVaultDir(path); void enqueueVaultCommit(`files: new folder ${path}`); return res.json({ ok: true }); }
    if (backend === "localdisk") { mkdirLocal(path); return res.json({ ok: true }); }
    if (backend === "drive" || backend === "supabase") return notConnected(res, backend);
    return badBackend(res, backend);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/files/move — rename/move WITHIN one backend (drag onto a
// sibling folder in the same pane).
filesRouter.post("/move", (req, res) => {
  const backend = String(req.body?.backend ?? "") as Backend;
  const from = String(req.body?.from ?? "").trim();
  const to = String(req.body?.to ?? "").trim();
  if (!from || !to) return res.status(400).json({ error: "from and to required" });
  try {
    if (backend === "vault") {
      moveVaultEntry(from, to);
      void enqueueVaultCommit(`files: move ${from} → ${to}`);
      return res.json({ ok: true });
    }
    if (backend === "localdisk") { moveLocal(from, to); return res.json({ ok: true }); }
    if (backend === "drive" || backend === "supabase") return notConnected(res, backend);
    return badBackend(res, backend);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/files/transfer — move/copy ACROSS backends (drag from Vault
// pane onto Local Files pane, or vice versa). Cross-backend "move" = copy
// into destination + delete source, since they're different physical roots.
filesRouter.post("/transfer", (req, res) => {
  const srcBackend = String(req.body?.srcBackend ?? "") as Backend;
  const srcPath = String(req.body?.srcPath ?? "").trim();
  const dstBackend = String(req.body?.dstBackend ?? "") as Backend;
  const dstPath = String(req.body?.dstPath ?? "").trim();
  const keepSource = req.body?.keepSource === true;
  if (!srcPath || !dstPath) return res.status(400).json({ error: "srcPath and dstPath required" });
  if (srcBackend === dstBackend) return res.status(400).json({ error: "same-backend transfer — use /move instead" });

  const unsupported = [srcBackend, dstBackend].find(b => b !== "vault" && b !== "localdisk");
  if (unsupported) return notConnected(res, unsupported);

  try {
    if (srcBackend === "vault" && dstBackend === "localdisk") {
      const st = statVaultEntry(srcPath);
      if (!st.exists) return res.status(404).json({ error: `not found: ${srcPath}` });
      const srcAbs = join(config.vaultPath, srcPath);
      importIntoLocal(dstPath, srcAbs);
      if (!keepSource) { deleteVaultEntry(srcPath); void enqueueVaultCommit(`files: moved ${srcPath} to Local Files`); }
      return res.json({ ok: true });
    }
    if (srcBackend === "localdisk" && dstBackend === "vault") {
      const st = statLocal(srcPath);
      if (!st.exists) return res.status(404).json({ error: `not found: ${srcPath}` });
      const srcAbs = localAbsPath(srcPath);
      if (st.isDir) return res.status(400).json({ error: "moving a whole folder from Local Files into the vault isn't supported yet — move files individually" });
      importBinaryIntoVault(dstPath, srcAbs);
      if (!keepSource) deleteLocal(srcPath);
      void enqueueVaultCommit(`files: moved ${dstPath} from Local Files`);
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: "unsupported transfer direction" });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

filesRouter.post("/delete", (req, res) => {
  const backend = String(req.body?.backend ?? "") as Backend;
  const path = String(req.body?.path ?? "").trim();
  if (!path) return res.status(400).json({ error: "path required" });
  try {
    if (backend === "vault") { deleteVaultEntry(path); void enqueueVaultCommit(`files: delete ${path}`); return res.json({ ok: true }); }
    if (backend === "localdisk") { deleteLocal(path); return res.json({ ok: true }); }
    if (backend === "drive" || backend === "supabase") return notConnected(res, backend);
    return badBackend(res, backend);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// POST /api/files/upload — drop a file dragged in from the OS directly into
// a folder. Body: { backend, path (target folder), filename, contentBase64 }
filesRouter.post("/upload", (req, res) => {
  const backend = String(req.body?.backend ?? "") as Backend;
  const folder = String(req.body?.path ?? "").trim();
  const filename = String(req.body?.filename ?? "").replace(/[/\\]/g, "_").trim();
  const contentBase64 = String(req.body?.contentBase64 ?? "");
  if (!filename) return res.status(400).json({ error: "filename required" });
  if (!contentBase64) return res.status(400).json({ error: "contentBase64 required" });
  let buf: Buffer;
  try { buf = Buffer.from(contentBase64, "base64"); }
  catch (e: any) { return res.status(400).json({ error: `base64 decode failed: ${e?.message ?? e}` }); }
  if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: "decoded payload too large: > 20 MB cap" });
  const rel = (folder ? `${folder}/${filename}` : filename).replace(/^\/+/, "");
  try {
    if (backend === "vault") {
      // Stage to a temp path so importBinaryIntoVault has a real source file.
      const tmp = join(config.vaultPath, ".upload-staging", `${randomUUID()}-${filename}`);
      mkdirSync(dirname(tmp), { recursive: true });
      writeFileSync(tmp, buf);
      try {
        importBinaryIntoVault(rel, tmp);
        void enqueueVaultCommit(`files: upload ${rel}`);
        return res.json({ ok: true, path: rel });
      } finally { try { unlinkSync(tmp); } catch {} }
    }
    if (backend === "localdisk") {
      const r = writeLocalFileBuffer(rel, buf);
      return res.json({ ok: true, path: r.rel });
    }
    if (backend === "drive" || backend === "supabase") return notConnected(res, backend);
    return badBackend(res, backend);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// GET /api/files/download?backend=&path=
filesRouter.get("/download", (req, res) => {
  const backend = String(req.query.backend ?? "") as Backend;
  const rel = String(req.query.path ?? "").trim();
  if (!rel) return res.status(400).json({ error: "path required" });
  try {
    if (backend === "vault") {
      const full = join(config.vaultPath, rel);
      if (!existsSync(full) || !statSync(full).isFile()) return res.status(404).json({ error: "not found" });
      return res.download(full);
    }
    if (backend === "localdisk") {
      const full = localAbsPath(rel);
      if (!existsSync(full) || !statSync(full).isFile()) return res.status(404).json({ error: "not found" });
      return res.download(full);
    }
    if (backend === "drive" || backend === "supabase") return notConnected(res, backend);
    return badBackend(res, backend);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});
