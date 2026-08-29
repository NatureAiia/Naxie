// Sandboxed local-disk file store for the Files explorer's "Local Files"
// pane (config.localFilesPath — a dedicated folder, not the whole C:\ drive).
// Mirrors lib/vault.ts's containment pattern (resolve + startsWith guard)
// but generic: list/mkdir/move/delete/read/write all scoped to this one root.

import { readdirSync, statSync, existsSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, relative, sep, basename, dirname } from "node:path";
import { config } from "../config.js";

const ROOT = config.localFilesPath;

export type LocalEntry = { name: string; path: string; type: "dir" | "file"; size?: number; mtimeMs?: number };

export class LocalPathEscape extends Error {
  constructor(p: string) { super(`path escapes local files root: ${p}`); this.name = "LocalPathEscape"; }
}

function ensureRoot() {
  mkdirSync(ROOT, { recursive: true });
}

function resolveInRoot(rel: string): string {
  const full = resolve(ROOT, rel.replace(/^[/\\]+/, ""));
  const root = resolve(ROOT);
  if (full !== root && !full.startsWith(root + sep)) throw new LocalPathEscape(rel);
  return full;
}

export function localFilesRoot(): string { return ROOT; }

export function listLocal(rel = ""): LocalEntry[] {
  ensureRoot();
  const full = resolveInRoot(rel);
  if (!existsSync(full)) return [];
  const entries = readdirSync(full, { withFileTypes: true })
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return entries.map(e => {
    const abs = resolve(full, e.name);
    const childRel = relative(ROOT, abs).split(sep).join("/");
    if (e.isDirectory()) return { name: e.name, path: childRel, type: "dir" as const };
    const st = statSync(abs);
    return { name: e.name, path: childRel, type: "file" as const, size: st.size, mtimeMs: st.mtimeMs };
  });
}

export function mkdirLocal(rel: string): void {
  ensureRoot();
  const full = resolveInRoot(rel);
  mkdirSync(full, { recursive: true });
}

export function moveLocal(fromRel: string, toRel: string): void {
  ensureRoot();
  const from = resolveInRoot(fromRel);
  const to = resolveInRoot(toRel);
  if (!existsSync(from)) throw new Error(`not found: ${fromRel}`);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

export function deleteLocal(rel: string): void {
  ensureRoot();
  const full = resolveInRoot(rel);
  if (!existsSync(full)) return;
  rmSync(full, { recursive: true, force: true });
}

export function readLocalFileBuffer(rel: string): Buffer {
  ensureRoot();
  const full = resolveInRoot(rel);
  return readFileSync(full);
}

export function writeLocalFileBuffer(rel: string, data: Buffer): { rel: string; abs: string; size: number } {
  ensureRoot();
  const full = resolveInRoot(rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  return { rel, abs: full, size: data.length };
}

export function statLocal(rel: string): { exists: boolean; isDir?: boolean; size?: number; mtimeMs?: number } {
  ensureRoot();
  const full = resolveInRoot(rel);
  if (!existsSync(full)) return { exists: false };
  const st = statSync(full);
  return { exists: true, isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
}

// Copy a file/dir FROM anywhere on disk INTO the local root — used when a
// file is transferred in from the vault (a different physical tree). Source
// is trusted (caller already resolved it inside another sandboxed root).
export function importIntoLocal(rel: string, sourceAbsPath: string): { rel: string; abs: string } {
  ensureRoot();
  const full = resolveInRoot(rel);
  mkdirSync(dirname(full), { recursive: true });
  const st = statSync(sourceAbsPath);
  if (st.isDirectory()) {
    rmSync(full, { recursive: true, force: true });
    mkdirSync(full, { recursive: true });
    copyDirRecursive(sourceAbsPath, full);
  } else {
    copyFileSync(sourceAbsPath, full);
  }
  return { rel, abs: full };
}

function copyDirRecursive(srcDir: string, dstDir: string) {
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    const s = resolve(srcDir, e.name);
    const d = resolve(dstDir, e.name);
    if (e.isDirectory()) { mkdirSync(d, { recursive: true }); copyDirRecursive(s, d); }
    else copyFileSync(s, d);
  }
}

export function localAbsPath(rel: string): string {
  return resolveInRoot(rel);
}

export { basename };
