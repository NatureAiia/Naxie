// MiniSearch-backed inverted index over the vault's text files.
//
// searchVault() does a linear walk + readFileSync on every cache-miss query.
// At ~150 files that's fine; at the ~1000+ we now have post bulk-import, the
// walk is noticeable (~200-300ms first time, then a 60s TTL cache). This
// module replaces the walk with a one-time index build + per-query O(log N)
// lookups. The index lives in memory and is invalidated by the existing
// vault watcher signals (no separate watcher — we just expose
// `invalidateIndex` and have vault.ts call it from the same coalesced
// timer that busts the legacy cache).
//
// Persistence: not on disk for now — rebuilds take ~1-2s for 1500 markdown
// files, fine for a cold server boot. A future iteration can serialize
// MiniSearch.toJSON() to .naxion/vault-index.json for instant startup.
//
// Falls back to a linear walk if MiniSearch fails to load (defence: an
// extractor crash on one note shouldn't take search down for the rest).

import MiniSearch from "minisearch";
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, sep, extname, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type IndexedDoc = {
  id: string;          // vault-relative path with forward slashes
  path: string;        // same as id (kept for clarity in result handlers)
  title: string;       // h1 if present, else filename stem
  body: string;        // file contents (text + extracted excerpts already inline)
  preview?: string;    // first ~200 chars — used when the file can't be re-read as text (PDF/DOCX)
};

export type IndexSearchHit = {
  path: string;
  line: number;
  preview: string;
  score: number;
};

const HIDDEN_PREFIXES = [".git", ".obsidian", "node_modules"];
const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".canvas"]);
// Binary office docs + images indexed via the doc-extractor/OCR pipeline
// (RIFTS-X DocumentAnalyzer). Walk yields them; buildIndex extracts text.
export const DOC_EXTS = new Set([
  ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".xlsm", ".csv", ".tsv",
  ".pptx", ".ppt", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp",
]);
const INDEXABLE_EXTS = new Set([...TEXT_EXTS, ...DOC_EXTS]);

let index: MiniSearch<IndexedDoc> | null = null;
let buildTimer: NodeJS.Timeout | null = null;
let lastBuiltAt = 0;
let buildPromise: Promise<void> | null = null;
// True after invalidateIndex() until the next successful rebuild. A vault
// write means the on-disk content moved out from under the index, but the
// index itself is still a perfectly good (if slightly outdated) ranked
// index — nulling it outright (the previous behaviour) silently downgraded
// every search to the unranked O(n) linear walk for the whole rebuild
// window, which on a continuously-written vault meant "most of the time".
let stale = false;
// True while the IIFE inside buildIndex is reading vault files. The watcher
// in vault.ts can fire spurious events during this window (subst-mapped
// drives on Windows + fs.watch is a known-flaky combination); if we let
// those events invalidate mid-build, the build completes but is immediately
// nuked before the first search ever gets to use it. The watcher checks
// this flag via isBuildInProgress() and SKIPS invalidation while true.
//
// We also keep a POST-BUILD GRACE WINDOW (the `buildEndedAt + GRACE_MS`
// envelope) — Windows fs.watch on subst-mapped drives can fire events
// for a few hundred ms AFTER the build's last read, and treating those
// as real external writes loops the index back to null. The grace window
// makes the invalidation deaf to such trailing events. Real external
// edits land outside the window and still invalidate as intended.
let buildInProgress = false;
let buildEndedAt = 0;
const BUILD_POST_GRACE_MS = 1500;
export function isBuildInProgress(): boolean {
  if (buildInProgress) return true;
  return Date.now() - buildEndedAt < BUILD_POST_GRACE_MS;
}

// Shared config — newIndex() AND MiniSearch.loadJSON() must use the SAME
// options or load throws ("incompatible"). Factor it out so they can't drift.
const INDEX_OPTIONS = {
  fields: ["title", "body"],
  storeFields: ["path", "title", "preview"],
  searchOptions: {
    // Prefix matching catches "neur" → "neuroworks"; fuzzy 0.2 tolerates
    // one-character typos on words of length ≥5 without exploding the
    // false-positive rate.
    prefix: true,
    fuzzy: 0.2,
    boost: { title: 3 },
    combineWith: "AND" as const,
  },
};

function newIndex(): MiniSearch<IndexedDoc> {
  return new MiniSearch<IndexedDoc>(INDEX_OPTIONS);
}

// Persisted snapshot lives in the state dir (next to executor.json), NOT the
// vault — it's derived data, and on Docker the state dir is its own volume.
// __dirname = server/src/lib → ../../../.naxion at the repo/app root.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSIST_PATH = resolve(__dirname, "../../../.naxion", "vault-index.json");
const PERSIST_VERSION = 1;

// Serialize the live index so a cold boot is instant instead of a 1-2s rebuild.
// Best-effort: a write failure (read-only FS, disk full) must never fail a build.
function persistIndex(idx: MiniSearch<IndexedDoc>, docs: number): void {
  try {
    mkdirSync(dirname(PERSIST_PATH), { recursive: true });
    const payload = JSON.stringify({ v: PERSIST_VERSION, builtAt: Date.now(), docs, index: idx.toJSON() });
    writeFileSync(PERSIST_PATH, payload, "utf8");
  } catch (e: any) {
    console.warn(`[vault-index] persist skipped: ${e?.message ?? e}`);
  }
}

// Load a persisted snapshot into memory for instant cold-start readiness.
// Returns true on success. The caller still kicks a background rebuild to catch
// any edits made while the server was down.
export function loadPersistedIndex(): boolean {
  try {
    if (!existsSync(PERSIST_PATH)) return false;
    const parsed = JSON.parse(readFileSync(PERSIST_PATH, "utf8"));
    if (parsed?.v !== PERSIST_VERSION || !parsed.index) return false;
    index = MiniSearch.loadJS(parsed.index, INDEX_OPTIONS) as MiniSearch<IndexedDoc>;
    lastBuiltAt = Number(parsed.builtAt) || Date.now();
    console.log(`[vault-index] loaded persisted snapshot — ${index.documentCount} docs (will refresh in background)`);
    return true;
  } catch (e: any) {
    console.warn(`[vault-index] persisted snapshot ignored: ${e?.message ?? e}`);
    return false;
  }
}

// Exported so other vault walkers (e.g. lib/rag-chunk.ts's chunker) reuse the
// exact same traversal/filter rules instead of re-implementing them slightly
// differently (which has historically caused "why didn't my note show up"
// bugs when two walkers silently disagreed on hidden-prefix or extension
// filtering).
export function* walk(root: string): Generator<string> {
  let entries: any[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (HIDDEN_PREFIXES.some(p => e.name.startsWith(p))) continue;
    const full = join(root, e.name);
    if (e.isDirectory()) yield* walk(full);
    else {
      const ext = extname(e.name).toLowerCase();
      if (INDEXABLE_EXTS.has(ext)) yield full;
    }
  }
}

// Read a vault file as indexable text. Markdown/text reads directly;
// office docs + images go through the extractor/OCR pipeline. Returns
// { text, title } — never throws (unreadable files yield "").
export async function readIndexableText(full: string, fallbackStem: string): Promise<{ text: string; title: string }> {
  const ext = extname(full).toLowerCase();
  try {
    if (TEXT_EXTS.has(ext)) {
      const body = readFileSync(full, "utf8");
      return { text: body, title: extractTitle(body, fallbackStem) };
    }
    if (DOC_EXTS.has(ext)) {
      const st = statSync(full);
      if (st.size > 25_000_000) return { text: "", title: fallbackStem };
      if ([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp"].includes(ext)) {
        try {
          const { ocrFile } = await import("./ocr.js");
          const ocr = await ocrFile(full, "auto");
          const text = `# ${fallbackStem}\n\n${ocr.text ?? ""}`.trim();
          return { text, title: fallbackStem };
        } catch { return { text: "", title: fallbackStem }; }
      }
      const { extractDocText } = await import("./doc-extractor.js");
      const ex = await extractDocText(full);
      const raw = (ex.text ?? "").trim();
      // Don't index placeholder text ("(binary file…)", "(extraction
      // failed…)") — it pollutes BM25 with tokens every binary shares.
      // Direct-read callers still get the hint; the index just skips it.
      if (ex.kind === "unsupported" || /^\([^()\n]{0,220}\)$/.test(raw)) {
        return { text: "", title: fallbackStem };
      }
      const text = raw ? `# ${fallbackStem}\n\n${raw}` : "";
      return { text, title: fallbackStem };
    }
  } catch { /* tolerate one bad file */ }
  return { text: "", title: fallbackStem };
}

export function extractTitle(body: string, fallback: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 200);
  const fmTitle = body.match(/^title:\s*"?([^"\n]+?)"?\s*$/m);
  if (fmTitle) return fmTitle[1].trim().slice(0, 200);
  return fallback;
}

// Build (or rebuild) the index from scratch. Idempotent — concurrent callers
// share the same in-flight promise so we don't index the vault twice in
// parallel during cold start.
export function buildIndex(vaultRoot: string): Promise<void> {
  if (buildPromise) return buildPromise;
  buildPromise = (async () => {
    // CRITICAL: every code path inside this IIFE must clear buildPromise
    // before returning, OR the guard `if (buildPromise) return buildPromise`
    // at the top would lock out future rebuilds forever. The previous
    // version left buildPromise as a rejected Promise on any unhandled throw
    // (e.g. a transient ENOENT from a watcher race on a deleted file), which
    // looked like "index never settles" externally. Try/finally fixes that.
    //
    // This await MUST be the first statement. Without it, the rest of this
    // function body (which has no other await — every fs call is sync) runs
    // to completion SYNCHRONOUSLY, inside the evaluation of the assignment
    // `buildPromise = (async () => {...})()` below. That means the finally
    // block's `buildPromise = null` executes and is then immediately
    // clobbered back to a resolved promise by that same assignment finishing
    // — buildIndex() never actually returns to a null buildPromise after the
    // first call. The next invalidateIndex() + buildIndex() then hits the
    // `if (buildPromise) return buildPromise` guard forever: the returned
    // promise is already-settled, so callers see it resolve instantly, but
    // the index itself is never rebuilt again for the life of the process —
    // every search silently and permanently degrades to the legacy linear
    // walk after the very first vault write. Forcing a suspend here ensures
    // the outer assignment completes BEFORE any of this runs, so the later
    // finally reset actually sticks.
    await Promise.resolve();
    buildInProgress = true;
    try {
      if (!existsSync(vaultRoot)) return;
      const next = newIndex();
      let count = 0;
      const t0 = Date.now();
      for (const full of walk(vaultRoot)) {
        try {
          const st = statSync(full);
          if (st.size > 25_000_000) continue;
          const rel = relative(vaultRoot, full).split(sep).join("/");
          const filename = full.split(sep).pop() ?? rel;
          const stem = filename.replace(/\.[^.]+$/i, "");
          const { text: body, title } = await readIndexableText(full, stem);
          if (!body.trim()) continue;
          next.add({
            id: rel,
            path: rel,
            title: title.slice(0, 200),
            body: body.slice(0, 100_000),
            preview: body.slice(0, 200),
          });
          count += 1;
        } catch { /* tolerate one bad file */ }
      }
      index = next;
      stale = false;
      lastBuiltAt = Date.now();
      const elapsed = Date.now() - t0;
      console.log(`[vault-index] built — ${count} docs in ${elapsed}ms`);
      // Snapshot to disk so the next cold boot is instant (load + background
      // refresh) instead of a full walk. Synchronous + best-effort.
      persistIndex(next, count);
    } catch (e: any) {
      console.warn(`[vault-index] build failed: ${e?.message ?? e}`);
    } finally {
      buildPromise = null;
      buildInProgress = false;
      buildEndedAt = Date.now();
    }
  })();
  // Debug aid for cold-start diagnosis — uncomment to trace the build sequence.
  // console.log(`[vault-index] kicked off build (existing buildPromise was ${buildPromise === null ? "null" : "set"})`);
  return buildPromise;
}

// Coalesced invalidation — vault.ts watcher fires this whenever an
// observed change is detected. We DON'T rebuild immediately; the next
// search() call triggers a lazy rebuild. This keeps a burst of writes
// from triggering N rebuilds in a row.
export function invalidateIndex(): void {
  // Mark stale, don't discard. The comment below has always said "stale
  // indexes still serve queries" — this used to null `index` outright
  // instead, which contradicted it: every search between a vault write and
  // the next completed rebuild silently fell back to the unranked O(n)
  // linear walk, which on a continuously-written vault (jobs, reflections,
  // backups landing every few minutes) meant "most of the time".
  stale = true;
  if (buildTimer) { clearTimeout(buildTimer); buildTimer = null; }
}

// Returns true if the index exists AND is fresher than a configurable
// max-age. Stale indexes still serve queries (caller decides whether to
// rebuild); this is just a probe used by /api/status surfacing.
export function indexStats(): { ready: boolean; docs: number; ageMs: number; built: boolean; stale: boolean } {
  return {
    ready: index !== null,
    docs: index ? index.documentCount : 0,
    ageMs: index ? Date.now() - lastBuiltAt : -1,
    built: lastBuiltAt > 0,
    stale,
  };
}

// Run a search query against the index. Returns null when the index isn't
// available yet — callers should fall back to the linear walk in that case.
//
// We also synthesise a "line + preview" so the result shape matches the
// existing SearchHit so the caller can substitute one for the other without
// touching downstream rendering. Line is approximated by find-first-match
// on the original body (cheap; under 1ms per result for typical previews).
export function searchIndex(query: string, vaultRoot: string, limit = 50): IndexSearchHit[] | null {
  if (!index) return null;
  const q = query.trim();
  if (!q) return [];
  const raw = index.search(q, { combineWith: "AND" }).slice(0, limit);
  const hits: IndexSearchHit[] = [];
  for (const r of raw) {
    const storedPreview = (r as unknown as { preview?: string }).preview ?? "";
    try {
      const full = join(vaultRoot, r.path);
      const ext = extname(r.path).toLowerCase();
      if (!TEXT_EXTS.has(ext)) {
        // Binary doc — don't re-read bytes as UTF-8; use indexed preview.
        hits.push({ path: r.path, line: 1, preview: (storedPreview || r.title || r.path).slice(0, 200), score: r.score });
        continue;
      }
      const body = readFileSync(full, "utf8");
      const lines = body.split("\n");
      // Find the first line matching any query term.
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      let line = 1, preview = lines[0] ?? "";
      for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        if (terms.some(t => lower.includes(t))) {
          line = i + 1;
          preview = lines[i];
          break;
        }
      }
      hits.push({
        path: r.path,
        line,
        preview: preview.slice(0, 200),
        score: r.score,
      });
    } catch {
      hits.push({ path: r.path, line: 1, preview: r.title ?? r.path, score: r.score });
    }
  }
  return hits;
}
