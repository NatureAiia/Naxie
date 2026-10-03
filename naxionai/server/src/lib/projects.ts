// Lightweight "Project" entity — a name plus the repos it spans and which
// GitHub account (see github-accounts.ts) owns them. Gives the git-commit
// watcher (github-watcher.ts) something concrete to check per project, and
// gives "verify project status" a real referent instead of prose.
//
// Persistence follows the exact pattern org-tasks.ts uses: a JSON file under
// .naxion/, an in-memory cache, and an mtime check on load. No secrets
// here (that's github-accounts.ts's job) — plain JSON is fine.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.naxion");
const FILE = join(STATE_DIR, "projects.json");

export type Project = {
  id: string;
  name: string;
  accountId: string;         // which GithubAccount's token watches this project's repos
  repos: string[];           // "owner/repo" strings
  lastSeenShas: Record<string, string>; // repo -> last-seen commit sha (short, matches github.ts's convention)
  createdAt: string;
  updatedAt: string;
};

type Store = { projects: Project[] };
let cache: Store | null = null;
let cacheMtimeMs = 0;

function load(): Store {
  const cached = cache;
  if (cached) {
    try {
      const m = statSync(FILE).mtimeMs;
      if (m === cacheMtimeMs) return cached;
      cache = null; // file changed under us — re-read
    } catch { return cached; }
  }
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(FILE)) {
    cache = { projects: [] };
    persist();
    return cache;
  }
  try {
    const raw = readFileSync(FILE, "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    cache = { projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
  } catch (e) {
    console.warn(`[projects] failed to read ${FILE}: ${(e as Error).message}. Starting empty.`);
    cache = { projects: [] };
  }
  try { cacheMtimeMs = statSync(FILE).mtimeMs; } catch { cacheMtimeMs = 0; }
  return cache;
}

function persist(): void {
  if (!cache) return;
  try {
    writeFileSync(FILE, JSON.stringify(cache, null, 2));
    try { cacheMtimeMs = statSync(FILE).mtimeMs; } catch { /* next load() re-reads — harmless */ }
  } catch (e) {
    console.warn(`[projects] persist failed: ${(e as Error).message}`);
  }
}

export function listProjects(): Project[] {
  return load().projects.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProject(id: string): Project | undefined {
  return load().projects.find(p => p.id === id);
}

export function createProject(input: { name: string; accountId: string; repos: string[] }): Project {
  const name = String(input.name ?? "").trim();
  const accountId = String(input.accountId ?? "").trim();
  const repos = (Array.isArray(input.repos) ? input.repos : []).map(r => String(r).trim()).filter(Boolean);
  if (!name) throw new Error("name is required");
  if (!accountId) throw new Error("accountId is required");
  if (repos.length === 0) throw new Error("at least one repo is required");
  const now = new Date().toISOString();
  const project: Project = { id: randomUUID(), name, accountId, repos, lastSeenShas: {}, createdAt: now, updatedAt: now };
  const s = load();
  s.projects.push(project);
  persist();
  return project;
}

export function updateProject(id: string, patch: { name?: string; accountId?: string; repos?: string[] }): Project | null {
  const s = load();
  const p = s.projects.find(x => x.id === id);
  if (!p) return null;
  if (patch.name !== undefined) p.name = String(patch.name).trim() || p.name;
  if (patch.accountId !== undefined) p.accountId = String(patch.accountId).trim() || p.accountId;
  if (patch.repos !== undefined) {
    const repos = patch.repos.map(r => String(r).trim()).filter(Boolean);
    if (repos.length > 0) {
      // Drop lastSeenShas for repos no longer tracked — a re-added repo just
      // re-detects its current HEAD as "new" on the next tick, which is fine.
      p.lastSeenShas = Object.fromEntries(Object.entries(p.lastSeenShas).filter(([repo]) => repos.includes(repo)));
      p.repos = repos;
    }
  }
  p.updatedAt = new Date().toISOString();
  persist();
  return p;
}

export function deleteProject(id: string): boolean {
  const s = load();
  const next = s.projects.filter(p => p.id !== id);
  if (next.length === s.projects.length) return false;
  s.projects = next;
  persist();
  return true;
}

// Called by github-watcher.ts once it's confirmed the newest commit for
// repo differs from what's on record.
export function recordSeenSha(projectId: string, repo: string, sha: string): void {
  const s = load();
  const p = s.projects.find(x => x.id === projectId);
  if (!p) return;
  p.lastSeenShas[repo] = sha;
  p.updatedAt = new Date().toISOString();
  persist();
}
