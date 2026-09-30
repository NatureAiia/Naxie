// Query intent router (RIFTS-X QueryIntentAnalyzer port).
// Classifies a RAG query so ragSearch can pick a retrieval strategy
// instead of running the same hybrid path for everything.

export type RagIntent =
  | "summary"
  | "search"
  | "analytics"
  | "comparison"
  | "status"
  | "recommendation"
  | "alert";

const INTENT_PATTERNS: Record<RagIntent, string[]> = {
  summary: ["summary", "summarise", "summarize", "overview", "brief", "what is", "tell me about", "explain"],
  search: ["find", "show", "list", "get", "retrieve", "search", "where is", "which", "locate"],
  analytics: ["how many", "count", "statistics", "stats", "analytics", "trend", "analysis", "report", "metrics"],
  comparison: ["compare", "comparison", "difference", "vs", "versus", "better", "worse", "diff"],
  status: ["status", "progress", "state", "condition", "how is", "health", "overdue", "pending"],
  recommendation: ["suggest", "recommend", "should", "what should", "best", "advise", "next step"],
  alert: ["alert", "warning", "issue", "problem", "risk", "danger", "expir", "breach", "attention"],
};

export function detectIntent(query: string): RagIntent[] {
  const q = query.toLowerCase();
  const out: RagIntent[] = [];
  for (const [intent, kws] of Object.entries(INTENT_PATTERNS) as [RagIntent, string[]][]) {
    if (kws.some(k => q.includes(k))) out.push(intent);
  }
  return out.length > 0 ? out : ["search"];
}

export type RagEntityHint =
  | "file" | "project" | "contract" | "task" | "user"
  | "department" | "knowledge" | "leave" | "asset" | "finance";

const ENTITY_PATTERNS: Record<RagEntityHint, RegExp> = {
  file: /\b(file|files|document|documents|record|records|note|notes|vault)\b/i,
  project: /\b(project|projects|initiative|program|sprint|phase)\b/i,
  contract: /\b(contract|contracts|agreement|tender|bid|procurement)\b/i,
  task: /\b(task|tasks|todo|action item|deliverable)\b/i,
  user: /\b(user|users|staff|employee|person|member|people)\b/i,
  department: /\b(department|team|division|org)\b/i,
  knowledge: /\b(knowledge|policy|policies|sop|guide|howto|decision)\b/i,
  leave: /\b(leave|vacation|time.?off|absence)\b/i,
  asset: /\b(asset|assets|equipment|inventory)\b/i,
  finance: /\b(budget|requisition|expenditure|cost|invoice|payment|finance)\b/i,
};

export function extractEntityHints(query: string): RagEntityHint[] {
  return (Object.entries(ENTITY_PATTERNS) as [RagEntityHint, RegExp][])
    .filter(([, re]) => re.test(query))
    .map(([k]) => k);
}

// Strategy hint consumed by ragSearch: analytics/status queries want the
// structured + insight paths ranked higher; plain searches keep BM25 first.
export function intentStrategy(intents: RagIntent[]): {
  boostStructured: boolean;
  boostInsights: boolean;
  limit: number;
} {
  const set = new Set(intents);
  const boostInsights = set.has("analytics") || set.has("status") || set.has("alert") || set.has("summary");
  const boostStructured = boostInsights || set.has("comparison") || set.has("recommendation");
  return { boostStructured, boostInsights, limit: boostInsights ? 10 : 8 };
}
