// A deterministic research-to-report pipeline. Ported from
// AI-Institute-Africa/neuroworks.
//
// WHY THIS EXISTS
// A "give me a report on X" ask used to run as a free-form agent plan: the
// planner picked tools, usually landed on research.deep, and research.deep
// handed a large evidence catalog to ONE local LLM call with a hard time cap.
// When it blew the cap — which it did repeatedly upstream — the entire
// report was lost and the operator got a list of links instead.
//
// The failure is structural, not a tuning problem. One unbounded call
// producing one monolithic document has no partial-credit mode: it either
// finishes or there is nothing.
//
// So this pipeline fixes the SHAPE:
//   1. RETRIEVE INTERNAL EVIDENCE   deterministic, no model involved
//   2. RETRIEVE EXTERNAL EVIDENCE   bounded search + the strict source validator
//   3. DRAFT SECTION BY SECTION     one small bounded call per section
//   4. CHECK CITATIONS              every claim-bearing section must cite
//   5. ASSEMBLE + RECORD PROVENANCE
//
// Step 3 is the important one. Each section is a separate short call over
// only the evidence that section needs, so:
//   • no single call has to chew through the whole catalog,
//   • a section that times out becomes a NAMED GAP in an otherwise complete
//     report rather than taking the report with it,
//   • and the section list is declared up front, so the output has the same
//     shape every run and can be diffed, graded and scheduled.
//
// Nothing here publishes or sends. Callers own delivery and approval.
//
// Naxie-specific note: upstream's gatherInternalEvidence() called
// searchVault(topic, 24, { excludeAgentCaptures: true }) — Naxie's
// searchVault(query, limit) has no third options argument, so that filter is
// dropped here rather than faked.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { searchVault, readVaultFile } from "./vault.js";
import { truncateWithMarker } from "./truncate.js";

export type SectionSpec = {
  /** Stable id, used for gap reporting. */
  id: string;
  /** The `## heading` written into the document. */
  heading: string;
  /** What this section must contain — becomes the per-section instruction. */
  brief: string;
  /** Which evidence pool this section is drafted from. */
  evidence: "internal" | "external" | "both";
  /**
   * Does this section make factual claims that must be cited? A summary
   * section synthesises cited sections rather than citing directly, so
   * demanding citations there produces noise, not rigour.
   */
  needsCitations?: boolean;
  /**
   * Show this section the sections already written, even though it still
   * needs its own citations — for a schema whose sections are independent
   * PEERS rather than a summary-over-detail hierarchy (e.g. 3 separate
   * solution proposals), so section 2 knows not to repeat section 1's
   * problem/solution.
   */
  seePriorSections?: boolean;
};

export type ReportSchema = {
  id: string;
  /** One-line description of the deliverable, used in the system prompt. */
  purpose: string;
  sections: SectionSpec[];
  /**
   * Guards a citation-EXEMPT section (a Summary, typically — needsCitations:
   * false, meant to synthesise rather than quote) against independently
   * asserting a claim the sections it's supposed to summarise don't actually
   * support. When every section named in `requiredIds` ends up unavailable
   * (failed OR withheld), the section named `summaryId` is withheld too,
   * through the same withholding mechanism every other section already uses.
   */
  summaryGuard?: { summaryId: string; requiredIds: string[] };
};

export type InternalDoc = {
  path: string;
  text: string;
  /** Last modified, ISO date — freshness is part of provenance. */
  modified?: string;
  /** True for `_knowledge/`, `_company/`, `2-Permanent/` etc. */
  curated: boolean;
  /** Set when the text came from an extraction sidecar rather than the file itself. */
  extractedFrom?: string;
  /**
   * Other vault paths holding the same content. The vault mirrors notes (a
   * download re-imported, a note promoted without the original being
   * removed), so the same text can occupy several of the few slots a report
   * has for internal evidence. Only the best-ranked copy is kept; the rest
   * are recorded here so the duplication stays visible.
   */
  mirrors?: string[];
};

export type ExternalDoc = {
  n: number;
  url: string;
  title: string;
  text: string;
  score?: number;
};

export type SectionResult = {
  id: string;
  heading: string;
  text: string;
  ok: boolean;
  /** Why this section is a gap rather than prose. */
  gap?: string;
  citations: string[];
  elapsedMs: number;
  /**
   * Set when the section was WRITTEN but must not be published as prose —
   * it made claims with no citation, or named sources that were never
   * fetched. The text is kept (useful for debugging the run) but the
   * assembled report shows the reason in its place.
   */
  withheld?: string;
};

export type ReportResult = {
  markdown: string;
  sections: SectionResult[];
  internal: InternalDoc[];
  external: ExternalDoc[];
  /** Sections that failed or came back uncited — the honest quality signal. */
  gaps: { id: string; reason: string }[];
  stats: {
    internalDocs: number;
    externalSources: number;
    externalDropped: number;
    sectionsWritten: number;
    sectionsFailed: number;
    uncitedSections: number;
    /** Sections written but not published — uncited, or naming unfetched sources. */
    withheldSections: number;
    elapsedMs: number;
  };
};

/** Curated trees outrank scratch space when only a few docs can be read. */
const CURATED_RE = /^(?:_knowledge\/(?!downloads\/)|_company\/|2-Permanent\/|1-Literature\/|_governance\/)/i;

/**
 * Per-section budget. A section is ~200 words, so a HEALTHY one lands in
 * 10-30s and never comes near this. 150s fits one stalled provider-failover
 * attempt (60s of silence) plus a healthy retry, with room for a second
 * failover — a tighter budget was measured to expire mid-failover and record
 * every section as a gap.
 */
const SECTION_TIMEOUT_MS = Number(process.env.NAXION_REPORT_SECTION_TIMEOUT_MS ?? "150000");
/** Total budget. A scheduled report must land, not run until someone notices. */
const TOTAL_TIMEOUT_MS = Number(process.env.NAXION_REPORT_TOTAL_TIMEOUT_MS ?? String(18 * 60_000));

/**
 * How much evidence, and how much already-written report, a single
 * section's prompt may carry — in characters (~4 per token).
 *
 * Sized against NAXION_OLLAMA_NUM_CTX so a local model's window isn't
 * silently overflowed: an overflowing prompt is truncated by Ollama from the
 * LEFT, which deletes the numbered source list, and the model writes a
 * section it had no sources for — reading like a model that won't cite
 * rather than a prompt that lost its sources before the model saw them.
 * Tune DOWN to match a small local window, back up when a large-context
 * model is available. An explicit env var always wins.
 */
const NUM_CTX = Math.max(1024, Number(process.env.NAXION_OLLAMA_NUM_CTX ?? "4096"));
const PROMPT_CHAR_BUDGET = Math.max(3_000, NUM_CTX * 4 - 650 * 4 - 2_500);
const EVIDENCE_CHARS = Math.max(2_000, Number(
  process.env.NAXION_REPORT_EVIDENCE_CHARS ?? String(Math.min(24_000, Math.floor(PROMPT_CHAR_BUDGET * 0.75))),
));
const PRIOR_CONTEXT_CHARS = Math.max(1_000, Number(
  process.env.NAXION_REPORT_PRIOR_CHARS ?? String(Math.min(6_000, Math.floor(PROMPT_CHAR_BUDGET * 0.25))),
));
/** Governance is prepended to EVERY section's system prompt and was unbounded. */
const SYSTEM_PREFIX_CHARS = 2_000;

// ── The standard schemas ─────────────────────────────────────────────────────

export const GENERIC_REPORT: ReportSchema = {
  id: "generic-report",
  purpose: "a cited research report for a decision-maker",
  sections: [
    { id: "summary", heading: "Summary", brief: "3-5 sentences: what the evidence shows and the single thing to act on first. Written for someone who will read nothing else.", evidence: "both", needsCitations: false },
    { id: "internal", heading: "What we already know", brief: "What the organisation's OWN notes and documents say about this. Cite the vault path for every point. If the vault has nothing on it, say exactly that in one line — do not fill the space.", evidence: "internal" },
    { id: "external", heading: "External landscape", brief: "What the outside sources establish, with a numbered citation on every claim. Prefer specifics (names, numbers, dates) over characterisations.", evidence: "external" },
    { id: "gaps", heading: "What we could not establish", brief: "Questions the evidence does not answer, and what source would answer them. Be concrete; this section is more useful than a confident guess.", evidence: "both", needsCitations: false },
    { id: "recommendation", heading: "Recommendation", brief: "2-4 concrete next actions, each traceable to something above. No generic advice.", evidence: "both", needsCitations: false },
  ],
};

/** Build a schema from a plain list of headings (the `sections` template input). */
export function schemaFromHeadings(headings: string[], purpose: string): ReportSchema {
  const clean = headings.map(h => h.replace(/^#+\s*/, "").trim()).filter(Boolean);
  if (!clean.length) return GENERIC_REPORT;
  return {
    id: "custom",
    purpose,
    sections: clean.map((h, i) => ({
      id: h.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `section-${i + 1}`,
      heading: h,
      // A summary section is synthesis, so it is exempted from the citation
      // check; everything else is treated as claim-bearing.
      brief: /^(summary|executive summary|overview|tl;?dr)$/i.test(h)
        ? "3-5 sentences summarising the whole report and what to act on first."
        : `Write the "${h}" section of the report, grounded strictly in the supplied evidence and citing it.`,
      evidence: "both",
      needsCitations: !/^(summary|executive summary|overview|tl;?dr|recommendation|recommendations|next steps|watchlist)$/i.test(h),
    })),
  };
}

// ── Step 1: internal evidence ────────────────────────────────────────────────

/**
 * Read the org's own material on a topic, curated trees first.
 *
 * Deterministic: a keyword search and a bounded read, no model deciding what
 * to look at. The returned docs carry their provenance (path, freshness,
 * whether the text came from an extraction sidecar) so the report can
 * attribute them and the reader can judge how stale the basis is.
 */
export function gatherInternalEvidence(topic: string, opts: {
  maxDocs?: number; charsPerDoc?: number; extraPaths?: string[];
} = {}): InternalDoc[] {
  const maxDocs = Math.max(1, opts.maxDocs ?? 8);
  const charsPerDoc = Math.max(500, opts.charsPerDoc ?? 4000);
  const out: InternalDoc[] = [];
  const seen = new Set<string>();
  // Content hash → the doc that claimed it, so a mirrored note is attributed
  // to one path instead of consuming several evidence slots.
  const byContent = new Map<string, InternalDoc>();

  const push = (path: string) => {
    if (out.length >= maxDocs || seen.has(path)) return;
    seen.add(path);
    try {
      const body = readVaultFile(path);
      if (!body || !body.trim()) return;
      // A vault doc longer than charsPerDoc used to enter the pool as a bare
      // head slice, so a section prompt built from it read as a complete
      // document that simply had nothing to say about the back half. Mark
      // the cut; the marker is paid for out of charsPerDoc, not added to it.
      const clipped = body.slice(0, charsPerDoc);
      const text = truncateWithMarker(body, charsPerDoc);

      // Frontmatter and whitespace differ between mirrored copies while the
      // substance is identical, so both are stripped before hashing. Hash
      // the UNMARKED slice: the marker names the document's own length, so
      // two mirrored copies that differ in trailing bytes would otherwise
      // hash apart and consume two evidence slots instead of one.
      const fingerprint = createHash("sha1")
        .update(clipped.replace(/^---[\s\S]*?---\s*/, "").replace(/\s+/g, " ").trim().toLowerCase())
        .digest("hex");
      const first = byContent.get(fingerprint);
      if (first) {
        first.mirrors = [...(first.mirrors ?? []), path];
        return;
      }

      let modified: string | undefined;
      try { modified = new Date(statSync(resolve(config.vaultPath, path)).mtimeMs).toISOString().slice(0, 10); }
      catch { /* freshness is nice to have, not required */ }

      const doc: InternalDoc = {
        path,
        text,
        curated: CURATED_RE.test(path),
        ...(modified ? { modified } : {}),
        ...(/\.extracted\.md$/i.test(path) ? { extractedFrom: path.replace(/\.extracted\.md$/i, "") } : {}),
      };
      byContent.set(fingerprint, doc);
      out.push(doc);
    } catch { /* an unreadable hit is not fatal */ }
  };

  // Caller-supplied paths are RECENT (inbox notes, session transcripts),
  // which is not the same as relevant. Give them a bounded share of the pool
  // rather than the front of it — enough that "signals from our own usage"
  // still has material, not so much that recency displaces the subject. The
  // remainder are appended after the ranked hits, filling space only when
  // the topic search came up short.
  const extra = opts.extraPaths ?? [];
  const extraBudget = Math.max(1, Math.floor(maxDocs / 3));
  for (const p of extra.slice(0, extraBudget)) push(p);

  try {
    const hits = searchVault(topic, 24);
    // Curated before scratch, preserving relevance order within each group.
    const ranked = [...hits].sort((a, b) => (CURATED_RE.test(a.path) ? 0 : 1) - (CURATED_RE.test(b.path) ? 0 : 1));
    for (const h of ranked) push(h.path);
  } catch { /* a vault with no index still produces a web-only report */ }

  for (const p of extra.slice(extraBudget)) push(p);

  return out;
}

// ── Step 2: external evidence ────────────────────────────────────────────────

/**
 * A bounded web pass: a fixed number of queries, a fixed number of fetches
 * per query, then the STRICT source validator. "Bounded" is the whole
 * point — the cost is known before the call, and only sources that pass
 * validation reach the drafter. Anything dropped is counted, not silently
 * lost.
 */
export async function gatherExternalEvidence(queries: string[], opts: {
  perQuery?: number; maxSources?: number; charsPerSource?: number;
  push?: (m: string) => void;
} = {}): Promise<{ kept: ExternalDoc[]; dropped: number; reasons: Record<string, number> }> {
  const push = opts.push ?? (() => {});
  const perQuery = Math.max(1, opts.perQuery ?? 4);
  const maxSources = Math.max(1, opts.maxSources ?? 8);
  const charsPerSource = Math.max(500, opts.charsPerSource ?? 5000);
  const qs = queries.map(q => q.trim()).filter(Boolean).slice(0, 4);
  if (!qs.length) return { kept: [], dropped: 0, reasons: {} };

  const { searchWeb, smartFetch } = await import("./web-client.js");
  const { validateSources } = await import("./source-validator.js");

  const hits: { title: string; url: string; snippet: string }[] = [];
  const seenUrl = new Set<string>();
  for (const q of qs) {
    try {
      const r = await searchWeb(q, perQuery);
      for (const h of r.results.slice(0, perQuery)) {
        if (!h.url || seenUrl.has(h.url)) continue;
        seenUrl.add(h.url);
        hits.push({ title: h.title ?? h.url, url: h.url, snippet: (h as any).snippet ?? "" });
      }
    } catch (e: any) { push(`Search for "${q}" failed: ${String(e?.message ?? e).slice(0, 80)}`); }
  }
  if (!hits.length) { push("No web results — the report will run on internal evidence only."); return { kept: [], dropped: 0, reasons: {} }; }

  const fetched = await Promise.all(hits.slice(0, maxSources * 2).map(async h => {
    try {
      const r = await smartFetch(h.url, { maxBytes: 80_000, timeoutMs: 8_000 });
      return { url: h.url, title: r.title ?? h.title, text: r.text.slice(0, charsPerSource), ok: true, status: r.status, engine: r.engine, usedBrowser: r.usedBrowser };
    } catch (e: any) {
      return { url: h.url, title: h.title, text: "", ok: false, error: String(e?.message ?? e), engine: "unknown" as const };
    }
  }));

  const validation = validateSources(
    fetched.map(f => ({ url: f.url, title: f.title, text: f.text, ok: f.ok, error: (f as any).error, status: (f as any).status, engine: (f.engine ?? "unknown") as any, usedBrowser: (f as any).usedBrowser })),
    { mode: "strict", query: qs.join(" ") },
  );

  const kept: ExternalDoc[] = validation.kept.slice(0, maxSources).map((f, i) => ({
    n: i + 1, url: f.url, title: f.title ?? f.url, text: String(f.text).slice(0, charsPerSource), score: f.score,
  }));
  push(`Web pass: ${kept.length} source${kept.length === 1 ? "" : "s"} kept, ${validation.dropped.length} dropped by the validator.`);
  return { kept, dropped: validation.dropped.length, reasons: validation.summary.reasons };
}

/**
 * Turn a topic into a few INDUSTRY-language search queries. Deliberately
 * does not search the topic verbatim when it reads like an internal brief:
 * private product names return nothing. Callers with better queries pass
 * them in.
 */
export function deriveQueries(topic: string): string[] {
  const clean = topic.replace(/\s+/g, " ").trim();
  const short = clean.length > 120 ? clean.slice(0, 120) : clean;
  const out = [short];
  // A second, recency-biased query catches the "what changed lately" angle
  // that a bare topic query misses.
  out.push(`${short} 2026 latest developments`);
  return out;
}

// ── Step 3: draft one section ────────────────────────────────────────────────

/**
 * Race a section's generation against its budget — and CANCEL the loser.
 *
 * Racing alone was not enough: Promise.race settles this promise but leaves
 * the LLM call running (socket open, tokens still generating, provider
 * concurrency still consumed). Sections run serially, so an abandoned call
 * from an earlier section can still be in flight when the next one starts.
 * The caller hands the generate function an AbortSignal, so a section that
 * runs out of budget takes its call down with it.
 */
export function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, what: string): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, rej) => {
    timer = setTimeout(() => {
      ctrl.abort();
      rej(new Error(`${what} exceeded ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([run(ctrl.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Tidy one finished section, deterministically — fixing things a schema
 * already asks for in words and a small local model does anyway: a literal
 * `[Vault:path]` example typed instead of a real citation, the brief echoed
 * back as body text, a duplicated heading, a bare citation marker alone on
 * its own line. Run AFTER the citation check, never before — extractCitations
 * needs the raw markers, and rewriting them first would change what the gate
 * sees.
 */
export function cleanSectionText(text: string, heading?: string): string {
  let out = String(text ?? "");

  // A placeholder citation resolves to nothing, so say that rather than
  // printing an instruction as though it were a source.
  out = out.replace(/\[vault:([^\]]*)\]/gi, (m, inner: string) =>
    isPlaceholderCitation(inner) ? "(source not in evidence)" : m);
  out = out.replace(/\[(?:the\s+)?source\]/gi, "(source not in evidence)");
  // `[N]` as the literal letter N, not a number.
  out = out.replace(/\[N\]/g, "(source not in evidence)");
  // A citation marker alone on its own line cites nothing in particular.
  out = out.replace(/^\s*\[\d{1,2}\]\s*$/gm, "");

  // The brief, handed back as prose. Anchored on the instruction voice these
  // schemas use, so ordinary sentences are not caught.
  out = out.replace(/^.*\bWhat is WANTED is\b.*$/gim, "");
  out = out.replace(/^\s*For each,? we will name the gap it fills.*$/gim, "");
  out = out.replace(/^\s*(?:Do not|Never) (?:repeat|write|invent)\b.*$/gim, "");

  // `## Heading` followed by the same heading again one level down.
  if (heading) {
    const h = heading.trim().toLowerCase();
    out = out.replace(/^\s*#{1,6}\s*(.+?)\s*$/m, (line, captured: string) =>
      captured.trim().toLowerCase() === h ? "" : line);
  }

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function isPlaceholderCitation(raw: string): boolean {
  const v = raw.trim().toLowerCase().replace(/^vault:/, "").replace(/[<>[\]{}]/g, "").trim();
  return v === "" || v === "path" || v === "n" || v === "source" || v === "the source"
    || v === "url" || v === "vault" || v === "vault:path" || v === "filename" || v === "doc";
}

/** The gate that a placeholder used to satisfy. */
export function extractCitations(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[vault:([^\]]+)\]/gi)) {
    const v = m[1].trim();
    if (isPlaceholderCitation(v)) continue;
    out.add(`vault:${v}`);
  }
  for (const m of text.matchAll(/\[(\d{1,2})\]/g)) out.add(m[1]);
  return [...out];
}

/**
 * Compare URLs by what identifies a resource, not by how it was typed.
 * Scheme, `www.`, a trailing slash and case differ freely between the
 * evidence and the model's prose without meaning anything.
 */
function urlKeyOf(u: string): string {
  return u.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[).,;'"]+$/, "")
    .replace(/\/+$/, "");
}

const URL_RE = /https?:\/\/[^\s)>\]"'`]+/gi;

/**
 * Every URL the run actually saw — the source list AND any link inside the
 * gathered text. A section may legitimately repeat a link it read inside a
 * note or a fetched page, so the bar is "this appeared in the evidence", not
 * "this was one of the search hits".
 */
function evidenceUrlKeys(internal: InternalDoc[], external: ExternalDoc[]): Set<string> {
  const keys = new Set<string>();
  for (const d of external) {
    if (d.url) keys.add(urlKeyOf(d.url));
    for (const m of d.text.matchAll(URL_RE)) keys.add(urlKeyOf(m[0]));
  }
  for (const d of internal) {
    for (const m of d.text.matchAll(URL_RE)) keys.add(urlKeyOf(m[0]));
  }
  return keys;
}

/**
 * Links a section states that the run never fetched or read. A fabricated
 * URL is the most costly kind of error a research report can make — it is
 * the part a reader acts on, and it looks exactly like a real one.
 */
export function unsupportedUrls(text: string, allowed: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const key = urlKeyOf(m[0]);
    if (!key || allowed.has(key)) continue;
    // A deeper path UNDER a URL the run read is supported — the evidence
    // established that resource. Matching on the host alone would not be:
    // github.com is the host of every repository that exists and every one
    // that does not.
    if ([...allowed].some(a => key.startsWith(`${a}/`))) continue;
    out.add(m[0].replace(/[).,;'"]+$/, ""));
  }
  return [...out];
}

function internalBlock(docs: InternalDoc[]): string {
  if (!docs.length) return "## Our own notes\n_(the vault has nothing on this topic)_";
  return "## Our own notes and documents\n" +
    "These are the organisation's OWN material. They outrank any outside source on anything about this organisation, its products, people, policies or history. Cite them as [vault:path].\n\n" +
    docs.map(d =>
      `### [vault:${d.path}]${d.modified ? ` _(modified ${d.modified})_` : ""}${d.curated ? " _(curated)_" : ""}` +
      `${d.extractedFrom ? ` _(text extracted from ${d.extractedFrom})_` : ""}` +
      // Stated so the model does not read three copies of one note as three
      // independent confirmations of the same point.
      `${d.mirrors?.length ? ` _(also mirrored at ${d.mirrors.length} other path${d.mirrors.length === 1 ? "" : "s"} — one source, not several)_` : ""}\n${d.text}`,
    ).join("\n\n");
}

function externalBlock(docs: ExternalDoc[]): string {
  if (!docs.length) return "## Outside sources\n_(no source survived validation)_";
  return "## Outside sources (validated)\n" +
    "Cite these by number, e.g. [2].\n\n" +
    docs.map(d => `### [${d.n}] ${d.title}\n${d.url}\n\n${d.text}`).join("\n\n");
}

// ── The pipeline ─────────────────────────────────────────────────────────────

export type RunReportOptions = {
  schema: ReportSchema;
  topic: string;
  internal: InternalDoc[];
  external: ExternalDoc[];
  externalDropped?: number;
  /**
   * The LLM call. Injected so this module is testable without a model.
   * `firstTokenMs` is the section's own budget, handed down so the model
   * layer's own first-token clock cannot fire first and report a
   * cancellation for a section this pipeline would still have waited for.
   */
  generate: (prompt: string, system: string, opts: { maxTokens: number; signal?: AbortSignal; firstTokenMs?: number }) => Promise<string>;
  /** Extra rules prepended to every section's system prompt (governance). */
  systemPrefix?: string;
  /**
   * A constant block of CONSTRAINTS on the answer — not evidence. Kept out
   * of the evidence pool deliberately: in the pool it becomes citable as the
   * source of a problem, and it competes for the same characters as the
   * real documents. Its length is SUBTRACTED from the evidence budget below
   * rather than growing the prompt (which would overflow the window and
   * truncate the numbered source list from the left).
   */
  constraintsBlock?: string;
  push?: (m: string) => void;
  /** Overrides, mainly for tests. */
  sectionTimeoutMs?: number;
  totalTimeoutMs?: number;
};

/**
 * TURN A GRADED REPORT INTO SOMETHING A PERSON READS.
 *
 * `[vault:path]` is the convention every report template is told to use and
 * `extractCitations` parses it back out to decide which sections went
 * uncited, so the marker has to survive all the way through grading. It
 * must not survive to the reader. MUST BE CALLED AFTER GRADING, never
 * before.
 *
 * Also fixes things a small local model does that no amount of further
 * instruction stops, and which are mechanical enough to decide here:
 * `Small Effort (S)` where the brief asked for `S`; a bare `Existing
 * coverage:` with nothing after it; immediate word repetition.
 */
export function renderReportForReader(
  body: string,
  internal: InternalDoc[],
  external: ExternalDoc[],
): string {
  let out = String(body ?? "");

  // Internal docs get numbers continuing after the external ones, so a
  // single Sources list covers both and `[N]` means one thing everywhere.
  const firstInternalN = external.reduce((m, d) => Math.max(m, Number(d.n) || 0), 0) + 1;
  const numberFor = new Map<string, number>();
  internal.forEach((d, i) => numberFor.set(normalisePath(d.path), firstInternalN + i));

  const cited = new Set<number>();
  out = out.replace(/\[vault:([^\]]+)\]/gi, (_m, raw: string) => {
    const p = normalisePath(String(raw).trim());
    const n = numberFor.get(p)
      // A path cited with a different prefix or casing than the doc carries.
      ?? [...numberFor.entries()].find(([k]) => k.endsWith(p) || p.endsWith(k))?.[1];
    if (!n) {
      // Cited something that is not in the evidence. Say so rather than
      // printing a marker that resolves to nothing.
      return "(source not in evidence)";
    }
    cited.add(n);
    return `[${n}]`;
  });

  // "The [3] document outlines..." reads worse than the marker did. A
  // citation belongs after the clause, not inside the noun phrase.
  out = out.replace(/\bThe \[(\d+)\] document\b/gi, "The source document [$1]");
  out = out.replace(/\bthe \[(\d+)\] document\b/g, "the source document [$1]");

  // Effort: the brief asks for S/M/L and gets "Small Effort (S)".
  out = out.replace(/^(\s*(?:\*\*)?Effort(?:\*\*)?\s*:?\s*)(.*)$/gim, (_m, head: string, rest: string) => {
    const v = /\b(?:small|^s)\b/i.test(rest) ? "S" : /\bmedium\b|\bmoderate\b/i.test(rest) ? "M" : /\blarge\b|\bhigh\b/i.test(rest) ? "L" : null;
    const letter = v ?? (rest.trim().match(/^\(?([SML])\)?$/i)?.[1]?.toUpperCase() ?? null);
    return letter ? `${head}${letter}` : `${head}${rest}`;
  });

  // A blank `Existing coverage:` is the one form the schema forbids and the
  // model still produced. Deterministic beats a fourth restatement.
  out = out.replace(/^(\s*(?:\*\*)?Existing coverage(?:\*\*)?\s*:)\s*$/gim, "$1 none");

  // "specific, specific, and consistent"
  out = out.replace(/\b(\w{4,})(,?\s+)\1\b/gi, "$1");

  const sources = buildEvidenceProvenance(internal, external, 0, firstInternalN);
  return `${out.trimEnd()}\n\n---\n\n${sources}`;
}

function normalisePath(p: string): string {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\.?\//, "").trim().toLowerCase();
}

/**
 * The "## Evidence used" block — what internal notes and external sources a
 * run actually drew on, so a reader (or the next scan) can judge how strong
 * the basis was.
 */
export function buildEvidenceProvenance(
  internal: InternalDoc[],
  external: ExternalDoc[],
  externalDropped = 0,
  /**
   * When given, our own notes are NUMBERED from here instead of bulleted, so
   * the inline `[N]` markers `renderReportForReader` writes resolve against
   * this list. Omitted elsewhere, which keeps the vault copy byte-identical.
   */
  internalStartN?: number,
): string {
  return (
    `## Evidence used\n\n` +
    `**Our own notes (${internal.length})**\n` +
    (internal.length
      ? internal.map((d, i) => `${internalStartN ? `${internalStartN + i}. ` : "- "}\`${d.path}\`${d.curated ? " · curated" : ""}${d.modified ? ` · modified ${d.modified}` : ""}${d.extractedFrom ? ` · text extracted from \`${d.extractedFrom}\`` : ""}${d.mirrors?.length ? ` · duplicated at ${d.mirrors.map(m => `\`${m}\``).join(", ")}` : ""}`).join("\n")
      : "_(none — the vault had nothing on this topic)_") +
    `\n\n**Outside sources (${external.length} kept${externalDropped ? `, ${externalDropped} dropped by the validator` : ""})**\n` +
    (external.length
      ? external.map(d => `${d.n}. [${d.title}](${d.url})${d.score != null ? ` _(relevance ${d.score})_` : ""}`).join("\n")
      : "_(none)_")
  );
}

export async function runReportPipeline(opts: RunReportOptions): Promise<ReportResult> {
  const t0 = Date.now();
  const { schema, topic, internal, external } = opts;
  const push = opts.push ?? (() => {});
  const sectionBudget = opts.sectionTimeoutMs ?? SECTION_TIMEOUT_MS;
  const totalBudget = opts.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;

  const system = (opts.systemPrefix ? `${opts.systemPrefix.slice(0, SYSTEM_PREFIX_CHARS)}\n\n` : "") +
    `You are writing ONE SECTION of ${schema.purpose}. ` +
    `Use ONLY the supplied evidence — never facts from memory, never an invented URL, name, number or repository. ` +
    `Cite inline: [vault:path] for our own notes, [N] for a numbered outside source. ` +
    `If the evidence does not support the section, say so in one plain line instead of padding. ` +
    `Write the section body only: no heading, no preamble, no meta-commentary about tools, evidence or time limits. Markdown allowed.`;

  const results: SectionResult[] = [];
  const written: string[] = [];
  // Consecutive timeouts, not total failures: when the model cannot deliver
  // a first token inside the section budget, the next section will not
  // either — the cause is the model or the queue in front of it, and
  // neither changes because we ask again. Two strikes and the rest are
  // gaps, which gets the report out with an honest reason much sooner.
  let consecutiveTimeouts = 0;
  const TIMEOUT_STRIKES = 2;
  // Whether the cascade actually FIRED — i.e. skipped a section as "not
  // attempted" (below) — as opposed to consecutiveTimeouts merely ending the
  // main loop at TIMEOUT_STRIKES because the last two sections in the
  // schema happened to time out with nothing left to skip. Those are not
  // the same thing — the retry pass below gates on THIS, not on
  // consecutiveTimeouts directly.
  let cascadeAborted = false;

  /** Is this gap/error string a TIMEOUT, as opposed to a refusal or bad response? */
  const isTimeoutGap = (s: string | undefined): boolean => /exceeded \d+s|abort|timed? ?out/i.test(String(s ?? ""));

  // One section's full attempt — prompt build, generate, citation repair.
  // Factored out so the one-shot retry pass below (after every section has
  // had its first attempt) runs EXACTLY the same logic a second time.
  async function attemptSection(spec: SectionSpec, sTime: number): Promise<SectionResult> {
    const pool = spec.evidence === "internal" ? internalBlock(internal)
      : spec.evidence === "external" ? externalBlock(external)
      : `${internalBlock(internal)}\n\n${externalBlock(external)}`;

    // Sections that reason ACROSS the report get the sections already
    // written, not the raw evidence again — that is what makes a summary a
    // summary, and it keeps the prompt small.
    const priorContext = ((spec.needsCitations === false || spec.seePriorSections) && written.length)
      ? `\n\nSections already written (summarise/build on these; do not repeat them verbatim):\n\n${written.join("\n\n").slice(0, PRIOR_CONTEXT_CHARS)}`
      : "";

    // EVIDENCE LEADS, INSTRUCTION TRAILS — deliberately. Speed: the evidence
    // block is identical for every section drawing on the same pool, while
    // the heading and brief change each time — leading with the shared
    // block lets Ollama reuse the cached KV prefix for sections that
    // follow. Quality: an instruction placed after long evidence is
    // followed more closely than one buried above it.
    // SUBTRACT, DO NOT ADD — see constraintsBlock's own doc comment above.
    const constraints = opts.constraintsBlock?.trim() ?? "";
    const constraintsPart = constraints ? `${constraints}\n\n` : "";
    const evidenceRoom = Math.max(500, EVIDENCE_CHARS - constraintsPart.length);
    const prompt =
      `EVIDENCE\n\n${truncateWithMarker(pool, evidenceRoom)}\n\n` +
      constraintsPart +
      `Report topic: ${topic}\n\n` +
      `Section to write: "${spec.heading}"\n` +
      `What it must contain: ${spec.brief}${priorContext}\n\n` +
      `Write the "${spec.heading}" section now.`;

    try {
      push(`Writing "${spec.heading}"…`);
      const text = (await withTimeout(
        (signal) => opts.generate(prompt, system, { maxTokens: spec.needsCitations === false ? 400 : 650, signal, firstTokenMs: sectionBudget }),
        sectionBudget,
        `section "${spec.heading}"`,
      )).trim();

      if (!text) {
        return { id: spec.id, heading: spec.heading, text: "", ok: false, gap: "the model returned nothing", citations: [], elapsedMs: Date.now() - sTime };
      }
      let finalText = text;
      let citations = extractCitations(text);
      // ONE repair attempt before a section is thrown away for citing
      // nothing. A small local model that writes a good paragraph and
      // forgets the "[2]" marker has made a formatting mistake, not an
      // unsupported claim, and withholding is a heavy penalty for it.
      // Asking again, with the source list and nothing else, is cheap and
      // usually enough. The unsupported-URL check further down stays
      // strict: that one catches invention, which no repair should rescue.
      if (spec.needsCitations !== false && citations.length === 0 && (internal.length || external.length)) {
        try {
          push(`"${spec.heading}" came back uncited — asking once for the markers.`);
          const repaired = (await withTimeout(
            (signal) => opts.generate(
              `${text}\n\nSOURCES\n${truncateWithMarker(pool, Math.floor(EVIDENCE_CHARS / 2))}`,
              `Add citation markers to the section above and return it otherwise UNCHANGED. Use [N] for a numbered outside source and [vault:path] for one of our own notes. Do not add, remove or reword any claim — if a sentence has no support in the sources, delete that sentence rather than inventing a marker for it.`,
              { maxTokens: 650, signal },
            ),
            Math.min(sectionBudget, 90_000),
            `citation repair "${spec.heading}"`,
          )).trim();
          const repairedCitations = extractCitations(repaired);
          if (repaired && repairedCitations.length > 0) {
            finalText = repaired;
            citations = repairedCitations;
          }
        } catch { /* repair is best-effort — fall through to the withholding path */ }
      }
      // Presentation, strictly after the citation check above — which needs
      // the raw markers to decide whether this section is supported at all.
      finalText = cleanSectionText(finalText, spec.heading);
      return { id: spec.id, heading: spec.heading, text: finalText, ok: true, citations, elapsedMs: Date.now() - sTime };
    } catch (e: any) {
      const gap = String(e?.message ?? e).slice(0, 160);
      push(`⚠ "${spec.heading}" did not complete (${gap}) — recorded as a gap.`);
      return { id: spec.id, heading: spec.heading, text: "", ok: false, gap, citations: [], elapsedMs: Date.now() - sTime };
    }
  }

  for (const spec of schema.sections) {
    const sTime = Date.now();
    const elapsedTotal = sTime - t0;

    if (consecutiveTimeouts >= TIMEOUT_STRIKES) {
      cascadeAborted = true;
      results.push({
        id: spec.id, heading: spec.heading, text: "", ok: false,
        gap: `not attempted — the previous ${consecutiveTimeouts} sections timed out, so the model (or the queue in front of it) is the problem, not this section`,
        citations: [], elapsedMs: 0,
      });
      continue;
    }

    // Total-budget guard. Remaining sections are reported as gaps rather
    // than attempted, so the report always lands and always says what is
    // missing.
    if (elapsedTotal > totalBudget) {
      results.push({
        id: spec.id, heading: spec.heading, text: "", ok: false,
        gap: `not attempted — the report's total time budget (${Math.round(totalBudget / 60_000)}min) was already spent`,
        citations: [], elapsedMs: 0,
      });
      continue;
    }

    const res = await attemptSection(spec, sTime);
    // A timeout says something about the MODEL; anything else (a refusal, a
    // provider error, a bad response) says something about this section, so
    // only the former counts toward the strikes.
    if (!res.ok && isTimeoutGap(res.gap)) consecutiveTimeouts += 1;
    else consecutiveTimeouts = 0;
    results.push(res);
    if (res.ok) written.push(`## ${res.heading}\n${res.text}`);
  }

  // ── ONE RETRY FOR EACH TIMED-OUT SECTION, AFTER EVERY FIRST ATTEMPT ────────
  //
  // A section that times out is very often queued behind THIS RUN'S OWN
  // other sections competing for the shared local-LLM lane (llm-lane.ts),
  // not actually slow to generate — caller timeouts include lane wait, not
  // just generation time. By the time every section has had its first
  // attempt, this run's own calls have drained out of the lane, and a
  // re-send often lands on a warm KV cache.
  //
  // Strictly bounded: timeouts only (a refusal or an empty body fails the
  // same way twice), one pass, sequential, same section budget. Skipped
  // entirely if the TIMEOUT_STRIKES cascade above actually FIRED — retrying
  // into a still-stuck model/queue would just repeat the same cascade.
  if (!cascadeAborted) {
    const timedOutIdx = results.map((r, i) => ({ r, i })).filter(({ r }) => !r.ok && isTimeoutGap(r.gap)).map(({ i }) => i);
    if (timedOutIdx.length) {
      push(`Retrying ${timedOutIdx.length} timed-out section(s) once, now the lane is quiet.`);
      for (const idx of timedOutIdx) {
        // Same total-budget guard the main loop applies before each attempt.
        if (Date.now() - t0 > totalBudget) {
          const spec = schema.sections[idx];
          results[idx] = { ...results[idx], gap: `not retried — the report's total time budget (${Math.round(totalBudget / 60_000)}min) was already spent` };
          push(`  "${spec.heading}": not retried — total time budget already spent`);
          continue;
        }
        const spec = schema.sections[idx];
        const retry = await attemptSection(spec, Date.now());
        results[idx] = retry;
        if (retry.ok) written.push(`## ${retry.heading}\n${retry.text}`);
        push(retry.ok ? `  "${spec.heading}": recovered on retry` : `  "${spec.heading}": still failed (${retry.gap})`);
      }
    }
  }

  // ── Step 4: citation check ──
  //
  // A failed check WITHHOLDS the section — unciteable claims do not reach
  // the page, rather than publishing regardless with a footnote nobody
  // connects to any particular paragraph.
  const gaps: { id: string; reason: string }[] = [];
  const allowedUrls = evidenceUrlKeys(internal, external);
  for (const r of results) {
    if (!r.ok) { gaps.push({ id: r.id, reason: r.gap ?? "section failed" }); continue; }
    const spec = schema.sections.find(s => s.id === r.id);
    const hasEvidence = internal.length > 0 || external.length > 0;
    // Only a claim-bearing section with evidence available and no citation
    // is a finding. Demanding a citation when there was nothing to cite
    // would flag the pipeline for correctly reporting an empty result.
    if (spec?.needsCitations !== false && hasEvidence && r.citations.length === 0) {
      const reason = "no citation — the claims in this section are not traceable to a source";
      gaps.push({ id: r.id, reason });
      r.withheld = reason;
      continue;
    }
    // Invented sources survive a citation check: a section can carry a "[2]"
    // and still name five repositories nobody fetched. Every URL has to be
    // one the run actually saw — in ANY section, cited or not.
    const bad = unsupportedUrls(r.text, allowedUrls);
    if (bad.length) {
      // The offending links go to the GAP (logs, the job record, anyone
      // debugging the run) but never into the document.
      gaps.push({
        id: r.id,
        reason: `names ${bad.length} source${bad.length === 1 ? "" : "s"} the run never fetched (${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ", …" : ""}) — unverifiable, so not published`,
      });
      r.withheld = `${bad.length} source${bad.length === 1 ? "" : "s"} named here could not be traced to anything the run fetched`;
    }
  }

  // ── Step 4.5: guard a citation-exempt summary against its own siblings ──
  //
  // Must run AFTER the citation check above (it reads the withheld state
  // that check just decided) and BEFORE assembly.
  if (schema.summaryGuard) {
    const { summaryId, requiredIds } = schema.summaryGuard;
    const summaryRes = results.find(r => r.id === summaryId);
    const unavailable = (id: string) => {
      const r = results.find(x => x.id === id);
      return !r || !r.ok || !!r.withheld;
    };
    const allUnavailable = requiredIds.length > 0 && requiredIds.every(unavailable);
    if (summaryRes && summaryRes.ok && !summaryRes.withheld && allUnavailable) {
      const reason = "no verifiable opportunities found this run — the sections it would summarise could not be grounded in evidence";
      summaryRes.withheld = reason;
      gaps.push({ id: summaryRes.id, reason });
    }
  }

  // ── Step 5: assemble ──
  const body = results.map(r => {
    // A gap is stated in the document, not hidden. A reader must be able to
    // see that a section is missing and why, rather than infer it from
    // silence.
    if (!r.ok) return `## ${r.heading}\n\n_Not written: ${r.gap}. The evidence for this section was gathered and is listed below — re-running usually completes it._`;
    if (r.withheld) return `## ${r.heading}\n\n_Withheld: ${r.withheld}. Nothing is being hidden from you — the text existed but could not be traced to the evidence below, and an unverifiable claim in a research report is worse than a blank section._`;
    return `## ${r.heading}\n\n${r.text}`;
  }).join("\n\n");

  const uncited = gaps.filter(g => g.reason.startsWith("no citation")).length;
  const withheld = results.filter(r => r.withheld).length;
  const provenance = buildEvidenceProvenance(internal, external, opts.externalDropped ?? 0);

  const failed = results.filter(r => !r.ok).length;
  const integrity = failed || uncited || withheld
    ? `\n\n---\n\n_Report integrity: ${results.length - failed}/${results.length} sections written` +
      (failed ? `, ${failed} incomplete` : "") +
      (uncited ? `, ${uncited} written without a citation` : "") +
      (withheld ? `, ${withheld} withheld as unverifiable` : "") + `._`
    : "";

  return {
    markdown: `${body}\n\n---\n\n${provenance}${integrity}\n`,
    sections: results,
    internal,
    external,
    gaps,
    stats: {
      internalDocs: internal.length,
      externalSources: external.length,
      externalDropped: opts.externalDropped ?? 0,
      sectionsWritten: results.length - failed,
      sectionsFailed: failed,
      uncitedSections: uncited,
      withheldSections: withheld,
      elapsedMs: Date.now() - t0,
    },
  };
}
