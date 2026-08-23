// Naxie router — decides which tier Naxie should use for this turn and
// exposes the decision as visible metadata (so the UI can show "quick free"
// vs "deep large" vs "local small → large" without guessing).
//
// Policy (per user spec):
//   • Online + simple  → fast free-tier cloud model (small tier)
//   • Online + complex  → large cloud model (large tier)
//   • Offline           → Ollama ordered by size (smallest/fastest for simple,
//                        larger when reasoning/longForm weight grows)

export type NaxieComplexity = "simple" | "complex";
export type NaxieTier = "free-small" | "free-large" | "ollama-small" | "ollama-large";

export type NaxieClassification = {
  level: NaxieComplexity;
  reason: string;
  signals: string[];
};

// Heuristic patterns — deliberately small/cheap, no LLM call.
const CODE_RE = /\b(write|generate|implement|refactor|fix|debug|code|function|class\b|```|def\s+\w+\s*\(|import\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|python|javascript|typescript|sql|api|algorithm|regex|unit test|bug)\b/i;
const REASONING_RE = /\b(analy[sz]e|compare|evaluate|explain why|prove|derive|trade-?off|architecture|strategy|research in depth|step[- ]by[- ]step|chain of thought|decision matrix|pros and cons|multi[- ]step)\b/i;
const LONGFORM_RE = /\b(essay|report|article|summary|document|comprehensive|detailed|long[- ]form|500 words|1000 words|2000 words|thorough|in depth)\b/i;
const MATH_RE = /\b(calculate|solve|equation|theorem|proof|integral|derivative|probability|statistics|optimize)\b/i;
const MULTISTEP_RE = /(step\s*\d|first.*then|after that|sequence|workflow|then\s+do|phase\s*\d)/i;

function estimateTokens(s: string | undefined): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

export function classifyNaxieComplexity(prompt: string, convoTokens = 0): NaxieClassification {
  const signals: string[] = [];
  const lower = prompt.trim();
  const tokens = estimateTokens(prompt) + convoTokens;
  const sentences = lower.split(/[.!?]+/).filter(Boolean).length;
  const words = lower.split(/\s+/).length;

  // Size signals
  if (tokens > 600) signals.push(`long-convo ~${tokens} tokens`);
  else if (tokens > 350) signals.push(`medium ~${tokens} tokens`);

  // Content signals
  if (CODE_RE.test(prompt)) signals.push("code");
  if (REASONING_RE.test(prompt)) signals.push("reasoning");
  if (LONGFORM_RE.test(prompt)) signals.push("long-form");
  if (MATH_RE.test(prompt)) signals.push("math");
  if (MULTISTEP_RE.test(prompt)) signals.push("multi-step");
  if (/```/.test(prompt)) signals.push("code-fence");
  if (sentences >= 4 && words > 60) signals.push("multi-sentence");

  // Very short + no complex signals = definitely simple
  if (tokens < 80 && signals.length === 0) {
    return { level: "simple", reason: "short + no complex signals — quick free tier", signals: ["short"] };
  }

  // Any strong complex signal triggers complex, even if short ("write a sorting algorithm")
  const strongSignals = signals.filter(s => ["code", "reasoning", "long-form", "math", "code-fence", "long-convo ~"].some(k => s.includes(k)));
  // Need at least 1 strong signal, or 2 weaker ones, or size alone >600
  const isComplex =
    tokens > 600 ||
    strongSignals.length >= 1 ||
    signals.length >= 2 ||
    tokens > 350 && signals.length >= 1;

  if (isComplex) {
    const reason = signals.length
      ? `complex (${signals.join(", ")}) — large tier`
      : `~${tokens} tokens — large tier`;
    return { level: "complex", reason, signals };
  }

  return { level: "simple", reason: signals.length ? `simple (${signals.join(", ")}) — quick free tier` : "simple — quick free tier", signals: signals.length ? signals : ["simple"] };
}

export function tierFor(level: NaxieComplexity, online: boolean): NaxieTier {
  if (online) return level === "complex" ? "free-large" : "free-small";
  return level === "complex" ? "ollama-large" : "ollama-small";
}
