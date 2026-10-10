// Naxie's local file access policy.
//
// The operator's grant: READ anywhere on local storage minus the secrets
// denylist (security-gates.ts), TRANSFER via Telegram only after an explicit
// confirm tap, WRITE only inside NAXIE_HOME (D:\Naxie — her folder). Reads
// never leave the machine except as a tapped Telegram send; writes never
// land outside her folder, so an edited copy of a machine file goes to
// NAXIE_HOME instead of overwriting the original.
//
// This module is the single enforcement point: agent primitives, Telegram
// callbacks, and uploads all route through these gates.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { config } from "../config.js";
import { checkSensitivePath } from "./security-gates.js";

// Telegram Bot API file cap (50MB) — refuse anything at/above 48MB so
// metadata + multipart overhead can never push a send over the edge.
export const TELEGRAM_FILE_CAP = 48 * 1024 * 1024;
// Staged sends live 10 minutes — long enough to tap, short enough that a
// forgotten confirm can't be weaponised later.
export const STAGED_SEND_TTL_MS = 10 * 60 * 1000;

export function naxieHome(): string {
  const home = resolve(config.naxieHome);
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
  } catch { /* caller surfaces real errors on use */ }
  return home;
}

// READ gate: anywhere on disk EXCEPT the secrets denylist. Throws on block.
export function assertNaxieReadable(absPath: string): string {
  const full = resolve(absPath);
  const check = checkSensitivePath(full);
  if (check.blocked) {
    throw new Error(`Refused — ${check.reason}. That file stays off Telegram.`);
  }
  return full;
}

// WRITE gate: NAXIE_HOME or nothing. Throws on escape.
export function assertNaxieWritable(absPath: string): string {
  const home = naxieHome();
  const full = resolve(absPath);
  if (full !== home && !full.startsWith(home + sep)) {
    throw new Error(`Refused — Naxie's writes stay inside her folder (${home}).`);
  }
  return full;
}

// Describe a file for confirm cards. Throws when unreadable/missing.
export function describeForSend(absPath: string): { path: string; name: string; size: number; tooBig: boolean } {
  const full = assertNaxieReadable(absPath);
  if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`Not a file: ${absPath}`);
  const size = statSync(full).size;
  return { path: full, name: basename(full), size, tooBig: size >= TELEGRAM_FILE_CAP };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Staged sends (confirm-tap) ────────────────────────────────────────────
// stageSend records intent; claimSendToken consumes it exactly once. Tokens
// are bound to the requesting chat — a tap from any other chat is refused.

export type StagedSend = { path: string; name: string; size: number; chatId: string; expiresAt: number };

const staged = new Map<string, StagedSend>();
let lastSweep = 0;

function sweep(): void {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, v] of staged) if (v.expiresAt <= now) staged.delete(k);
}

export function stageSend(absPath: string, chatId: string): { token: string; staged: StagedSend } {
  sweep();
  const info = describeForSend(absPath);
  if (info.tooBig) {
    throw new Error(`"${info.name}" is ${formatBytes(info.size)} — over Telegram's file limit, can't send it.`);
  }
  const token = randomBytes(8).toString("hex");
  const entry: StagedSend = { path: info.path, name: info.name, size: info.size, chatId, expiresAt: Date.now() + STAGED_SEND_TTL_MS };
  staged.set(token, entry);
  return { token, staged: entry };
}

// Re-checks readability + size + chat binding at tap time (the file may have
// changed since staging). Consumes the token.
export function claimSendToken(token: string, chatId: string): StagedSend {
  sweep();
  const entry = staged.get(token);
  if (!entry) throw new Error("That send expired or was already used — ask for the file again.");
  // Binding check BEFORE consuming: a tap from the wrong chat must not
  // destroy the legitimate staged send.
  if (entry.chatId !== chatId) throw new Error("That confirm belongs to a different chat.");
  staged.delete(token);
  const info = describeForSend(entry.path); // re-gate: denylist + existence + size
  if (info.tooBig) throw new Error(`"${info.name}" grew past Telegram's file limit since staging.`);
  return { ...entry, size: info.size };
}

export function cancelSendToken(token: string, chatId: string): boolean {
  const entry = staged.get(token);
  if (!entry || entry.chatId !== chatId) return false;
  staged.delete(token);
  return true;
}

export function _stagedCountForTests(): number {
  return staged.size;
}

// ── NAXIE_HOME paths ─────────────────────────────────────────────────────

// Safe landing spot for Telegram uploads: NAXIE_HOME/inbox/<sanitized name>
// (collision → numeric suffix, never overwrite).
export function inboxPath(originalName: string): string {
  const home = naxieHome();
  const inbox = join(home, "inbox");
  try {
    if (!existsSync(inbox)) mkdirSync(inbox, { recursive: true });
  } catch { /* surface on write */ }
  const base = basename(String(originalName ?? "upload")).replace(/[<>:"|?*\x00-\x1f]/g, "_").trim() || "upload";
  let candidate = join(inbox, base);
  for (let i = 1; existsSync(candidate) && i < 1000; i++) {
    const dot = base.lastIndexOf(".");
    candidate = dot > 0
      ? join(inbox, `${base.slice(0, dot)}-${i}${base.slice(dot)}`)
      : join(inbox, `${base}-${i}`);
  }
  return candidate;
}

// Edited-copy destination: a machine file's edited version lands in
// NAXIE_HOME (mirroring the source basename), never over the original.
export function editedCopyPath(sourceAbsPath: string, subdir = "edits"): string {
  const home = naxieHome();
  assertNaxieReadable(sourceAbsPath); // even copies respect the denylist
  const dir = join(home, subdir);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* surface on write */ }
  const base = basename(resolve(sourceAbsPath));
  let candidate = join(dir, base);
  for (let i = 1; existsSync(candidate) && i < 1000; i++) {
    const dot = base.lastIndexOf(".");
    candidate = dot > 0
      ? join(dir, `${base.slice(0, dot)}-${i}${base.slice(dot)}`)
      : join(dir, `${base}-${i}`);
  }
  return candidate;
}

// Telegram callback data for the file flow (64-byte cap: 12 + 16 hex max).
export function localSendCallback(token: string): string {
  return `local:send:${token}`;
}
export function localCancelCallback(token: string): string {
  return `local:cancel:${token}`;
}
export function parseLocalCallback(data: string): { action: "send" | "cancel"; token: string } | null {
  const m = /^local:(send|cancel):([0-9a-f]{16})$/.exec(String(data ?? ""));
  if (!m) return null;
  return { action: m[1] as "send" | "cancel", token: m[2] };
}

export function _inboxDirForTests(): string {
  return dirname(inboxPath("probe.tmp"));
}
