/**
 * Crash-safe reads and writes for the JSON stores under .neuroworks/.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-22 at 12:05 C: hit zero bytes free. `schedules.ts` persisted with
 * `writeFileSync(FILE, ...)` straight onto the live path: opening for write
 * truncated the file, the write then failed with ENOSPC, and schedules.json was
 * left at 0 bytes. All 11 of the operator's schedules were gone.
 *
 * `vault-embeddings.ts` took the SAME ENOSPC in the same minutes and its store
 * survived, because it wrote to a temp file and renamed. One line of difference,
 * two outcomes. That pattern (vault-embeddings.ts:176) is generalised here.
 *
 * But atomicity alone would NOT have saved those 11 records, and it is important
 * to be clear about that. Once the file was 0 bytes, `load()` treated it as an
 * empty store, and the next `createSchedule` would have written a one-record
 * store over it — atomically, durably, and wrong. So this module carries two
 * defences, and the second is the load-bearing one:
 *
 *   1. A write never opens the target. Any failure leaves the previous bytes.
 *   2. A store that could not be READ is marked degraded, and the caller must
 *      refuse to persist over it. You do not overwrite a file you failed to read.
 *
 * `.neuroworks/` is gitignored, so a destroyed store has no history to recover
 * from. Hence the `.bak` generation and the `.corrupt-<ts>` quarantine: they are
 * the only copies that will ever exist.
 *
 * Path resolution lives here too. Only 15 of ~53 writers honoured
 * NEUROWORKS_STATE_DIR; the rest hardcoded `resolve(__dirname, "../../../.neuroworks")`,
 * so a test that imported one wrote to the operator's real state (that is how
 * two Postgres connection strings were destroyed — commit e439344). Modules that
 * take their path from `statePath()` cannot have that bug.
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync,
  statfsSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The state directory, honouring NEUROWORKS_STATE_DIR. Read every call, never cached. */
export function stateDir(): string {
  return process.env.NEUROWORKS_STATE_DIR
    ? resolve(process.env.NEUROWORKS_STATE_DIR)
    : resolve(__dirname, "../../../.neuroworks");
}

/**
 * A path inside the state dir.
 *
 * NOT cached at module level, deliberately: a module-level `const FILE =
 * statePath("x.json")` is evaluated at import time, which is before a test's
 * `beforeEach` can redirect the env var. Call this inside load/persist instead.
 */
export function statePath(...segs: string[]): string {
  return join(stateDir(), ...segs);
}

export type WriteOpts = {
  /** Log tag, e.g. "schedules". Defaults to the file's basename. */
  label?: string;
  /** 2-space indent (default true) — every existing store is written pretty. */
  pretty?: boolean;
  /** File mode. Pass 0o600 for credential stores (api-keys/users/connectors precedent). */
  mode?: number;
  /** Keep one previous generation as `<path>.bak` (default true). */
  bak?: boolean;
  /** Refuse to write below this much free space. Default 8 MB; 0 disables. */
  minFreeBytes?: number;
};

const DEFAULT_MIN_FREE = 8 * 1024 * 1024;

/**
 * Free bytes on the volume holding `dir`, or null if it cannot be determined.
 *
 * Never throws: statfsSync is not available on every filesystem, and an
 * unanswerable question about free space must not block a write.
 */
function freeBytes(dir: string): number | null {
  try {
    const st = statfsSync(dir);
    const free = Number(st.bsize) * Number(st.bavail);
    return Number.isFinite(free) && free >= 0 ? free : null;
  } catch { return null; }
}

/** Raised when a write was refused because the volume is (nearly) full. */
export class OutOfSpace extends Error {}

/**
 * Write JSON to `path` atomically. Throws on failure, having left the existing
 * file byte-for-byte unchanged.
 *
 * The whole property rests on one fact: the target is never opened for writing.
 * A throw anywhere below therefore cannot have damaged it.
 */
export function writeJsonStoreAtomic(path: string, value: unknown, opts: WriteOpts = {}): void {
  const label = opts.label ?? path.split(/[\\/]/).pop() ?? "store";
  // Serialise BEFORE touching the filesystem: a circular-ref or BigInt throw
  // must not have created a temp file or clobbered a .bak.
  const json = opts.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // Fail early, and fail SAYING "disk space", instead of surfacing a bare ENOSPC
  // from somewhere deeper. This does not prevent corruption — the rename below
  // does that — it makes the cause legible and skips the .bak copy at exactly
  // the moment when doubling the store on disk is the wrong move.
  //
  // The threshold stays small on purpose: a store that refuses to persist
  // because of a conservative guess is data loss in slow motion.
  const min = opts.minFreeBytes ?? DEFAULT_MIN_FREE;
  if (min > 0) {
    const free = freeBytes(dir);
    const need = Math.max(min, Buffer.byteLength(json, "utf8") * 3);
    if (free !== null && free < need) {
      throw new OutOfSpace(
        `[${label}] refusing to write: ${(free / 1048576).toFixed(1)} MB free on ${dir}, need ~${(need / 1048576).toFixed(1)} MB`,
      );
    }
  }

  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, json, opts.mode === undefined
      ? { encoding: "utf8" }
      : { encoding: "utf8", mode: opts.mode });

    // One generation back, best-effort. Placed AFTER the temp write (which has
    // just proven the space exists) and BEFORE the rename (which destroys the
    // previous contents). Gitignored stores have no other backup.
    if (opts.bak !== false && existsSync(path)) {
      try { copyFileSync(path, `${path}.bak`); } catch { /* a missing .bak must never block the write */ }
    }

    renameSync(tmp, path);
  } finally {
    // Without this every failed rename leaks one temp file per pid, forever.
    //
    // Guarded: a throw from a `finally` REPLACES the exception in flight, so an
    // unguarded cleanup failure would hand the caller "rm returned EISDIR"
    // instead of the ENOSPC that actually stopped the write — hiding the cause
    // of exactly the incident this module exists for.
    try { rmSync(tmp, { force: true }); } catch { /* cleanup is never the story */ }
  }
}

// Failures already reported, keyed `${path}:${code}`. Cleared on the next
// successful write to that path, so a 30s scheduler tick cannot spam the log but
// a RECURRENCE after recovery is still reported. Same spirit as the
// once-per-boot `warnedCorrupt` set in schedules.ts.
const warned = new Set<string>();

/**
 * Write JSON atomically, never throwing. Returns whether the write landed.
 *
 * For callers on a timer or in a request path, where a failed persist must be
 * loud but must not take the process (or the response) down with it.
 */
export function tryWriteJsonStore(path: string, value: unknown, opts: WriteOpts = {}): boolean {
  const label = opts.label ?? path.split(/[\\/]/).pop() ?? "store";
  try {
    writeJsonStoreAtomic(path, value, opts);
    // Recovered — let the next failure speak again.
    for (const k of [...warned]) if (k.startsWith(`${path}:`)) warned.delete(k);
    return true;
  } catch (e: any) {
    const key = `${path}:${e?.code ?? e?.name ?? "err"}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[${label}] persist failed (target left intact): ${e?.message ?? e}`);
    }
    return false;
  }
}

/**
 * Atomic whole-file text write, for the JSONL stores that rewrite themselves on
 * compaction or rotation (briefing-ledger, llm-trace). Same truncation hazard,
 * different serialiser — forcing them through the JSON path would mean parsing
 * and re-emitting lines for no reason.
 */
export function writeTextAtomic(path: string, text: string, opts: WriteOpts = {}): void {
  const label = opts.label ?? path.split(/[\\/]/).pop() ?? "store";
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const min = opts.minFreeBytes ?? DEFAULT_MIN_FREE;
  if (min > 0) {
    const free = freeBytes(dir);
    const need = Math.max(min, Buffer.byteLength(text, "utf8") * 3);
    if (free !== null && free < need) {
      throw new OutOfSpace(
        `[${label}] refusing to write: ${(free / 1048576).toFixed(1)} MB free on ${dir}, need ~${(need / 1048576).toFixed(1)} MB`,
      );
    }
  }
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    if (opts.bak !== false && existsSync(path)) {
      try { copyFileSync(path, `${path}.bak`); } catch { /* best-effort */ }
    }
    renameSync(tmp, path);
  } finally {
    // Guarded — see writeJsonStoreAtomic: a throwing finally would mask the
    // real failure.
    try { rmSync(tmp, { force: true }); } catch { /* cleanup is never the story */ }
  }
}

export type ReadResult<T> = {
  value: T;
  /** Where `value` came from. "empty" means the fallback was used. */
  source: "file" | "backup" | "empty";
  /**
   * Set only when the file EXISTED but could not be used.
   *
   * Callers MUST NOT persist while this is set — that is what turned a truncated
   * schedules.json into permanent loss. A missing file is not an error and does
   * not set this.
   */
  error?: string;
};

type Degraded = { path: string; error: string; at: string };
const degraded = new Map<string, Degraded>();

/** Stores that failed to read in this process. Surfaced on /api/status. */
export function degradedStores(): Degraded[] {
  return [...degraded.values()];
}

/** Clear a store's degraded mark — for a route that has repaired it. */
export function clearDegraded(path: string): void {
  degraded.delete(path);
}

function markDegraded(path: string, error: string): void {
  degraded.set(path, { path, error, at: new Date().toISOString() });
}

/**
 * Move the unusable bytes aside as `<path>.corrupt-<ISO>`.
 *
 * A rename, not a copy: it costs no additional disk space, which matters when
 * the thing that caused the corruption was a full disk. It is also the only
 * forensic copy anyone will get, since .neuroworks has no git history.
 */
function quarantine(path: string, label: string): void {
  try {
    const to = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "")}`;
    renameSync(path, to);
    console.error(`[${label}] unreadable store moved aside to ${to}`);
  } catch (e: any) {
    console.error(`[${label}] could not quarantine ${path}: ${e?.message ?? e}`);
  }
}

function parseStore<T>(raw: string, validate?: (v: unknown) => boolean): T {
  // Strip a UTF-8 BOM: external tools (PowerShell 5.1) write one and JSON.parse
  // rejects it. Promoted from schedules.ts so every store gets the tolerance.
  const parsed = JSON.parse(raw.replace(/^﻿/, ""));
  if (validate && !validate(parsed)) throw new Error("store failed validation");
  return parsed as T;
}

/**
 * Read a JSON store, distinguishing "not there yet" from "damaged".
 *
 * That distinction is the whole point. The old behaviour — parse error, warn to
 * a console nobody watches, substitute an empty store — made a destroyed file
 * indistinguishable from a fresh install, and the API answered HTTP 200 with an
 * empty list for two days.
 */
export function readJsonStore<T>(
  path: string,
  fallback: () => T,
  opts: { label?: string; validate?: (v: unknown) => boolean } = {},
): ReadResult<T> {
  const label = opts.label ?? path.split(/[\\/]/).pop() ?? "store";

  // Genuinely absent: a legitimate first run, not an error.
  if (!existsSync(path)) return { value: fallback(), source: "empty" };

  let raw = "";
  let readErr: string | null = null;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e: any) {
    readErr = e?.message ?? String(e);
  }

  if (readErr === null) {
    // A 0-BYTE FILE IS NOT AN EMPTY STORE. This single classification is the
    // 2026-08-22 incident: an interrupted write leaves exactly this, and
    // treating it as "no records" is what made the loss silent and then
    // permanent.
    if (raw.trim() === "") {
      readErr = "file is empty (0 bytes) — an interrupted write, not an empty store";
    } else {
      try {
        return { value: parseStore<T>(raw, opts.validate), source: "file" };
      } catch (e: any) {
        readErr = e?.message ?? String(e);
      }
    }
  }

  const err = readErr ?? "unreadable";
  console.error(`[${label}] store at ${path} is unreadable: ${err}`);
  markDegraded(path, err);

  // The previous generation, if the last good write left one.
  const bak = `${path}.bak`;
  if (existsSync(bak)) {
    try {
      const value = parseStore<T>(readFileSync(bak, "utf8"), opts.validate);
      quarantine(path, label);
      // REINSTATE the recovered store on disk immediately.
      //
      // Without this the recovery is worthless: `error` being set tells the
      // caller not to persist, quarantine has just renamed the live file away,
      // so the next load() in a later process would find nothing at all and the
      // backup would have bought one process's worth of uptime and no more.
      try {
        writeJsonStoreAtomic(path, value, { label, bak: false });
        console.error(`[${label}] recovered from ${bak} and reinstated ${path}; the bad bytes were kept aside`);
        // Healthy again, so writes are NOT blocked. Still listed in
        // degradedStores() — the operator needs to know this happened.
        return { value, source: "backup" };
      } catch (e: any) {
        // Could not rewrite (still out of space, most likely). Serve the
        // recovered data, but keep writes blocked so nothing overwrites it.
        console.error(`[${label}] recovered from ${bak} but could not reinstate ${path}: ${e?.message ?? e}`);
        return { value, source: "backup", error: err };
      }
    } catch (e: any) {
      console.error(`[${label}] backup ${bak} is also unusable: ${e?.message ?? e}`);
    }
  }

  quarantine(path, label);
  return { value: fallback(), source: "empty", error: err };
}
