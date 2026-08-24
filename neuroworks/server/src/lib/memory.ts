// Persistent agent memory — the single biggest gap between "stateless tool
// runner" and "the same coworker who talked to you yesterday."
//
// File layout: `_neuroworks/memory/<subject-slug>.jsonl`. Each line is a
// fact: { subject, fact, source?, ts }. Subject = anything the agent wants
// to remember about — a person ("priya"), a project ("rag-pipeline-2026"),
// or a topic ("vault-cache-bug"). Recall is a linear scan; the files stay
// tiny in practice (a few KB each) so a real index is premature.
//
// Honcho / Mem0 / Letta integration is documented (env stubs only) so this
// module can be swapped for a remote provider without changing primitive
// signatures. Local first; remote later.

import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { getPgPool, isPgAvailable } from "./pg-client.js";

const MEMORY_DIR_REL = "_neuroworks/memory";

export type MemoryFact = {
  subject: string;
  fact: string;
  source?: string;
  // Optional calendar anchor (YYYY-MM-DD) for time-bound facts — a meeting,
  // deadline, renewal. When set, the fact surfaces on that day's plan via
  // `datedFactsInWindow`, which is how memory links to the calendar.
  date?: string;
  ts: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function root(): string { return join(config.vaultPath, MEMORY_DIR_REL); }

function slugify(subject: string): string {
  return subject.toLowerCase().trim()
    .replace(/[^a-z0-9 \-_.]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 80) || "general";
}

export function noteFact(args: { subject: string; fact: string; source?: string; date?: string }): MemoryFact {
  const dir = root();
  try { mkdirSync(dir, { recursive: true }); } catch { /* tolerate */ }
  const date = args.date?.trim();
  const rec: MemoryFact = {
    subject: args.subject.trim(),
    fact: args.fact.trim().slice(0, 2000),
    source: args.source ? args.source.slice(0, 200) : undefined,
    date: date && DATE_RE.test(date) ? date : undefined,
    ts: new Date().toISOString(),
  };
  const file = join(dir, slugify(args.subject) + ".jsonl");
  appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
  // Best-effort Supabase mirror (docs/naxie-storage-architecture.md §5, MAG
  // memory). Fire-and-forget: never await, never throw, never delay the
  // local write's return on the remote round trip. Local JSONL stays
  // canonical — this is durability against a wiped machine, not a sync
  // target read back from live.
  void mirrorFactToSupabase(rec).catch(() => { /* best-effort — see mirrorFactToSupabase */ });
  return rec;
}

// Mirror one fact to the `memory_facts` Supabase table (see
// migrations/0002_memory_facts.sql). Skips silently when pgvector/Postgres
// isn't configured or reachable — same degrade-gracefully posture as
// rag.ts's pgvectorSearch. Never throws out of this function.
async function mirrorFactToSupabase(rec: MemoryFact): Promise<void> {
  try {
    if (!(await isPgAvailable())) return;
    const pool = getPgPool();
    if (!pool) return;
    await pool.query(
      `insert into memory_facts (subject, fact, source, fact_date) values ($1, $2, $3, $4)`,
      [rec.subject, rec.fact, rec.source ?? null, rec.date ?? null],
    );
  } catch (e: any) {
    console.debug(`[memory] mirrorFactToSupabase skipped: ${e?.message ?? e}`);
  }
}

// Boot-time wipe-recovery hydration. If local memory storage is empty (fresh
// machine / wiped disk), pull facts back from the Supabase `memory_facts`
// mirror and write them locally. Local stays canonical from then on — this
// is a one-shot recovery, never a live two-way sync (avoids conflict
// resolution entirely, per docs/naxie-storage-architecture.md §5).
export async function hydrateMemoryFromSupabaseIfLocalEmpty(): Promise<number> {
  try {
    const dir = root();
    let hasLocalFacts = false;
    if (existsSync(dir)) {
      try {
        hasLocalFacts = readdirSync(dir).some(f => f.endsWith(".jsonl"));
      } catch { /* tolerate — treat as empty */ }
    }
    if (hasLocalFacts) return 0;
    if (!(await isPgAvailable())) return 0;
    const pool = getPgPool();
    if (!pool) return 0;
    const { rows } = await pool.query(
      `select subject, fact, source, fact_date, created_at from memory_facts order by created_at asc`,
    );
    if (!rows.length) return 0;
    mkdirSync(dir, { recursive: true });
    let restored = 0;
    for (const r of rows) {
      try {
        const rec: MemoryFact = {
          subject: String(r.subject ?? "").trim(),
          fact: String(r.fact ?? "").trim().slice(0, 2000),
          source: r.source ? String(r.source).slice(0, 200) : undefined,
          date: r.fact_date ? String(r.fact_date).slice(0, 10) : undefined,
          ts: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        };
        if (!rec.subject || !rec.fact) continue;
        const file = join(dir, slugify(rec.subject) + ".jsonl");
        appendFileSync(file, JSON.stringify(rec) + "\n", "utf8");
        restored += 1;
      } catch { /* tolerate a single bad row */ }
    }
    if (restored > 0) console.log(`[memory] hydrated ${restored} fact(s) from Supabase mirror (local memory was empty)`);
    return restored;
  } catch (e: any) {
    console.warn(`[memory] hydrateMemoryFromSupabaseIfLocalEmpty failed (non-fatal): ${e?.message ?? e}`);
    return 0;
  }
}

export function recallSubject(subject: string, limit = 20): MemoryFact[] {
  const file = join(root(), slugify(subject) + ".jsonl");
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const out: MemoryFact[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* tolerate */ }
    }
    return out;
  } catch { return []; }
}

// Free-text search across all memory files. Used when the agent isn't sure
// which subject a memory was filed under (e.g. a topic name).
export function searchMemory(query: string, limit = 20): MemoryFact[] {
  const dir = root();
  if (!existsSync(dir)) return [];
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const hits: MemoryFact[] = [];
  let files: string[] = [];
  try { files = readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { return []; }
  for (const f of files) {
    if (hits.length >= limit) break;
    try {
      const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && hits.length < limit; i--) {
        try {
          const rec = JSON.parse(lines[i]) as MemoryFact;
          const blob = (rec.subject + " " + rec.fact + " " + (rec.source ?? "")).toLowerCase();
          if (blob.includes(q)) hits.push(rec);
        } catch { /* tolerate */ }
      }
    } catch { /* tolerate */ }
  }
  return hits;
}

// Calendar link: return every dated fact whose `date` falls in [fromYmd, toYmd]
// (inclusive). This is what folds long-term memory into the daily plan — a
// "remember the Q3 board meeting is on 2026-07-15" fact shows up as a calendar
// commitment on that day, not buried in a JSONL file no one reads. Scans all
// memory files (cheap — they're tiny); skips undated facts.
export function datedFactsInWindow(fromYmd: string, toYmd: string, limit = 50): MemoryFact[] {
  const dir = root();
  if (!existsSync(dir)) return [];
  if (!DATE_RE.test(fromYmd) || !DATE_RE.test(toYmd)) return [];
  const out: MemoryFact[] = [];
  let files: string[] = [];
  try { files = readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { return []; }
  for (const f of files) {
    try {
      const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as MemoryFact;
          if (rec.date && DATE_RE.test(rec.date) && rec.date >= fromYmd && rec.date <= toYmd) out.push(rec);
        } catch { /* tolerate */ }
      }
    } catch { /* tolerate */ }
  }
  return out.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")).slice(0, limit);
}

export function listSubjects(): { subject: string; count: number; lastTs?: string }[] {
  const dir = root();
  if (!existsSync(dir)) return [];
  const out: { subject: string; count: number; lastTs?: string }[] = [];
  let files: string[] = [];
  try { files = readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { return []; }
  for (const f of files) {
    try {
      const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/).filter(Boolean);
      if (!lines.length) continue;
      let subject = f.replace(/\.jsonl$/, "");
      let lastTs: string | undefined;
      try {
        const last = JSON.parse(lines[lines.length - 1]) as MemoryFact;
        subject = last.subject || subject;
        lastTs = last.ts;
      } catch { /* tolerate */ }
      out.push({ subject, count: lines.length, lastTs });
    } catch { /* tolerate */ }
  }
  return out.sort((a, b) => (b.lastTs ?? "").localeCompare(a.lastTs ?? ""));
}
