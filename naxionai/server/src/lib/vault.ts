import { readFileSync, readdirSync, renameSync, statSync, writeFileSync, mkdirSync, existsSync, rmSync, copyFileSync, watch, type FSWatcher } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { simpleGit } from "simple-git";
import { config } from "../config.js";
import { isOffline } from "./offline-mode.js";
import { scanForSecurityRisks } from "./security.js";
import { buildIndex, invalidateIndex, searchIndex, indexStats, isBuildInProgress } from "./vault-index.js";
import { scheduleReembed } from "./rag-embed.js";
import { recordCustody } from "./file-governance.js";

const VAULT = config.vaultPath;

// Set NEUROWORKS_VAULT_SCAN=0 to disable. Default: ON. The scanner is fast (regex
// only) and prevents secrets that landed in an LLM response from being
// committed + pushed to a remote. High-severity findings refuse the write.
const VAULT_SCAN_ENABLED = process.env.NEUROWORKS_VAULT_SCAN !== "0";

export type VaultNode = {
  name: string;
  path: string;
  type: "dir" | "file";
  children?: VaultNode[];
  size?: number;
  mtimeMs?: number;
};

const HIDDEN_PREFIXES = [".obsidian", ".git", "node_modules"];

// Stale-lock recovery. A `.git/index.lock` file that's older than this
// threshold AND can be safely removed (we can't see the process holding it)
// is treated as left over from a crashed git process. Git itself takes the
// lock for milliseconds; anything more than 60s is almost certainly stale.
// Tunable via env in case someone runs a slow filesystem sync on the vault.
const STALE_LOCK_AGE_MS = Number(process.env.NEUROWORKS_STALE_LOCK_AGE_MS ?? "60000");
// Known lock files git creates. We only ever touch `index.lock` — the others
// are rare enough that auto-removing them could mask a real concurrent op.
// If users hit those repeatedly we can add them later.
const VAULT_LOCK_PATH = join(VAULT, ".git", "index.lock");

// Before each git operation, look for a stale `.git/index.lock` and remove
// it. Two safety rails:
//   (1) Only delete locks older than STALE_LOCK_AGE_MS.
//   (2) Try the delete and tolerate EBUSY (real git op in progress).
// If the lock is fresh, we DO NOT delete — that would race with whatever
// real git invocation is mid-commit.
export function clearStaleVaultLock(): { cleared: boolean; reason?: string; ageMs?: number } {
  try {
    if (!existsSync(VAULT_LOCK_PATH)) return { cleared: false, reason: "no lock present" };
    const st = statSync(VAULT_LOCK_PATH);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < STALE_LOCK_AGE_MS) {
      return { cleared: false, reason: `lock is fresh (${(ageMs / 1000).toFixed(1)}s) — leaving alone`, ageMs };
    }
    try {
      rmSync(VAULT_LOCK_PATH, { force: true });
      console.log(`[vault] removed stale .git/index.lock (age ${(ageMs / 1000).toFixed(1)}s)`);
      return { cleared: true, ageMs };
    } catch (e: any) {
      const msg = String(e?.code ?? e?.message ?? e);
      if (msg === "EBUSY" || msg.includes("ENOTEMPTY")) {
        return { cleared: false, reason: `delete failed — real git op in progress (${msg})`, ageMs };
      }
      return { cleared: false, reason: msg, ageMs };
    }
  } catch (e: any) {
    return { cleared: false, reason: String(e?.message ?? e) };
  }
}

// Quick vault-health probe — used by the brain routes + /api/health to tell
// the UI whether the vault path resolves on disk. Without this, an unmounted
// VAULT_PATH (e.g. D: drive on Windows) made listVault silently return [],
// which looks identical to "your vault is empty" — the user has no idea
// the drive is just missing. This helper surfaces the truth so the
// Knowledge page can show "vault unreachable" instead of an empty tree.
export type VaultHealth = {
  ok: boolean;
  vaultPath: string;
  exists: boolean;
  gitRepo: boolean;
  reason?: string;
  index?: { ready: boolean; docs: number; ageMs: number; built: boolean };
};

export function getVaultHealth(): VaultHealth {
  const vaultPath = VAULT;
  let exists = false;
  let gitRepo = false;
  let reason: string | undefined;
  try {
    exists = existsSync(vaultPath);
    if (!exists) {
      reason = `vault path "${vaultPath}" not found (drive unmounted, path renamed, or VAULT_PATH misconfigured)`;
    } else {
      // Confirm it's a directory and that the .git subdirectory exists — that
      // tells us this is a real vault repo, not just a coincidental folder
      // with the same name.
      const st = statSync(vaultPath);
      if (!st.isDirectory()) {
        exists = false;
        reason = `vault path "${vaultPath}" exists but is not a directory`;
      } else {
        gitRepo = existsSync(resolve(vaultPath, ".git"));
        if (!gitRepo) reason = "vault directory exists but contains no .git — Obsidian sync will not work until you initialise git in this folder";
      }
    }
  } catch (e: any) {
    reason = `vault health probe failed: ${e?.message ?? e}`;
  }
  return { ok: exists && (gitRepo || !!process.env.NEUROWORKS_VAULT_ALLOW_NO_GIT), vaultPath, exists, gitRepo, reason, index: indexStats() };
}

export function listVault(rel = ""): VaultNode[] {
  assertVaultExists();
  const full = resolve(VAULT, rel);
  ensureInsideVault(full);
  if (!existsSync(full)) return [];
  const entries = readdirSync(full, { withFileTypes: true })
    .filter(e => !HIDDEN_PREFIXES.some(p => e.name.startsWith(p)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return entries.map(e => {
    const abs = join(full, e.name);
    const childRel = relative(VAULT, abs).split(sep).join("/");
    if (e.isDirectory()) return { name: e.name, path: childRel, type: "dir" as const };
    const st = statSync(abs);
    return { name: e.name, path: childRel, type: "file" as const, size: st.size, mtimeMs: st.mtimeMs };
  });
}

// Generic move/rename within the vault — used by the Files explorer's
// drag-and-drop. Unlike /api/brain/promote (which rewrites frontmatter) this
// is a plain filesystem rename: same content, new location. Both endpoints
// must resolve inside the vault; mkdir the destination's parent so dropping
// onto a not-yet-created folder still works.
export function moveVaultEntry(fromRel: string, toRel: string): void {
  assertVaultExists();
  // Moving something OUT of _wiki/ is fine (cleanup); moving/renaming INTO
  // it bypasses the compile-only ownership rule on writeVaultFile, so it
  // gets the same refusal here.
  if (isWikiPath(toRel) && !isWikiPath(fromRel)) throw new VaultOwnershipRefusal(toRel);
  const from = resolve(VAULT, fromRel);
  const to = resolve(VAULT, toRel);
  ensureInsideVault(from);
  ensureInsideVault(to);
  if (!existsSync(from)) throw new Error(`not found: ${fromRel}`);
  mkdirSync(resolve(to, ".."), { recursive: true });
  renameSync(from, to);
  invalidateSearchCache();
}

// Generic delete (file or folder, recursive) — unlike /api/brain/discard
// (restricted to _imports/) this works anywhere in the vault. Gated to
// admin-layer callers at the route level; the UI confirms before calling.
export function deleteVaultEntry(rel: string): void {
  assertVaultExists();
  const full = resolve(VAULT, rel);
  ensureInsideVault(full);
  if (!existsSync(full)) return;
  rmSync(full, { recursive: true, force: true });
  invalidateSearchCache();
}

export function mkdirVaultDir(rel: string): void {
  assertVaultExists();
  if (isWikiPath(rel)) throw new VaultOwnershipRefusal(rel);
  const full = resolve(VAULT, rel);
  ensureInsideVault(full);
  mkdirSync(full, { recursive: true });
}

export function statVaultEntry(rel: string): { exists: boolean; isDir?: boolean; size?: number; mtimeMs?: number } {
  assertVaultExists();
  const full = resolve(VAULT, rel);
  ensureInsideVault(full);
  if (!existsSync(full)) return { exists: false };
  const st = statSync(full);
  return { exists: true, isDir: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
}

// Last commit that touched this one file — powers Library's hover tooltip
// (Data lineage: "modified 3 days ago · a1b2c3d · fixed onboarding copy").
// Lazy/on-demand only (called per hovered file, never bulk-attached to a
// folder listing) so browsing stays fast even on a large vault. Returns null
// when the vault isn't a git repo, or the file has no commit history yet
// (freshly created, not yet committed).
// Generic git-status probe for any local directory (not vault-specific,
// despite living in this file alongside every other simpleGit usage) —
// powers the IDE page's toolbar branch/dirty-count strip for whichever
// backend it's currently browsing. Cheap and read-only.
export async function gitStatusForDir(rootDir: string): Promise<{ isRepo: boolean; branch?: string; dirtyCount?: number }> {
  if (!existsSync(resolve(rootDir, ".git"))) return { isRepo: false };
  try {
    const git = simpleGit(rootDir);
    const status = await git.status();
    return { isRepo: true, branch: status.current ?? undefined, dirtyCount: status.files.length };
  } catch {
    return { isRepo: false };
  }
}

export async function vaultFileLineage(rel: string): Promise<{ commitHash: string; commitDate: string; commitMessage: string } | null> {
  assertVaultExists();
  const full = resolve(VAULT, rel);
  ensureInsideVault(full);
  if (!existsSync(full)) return null;
  try {
    const git = simpleGit(VAULT);
    const out = await git.raw(["log", "-1", "--format=%H%x1f%aI%x1f%s", "--", rel]);
    const line = out.trim();
    if (!line) return null;
    const [commitHash, commitDate, commitMessage] = line.split("\x1f");
    if (!commitHash) return null;
    return { commitHash, commitDate, commitMessage: commitMessage ?? "" };
  } catch {
    return null;
  }
}

// Full commit history for one vault file — powers the Library page's
// "History" panel (list of versions to diff). Same guards/idiom as
// vaultFileLineage above, just `git log` without `-1` and with author name
// added (the UI shows "who changed this"). Requests one extra row beyond
// `limit` so we can tell the caller whether there's another page — `before`
// is passed straight through as a revision arg (e.g. the oldest commitHash
// already seen), so `git log <before> -- rel` continues the walk from
// there for the next page.
export async function vaultFileHistory(
  rel: string,
  opts?: { limit?: number; before?: string },
): Promise<{ versions: { commitHash: string; commitDate: string; author: string; commitMessage: string }[]; hasMore: boolean }> {
  assertVaultExists();
  const full = resolve(VAULT, rel);
  ensureInsideVault(full);
  if (!existsSync(full)) return { versions: [], hasMore: false };
  const limit = opts?.limit ?? 50;
  try {
    const git = simpleGit(VAULT);
    const args = ["log", `--max-count=${limit + 1}`];
    if (opts?.before) args.push(opts.before);
    args.push("--format=%H%x1f%aI%x1f%an%x1f%s", "--", rel);
    const out = await git.raw(args);
    const lines = out.split("\n").map(l => l.trim()).filter(Boolean);
    const hasMore = lines.length > limit;
    const versions = lines.slice(0, limit).map(line => {
      const [commitHash, commitDate, author, commitMessage] = line.split("\x1f");
      return { commitHash, commitDate, author: author ?? "", commitMessage: commitMessage ?? "" };
    });
    return { versions, hasMore };
  } catch {
    return { versions: [], hasMore: false };
  }
}

// Read this file's content as of a specific commit. Returns null (rather
// than throwing) when the file didn't exist at that commit, the hash is
// bad, or the vault isn't a git repo — callers (the diff endpoint) treat
// null as "this side has no content" rather than a hard error.
export async function vaultFileVersionContent(rel: string, commitHash: string): Promise<string | null> {
  assertVaultExists();
  const full = resolve(VAULT, rel);
  ensureInsideVault(full);
  try {
    const git = simpleGit(VAULT);
    const out = await git.raw(["show", `${commitHash}:${rel}`]);
    return out;
  } catch {
    return null;
  }
}

// Diff support for the History panel — `toHash === "WORKING"` compares a
// past commit against the current on-disk file (which may be ahead of HEAD:
// writes are coalesced through a 4s debounce in commit-queue.ts before
// they're committed), otherwise both sides are read from git history.
export async function vaultFileDiff(
  rel: string,
  fromHash: string,
  toHash: string,
): Promise<{ before: string | null; after: string | null }> {
  const before = await vaultFileVersionContent(rel, fromHash);
  if (toHash === "WORKING") {
    let after: string | null;
    try {
      after = readVaultFile(rel);
    } catch {
      after = null;
    }
    return { before, after };
  }
  const after = await vaultFileVersionContent(rel, toHash);
  return { before, after };
}

export function readVaultFile(rel: string): string {
  assertVaultExists();
  const full = resolve(VAULT, rel);
  ensureInsideVault(full);
  return readFileSync(full, "utf8");
}

// Thrown by every read/write entrypoint when the vault root doesn't
// resolve on this machine (drive unmounted, path renamed, env wrong).
// Without this, searchVault() silently returns [] and downstream code
// reports "No matches" — masking the real failure behind a result that
// looks like an empty vault. Surfacing it lets the template runner,
// the agent primitive, and brain.ts all give the user the actual cause.
export class VaultUnreachable extends Error {
  vaultPath: string;
  constructor(vaultPath: string, reason?: string) {
    super(reason ?? `vault path "${vaultPath}" is unreachable (drive unmounted, path renamed, or VAULT_PATH misconfigured)`);
    this.vaultPath = vaultPath;
    this.name = "VaultUnreachable";
  }
}

// Cheap existence check. Centralised so any future change (e.g. allow a
// secondary fallback path) lands in one place.
function assertVaultExists(): void {
  if (!existsSync(VAULT)) throw new VaultUnreachable(VAULT);
}

export class VaultSecurityRefusal extends Error {
  findings: { type: string; severity: string; reason: string }[];
  constructor(findings: { type: string; severity: string; reason: string }[]) {
    super(`refusing vault write — ${findings.length} high-severity finding(s): ${findings.map(f => f.type).join(", ")}`);
    this.findings = findings;
    this.name = "VaultSecurityRefusal";
  }
}

// Second-brain folder convention: raw captures vs. compiled knowledge.
//   ARCHIVE_DIR — raw material (call transcripts, YouTube transcripts, voice
//     notes, pasted documents). You and Naxie's capture primitives write here.
//   WIKI_DIR    — distilled, compiled entries. ONLY the nightly wiki-compile
//     job may write here (see lib/wiki-compile.ts) — enforced below, not just
//     documented, so an agent/user write attempt fails loudly instead of
//     silently mixing raw and compiled content in the same tree.
export const ARCHIVE_DIR = "_archive";
export const WIKI_DIR = "_wiki";

export class VaultOwnershipRefusal extends Error {
  constructor(rel: string) {
    super(`refusing write to "${rel}" — ${WIKI_DIR}/ is compiled knowledge, written ONLY by the nightly wiki-compile job. Write your raw material to ${ARCHIVE_DIR}/ instead; the next compile will distill it into the wiki.`);
    this.name = "VaultOwnershipRefusal";
  }
}

function isWikiPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.?\//, "");
  return norm === WIKI_DIR || norm.startsWith(`${WIKI_DIR}/`);
}

export function writeVaultFile(rel: string, content: string, opts: { system?: boolean } = {}) {
  assertVaultExists();
  if (isWikiPath(rel) && !opts.system) throw new VaultOwnershipRefusal(rel);
  const full = resolve(VAULT, rel);
  ensureInsideVault(full);
  if (VAULT_SCAN_ENABLED) {
    const findings = scanForSecurityRisks(content, "note");
    const high = findings.filter(f => f.severity === "high");
    if (high.length > 0) {
      // Refuse — never commit a secret. The agent can call security.scan
      // explicitly to redact and retry, but the default-on guardrail blocks
      // the write outright.
      throw new VaultSecurityRefusal(high.map(f => ({ type: f.type, severity: f.severity, reason: f.reason })));
    }
  }
  mkdirSync(resolve(full, ".."), { recursive: true });
  const existed = existsSync(full);
  writeFileSync(full, content, "utf8");
  // Chain-of-custody trail (RIFTS-X CustodyLog). Best-effort, never throws.
  try {
    recordCustody({ path: rel, action: existed ? "edited" : "created" });
  } catch { /* governance must never break writes */ }
  // Vault changed — drop the search cache so the next searchVault picks up
  // the new note instead of returning stale results from the 60s window.
  //
  // EXCEPT for `_neuroworks/` machine state (job journals, reflections, etc.).
  // Those are append-only audit records, not user knowledge — and EVERY job
  // completion writes one. Invalidating the index on each of them created a
  // feedback loop under concurrent load: 80 jobs → 80 index busts → every
  // in-flight searchVault fell back to the synchronous 10-15s full-vault walk,
  // blocking the event loop (load test: search p50 went 0.2s → 20s, with the
  // server returning "fetch failed" on dispatch). Skipping invalidation here
  // keeps the index hot during job storms; real user-note writes still bust it.
  if (!isMachineStatePath(rel)) invalidateSearchCache();
}

// The ONE legitimate way to write into _wiki/ — used only by
// lib/wiki-compile.ts's nightly job. Everything else (agents, the user via
// the Files explorer's editor, primitives) goes through writeVaultFile and
// gets refused by the ownership guard above.
export function writeWikiFile(rel: string, content: string) {
  if (!isWikiPath(rel)) throw new Error(`writeWikiFile called with a non-${WIKI_DIR}/ path: ${rel}`);
  writeVaultFile(rel, content, { system: true });
}

// Persist a Zettelkasten permanent note — shared by the vault.create_zettel
// tool handler (primitives.ts) and the auto-zettel-extraction daemon loop
// (zettel-extract.ts), so both produce byte-identical frontmatter/filename
// shape (vault tooling like tag search and the graph view depend on that
// consistency). Does NOT commit — callers enqueueVaultCommit() themselves
// with their own commit message.
export function writeZettel(title: string, body: string, tags: string[] = []): { path: string; id: string } {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";
  const path = `2-Permanent/${stamp}-${slug}.md`;
  const today = new Date().toISOString().slice(0, 10);
  const md = `---\nid: ${stamp}\ntitle: ${title}\ntags: [${tags.join(", ")}]\ncreated: ${today}\n---\n\n# ${title}\n\n${body}\n`;
  writeVaultFile(path, md);
  return { path, id: stamp };
}

// `_neuroworks/` (and its OS path-separator variants) is NeuroWorks's own
// audit/state tree inside the vault — not user knowledge. Writes there must not
// disturb the user-knowledge search index.
function isMachineStatePath(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").replace(/^\.?\//, "");
  return norm === "_neuroworks" || norm.startsWith("_neuroworks/");
}

const AGENT_CAPTURE_RE = /^0-Inbox\/\d{12}-(?:research|curated|multiperspective|board)-/i;
const AGENT_JOURNAL_RE = /^_neuroworks\/(?:jobs|session|sessions|reflections|templates)\//i;
const DERIVED_DATASET_RE = /^_datasets\/[^/]+\/rag\.md$/i;

export function isAgentCapture(path: string): boolean {
  return AGENT_CAPTURE_RE.test(path) || AGENT_JOURNAL_RE.test(path) || DERIVED_DATASET_RE.test(path);
}

// Copy a binary file INTO the vault. PDFs, DOCXs, images — anything the
// text-based writeVaultFile can't safely scan or write. Skips the secret
// scan (binaries aren't strings; we'd produce garbage hits) but still
// applies the inside-vault containment check so a path-traversal arg
// can't escape D:\Main brain.
//
// Returns the absolute path written so the caller can compute file size,
// log provenance, etc.
export function importBinaryIntoVault(rel: string, sourceAbsPath: string): { rel: string; abs: string; size: number } {
  if (isWikiPath(rel)) throw new VaultOwnershipRefusal(rel);
  const full = resolve(VAULT, rel);
  ensureInsideVault(full);
  const st = statSync(sourceAbsPath);
  if (!st.isFile()) throw new Error(`source is not a file: ${sourceAbsPath}`);
  mkdirSync(resolve(full, ".."), { recursive: true });
  // copyFileSync preserves the original — the agent's contract with the
  // user is COPY-not-MOVE for "save to my vault" unless the user
  // explicitly asks to remove the original.
  copyFileSync(sourceAbsPath, full);
  invalidateSearchCache();
  return { rel, abs: full, size: st.size };
}

// Cheap "how many local commits haven't reached origin" probe. Useful
// when commitAndPush silently timed out — the local commit is durable
// but the user has no visual signal that origin is behind. Surfaced
// via vaultCommitStats() → /api/status. Returns null when status
// itself fails (e.g. vault is not a git repo, or a transient lock).
export async function vaultAheadBy(): Promise<number | null> {
  try {
    const git = simpleGit(VAULT);
    const status = await git.status();
    return typeof status.ahead === "number" ? status.ahead : null;
  } catch { return null; }
}

// Push the current HEAD without committing. Used to retry a failed push when
// the prior commitAndPush left commits locally but couldn't reach origin (the
// most common case: large pack history times out the first push, but a retry
// from a now-warm git connection works). Same 15s timeout to keep the UI
// responsive.
export async function pushOnly(): Promise<{ pushed: boolean; error?: string; aheadBy?: number }> {
  // Stale-lock sweep — defensive cleanup before touching the repo. Cheap;
  // does nothing if no lock exists or the lock is recent.
  if (isOffline()) return { pushed: false, error: "offline mode — commits stay local until you go back online" };
  clearStaleVaultLock();
  const git = simpleGit(VAULT);
  let aheadBy: number | undefined;
  try {
    const status = await git.status();
    aheadBy = status.ahead;
  } catch { /* tolerate */ }
  try {
    await raceTimeout(git.push("origin", "HEAD"), 15_000, "push timeout");
    return { pushed: true, aheadBy };
  } catch (e: any) {
    return { pushed: false, error: String(e?.message ?? e), aheadBy };
  }
}

export async function commitAndPush(message: string) {
  // Stale-lock sweep — removes a left-over `.git/index.lock` from a previously
  // crashed git process so this commit doesn't fail with the "Unable to
  // create '.git/index.lock': File exists" error. Cheap and bounded; if the
  // lock is fresh OR EBUSY (real git op in flight) we leave it alone.
  clearStaleVaultLock();
  const git = simpleGit(VAULT);
  // Retry once on lock-conflict — if a real git op held the lock and finished
  // between our sweep and the .add() call, the second attempt sees no lock.
  // Anything more aggressive than one retry risks masking real concurrent
  // commits, so we stop there.
  try {
    await git.add(".");
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/index\.lock|File exists/.test(msg)) {
      console.warn("[vault] git.add hit lock; sweeping + retrying once");
      clearStaleVaultLock();
      await git.add(".");
    } else {
      throw e;
    }
  }
  const before = await git.status();
  if (before.staged.length === 0 && before.created.length === 0 && before.modified.length === 0 && before.deleted.length === 0 && before.renamed.length === 0) {
    return { committed: false };
  }

  // GitHub hard-rejects any push containing a blob over 100 MB (GH001) — and
  // one such file poisons EVERY subsequent push until history is rewritten
  // (the 2026-07-16 incident: two oversized downloads blocked 112 commits for
  // weeks). Unstage anything over 95 MB before committing, whatever wrote it;
  // the file stays on disk, it just never enters git history.
  const GH_BLOB_LIMIT = 95 * 1024 * 1024;
  for (const rel of [...before.created, ...before.modified, ...before.staged]) {
    try {
      const st = statSync(resolve(VAULT, rel));
      if (st.isFile() && st.size > GH_BLOB_LIMIT) {
        await git.reset(["--", rel]);
        console.warn(`[vault] NOT committing ${rel} (${(st.size / 1024 / 1024).toFixed(0)} MB > GitHub's 100 MB blob limit) — file kept on disk only`);
      }
    } catch { /* stat/reset failures fall through to the normal commit */ }
  }
  const after = await git.status();
  if (after.staged.length === 0) return { committed: false };

  await git.commit(message);

  // Offline mode: the commit is durable locally; the push is flushed by
  // pushOnly() when the operator switches back online.
  if (isOffline()) {
    return { committed: true, pushed: false, error: "offline mode — commit is local-only until you go back online" };
  }

  // Time-box the push. Vault repos with large pack history can stall HTTP push
  // for minutes before timing out — that hangs every clawbot task. We bound at
  // 15s; if we can't push in that window, return success-with-deferred and let
  // the user resolve the sync separately (the local commit is already durable).
  const PUSH_TIMEOUT_MS = 15_000;

  let pushErr: any = null;
  try {
    await raceTimeout(git.push("origin", "HEAD"), PUSH_TIMEOUT_MS, "push timeout");
    return { committed: true, pushed: true };
  } catch (e: any) {
    pushErr = e;
    const msg = String(e.message ?? e);
    if (msg === "push timeout") {
      return { committed: true, pushed: false, error: "push exceeded 15s; commit is local-only — fix vault.git size or sync manually" };
    }
    if (!/rejected|fetch first|non-fast-forward|fast-forward/i.test(msg)) {
      return { committed: true, pushed: false, error: msg };
    }
  }

  // Stale-ref recovery path. DEFAULT OFF — when origin/main is divergent (the
  // common case for a private vault that hasn't been pushed yet), `pull --rebase`
  // rewinds local commits and replays them, which can drop into a paused
  // interactive-rebase state and cause every subsequent journal commit to
  // re-trigger the same loop. The local commit is already durable; let the user
  // reconcile the remote manually. Set NEUROWORKS_AUTO_REBASE_RECOVERY=1 to opt in.
  if (process.env.NEUROWORKS_AUTO_REBASE_RECOVERY !== "1") {
    return { committed: true, pushed: false, error: `push rejected; auto-rebase disabled (set NEUROWORKS_AUTO_REBASE_RECOVERY=1 to enable). Original error: ${String(pushErr.message ?? pushErr).slice(0, 200)}` };
  }
  try {
    return await raceTimeout(rebaseWithSidesteppedConflicts(git, String(pushErr.message ?? pushErr)), PUSH_TIMEOUT_MS * 2, "rebase timeout");
  } catch (e: any) {
    return { committed: true, pushed: false, error: String(e.message ?? e) };
  }
}

function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

// Pull --rebase, but if it fails because untracked-and-gitignored files would be overwritten by an
// intermediate rebase commit, move those specific files aside, retry, and restore them. This is what
// happens when older history added files that are now gitignored locally (e.g. the notepad sync).
async function rebaseWithSidesteppedConflicts(git: ReturnType<typeof simpleGit>, originalErr: string, attempt = 0): Promise<any> {
  let conflictPaths: string[] = [];
  const matchAttempt = async (): Promise<{ ok: true } | { ok: false; err: string }> => {
    try {
      try { await git.raw(["rebase", "--abort"]); } catch {}
      await git.fetch("origin", "main");
      await git.pull("origin", "main", { "--rebase": "true" });
      await git.push("origin", "HEAD");
      return { ok: true };
    } catch (e: any) {
      return { ok: false, err: String(e.message ?? e) };
    }
  };

  // First attempt — already failed (we got here because the basic push + rebase didn't work).
  // Parse the conflict paths from the original push/rebase error and move them aside.
  conflictPaths = parseUntrackedConflicts(originalErr);

  if (conflictPaths.length === 0 && attempt === 0) {
    // No specific paths to sidestep — try a plain rebase
    const r = await matchAttempt();
    if (r.ok) return { committed: true, pushed: true, rebased: true };
    if (attempt >= 3) return { committed: true, pushed: false, rebased: true, error: r.err };
    return rebaseWithSidesteppedConflicts(git, r.err, attempt + 1);
  }

  // Move conflict paths aside, retry, restore
  const stashRoot = join(tmpdir(), `clawbot-presync-${randomUUID()}`);
  mkdirSync(stashRoot, { recursive: true });
  const moved: { src: string; tmp: string }[] = [];
  for (const p of conflictPaths) {
    const src = resolve(VAULT, p);
    if (!existsSync(src)) continue;
    const tmp = join(stashRoot, p.replace(/[\\/]/g, "_"));
    try { renameSync(src, tmp); moved.push({ src, tmp }); } catch {}
  }
  try {
    const r = await matchAttempt();
    if (r.ok) return { committed: true, pushed: true, rebased: true, sidestepped: moved.length };
    if (attempt < 3) {
      // Maybe more conflicts surfaced
      return rebaseWithSidesteppedConflicts(git, r.err, attempt + 1);
    }
    return { committed: true, pushed: false, rebased: true, error: r.err, sidestepped: moved.length };
  } finally {
    for (const m of moved) {
      try { renameSync(m.tmp, m.src); } catch {}
    }
    try { rmSync(stashRoot, { recursive: true, force: true }); } catch {}
  }
}

function parseUntrackedConflicts(stderr: string): string[] {
  // git emits one path per line, each prefixed with a tab, between the headline and "Please move..."
  const lines = stderr.split(/\r?\n/);
  const paths: string[] = [];
  for (const line of lines) {
    if (line.startsWith("\t") || /^\s\s+/.test(line)) {
      const p = line.trim();
      if (p && !p.startsWith("hint:") && !p.toLowerCase().includes("please move") && !p.includes("Aborting")) {
        paths.push(p);
      }
    }
  }
  return paths;
}

// In-process search cache. The full disk walk + per-file read can take
// 10-15s on a multi-thousand-note vault (measured on D:\Main brain\), and a
// single chat task hits searchVault multiple times (triage, planner, research
// primitives). A 60s TTL keyed by (query, limit) collapses repeat calls
// inside one task into a single walk while still picking up new notes on
// the next task. Bust on every vault write so a just-saved note shows up
// on the very next search.
type SearchHit = { path: string; line: number; preview: string };
const SEARCH_CACHE = new Map<string, { at: number; results: SearchHit[] }>();
const SEARCH_CACHE_TTL_MS = Number(process.env.NEUROWORKS_VAULT_SEARCH_TTL_MS ?? "60000");
const SEARCH_CACHE_MAX = 200;

function invalidateSearchCache() {
  SEARCH_CACHE.clear();
  // Inverted index is independent of the SEARCH_CACHE; bust both on the
  // same signal so vault.search and the MiniSearch path can't disagree
  // about what's in the vault.
  invalidateIndex();
  // pgvector RAG store (Phase 2, optional) — debounced re-embed of the whole
  // vault on the same write signal. No-op when Supabase/embeddings aren't
  // configured (checked inside scheduleReembed).
  scheduleReembed();
}

// External-edit detection. The cache is invalidated whenever
// writeVaultFile runs, which covers every NeuroWorks-side write — but
// the user editing a note directly in Obsidian (or any other tool) is
// invisible to that path. fs.watch recursively notices those edits and
// busts the cache so the next searchVault picks up the change.
//
// Windows: fs.watch supports { recursive: true } natively (ReadDirectoryChangesW).
// We catch + log any setup errors instead of crashing — a missing
// watcher just degrades to the 60s TTL behaviour, not a server outage.
//
// We also coalesce: an Obsidian save typically fires multiple events
// (write, rename for autosave, etc.) within milliseconds. A single
// invalidation per burst is enough.
let vaultWatcher: FSWatcher | null = null;
let watchInvalidateTimer: NodeJS.Timeout | null = null;
const WATCH_COALESCE_MS = 250;

export function startVaultWatcher(): void {
  if (vaultWatcher) return;
  if (process.env.NEUROWORKS_VAULT_WATCH === "0") {
    console.log("[vault] fs.watch disabled via NEUROWORKS_VAULT_WATCH=0 — search cache only busts on server-side writes");
    return;
  }
  try {
    vaultWatcher = watch(VAULT, { recursive: true, persistent: false }, (eventType, filename) => {
      if (!filename) return;
      const name = String(filename);
      // Filter to .md/.canvas changes only — we don't care about images,
      // PDFs, or .git internals for search-cache purposes.
      if (!/\.(md|canvas)$/i.test(name)) return;
      // Skip the .git directory — git operations (during commitAndPush
      // / pull) fire a flood of events that would invalidate the cache
      // for no useful reason.
      if (name.startsWith(".git") || name.includes(`${sep}.git${sep}`) || name.includes("/.git/")) return;
      // Skip `_neuroworks/` — our own audit/journal tree. Every job completion
      // writes a note there; letting the watcher invalidate on those recreates
      // the same index-bust storm writeVaultFile now avoids (see isMachineStatePath).
      if (name.startsWith("_neuroworks") || name.includes(`${sep}_neuroworks${sep}`) || name.includes("/_neuroworks/")) return;
      if (watchInvalidateTimer) clearTimeout(watchInvalidateTimer);
      watchInvalidateTimer = setTimeout(() => {
        watchInvalidateTimer = null;
        // Skip invalidation while the index is mid-build. Subst-mapped D:
        // on Windows fires spurious events for files we're reading, which
        // creates an invalidation/build loop where the index never
        // stabilises. Real external writes still come through after the
        // build window closes — chokidar would mark them but our debounce
        // window already coalesces near-simultaneous events.
        if (isBuildInProgress()) return;
        invalidateSearchCache();
      }, WATCH_COALESCE_MS);
    });
    vaultWatcher.on("error", (e: any) => {
      console.warn(`[vault] watcher error: ${e?.message ?? e}`);
    });
    console.log(`[vault] watching ${VAULT} for external edits`);
    // Kick off an initial index build in the background so the FIRST
    // search after startup doesn't pay the build cost on the request path.
    void buildIndex(VAULT);
  } catch (e: any) {
    console.warn(`[vault] could not start watcher (${e?.message ?? e}) — falling back to ${SEARCH_CACHE_TTL_MS}ms TTL`);
    vaultWatcher = null;
  }
}

export function stopVaultWatcher(): void {
  if (watchInvalidateTimer) { clearTimeout(watchInvalidateTimer); watchInvalidateTimer = null; }
  if (vaultWatcher) { try { vaultWatcher.close(); } catch { /* tolerate */ } vaultWatcher = null; }
}

// Periodic pull --rebase so Obsidian edits made on ANOTHER machine (or via
// Obsidian's git plugin pushing to the same remote) sync into the local
// vault that clawbot reads from. Without this, clawbot only sees changes
// that landed locally — a remote Obsidian save needs a manual git pull
// before clawbot can search / read it.
//
// Defaults: every NEUROWORKS_VAULT_PULL_MIN minutes (default 5). Skipped when:
//   • NEUROWORKS_VAULT_PULL=0 (opt-out)
//   • Local has uncommitted changes (a pull would conflict with in-flight work)
//   • A push is currently in flight (avoid racing simpleGit calls)
//   • Vault path doesn't exist (drive unmounted)
//
// The pull itself is time-boxed at 10s — a stalled remote shouldn't block
// the scheduler from running again.
let vaultPullTimer: NodeJS.Timeout | null = null;
let lastPullAt = 0;
let lastPullResult: { ok: boolean; at: string; details?: string } = { ok: false, at: "never" };
const PULL_TIMEOUT_MS = 10_000;

export async function pullFromOrigin(): Promise<{ ok: boolean; reason?: string; pulled?: boolean }> {
  if (isOffline()) return { ok: false, reason: "offline mode — pull skipped" };
  if (!existsSync(VAULT)) {
    return { ok: false, reason: `vault path ${VAULT} not present (drive unmounted?)` };
  }
  const git = simpleGit(VAULT);
  try {
    const status = await git.status();
    if (status.modified.length + status.created.length + status.deleted.length + status.staged.length + status.renamed.length > 0) {
      return { ok: false, reason: "local has uncommitted changes; pull skipped to avoid conflicts" };
    }
    await raceTimeout(git.fetch("origin"), PULL_TIMEOUT_MS, "fetch timeout");
    const before = (await git.revparse(["HEAD"])).trim();
    await raceTimeout(git.pull("origin", "HEAD", { "--rebase": "true" }), PULL_TIMEOUT_MS, "pull timeout");
    const after = (await git.revparse(["HEAD"])).trim();
    const pulled = before !== after;
    lastPullAt = Date.now();
    lastPullResult = { ok: true, at: new Date().toISOString(), details: pulled ? `pulled ${before.slice(0, 7)} → ${after.slice(0, 7)}` : "already up-to-date" };
    if (pulled) invalidateSearchCache();
    return { ok: true, pulled };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    lastPullAt = Date.now();
    lastPullResult = { ok: false, at: new Date().toISOString(), details: msg.slice(0, 200) };
    return { ok: false, reason: msg };
  }
}

export function startVaultPullScheduler(): void {
  if (vaultPullTimer) return;
  if (process.env.NEUROWORKS_VAULT_PULL === "0") {
    console.log("[vault] periodic pull disabled via NEUROWORKS_VAULT_PULL=0");
    return;
  }
  const minutes = Math.max(1, Number(process.env.NEUROWORKS_VAULT_PULL_MIN ?? "5"));
  const ms = minutes * 60_000;
  vaultPullTimer = setInterval(() => {
    void pullFromOrigin().catch((e: any) => console.warn(`[vault] pull error: ${e?.message ?? e}`));
  }, ms);
  vaultPullTimer.unref?.();
  // Fire one immediately so a fresh-start server catches up before doing work.
  void pullFromOrigin().catch(() => { /* logged inside */ });
  console.log(`[vault] periodic pull armed (every ${minutes}m, opt out with NEUROWORKS_VAULT_PULL=0)`);
}

export function stopVaultPullScheduler(): void {
  if (vaultPullTimer) { clearInterval(vaultPullTimer); vaultPullTimer = null; }
}

export function getVaultPullStatus(): { lastPullAt: number; lastPullResult: typeof lastPullResult } {
  return { lastPullAt, lastPullResult };
}

// Filename-only vault scan. Walks the vault tree but ONLY checks the .md
// filename for the query — never opens the file. Fast (~50-200ms on a multi-
// thousand-note vault) vs ~10-15s for full-content searchVault().
//
// Used by the triage block ("does this user already have notes on X?") where
// we don't need real matches — we just need a yes/no signal that the topic
// is present in the vault. Content search is overkill there; the slow walk
// was the root cause of the 11s gap measured before this fix.
//
// excludeAgentCaptures skips everything under _neuroworks/ (job trackers,
// reflections, memory, personas, screenshots, exports, ...) — the agent's
// own prior output, not real user knowledge. Without it, a self-grounding
// drift bug is possible: the agent cites its own earlier capture as
// evidence the vault "has notes on this", when really it's just seeing its
// own past run. isMachineStatePath() below is the same root-prefix test
// used elsewhere in this file to identify agent/system-generated content.
export function searchVaultFilenames(query: string, limit = 5, opts?: { excludeAgentCaptures?: boolean }): SearchHit[] {
  // Triage path — silently return [] when the vault is unreachable so we
  // don't break the planner's "do we have notes on X?" probe. The actual
  // search path (searchVault) still throws so the user sees the cause.
  if (!existsSync(VAULT)) return [];
  const excludeAgentCaptures = opts?.excludeAgentCaptures ?? false;
  const q = query.toLowerCase();
  // Normalise hyphens/underscores in filenames so "vault edit" matches
  // "vault-edit.md" / "vault_edit.md". Multi-token queries require every
  // token to appear in the filename.
  const tokens = q.replace(/[-_\s]+/g, " ").split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const out: SearchHit[] = [];
  function walk(dir: string) {
    if (out.length >= limit) return;
    let entries: any[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (HIDDEN_PREFIXES.some(p => e.name.startsWith(p))) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (excludeAgentCaptures && isMachineStatePath(relative(VAULT, full))) continue;
        walk(full);
        continue;
      }
      if (!e.name.endsWith(".md")) continue;
      const normalised = e.name.slice(0, -3).toLowerCase().replace(/[-_]+/g, " ");
      if (tokens.every(t => normalised.includes(t))) {
        out.push({
          path: relative(VAULT, full).split(sep).join("/"),
          line: 0,
          preview: e.name,
        });
      }
    }
  }
  walk(VAULT);
  return out;
}

// excludeAgentCaptures mirrors searchVaultFilenames' option of the same name
// (see its comment) — the agent's own prior output (job trackers, reflections,
// memory) under _neuroworks/ is not real user knowledge. The filter MUST run
// INSIDE the search, before the result set is capped to `limit`, not after:
// filtering a capped set that happens to be dominated by captures can leave
// the caller with zero real evidence even though plenty exists just past the
// cutoff (caught live: a reflection backlog of agent telemetry mentioning
// "NeuroWorks" on nearly every line crowded the one real product-description
// note out of the top results research.deep actually reads).
export function searchVault(query: string, limit = 50, opts?: { excludeAgentCaptures?: boolean }): SearchHit[] {
  assertVaultExists();
  const excludeAgentCaptures = opts?.excludeAgentCaptures ?? false;
  const q = query.toLowerCase();
  const key = `${q}|${limit}|${excludeAgentCaptures}`;
  const hit = SEARCH_CACHE.get(key);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) {
    return hit.results;
  }
  // Fast path — MiniSearch inverted index. Falls back to the legacy walk
  // when the index hasn't built yet (cold start) or when MiniSearch declines
  // a query. Index builds lazily; first call after a cache invalidation
  // rebuilds it before serving.
  const stats = indexStats();
  if (!stats.ready) {
    void buildIndex(VAULT);
  } else {
    // Stale (a vault write happened since the last build) still serves —
    // just kick a background refresh alongside it so the index eventually
    // catches up instead of staying stale forever.
    if (stats.stale) void buildIndex(VAULT);
    // Over-fetch when filtering so excluding captures doesn't just shrink
    // the capped set — pull a larger candidate pool, filter, then cap.
    const fetchLimit = excludeAgentCaptures ? Math.max(limit * 5, 100) : limit;
    const indexed = searchIndex(query, VAULT, fetchLimit);
    if (indexed && indexed.length > 0) {
      const filtered = excludeAgentCaptures ? indexed.filter(h => !isMachineStatePath(h.path)) : indexed;
      if (filtered.length > 0) {
        const results = filtered.slice(0, limit).map(h => ({ path: h.path, line: h.line, preview: h.preview }));
        SEARCH_CACHE.set(key, { at: Date.now(), results });
        return results;
      }
      // Every indexed hit was a capture — fall through to the legacy walk,
      // which excludes capture DIRECTORIES from its traversal entirely.
    } else {
      // Index returned [] — let the legacy walk run too, since MiniSearch's
      // AND combiner can be stricter than substring matching. If the walk
      // also returns nothing the user gets the same answer either way.
    }
  }
  const out: SearchHit[] = [];
  function walk(dir: string) {
    if (out.length >= limit) return;
    let entries: any[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (HIDDEN_PREFIXES.some(p => e.name.startsWith(p))) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (excludeAgentCaptures && isMachineStatePath(relative(VAULT, full))) continue;
        walk(full);
        continue;
      }
      if (e.name.endsWith(".md") && statSync(full).size < 1_000_000) {
        try {
          const content = readFileSync(full, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && out.length < limit; i++) {
            if (lines[i].toLowerCase().includes(q)) {
              out.push({ path: relative(VAULT, full).split(sep).join("/"), line: i + 1, preview: lines[i].slice(0, 200) });
              break;
            }
          }
        } catch {}
      }
    }
  }
  walk(VAULT);
  // Cap the cache so a long-running worker doesn't bleed memory on a wide
  // range of unique queries. Drop the oldest entry when over the cap.
  if (SEARCH_CACHE.size >= SEARCH_CACHE_MAX) {
    const oldest = [...SEARCH_CACHE.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) SEARCH_CACHE.delete(oldest[0]);
  }
  SEARCH_CACHE.set(key, { at: Date.now(), results: out });
  return out;
}

function ensureInsideVault(full: string) {
  const r = resolve(full);
  if (!r.startsWith(resolve(VAULT))) {
    throw new Error(`path escapes vault: ${full}`);
  }
}
