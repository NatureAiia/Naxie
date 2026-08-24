// Vault chunking for the pgvector RAG store (vault_chunks table). Walks the
// vault with the SAME traversal rules vault-index.ts already uses (its
// `walk()` generator, exported for exactly this reuse) so this module never
// disagrees with MiniSearch about what counts as vault content.
//
// Splits each note on markdown headings (H1-H6) and caps chunk size by a
// rough char-count heuristic (~4 chars/token), so no single chunk blows the
// embedding model's practical input size. Every chunk is prefixed with the
// note's title so embeddings retain document-level context even once split.

import { readFileSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import { walk, extractTitle } from "./vault-index.js";

export type VaultChunk = {
  path: string;        // vault-relative path, forward slashes
  title: string;
  heading: string | null;
  chunkIndex: number;
  content: string;      // includes the title prefix — this is what gets embedded
};

// ~4 chars/token is a standard rough heuristic for English prose; good enough
// for a chunk-size cap (we're not billing tokens here, just avoiding
// pathologically large embedding inputs).
const CHARS_PER_TOKEN = 4;
const MAX_CHUNK_TOKENS = 1000; // within the 800-1200 target
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

type RawSection = { heading: string | null; body: string };

// Split a note's body into sections at each heading line. Content before the
// first heading (if any) becomes a section with heading=null.
function splitByHeading(body: string): RawSection[] {
  const lines = body.split("\n");
  const sections: RawSection[] = [];
  let current: RawSection = { heading: null, body: "" };
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      if (current.body.trim()) sections.push(current);
      current = { heading: m[2].trim(), body: "" };
    } else {
      current.body += line + "\n";
    }
  }
  if (current.body.trim()) sections.push(current);
  return sections;
}

// Further split an over-long section body into MAX_CHUNK_CHARS-sized pieces,
// breaking on paragraph boundaries where possible so we don't slice mid-
// sentence any more than necessary.
function capSize(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) return [body];
  const paras = body.split(/\n{2,}/);
  const pieces: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur.length + p.length + 2 > MAX_CHUNK_CHARS && cur) {
      pieces.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    // A single paragraph longer than the cap on its own — hard-slice it.
    while (cur.length > MAX_CHUNK_CHARS) {
      pieces.push(cur.slice(0, MAX_CHUNK_CHARS));
      cur = cur.slice(MAX_CHUNK_CHARS);
    }
  }
  if (cur.trim()) pieces.push(cur);
  return pieces.length > 0 ? pieces : [body];
}

// Chunk one note's raw markdown into VaultChunk records, prefixed with the
// note's title (frontmatter `title:` or the H1, falling back to filename).
export function chunkNote(relPath: string, body: string): VaultChunk[] {
  const filename = relPath.split("/").pop() ?? relPath;
  const stem = filename.replace(/\.(md|markdown|txt|canvas)$/i, "");
  const title = extractTitle(body, stem);

  const sections = splitByHeading(body);
  const chunks: VaultChunk[] = [];
  let idx = 0;
  for (const section of sections) {
    const pieces = capSize(section.body.trim());
    for (const piece of pieces) {
      if (!piece.trim()) continue;
      const headingLine = section.heading ? `## ${section.heading}\n\n` : "";
      const content = `# ${title}\n\n${headingLine}${piece.trim()}`.trim();
      chunks.push({ path: relPath, title, heading: section.heading, chunkIndex: idx, content });
      idx += 1;
    }
  }
  // A note with no headings and no body at all (e.g. an empty file after
  // frontmatter) still gets a single title-only chunk so it's not silently
  // dropped from the store.
  if (chunks.length === 0) {
    chunks.push({ path: relPath, title, heading: null, chunkIndex: 0, content: `# ${title}` });
  }
  return chunks;
}

const HIDDEN = new Set([".md", ".markdown", ".txt", ".canvas"]);

// Walk the whole vault and chunk every note. Tolerates unreadable/oversized
// files the same way vault-index.ts's buildIndex does (skip, keep going).
export function chunkVault(vaultRoot: string): VaultChunk[] {
  const chunks: VaultChunk[] = [];
  for (const full of walk(vaultRoot)) {
    try {
      const st = statSync(full);
      if (st.size > 1_000_000) continue;
      const ext = full.slice(full.lastIndexOf(".")).toLowerCase();
      if (!HIDDEN.has(ext)) continue;
      const body = readFileSync(full, "utf8");
      const rel = relative(vaultRoot, full).split(sep).join("/");
      chunks.push(...chunkNote(rel, body));
    } catch { /* tolerate one bad file */ }
  }
  return chunks;
}
