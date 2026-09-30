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
import { relative, sep, extname } from "node:path";
import { walk, extractTitle, readIndexableText } from "./vault-index.js";
import { extractEntities, extractKeywords, type RagEntities } from "./rag-entities.js";

export type VaultChunk = {
  path: string;        // vault-relative path, forward slashes
  title: string;
  heading: string | null;
  chunkIndex: number;
  content: string;      // includes the title prefix — this is what gets embedded
  entities?: RagEntities;
  keywords?: string[];
  sourceKind?: string;  // md | pdf | docx | xlsx | image | txt ...
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
// Attaches the entity/keyword sidecar used for overlap boosting.
export function chunkNote(relPath: string, body: string, sourceKind = "md"): VaultChunk[] {
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
      chunks.push({
        path: relPath, title, heading: section.heading, chunkIndex: idx, content,
        entities: extractEntities(content), keywords: extractKeywords(content), sourceKind,
      });
      idx += 1;
    }
  }
  // A note with no headings and no body at all (e.g. an empty file after
  // frontmatter) still gets a single title-only chunk so it's not silently
  // dropped from the store.
  if (chunks.length === 0) {
    const content = `# ${title}`;
    chunks.push({
      path: relPath, title, heading: null, chunkIndex: 0, content,
      entities: extractEntities(content), keywords: extractKeywords(content), sourceKind,
    });
  }
  return chunks;
}

const HIDDEN = new Set([".md", ".markdown", ".txt", ".canvas"]);

// Legacy sync walker — markdown/text only, kept for callers that can't
// await (tests, offline paths). Binary docs are covered by chunkVaultAsync.
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
      chunks.push(...chunkNote(rel, body, "md"));
    } catch { /* tolerate one bad file */ }
  }
  return chunks;
}

// Async walker — markdown/text PLUS office docs + images via the shared
// readIndexableText() extractor. Used by the re-embed job so PDFs/DOCXs
// land in vault_chunks instead of being invisible to semantic search.
export async function chunkVaultAsync(vaultRoot: string): Promise<VaultChunk[]> {
  const chunks: VaultChunk[] = [];
  for (const full of walk(vaultRoot)) {
    try {
      const st = statSync(full);
      if (st.size > 25_000_000) continue;
      const rel = relative(vaultRoot, full).split(sep).join("/");
      const filename = full.split(/[\\/]/).pop() ?? rel;
      const stem = filename.replace(/\.[^.]+$/i, "");
      const ext = extname(full).toLowerCase().replace(".", "") || "md";
      const { text: body } = await readIndexableText(full, stem);
      if (!body.trim()) continue;
      chunks.push(...chunkNote(rel, body, ext));
    } catch { /* tolerate one bad file */ }
  }
  return chunks;
}
