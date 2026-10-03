// Nightly wiki-compile — the second-brain "compile" step from the Archive-
// vs-Wiki split (see lib/vault.ts's ARCHIVE_DIR/WIKI_DIR + the ownership
// guard on writeVaultFile). Once a day it walks `_archive/` for raw captures
// (call transcripts, YouTube transcripts, voice notes — see the
// vault.capture_note / vault.capture_youtube primitives) that haven't been
// compiled yet, asks the LLM to distill each into a clean wiki entry, and
// writes the result to `_wiki/` via writeWikiFile — the ONE legitimate path
// into that folder. A second, later-hour scheduler emails/toasts the
// operator a brief morning summary of what got compiled overnight, mirroring
// the "compile at 3am, digest at 7am" split from the second-brain design.
//
// Pattern mirrors lib/reflection.ts: hour-gated catch-up tick (not exact
// cron), restart-proof via an on-disk state file, best-effort throughout.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { config } from "../config.js";
import { readVaultFile, writeWikiFile, ARCHIVE_DIR, WIKI_DIR, getVaultHealth } from "./vault.js";
import { enqueueVaultCommit } from "./commit-queue.js";
import { llmGenerate } from "./llm.js";

const STATE_DIR = "_naxion/wiki-compile";
const STATE_PATH = `${STATE_DIR}/state.json`;

type CompileState = {
  compiledSources: string[];     // archive-relative paths already turned into a wiki entry
  lastCompileAt?: string;        // ISO
  lastDigestSentDate?: string;   // YYYY-MM-DD — guards the digest scheduler
};

function loadState(): CompileState {
  try {
    const full = join(config.vaultPath, STATE_PATH);
    if (!existsSync(full)) return { compiledSources: [] };
    const parsed = JSON.parse(readFileSync(full, "utf8"));
    return { compiledSources: Array.isArray(parsed.compiledSources) ? parsed.compiledSources : [], lastCompileAt: parsed.lastCompileAt, lastDigestSentDate: parsed.lastDigestSentDate };
  } catch { return { compiledSources: [] }; }
}

function saveState(state: CompileState): void {
  const full = join(config.vaultPath, STATE_PATH);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(state, null, 2), "utf8");
}

function walkArchive(): string[] {
  const root = join(config.vaultPath, ARCHIVE_DIR);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  function walk(dir: string) {
    let entries: any[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".md")) out.push(relative(root, full).split(sep).join("/"));
    }
  }
  walk(root);
  return out;
}

const DISTILL_SYSTEM = `You compile raw captured material (call transcripts, video transcripts, voice notes, meeting notes) into a concise, well-organized wiki entry for a company's internal knowledge base.

Rules:
- Extract the substance: key facts, decisions, objections/questions raised, action items, numbers, names. Drop filler, small talk, and verbatim repetition.
- Write in clear prose + bullet lists, organized under short headings where useful.
- Do NOT invent anything not present in the source. If the source is thin, produce a short entry rather than padding it.
- Output markdown body only — no frontmatter, no preamble like "Here is the summary".`;

export type CompileResult = {
  ranAt: string;
  scanned: number;
  compiled: { source: string; wiki: string; title: string }[];
  skipped: number;
  errors: { source: string; error: string }[];
};

let lastResult: CompileResult | null = null;
export function lastCompileResult(): CompileResult | null { return lastResult; }

// Run the compile now. Idempotent-ish: sources already in state.compiledSources
// are skipped, so re-running only picks up NEW captures since the last run.
export async function runWikiCompile(): Promise<CompileResult> {
  const state = loadState();
  const sources = walkArchive();
  const pending = sources.filter(s => !state.compiledSources.includes(s));
  const compiled: CompileResult["compiled"] = [];
  const errors: CompileResult["errors"] = [];

  for (const rel of pending) {
    const archiveRel = `${ARCHIVE_DIR}/${rel}`;
    try {
      const raw = readVaultFile(archiveRel);
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const fm = fmMatch ? fmMatch[1] : "";
      const body = (fmMatch ? fmMatch[2] : raw).trim();
      const titleMatch = fm.match(/^title:\s*(.+)$/m);
      const sourceTitle = titleMatch ? titleMatch[1].trim() : rel.replace(/\.md$/, "");
      if (!body || body.length < 20) { continue; } // too thin to distill

      const distilled = await llmGenerate(
        `Source: ${sourceTitle}\n\n${body.slice(0, 20_000)}`,
        DISTILL_SYSTEM,
        { profile: "synthesis", temperature: 0.2 },
      );
      const wikiRel = `${WIKI_DIR}/${rel}`;
      const today = new Date().toISOString().slice(0, 10);
      const wikiBody = `---\ntitle: ${sourceTitle}\ncompiled: ${today}\nsource: ${archiveRel}\n---\n\n${distilled.trim()}\n`;
      writeWikiFile(wikiRel, wikiBody);
      compiled.push({ source: archiveRel, wiki: wikiRel, title: sourceTitle });
      state.compiledSources.push(rel);
    } catch (e: any) {
      errors.push({ source: archiveRel, error: e?.message ?? String(e) });
    }
  }

  state.lastCompileAt = new Date().toISOString();
  saveState(state);
  if (compiled.length > 0) void enqueueVaultCommit(`wiki-compile: distilled ${compiled.length} archive entr${compiled.length === 1 ? "y" : "ies"} into ${WIKI_DIR}/`);

  const result: CompileResult = {
    ranAt: new Date().toISOString(),
    scanned: sources.length,
    compiled,
    skipped: pending.length - compiled.length - errors.length,
    errors,
  };
  lastResult = result;
  return result;
}

// ─── Schedulers ───
// Two independent hour-gated tickers, same catch-up pattern as
// lib/reflection.ts: any tick after the target hour runs the job once per
// day, so a server that was down at the exact hour still catches up instead
// of silently skipping the day.

let compileScheduler: NodeJS.Timeout | null = null;
let digestScheduler: NodeJS.Timeout | null = null;
let lastCompileRunDate: string | null = null;
let lastDigestRunDate: string | null = null;

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startWikiCompileScheduler(): void {
  if (compileScheduler) return;
  const HOUR = Number(process.env.NAXION_WIKI_COMPILE_HOUR ?? "3");
  const tick = async () => {
    const now = new Date();
    const today = localDateStr(now);
    if (now.getHours() < HOUR || lastCompileRunDate === today) return;
    if (!getVaultHealth().exists) return;
    // Restart-proof guard: skip if state.json was already touched today.
    try {
      const full = join(config.vaultPath, STATE_PATH);
      if (existsSync(full)) {
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        if (statSync(full).mtimeMs >= midnight) { lastCompileRunDate = today; return; }
      }
    } catch { /* tolerate */ }
    lastCompileRunDate = today;
    console.log(`[wiki-compile] firing daily compile (hour>=${HOUR}, catch-up)`);
    try { await runWikiCompile(); }
    catch (e: any) { console.warn(`[wiki-compile] scheduler run failed: ${e?.message ?? e}`); }
  };
  compileScheduler = setInterval(tick, 10 * 60_000);
  void tick();
}

export function stopWikiCompileScheduler(): void {
  if (compileScheduler) { clearInterval(compileScheduler); compileScheduler = null; }
}

// Later-hour digest — emails/toasts a summary of the most recent compile
// (whether it ran just now or earlier tonight) once per day.
export function startWikiDigestScheduler(): void {
  if (digestScheduler) return;
  const HOUR = Number(process.env.NAXION_WIKI_DIGEST_HOUR ?? "7");
  const tick = async () => {
    const now = new Date();
    const today = localDateStr(now);
    if (now.getHours() < HOUR || lastDigestRunDate === today) return;
    if (!getVaultHealth().exists) return;
    const state = loadState();
    if (state.lastDigestSentDate === today) { lastDigestRunDate = today; return; }
    lastDigestRunDate = today;
    const result = lastResult ?? (state.lastCompileAt ? { ranAt: state.lastCompileAt, scanned: 0, compiled: [], skipped: 0, errors: [] } as CompileResult : null);
    if (!result) return; // nothing to report yet
    try {
      const { notifyUrgent } = await import("./notify.js");
      const lines = result.compiled.length > 0
        ? result.compiled.map(c => `- ${c.title} → ${c.wiki}`).join("\n")
        : "Nothing new in the archive overnight.";
      await notifyUrgent(
        `Wiki compile: ${result.compiled.length} new entr${result.compiled.length === 1 ? "y" : "ies"}`,
        `Overnight second-brain compile summary:\n\n${lines}${result.errors.length > 0 ? `\n\n${result.errors.length} error(s): ${result.errors.map(e => e.source).join(", ")}` : ""}`,
        { actor: "wiki-compile" },
      );
    } catch (e: any) {
      console.warn(`[wiki-compile] digest send failed: ${e?.message ?? e}`);
    }
    state.lastDigestSentDate = today;
    saveState(state);
  };
  digestScheduler = setInterval(tick, 10 * 60_000);
  void tick();
}

export function stopWikiDigestScheduler(): void {
  if (digestScheduler) { clearInterval(digestScheduler); digestScheduler = null; }
}
