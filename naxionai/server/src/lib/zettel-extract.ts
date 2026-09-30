// Automatic zettel creation — periodically scan recent conversations across
// all users and extract durable, save-worthy insights into permanent notes,
// without the operator manually asking or clicking "Promote". Mirrors
// maybeRunProactiveResearch's shape (org-daemon.ts) — double throttle (in-
// memory + persisted cursor), single LLM extraction call, best-effort output.
//
// Defaults DISABLED (see lib/daemon-settings.ts) — auto-writing into the
// permanent-notes vault is impactful enough that it should be opt-in, unlike
// the daemon's read-only/notify-only loops which default on.

import { listUsers } from "./users.js";
import { listChatHistory, type ChatExchange } from "./chat-history.js";
import { getInteractions, setLastZettelScanAt } from "./naxie-interactions.js";
import { listVault, readVaultFile, writeZettel } from "./vault.js";
import { enqueueVaultCommit } from "./commit-queue.js";
import { logAudit } from "./audit-log.js";

const ZETTEL_EXTRACT_MS = Number(process.env.NAXION_ZETTEL_EXTRACT_MS) || 6 * 3600 * 1000;
const ZETTEL_EXTRACT_THROTTLE_MS = Number(process.env.NAXION_ZETTEL_EXTRACT_THROTTLE_MS) || 6 * 3600 * 1000;
const MAX_EXCHANGES_PER_RUN = 30;
const MAX_RECENT_TITLES = 20;

let lastZettelExtractAt = 0;

// Recent 2-Permanent/ titles, newest-first (stamp-prefixed filenames sort
// lexicographically ≈ recency — no mtime sort needed) — fed to the LLM as
// "already captured, don't repeat these" since it has no memory across runs.
function recentZettelTitles(): string[] {
  const titles: string[] = [];
  try {
    const nodes = listVault("2-Permanent").filter(n => n.type === "file" && n.name.endsWith(".md"));
    nodes.sort((a, b) => b.name.localeCompare(a.name));
    for (const n of nodes.slice(0, MAX_RECENT_TITLES)) {
      try {
        const body = readVaultFile(n.path);
        const m = body.match(/^title:\s*(.+)$/m);
        if (m) titles.push(m[1].trim());
      } catch { /* tolerate one bad file */ }
    }
  } catch { /* vault not configured — no titles to exclude */ }
  return titles;
}

function collectRecentExchanges(sinceIso: string): ChatExchange[] {
  const all: ChatExchange[] = [];
  for (const u of listUsers()) {
    for (const ex of listChatHistory(u.id, 100)) {
      if (ex.at > sinceIso) all.push(ex);
    }
  }
  all.sort((a, b) => b.at.localeCompare(a.at));
  return all.slice(0, MAX_EXCHANGES_PER_RUN);
}

type ExtractedInsight = { title: string; body: string; tags?: string[] };

function parseInsights(raw: string): ExtractedInsight[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  const parsed = JSON.parse(m[0]);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x): x is ExtractedInsight => x && typeof x.title === "string" && typeof x.body === "string" && x.title.trim() && x.body.trim())
    .slice(0, 3);
}

export async function maybeExtractZettels(now = Date.now()): Promise<boolean> {
  if (now - lastZettelExtractAt < ZETTEL_EXTRACT_THROTTLE_MS) return false;
  const persistedAt = getInteractions()?.lastZettelScanAt;
  const cursor = persistedAt ?? new Date(now - ZETTEL_EXTRACT_MS).toISOString();
  if (persistedAt && now - new Date(persistedAt).getTime() < ZETTEL_EXTRACT_MS) return false;

  // Set both throttle markers before the async work — a crash mid-extraction
  // shouldn't cause the same window to be retried forever.
  lastZettelExtractAt = now;
  setLastZettelScanAt(new Date(now).toISOString());

  try {
    const exchanges = collectRecentExchanges(cursor);
    if (exchanges.length === 0) return false;

    const transcript = exchanges
      .slice()
      .reverse() // chronological for the prompt
      .map(ex => `[${ex.at}]\nUser: ${ex.prompt.slice(0, 600)}\nNaxie: ${ex.response.slice(0, 600)}`)
      .join("\n\n");
    const excludeTitles = recentZettelTitles();
    const excludeBlock = excludeTitles.length > 0 ? `\nAlready captured — do NOT repeat these:\n${excludeTitles.map(t => `- ${t}`).join("\n")}\n` : "";
    const prompt = `Review this recent conversation transcript and identify 0-3 durable, save-worthy insights — facts, decisions, or realizations worth keeping permanently. Skip routine Q&A, small talk, and anything transient (status checks, "did X work" confirmations).\n${excludeBlock}\nTranscript:\n${transcript}\n\nRespond with ONLY a JSON array (no prose, no markdown fences), 0-3 items: [{"title": "...", "body": "...", "tags": ["..."]}]. Empty array if nothing is durable enough to save.`;
    const system = "You are Naxie's zettel-extraction pass — a careful curator, not a summarizer. Most conversations yield zero durable insights; only extract what would genuinely be worth finding again later.";

    const { llmGenerate } = await import("./llm.js");
    const raw = (await llmGenerate(prompt, system, { profile: "extraction", temperature: 0, maxTokens: 900 })).trim();
    if (!raw) return false;

    let insights: ExtractedInsight[];
    try {
      insights = parseInsights(raw);
    } catch (e) {
      console.warn(`[zettel-extract] failed to parse LLM output (tolerated): ${(e as Error).message}`);
      return false;
    }
    if (insights.length === 0) return false;

    for (const insight of insights) {
      const tags = [...(Array.isArray(insight.tags) ? insight.tags.map(String) : []), "auto-extracted"];
      const { path, id } = writeZettel(insight.title.trim(), insight.body.trim(), tags);
      void enqueueVaultCommit(`neuroworks: auto-zettel — ${path.split("/").pop()!.replace(/\.md$/, "")}`);
      try {
        logAudit({ level: "info", actor: "daemon", action: "zettel.auto_extracted", target: insight.title.slice(0, 100), detail: path, result: "success" });
      } catch { /* best-effort */ }
      void id; // returned for callers that want it; unused here
    }
    return true;
  } catch (e: any) {
    console.warn(`[zettel-extract] maybeExtractZettels failed (tolerated): ${e?.message ?? e}`);
    return false;
  }
}
