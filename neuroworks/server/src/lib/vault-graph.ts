// Vault graph — extracted from routes/brain.ts's GET /api/brain/graph handler
// (docs/naxie-storage-architecture.md §6, MAG — graph) so lib/rag.ts can reuse
// the same wikilink+tag graph for retrieval-time neighbor expansion, without
// routes/brain.ts's HTTP handler being the only caller.
//
// routes/brain.ts's handler is now a thin wrapper around buildVaultGraph() —
// same response shape ({ nodes, links, docCount }), unchanged behavior.
//
// Walk + parsing kept intentionally simple (regex over raw markdown, no
// dependency on the search index), matching the original comment on the
// route this was extracted from.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { config } from "../config.js";
import { mergeGraphifyLinks } from "./graphify-import.js";

const GRAPH_HIDDEN_PREFIXES = [".git", ".obsidian", "node_modules"];
const GRAPH_TEXT_EXTS = new Set([".md", ".markdown"]);

type GraphDoc = { path: string; title: string; tags: string[]; body: string };

export type VaultGraphNode = { id: string; label: string; group: string; kind: "note" | "tag" };
export type VaultGraphLink = { source: string; target: string };
export type VaultGraph = { nodes: VaultGraphNode[]; links: VaultGraphLink[]; docCount: number };

function* walkGraphVault(root: string): Generator<string> {
  let entries: any[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (GRAPH_HIDDEN_PREFIXES.some(p => e.name.startsWith(p))) continue;
    const full = join(root, e.name);
    if (e.isDirectory()) yield* walkGraphVault(full);
    else if (GRAPH_TEXT_EXTS.has(extname(e.name).toLowerCase())) yield full;
  }
}

function parseFrontmatterTags(body: string): string[] {
  const fm = body.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const tags: string[] = [];
  const inline = fm[1].match(/^tags:\s*\[([^\]]*)\]/m);
  if (inline) {
    for (const t of inline[1].split(",")) {
      const v = t.trim().replace(/^["']|["']$/g, "");
      if (v) tags.push(v);
    }
    return tags;
  }
  const list = fm[1].match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m);
  if (list) {
    for (const line of list[1].split("\n")) {
      const m = line.match(/-\s*(.+)/);
      if (m) { const v = m[1].trim().replace(/^["']|["']$/g, ""); if (v) tags.push(v); }
    }
  }
  return tags;
}

// Build the vault as a node graph (Obsidian-style): one node per note, plus a
// node per frontmatter tag, linked by [[wikilinks]] and shared tags.
// `limit` caps how many documents get walked (same default/bounds the
// original route handler used).
export function buildVaultGraph(limit = 1500): VaultGraph {
  const vaultRoot = resolve(config.vaultPath);
  const docs: GraphDoc[] = [];
  for (const full of walkGraphVault(vaultRoot)) {
    if (docs.length >= limit) break;
    let body: string;
    try {
      if (statSync(full).size > 500_000) continue;
      body = readFileSync(full, "utf8");
    } catch { continue; }
    const rel = relative(vaultRoot, full).split(sep).join("/");
    const stem = basename(full).replace(/\.(md|markdown)$/i, "");
    const h1 = body.match(/^#\s+(.+)$/m);
    const fmTitle = body.match(/^title:\s*"?([^"\n]+?)"?\s*$/m);
    const title = (h1?.[1] ?? fmTitle?.[1] ?? stem).trim().slice(0, 120);
    docs.push({ path: rel, title, tags: parseFrontmatterTags(body), body });
  }

  // Resolve [[wikilinks]] by filename stem or extracted title (Obsidian's
  // own resolution order), case-insensitively.
  const byKey = new Map<string, string>();
  for (const d of docs) {
    const stem = basename(d.path).replace(/\.(md|markdown)$/i, "");
    byKey.set(stem.toLowerCase(), d.path);
    byKey.set(d.title.toLowerCase(), d.path);
  }

  const nodes: VaultGraphNode[] = [];
  const links: VaultGraphLink[] = [];
  for (const d of docs) {
    nodes.push({ id: d.path, label: d.title, group: d.path.split("/")[0] || "root", kind: "note" });
  }

  const tagNodeIds = new Set<string>();
  const linkSeen = new Set<string>();
  for (const d of docs) {
    const linkRe = /\[\[([^\]|#]+)/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(d.body))) {
      const target = byKey.get(m[1].trim().toLowerCase());
      if (target && target !== d.path) {
        const key = `${d.path} ${target}`;
        if (!linkSeen.has(key)) { linkSeen.add(key); links.push({ source: d.path, target }); }
      }
    }
    for (const t of d.tags) {
      const tagId = `#${t}`;
      if (!tagNodeIds.has(tagId)) {
        tagNodeIds.add(tagId);
        nodes.push({ id: tagId, label: t, group: "tag", kind: "tag" });
      }
      links.push({ source: d.path, target: tagId });
    }
  }

  return { nodes, links, docCount: docs.length };
}

// Cache the built graph briefly — graphNeighbors() is meant to be called once
// per RAG hit (potentially several times per chat turn), and rebuilding the
// full wikilink graph from disk on every call would be wasteful. Same TTL
// posture as vault.ts's own search cache (60s) rather than a full mtime-watch
// (the vault-write hooks that invalidate MiniSearch/CAG don't reach this
// module, and a brief staleness window here is harmless — this is best-effort
// "related notes" annotation, not a source of truth).
const GRAPH_CACHE_TTL_MS = 60_000;
let cachedGraph: VaultGraph | null = null;
let cachedAt = 0;

// Internal only — graphNeighbors() consumes this, buildVaultGraph()'s own
// exported output (routes/brain.ts's /api/brain/graph) stays untouched by the
// graphify merge below, preserving that route's exact prior response shape.
function getCachedGraph(): VaultGraph {
  const now = Date.now();
  if (cachedGraph && now - cachedAt < GRAPH_CACHE_TTL_MS) return cachedGraph;
  const base = buildVaultGraph();
  cachedGraph = mergeGraphifyLinks(base);
  cachedAt = now;
  return cachedGraph;
}

// Invalidate the cached graph — exposed for callers (e.g. graphify-import.ts)
// that merge additional links into the graph and want the next
// graphNeighbors() call to see them without waiting out the TTL.
export function invalidateVaultGraphCache(): void {
  cachedGraph = null;
  cachedAt = 0;
}

// Adjacency lookup over the graph buildVaultGraph() produces. Returns the
// labels of vault-note neighbors within `hops` hops of `path` (tag nodes are
// traversed through but not returned, since a "related note" annotation
// should point at notes, not tags).
export function graphNeighbors(path: string, hops = 1): string[] {
  const graph = getCachedGraph();
  const adjacency = new Map<string, Set<string>>();
  for (const l of graph.links) {
    if (!adjacency.has(l.source)) adjacency.set(l.source, new Set());
    if (!adjacency.has(l.target)) adjacency.set(l.target, new Set());
    adjacency.get(l.source)!.add(l.target);
    adjacency.get(l.target)!.add(l.source);
  }
  const nodesById = new Map(graph.nodes.map(n => [n.id, n]));

  let frontier = new Set<string>([path]);
  const visited = new Set<string>([path]);
  for (let h = 0; h < Math.max(1, hops); h++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!visited.has(neighbor)) { visited.add(neighbor); next.add(neighbor); }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  visited.delete(path);

  const out: string[] = [];
  for (const id of visited) {
    const node = nodesById.get(id);
    if (node && node.kind === "note") out.push(node.label);
  }
  return out;
}
