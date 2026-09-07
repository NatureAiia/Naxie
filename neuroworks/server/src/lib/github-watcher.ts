// Git commits as a trigger — the first two engines registered into
// scheduler-registry.ts. Polling, not webhooks (no public URL needed to run
// this from a dev box): each tick, for every Project, check every repo it
// tracks for a new commit under that project's own GitHub account.
//
// v1 scope is deliberately narrow: detect + record the new commit and log an
// event. Reacting to it (re-embedding touched vault notes, nudging
// org-daemon) is a natural next step but not built here — that's exactly
// what org-daemon.ts's own cycle already exists to do, and duplicating a
// second reaction pipeline isn't worth it before this one's even proven.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listProjects, recordSeenSha } from "./projects.js";
import { octokitFor } from "./github-accounts.js";
import { recentCommits } from "./github.js";
import { registerEngine } from "./scheduler-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.neuroworks");
const EVENTS_FILE = join(STATE_DIR, "github-events.json");
const MAX_EVENTS = 200;

export type GithubEvent = {
  at: string;
  projectId: string;
  projectName: string;
  repo: string;
  sha: string;
  message: string;
  author: string;
  url: string;
};

function loadEvents(): GithubEvent[] {
  try {
    if (!existsSync(EVENTS_FILE)) return [];
    const parsed = JSON.parse(readFileSync(EVENTS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function appendEvent(event: GithubEvent): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const events = [event, ...loadEvents()].slice(0, MAX_EVENTS);
  try { writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2)); }
  catch (e: any) { console.warn(`[github-watcher] failed to record event: ${e?.message ?? e}`); }
}

export function listGithubEvents(): GithubEvent[] {
  return loadEvents();
}

// One tick: for each project/repo, fetch commits since a lookback window
// (generous enough to not miss anything between ticks even if the process
// was down for a while) and compare the newest sha against what's on record.
async function checkForNewCommits(): Promise<void> {
  const sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  for (const project of listProjects()) {
    let client;
    try { client = octokitFor(project.accountId); }
    catch { continue; } // account was removed — skip, don't crash the tick
    for (const repo of project.repos) {
      const [owner, name] = repo.split("/");
      if (!owner || !name) continue;
      // One bad/revoked token or an unreachable repo shouldn't abort the
      // whole tick — recentCommits rethrows on a 401 (see github.ts's
      // rethrowIfAuthError), which would otherwise stop every other
      // project/repo in this loop from being checked.
      try {
        const commits = await recentCommits(owner, name, sinceIso, client);
        if (commits.length === 0) continue;
        const newest = commits[0]; // recentCommits returns newest-first (GitHub's own listCommits order)
        if (project.lastSeenShas[repo] === newest.sha) continue;
        recordSeenSha(project.id, repo, newest.sha);
        appendEvent({
          at: new Date().toISOString(),
          projectId: project.id,
          projectName: project.name,
          repo,
          sha: newest.sha,
          message: newest.message,
          author: newest.author,
          url: newest.url,
        });
      } catch (e: any) {
        // rethrowIfAuthError's message references GITHUB_TOKEN/.env, which is
        // accurate for the single global client but misleading for a
        // per-account token — rewrite that one case so the log points at the
        // right place to fix.
        const raw = String(e?.message ?? e);
        const detail = raw.includes("GITHUB_TOKEN in .env")
          ? "GitHub auth failed (401 Bad credentials) — this account's token in GitHub Accounts settings is invalid, expired, or revoked"
          : raw;
        console.warn(`[github-watcher] "${project.name}" (${repo}) check failed: ${detail}`);
      }
    }
  }
}

// Confirms each project's assigned account still resolves to a working
// client — cheap reachability signal, not a full CI/Checks integration (that
// would add a second API call per repo per tick; noted as a future
// enhancement, not built in v1).
async function checkProjectStatus(): Promise<void> {
  for (const project of listProjects()) {
    try { octokitFor(project.accountId); }
    catch (e: any) { console.warn(`[github-watcher] project "${project.name}" has no working account: ${e?.message ?? e}`); }
  }
}

const WATCH_INTERVAL_SECONDS = Number(process.env.NEUROWORKS_GITHUB_WATCH_INTERVAL_SECONDS ?? "300") || 300;

export function startGithubWatcher(): void {
  registerEngine({ name: "github-commit-watcher", intervalSeconds: WATCH_INTERVAL_SECONDS, run: checkForNewCommits });
  registerEngine({ name: "github-project-status", intervalSeconds: WATCH_INTERVAL_SECONDS, run: checkProjectStatus });
}
