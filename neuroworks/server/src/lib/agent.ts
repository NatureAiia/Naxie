import { findPrimitive, humanStepLabel, primitivesPromptCatalog, primitives } from "./primitives.js";
import { ollamaGenerate, ollamaGenerateWithMeta } from "./ollama.js";
import { pollPeers } from "./peers.js";
import { searchVault, searchVaultFilenames } from "./vault.js";
import { suggestSkillsForIntent, suggestSkillsForTask, topSkillScoreForTask } from "./skills.js";
import { config } from "../config.js";
import { openrouterCircuitOpen, openrouterDailyQuotaExhausted, openrouterBillingExhausted } from "./openrouter.js";
import { PLAN_SYSTEM, POLISHED_DIRECT, POLISHED_SYNTH, TRIVIAL_DIRECT } from "./agent-prompts.js";
import { injectLanguagePrompt } from "./language-prompts.js";
import { classifyDeliverable, taskWantsResearch } from "./deliverable.js";
import { newOffloadRun, offloadLargeFields, recoverFullText } from "./context-offload.js";
import { listSources as listDataSources, getSourceByLabel } from "./data-sources.js";

// Shared local-filesystem detector — "does this task point at a file on the
// operator's PC?" Used at three points (the planner's system-prompt hint,
// the post-plan repair step, and defaultVaultPlan's last-resort fallback)
// so a task like "the doc called Summit Recon" is recognised consistently
// everywhere instead of only where each site's own regex happened to be
// broad enough. Was previously three independently-copied regexes that only
// matched "file called/named X" — "doc called X" / "document called X" (an
// extremely natural phrasing) matched NONE of them, so tasks phrased that
// way skipped local search entirely and fell through to a useless
// research.deep web search (2026-07-08 regression: "send an attachment doc
// called Summit Recon CONSO..." never even looked at the filesystem).
// Keep the "called/named" synonym list in sync with the (file|doc|document|
// pdf|docx?|xlsx?|pptx?) set defaultVaultPlan's needle-stripper already uses.
const LOCAL_FS_HINT_RE = /\b(downloads?|desktop|documents?|music|pictures|photos|videos|my\s+pc|my\s+computer|on\s+disk|local\s+file|(?:file|doc|document|pdf|docx?|xlsx?|pptx?|mp3|m4a|wav|flac|song|track|audio)\s+(?:called|named|titled))\b/i;

// Module-level so BOTH heuristicPlan (which runs first and can short-circuit
// straight to research.deep via detectResearchSignals — "the latest budgets"
// matches its recency pattern) and plan()'s financeContext hint agree on
// what counts as a finance-readout task. Without heuristicPlan also
// checking this, it intercepts finance questions before plan() ever runs,
// so the LLM-prompt hint never gets a chance — reproduced live 2026-07-10
// ("Give me the Aiia Finance Summary — pull the latest budgets..." routed
// to research.deep and returned "no data found" despite the FinanceFlow
// connector being live and correctly configured).
const FINANCE_READOUT_RE = /\b(aiia\s*finance|finance\s*(summary|dashboard|snapshot|read[\s-]?out)|financial\s+(summary|position|dashboard|snapshot)|how\s+(?:are\s+we|is\s+the\s+business)\s+doing\s+financially|net\s+profit|cash\s+(?:balance|flow)|company'?s?\s+finances|our\s+(?:revenue|financials?)|budgets?|receipts?|purchase\s+requisitions?|expense\s*(?:baselines?|forecasts?|history)|historical\s+(?:cash|expense|financial)|live\s+financial\s+(?:figures?|data|numbers?))\b/i;

// Org-structure / workforce-design tasks — job descriptions, team structure,
// reporting lines, "how are agents integrated", role design, org charts.
// These MUST plan from the company's own records (users.list, personas.list,
// org.*, company.department_data), never refuse for "lack of details" and
// never fall into the research-signal heuristic (the answer is internal, not
// on the web). Kept alongside FINANCE_READOUT_RE because it plays the same
// role: bail out of heuristicPlan so the plan()-level hint gets to run.
// Visual/image deliverable — route to the media.image studio (text-to-image),
// never to research/vault/local-file search. "of X" is required after the
// image nouns so "summarise the logo redesign doc" (a text task) doesn't match.
// Two branches: (1) unambiguous visual-deliverable nouns (logo/poster/banner/…)
// allow up to 3 intervening adjective words after the verb ("generate a SIMPLE
// logo", "design a bold minimalist poster") — the old form required the noun
// immediately after the article and missed every adjective phrasing; (2) the
// generic nouns (image/picture/graphic/visual) stay article-adjacent so a
// research ask like "a report on image recognition" doesn't mis-route to media.
const IMAGE_GEN_RE = /\b(?:generate|make|create|design|render|produce|draw|whip\s+up|mock\s+up)\b(?:\s+(?:me|an?|the|some))?(?:\s+[a-z][a-z-]*){0,3}?\s+(?:logos?|posters?|banners?|flyers?|mockups?|icons?|thumbnails?|wallpapers?|illustrations?|artworks?|hero\s+(?:image|banner)|cover\s+art)\b|\b(?:generate|make|create|design|render|produce|draw)\s+(?:me\s+)?(?:an?\s+|the\s+|some\s+)?(?:image|picture|graphic|visual)\b|\btext[\s-]to[\s-]image\b|\bimage\s+of\b/i;
// Connector / integration / data-source INVENTORY question — "what connectors
// do we have", "list our integrations", "which external data sources are
// available". Deterministic so it reaches connector.list / db.list_sources
// instead of the LLM planner picking research.deep (which can't see the
// operator's own configured connectors → falsely reports "no connectors").
const CONNECTOR_INVENTORY_RE = /\b(?:what|which|list|show|do we (?:have|got)|are (?:there|available)|available|configured)\b[^.\n]{0,50}\b(?:connectors?|integrations?|external\s+data\s+sources?|data\s+connectors?|third[\s-]party\s+(?:apis?|integrations?))\b|\b(?:our|available|configured|set[\s-]?up)\s+(?:connectors?|integrations?)\b/i;
// Video generation — "make a video / clip / reel / promo video / animation".
// Routes to media.video (MiniMax). "video" is excluded when immediately
// followed by "ad(s)" so "make a video ad" stays with AD_CREATIVE_RE → media.image
// (copy + still) rather than a raw clip. The verb→noun gap tolerates a short
// qualifier ("make a short promo video of X").
const VIDEO_GEN_RE = /\b(?:make|generate|create|produce|render|animate|whip\s+up|put\s+together)\b[^.\n]{0,30}\b(?:videos?(?!\s*ads?\b)|clips?|reels?|animations?|short\s+films?|movies?)\b|\btext[\s-]to[\s-]video\b/i;

// Ad/campaign creative — "make an ad for X", "create a social ad", "make a
// 10/10 ad about neuroworks and give me the downloadable". These need BOTH
// copy AND a downloadable visual asset: route to media.image for the visual;
// the synth writes the copy and the media block carries the download link.
// Caught live 2026-07-19: two ad tasks direct-synthed a text-only "content
// plan" and claimed media tools were "awaiting API configuration" while image
// generation was live. "add" is included behind an article ("a 10/10 add
// about X") — a common misspelling of ad — but bare "add a section" never
// matches because it has no preceding article.
const AD_CREATIVE_RE = /\b(?:make|create|design|produce|generate|build|craft)\b[^.\n]{0,60}\b(?:(?:an?|the|this|that|10\/10|killer|great|best|new|short|quick)\s+(?:ads?|adds?|advert(?:isement)?s?|commercials?|promos?)|advert(?:isement)?s?)\b|\b(?:social|video|display|digital|marketing|instagram|facebook|tiktok)\s+ads?\b/i;

// "Send/email me the (last N) generated images" — the artifacts live in the
// studio media folder (.neuroworks/media), which vault.search and fs.find_in
// CANNOT see. Caught live 2026-07-19: an agent searched vault + local storage,
// honestly reported "no such files", and claimed there was "no email
// transmission mechanism" while email.send was live. Routes to
// media.list → email.send with the listed paths attached.
const SEND_MEDIA_RE = /\b(?:send|email|mail|forward|share)\b[^.\n]{0,80}\b(?:generated\s+|created\s+|made\s+)?(?:images?|pictures?|visuals?|pngs?|photos?|artwork|graphics?)\b/i;

// Email send — an explicit "send an email to <addr> ..." task. Used to VETO
// direct-answer / triage (a send is always a tool task) and to gate the
// deterministic email.send plan in heuristicPlan below.
// The `email <address>` alternative (email directly followed by an @address,
// e.g. "email jane@x.com saying …") requires the @ so "email marketing", "email
// campaign", "email best practices" never match — only a real recipient does.
const EMAIL_SEND_RE = /\b(?:send\s+(?:an?\s+)?e[- ]?mail|e[- ]?mail\s+(?:it|this|that|to)\b|e[- ]?mail\s+[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|shoot\s+(?:an?\s+)?e[- ]?mail|fire\s+off\s+(?:an?\s+)?e[- ]?mail)\b/i;
// Social-media posting or monitoring — a tool task (social.*) against the org's
// OWN channels, never a world-knowledge direct answer. Requires a platform/
// "social media" word AND a social ACTION word (in either order, within 60
// chars) so a passing mention ("share your thoughts", "a Facebook outage")
// can't trip it.
const SOCIAL_PLATFORM = "(?:social\\s*media|twitter|linkedin|instagram|facebook|tiktok|threads)";
const SOCIAL_ACTION = "(?:post|posts|posting|publish|share|tweet|schedule|mentions?|comments?|engagement|analytics|followers|reach|impressions|monitor|recent|history|performance|content\\s+calendar)";
const SOCIAL_TASK_RE = new RegExp(`\\b${SOCIAL_ACTION}\\b[^]{0,60}?\\b${SOCIAL_PLATFORM}\\b|\\b${SOCIAL_PLATFORM}\\b[^]{0,60}?\\b${SOCIAL_ACTION}\\b`, "i");

// Tools that cause a real, hard-to-undo EXTERNAL side effect — writing to a
// customer database, calling an outbound connector, or sending an email. A
// fresh plan that includes any of them pauses for human sign-off BEFORE it
// executes (see the approval checkpoint in planAndExecute). The approved
// replay comes back through the `preplan` path, which skips the checkpoint, so
// approving runs the exact plan the operator reviewed — no re-planning, no
// second gate. db.query is read-only (SELECT/WITH) but still gated: a DB check
// can surface sensitive records, and the operator asked for it to be reviewed.
// code.exec / browser.harness_exec run arbitrary code/automation and are
// gated here too as defence-in-depth for when they're enabled.
// system_control / manage_clipboard: the Settings > System Access toggle
// (docs/naxie-architecture.md §2.2) only makes these tools ELIGIBLE to run —
// it is not blanket permission. Every actual plan that uses them still
// pauses here, same as email.send. git_pull mutates the configured repo, so
// it's gated the same way; git_status is read-only and deliberately left out
// so a routine status check doesn't need sign-off.
export const SENSITIVE_APPROVAL_TOOLS = new Set(["db.query", "connector.call", "email.send", "code.exec", "browser.harness_exec", "social.post", "buffer.post", "heygen.create_video", "system_control", "manage_clipboard", "git_pull"]);

// connector.call is gated by default (see SENSITIVE_APPROVAL_TOOLS above), but
// a READ (GET/HEAD, or no method → GET default) against a connector the
// operator has explicitly opted in via `skipApprovalForReads` skips the gate —
// e.g. the operator's own Microsoft To Do list can't expose anything they
// don't already see by opening the app, so pausing "what's on my list" for
// manual sign-off is pure friction with no safety benefit. This is opt-in per
// connector and read-only-only: writes, and every connector that hasn't opted
// in (finance systems, admin APIs, ...), stay gated exactly as before —
// mirrors why db.query stays gated even for SELECTs (comment above).
async function isConnectorCallExempt(args: Record<string, unknown> | undefined): Promise<boolean> {
  const method = String(args?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const ref = String(args?.connector ?? "").trim();
  if (!ref) return false;
  const { listConnectors } = await import("./connectors.js");
  const key = ref.toLowerCase();
  const conn = listConnectors().find((c: any) => c.id === ref || String(c.label ?? "").toLowerCase() === key);
  return !!(conn as any)?.skipApprovalForReads;
}

// The sensitive-tool steps in a plan (deduped by tool name). Used both by the
// in-agent checkpoint and by the chat router to re-park a DELEGATED plan whose
// worker hit the gate — the primary can't approve a worker's job, so it adopts
// the plan and runs the approved version locally.
export async function planSensitiveTools(plan?: { steps?: { tool: string; args?: Record<string, unknown> }[] } | null): Promise<string[]> {
  if (!plan?.steps) return [];
  const tools = new Set<string>();
  for (const s of plan.steps) {
    if (!SENSITIVE_APPROVAL_TOOLS.has(s.tool)) continue;
    if (s.tool === "connector.call" && await isConnectorCallExempt(s.args)) continue;
    tools.add(s.tool);
  }
  return [...tools];
}

// Parse a SELF-CONTAINED send: an explicit recipient address + an explicit
// body (quoted, or after body/message/saying/that says). Returns null when the
// body isn't literally present (e.g. "email me a summary of X" — that needs
// evidence-gathering, so it stays on the LLM planner path with the emailContext
// hint). Subject is optional; we derive a short one when omitted.
function parseSelfContainedEmail(t: string): { to: string; subject: string; body: string } | null {
  const addr = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (!addr) return null;
  const to = addr[0];
  // Body: quoted after body/message/saying/that says/text/content, or a bare
  // quoted run near a "body"/"saying" cue.
  const bodyM =
    t.match(/\b(?:body|message|saying|that\s+says?|text|content)\b\s*(?:of|is|:|=)?\s*["'“”]([^"'“”]{1,4000})["'“”]/i) ??
    t.match(/\b(?:body|message)\b\s*(?:of|is|:|=)?\s*(.+?)\s*$/i);
  if (!bodyM || !bodyM[1].trim()) return null;
  const body = bodyM[1].trim();
  // Subject: quoted after "subject", else derive from the body's first clause.
  const subjM = t.match(/\bsubject\b\s*(?:line\s*)?(?:of|is|:|=)?\s*["'“”]([^"'“”]{1,200})["'“”]/i)
    ?? t.match(/\bsubject\b\s*(?:line\s*)?(?:of|is|:|=)?\s*(.+?)\s+(?:and\s+)?(?:with\s+)?(?:body|message|saying)\b/i);
  const subject = (subjM?.[1]?.trim()) || body.slice(0, 60).replace(/\s+/g, " ");
  return { to, subject, body };
}

// Notepad — the WINDOWS APP, not a file. "what's in my notepad", "read/
// summarise my notepad (notes)", "what did I jot down in notepad". Routes to
// system.notepad (reads the autosave store, incl. unsaved tabs). "note pad"
// spacing tolerated; a bare "note" never matches (needs "notepad" or "notepad
// notes"), so "make a note" / "my notes app" don't false-trigger.
const NOTEPAD_RE = /\bnote\s?pad\b/i;

const ORG_STRUCTURE_RE = /\b(job\s+descriptions?|org(?:ani[sz]ational?)?\s+(?:structure|chart|outline|design)|reporting\s+lines?|team\s+structure|company\s+structure|agents?\s+(?:integrated|incorporated|in\s+the\s+org)|(?:role|position)\s+(?:profiles?|specs?)|staffing\s+(?:plan|structure)|workforce\s+(?:structure|design)|who\s+reports\s+to|(?:our|the\s+company'?s?|aiia'?s?)\s+(?:org(?:ani[sz]ation)?|departments?|teams?|structure|workforce|agents?|personas?|neuros?|staff|people|employees|hires?)\b|what\s+departments?\b|departments?\s+(?:exist|do\s+we\s+have)|(?:list|show|name)\s+(?:all\s+)?(?:the\s+|our\s+)?(?:departments?|teams?|agents?|personas?|neuros?|employees|staff)\b|who\s+(?:works|is)\s+(?:in|on)\s+(?:the\s+)?\w+\s+(?:department|team)\b|how\s+many\s+(?:agents?|personas?|neuros?|employees|people|staff|departments?|teams?)\b)/i;

// Parse the "Interpretation: intent=foo, target=..." line that chat.ts
// appends to enriched tasks. Returns the intent label when present, or
// undefined if the task didn't go through intent extraction. Used by the
// synth path to load a matching skill playbook.
function parseIntentFromTask(task: string): string | undefined {
  const m = task.match(/Interpretation:\s*intent=([\w-]+)/i);
  return m ? m[1].toLowerCase() : undefined;
}

// Extract just the user's actual request from the enriched task — strip
// thread context, interpretation lines, deliverable hints, AND chat-template
// preambles so heuristics + extractTopic see only the original ask.
//
// Three shapes get stripped (in priority order):
//   1. Chat templates (Quick web look-up, Multi-perspective, etc.) wrap the
//      user's typed text as "<template instructions>\n\nTopic: <bare text>".
//      The bare text after "Topic:" is the real ask.
//   2. Thread-context enrichment wraps as "Current request (...): <text>".
//   3. Plain enriched tasks just have the persona prefix and trailing
//      Interpretation: / Deliverable shape: blocks to strip.
export function parseUserRequestFromTask(task: string): string {
  // 1. Template preamble + Topic: suffix. The web UI splices the user's typed
  //    text in via "${activeTemplate.task}\n\nTopic: ${topic}" — without this
  //    extraction the planner sees the full template prose as the topic
  //    (cause of the 5-min "whats the hanta virus" research run).
  const topicMatch = task.match(/(?:^|\n)\s*Topic:\s*([\s\S]+?)(?:\n\nInterpretation:|\n\nDeliverable shape:|\n\n\*\*Alignment check|\n\n\*\*Source-of-truth notice|$)/i);
  if (topicMatch && topicMatch[1].trim().length > 0) return topicMatch[1].trim().slice(0, 400);
  // 2. Thread-context block.
  const m = task.match(/Current request \(.*?\):\s*([\s\S]*?)(?:\n\nInterpretation:|\n\nDeliverable shape:|\n\n\*\*Alignment check|\n\n\*\*Source-of-truth notice|$)/);
  if (m && m[1].trim().length > 0) return m[1].trim().slice(0, 400);
  // 3. Plain enriched task — strip wrappers and return the body. The
  //    Alignment-check / Source-of-truth blocks are planner directives chat.ts
  //    appends AFTER the user's text — without stripping them here they leak
  //    into customer-facing surfaces (a rescue-summary email once opened with
  //    "…in an email to X **Alignment check — required before responding…**").
  return task
    .replace(/\n*Interpretation:[\s\S]*$/i, "")
    .replace(/\n*Deliverable shape:[\s\S]*$/i, "")
    .replace(/\n*\*?\*?Alignment check — required[\s\S]*$/i, "")
    .replace(/\n*\*?\*?Source-of-truth notice\.?\*?\*?[\s\S]*$/i, "")
    .replace(/^\(You are operating as[^)]+\)\n+/, "")
    .trim()
    .slice(0, 400);
}

// True when the original task came in via a chat template (i.e. has a
// "Topic: <X>" splice). When this is the case, the user explicitly asked for
// the template's behavior (web look-up, multi-perspective, etc.) — we should
// honor that and NOT shortcut to a direct LLM answer even when the bare
// topic looks like a definition question.
function taskWasTemplated(task: string): boolean {
  return /(?:^|\n)\s*Topic:\s*\S/i.test(task);
}

export type PlanStep = { tool: string; args: Record<string, any>; rationale?: string; label?: string };
export type Plan = { steps: PlanStep[]; summary?: string; waves?: number[][] };
export type StepRun = { step: PlanStep; ok: boolean; result?: any; error?: string; durationMs: number; startedAt?: number; modelUsed?: string };

export type PeerReview = {
  verdict: "good" | "needs-work" | "bad";
  issues: string[];
  revised_answer?: string;
  confidence: number;
  reviewer?: { name?: string; model?: string };
  elapsedMs?: number;
};

export type QualityScore = {
  pass: boolean;
  factuality_risk: number;
  citation_coverage: number;
  persona_fit: number;
  // Did the answer actually do what the user asked (instruction-following /
  // on-target). Gates pass in every deliverable class. Optional for back-compat
  // with records written before this axis existed.
  prompt_alignment?: number;
  score?: number;
  issues?: string[];
};

export type SecurityScan = {
  pass: boolean;
  findings: { type: string; match: string; severity: "high" | "medium" | "low"; reason: string }[];
  redacted?: string;
  kind?: string;
};

// Structured "I need a human" ask — the heart of the hybrid-workforce loop.
// When a plan reaches a human.request step (or the active hire is a human
// worker), the task PAUSES instead of failing: the job lands in
// waiting_on_human with this shape attached, the Tasks page renders each
// item as an input the operator can answer, and POST /api/tasks/:id/human-input
// spins the continuation job with the answers injected.
export type HumanRequestItem = {
  type: "answer" | "upload" | "approval" | "action";
  prompt: string;
};
export type HumanRequest = {
  items: HumanRequestItem[];
  reason?: string;
  requestedAt: string;
  // Stamped by the resume endpoint once the operator responds — a request
  // with resolvedAt set no longer shows in the waiting queue.
  resolvedAt?: string;
};

export type AgentResult = {
  task: string;
  plan: Plan;
  runs: StepRun[];
  answer: string;
  // Present when the run paused on a human.request step — the caller (runJob)
  // parks the job in waiting_on_human instead of marking it succeeded.
  humanRequest?: HumanRequest;
  // Streamed partial answer surfaced during synthesis. Replaced by the final
  // `answer` once synthesis completes; the UI prefers `answer` when present.
  partialAnswer?: string;
  hadWrites: boolean;
  review?: PeerReview;
  quality?: QualityScore;
  security?: SecurityScan;
  // Sub-agent spin-up telemetry — the UI uses this to show users why their
  // run was fast (or wasn't). `budgets` are the dual-lane caps used for this
  // run; `subagentTimings` is per-wave elapsed time in ms.
  budgets?: { llm: number; io: number; idlePeers: number };
  subagentTimings?: { wave: number; elapsedMs: number; ioCount: number; llmCount: number }[];
  // Skill picker telemetry. `skillUsed` is the name of the playbook the
  // synth was guided by; `skillScore` is the composite score (intent +
  // keyword) from suggestSkillsForTask. Both are persisted by job-store
  // and aggregated by the daily reflection so the picker has a feedback
  // loop — patterns like "skill X chosen N times but the customer flagged
  // M as wrong" become visible without manual review.
  skillUsed?: string;
  skillScore?: number;
  // Present when a fresh plan hit the sensitive-action checkpoint (db.query /
  // connector.call / email.send). runJob parks the job in awaiting-approval,
  // stores this plan, and the approve endpoint replays it via `preplan`. The
  // plan/task/personaSuffix ride along so the parked job can be resumed exactly
  // as reviewed without the caller having to re-thread them.
  // `plan` is the plan to REPLAY on approval. Usually undefined (the parent's
  // own plan is replayed via preplan), but set when a delegated sub-task parked:
  // then it's the WORKER's sub-plan, so approving runs the actual sensitive
  // steps locally instead of re-running the peer.delegate wrapper (which would
  // just re-delegate and re-park).
  approvalRequired?: { tools: string[]; steps: number; task: string; personaSuffix?: string; plan?: Plan };
};

// PLAN_SYSTEM, POLISHED_DIRECT, POLISHED_SYNTH moved to agent-prompts.ts
// — see that file for the prompt bodies. Imported above; usages below.

// Phrases that signal "the customer wants real external sources, not your
// training-data memory". When any of these appear in the task we add a
// research-required hint to the planner prompt — without it the LLM
// planner sometimes shortcuts long persona tasks ("I have a discovery call
// Friday — research Anthropic's enterprise pricing as of 2026 then prep
// MEDDIC notes") to a direct ollama.generate from memory, producing
// confident but untethered output. Patterns are matched case-insensitive
// against the full enriched task body. Returns the matched phrase for
// audit (so the planner prompt can name it back), or null when no signal.
const RESEARCH_SIGNAL_PATTERNS: RegExp[] = [
  // Look-up verbs anywhere in the body
  /\b(?:look\s+(?:it\s+|them\s+|this\s+)?up|find\s+(?:out|me\s+)\s*(?:what|how|who|whether|if)|investigate|dig\s+into|look\s+into)\b/i,
  // "Research X" — broadened. Previously required research + (it|them|this|
  // how|...) which missed the most common research framing "Research Notion's
  // launches" / "Research Stripe pricing" / "Research the current state of X".
  // Now matches research followed by ANY word (capitalised entity, article,
  // determiner, pronoun) — anything except a sentence boundary.
  /\bresearch\s+(?:[\w']+|the\s+|a\s+|an\s+)/i,
  // "Scan X" / "map the landscape for X" — landscape-scan trigger
  /\b(?:scan\s+(?:the\s+|a\s+)?(?:current\s+)?(?:landscape|market|category|space|players|competitive\s+set)|map\s+(?:the\s+|out\s+the\s+)?(?:market|landscape|competitive\s+set|category))\b/i,
  // Triangulate / verify / fact-check — these all imply gathering multiple
  // sources before answering
  /\b(?:triangulat(?:e|ing|ed)|verify\s+(?:the\s+|this\s+|a\s+)?claim|fact[- ]?check\s+(?:the\s+|this\s+|a\s+)?claim|cross[- ](?:check|verify|reference)\s+(?:the\s+|this\s+|a\s+)?claim)\b/i,
  // "Look up <noun> (on the web|online)" — most common research framing
  /\blook\s+up\s+(?:the\s+|a\s+|an\s+|some\s+)?\w+/i,
  // Recency markers — claims that depend on fresh facts
  /\b(?:latest|most\s+recent|currently|as\s+of\s+20\d{2}|in\s+20(?:2[5-9]|3\d)|this\s+(?:year|quarter|month))\b/i,
  // News / current-events framing — the local model, asked for "AI news from
  // the past month", declines with a knowledge-cutoff excuse instead of
  // searching. These force a fetch so it never answers a current-events
  // question from stale training data (2026-07-16 incident).
  /\b(?:news|headlines?|recent\s+(?:developments?|announcements?|news|updates?|breakthroughs?)|breaking|just\s+(?:announced|released|launched)|past\s+(?:week|month|few\s+(?:days|weeks))|last\s+(?:week|month|few\s+(?:days|weeks))|over\s+the\s+past\s+\w+|what(?:'?s|\s+is)\s+(?:new|happening)|new\s+in\s+(?:AI|ML|tech))\b/i,
  /\b(?:the\s+current\s+(?:state|landscape|consensus|best\s+practices?|status)|what(?:'?s|\s+is)\s+(?:the\s+)?(?:current|latest|most\s+recent|trending))\b/i,
  // Benchmark / industry-typical asks
  /\b(?:industry[- ]?(?:standard|typical|average|median|benchmark)|best[- ]in[- ]class\s+(?:companies|teams|orgs|saas)|what\s+(?:do|does)\s+(?:typical|good|great|leading)\s+(?:companies|teams|saas|firms|orgs|engineers))\b/i,
  /\b(?:benchmark(?:s|ed|ing)?|comparable\s+(?:company|companies|saas|firm)|what\s+(?:are\s+the\s+|what\s+are\s+)?typical\s+(?:ranges?|numbers?|values?|figures?|rates?))\b/i,
  // "According to" / cite-a-source phrasing
  /\b(?:according\s+to\s+(?:a\s+|the\s+|recent\s+)?(?:report|study|article|analyst|industry|survey|benchmark)|cite\s+(?:your\s+|the\s+)?sources?|with\s+citations?|with\s+sources?|grounded\s+in\s+(?:a\s+|the\s+)?source)\b/i,
  // Named-report or report-class lookups
  /\b(?:OpenView|SaaStr|KeyBanc|Bessemer|Gartner|Forrester|McKinsey|Bain|Goldman|Deloitte|Stack\s+Overflow\s+Developer\s+Survey|DORA\s+State\s+of\s+DevOps|JetBrains)\b/i,
  // Verbs that require real-world data
  /\b(?:price\s+check|pricing\s+(?:page|structure|tiers|model)|recent\s+(?:funding|launch|product|release|hire)|changelog|release\s+notes|roadmap\s+for\s+\w+)\b/i,
  // Multi-company / market-scan phrasings
  /\b(?:who(?:'?s|\s+is)\s+(?:playing|competing|in)\s+(?:this|the)\s+(?:market|space|category)|landscape\s+(?:for|of|on)|map\s+(?:the\s+|out\s+the\s+)?(?:market|landscape|competitive\s+set))\b/i,
];

export function detectResearchSignals(text: string): string | null {
  if (!text || text.length < 10) return null;
  const cap = text.slice(0, 4000);
  for (const re of RESEARCH_SIGNAL_PATTERNS) {
    const m = cap.match(re);
    if (m) return m[0].slice(0, 60);
  }
  return null;
}

// Hard cap on the planner LLM call. Slow local models occasionally take 2+
// minutes JUST to plan — by which point the customer has given up. After
// PLAN_TIMEOUT_MS we abandon the LLM plan and fall back to defaultVaultPlan,
// which routes the task to research.deep (or web.scrape for bare URLs).
// Dropped from 60s → 30s → 18s: with the templated-task path and `whats X`
// heuristic, anything that DIDN'T already match the heuristic by now is a
// genuinely unusual shape and 18s is enough for a small local planner; if
// it isn't, the fallback is faster than waiting any longer.
const PLAN_TIMEOUT_MS = Number(process.env.NEUROWORKS_PLAN_TIMEOUT_MS ?? "18000");

export async function plan(task: string, _personaSystemSuffix?: string, push?: (msg: string) => void, workMode?: "agent" | "hybrid" | "human", learn?: { taskKind?: string; persona?: string }): Promise<Plan> {
  // Persona deliberately omitted from the TOOL CHOICE prompt: tool selection
  // is mechanical and must not be gated by role. (Head of AI asking about
  // NeuroWorks is still allowed to search the vault.) The persona colors the
  // synthesised answer. We DO however pass vault-hits context — the planner
  // makes much better decisions when it knows whether the vault has notes on
  // the topic ("4 hits → prefer vault.search before web").
  const topic = extractTopic(task);
  let vaultContext = "";
  if (topic && topic.length >= 2) {
    try {
      // Filename-only scan here too: the planner only needs a hint about
      // whether the vault has anything on this topic. Full content search
      // would cost 10-15s on a big vault before the planner LLM even starts.
      const hits = searchVaultFilenames(topic, 5);
      if (hits.length > 0) {
        vaultContext = `\n\nVault context: the user's vault has ${hits.length} note${hits.length === 1 ? "" : "s"} matching this topic. Sample paths: ${hits.slice(0, 3).map(h => h.path).join(", ")}. Strongly prefer vault.search / vault.read over the web for this task; the user wants their own notes prioritised.\n`;
      } else {
        vaultContext = `\n\nVault context: the user's vault has NO notes on this topic. Web research (research.deep or research.multiperspective) is appropriate; capture findings back to 0-Inbox/.\n`;
      }
    } catch { /* tolerate — vault search failure shouldn't block planning */ }
  }
  // Research-trigger hint: when the task TEXT itself implies the customer
  // wants real external sources (look-up verbs, recency markers, benchmark
  // asks, "according to a recent report" phrasing), explicitly tell the
  // planner: do NOT short-circuit to ollama.generate / direct answer —
  // fetch web sources first. This catches the failure mode where the LLM
  // planner reads a long persona task ("I have a discovery call... research
  // Anthropic's pricing... then prep MEDDIC") and picks a single
  // ollama.generate from training memory because the surface verb wasn't
  // a bare "research X".
  const researchHint = detectResearchSignals(task);
  const researchContext = researchHint
    ? `\n\nResearch required: the task contains "${researchHint}" — the customer expects you to FETCH external sources, not answer from memory. Your plan MUST include at least one of: research.deep, research.multiperspective, web.search + smartFetch chain, or web.scrape. If you also need to synthesise persona-flavored output afterward, chain a final ollama.generate that takes the research result as evidence. Do NOT skip the fetch step.\n`
    : "";
  // Explicit-tool hint: when the user's task literally names a registered
  // primitive (e.g. "use fs.list_external", "with vault.read"), respect it.
  // Without this, the planner regularly ignored direct tool mentions and
  // routed every local-doc / external-fs request through research.deep — a
  // 30-90s detour that often answered "I couldn't find that" because the
  // wrong tool was reached for. Word-boundary match against the registered
  // catalog avoids false positives from substrings of unrelated words.
  const namedTools: string[] = [];
  for (const p of primitives) {
    const re = new RegExp(`\\b${p.name.replace(/\./g, "\\.")}\\b`);
    if (re.test(task)) namedTools.push(p.name);
  }
  // Cap the override-honoring set so a chat message that happened to list
  // many tool names can't outweigh the rest of the task brief. The research
  // override above still applies — when both signals fire, the planner has
  // both hints and can balance them.
  const explicitToolContext = namedTools.length > 0
    ? `\n\nExplicit tool request: the user's task literally names tool${namedTools.length === 1 ? "" : "s"} ${namedTools.slice(0, 5).map(t => `\`${t}\``).join(", ")}. Honor that — include the named tool${namedTools.length === 1 ? "" : "s"} as the FIRST step(s) in your plan with the most direct, minimal arguments the task implies. Only chain other tools afterward (e.g. a synth step) if the named tool's output needs further shaping. Do NOT silently substitute research.deep for a directly-named fs.* / vault.* / web.* primitive — the user already chose.\n`
    : "";
  // Company data hint: when the operator has registered a database
  // connection OR seeded the _company/ knowledge folder, surface that in
  // the planner's context. Without this nudge the planner reaches for
  // research.deep (web search) on questions like "what's our revenue this
  // quarter" — when the answer is sitting in the operator's own CRM DB
  // or company KB. Cheap to check: read registry sync + one folder stat.
  // Company knowledge map — a LIVE inventory of every place the answer to a
  // business question might already live (vault, connected databases,
  // connectors to other apps, published datasets), plus an explicit
  // "figure out the likeliest source FIRST" routing rule. Without this the
  // small planner defaults to research.deep (the public web) even when the
  // operator's own systems hold the answer.
  let companyDataContext = "";
  try {
    const { listSources } = await import("./data-sources.js");
    const sources = listSources();
    const { existsSync: fsExistsSync } = await import("node:fs");
    const { resolve: rresolve } = await import("node:path");
    const { config: cfg } = await import("../config.js");
    const hasCompanyFolder = fsExistsSync(rresolve(cfg.vaultPath, "_company"));

    // Connectors — outbound authenticated links to the operator's other apps
    // (finance system, CRM, etc.). A read-only connector call can answer a
    // question the vault/db don't cover.
    let connectors: { id: string; label: string; notes?: string }[] = [];
    try {
      const { listConnectors } = await import("./connectors.js");
      connectors = (listConnectors() as any[]).map(c => ({ id: c.id, label: c.label, notes: c.notes ?? c.description }));
    } catch { /* connectors optional */ }

    // Published datasets — curated golden records agents learn from via RAG.
    let datasetCount = 0;
    try { const { listDatasets } = await import("./adrs.js"); datasetCount = (listDatasets() as any[]).length; } catch { /* optional */ }

    const sourceLines: string[] = [];
    if (hasCompanyFolder) sourceLines.push(`VAULT (_company/): policies, playbooks, decks, contracts, meeting notes — via vault.search / vault.read.`);
    if (sources.length > 0) {
      sourceLines.push(`DATABASES (${sources.length}): ${sources.slice(0, 5).map(s => `"${s.label}"${s.notes ? ` — ${String(s.notes).slice(0, 60)}` : ""} (${s.kind}, id=${s.id})`).join("; ")} — via db.list_sources → db.schema(id) → db.query(id, sql) (read-only SELECT/WITH).`);
    }
    if (connectors.length > 0) {
      sourceLines.push(`CONNECTORS (${connectors.length}): ${connectors.slice(0, 5).map(c => `"${c.label}"${c.notes ? ` — ${String(c.notes).slice(0, 60)}` : ""} (id=${c.id})`).join("; ")} — via connector.list → connector.describe(id) → connector.call(id, endpoint) (respects each connector's read-only gate).`);
    }
    if (datasetCount > 0) sourceLines.push(`DATASETS (${datasetCount} published): curated golden records — data.list_datasets, then vault.search (their RAG chunks live in the vault).`);

    if (sourceLines.length > 0) {
      companyDataContext =
        `\n\nCOMPANY KNOWLEDGE MAP — before planning, decide WHERE the answer most likely lives and go there FIRST, only falling back to research.deep (public web) when none of the operator's own systems would hold it:\n- ${sourceLines.join("\n- ")}\n` +
        `Routing rule: money / revenue / expenses / invoices / cash → the finance DATABASE or finance CONNECTOR. Customers / deals / pipeline → the CRM CONNECTOR or a customer DATABASE. Policies / how-we-do-X / past decisions / contracts → the VAULT. Sales / orders / inventory / employees → a DATABASE. Only genuinely EXTERNAL facts (market news, competitor moves, general research) go to research.deep. When unsure which internal source, list them first (db.list_sources / connector.list) and pick by label/notes before querying.\n`;
    }
  } catch { /* tolerate — bad import shouldn't break planning */ }
  // Local-fs hint — when the task mentions Downloads / Desktop / Documents
  // / "my PC" / "my computer", route to fs.find_in (NOT research.deep,
  // which can't see the operator's filesystem). Without this, the small
  // planner often picks research.deep, then narrates a fabricated "I
  // searched your Downloads" answer.
  let localFsContext = "";
  if (LOCAL_FS_HINT_RE.test(task)) {
    localFsContext = `\n\nLocal filesystem context: the task mentions a file on the operator's PC (Downloads / Desktop / Documents / "my PC"). The FIRST step MUST be fs.find_in with folder='downloads'|'desktop'|'documents'|'all' and the filename substring. Do NOT use research.deep — it cannot see the operator's local filesystem. Chain fs.read_external (for the absolute path returned) or fs.import_to_vault afterward as the task requires.\n`;
  }
  // GitHub-activity hint — when the task asks about the operator's OWN
  // repos/commits/PRs/issues ("summarize my recent commits", "what's open
  // across my repos"), route to the github.* primitives, not research.deep
  // (which can only search the public web + vault and has no way to see
  // private repo activity). 2026-07-11: "summarize recent commits across
  // my repos and email me" fell through heuristicPlan's explainer bail
  // into this LLM path with no hint at all and no primitive nudge —
  // adding the hint here so the planner reliably composes list+read+send
  // instead of guessing.
  let githubContext = "";
  if (/\b(?:my|our)\s+(?:repos?|repositories|commits?|pull\s+requests?|prs?|issues?)\b/i.test(task) || /\bcommits?\b.{0,25}\b(?:repos?|repositories)\b/i.test(task) || /\b(?:git\s?hub|gh)\s+(?:repos?|repositories)\b/i.test(task) || /\b(?:all|list|summari[sz]e)\b[^.\n]{0,30}\b(?:repos?|repositories)\b/i.test(task)) {
    githubContext = `\n\nGitHub-activity context: the task asks about the operator's own GitHub repos/commits/PRs/issues. Use github.list_repos to enumerate them, then github.read_repo (owner+name) per repo of interest for README/recent commits/open PRs/issues — NOT research.deep, which cannot see private repo activity. If the task also asks to summarize across MULTIPLE repos, chain an ollama.generate synthesis step over the github.read_repo results before any final email/notify step.\n`;
  }
  // Email-send hint — when the task is about sending email, use the
  // dedicated email.send primitive that routes through Mailjet. Without
  // this nudge, small planners reach for web.interact and try to drive
  // Gmail's UI in a headless browser that isn't logged in — the step
  // returns ok but no actual email is sent, leaving the synth to
  // fabricate a "looks delivered" response. email.send returns a real
  // delivery confirmation the synth can quote. Also matches self-reference
  // ("email me", "send it to me", "notify me") — previously ONLY an
  // explicit @address or "send an email" phrasing matched, so "email me"
  // (the single most natural way to ask this) got no hint at all.
  let emailContext = "";
  if (/\b(send\s+(an?\s+)?email|email\s+\S+@|reply\s+(to|via)\s+email|mail\s+\S+@|send.*to\s+\S+@|email\s+me\b|send\s+(?:it|that|this|me)\s+(?:to\s+me\b|(?:an?\s+)?email\b)|notify\s+me\b)\b/i.test(task)) {
    const selfRef = /\b(?:email\s+me\b|send\s+(?:it|that|this)\s+to\s+me\b|notify\s+me\b)\b/i.test(task) && !/\S+@\S+/.test(task);
    emailContext = `\n\nEmail-send context: the task asks for an actual email to be sent. The plan MUST use email.send (NOT web.interact, NOT fs.* — those don't send mail). Required args: to (the @ address), subject, body (markdown ok). The body should be drafted INLINE in the args.body string, not as a separate ollama.generate step unless the body needs evidence-gathering first. Chain pattern when the body needs evidence: research/vault step → ollama.generate to draft the body → email.send with {body: "$step_N.text"}. When the body is self-contained from the task, ONE email.send step is the whole plan.${selfRef ? ` The task says "email/notify ME" with no address given — resolve the operator's own address with users.lookup / users.list first (do NOT invent an address or use a placeholder).` : ""}\n`;
  } else if (/\b(?:read|check|show|list|summari[sz]e|triage|go\s+through|any\s+new|unread|latest|recent|do\s+i\s+have)\b[^]{0,40}\b(?:e-?mails?|inbox|mailbox|mail)\b/i.test(task) || /\b(?:e-?mails?|inbox|mailbox)\b[^]{0,25}\b(?:unread|new|recent|latest|waiting|arrived)\b/i.test(task)) {
    emailContext = `\n\nEmail-read context: the task asks to READ the mailbox, not send. The plan MUST use inbox.read_unread (the IMAP reader on the configured mailbox — pass unreadOnly:false for "latest/recent" phrasing, leave the default for "unread/new"), or integration.gmail.read when a Google connection exists. Do NOT use vault.* / fs.* (the vault "0-Inbox" FOLDER is not the email inbox) and NOT db.query (the company database is not the mailbox). Summarise strictly from the returned messages; if none are returned, say the inbox has nothing matching rather than inventing.\n`;
  }
  // Activity-report hint — when the task asks about the agent's OWN completed
  // work/tasks over a time window ("report on the tasks I did yesterday", "what
  // shipped this week", "yesterday's task completion"), route to calendar.activity.
  // Without this, the planner runs vault.search/research.deep, finds nothing
  // (completed-task records live in the job history, NOT vault notes), and
  // reports "no records" — exactly the failure we saw. We also compute the
  // concrete dates because the small planner doesn't reliably know "today".
  let activityContext = "";
  const timeWindowRe = /\b(yesterday|today|this\s+week|last\s+week|this\s+month|last\s+month|past\s+\d+\s+(day|week)s?|last\s+(mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
  const activityIntentRe = /\b(tasks?|did|done|complete[d]?|finish(ed)?|accomplish(ed)?|work(ed)?|shipp(ed)?|activit|progress|report)\b/i;
  if (timeWindowRe.test(task) && activityIntentRe.test(task)) {
    const now = new Date();
    // LOCAL calendar dates (server tz == operator's) so "today"/"yesterday"
    // match the wall clock, not UTC — same off-by-one the Calendar had.
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const today = iso(now);
    const yesterday = iso(new Date(now.getTime() - 864e5));
    const weekAgo = iso(new Date(now.getTime() - 7 * 864e5));
    activityContext = `\n\nActivity-report context: the task asks about the agent's OWN completed work/tasks over a time window. The FIRST step MUST be calendar.activity (NOT vault.search / research.deep — completed-task records live in the job history, not vault notes; searching the vault returns "no records" and produces a false empty report). Scope it with from/to. Reference dates from the server clock: today=${today}, yesterday=${yesterday}, this-week-start=${weekAgo}. Use from=${yesterday} to=${yesterday} for "yesterday", from=${today} to=${today} for "today", from=${weekAgo} to=${today} for "this week". Then synthesise the report from the returned jobs (each has title, template, kind, status, score). If the task also asks to email/send it, chain email.send AFTER the synth with the report as the body.\n`;
  }
  // Memory hint — when the task asks the agent to RECALL something it was told
  // earlier ("what do you remember about X", "what do we know about the Acme
  // deal", "what's on file about …") or to PERSIST a durable fact ("remember
  // that …", "note that …", "keep in mind …"), route to the memory.* tools.
  // Without this the planner sends recall queries to research.deep / vault.search
  // (which do NOT read _neuroworks/memory) and drops "remember that …" on the
  // floor — exactly the orphaned-memory failure the angle probe surfaced (the
  // laptop-budget fact on disk was never recalled on either executor).
  let memoryContext = "";
  const rememberRe = /\b(remember\s+(that|this|to|the|my|our)?|note\s+(that|down)|make\s+a\s+note|keep\s+in\s+mind|don'?t\s+forget|store\s+(that|this)|for\s+future\s+reference|take\s+note)\b/i;
  const recallRe = /\b(what\s+do\s+(you|we)\s+(remember|know)|do\s+you\s+remember|recall(?:\s+(what|anything|the))?|on\s+file\s+about|what\s+(have|did)\s+(you|we)\s+(note|record|store|save)|from\s+(your\s+)?memory|what\s+do\s+you\s+have\s+on)\b/i;
  if (rememberRe.test(task)) {
    memoryContext = `\n\nMemory-write context: the task asks you to durably REMEMBER a fact. The plan MUST include a memory.note step with {subject, fact} — subject is the entity the fact is ABOUT (a person, project, or topic, e.g. "Q3 board meeting", "Priya", "acme-deal"), fact is the detail to remember verbatim (dates, amounts, names). Add an optional {date: "YYYY-MM-DD"} when the fact is time-bound (a meeting, deadline, renewal) so it surfaces on the calendar. This persists to long-term memory for future sessions — do NOT use vault.create_zettel; memory.note is the dedicated store memory.recall reads back. If the task also asks to confirm/read it back, chain memory.recall after.\n`;
  } else if (recallRe.test(task)) {
    memoryContext = `\n\nMemory-recall context: the task asks what the agent REMEMBERS / has on file about something. The FIRST step MUST be memory.search with {query: "<the key terms — the entity/topic the user named>"} (NOT research.deep / vault.search — durable facts live in _neuroworks/memory, which those tools do not read). If the user named an exact subject stored before, memory.recall {subject} is more precise. Synthesise the answer from the returned facts; if none are found, say so plainly rather than inventing.\n`;
  }
  // Aiia Finance hint — same failure shape as activity/memory above: without
  // an explicit steer, the planner has no way to know where finance data
  // lives (persona system prompts and skill playbooks are injected at
  // synth/direct time, NOT into planning — see the plan-phase sys prompt
  // built below, which never includes personaSystemSuffix). A "Aiia Finance
  // Summary" task silently fell through to vault.search + vault.read (found
  // nothing) before this hint existed, and the synth apologised for a
  // "missing connector" — reproduced live 2026-07-09.
  //
  // 2026-07-10: the old push-model snapshot (Finance System POSTs to
  // /api/public/dashboard, NeuroWorks stores one 5-field snapshot) is
  // retired — its data was stale (last pushed 2026-07-01) and has been
  // deleted from the vault. The real, live source is now the "Aiia
  // FinanceFlow" connector (external app, budgets/receipts/requisitions,
  // read-only, session-cookie auth that expires ~24h from setup).
  const financeContext = FINANCE_READOUT_RE.test(task)
    ? `\n\nAiia Finance context: the task asks for the company's real financial figures. Real data now lives in the live "Aiia FinanceFlow" connector — NOT finance.snapshot (retired, its pushed data was stale and has been cleared — it will return available:false), NOT vault.search, NOT research.deep. The plan should use connector.call on connector "Aiia FinanceFlow" against whichever endpoint(s) the question needs: list-budgets (/api/budgets), list-receipts (/api/receipts), list-requisitions (/api/requisitions). If unsure what's available, connector.describe {name:"Aiia FinanceFlow"} first. Synthesise the answer strictly from what the connector returns — never invent a figure. If the call fails (e.g. 401 — the connector's session cookie expires ~24h after each manual re-auth), say plainly that the FinanceFlow connection needs to be refreshed and stop; do not fall back to finance.snapshot or a vault note.\n`
    : "";
  // Org-structure grounding hint: the company's own structure is IN the
  // catalog — humans (users.list), AI agents (personas.list), reporting lines
  // (org.lookup / org.reports / org.escalation_path), department facts
  // (company.department_data). Without this hint the planner treated org
  // questions as unanswerable and refused with "I lack details about the
  // teams / please provide the organizational outline" — while every one of
  // those details sat one primitive call away.
  const orgContext = ORG_STRUCTURE_RE.test(task)
    ? `\n\nOrganization-structure context: this task is about the company's OWN structure, teams, roles, or agent workforce — all of which are available in the catalog. Ground the plan on the real records: users.list (every human — name, title, department, role), personas.list (every AI agent — role, job description, responsibilities, work mode), org.lookup / org.reports / org.escalation_path (reporting lines for a named person), company.department_data (department facts and policies), company.documents (official uploaded documents — strategic plan, governance policy, org structure, compliance; list then read by name), and vault.search for anything else the company's notes cover. A typical plan: users.list + personas.list (+ company.department_data when a department is named) → draft the deliverable from those results. Do NOT refuse for lack of organizational details, do NOT use human.request to ask for an "organizational outline" or "agent definitions", and do NOT plan research.deep/web search — this information is internal and already on hand.\n`
    : "";
  // Image-generation hint — when the task asks for a visual deliverable
  // (image/logo/poster/hero/illustration/mockup), the plan MUST use
  // media.image (text-to-image studio). Without this the planner tries
  // research.deep or fs.* and produces text about an image, not an image.
  const imageGenContext = IMAGE_GEN_RE.test(task)
    ? `\n\nImage-generation context: this task asks for a VISUAL/image deliverable. The plan MUST use media.image (text-to-image). Optionally call media.studio_models first to pick a model (Ideogram for typography/logos/posters; flux/seedream/imagen for photoreal). Pass a rich prompt (subject, style, composition, lighting, colour; exact text in quotes for typography) and an aspect_ratio. Do NOT use research.deep / web.search / fs.* — those cannot create an image, and do NOT hand-draw an inline SVG. If media.image reports no provider configured, say plainly that image generation needs IDEOGRAM_API_KEY or MUAPI_API_KEY — do not fabricate a file.\n`
    : "";
  // Send-existing-media hint — already-generated images live in the studio
  // media folder, which vault.search / fs.find_in cannot see. Without this
  // the planner searches the vault, finds nothing, and refuses.
  const mediaSendContext = SEND_MEDIA_RE.test(task)
    ? `\n\nSend-media context: the task refers to images that were ALREADY GENERATED. They live in the studio media folder — vault.search and fs.find_in will NOT find them. Use media.list (returns newest first with absolute paths) and, to email them, chain email.send with {attach_paths: "$step_N.pathsJoined"}. Email sending IS configured (email.send) — never claim there is "no email transmission mechanism". If the recipient is a name/"me" rather than a literal address, resolve it with users.lookup first.\n`
    : "";
  // Calendar/schedule write hint — agents CAN write to the calendar and
  // create recurring schedules; without the hint the planner treats these as
  // read-only surfaces and refuses or just narrates.
  const scheduleContext = /\b(?:schedule|recurring|every\s+(?:day|week|month|morning|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday)|daily|weekly|remind(?:er)?|add\s+(?:to|an?\s+event)|book\s+a|put\s+(?:it\s+)?on\s+(?:the\s+|my\s+)?calendar|calendar)\b/i.test(task)
    ? `\n\nCalendar/schedule context: agents can WRITE to the calendar. One-off dated commitments → calendar.add_event {date: YYYY-MM-DD, title}. Recurring automated work → schedule.create {name, task, hour, minute?, days_of_week?, deliver_email?} (check schedule.list first to avoid duplicates; schedule.delete cancels one). Reading: calendar.read_today / calendar.activity / calendar.plan_day. Do NOT claim the calendar is read-only.\n`
    : "";
  // Complexity fan-out hint: big or multi-part tasks should be decomposed into
  // PARALLEL sub-agents, not one serial chain. The executor already runs
  // independent steps as concurrent sub-agents (waves + dual-lane budgets) —
  // but only if the planner actually emits independent steps. Small planners
  // default to serial chains, leaving that speed on the table. Signals:
  // multi-part phrasing (numbered items, "and also", semicolons), several
  // deliverable verbs, or simply a long brief.
  const partSignals =
    (task.match(/(?:^|\n)\s*(?:\d+[.)]|[-•*])\s+/g)?.length ?? 0) +
    (task.match(/\b(?:and (?:also|then)|as well as|plus|additionally)\b|;/gi)?.length ?? 0);
  const verbSignals = (task.match(/\b(?:research|compare|summari[sz]e|draft|analy[sz]e|list|find|gather|review|check|prepare|compile)\b/gi)?.length ?? 0);
  const looksComplex = task.length > 400 || partSignals >= 2 || verbSignals >= 3;
  const fanOutContext = looksComplex
    ? `\n\nComplex task — FAN OUT: this task has multiple parts. Decompose the information-gathering into 3-6 INDEPENDENT steps with NO $step_ references between them (each becomes a parallel sub-agent — e.g. research.deep on distinct sub-topics, vault.search, connector.call, db.query side by side), then ONE final synthesis step that references their outputs. Parallel sub-agents finish far faster than a serial chain; only chain steps that genuinely need an earlier step's output.\n`
    : "";
  // Hybrid-hire hint: this role is agent + human. The planner should lean on
  // human.request for anything the catalog genuinely can't supply (internal
  // decisions, offline actions, documents only the person holds) instead of
  // guessing or producing a thin answer. Pure-agent roles get no hint — for
  // them human.request stays a last resort per the base PLAN_SYSTEM rule.
  const workModeContext = workMode === "hybrid"
    ? `\n\nHybrid role context: this hire is part agent, part human. Split the work deliberately — plan agent steps for everything the catalog can do, and add ONE human.request step (with typed items) for the parts that genuinely need the person: internal figures not in the vault/connectors/databases, judgment calls, sign-offs, offline actions, or documents only they hold. Do NOT fabricate content to avoid asking.\n`
    : "";
  // Learned context — the reinforcement loop. Quality (Feature A): if past runs
  // of this task-kind/persona score low on a specific quality axis, steer this
  // plan to fix it. Bottlenecks (Feature B): if reflection recorded a recurring
  // failure/slow step for this task-kind, avoid that failure mode. Both are
  // derived from real prior-run data and reach the PLANNER (not just synth).
  let learnedContext = "";
  try {
    const { qualityHintFor } = await import("./quality.js");
    const qh = qualityHintFor({ taskKind: learn?.taskKind, persona: learn?.persona });
    if (qh) learnedContext += `\n\n${qh}\n`;
  } catch { /* learning hints are optional */ }
  try {
    const { bottleneckHintFor } = await import("./reflection-bottlenecks.js");
    const bh = bottleneckHintFor({ taskKind: learn?.taskKind, template: learn?.taskKind });
    if (bh) learnedContext += `\n\n${bh}\n`;
  } catch { /* bottleneck index optional */ }

  // Social-media routing hint — publishing vs monitoring both have dedicated
  // primitives; without this the planner reaches for web.* (can't post) or
  // research.deep (can't read our own accounts).
  let socialContext = "";
  if (/\b(post|publish|share|tweet|schedule)\b[^]{0,40}\b(social|twitter|\bx\b|linkedin|facebook|instagram|tiktok|threads|feed|timeline)\b/i.test(task) || /\b(social\s+media|our\s+(mentions|followers|engagement|posts)|(mentions|comments|analytics)\s+on\s+(twitter|linkedin|facebook|instagram|social))\b/i.test(task)) {
    socialContext = `\n\nSocial-media context: the task involves social platforms. PUBLISHING → use social.post {post, platforms:["twitter","linkedin",…], mediaUrls?} — it PARKS FOR APPROVAL before going live (expected; don't treat the park as a failure). MONITORING/READING → social.history (recent posts + their ids), social.analytics {id} (engagement), social.comments {id} (comments/mentions). Do NOT use web.* to post or to read our own accounts. When the ask is about an existing post, get its id from social.history first.\n`;
  }
  // Compact catalog: ~40% smaller prompt → faster planning on small models.
  const sys = injectLanguagePrompt(PLAN_SYSTEM, "plan") + primitivesPromptCatalog({ compact: true }) + vaultContext + researchContext + companyDataContext + localFsContext + githubContext + emailContext + socialContext + activityContext + memoryContext + financeContext + orgContext + imageGenContext + mediaSendContext + scheduleContext + explicitToolContext + workModeContext + fanOutContext + learnedContext;


  // Race the planner LLM call against PLAN_TIMEOUT_MS. If the LLM stalls,
  // we fall back to an empty plan; the caller then uses defaultVaultPlan
  // (research.deep). Better a generic-but-fast plan than a 2-min planner
  // stall that makes the customer think it's hung.
  //
  // Planning is marked complexity:"normal" because the prompt is short
  // (under the 6k-token complexity threshold). When OPENROUTER_API_KEY is
  // set AND OPENROUTER_PROFILES is empty or includes "planning", the
  // dispatcher routes to OR's small/cheap model — typically ~1-2 seconds
  // vs ~30-90 seconds on local Ollama. Customers wanting strict local-only
  // can set OPENROUTER_PROFILES to exclude planning.
  let out: string;
  try {
    out = await Promise.race([
      ollamaGenerate(`Task: ${task}`, sys, {
        profile: "planning",
        onRoutingDecision: push ? (info) => {
          // Only push when planner went remote — the local-Ollama-default
          // case is the silent norm and doesn't deserve a log line.
          if (info.backend === "openrouter") {
            push(`Planning with ${info.model}${info.reason ? ` — ${info.reason}` : ""}.`);
          }
        } : undefined,
      }),
      new Promise<string>((_, rej) =>
        setTimeout(() => rej(new Error(`planner timeout after ${PLAN_TIMEOUT_MS / 1000}s`)), PLAN_TIMEOUT_MS),
      ),
    ]);
  } catch (e: any) {
    console.warn(`[planner] ${e?.message ?? e} — falling back to empty plan; caller will use defaultVaultPlan`);
    return { steps: [] };
  }
  const json = extractJson(out);
  if (!json) return { steps: [] };
  if (!Array.isArray(json.steps)) return { steps: [] };
  // Validate each step references a real tool
  const steps: PlanStep[] = [];
  for (const s of json.steps) {
    if (!s || typeof s.tool !== "string") continue;
    if (!findPrimitive(s.tool)) continue;
    const args = s.args ?? {};
    steps.push({ tool: s.tool, args, rationale: s.rationale, label: humanStepLabel(s.tool, args) });
  }
  const waves = computeWaves(steps);
  return { steps, summary: typeof json.summary === "string" ? json.summary : undefined, waves };
}

// Build dependency graph from $step_<i> references and group steps into "waves"
// — each wave's steps depend only on earlier waves, so they all run in parallel
// as sub-agents.
function computeWaves(steps: PlanStep[]): number[][] {
  const deps: Set<number>[] = steps.map(s => collectDeps(s.args));
  const wave: number[] = new Array(steps.length).fill(-1);
  const result: number[][] = [];
  let placed = 0;
  while (placed < steps.length) {
    const w: number[] = [];
    for (let i = 0; i < steps.length; i++) {
      if (wave[i] !== -1) continue;
      const ready = [...deps[i]].every(d => wave[d] !== -1 && wave[d] < result.length);
      if (ready) w.push(i);
    }
    if (w.length === 0) {
      // Cycle or invalid dep — give up and serialize remaining steps
      for (let i = 0; i < steps.length; i++) if (wave[i] === -1) { wave[i] = result.length; result.push([i]); placed++; }
      break;
    }
    for (const i of w) wave[i] = result.length;
    result.push(w);
    placed += w.length;
  }
  return result;
}

function collectDeps(args: any, acc: Set<number> = new Set()): Set<number> {
  if (typeof args === "string") {
    for (const m of args.matchAll(/\$step_(\d+)/g)) acc.add(Number(m[1]));
  } else if (Array.isArray(args)) {
    for (const v of args) collectDeps(v, acc);
  } else if (args && typeof args === "object") {
    for (const v of Object.values(args)) collectDeps(v, acc);
  }
  return acc;
}

// Sub-agent concurrency budgets. We have two lanes because the two cost
// curves are different:
//   • LLM-bound tools (ollama.generate, research.deep, peer.review,
//     quality.check, peer.delegate) — bottlenecked by the local Ollama model.
//     Running many in parallel only helps if OLLAMA_NUM_PARALLEL is high or
//     idle peers can absorb the work. Default: 3 + 2 per idle peer.
//   • I/O-bound tools (vault.*, github.*, web.fetch, web.scrape, fs.*,
//     clock.*) — bound by network/disk and parallelise great. Default: 6.
//
// NEUROWORKS_SUBAGENT_BUDGET overrides the LLM-lane base. NEUROWORKS_IO_BUDGET
// overrides the I/O lane. Persona-shifter peers can crank both up because
// they're the dedicated worker — their job IS to run as many sub-agents as
// the tools can handle.
const LLM_BASE = Number(process.env.NEUROWORKS_SUBAGENT_BUDGET ?? "3");
const IO_BASE = Number(process.env.NEUROWORKS_IO_BUDGET ?? "6");
const PER_PEER_BONUS = 2;
const HARD_CAP = 12;

const LLM_HEAVY_TOOLS = new Set([
  "ollama.generate", "research.deep", "peer.review", "peer.delegate",
  "quality.check", "synth", "synthesis",
]);

function isLlmHeavy(tool: string): boolean {
  return LLM_HEAVY_TOOLS.has(tool);
}

type Budgets = { llm: number; io: number; idlePeers: number };

// Compute both budgets once at the start of a run, then keep them stable for
// the whole plan. The peer poll is bounded by pollPeers's own 2s/peer timeout
// so an unreachable peer can't stall the run start.
async function computeBudgets(): Promise<Budgets> {
  try {
    const peers = await pollPeers();
    const idleReachable = peers.filter(p => p.ok && p.ready && (p.inflightJobs ?? 0) === 0).length;
    const llm = Math.min(HARD_CAP, Math.max(LLM_BASE, LLM_BASE + idleReachable * PER_PEER_BONUS));
    const io = Math.min(HARD_CAP, Math.max(IO_BASE, IO_BASE + idleReachable));
    return { llm, io, idlePeers: idleReachable };
  } catch {
    return { llm: LLM_BASE, io: IO_BASE, idlePeers: 0 };
  }
}

// Errors that look transient and worth one retry. Network blips, Ollama load
// timeouts, GitHub 5xx — the kind of thing that's usually fine on a second try.
const TRANSIENT_ERROR_RE = /\b(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|abort|timeout|503|502|504|429|empty response body)\b/i;
// Unrecoverable failures — auth, missing model, hard config issues. We do NOT
// retry these (the next attempt will fail the same way) but we ALSO don't
// abort the whole plan: the wave-level check decides whether to continue.
const FATAL_ERROR_RE = /\b(?:401|403|model not found|model not pulled|API key|invalid_request_error|insufficient_quota)\b/i;
// Three retries: 1.5s, 4s, 8s. Was two — the 2026-07-03 reflection found 4 of
// 5 "fetch failed" general-task failures looked transient enough that one
// more, longer-spaced attempt would likely have recovered them.
const STEP_RETRY_BACKOFF_MS = [1500, 4000, 8000];

export async function executePlan(p: Plan, push: (msg: string) => void, onProgress?: (runs: StepRun[]) => void, signal?: AbortSignal): Promise<{ runs: StepRun[]; hadWrites: boolean; budgets?: { llm: number; io: number; idlePeers: number }; subagentTimings?: { wave: number; elapsedMs: number; ioCount: number; llmCount: number }[]; cancelled?: boolean; delegatedApproval?: { tools: string[]; plan?: Plan } }> {
  // Per-run offload archive id — see context-offload.ts. Large step-result
  // fields get archived under .neuroworks/offload/<offloadRunId>/ and
  // replaced in the running history with a short preview, so steps 2..N of
  // a long plan don't each carry a full copy of step 1's raw scrape/read
  // through their own LLM calls.
  const offloadRunId = newOffloadRun();
  const runs: StepRun[] = p.steps.map(step => ({ step, ok: false, durationMs: 0 }));
  let hadWrites = false;
  for (const step of p.steps) {
    const tool = findPrimitive(step.tool)!;
    if (!tool.readonly) hadWrites = true;
  }
  const waves = p.waves && p.waves.length > 0 ? p.waves : p.steps.map((_, i) => [i]);
  let aborted = false;
  // Set when a delegated sub-task (a peer.delegate step) came back parked for
  // approval — the parent stops and the caller re-parks with this sub-plan.
  let delegatedApproval: { tools: string[]; plan?: Plan } | null = null;
  // Resolve both concurrency lanes for this run. The I/O lane stays wider
  // than the LLM lane so vault/web/github sub-agents fan out aggressively
  // while LLM calls respect the local Ollama bottleneck.
  const budgets = await computeBudgets();
  const spinStartedAt = Date.now();
  // Only surface the budget line when an idle peer is boosting capacity (the
  // customer-relevant case — they paid for that worker, show it's helping) or
  // when the budgets exceed the trivial defaults. Otherwise this line is
  // operator-only noise that clutters the chat-side trace.
  if (budgets.idlePeers > 0) {
    push(`Running with help from ${budgets.idlePeers} peer worker${budgets.idlePeers === 1 ? "" : "s"} (capacity ${budgets.llm} thinking + ${budgets.io} I/O sub-agents).`);
  } else if (process.env.NEUROWORKS_VERBOSE === "1") {
    push(`Capacity: ${budgets.llm} thinking + ${budgets.io} I/O sub-agents.`);
  }
  onProgress?.([...runs]);
  // Inform progress callbacks via the runs payload (executePlan only emits
  // runs — we stamp the budget on the first run as a side-channel so the UI
  // can surface it without changing the existing wire shape).

  async function runStep(i: number) {
    if (aborted || signal?.aborted) return;
    const step = p.steps[i];
    const tool = findPrimitive(step.tool)!;
    const args = resolveArgs(step.args, runs);
    push(`Step ${i + 1} of ${p.steps.length}: ${step.label ?? step.tool}`);
    runs[i] = { step, ok: false, durationMs: 0, startedAt: Date.now() };
    onProgress?.([...runs]);
    const t0 = Date.now();

    // Unresolved-reference gate. A whole-string "$step_N..." arg that
    // resolveValue couldn't substitute passes through as the LITERAL
    // placeholder — which downstream tools then treat as a real value
    // (2026-07-10: email.send tried to attach the file
    // "$step_0.matches.0.path" and vault.read tried to open
    // "D:\Main brain\$step_0.matches.0.path"; 6 of that day's 8 tool
    // failures trace to this). Fail the step here with a diagnosis of WHY
    // the reference didn't resolve instead of letting a garbage arg hit an
    // external service.
    for (const [argName, argVal] of Object.entries(args)) {
      const m = typeof argVal === "string" ? argVal.match(/^\$step_(\d+)(\..+)?$/) : null;
      if (!m) continue;
      const refIdx = Number(m[1]);
      const ref = runs[refIdx];
      const why = !ref ? `step ${refIdx + 1} does not exist in this plan`
        : ref.ok !== true ? `step ${refIdx + 1} (${ref.step?.tool ?? "?"}) ${ref.error ? `failed: ${String(ref.error).slice(0, 140)}` : "has not produced a result"}`
        : `step ${refIdx + 1} (${ref.step?.tool ?? "?"}) succeeded but has no value at "${(m[2] ?? "").replace(/^\./, "") || "(root)"}" — likely an empty result (e.g. a search with no matches) or a wrong field name`;
      const msg = `arg "${argName}" references ${argVal} which could not be resolved: ${why}`;
      runs[i] = { step, ok: false, error: msg, durationMs: Date.now() - t0, startedAt: t0 };
      push(`  ✗ ${step.label ?? step.tool}: ${msg.slice(0, 200)}`);
      onProgress?.([...runs]);
      return;
    }

    // Governance gate — runs BEFORE the tool call, only for side-effecting
    // tools (email.send, vault.write, github.*, webhook/chat posts, payments,
    // db.write, code.exec — see CONSEQUENTIAL_TOOLS). Checks the step's
    // resolved args against accepted+reviewed HARD constraints extracted from
    // policy docs under Governance. This is the actual enforcement point —
    // the governance system-prompt prefix (see loadGovernancePrefix above)
    // only ever asked the model nicely not to violate a policy; this blocks
    // the tool call outright when a hard constraint matches, same failure
    // mode as the org-policy incident this was built to prevent (an accepted
    // "never email outside the finance domain" rule sitting inert in the
    // review UI while email.send fired anyway). Wrapped in try/catch and
    // fails OPEN on any internal error — governance must never be the reason
    // an unrelated task breaks.
    try {
      const { checkStepAgainstGovernance } = await import("./governance.js");
      const gate = checkStepAgainstGovernance(step.tool, args);
      if (gate.blocked) {
        const reason = gate.violations.map(v => `"${v.rule}" (policy: ${v.policyName})`).join("; ");
        const msg = `Blocked by governance policy — ${reason}`;
        runs[i] = { step, ok: false, error: msg, durationMs: Date.now() - t0, startedAt: t0 };
        push(`  ⛔ ${step.label ?? step.tool}: ${msg}`);
        onProgress?.([...runs]);
        try {
          const { logAudit } = await import("./audit-log.js");
          logAudit({ level: "warn", actor: "governance", action: "governance.block_step", target: step.tool, detail: reason.slice(0, 200), result: "failure" });
        } catch { /* audit is best-effort */ }
        return;
      }
    } catch { /* governance is non-fatal — never block a task on its own failure */ }
    let attempt = 0;
    while (true) {
      try {
        const result = await tool.handler(args);
        // ollama.generate returns { text, model } so we capture the model used.
        // Other tools just leave modelUsed undefined.
        const modelUsed = result && typeof result === "object" && "model" in result ? String((result as any).model) : undefined;
        const offloadedResult = offloadLargeFields(offloadRunId, i, step.tool, result);
        runs[i] = { step, ok: true, result: offloadedResult, durationMs: Date.now() - t0, startedAt: t0, modelUsed };
        onProgress?.([...runs]);
        // A delegated sub-task came back parked for approval (its plan hit the
        // sensitive-action checkpoint on the worker). We can't approve a
        // worker's job from here, so stop and hand the sub-plan up — the caller
        // re-parks THIS job and, on approval, replays the sub-plan locally.
        if (step.tool === "peer.delegate" && result && typeof result === "object"
            && ((result as any).status === "awaiting-approval" || (result as any).approvalRequired)) {
          const ar = (result as any).approvalRequired;
          const subPlan = (result as any).plan;
          const fallbackTools = Array.isArray(ar?.tools) && ar.tools.length ? ar.tools : await planSensitiveTools(subPlan);
          delegatedApproval = {
            tools: fallbackTools,
            plan: subPlan,
          };
          aborted = true;
          push(`⏸ A delegated sub-task needs your approval (${delegatedApproval.tools.join(", ")}) before it can run — parking this task for sign-off.`);
          return;
        }
        // A human.request step means the plan cannot proceed without the
        // operator — stop launching later waves. The caller detects the
        // request in the runs and parks the job in waiting_on_human; the
        // remaining work happens in the continuation job once the human
        // supplies what's needed.
        if (step.tool === "human.request") {
          aborted = true;
          push(`⏸ Pausing here — this task needs input from you before the remaining steps can run.`);
        }
        return;
      } catch (e: any) {
        const msg = String(e.message ?? e);
        // Up to TWO retries on transient errors with growing backoff. Real
        // network blips, brief rate limits, undici socket hang-ups — these
        // recover within seconds, so a single retry sometimes wasn't enough.
        if (attempt < STEP_RETRY_BACKOFF_MS.length && TRANSIENT_ERROR_RE.test(msg) && !FATAL_ERROR_RE.test(msg)) {
          const wait = STEP_RETRY_BACKOFF_MS[attempt];
          attempt++;
          push(`  ⟳ ${step.label ?? step.tool}: transient error (attempt ${attempt}/${STEP_RETRY_BACKOFF_MS.length}), retrying in ${(wait / 1000).toFixed(1)}s — ${msg.slice(0, 120)}`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        runs[i] = { step, ok: false, error: msg, durationMs: Date.now() - t0, startedAt: t0 };
        // DO NOT abort the whole plan on a single step failure. A fan-out
        // wave (multiperspective research, parallel scrapers) often has 4+
        // steps and losing one shouldn't doom the rest. The wave-level
        // check below decides whether enough succeeded to keep going.
        push(`  ✗ ${step.label ?? step.tool}: ${msg.slice(0, 200)}`);
        onProgress?.([...runs]);
        return;
      }
    }
  }

  const subagentTimings: { wave: number; elapsedMs: number; ioCount: number; llmCount: number }[] = [];
  for (let w = 0; w < waves.length; w++) {
    if (aborted) break;
    // Operator cancelled — stop launching further waves. Returns cancelled:true
    // so planAndExecute can short-circuit synthesis (no point drafting an
    // answer over a run the user stopped).
    if (signal?.aborted) {
      push(`⏹ Cancelled — stopping before wave ${w + 1}.`);
      return { runs, hadWrites, budgets, subagentTimings, cancelled: true };
    }
    const ids = waves[w];
    // Track wave-level success/failure. If EVERY step in a wave fails we
    // abort — there's nothing downstream can build on. But if at least one
    // succeeds, we continue: the wave produced partial evidence the next
    // wave (and the synth) can use.
    const waveStepIds = [...ids];
    if (ids.length > 1) {
      const llmIds = ids.filter(i => isLlmHeavy(p.steps[i].tool));
      const ioIds = ids.filter(i => !isLlmHeavy(p.steps[i].tool));
      const waveStartedAt = Date.now();
      push(`Running ${ids.length} sub-agents in parallel (${ioIds.length} I/O + ${llmIds.length} thinking).`);
      // Run the lanes in parallel against each other. Within a lane we chunk
      // to respect the budget. I/O sub-agents start FIRST so they have a head
      // start (they're typically faster); LLM sub-agents follow on the LLM
      // lane while I/O is still finishing — most plans gate the LLM step on
      // the I/O step's output anyway, but when they don't this is a free win.
      const ioPromise = (async () => {
        for (let off = 0; off < ioIds.length; off += budgets.io) {
          if (aborted) break;
          const chunk = ioIds.slice(off, off + budgets.io);
          await Promise.all(chunk.map(runStep));
        }
      })();
      const llmPromise = (async () => {
        for (let off = 0; off < llmIds.length; off += budgets.llm) {
          if (aborted) break;
          const chunk = llmIds.slice(off, off + budgets.llm);
          await Promise.all(chunk.map(runStep));
        }
      })();
      await Promise.all([ioPromise, llmPromise]);
      const waveMs = Date.now() - waveStartedAt;
      subagentTimings.push({ wave: w + 1, elapsedMs: waveMs, ioCount: ioIds.length, llmCount: llmIds.length });
      const okInWave = waveStepIds.filter(idx => runs[idx]?.ok).length;
      const failedInWave = waveStepIds.length - okInWave;
      if (failedInWave > 0) {
        push(`Wave ${w + 1} finished in ${(waveMs / 1000).toFixed(1)}s — ${okInWave} of ${waveStepIds.length} sub-agents succeeded (${failedInWave} failed; partial results kept).`);
      } else {
        push(`Wave ${w + 1} finished in ${(waveMs / 1000).toFixed(1)}s.`);
      }
    } else {
      // Single-step wave — no lane split needed.
      const tSingle = Date.now();
      await runStep(ids[0]);
      const stepTool = p.steps[ids[0]].tool;
      subagentTimings.push({ wave: w + 1, elapsedMs: Date.now() - tSingle, ioCount: isLlmHeavy(stepTool) ? 0 : 1, llmCount: isLlmHeavy(stepTool) ? 1 : 0 });
    }
    // Wave-level abort gate: only abort if EVERY step in this wave failed
    // AND the failure was something downstream can't recover from. A
    // single-step wave that fails on a single-step plan obviously means
    // there's nothing left to synthesize; multi-step waves get to keep
    // going as long as at least one perspective succeeded.
    const okInWave = waveStepIds.filter(idx => runs[idx]?.ok).length;
    if (okInWave === 0 && waveStepIds.length > 0) {
      // Special tolerance: if a SUBSEQUENT wave succeeded earlier or there
      // are still later waves to try, we don't abort — synth can work from
      // anything we've gathered so far. But if this was the FIRST wave and
      // it produced nothing, there's no evidence to build on, so we stop.
      const anySucceededOverall = runs.some(r => r.ok);
      if (!anySucceededOverall && w === 0) {
        push(`First wave had no successful sub-agents — stopping early. I'll summarise what was tried and why it didn't land.`);
        aborted = true;
      }
    }
  }
  const totalSpinMs = Date.now() - spinStartedAt;
  push(`All sub-agents finished in ${(totalSpinMs / 1000).toFixed(1)}s.`);
  return { runs, hadWrites, budgets, subagentTimings, delegatedApproval: delegatedApproval ?? undefined };
}

// Auto-review is opt-out via env. Skipped automatically when the answer is
// trivial (under MIN_REVIEW_CHARS) or no peer is reachable. This makes the
// behavior degrade cleanly on single-clawbot setups.
const AUTO_REVIEW = process.env.NEUROWORKS_AUTO_REVIEW !== "0";
const MIN_REVIEW_CHARS = 120;

// Build a compact, numbered evidence string from successful step runs.
// quality.check accepts a `sources` arg — without it the scorer is grading
// citation_coverage blind. Format mirrors the catalog the synth saw so the
// scorer can match the draft's [N] markers back to real sources.
function buildEvidenceCatalog(runs: StepRun[]): string {
  const ok = runs.filter(r => r.ok && r.step.tool !== "quality.check" && r.step.tool !== "security.scan" && r.step.tool !== "peer.review");
  if (ok.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < ok.length; i++) {
    const r = ok[i];
    const result: any = r.result;
    let body = "";
    if (typeof result === "string") body = result;
    else if (result && typeof result === "object") {
      if (typeof result.answer === "string") body = result.answer;
      else if (typeof result.text === "string") body = result.text;
      else if (typeof result.content === "string") body = result.content;
      else if (Array.isArray(result.matches)) body = result.matches.slice(0, 6).map((m: any) => `${m.path ?? "?"}: ${(m.preview ?? "").slice(0, 120)}`).join("\n");
      else if (Array.isArray(result.results)) body = result.results.slice(0, 6).map((m: any) => `${m.title ?? m.path ?? m.url ?? "?"} — ${(m.snippet ?? m.preview ?? "").slice(0, 120)}`).join("\n");
      else if (Array.isArray(result.webSources)) body = result.webSources.slice(0, 6).map((s: any, i: number) => `[${i + 1}] ${s.title ?? s.url}`).join("\n");
      else { try { body = JSON.stringify(result); } catch { body = ""; } }
    }
    body = String(body).slice(0, 1500);
    if (!body) continue;
    const args = r.step.args ?? {};
    const provenance: string[] = [];
    for (const k of ["url", "path", "query", "name", "repo", "owner"]) {
      const v = (args as any)[k];
      if (typeof v === "string") provenance.push(`${k}="${v.slice(0, 60)}"`);
    }
    lines.push(`[${i + 1}] ${r.step.tool}${provenance.length ? ` (${provenance.join(", ")})` : ""}\n${body}`);
  }
  return lines.join("\n\n").slice(0, 8000);
}
// Triage skips the planner for short conversational/world-knowledge prompts.
// Set NEUROWORKS_TRIAGE=0 to disable. The triage call uses the smallest available
// model so the shortcut path is much faster than full plan→execute→synth.
const TRIAGE_ENABLED = process.env.NEUROWORKS_TRIAGE !== "0";
const TRIAGE_MAX_CHARS = 200;

// Heuristic prefilter: certain shapes are obviously direct-answer (greetings,
// simple math, "what is/are" world-knowledge questions) — skip the LLM triage
// call entirely. Saves 2-5s per simple task on local Ollama. The LLM triage
// handles the ambiguous middle.
//
// Anything that name-drops vault/notes/brain, a file path, a URL, a repo, or a
// "search/find/look up" verb is NOT direct — those need tools and must reach
// the planner. The vault-hits check downstream still vetoes a direct path
// when the user's notes actually cover the topic.
const TOOL_CUES = /\b(?:my\s+(?:vault|notes?|brain|second\s+brain|repos?|files?|docs?|inbox)|the\s+(?:vault|repo|repository|inbox)|in\s+(?:my|the)\s+(?:vault|notes?|brain|repo|inbox|files?|docs?)|find|search|look\s+(?:up|for|inside)|browse|fetch|scrape|read\s+\S+\.(?:md|pdf|docx|xlsx|txt|json|yaml|yml|csv)|github\.com|https?:\/\/|[a-zA-Z]:\\|\/[\w-]+\/[\w-]+|\.md\b|\.pdf\b|\.docx\b)/i;
export function looksLikeDirectAnswer(task: string): boolean {
  const t = task.trim();
  if (t.length === 0 || t.length > TRIAGE_MAX_CHARS) return false;
  const lower = t.toLowerCase();
  // Tool-cue blocklist applies to every direct-answer pattern below.
  if (TOOL_CUES.test(t)) return false;
  // Company-internal structure questions need the org's own records
  // (users.list / personas.list / org.* / company.department_data) — never
  // world knowledge, no matter how short the prompt is.
  if (ORG_STRUCTURE_RE.test(t)) return false;
  // Image generation + studio-model discovery are tool tasks (media.image /
  // media.studio_models), never a direct persona answer — a persona whose
  // lane isn't design would otherwise refuse ("outside my lane").
  if (IMAGE_GEN_RE.test(t) || AD_CREATIVE_RE.test(t)) return false;
  if (/\b(?:image|studio|generation|generative)\s+models?\b/i.test(t)) return false;
  // Notepad reads are a tool task (system.notepad), never a direct answer —
  // a persona would otherwise "answer" from thin air about the user's notes.
  if (NOTEPAD_RE.test(t)) return false;
  // Sending an email is always a tool task (email.send) — never a chat reply.
  if (EMAIL_SEND_RE.test(t)) return false;
  // Social-media posting/monitoring is a tool task (social.*), never direct.
  if (SOCIAL_TASK_RE.test(t)) return false;
  if (/^(?:hi|hello|hey|yo|sup|good\s+(?:morning|afternoon|evening)|thanks?|thank\s+you|bye|goodbye|cool|ok|okay|got\s+it|nice|sweet|sounds\s+good)\b[\s!,.?]*$/i.test(lower)) return true;
  // Single-word affirmations / non-questions.
  if (/^\s*(?:yes|yeah|yep|sure|fine|no|nope|nah|maybe|idk)[\s!.?]*$/i.test(lower)) return true;
  if (/^[\d\s+\-*/().,]+\??$/.test(lower) && /\d/.test(lower)) return true; // pure arithmetic
  // World-knowledge question shapes — short prompts with no tool cues.
  // "what is X" / "what are X" / "what's X" / "whats X" / "what does X mean"
  // (apostrophe in "what's" is optional — users frequently type "whats")
  if (/^\s*what(?:'?s|\s+is|\s+are|\s+does|\s+do)\s+\S/i.test(t) && t.length <= 120) return true;
  // "define X" / "explain X" / "describe X" / "tell me about X" with no tool cues
  if (/^\s*(?:define|explain|describe|clarify|elaborate(?:\s+on)?)\s+\S/i.test(t) && t.length <= 120) return true;
  // "how do/does/can/should/would X" / "how long/much/many/big X"
  if (/^\s*how\s+(?:do|does|can|should|would|long|much|many|big|small|fast|slow|often|come|to)\b/i.test(t) && t.length <= 140) return true;
  // "why is/are/does X" / "when is/was/did X" / "where is/are X"
  if (/^\s*(?:why|when|where|who|which)\s+(?:is|are|was|were|did|does|do|will|would|should|can)\b/i.test(t) && t.length <= 140) return true;
  // "can you X" / "could you X" where X is a reasoning task (not a tool task)
  if (/^\s*(?:can|could)\s+you\s+(?:help|explain|describe|tell|clarify|elaborate|summari[sz]e|recommend|suggest)\b/i.test(t) && t.length <= 140) return true;
  // Pure "compare X and Y" / "X vs Y" reasoning prompts
  if (/^\s*(?:compare|contrast)\s+\S+\s+(?:and|vs\.?|versus|with|to)\s+\S/i.test(t) && t.length <= 160) return true;
  return false;
}

// True when the prompt is the kind of trivial input where world knowledge
// is the right tier and NEITHER the vault NOR web research would help:
// greetings, pure arithmetic, single-word affirmations. These bypass the
// "if direct, try heuristicPlan first" cascade rule — we send them straight
// to world knowledge without checking for `aboutMatch` etc.
//
// `hasPriorTurnContext` — when the full task includes thread-context
// wrapping (e.g. "Current request (after prior turns about X): yes"),
// affirmations like "yes" / "no" / "maybe" are meaningful answers to a
// prior question and SHOULD route trivially. Without that wrapping,
// a bare "yes" is meaningless — the cold-start user has nothing to
// affirm — so we let it fall through to the LLM which will at least
// ask "yes to what?" rather than hallucinate a confident response.
export function isTriviallyDirectAnswer(task: string, hasPriorTurnContext = true): boolean {
  const t = task.trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  // Greetings, thanks, farewells — never benefit from vault/web.
  if (/^(?:hi|hello|hey|yo|sup|good\s+(?:morning|afternoon|evening)|thanks?|thank\s+you|bye|goodbye|cool|ok|okay|got\s+it|nice|sweet|sounds\s+good)\b[\s!,.?]*$/i.test(lower)) return true;
  // Arithmetic-only (with or without "what is" prefix).
  if (/^[\d\s+\-*/().,]+\??$/.test(lower) && /\d/.test(lower)) return true;
  if (/^\s*what(?:'?s|\s+is)\s+[\d\s+\-*/().,]+\??$/i.test(lower)) return true;
  // Single-word affirmations / non-questions. Only trivial when we have
  // prior-turn context for them to answer to.
  if (/^\s*(?:yes|yeah|yep|sure|fine|no|nope|nah|maybe|idk)[\s!.?]*$/i.test(lower)) {
    return hasPriorTurnContext;
  }
  return false;
}

// Detect whether the enriched task carries prior-turn context. Used by
// the affirmation branch of isTriviallyDirectAnswer to distinguish
// "yes" answering a question we asked from "yes" arriving cold.
function taskHasPriorTurnContext(fullTask: string): boolean {
  // The thread-context wrapper inserted by chat.ts/templates.ts looks
  // like "Current request (after prior turns about X): <bare ask>".
  return /Current request \([^)]*\):/i.test(fullTask);
}

// Ask the smallest available model "does this need tools, or can you answer
// directly from world knowledge?". Returns true → direct, false → plan.
async function llmTriage(task: string): Promise<boolean> {
  // Company-internal questions can NEVER be answered from world knowledge —
  // the answer lives in the org's own records (users directory, persona
  // roster, org chart, department data). The small triage model reliably
  // misclassifies these as DIRECT ("What departments exist in our
  // organization?" → confident refusal about not knowing 'Aiia'), so veto
  // before it gets a vote. Same guard class as TOOL_CUES, kept here because
  // the persona preamble pushes these tasks past looksLikeDirectAnswer's
  // length cap and into this LLM path.
  if (ORG_STRUCTURE_RE.test(task)) return false;
  // Image / studio-model tasks are tool work — never a direct answer.
  if (IMAGE_GEN_RE.test(task) || AD_CREATIVE_RE.test(task) || /\b(?:image|studio|generation|generative)\s+models?\b/i.test(task)) return false;
  if (NOTEPAD_RE.test(task)) return false;
  if (EMAIL_SEND_RE.test(task)) return false;
  // Social-media posting/monitoring is tool work (social.*) — the org's own
  // channels, never world knowledge. The small triage model calls "check our
  // social engagement" DIRECT and then apologises about having no data.
  if (SOCIAL_TASK_RE.test(task)) return false;
  const sys = `Classify whether the user's task can be answered DIRECTLY from world knowledge alone, or whether it needs tools (vault search, GitHub, web, file system).

Reply with exactly one word: DIRECT or TOOLS.

DIRECT examples: small talk, definitions, general knowledge, simple math, programming concepts, advice, reasoning puzzles.
TOOLS examples: anything mentioning "my vault/notes/brain", repo names, file paths, URLs, "what's in X", "summarize X", "find X", "scrape X".`;
  try {
    // The classifier returns a single word — 16 tokens is generous. Tight
    // num_predict means the small triage model stops generating as soon as
    // it's emitted DIRECT or TOOLS, shaving 1-3s off this call on local
    // Ollama compared to the default 1024-token budget.
    const out = await ollamaGenerate(`Task: ${task}\n\nClassification:`, sys, { profile: "triage", maxTokens: 16 });
    return /\bDIRECT\b/i.test(out.trim().slice(0, 30));
  } catch { return false; }
}

// Pull the structured human ask out of a finished run list. The human.request
// primitive returns { humanRequest } as its result; the LAST successful one
// wins (there's normally only one — the executor aborts the plan on it).
function extractHumanRequest(runs: StepRun[]): HumanRequest | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.ok && r.step.tool === "human.request" && r.result && typeof r.result === "object") {
      const hr = (r.result as any).humanRequest;
      if (hr && Array.isArray(hr.items) && hr.items.length > 0) return hr as HumanRequest;
    }
  }
  return undefined;
}

// The customer-facing text shown while a task waits on its human. Kept short —
// the structured items render as real input fields in the Tasks page; this is
// just the narrative line above them.
function humanWaitAnswer(hr: HumanRequest): string {
  const lines = [
    `⏸ **Waiting on you** — I've done what I can on my side. To finish this task I need:`,
    "",
    ...hr.items.map((it, i) => `${i + 1}. ${it.prompt}${it.type !== "answer" ? ` _(${it.type})_` : ""}`),
  ];
  if (hr.reason) lines.push("", `Why: ${hr.reason}`);
  lines.push("", `Reply on the Tasks page (or re-run this task with the missing details) and I'll pick up where I left off.`);
  return lines.join("\n");
}

export async function planAndExecute(
  task: string,
  push: (msg: string) => void,
  onProgress?: (patch: Partial<AgentResult> & { phase?: string }) => void,
  opts: { personaSystemSuffix?: string; autoReview?: boolean; preplan?: Plan; workMode?: "agent" | "hybrid" | "human"; testMode?: boolean; signal?: AbortSignal; skipApprovalGate?: boolean; taskKind?: string; persona?: string } = {},
): Promise<AgentResult> {
  // Human-worker gate: a hire whose workMode is "human" doesn't get an agent
  // loop at all — the task is logged, parked in waiting_on_human, and the
  // person does the work. The system's job here is tracking (who owes what,
  // for how long), not doing.
  if (opts.workMode === "human") {
    const hr: HumanRequest = {
      items: [{ type: "action", prompt: `Complete this task and report back with the outcome or deliverable: ${parseUserRequestFromTask(task).slice(0, 600)}` }],
      reason: "This role is staffed by a human worker — the system tracks the work; a person performs it.",
      requestedAt: new Date().toISOString(),
    };
    push(`This hire is a human worker — parking the task in the waiting queue instead of running the agent loop.`);
    return { task, plan: { steps: [] }, runs: [], answer: humanWaitAnswer(hr), hadWrites: false, humanRequest: hr };
  }
  // CRITICAL: every heuristic below MUST run against the bare user text, not
  // the enriched task (which is prefixed with persona framing + thread
  // context + interpretation/deliverable blocks). Otherwise:
  //   • looksLikeDirectAnswer fails the `^\s*<verb>` check
  //   • heuristicPlan fails the URL/path/topic regex anchors
  //   • extractTopic returns the persona framing as the "topic"
  //   • defaultVaultPlan passes that garbage as the research query
  // This bug produced 5-minute fallbacks on requests that should have
  // matched the URL-only heuristic in milliseconds (e.g. "fetch http://...").
  // We compute bareTask once and thread it through every heuristic.
  const bareTask = parseUserRequestFromTask(task);
  const fromTemplate = taskWasTemplated(task);

  // Memory intent — "remember that …" / "what do you remember about …" must go
  // through the PLANNER (which has the memory.* routing hint), NOT the triage→
  // direct-answer shortcut or the creative/procedural forceDirect path. Both of
  // those skip tools entirely, so a short recall like "what do you remember
  // about the Q3 board meeting?" was answered from thin air in ~9s instead of
  // calling memory.search. Detect it here and force the tool-using plan path.
  // Require an object keyword after "remember" so the WRITE pattern doesn't also
  // match the recall question "what do you remember ABOUT x" (no that/this/the…).
  const MEM_REMEMBER_RE = /\b(remember\s+(that|this|to|the|my|our)|note\s+(that|down)|make\s+a\s+note|keep\s+in\s+mind|don'?t\s+forget|store\s+(that|this)|for\s+future\s+reference|take\s+note)\b/i;
  const MEM_RECALL_RE = /\b(what\s+do\s+(you|we)\s+(remember|know)|do\s+you\s+remember|recall(?:\s+(what|anything|the))?|on\s+file\s+about|what\s+(have|did)\s+(you|we)\s+(note|record|store|save)|from\s+(your\s+)?memory|what\s+do\s+you\s+have\s+on)\b/i;
  const memoryIntent = !fromTemplate && (MEM_REMEMBER_RE.test(bareTask) || MEM_RECALL_RE.test(bareTask));
  // Daily-briefing intent — must use calendar.plan_day (meetings + scheduled
  // tasks + DATED MEMORY COMMITMENTS + carryover), not calendar.activity (which
  // only has past jobs and no commitments). The free-tier planner picks between
  // them nondeterministically, so pin it.
  const BRIEFING_RE = /\b(daily|morning)\s+brief(ing)?\b|\bbrief\s+me\s+on\s+(my\s+)?(day|today)\b|\b(plan|plan\s+out)\s+my\s+day\b|\bwhat'?s\s+on\s+(for\s+)?(my\s+)?(today|day)\b/i;
  const briefingIntent = !fromTemplate && BRIEFING_RE.test(bareTask);

  // Governance prefix — admin-curated policies under _governance/ in the
  // vault get prepended to the persona suffix so every downstream LLM call
  // (planner, synth, direct-answer, rescue retries) sees them as system
  // constraints. Cached for 60s on the governance side so this is cheap.
  // Empty string when no policies exist, so the concat is safe either way.
  try {
    const { loadGovernancePrefix } = await import("./governance.js");
    const govPrefix = loadGovernancePrefix();
    if (govPrefix) {
      opts = { ...opts, personaSystemSuffix: govPrefix + (opts.personaSystemSuffix ?? "") };
    }
  } catch { /* governance is non-fatal — never block a task on its absence */ }

  // Pre-planned execution. Custom templates ship with a saved plan that was
  // verified the first time it ran via the agent. When the caller supplies
  // `opts.preplan`, skip all triage / heuristic / LLM planning and jump
  // straight to executing that plan + synthesising an answer. Without this
  // path, saved-plan customs returned raw {plan, runs, ...} JSON with no
  // `answer` field — the customer saw machine output instead of a written
  // reply.
  if (opts.preplan && opts.preplan.steps.length > 0) {
    push(`Replaying a saved plan — ${opts.preplan.steps.length} step${opts.preplan.steps.length === 1 ? "" : "s"}.`);
    const p: Plan = opts.preplan;
    onProgress?.({ plan: p, phase: "executing" });
    const runsBuffer: StepRun[] = [];
    const { runs, hadWrites } = await executePlan(p, push, (rs) => {
      runsBuffer.splice(0, runsBuffer.length, ...rs);
      onProgress?.({ runs: [...rs] });
    });
    const preplanHumanReq = extractHumanRequest(runs);
    if (preplanHumanReq) {
      return { task, plan: p, runs, answer: humanWaitAnswer(preplanHumanReq), hadWrites, humanRequest: preplanHumanReq };
    }
    onProgress?.({ phase: "synthesizing", runs });
    const synth = await synthesize(task, p, runs, opts.personaSystemSuffix, (partial) => {
      onProgress?.({ partialAnswer: partial });
    }, { push });
    return { task, plan: p, runs, answer: synth.answer, hadWrites };
  }

  // Creative / procedural deliverables (marketing copy, runbooks, how-tos)
  // draw on the persona's own knowledge — they have nothing external to cite.
  // Route them straight to a persona-knowledge direct answer instead of running
  // speculative web research that yields thin "sources" (which then drag the
  // citation grader down) and wastes 1-3 minutes. Honour explicit research
  // signals ("latest", "search", "our docs", a URL) — those mean the user
  // wants grounding — and never override a template-driven run.
  const deliverableClass = classifyDeliverable(bareTask);
  // A task that literally names a registered tool must NEVER shortcut to a
  // toolless direct answer — "Create a Paynow payment … using the
  // payment.paynow_link tool" classified as creative and got a prose reply
  // instead of the payment (caught live 2026-07-04).
  const namesRegisteredTool = primitives.some(pr => new RegExp(`\\b${pr.name.replace(/\./g, "\\.")}\\b`).test(bareTask));
  const forceDirect = !fromTemplate
    && !memoryIntent
    && !briefingIntent
    && !namesRegisteredTool
    && (deliverableClass === "creative" || deliverableClass === "procedural")
    && !taskWantsResearch(bareTask);
  if (forceDirect) {
    // Marketing copy / runbooks / how-tos draw on the persona's own knowledge,
    // not external sources. Synthesize the deliverable directly — no research
    // steps that would yield thin "sources" (which then drag the citation
    // grader down) and waste 1-3 minutes. Routed through synthesize() with an
    // empty plan, which has a knowledge-deliverable branch that uses the full
    // deliverable prompt + a generous token budget (POLISHED_DIRECT's brevity
    // + anti-hallucination framing would truncate a runbook or make the model
    // ask questions instead of drafting the copy).
    push(`This is a ${deliverableClass} deliverable — drafting it directly from professional knowledge (no web research needed for this shape).`);
    const emptyPlan: Plan = { steps: [], summary: `${deliverableClass} deliverable — drafted from professional knowledge`, waves: [] };
    onProgress?.({ phase: "synthesizing", plan: emptyPlan, runs: [] });
    const synth = await synthesize(task, emptyPlan, [], opts.personaSystemSuffix, (partial) => {
      onProgress?.({ partialAnswer: partial });
    }, { push });
    return { task, plan: emptyPlan, runs: [], answer: synth.answer, hadWrites: false };
  }

  // Triage first — the cheapest possible path is skipping the planner entirely
  // for prompts that don't need tools. Total round-trip drops from ~3min to
  // ~10-20s for trivial tasks.
  //
  // SPEED OPTIMISATION: triage LLM call + vault pre-check run in parallel.
  // The LLM triage costs ~1-3s; vault search costs ~10-50ms. Running them
  // sequentially wasted the vault budget. Now they overlap and the result
  // is combined: if EITHER (a) triage said DIRECT AND (b) vault has no
  // hits, we take the direct-answer path. Otherwise plan.
  //
  // EXCEPTION: when the task came in via a chat template (Topic: suffix),
  // the customer explicitly asked for that template's behavior — Quick web
  // look-up wants the web, Multi-perspective wants the fan-out. We must NOT
  // shortcut to a direct LLM answer in that case even when the topic itself
  // looks like a definition question.
  if (!fromTemplate && !memoryIntent && !briefingIntent && TRIAGE_ENABLED && bareTask.length > 0 && bareTask.length <= TRIAGE_MAX_CHARS) {
    const heuristicDirect = looksLikeDirectAnswer(bareTask);
    const topic = extractTopic(bareTask);
    // Vault pre-check uses the filename-only scan: we only need a yes/no
    // signal "does the user have notes on this topic?" and the full content
    // search takes 10-15s on a multi-thousand-note vault. Filename scan
    // returns in ~50-200ms. The content search still runs later inside the
    // research primitives when we actually need real matches.
    const [llmDirect, vaultHits] = await Promise.all([
      heuristicDirect ? Promise.resolve(true) : llmTriage(bareTask).catch(() => false),
      (topic && topic.length >= 2)
        ? Promise.resolve().then(() => { try { return searchVaultFilenames(topic, 1); } catch { return []; } })
        : Promise.resolve([] as { path: string; line: number; preview: string }[]),
    ]);
    let direct = llmDirect;
    // Vault override: if filename scan hit AND the topic is non-trivial,
    // we'd rather use the user's own notes than world knowledge. Trivial
    // inputs (greetings, arithmetic) bypass this — "hi" matching a note
    // called "hi-everyone.md" shouldn't promote a greeting to vault search.
    //
    // EXCLUDE agent-internal job tracker files (_neuroworks/jobs/*) —
    // those are scratch records of past runs ("Research: who is X"),
    // not real user knowledge. Without this filter, the second run of
    // any query routes itself to research.deep because the FIRST run's
    // job-tracker file matched the topic name. Round-2 harness hit this
    // for "who is dario amodei" — the bare entity query stayed in
    // research mode (which couldn't find him) instead of falling through
    // to direct-answer / world knowledge.
    const realVaultHits = vaultHits.filter(h => !/^_neuroworks\/jobs\//i.test(h.path));
    const priorContext = taskHasPriorTurnContext(task);
    if (direct && realVaultHits.length > 0 && !isTriviallyDirectAnswer(bareTask, priorContext) && topic && topic.length >= 3) {
      push(`Tier 2 — your second brain: found ${realVaultHits.length} note${realVaultHits.length === 1 ? "" : "s"} on "${topic}". Pulling those in instead of going to general knowledge.`);
      direct = false;
    }
    // CONTEXT CASCADE: even when triage thinks "direct answer is fine", we
    // still defer to heuristicPlan if it recognises a shape that includes
    // tools. The cascade we want is:
    //   1. chat input (already in `task` via buildEnrichedTask)
    //   2. vault (heuristicPlan's vault/research.deep paths)
    //   3. web (research.deep / web.search)
    //   4. world knowledge (this direct-answer path) — final fallback only
    // For "what is hanta virus" with empty vault, that means research.deep
    // (vault + web) runs BEFORE we settle for the model's training data.
    // World knowledge only kicks in when no heuristic shape matches AND
    // the question is conversational / definitional with no topic worth
    // researching.
    //
    // EXCEPTION: truly trivial inputs (greetings, arithmetic, "yes"/"no")
    // never benefit from vault or web — bypass the cascade and answer
    // directly. Without this guard, "what is 2+2" would needlessly route
    // to research.deep.
    if (direct && !isTriviallyDirectAnswer(bareTask, priorContext)) {
      const speculativeHeuristic = heuristicPlan(bareTask, { hasAttachments: /\nAttached documents \(user uploaded as context/.test(task) });
      const wantsResearch = speculativeHeuristic && speculativeHeuristic.steps.length > 0
        && speculativeHeuristic.steps.some(s => s.tool === "research.deep" || s.tool === "web.search" || s.tool === "vault.search");
      // Short-definitional override: when the query is a definitional
      // explainer shape (looksLikeDirectAnswer already returned true) AND
      // the bare task is short (≤ 80 chars) AND the vault filename scan
      // surfaced no real hits, the model's training knowledge is the
      // right tier. Routing through research.deep on free-tier OR often
      // returns thin/irrelevant evidence and the small synth model then
      // refuses despite Rule 0 — the TCP-vs-UDP regression hit this
      // path. We trust direct-answer + POLISHED_DIRECT's anti-
      // hallucination guard for short questions about likely-known
      // concepts; longer / vault-rooted queries still route through
      // research.
      const isShortDefinitional = bareTask.length <= 80;
      if (wantsResearch && !isShortDefinitional) {
        push(`Tier 2/3 — checking your second brain first, then the web if needed (instead of guessing from general knowledge).`);
        direct = false;
      } else if (wantsResearch && isShortDefinitional) {
        push(`Tier 4 — short definitional question with no relevant vault notes; answering from training knowledge.`);
      }
    }
    if (direct) {
      // Tier 4 — final fallback. World knowledge only. We ALSO race a
      // capped vault content search in parallel: if the second brain
      // actually has matter on this topic by the time the LLM finishes,
      // we'll have grounded the answer; if not, we use world knowledge
      // cleanly. 1.5s cap so a big vault never blocks a trivial answer.
      push(`Tier 4 — general knowledge. (Your second brain has no notes on this; no web search needed for the shape.)`);
      onProgress?.({ phase: "synthesizing" });
      const vaultContentRace: Promise<{ path: string; line: number; preview: string }[]> = (topic && topic.length >= 2)
        ? Promise.race([
            new Promise<any[]>((resolve) => {
              // Lazy-import the slow content scan only when we actually need
              // it — keeps the hot-path triage scan fast.
              import("./vault.js").then(({ searchVault }) => {
                try { resolve(searchVault(topic, 3)); } catch { resolve([]); }
              }).catch(() => resolve([]));
            }),
            new Promise<any[]>(resolve => setTimeout(() => resolve([]), 1500)),
          ])
        : Promise.resolve([]);
      // Trivial inputs (greetings, arithmetic, single-word affirmations
      // with prior context) get the TIGHT prompt + 96-token cap so we
      // don't burn 40s generating a LaTeX essay for "2+2". Non-trivial
      // direct answers (explainers, definitions with no vault hit) keep
      // the POLISHED_DIRECT framing and the larger 384-token budget.
      const isTrivial = isTriviallyDirectAnswer(bareTask, taskHasPriorTurnContext(task));
      // Skill injection for the direct-answer path. A deliverable-shaped task
      // (reconciliation, financial summary, a BRD with the data inline) can route
      // here when it's self-contained and needs no research — but it STILL
      // deserves its playbook. Without this, the matched skill only reached
      // synthesize()'s path and these tasks got no guidance (and a reconciliation
      // came out with the adjustment directions wrong). Trivial inputs
      // (greetings/arithmetic) skip it — no skill, tight budget.
      let directSkillBlock = "";
      let directSkillName: string | undefined;
      if (!isTrivial) {
        try {
          const sIntent = parseIntentFromTask(task);
          const sBare = parseUserRequestFromTask(task);
          const sTop = topSkillScoreForTask(sBare, sIntent);
          // 20+ means intent + keyword AGREE on the skill. 15-19 is a
          // keyword-only match — the 07-03 reflection found that tier too weak
          // a trigger (wrong playbook applied more often than it helped).
          if (sTop && sTop.score >= 20) {
            const sk = suggestSkillsForTask(sBare, sIntent, 1);
            if (sk.length > 0) {
              directSkillName = sk[0].name;
              directSkillBlock = `\n\n--- Skill playbook: ${sk[0].name} ---\n${sk[0].body.slice(0, 3000)}\n--- end playbook ---`;
            }
          }
        } catch { /* skill lookup must never block the answer */ }
      }
      const hasDirectSkill = !!directSkillBlock;
      if (hasDirectSkill) push(`Applying the ${directSkillName} playbook to this deliverable.`);
      const directPrompt = isTrivial ? TRIVIAL_DIRECT : POLISHED_DIRECT;
      // A skill-guided deliverable needs room (a reconciliation bridge, a BRD)
      // — the 384-token default truncates it. Give it a generous budget.
      const directMaxTokens = isTrivial ? 96 : (hasDirectSkill ? 1400 : 384);
      // Prompt order: STATIC base first (so OpenAI/Anthropic can cache the
      // stable ≥1024-token prefix across calls), then the per-task skill block,
      // then the per-persona suffix LAST — which also matches the documented
      // invariant that personaSystemSuffix lands last so its language directive
      // overrides (see language-prompts.ts). Persona-first busted the cache AND
      // the override precedence.
      const sys = injectLanguagePrompt(directPrompt, "direct") + directSkillBlock + (opts.personaSystemSuffix ? "\n\n" + opts.personaSystemSuffix : "");
      try {
        // SPEED: direct-answer prose is short. We route through the
        // TRIAGE profile by default, which picks the user's
        // smallest/fastest model — qwen3.5:0.8b on this machine —
        // instead of the larger synthesis-tier model. Measured drop:
        // ~67s → ~15-25s on local Ollama. Customer can opt out with
        // NEUROWORKS_FAST_DIRECT_ANSWER=0 when they'd rather have the
        // larger model's prose quality. Token budgets:
        //   trivial → 96 (one sentence is plenty)
        //   non-trivial → 384 (40-180 words of professional prose)
        // A skill-guided deliverable goes to the synthesis-tier model — the
        // tiny triage model can't reliably apply a multi-step playbook (it got
        // a reconciliation's adjustment directions wrong). Plain direct answers
        // keep the fast path.
        const useFastDirect = process.env.NEUROWORKS_FAST_DIRECT_ANSWER !== "0" && !hasDirectSkill;
        // Inner helper so we can re-issue with a different backend when the
        // first attempt hits OR 429 / transport hiccup. Keeps the late-vault
        // race + return shape identical between primary and retry paths.
        async function runDirect(profile: "triage" | "synthesis" | undefined) {
          const [meta, lateVaultHits] = await Promise.all([
            ollamaGenerateWithMeta(task, sys, {
              profile,
              maxTokens: directMaxTokens,
              onToken: (_chunk, accumulated) => onProgress?.({ partialAnswer: accumulated }),
            }),
            vaultContentRace,
          ]);
          return { meta, lateVaultHits };
        }
        let attempt;
        try {
          attempt = await runDirect(useFastDirect ? "triage" : "synthesis");
        } catch (e: any) {
          // OR free-tier 429 / transport hiccup is the common failure here
          // because triage routes to OR when OPENROUTER_TRIAGE_MODEL is
          // pinned. Retry once with profile=undefined which forces local
          // Ollama (shouldRouteToOpenRouter returns false when profile is
          // missing) — slower (~15-25s) but always available. If THAT also
          // fails we have no LLM and fall through to the planner.
          const msg = String(e?.message ?? e);
          const transientLLM = /429|rate[\s-]?limit|fetch\s+failed|terminated|ECONNRESET|HTTP\s+5\d\d|other\s+side\s+closed/i.test(msg);
          if (!transientLLM) throw e;
          push(`Direct answer hit a remote hiccup (${msg.slice(0, 80)}) — retrying once on local Ollama.`);
          attempt = await runDirect(undefined);
        }
        // If the late vault search found something AFTER the model already
        // answered (which usually means the answer is world-knowledge-only),
        // flag it for the customer so they know there's vault context they
        // could promote next time.
        if (attempt.lateVaultHits.length > 0) {
          push(`Note: your second brain has ${attempt.lateVaultHits.length} note${attempt.lateVaultHits.length === 1 ? "" : "s"} that mention this topic (e.g. ${attempt.lateVaultHits[0].path}) — re-ask if you want me to use those instead of general knowledge.`);
        }
        const direct: Plan = { steps: [], summary: "Direct answer (general knowledge — no vault notes, no web search).", waves: [] };
        return { task, plan: direct, runs: [], answer: attempt.meta.text.trim(), hadWrites: false };
      } catch (e: any) {
        push(`Direct answer didn't land cleanly (${String(e?.message ?? e).slice(0, 80)}) — switching to the planner.`);
        // fall through
      }
    }
  }

  // Heuristic planner shortcut. Common task shapes ("tell me about X",
  // "open <path>", "scrape <url>") have one obvious tool — we skip the LLM
  // planner entirely for those and save 3-8s. Only falls back to the LLM
  // planner when the shape isn't recognised.
  //
  // bareTask (computed at top) strips persona framing so URL / path / verb
  // anchors match from line-start.
  onProgress?.({ phase: "planning" });
  // Memory intents get a DETERMINISTIC plan. The free-tier planner is too
  // unreliable to emit the right memory.* step even with the routing hint, and
  // heuristicPlan would otherwise grab "remember/recall … about X" as a research
  // shape (research.deep), which is exactly the orphaned-memory miss the probe
  // showed. Build the memory.note / memory.search step here from the text.
  const buildMemoryPlan = (): Plan | null => {
    if (!memoryIntent) return null;
    // Recall wins UNLESS the task leads with an imperative "remember/note …"
    // (the roundtrip "Remember that X. Then tell me what you have on file" — the
    // write is the part we can't afford to drop). Otherwise "what do you
    // remember about X" is a read, not a write.
    const startsImperativeRemember = /^\s*(please\s+)?(remember|note|store|make\s+a\s+note|keep\s+in\s+mind|take\s+note|jot\s+down)\b/i.test(bareTask);
    const isRecall = !startsImperativeRemember && MEM_RECALL_RE.test(bareTask);
    if (!isRecall && MEM_REMEMBER_RE.test(bareTask)) {
      const fact = bareTask
        .replace(/^.*?\b(remember|note|keep\s+in\s+mind|don'?t\s+forget|store|take\s+note|make\s+a\s+note)\b[\s:,-]*(that|this|to|the)?\s*/i, "")
        .trim() || bareTask;
      const isoDate = (bareTask.match(/\b(\d{4}-\d{2}-\d{2})\b/) || [])[1];
      const subject = (extractTopic(fact) || fact.split(/\s+/).slice(0, 5).join(" ")).slice(0, 80);
      const args: Record<string, unknown> = { subject, fact };
      if (isoDate) args.date = isoDate;
      push(`Filing this to long-term memory under "${subject}"${isoDate ? ` (calendar-anchored to ${isoDate})` : ""}.`);
      return { steps: [{ tool: "memory.note", args, label: humanStepLabel("memory.note", args) }], summary: "Persisting a fact to long-term memory", waves: [] };
    }
    const query = (extractTopic(bareTask) || bareTask).slice(0, 120);
    push(`Searching long-term memory for "${query}".`);
    return { steps: [{ tool: "memory.search", args: { query }, label: humanStepLabel("memory.search", { query }) }], summary: "Recalling from long-term memory", waves: [] };
  };
  const buildBriefingPlan = (): Plan | null => {
    if (!briefingIntent) return null;
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const date = (bareTask.match(/\b(\d{4}-\d{2}-\d{2})\b/) || [])[1] ?? iso(new Date());
    push(`Building the day plan for ${date} — meetings, scheduled tasks, dated memory commitments, and carryover.`);
    return { steps: [{ tool: "calendar.plan_day", args: { date }, label: humanStepLabel("calendar.plan_day", { date }) }], summary: "Daily briefing from the day plan", waves: [] };
  };
  // Deterministic EMAIL-READ plan. "read my inbox", "any new emails?", "check my
  // mail", "unread messages", "summarise my inbox" must reach the MAILBOX — not
  // the vault 0-Inbox folder (the fs/vault heuristics alias the word "inbox" to a
  // vault path) and NOT db.query (buildDbPlan fuzzy-matched "emails" against a
  // data source's notes and ran SQL — live 2026-07-24: "read my unread inbox and
  // summarise" fired db.query on "Website DB"). Routes to the IMAP unread reader
  // when NEUROWORKS_EMAIL_* creds are set, else integration.gmail.read (Gmail
  // connection). Placed FIRST in the intercept chain so no other heuristic can
  // steal an email-read request.
  // Deterministic SOCIAL plan — publishing and monitoring both have dedicated
  // primitives, and the LLM-planner hint alone doesn't fire on the direct-answer
  // path (a "check our social posts" question went to an empty plan). Placed
  // FIRST so a social task can't be stolen by the email-read or db intercepts
  // (live 2026-07-26: "post … agents can now read email …" was hijacked to
  // inbox.read_unread by the "read email" substring in the post text).
  const buildSocialPlan = (): Plan | null => {
    if (fromTemplate) return null;
    const platMatches = bareTask.match(/\b(twitter|linkedin|facebook|instagram|tiktok|threads)\b/ig) ?? [];
    const plats = [...new Set(platMatches.map(p => p.toLowerCase()))];
    const socialWord = /\bsocial(\s*media)?\b/i.test(bareTask);
    if (plats.length === 0 && !socialWord) return null;
    // Extract the post PAYLOAD first (quoted, or after a colon), then classify
    // intent on the COMMAND with the payload removed — otherwise a monitor word
    // INSIDE the message being posted ("post: '…our analytics dashboard…'")
    // flips a publish into a read (live 2026-07-27: routed to social.history).
    const quoted = bareTask.match(/["“”']([^"“”']{3,})["“”']/);
    const afterColon = bareTask.match(/:\s*([\s\S]{3,})$/);
    const payload = (quoted?.[1] ?? afterColon?.[1] ?? "").trim();
    const command = payload ? bareTask.replace(payload, " ") : bareTask;
    const publishIntent = /\b(post|publish|share|tweet|announce|put\s+out|schedule)\b/i.test(command);
    const monitorWord = /\b(mentions?|comments?|analytics|engagement|performance|metrics|read|check|show|list|recent|history|how)\b/i.test(command);
    // PUBLISH — a publish verb + an extractable payload wins regardless of any
    // monitor words inside that payload. Without a clean payload, only take the
    // publish path when there's no monitor intent; else fall through to read.
    if (publishIntent && (payload || !monitorWord)) {
      const platforms = plats.length ? plats : ["twitter"];
      if (payload) {
        push(`Drafting a social post for ${platforms.join(", ")} — it parks for your approval before publishing.`);
        return { steps: [{ tool: "social.post", args: { post: payload, platforms }, rationale: "publish to social — approval-gated", label: humanStepLabel("social.post", { platforms: platforms.join(", ") }) }], summary: "Publish a social post (approval-gated)", waves: [[0]] };
      }
      return null; // publish intent but no clean payload — let the LLM planner compose it
    }
    // READ / MONITOR — recent posts + delivery status (a starting point the
    // synth can expand with social.analytics/social.comments on specific ids).
    push(`Reading our recent social posts and engagement.`);
    return { steps: [{ tool: "social.history", args: { limit: 10 }, rationale: "list recent social posts + delivery status", label: humanStepLabel("social.history", {}) }], summary: "Read recent social activity", waves: [[0]] };
  };
  const buildEmailReadPlan = (): Plan | null => {
    if (fromTemplate) return null;
    // A SOCIAL task that happens to mention "email"/"mail" in its content (e.g.
    // "post … agents can now read email …") is not an email-read request — the
    // social intercept owns it.
    if (/\b(post|publish|tweet|share)\b/i.test(bareTask) && (/\b(twitter|linkedin|facebook|instagram|tiktok|threads)\b/i.test(bareTask) || /\bsocial(\s*media)?\b/i.test(bareTask))) return null;
    // Must clearly be about EMAIL/MAIL. A bare "inbox" only qualifies alongside a
    // mail word so "list the notes in my inbox folder" (vault) stays untouched.
    const emailNoun = /\b(e-?mails?|mailbox|mail)\b/i.test(bareTask) || /\binbox\b/i.test(bareTask);
    if (!emailNoun) return null;
    // Explicit vault/file-in-a-FOLDER phrasing → leave for the vault heuristic.
    if (/\b(?:notes?|files?|docs?|documents?|markdown|zettels?)\b/i.test(bareTask) && /\bfolder\b/i.test(bareTask)) return null;
    const readVerb = /\b(read|check|show|list|summari[sz]e|any\s+new|unread|latest|recent|do\s+i\s+have|what'?s\s+in|go\s+through|triage|scan|fetch|get|view|see)\b/i.test(bareTask);
    // SEND intent ("email X about Y", "reply", "forward", "email me") is handled
    // by the send path / emailContext — never a read.
    const sendIntent = /\b(send|write|draft|compose|reply|forward|email\s+\S+@|email\s+(me|him|her|them|everyone|the\s+team|all)\b)\b/i.test(bareTask);
    if (!readVerb || sendIntent) return null;
    const limitMatch = bareTask.match(/\b(\d{1,2})\b/);
    const limit = limitMatch ? Math.min(50, Math.max(1, parseInt(limitMatch[1], 10))) : 10;
    // "unread/unseen/new" ⇒ unseen only; otherwise show the most recent messages
    // regardless of read state (so "read my latest emails" isn't empty when the
    // mailbox has 0 unseen).
    const wantsUnread = /\b(unread|unseen|new)\b/i.test(bareTask);
    const imapConfigured = !!(process.env.NEUROWORKS_EMAIL_USER && process.env.NEUROWORKS_EMAIL_APP_PASSWORD);
    if (imapConfigured) {
      const args = { limit, unreadOnly: wantsUnread };
      push(`Reading ${wantsUnread ? "unread" : "recent"} messages from the mailbox — up to ${limit}.`);
      return { steps: [{ tool: "inbox.read_unread", args, rationale: "task asks to read the email inbox — IMAP reader on the configured mailbox", label: humanStepLabel("inbox.read_unread", args) }], summary: "Read the email inbox and summarize", waves: [[0]] };
    }
    // No IMAP creds — fall back to the Gmail connection reader (errors cleanly if
    // no Google connection is configured; the synth relays that honestly).
    const args = { query: wantsUnread ? "is:unread newer_than:14d" : "newer_than:7d", maxResults: limit };
    push(`Reading your Gmail inbox (${wantsUnread ? "unread" : "recent"}) — up to ${limit} messages.`);
    return { steps: [{ tool: "integration.gmail.read", args, rationale: "task asks to read the email inbox — Gmail connection reader", label: humanStepLabel("integration.gmail.read", args) }], summary: "Read the email inbox and summarize", waves: [[0]] };
  };
  // Deterministic DB plan — same pattern as buildMemoryPlan/buildBriefingPlan.
  // When the task names a REGISTERED data source (or clearly asks about "the
  // database"), route straight to db.query question-mode: the primitive
  // fetches the schema, generates SQL from the question, executes, and
  // returns labeled result sets for the synth. Without this, "query the Neon
  // Cloud DB and summarize" went to a WEB search three runs straight
  // (2026-07-12) — the free-tier LLM planner never chose the db.* chain even
  // with the registered-databases hint in its prompt.
  const buildDbPlan = (): Plan | null => {
    if (fromTemplate) return null;
    // WRITE INTENT → do NOT hijack into read-only question-mode. Question-mode
    // generates SELECT-only SQL; a task that asks to INSERT/UPDATE/DELETE (or
    // literally names db.write) must reach the LLM planner / explicit-tool
    // path so the real db.write HITL primitive runs. Routing it here silently
    // ran a SELECT and the synth then FABRICATED a successful write with
    // placeholder row values (live 2026-07-13 — 0 rows actually landed).
    if (/\b(?:db\.write|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+a?\s*(?:new\s+)?(?:requisition|record|row|entry)|add\s+a?\s*(?:new\s+)?(?:requisition|record|row|entry)|write\s+to)\b/i.test(bareTask)) return null;
    try {
      const sources = listDataSources();
      if (sources.length === 0) return null;
      const lower = bareTask.toLowerCase();
      // Exact-label mention first, then the FUZZY resolver (label + notes token
      // overlap) so "query the db of the finance flow" resolves to the source
      // whose notes describe it as the finance system, even with several DBs
      // registered (live 2026-07-13 — two postgres sources, neither labeled
      // "finance flow", sent the task to a web search).
      const labeled = sources.find(s => s.label && lower.includes(s.label.toLowerCase()))
        ?? getSourceByLabel(bareTask);
      const genericDb = /\b(?:database|data\s+sources?|db|sql|postgres(?:ql)?|mysql|mongodb|sqlite|mssql)\b/i.test(bareTask);
      // Verbs that make this a DATA request, not a config/admin request
      // ("delete the database connection" should not run queries).
      const wantsData = /\b(?:quer(?:y|ies)|summari[sz]e|how\s+many|count|total|recent|latest|list|show|what(?:'s|\s+is)?\s+in|look\s+into|analy[sz]e|report|findings|stored)\b/i.test(bareTask);
      if (!wantsData || (!labeled && !genericDb)) return null;
      const target = labeled ?? (sources.length === 1 ? sources[0] : null);
      if (!target) return null; // several sources, none named — let the LLM planner disambiguate
      push(`Recognised a database question — querying "${target.label}" (${target.kind}) directly.`);
      const args = { source: target.label, question: bareTask.slice(0, 500) };
      return {
        steps: [{ tool: "db.query", args, rationale: "task asks about a registered company data source — schema-aware question-mode query instead of web research", label: humanStepLabel("db.query", args) }],
        summary: `Query ${target.label} and summarize the findings`,
        waves: [[0]],
      };
    } catch { return null; }
  };
  // Deterministic DB WRITE plan. An action against an external system
  // ("$10 requisition in the financeflow", "add a record to X") must produce a
  // REAL db.write, not a web search the synth then narrates as a fake success
  // ("Added — Draft", live 2026-07-13). Fires only for create/add intent on a
  // resolvable, WRITABLE source; routes to db.write intent-mode (schema →
  // INSERT). If the source is read-only we do NOT fabricate — fall through so
  // the agent reports it can't write rather than inventing a result.
  const buildDbWritePlan = (): Plan | null => {
    if (fromTemplate) return null;
    const CREATE_RE = /\b(?:create|add|make|log|record|file|submit|raise|enter|insert)\b/i;
    const OBJECT_RE = /\b(requisition|record|entry|expense|receipt|budget|row|order|invoice|ticket)\b/i;
    if (!(CREATE_RE.test(bareTask) && OBJECT_RE.test(bareTask))) return null;
    try {
      const target = getSourceByLabel(bareTask);
      if (!target) return null;      // no matching source — LLM planner / connector path handles it
      if (target.readonly) return null; // writable sources only — never fabricate a write
      push(`Recognised an external write — creating a record in "${target.label}" via db.write.`);
      const args = { source: target.label, intent: bareTask.slice(0, 500), dryRun: false };
      return {
        steps: [{ tool: "db.write", args, rationale: "action task targets a writable registered data source — generate the INSERT from the live schema and execute", label: humanStepLabel("db.write", { source: target.label }) }],
        summary: `Write a record to ${target.label}`,
        waves: [[0]],
      };
    } catch { return null; }
  };
  // Org-structure questions skip the DB plan: db.query can list the users
  // table but knows nothing of the agent roster, department data, or the
  // uploaded strategy/governance documents — heuristicPlan's deterministic
  // org plan covers all of those (caught live 2026-07-19: "summarize our
  // organizational structure vs the 2026 strategic plan" routed to db.query
  // and reported "no documented alignment" while the strategic plan sat in
  // _company/).
  // When the caller has already assembled the evidence and pasted it in as an
  // "Attached documents (user uploaded as context)" block, that block IS the
  // plan — synthesise directly from it. The deterministic intercept plans
  // (db.query question-mode, memory recall, briefing day-plan) must not
  // hijack it: doing so runs a DIFFERENT evidence source and silently drops
  // the attached context, which is exactly how the daily briefing kept losing
  // its innovation-scan section (db.query grabbed "tasks yesterday" and synth
  // never saw the scan). Attachments short-circuit straight to the empty plan
  // → direct-synth-from-attachments path.
  const taskHasAttachments = /\nAttached documents \(user uploaded as context/.test(task);
  // Attachments + a LIVE-data ask are NOT mutually exclusive. The pure
  // short-circuit silently dropped the live half: "integrate live cash flow
  // baselines into the attached plan" direct-synthed with ZERO tool calls and
  // the synth fabricated "the Aiia Finance connector is not set up" while
  // three connectors sat registered (caught live 2026-07-19). When the task
  // asks for real financial figures, pull the FinanceFlow endpoints FIRST —
  // the synth then combines the connector results with the attached context.
  const financeWithAttachments: Plan | null = taskHasAttachments && FINANCE_READOUT_RE.test(bareTask)
    ? {
        steps: [
          { tool: "connector.call", args: { connector: "Aiia FinanceFlow", path: "/api/budgets" }, rationale: "live budgets from the finance connector", label: humanStepLabel("connector.call", { connector: "Aiia FinanceFlow" }) },
          { tool: "connector.call", args: { connector: "Aiia FinanceFlow", path: "/api/receipts" }, rationale: "live receipts/cash-flow history", label: humanStepLabel("connector.call", { connector: "Aiia FinanceFlow" }) },
        ],
        summary: "Live finance pull (FinanceFlow connector) + synth with the attached context.",
        waves: [[0, 1]],
      }
    : null;
  let p = taskHasAttachments
    ? (financeWithAttachments ?? { steps: [], summary: "Direct synth from attached context", waves: [] })
    : buildSocialPlan() ?? buildEmailReadPlan() ?? buildMemoryPlan() ?? buildBriefingPlan() ?? buildDbWritePlan() ?? (ORG_STRUCTURE_RE.test(bareTask) ? null : buildDbPlan()) ?? heuristicPlan(bareTask, { hasAttachments: false }) ?? { steps: [], summary: undefined, waves: [] };
  if (p.steps.length > 0) {
    // Customer-facing context-tier badge based on what the plan touches.
    // Helps the customer see "this answer drew on your vault" vs "this
    // pulled from the web" vs "this just used a single tool" at a glance.
    const tools = new Set(p.steps.map(s => s.tool));
    const hitsVault = ["vault.search", "vault.read", "vault.scan_docs"].some(t => tools.has(t));
    const hitsWeb = ["research.deep", "research.multiperspective", "web.search", "web.fetch", "web.scrape", "web.firecrawl"].some(t => tools.has(t));
    const hitsLocal = ["fs.find_in", "fs.read_external", "fs.list_external"].some(t => tools.has(t));
    let tier = "Tier 1 — chat context";
    if (hitsVault && hitsWeb) tier = "Tier 2+3 — your second brain + the web";
    else if (hitsVault) tier = "Tier 2 — your second brain";
    else if (hitsWeb) tier = "Tier 3 — the web";
    else if (hitsLocal) tier = "Tier 2 — your local files";
    else tier = "Direct tool use";
    push(`Recognised the shape — ${tier}, ${p.steps.length} step${p.steps.length === 1 ? "" : "s"}.`);
  } else if (taskHasAttachments) {
    // Evidence already inline — no planner, no research. Straight to the
    // direct-synth-from-attachments path below.
    push(`Synthesising from the attached context.`);
  } else {
    push(`Thinking about the best approach…`);
    p = await plan(task, opts.personaSystemSuffix, push, opts.workMode, { taskKind: opts.taskKind, persona: opts.persona });
  }
  if (p.steps.length === 0 && !taskHasAttachments) {
    // Vault-first fallback uses bareTask so extractTopic doesn't fold the
    // persona prefix into the research query (root cause of the 5-minute
    // research.deep run measured in the wild). This IS the default cascade:
    // vault search inside research.deep, then web if the vault is thin.
    push(`Couldn't draft a tight plan in time — falling back to the standard cascade: your second brain first, then the web.`);
    p = defaultVaultPlan(bareTask, { hasAttachments: false });
  }
  // PLAN REPAIR — local-fs intent. Small planner LLMs sometimes pick
  // research.deep even when the task clearly says "in my downloads /
  // desktop / documents". research.deep cannot read the operator's
  // local PC, so the resulting answer is always "no matches found".
  // When the task mentions a local folder AND the plan has no fs.* /
  // vault.* step, swap the first research.deep / web.* step for a
  // proper local-fs chain. Idempotent: skipped when the planner already
  // included fs.find_in / fs.read_external.
  const localFsTaskHint = bareTask.match(LOCAL_FS_HINT_RE);
  if (localFsTaskHint) {
    const planTools = new Set(p.steps.map(s => s.tool));
    const hasLocalFs = ["fs.find_in", "fs.read_external", "fs.list_external"].some(t => planTools.has(t));
    if (!hasLocalFs) {
      const repaired = defaultVaultPlan(bareTask, { hasAttachments: /\nAttached documents \(user uploaded as context/.test(task) });
      // Only override if defaultVaultPlan produced an fs.find_in plan
      // (i.e. our local-fs branch fired). Avoids replacing with the
      // research.deep default.
      if (repaired.steps[0]?.tool === "fs.find_in") {
        push(`Plan repair: rerouting from web/vault search to local-PC search — task mentions ${localFsTaskHint[1]}.`);
        p = repaired;
      }
    }
  }
  // PLAN REPAIR — fs.find_in with no name. `name` is a required, substring-
  // match argument (fs.find_in is a NAME search, not a folder listing) —
  // there's no "list everything" mode. A "list all downloads and summarise
  // what's there" style task has no specific filename to search for, and a
  // planner LLM sometimes reaches for fs.find_in anyway and just omits
  // `name`, which throws immediately ("fs.find_in: 'name' is required") and
  // kills the whole step with nothing to show for it (reproduced live
  // 2026-07-10). The correct tool for "what's in this folder" is
  // fs.list_external — swap in place rather than failing the step.
  for (let i = 0; i < p.steps.length; i++) {
    const step = p.steps[i];
    if (step.tool === "fs.find_in" && !String(step.args?.name ?? "").trim()) {
      const folderArg = String(step.args?.folder ?? "downloads");
      const { resolveFsFolderRoots } = await import("./primitives.js");
      const root = resolveFsFolderRoots(folderArg)[0];
      push(`Plan repair: fs.find_in had no name to search for — listing ${folderArg} instead (fs.list_external).`);
      step.tool = "fs.list_external";
      step.args = { path: root, depth: 2 };
      step.label = humanStepLabel("fs.list_external", { path: root });
      // Any later step referencing this step's result via $step_i.matches...
      // (fs.find_in's shape) would now resolve to nothing — fs.list_external
      // returns `entries`, not `matches`. Rewrite those references rather
      // than leaving a step pointed at a field that no longer exists.
      for (let j = i + 1; j < p.steps.length; j++) {
        const later = p.steps[j];
        const raw = JSON.stringify(later.args ?? {});
        if (raw.includes(`$step_${i}.matches`)) {
          later.args = JSON.parse(raw.replaceAll(`$step_${i}.matches`, `$step_${i}.entries`));
        }
      }
    }
  }
  // PLAN REPAIR — fs.find_in pointed at a folder the task didn't ask for.
  // "Summarize all the documents in my downloads that refer to X" contains
  // both the word "documents" (as a noun for files) and "downloads" (the
  // actual folder) — the LLM planner picked folder='documents' from the
  // noun and searched the wrong place (4 identical live failures on
  // 2026-07-12, all "succeeded" at job level while the answer said
  // "searched Documents, found nothing"). The possessive form is the
  // disambiguator: "my downloads" is a folder reference, bare "documents"
  // is not. When the task names exactly ONE folder that way, it wins over
  // whatever the planner chose.
  {
    const folderWord = (w: string) =>
      /^download/i.test(w) ? "downloads"
      : /^(documents?|docs)$/i.test(w) ? "documents"
      : /^photos$/i.test(w) ? "pictures"
      : w.toLowerCase();
    const mentions = new Set(
      [...bareTask.matchAll(/\b(?:my|the)\s+(downloads?|desktop|documents?|docs|music|pictures|photos|videos)\s+(?:folder\b)?/gi)]
        .map(m => folderWord(m[1])),
    );
    if (mentions.size === 1) {
      const wanted = [...mentions][0];
      for (const step of p.steps) {
        if (step.tool !== "fs.find_in" && step.tool !== "fs.list_external") continue;
        const current = String(step.args?.folder ?? "").toLowerCase();
        if (step.tool === "fs.find_in" && current && current !== "all" && folderWord(current) !== wanted) {
          push(`Plan repair: task says "my ${wanted}" but the plan searched ${current} — correcting the folder.`);
          (step.args as Record<string, unknown>).folder = wanted;
          if (step.label) step.label = humanStepLabel("fs.find_in", step.args ?? {});
        }
      }
    }
  }
  // PLAN REPAIR — test-mode capture suppression. research.deep and
  // research.multiperspective default `capture: true` (write a note to
  // 0-Inbox/) unless a caller explicitly opts out. Internal QA/stress
  // harnesses never did, so 3 concentrated sweep days (2026-05-29/30,
  // 06-01) wrote 1,036 machine-test notes straight into the user's actual
  // vault — reproduced and root-caused 2026-07-10 during a vault sweep.
  // Callers now opt IN to test mode via {testMode:true} in the request
  // body (threaded through generalTaskRunner); when set, force capture off
  // on every step regardless of what the planner decided.
  if (opts.testMode) {
    for (const step of p.steps) {
      if ((step.tool === "research.deep" || step.tool === "research.multiperspective") && step.args) {
        (step.args as Record<string, unknown>).capture = false;
      }
    }
  }
  push(`Plan ready: ${p.steps.length} step${p.steps.length === 1 ? "" : "s"}${p.summary ? ` — ${p.summary}` : ""}.`);

  // ─── Sensitive-action approval checkpoint ───
  // A fresh plan that would touch the database, an outbound connector, or send
  // an email pauses HERE, before any step runs, and hands the plan back for
  // human sign-off. runJob parks the job in awaiting-approval; approving it
  // replays this exact plan through the `preplan` path above (which never
  // reaches this checkpoint), so the operator's review is what runs. Skipped
  // for preplan replays (opts.preplan short-circuits long before this) and when
  // a caller explicitly opts out (opts.skipApprovalGate) — e.g. an internal
  // pipeline that has already gated the action upstream.
  if (!opts.skipApprovalGate) {
    const sensitiveSteps: typeof p.steps = [];
    for (const s of p.steps) {
      if (!SENSITIVE_APPROVAL_TOOLS.has(s.tool)) continue;
      if (s.tool === "connector.call" && await isConnectorCallExempt(s.args as any)) continue;
      sensitiveSteps.push(s);
    }
    if (sensitiveSteps.length > 0) {
      const tools = [...new Set(sensitiveSteps.map(s => s.tool))];
      push(`This plan includes ${tools.join(", ")} — ${tools.length === 1 ? "an action" : "actions"} that need your approval before running. Parking the task for sign-off on the Approvals page.`);
      onProgress?.({ plan: p, phase: "awaiting-approval" });
      return {
        task, plan: p, runs: [], answer: "", hadWrites: false,
        approvalRequired: { tools, steps: sensitiveSteps.length, task, personaSuffix: opts.personaSystemSuffix },
      };
    }
  }

  onProgress?.({ phase: "executing", plan: p, runs: [] });

  const { runs, hadWrites, budgets, subagentTimings, cancelled, delegatedApproval } = await executePlan(p, push, (runs) => onProgress?.({ runs: [...runs] }), opts.signal);
  if (budgets) onProgress?.({ budgets, subagentTimings });

  // A delegated sub-task parked for approval — re-park THIS (parent) job. Carry
  // the worker's SUB-plan so approving replays the real sensitive steps locally
  // (not the peer.delegate wrapper, which would re-delegate and re-park). Same
  // awaiting-approval path runJob already handles for the self-plan checkpoint.
  if (delegatedApproval) {
    onProgress?.({ plan: p, runs, phase: "awaiting-approval" });
    return {
      task, plan: p, runs, answer: "", hadWrites,
      approvalRequired: { tools: delegatedApproval.tools, steps: delegatedApproval.plan?.steps?.length ?? 0, task, personaSuffix: opts.personaSystemSuffix, plan: delegatedApproval.plan },
    };
  }

  // Operator cancelled mid-run — return immediately without synthesising or
  // running QA. runJob has already (or is about to) mark the job failed with
  // the "Cancelled" reason; drafting an answer here would waste an LLM call
  // on a run the user stopped.
  if (cancelled || opts.signal?.aborted) {
    return { task, plan: p, runs, answer: "Run cancelled.", hadWrites };
  }

  // Human-in-the-loop pause: the plan hit a human.request step, so the rest of
  // the work belongs to the operator. Skip synthesis + QA entirely (there's no
  // finished deliverable to grade) and hand back the structured ask — runJob
  // parks the job in waiting_on_human and the Tasks page renders the items.
  const humanReq = extractHumanRequest(runs);
  if (humanReq) {
    onProgress?.({ phase: "waiting_on_human", runs });
    return { task, plan: p, runs, answer: humanWaitAnswer(humanReq), hadWrites, humanRequest: humanReq };
  }

  // Synthesize a chat-friendly answer from the step results. Stream tokens as
  // they arrive into job.result.partialAnswer so the UI can render the answer
  // materialising in real time instead of waiting for the full generation.
  onProgress?.({ phase: "synthesizing", runs });
  const synth = await synthesize(task, p, runs, opts.personaSystemSuffix, (partial) => {
    onProgress?.({ partialAnswer: partial });
  }, { push });

  // Post-flight QA. Split into two phases so the happy path doesn't pay for
  // peer.review (the slowest QA call, 30-90s):
  //   Phase A — quality.check + security.scan (fast, parallel)
  //   Phase B — peer.review, ONLY when phase-A says the draft needs help
  //
  // Both phases land as real plan steps so the AgentVisualizer shows them
  // live next to the user's other sub-agents.
  // Skip the QA wave when the plan produced ZERO real successes. The synth
  // in that case is a fallback rescue summary ("we tried X, it failed
  // because Y") — there's no real content to quality-check, no citations
  // to verify, and running peer.review on an apology wastes 60-90s on a
  // task that already failed once. Detected via runs.every(!ok).
  const allWorkFailed = runs.length > 0 && runs.every(r => !r.ok);
  const wantQA = (opts.autoReview ?? AUTO_REVIEW) && synth.answer.length >= MIN_REVIEW_CHARS && !allWorkFailed;
  // Use bareTask length here too — enriched task is always > 30 chars due to
  // the persona prefix, which neutered this QA-skip optimisation entirely.
  const trivialTask = bareTask.trim().length < 30;
  // Definitional explainers: "explain X" / "what is X" / "who is X" /
  // "tell me about X" / "describe X" / "how does X work". When the plan
  // is a SINGLE research.* step (no compare, no multi-source) the QA wave
  // costs 60-90s for marginal value — research.deep already grounds against
  // vault+web, and there's no compound claim to peer-review. Trades a tiny
  // accuracy risk for substantial latency on every "explain X" query.
  const looksDefinitionalExplainer =
    /^(?:what(?:'?s|\s+is|\s+are|\s+does|\s+do)|who(?:'?s|\s+is|\s+are|\s+was)|tell\s+me\s+about|explain|describe|how\s+(?:do|does|can|should|would)|summari[sz]e|recap|brief\s+me\s+on|tldr)\s+/i.test(bareTask)
    && bareTask.length <= 100;
  const singleResearchStep = p.steps.length === 1 && /^research\./.test(p.steps[0].tool);
  const skipQAForExplainer = looksDefinitionalExplainer && singleResearchStep && synth.answer.length >= MIN_REVIEW_CHARS;
  if (allWorkFailed) {
    push(`Skipping quality review — every step failed, so the response is just a summary of what went wrong (nothing to grade).`);
  }
  const plannerAlreadyReviewed = p.steps.some(s => s.tool === "peer.review");
  // Build a compact evidence catalog from successful runs to feed quality.check.
  // Without this the scorer is asked to grade citation_coverage but can't
  // actually verify whether claims are sourced — it only sees the draft.
  // Passing the same numbered evidence the synth saw makes the score meaningful.
  const evidenceForQA = buildEvidenceCatalog(runs);

  // Only add governance.check to the QA wave when there's actually an
  // accepted+reviewed HARD constraint to check against — most installs never
  // touch Governance, so this stays a silent no-op cost for them instead of
  // an extra step on every single task.
  let govActive = false;
  try {
    const { hasEnforceableConstraints } = await import("./governance.js");
    govActive = hasEnforceableConstraints();
  } catch { /* governance is non-fatal */ }

  if (wantQA && !trivialTask && !skipQAForExplainer) {
    onProgress?.({ phase: "reviewing", runs });
    // ---- Phase A: quality + security (+ governance when active), parallel ----
    const phaseASteps: PlanStep[] = [
      {
        tool: "quality.check",
        // Task-aligned grading: grounded when we actually gathered evidence OR
        // the task explicitly asked for sources/current/company data. An
        // evidence-less direct answer to a knowledge question is graded as
        // ungrounded (persona_fit-led) so the research rubric doesn't inflate
        // factuality_risk on correct-but-uncited prose. Mirrors the Hermes gate.
        args: { task, answer: synth.answer, sources: evidenceForQA, grounded: evidenceForQA.trim().length > 0 || taskWantsResearch(task) },
        rationale: "auto-injected: score factuality, citation coverage, persona fit (evidence-aware)",
        label: humanStepLabel("quality.check", {}),
      },
      {
        tool: "security.scan",
        args: { content: synth.answer, kind: "note" },
        rationale: "auto-injected: scan answer for secrets, dodgy URLs",
        label: humanStepLabel("security.scan", { kind: "note" }),
      },
    ];
    if (govActive) {
      phaseASteps.push({
        tool: "governance.check",
        args: { content: synth.answer },
        rationale: "auto-injected: check answer against accepted hard governance constraints",
        label: humanStepLabel("governance.check", {}),
      });
    }
    push(`Reviewing the draft — running quality${govActive ? ", security, and governance checks" : " and security checks"} in parallel.`);
    const baseIdxA = p.steps.length;
    const waveA = phaseASteps.map((_, i) => baseIdxA + i);
    p.steps.push(...phaseASteps);
    p.waves = [...(p.waves ?? p.steps.slice(0, baseIdxA).map((_, i) => [i])), waveA];
    runs.push(...phaseASteps.map(step => ({ step, ok: false, durationMs: 0 } as StepRun)));
    onProgress?.({ plan: p, runs: [...runs] });
    const planA: Plan = { steps: p.steps, summary: p.summary, waves: [waveA] };
    await executePlan(planA, push, (rs) => {
      for (const i of waveA) if (rs[i]) runs[i] = rs[i];
      onProgress?.({ runs: [...runs] });
    });

    // ---- Phase B: peer.review, only when the draft didn't clearly pass ----
    if (!plannerAlreadyReviewed) {
      const qScore = (runs.find(r => r.step.tool === "quality.check" && r.ok)?.result as any)?.score ?? 0;
      const qPass = (runs.find(r => r.step.tool === "quality.check" && r.ok)?.result as any)?.pass === true;
      const sPass = (runs.find(r => r.step.tool === "security.scan" && r.ok)?.result as any)?.pass !== false;
      // GOOD bar: quality.check says pass=true AND composite score >= 0.75
      // AND security clean. Skip peer.review on confident outputs.
      const cleanDraft = qPass && qScore >= 0.75 && sPass;
      if (cleanDraft) {
        push(`Quality check passed (${Math.round(qScore * 100)}%) and security is clean — peer review skipped (saves 30-90s).`);
      } else {
        const peerStep: PlanStep = {
          tool: "peer.review",
          args: { task, answer: synth.answer },
          rationale: `auto-injected: quality score=${qScore.toFixed(2)} (pass=${qPass}) — peer review for a second opinion`,
          label: humanStepLabel("peer.review", {}),
        };
        const baseIdxB = p.steps.length;
        const waveB = [baseIdxB];
        p.steps.push(peerStep);
        p.waves = [...(p.waves ?? []), waveB];
        runs.push({ step: peerStep, ok: false, durationMs: 0 });
        onProgress?.({ plan: p, runs: [...runs] });
        const planB: Plan = { steps: p.steps, summary: p.summary, waves: [waveB] };
        await executePlan(planB, push, (rs) => {
          for (const i of waveB) if (rs[i]) runs[i] = rs[i];
          onProgress?.({ runs: [...runs] });
        });
      }
    }
  } else if (wantQA && skipQAForExplainer) {
    push(`Skipping quality review — definitional explainer with a single research step (saves 60-90s; research.deep already grounds against vault + web).`);
  } else if (wantQA && trivialTask) {
    push(`Skipping quality review — short task, not worth a full QA pass.`);
  }

  // Pull the structured results out of the QA runs.
  const reviewRun = runs.find(r => r.step.tool === "peer.review" && r.ok);
  const qualityRun = runs.find(r => r.step.tool === "quality.check" && r.ok);
  const securityRun = runs.find(r => r.step.tool === "security.scan" && r.ok);
  const governanceRun = runs.find(r => r.step.tool === "governance.check" && r.ok);
  const review = reviewRun?.result ? coerceReview(reviewRun.result) : undefined;
  let quality: any = qualityRun?.result;
  const security = securityRun?.result;
  const governance: any = governanceRun?.result;

  // Governance enforcement — a hard-constraint violation on the FINAL answer
  // text withholds delivery and replaces the answer with a refusal that
  // names the specific policy, mirroring the instruction the governance
  // system-prompt prefix already gives the model ("when you decline, name
  // the specific policy you're honoring") — except this is enforced
  // deterministically after the fact rather than hoped-for at generation
  // time. No rescue/re-synth attempt: unlike a quality miss, a policy
  // violation isn't something a retry fixes, since the underlying request is
  // what's disallowed.
  if (governance && governance.pass === false) {
    const names = (governance.violations ?? []).map((v: any) => `"${v.rule}" (${v.policyName})`).slice(0, 3).join("; ");
    push(`⛔ Governance policy blocked this answer: ${names}`);
    synth.answer = `I can't deliver this answer as drafted — it conflicts with an organizational policy: ${names}. If this constraint shouldn't apply here, an admin can review it on the Governance page.`;
    try {
      const { logAudit } = await import("./audit-log.js");
      logAudit({ level: "warn", actor: "governance", action: "governance.block_answer", target: "answer", detail: names.slice(0, 200), result: "failure" });
    } catch { /* audit is best-effort */ }
  }

  // SKILL-ACQUISITION RESCUE (first-tier, cheap): if quality.check failed AND
  // no matching skill exists for the detected intent, the agent draft-writes
  // one and re-synthesises with it loaded. This is the "Claude makes a skill
  // when one is missing" loop — each unique struggle teaches the system a
  // new playbook that subsequent runs benefit from.
  //
  // Order matters: try this BEFORE the OR-rescue because (a) it doesn't
  // require OpenRouter, (b) a well-targeted skill is often a bigger lift
  // than swapping models, and (c) the drafted skill persists, helping the
  // next run too.
  let rescuedSynth: string | undefined;
  // Skill picker telemetry the rescue paths can overwrite — once a
  // drafted skill is used to rescue a failed synth, that skill is what
  // actually guided the FINAL answer, so the reflection should learn
  // from the rescue's pick, not the original.
  let finalSkillUsed: string | undefined = synth.skillUsed;
  let finalSkillScore: number | undefined = synth.skillScore;
  if (quality && quality.pass === false && synth.answer.length >= MIN_REVIEW_CHARS) {
    const intent = parseIntentFromTask(task);
    const bareTaskForSkill = parseUserRequestFromTask(task);
    // Combined picker score: 20+ means we had an exact intent match;
    // 15-19 means keyword-only; under 15 means no real match. We treat the
    // last two as "the matched skill (if any) is a weak fit" — draft a new
    // one rather than re-running with thin guidance.
    const topMatch = topSkillScoreForTask(bareTaskForSkill, intent);
    const matchedStrongly = topMatch !== null && topMatch.score >= 20;
    if (intent && !matchedStrongly) {
      const reason = topMatch === null
        ? `no skill targets intent "${intent}" or the task body`
        : `only weakly matched "${topMatch.skill.name}" (score ${topMatch.score}) — drafting a stronger fit`;
      push(`${reason} — drafting a new skill playbook (the system learns from this struggle)`);
      // We use intent here so the drafted skill is wired into the registry's
      // applies_to list, making subsequent tasks with the same intent find
      // it automatically.
        try {
          const { draftSkillForIntent } = await import("./skills.js");
          const firstIssue = Array.isArray(quality.issues) && quality.issues.length > 0 ? String(quality.issues[0]) : `quality score ${quality.score ?? "?"} below pass threshold`;
          const newSkill = await draftSkillForIntent({
            intent,
            taskSample: parseUserRequestFromTask(task),
            failureReason: firstIssue,
          });
          if (newSkill) {
            push(`drafted skill "${newSkill.name}" — re-running synth with the new playbook loaded`);
            try {
              const rescue = await synthesize(task, p, runs, opts.personaSystemSuffix, undefined, { push });
              if (rescue && rescue.answer.length >= MIN_REVIEW_CHARS) {
                rescuedSynth = rescue.answer;
                try {
                  const checkTool = findPrimitive("quality.check");
                  if (checkTool) {
                    const rescueEvidence = buildEvidenceCatalog(runs);
                    const rq: any = await checkTool.handler({ task, answer: rescue.answer, sources: rescueEvidence, grounded: rescueEvidence.trim().length > 0 || taskWantsResearch(task) });
                    const rs = rq?.score ?? 0;
                    const os = quality?.score ?? 0;
                    if (rs > os) {
                      push(`skill rescue improved score: ${os} → ${rs}; keeping the skill-rescued draft`);
                      quality = { ...rq, rescuedBy: "skill-acquisition", originalScore: os };
                      // Rescue's pick guided the kept answer — surface it
                      // to the reflection loop as the skill of record.
                      finalSkillUsed = rescue.skillUsed ?? finalSkillUsed;
                      finalSkillScore = rescue.skillScore ?? finalSkillScore;
                    } else {
                      push(`skill rescue produced ${rs} (not better than ${os}); falling through to OR rescue if available`);
                      rescuedSynth = undefined;
                    }
                  }
                } catch { /* tolerate re-score failure */ }
              }
            } catch (e: any) {
              push(`skill-rescue synth failed: ${String(e?.message ?? e).slice(0, 80)}`);
            }
          } else {
            push(`skill draft was unusable — falling through to OR rescue if available`);
          }
        } catch (e: any) {
          push(`skill draft failed: ${String(e?.message ?? e).slice(0, 80)}`);
        }
    }
  }

  // QUALITY RESCUE (second-tier): if quality.check failed (pass=false) AND
  // OpenRouter is configured AND we didn't already rescue via skill
  // acquisition, re-synth with the LARGE-tier model. The first attempt used
  // whatever the dispatcher picked (often local Ollama); the rescue forces
  // complexity:"high" so the dispatcher hands off to the bigger model. We
  // re-score the rescued draft and keep whichever has the better score.
  if (!rescuedSynth && config.openrouterEnabled && quality && quality.pass === false && synth.answer.length >= MIN_REVIEW_CHARS) {
    push(`quality.check failed (score=${quality.score ?? "?"}, issues: ${(quality.issues ?? []).slice(0, 2).join("; ")}) — re-synthesising with the large model`);
    try {
      const rescue = await synthesize(task, p, runs, opts.personaSystemSuffix, undefined, { forceComplex: true, push });
      if (rescue && rescue.answer.length >= MIN_REVIEW_CHARS) {
        rescuedSynth = rescue.answer;
        // Re-score the rescue draft so we know whether to keep it.
        try {
          const checkTool = findPrimitive("quality.check");
          if (checkTool) {
            const rescueQuality: any = await checkTool.handler({ task, answer: rescue.answer, sources: buildEvidenceCatalog(runs), grounded: buildEvidenceCatalog(runs).trim().length > 0 || taskWantsResearch(task) });
            const rescueScore = rescueQuality?.score ?? 0;
            const originalScore = quality?.score ?? 0;
            if (rescueScore > originalScore) {
              push(`quality rescue improved score: ${originalScore} → ${rescueScore}; using the rescued draft`);
              quality = { ...rescueQuality, rescued: true, originalScore };
              // Rescue's skill pick guided the kept draft — record it.
              finalSkillUsed = rescue.skillUsed ?? finalSkillUsed;
              finalSkillScore = rescue.skillScore ?? finalSkillScore;
            } else {
              push(`quality rescue produced score ${rescueScore} (not better than ${originalScore}); keeping the original`);
              rescuedSynth = undefined;
            }
          }
        } catch (e: any) {
          push(`quality re-score failed (${String(e?.message ?? e).slice(0, 80)}); keeping the rescued draft anyway`);
        }
      }
    } catch (e: any) {
      push(`quality rescue failed (${String(e?.message ?? e).slice(0, 80)}); keeping the original draft`);
    }
  }

  // REVIEW-DRIVEN RETRY (third-tier): peer review still says needs-work/bad
  // after the quality and OR rescues — re-synthesize with the reviewer's
  // specific issues injected as revision instructions, then re-review. If
  // the retry clears (verdict=good) we swap the draft AND replace the review
  // object so the user never sees the failed review chip in the UI.
  //
  // Only one retry attempt — bounded to keep the cost predictable. If the
  // retry STILL doesn't pass, we fall back to whichever has the better
  // quality score (retry vs. original) so the user gets the best version we
  // have rather than the one with the lowest reviewer confidence.
  let reviewRetriedDraft: string | undefined;
  let postRetryReview: typeof review = review;
  // Use the current best draft (rescued or original) as the baseline so we
  // don't lose ground from the rescue paths above.
  const draftAfterRescues = rescuedSynth ?? synth.answer;
  if (
    review && review.verdict !== "good" && Array.isArray(review.issues) && review.issues.length > 0 &&
    draftAfterRescues.length >= MIN_REVIEW_CHARS
  ) {
    push(`peer review verdict=${review.verdict} (${(review.issues ?? []).slice(0, 2).join("; ").slice(0, 120)}) — retrying with reviewer's issues as guidance before returning to user`);
    try {
      // Stitch the reviewer's issues onto the task as explicit revision
      // instructions. The synthesizer's existing prompt machinery will then
      // bias toward fixing exactly the named problems.
      const issuesBlock = (review.issues ?? []).slice(0, 6).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n");
      const reviseGuidance = `\n\n--- REVISION INSTRUCTIONS (from peer review) ---\nThe previous draft was flagged with these specific issues. Address each one in the new version:\n${issuesBlock}\n\nProduce a tightened, corrected answer that fixes every issue above. Use the same evidence already gathered; do NOT add new fabrications. If the prior draft cited specific dates, contacts, or numbers, verify each against the evidence catalog and correct any inconsistencies. Drop filler.\n--- END REVISION INSTRUCTIONS ---`;
      const reviseTask = task + reviseGuidance;
      const retry = await synthesize(reviseTask, p, runs, opts.personaSystemSuffix, undefined, { forceComplex: true, push });
      if (retry && retry.answer.length >= MIN_REVIEW_CHARS) {
        // Re-run the peer review on the retry draft. If verdict is "good",
        // swap both the draft AND the review. If not, compare quality scores
        // and pick the better of the two.
        try {
          const reviewTool = findPrimitive("peer.review");
          if (reviewTool) {
            const retryReviewRaw: any = await reviewTool.handler({ task, answer: retry.answer });
            const retryReview = coerceReview(retryReviewRaw);
            if (retryReview.verdict === "good") {
              push(`retry cleared peer review (verdict=good, confidence=${retryReview.confidence ?? "?"}); using retry as final answer`);
              reviewRetriedDraft = retry.answer;
              postRetryReview = retryReview;
              finalSkillUsed = retry.skillUsed ?? finalSkillUsed;
              finalSkillScore = retry.skillScore ?? finalSkillScore;
            } else {
              // Not good — compare quality scores to pick the better draft.
              try {
                const qcheck = findPrimitive("quality.check");
                if (qcheck) {
                  const retryQ: any = await qcheck.handler({ task, answer: retry.answer, sources: buildEvidenceCatalog(runs) });
                  const baseQ: any = quality ?? { score: 0 };
                  const retryScore = Number(retryQ?.score ?? 0);
                  const baseScore = Number(baseQ?.score ?? 0);
                  if (retryScore > baseScore) {
                    push(`retry verdict=${retryReview.verdict} but quality improved (${baseScore} → ${retryScore}); using retry`);
                    reviewRetriedDraft = retry.answer;
                    postRetryReview = retryReview;
                    quality = { ...retryQ, reviewRetried: true, originalScore: baseScore };
                    finalSkillUsed = retry.skillUsed ?? finalSkillUsed;
                    finalSkillScore = retry.skillScore ?? finalSkillScore;
                  } else {
                    push(`retry verdict=${retryReview.verdict} and quality not improved (${retryScore} ≤ ${baseScore}); keeping the rescued/original draft`);
                  }
                }
              } catch (e: any) {
                push(`retry quality compare failed (${String(e?.message ?? e).slice(0, 60)}); keeping the rescued/original draft`);
              }
            }
          }
        } catch (e: any) {
          push(`retry re-review failed (${String(e?.message ?? e).slice(0, 60)}); keeping the rescued/original draft`);
        }
      } else {
        push(`retry synth too short (${retry?.answer.length ?? 0} chars); keeping the rescued/original draft`);
      }
    } catch (e: any) {
      push(`review-driven retry failed: ${String(e?.message ?? e).slice(0, 80)}; keeping the rescued/original draft`);
    }
  }

  // Final answer precedence:
  //   1. Review-driven retry if it cleared (or beat the rescued draft on
  //      quality) — most recent + most informed by reviewer feedback.
  //   2. Rescued synth (large OR model) if it scored better — strongest
  //      output we have; favour it over a small-model peer review revision.
  //   3. Reviewer revision if reviewer flagged + provided one AND no rescue
  //      happened (so the small-model draft isn't surfacing untouched).
  //   4. Original synth.
  // Original is preserved on the (final) review object for audit either way.
  const reviewForFinal = postRetryReview;
  const finalAnswer = reviewRetriedDraft
    ? reviewRetriedDraft
    : (rescuedSynth
        ? rescuedSynth
        : ((reviewForFinal && reviewForFinal.verdict !== "good" && reviewForFinal.revised_answer)
            ? reviewForFinal.revised_answer
            : synth.answer));

  return {
    task, plan: p, runs, answer: finalAnswer, hadWrites, review: reviewForFinal, quality, security, budgets, subagentTimings,
    skillUsed: finalSkillUsed,
    skillScore: finalSkillScore,
  };
}

function coerceReview(r: any): PeerReview {
  return {
    verdict: ["good", "needs-work", "bad"].includes(r.verdict) ? r.verdict : "needs-work",
    issues: Array.isArray(r.issues) ? r.issues : [],
    revised_answer: typeof r.revised_answer === "string" && r.revised_answer ? r.revised_answer : undefined,
    confidence: typeof r.confidence === "number" ? r.confidence : 0,
    reviewer: r.peer ?? r.reviewer,
    elapsedMs: r.elapsedMs,
  };
}

// Pulled-from-task search query: strip filler so the vault search actually
// hits the right notes. "give me a summary on neuroworks" → "neuroworks".
export function extractTopic(task: string): string {
  const stripped = task
    .replace(/^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|kindly\s+)?/i, "")
    .replace(/^(?:give\s+me\s+|tell\s+me\s+|show\s+me\s+|share\s+|provide\s+)/i, "")
    .replace(/^(?:a\s+|the\s+|an\s+)?(?:summary|overview|recap|tldr|brief|update|status|rundown)\s+(?:on|of|about|for|regarding)\s+/i, "")
    .replace(/^(?:summari[sz]e|recap|brief\s+me\s+on|tell\s+me\s+about|what(?:'?s|\s+is)\s+(?:up\s+with\s+|going\s+on\s+with\s+)?|what\s+do\s+(?:we|i|you)\s+know\s+about)\s+/i, "")
    // "what my vault says about X" / "what my notes have on X" /
    // "what we know about X" / "what i have on X" tail — by this
    // point the verb prefix ("summarise", "tell me", etc.) has
    // already been stripped above, but the noisy "what (subject)
    // (verb) about/on" stem is still in the way. Strip it so the
    // captured topic is just X. Without this, "summarise what my
    // vault says about neuroworks" left "what my vault says about
    // neuroworks" as the topic, which then routed a literal web
    // search that hit Slovak-language sites matching "my".
    .replace(/^what\s+(?:my\s+(?:vault|notes?|brain|second\s+brain|knowledge|repo|repos?|files?|docs?|inbox)|the\s+(?:vault|repo|inbox)|we|i|you)\s+(?:says?|has|have|knows?|got|contain|contains|covers?|mentions?)\s+(?:about\s+|on\s+|of\s+|regarding\s+)?/i, "")
    // Drafting verbs: "draft an Aiia Reference Letter" → "Aiia Reference
    // Letter". Without this strip, the triage vault check searches for the
    // verb-prefixed phrase ("draft aiia reference letter") and gets zero
    // hits — letting the direct-answer path hallucinate the meaning of
    // proper nouns it doesn't know. Article (a/an/the/some/new) optional.
    .replace(/^(?:draft|write|compose|create|prepare|produce|generate|build|put\s+together|make)\s+(?:a\s+|an\s+|the\s+|some\s+|new\s+)?(?:short\s+|quick\s+|brief\s+|long\s+|formal\s+|professional\s+)?/i, "")
    // After the verb strips above run, a leading noise preposition often
    // remains: "tell me " (stripped) leaves "about neuroworks"; "give me
    // info " leaves "on neuroworks"; "summary on neuroworks" leaves "on
    // neuroworks" when the summary strip narrowly misses. Drop the bare
    // preposition so the topic is the actual subject.
    .replace(/^(?:about|regarding|concerning|on|of)\s+/i, "")
    .replace(/[?!.]+$/, "")
    .trim();
  return stripped || task.trim();
}

// Heuristic planner. Matches common task shapes to a single-tool plan
// without calling the LLM, eliminating 3-8s of planner latency on the most
// frequent ad-hoc tasks. Falls through (returns null) when nothing matches.
//
// Shapes covered:
//   • URL-only or "scrape/browse/open <url>" → web.scrape
//   • "tell me about X" / "explain X" / "what is X" → research.deep
//   • Bare vault-path mention ("read 2-Permanent/x.md") → vault.read
//   • "search the web for X" → research.deep
export function heuristicPlan(task: string, opts: { hasAttachments?: boolean } = {}): Plan | null {
  const t = task.trim();
  if (!t) return null;
  // Finance-readout tasks bail out to the real LLM planner, which carries
  // the financeContext hint steering it to connector.call on "Aiia
  // FinanceFlow". Without this, the research-signal heuristic below (any
  // recency marker like "latest") intercepts first and routes straight to
  // research.deep — the planner-side hint never gets a chance to run.
  if (FINANCE_READOUT_RE.test(t)) return null;
  // Notepad — "what's in my notepad", "summarise my notepad notes", "read my
  // notepad". Deterministic single step to system.notepad. Without this the
  // LLM planner routed to fs.find_in with the whole sentence as a FILENAME
  // ("whats in my notepad" → zero matches — caught live 2026-07-21). Must
  // beat the generic read/summarise shapes below.
  if (NOTEPAD_RE.test(t)) {
    return {
      steps: [{ tool: "system.notepad", args: {}, rationale: "read the Windows Notepad tabs (incl. unsaved)", label: humanStepLabel("system.notepad", {}) }],
      summary: "Read the user's Notepad (including unsaved tabs).",
      waves: [[0]],
    };
  }
  // Self-contained email send — "send an email to <addr> with subject X and
  // body Y". DETERMINISTIC because the LLM planner falls through to the default
  // research plan on a timeout and web-searches the request instead of sending
  // (caught live 2026-07-21: an explicit send returned the {to,subject,body} as
  // JSON via research.deep, no mail sent). Only fires when the recipient AND
  // body are literally present; evidence-needing sends ("email me a summary of
  // X") return null and stay on the LLM path with the emailContext hint.
  if (EMAIL_SEND_RE.test(t)) {
    const parsed = parseSelfContainedEmail(t);
    if (parsed) {
      return {
        steps: [{ tool: "email.send", args: { to: parsed.to, subject: parsed.subject, body: parsed.body }, rationale: "send the email via the Mailjet bridge", label: humanStepLabel("email.send", { to: parsed.to }) }],
        summary: `Send an email to ${parsed.to}.`,
        waves: [[0]],
      };
    }
  }
  // Org-structure tasks get a DETERMINISTIC plan: pull the whole org picture
  // (humans, AI agents, department data) and let synthesis draft from it.
  // Deliberately NOT a bail-to-LLM-planner: when the planner model times out,
  // the generic fallback cascade routes to research.deep, which can only
  // refuse or hallucinate about a private company — caught live 2026-07-19
  // ("What departments exist in our organization?" → gemini plan timeout →
  // default research plan → web search → truncated nonsense). The plan()-level
  // orgContext hint still covers org tasks that arrive by other routes.
  if (ORG_STRUCTURE_RE.test(t)) {
    return {
      steps: [
        { tool: "users.list", args: {}, rationale: "every human in the org — name, title, department, role", label: humanStepLabel("users.list", {}) },
        { tool: "personas.list", args: {}, rationale: "every AI agent — role, job description, responsibilities, work mode", label: humanStepLabel("personas.list", {}) },
        { tool: "company.department_data", args: {}, rationale: "operator-curated department facts and policies", label: humanStepLabel("company.department_data", {}) },
        { tool: "vault.search", args: { query: "organizational structure strategic plan governance" }, rationale: "official company documents (_company uploads: strategic plan, governance policy, org structure) — extracted sidecars are vault-indexed", label: humanStepLabel("vault.search", { query: "organizational structure strategic plan governance" }) },
      ],
      summary: "Organization-structure task — ground on the org's own records (people, agents, departments), then draft.",
      waves: [],
    };
  }
  // Image-generation tasks get a DETERMINISTIC single-step media.image plan.
  // The LLM planner is unreliable here: caught live 2026-07-19 planning
  // vault.search + fs.find_in (hunting for an existing logo FILE) and then
  // emitting raw tool-call JSON as the "answer". Routing straight to
  // media.image guarantees the studio tool actually runs; the handler returns
  // a friendly "no provider configured" message when no key is set, which the
  // synth relays honestly. Prompt = the user's request verbatim (the model
  // arg is left unset so the provider default — Ideogram — applies; agents
  // wanting a specific model use the tool directly via the LLM path).
  // "what image models do we have / list the studio models" → discovery.
  if (/\b(?:list|show|what|which)\b.*\b(?:image|studio|generation|generative)\s+models?\b/i.test(t) || /\bstudio\s+models?\b/i.test(t)) {
    return {
      steps: [{ tool: "media.studio_models", args: {}, rationale: "list available generative-media models", label: humanStepLabel("media.studio_models", {}) }],
      summary: "List the studio's generative-media models.",
      waves: [],
    };
  }
  // Recurring-schedule creation — deterministic parse of the common phrasing
  // ("create a schedule called X: every weekday at 08:00 <task>"). Without
  // this the summarize/doc heuristics hijack the task (caught live 2026-07-19:
  // planned vault.search + fs.find_in and never created anything). Falls
  // through to the LLM planner (which gets scheduleContext) when the work
  // text can't be extracted confidently.
  if (/\b(?:create|set\s+up|make|add|start)\b[^.\n]{0,50}\b(?:recurring\s+)?schedule\b|\bschedule\b[^.\n]{0,30}\bevery\b|\bevery\s+(?:weekday|day|morning|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.\n]{0,40}\bat\s+\d/i.test(t)) {
    const time = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    let hour = time ? Number(time[1]) : 8;
    const minute = time?.[2] ? Number(time[2]) : 0;
    const ampm = time?.[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const DAY_IDX: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    let days: number[] = [];
    if (/\bevery\s+weekday\b|\bweekdays\b/i.test(t)) days = [1, 2, 3, 4, 5];
    else for (const [dn, idx] of Object.entries(DAY_IDX)) if (new RegExp(`\\bevery\\s+${dn}\\b`, "i").test(t)) days.push(idx);
    const nameMatch = t.match(/\bcalled\s+["“]?([^":,.\n]{3,60})/i);
    const email = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
    // The work each fire runs = text AFTER the time phrase; else after the
    // last colon. Strip a trailing "and email it to <addr>" clause when the
    // address became deliver_email — otherwise every fire sends twice.
    let work = "";
    if (time && time.index != null) work = t.slice(time.index + time[0].length).replace(/^[\s,:—-]+/, "").trim();
    if (!work) { const ci = t.lastIndexOf(":"); if (ci > 0) work = t.slice(ci + 1).trim(); }
    if (email && work) work = work.replace(/[\s,]*(?:and|then)\s+(?:email|send|deliver)\b[\s\S]*$/i, "").trim();
    if (work.length >= 12 && Number.isInteger(hour) && hour >= 0 && hour <= 23) {
      const name = nameMatch?.[1]?.trim() ?? `Scheduled: ${work.slice(0, 50)}`;
      return {
        steps: [
          { tool: "schedule.create", args: { name, task: work, hour, minute, ...(days.length ? { days_of_week: days.join(",") } : {}), ...(email ? { deliver_email: email } : {}) }, rationale: "create the recurring schedule the user described", label: humanStepLabel("schedule.create", { name }) },
        ],
        summary: `Create recurring schedule "${name}" — ${days.length ? `days ${days.join(",")}` : "daily"} at ${hour}:${String(minute).padStart(2, "0")}.`,
        waves: [],
      };
    }
  }
  // Send/email already-generated images — MUST outrank the image-gen branch:
  // "email the image of the leaf we made" contains "image of" and would
  // otherwise REGENERATE instead of attaching the existing file. Deterministic
  // only when the task carries a literal address; otherwise the planner hint
  // (mediaSendContext) guides the LLM to resolve the recipient first.
  if (SEND_MEDIA_RE.test(t)) {
    const addrMatch = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const countMatch = t.match(/\b(?:last|latest|most\s+recent|recent|top)\s+(\d{1,2})\b|\b(\d{1,2})\s+(?:most\s+recently|latest|last|recent)\b/i);
    const count = Number(countMatch?.[1] ?? countMatch?.[2] ?? (/(images|pictures|visuals|photos)\b/i.test(t) ? 3 : 1)) || 3;
    if (addrMatch) {
      return {
        steps: [
          { tool: "media.list", args: { count }, rationale: "locate the most recently generated images (they live in the studio media folder, not the vault)", label: humanStepLabel("media.list", { count }) },
          { tool: "email.send", args: { to: addrMatch[0], subject: "Requested images", body: `Here ${count === 1 ? "is the most recently generated image" : `are the ${count} most recently generated images`} from the studio, attached.`, attach_paths: "$step_0.pathsJoined" }, rationale: "email the images as attachments", label: humanStepLabel("email.send", { to: addrMatch[0] }) },
        ],
        summary: `Send the ${count} newest generated image${count === 1 ? "" : "s"} to ${addrMatch[0]}.`,
        waves: [],
      };
    }
  }
  // Video generation — DETERMINISTIC single-step media.video plan. Without this
  // "make a promo video of X" fell to the LLM planner, which treated it as a
  // research/draft task (vault.search + fs.find_in) and then FABRICATED a
  // "sent to media.video — key not configured" line in prose while no
  // media.video step ever ran (caught live 2026-07-23). Must beat IMAGE_GEN_RE
  // (below) so a video request never routes to media.image. When MiniMax is
  // unconfigured, media.video returns a friendly error the synth relays
  // honestly (see the video/audio media short-circuit in synthesize()).
  // Connector / data-source inventory — go straight to the catalog rather than
  // the web. connector.list + db.list_sources are independent (parallel wave).
  if (CONNECTOR_INVENTORY_RE.test(t)) {
    return {
      steps: [
        { tool: "connector.list", args: {}, rationale: "enumerate the operator's configured connectors", label: humanStepLabel("connector.list", {}) },
        { tool: "db.list_sources", args: {}, rationale: "enumerate the operator's configured databases", label: humanStepLabel("db.list_sources", {}) },
      ],
      summary: "Inventory the available connectors + data sources (connector.list, db.list_sources).",
      waves: [[0, 1]],
    };
  }
  if (VIDEO_GEN_RE.test(t)) {
    return {
      steps: [{ tool: "media.video", args: { prompt: t.slice(0, 1500) }, rationale: "text-to-video studio generation", label: humanStepLabel("media.video", { prompt: t.slice(0, 60) }) }],
      summary: "Video generation — text-to-video via the studio (media.video).",
      waves: [],
    };
  }
  if (IMAGE_GEN_RE.test(t)) {
    const aspect = /\b(16[:x]9|widescreen|banner|hero)\b/i.test(t) ? "16:9"
      : /\b(9[:x]16|portrait|story|reel|vertical)\b/i.test(t) ? "9:16"
      : /\b(4[:x]5|social\s+post)\b/i.test(t) ? "4:5"
      : "1:1";
    return {
      steps: [
        { tool: "media.image", args: { prompt: t.slice(0, 1500), aspect_ratio: aspect }, rationale: "text-to-image studio generation", label: humanStepLabel("media.image", { prompt: t.slice(0, 60) }) },
      ],
      summary: "Image generation — text-to-image via the studio (media.image).",
      waves: [],
    };
  }
  // Ad/campaign creative — generate the visual asset deterministically; the
  // synth then writes the copy and appends the guaranteed download block
  // (see the media short-circuit in synthesize()). Without this branch these
  // tasks direct-synthed a text-only plan and no downloadable existed.
  if (AD_CREATIVE_RE.test(t)) {
    const aspect = /\b(16[:x]9|widescreen|banner|hero|youtube)\b/i.test(t) ? "16:9"
      : /\b(9[:x]16|portrait|story|stories|reel|tiktok|vertical)\b/i.test(t) ? "9:16"
      : /\b(4[:x]5|social\s+(?:post|ad)|instagram|facebook)\b/i.test(t) ? "4:5"
      : "1:1";
    return {
      steps: [
        { tool: "media.image", args: { prompt: `Professional, high-production-value advertisement visual for this brief (brand-appropriate, striking composition, no placeholder text): ${t.slice(0, 1200)}`, aspect_ratio: aspect }, rationale: "generate the ad's downloadable visual asset", label: humanStepLabel("media.image", { prompt: t.slice(0, 60) }) },
      ],
      summary: "Ad creative — generate the visual (media.image), then write the copy.",
      waves: [],
    };
  }
  // When attachments are present, suppress the shape shortcuts that
  // funnel summarize/explain/research onto vault.search or research.deep.
  // The actual source material is already inline as an "Attached documents"
  // block — the LLM planner (or empty-plan + direct synth) handles it
  // correctly. Without this gate "summarize this" on a 2 KB attached doc
  // planned `research.deep` for the literal word "this" and produced a
  // dictionary definition.
  const hasAttachments = opts.hasAttachments === true;

  // Import-to-vault: "move/copy/import/save/file/add X to my vault" /
  // "save X to my knowledge" / "put X in neuroworks". Chains fs.find_in
  // (to resolve a bare filename across user folders) → fs.import_to_vault
  // (copy the binary + write a markdown sidecar so it shows up in the
  // knowledge view). MUST match before the read-only doc heuristic below,
  // because "save X to my vault" superficially looks like a read request.
  //
  // We detect the "remove original" intent from the verb: "move" with
  // "and delete" / "and remove from" implies removeOriginal=true. Bare
  // "move" stays copy-semantics — the user typically wants a backup, not
  // an evacuation.
  // Matches either:
  //   <verb> <target> (in)?to my? vault|knowledge|second brain|neuroworks|...
  //   <verb> <target> (in)?to 0-Inbox|1-Literature|1-projects|2-Permanent
  const importMatch =
    // Optional trailing modifier handles "...to my vault and delete the
    // original" / "...to neuroworks and remove from downloads". The
    // removeOriginal flag below detects that modifier on the FULL task,
    // so the regex only needs to TOLERATE the trailing phrase.
    t.match(/^\s*(?:please\s+|could\s+you\s+|can\s+you\s+)?(?:move|copy|import|save|file|add|put|drop|stash|archive)\s+(.+?)\s+(?:(?:in)?to|into|to|in)\s+(?:my\s+|the\s+)?(?:vault|second\s+brain|knowledge(?:\s+base)?|neuroworks|obsidian|brain|inbox|0-inbox|1-literature|1-projects|2-permanent)(?:\s+(?:and\s+(?:then\s+)?|then\s+)?(?:delete|remove)\s+(?:the\s+)?(?:original|originals|source|copy|file|it)?(?:\s+from\s+\w+)?)?\s*[.?!]?\s*$/i);
  if (importMatch) {
    // Strip leading articles AND the "and delete/remove" intent suffix so the
    // captured target is just the filename. E.g. "and delete tax-return.pdf"
    // → "tax-return.pdf" (the remove flag is detected separately on the full t).
    const target = importMatch[1].trim()
      .replace(/^(?:and\s+(?:then\s+)?(?:delete|remove)\s+)/i, "")
      .replace(/^(?:then\s+(?:delete|remove)\s+)/i, "")
      .replace(/^(?:the\s+|this\s+|that\s+|a\s+|an\s+)/i, "")
      .replace(/[.?!]+$/, "")
      .trim();
    // Whole-folder imports aren't supported by fs.import_to_vault (it imports
    // one file at a time). If the user asked for a folder, fall through to
    // the planner so it can build a multi-step plan.
    const looksLikeFolder = /^(?:downloads?|desktop|documents?|docs|all\s+(?:my\s+)?(?:pdfs?|docs?|files?))$/i.test(target);
    if (!looksLikeFolder && target.length >= 2 && target.length <= 200) {
      // Heuristic for removal: explicit "move ... and delete/remove" — or
      // a literal "move ... to my vault and remove from <folder>".
      const removeOriginal = /\b(?:and\s+(?:delete|remove)|then\s+(?:delete|remove)|move\s+and\s+delete)\b/i.test(t);
      // If the target ALREADY looks like an absolute path, skip the find
      // step — go straight to import.
      const isAbsolute = /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("/");
      if (isAbsolute) {
        return {
          steps: [
            {
              tool: "fs.import_to_vault",
              args: { path: target, vaultFolder: "0-Inbox", removeOriginal },
              rationale: "absolute-path import — copy into vault + write sidecar",
              label: humanStepLabel("fs.import_to_vault", { path: target, vaultFolder: "0-Inbox" }),
            },
          ],
          summary: `Import ${target.split(/[\\/]/).pop() ?? target} into your second brain`,
          waves: [[0]],
        };
      }
      return {
        steps: [
          {
            tool: "fs.find_in",
            args: { folder: "all", name: target, limit: 5 },
            rationale: "resolve the named file across Downloads + Desktop + Documents + Inbox before importing",
            label: humanStepLabel("fs.find_in", { folder: "all", name: target }),
          },
          {
            tool: "fs.import_to_vault",
            args: { path: "$step_0.matches.0.path", vaultFolder: "0-Inbox", removeOriginal },
            rationale: "copy the top match into the vault and write a markdown sidecar so it shows up in NeuroWorks Knowledge",
            label: humanStepLabel("fs.import_to_vault", { path: target, vaultFolder: "0-Inbox" }),
          },
        ],
        summary: `Find "${target}" on your PC and ${removeOriginal ? "move" : "copy"} it into your second brain`,
        waves: [[0], [1]],
      };
    }
  }

  // Vault path read MUST match before the local-doc heuristic below.
  // "read 0-Inbox/note.md" superficially looks like docPhraseMatch's
  // ".md path" branch, but docPhraseMatch routes to fs.find_in (which
  // sweeps Downloads/Desktop/Documents/Inbox, NOT the vault) — the file
  // would never be found. The slash-required regex prevents this from
  // catching bare filenames ("read foo.md") that genuinely need the
  // local-doc sweep.
  const vaultPathMatch = t.match(/^\s*(?:read|show(?:\s+me)?|open|cat)\s+([\w._-]+(?:[/\\][\w._-]+)+\.md)\s*$/i);
  if (vaultPathMatch) {
    const path = vaultPathMatch[1].replace(/\\/g, "/");
    return {
      steps: [{ tool: "vault.read", args: { path }, rationale: "direct vault read — slashed path resolves inside the vault", label: humanStepLabel("vault.read", { path }) }],
      summary: `Read ${path} from your vault`,
      waves: [[0]],
    };
  }

  // Vault folder listing: "list 5 notes from my vault inbox folder" /
  // "show me the files in my vault" / "list notes in inbox". Maps common
  // folder words ("inbox", "knowledge", "neuroworks", "jobs", "archive")
  // onto the real vault paths. Without this heuristic the planner falls
  // back to research.deep, which never finds folder listings — round-2
  // harness showed a refusal because research returned nothing relevant.
  const vaultFolderAliases: Record<string, string> = {
    inbox: "0-Inbox",
    "0-inbox": "0-Inbox",
    knowledge: "_knowledge",
    neuroworks: "_neuroworks",
    jobs: "_neuroworks/jobs",
    archive: "_archive",
    summaries: "_clawbot/summaries",
    clawbot: "_clawbot",
    decisions: "",
    root: "",
    vault: "",
  };
  const vaultListMatch = t.match(/^\s*(?:list|show(?:\s+me)?|what(?:'?s|\s+is|\s+are))\s+(?:\d+\s+|the\s+|all\s+|some\s+|a\s+few\s+|recent\s+|latest\s+)?(?:notes?|files?|items?|things?|entries?|docs?|markdown(?:\s+files?)?)\s+(?:in|from|under|inside)\s+(?:my\s+|the\s+|your\s+)?(?:vault(?:'s)?\s+)?(?:(?:in\s+the\s+|the\s+)?([\w/.-]+?)\s+folder|folder\s+([\w/.-]+)|([\w/.-]+?))\s*[.?!]?\s*$/i);
  if (vaultListMatch) {
    const raw = (vaultListMatch[1] ?? vaultListMatch[2] ?? vaultListMatch[3] ?? "").toLowerCase().trim().replace(/^my\s+|^the\s+|^your\s+/i, "");
    const path = raw in vaultFolderAliases ? vaultFolderAliases[raw] : raw;
    // Pull explicit count if present, so the synth knows how many to show.
    const countMatch = t.match(/\b(\d+)\s+(?:notes?|files?|items?|things?|entries?|docs?)/i);
    const limit = countMatch ? Math.min(50, Math.max(1, parseInt(countMatch[1], 10))) : undefined;
    return {
      steps: [{
        tool: "vault.list",
        args: { path },
        rationale: `list ${limit ?? "all"} entries in vault folder "${path || "<root>"}"`,
        label: humanStepLabel("vault.list", { path }),
      }],
      summary: `List entries in ${path || "vault root"}`,
      waves: [[0]],
    };
  }

  // Vault folder scan (summarise multiple docs): "summarise the docs in
  // 0-Inbox" / "what's in my knowledge folder" / "read all notes in
  // _clawbot" / "scan my inbox docs". Routes to vault.scan_docs which
  // reads MANY docs in parallel and returns extracted text. Without
  // this heuristic the LLM planner often picks research.deep which
  // misses the user's actual files.
  const vaultScanMatch = t.match(
    /^\s*(?:summari[sz]e|scan|read|skim|brief\s+me\s+on)\s+(?:all\s+)?(?:the\s+|my\s+|your\s+)?(?:docs?|documents?|notes?|files?|content|markdown(?:\s+files?)?|entries?)\s+(?:in|inside|under|from)\s+(?:my\s+|the\s+|your\s+)?(?:vault(?:'s)?\s+)?(?:([\w/.-]+?)\s+folder|folder\s+([\w/.-]+)|([\w/.-]+?))\s*[.?!]?\s*$/i,
  );
  if (vaultScanMatch) {
    const raw = (vaultScanMatch[1] ?? vaultScanMatch[2] ?? vaultScanMatch[3] ?? "").toLowerCase().trim().replace(/^my\s+|^the\s+|^your\s+/i, "");
    const folderAliases: Record<string, string> = {
      inbox: "0-Inbox", "0-inbox": "0-Inbox",
      knowledge: "_knowledge", neuroworks: "_neuroworks",
      jobs: "_neuroworks/jobs", archive: "_archive",
      summaries: "_clawbot/summaries", clawbot: "_clawbot",
    };
    const folder = (raw in folderAliases) ? folderAliases[raw] : raw;
    return {
      steps: [{
        tool: "vault.scan_docs",
        args: { folder, limit: 12 },
        rationale: "scan multiple docs in the named vault folder and return extracted text for synthesis",
        label: humanStepLabel("vault.scan_docs", { folder }),
      }],
      summary: `Scan docs in vault folder "${folder || "<root>"}"`,
      waves: [[0]],
    };
  }

  // Local-doc lookup WITHOUT a folder hint: "what's in this doc X" /
  // "summarise this pdf X" / "read this file X" / "open X.pdf". The customer
  // hasn't told us which folder — we sweep Downloads + Desktop + Documents +
  // Inbox in parallel via fs.find_in folder='all'. Catches the common shape
  // where someone refers to a doc by name without remembering where they put
  // it. Routes BEFORE the URL/research patterns so we never fall through to
  // a web search on a doc the user already has locally.
  //
  // Patterns covered:
  //   • "what(?:'?s| is| does) (?:in |inside )?this (?:doc|file|pdf|note|letter|paper|document) X"
  //   • "summari[sz]e (?:this |the )?(?:doc|file|pdf|note|letter) X"
  //   • "read (?:this |the |)?X.(?:pdf|docx|md|txt|xlsx)"
  //   • Bare "X.pdf" / "X.docx" with optional verb prefix
  const docPhraseMatch =
    t.match(/^\s*(?:please\s+|could\s+you\s+|can\s+you\s+)?(?:what(?:'?s|\s+is|\s+does)\s+(?:in\s+|inside\s+|about\s+)?(?:this\s+|the\s+|that\s+)?(?:doc|document|file|pdf|note|letter|paper|memo|report|deck)\s+(?:called\s+|named\s+|titled\s+)?(.+?))(?:[?.!]|\s*$)/i) ??
    t.match(/^\s*(?:please\s+|could\s+you\s+|can\s+you\s+)?(?:summari[sz]e|recap|tldr|brief\s+me\s+on|read|open|show\s+me)\s+(?:this\s+|the\s+|that\s+)?(?:doc(?:ument)?|file|pdf|note|letter|paper|memo|report|deck)\s+(?:called\s+|named\s+|titled\s+)?(.+?)\s*[?.!]?\s*$/i) ??
    t.match(/^\s*(?:please\s+|could\s+you\s+|can\s+you\s+)?(?:summari[sz]e|recap|tldr|read|open|show\s+me)\s+(.+?\.(?:pdf|docx|md|txt|xlsx|pptx))\s*[?.!]?\s*$/i);
  if (docPhraseMatch) {
    const name = docPhraseMatch[1].trim().replace(/[.?!]+$/, "");
    // Reject pronouns / placeholders that mean the user hasn't named anything
    // ("read this doc" with no name — better to ask).
    const isPronounOnly = /^(?:it|this|that|one|something|anything)\s*$/i.test(name);
    if (!isPronounOnly && name.length >= 2 && name.length <= 200) {
      return {
        steps: [
          {
            tool: "fs.find_in",
            args: { folder: "all", name, limit: 5 },
            rationale: "local-doc lookup (no folder hint) — sweep Downloads + Desktop + Documents + Inbox",
            label: humanStepLabel("fs.find_in", { folder: "all", name }),
          },
          {
            tool: "fs.read_external",
            args: { path: "$step_0.matches.0.path" },
            rationale: "read the top match (newest first) to surface its contents",
            label: "Reading the top match",
          },
        ],
        summary: `Find and read "${name}" from your usual doc folders`,
        waves: [[0], [1]],
      };
    }
  }

  // Local-file lookup WITH an explicit folder hint: "check/look/find/search in
  // my downloads for X" / "look in my desktop for X" / "open the Aiia letter
  // in my documents" — etc.
  // Routes to fs.find_in + fs.read_external so PDFs/DOCXs run through the
  // doc-extractor cleanly. Chained via $step_0 reference so a single match
  // gets read automatically; the synth handles the "tell me what's inside"
  // suffix without needing a separate step.
  //
  // CRITICAL: matches BEFORE the URL/research patterns so the LLM planner
  // never sees this shape (the previous behaviour was a 3-minute web research
  // run for "check my downloads for Aiia Reference Letter").
  // TWO shapes supported:
  //   (A) folder-first: "find in my downloads for X" / "look in my desktop X"
  //   (B) name-first:   "find X in my downloads" / "look for X in my desktop"
  // Both extract folder + name and route through fs.find_in. (B) is the
  // natural shape most people type; (A) was the only one this heuristic
  // handled before, which left "find resume.pdf in my downloads" falling
  // through to the LLM planner → research.deep on the bare phrase.
  const localFileMatch = t.match(
    /^\s*(?:(?:please\s+|could\s+you\s+|can\s+you\s+)?(?:check|look|find|search|browse|see|grab|open|read)\s+(?:in\s+)?)?my\s+(downloads?|desktop|documents?|docs|inbox|vault|home(?:\s+folder)?)\s+(?:folder\s+)?(?:for\s+|to\s+find\s+|to\s+see\s+|to\s+look\s+up\s+)?(.+?)(?:\s+(?:and|then|to)\s+(?:tell|show|read|summari[sz]e|explain).*)?\s*[.?!]?\s*$/i,
  ) ?? t.match(
    /^\s*(?:please\s+|could\s+you\s+|can\s+you\s+)?(?:check|look|find|search|browse|locate|grab)\s+(?:for\s+|up\s+)?(.+?)\s+(?:in|inside|under|on)\s+(?:my\s+|the\s+|your\s+)?(downloads?|desktop|documents?|docs|inbox|vault|home(?:\s+folder)?)\s*(?:\s+(?:and|then|to)\s+(?:tell|show|read|summari[sz]e|explain).*)?\s*[.?!]?\s*$/i,
  );
  if (localFileMatch) {
    // Disambiguate which group is folder vs name. Shape (A) captures folder
    // first; shape (B) captures name first. The alternation order above
    // means shape (A) returns groups [folder, name] and shape (B) returns
    // [name, folder]. Detect by checking which group looks like a known
    // folder word.
    const KNOWN_FOLDERS = /^(?:downloads?|desktop|documents?|docs|inbox|vault|home(?:\s+folder)?)$/i;
    const g1 = localFileMatch[1] ?? "";
    const g2 = localFileMatch[2] ?? "";
    let folderRaw: string, name: string;
    if (KNOWN_FOLDERS.test(g1.trim())) {
      folderRaw = g1.toLowerCase().replace(/\s+folder/, "");
      name = g2.trim().replace(/[.?!]+$/, "");
    } else {
      folderRaw = g2.toLowerCase().replace(/\s+folder/, "");
      name = g1.trim().replace(/[.?!]+$/, "");
    }
    // Map "docs" → "documents", "home folder" → "home", strip trailing 's'
    // for downloads/documents so both forms match.
    const folder = folderRaw === "docs" ? "documents"
                 : folderRaw === "downloads" ? "downloads"
                 : folderRaw === "document" ? "documents"
                 : folderRaw === "download" ? "downloads"
                 : folderRaw;
    if (name && name.length >= 2 && name.length <= 200) {
      return {
        steps: [
          {
            tool: "fs.find_in",
            args: { folder, name, limit: 5 },
            rationale: "local-file lookup shape recognised — find matching file in user's folder",
            label: humanStepLabel("fs.find_in", { folder, name }),
          },
          {
            // Read the top match. fs.read_external routes PDF/DOCX/XLSX
            // through the doc-extractor so binary contents become readable
            // text for the synth to summarise.
            tool: "fs.read_external",
            args: { path: "$step_0.matches.0.path" },
            rationale: "read the top match (newest first) to surface its contents",
            label: "Reading the top match",
          },
        ],
        summary: `Look in your ${folder} for "${name}" and surface its contents`,
        waves: [[0], [1]],
      };
    }
  }

  // Bare URL or scrape/browse/open <url>
  const urlMatch = t.match(/^\s*(?:(?:scrape|browse|open|fetch|read)\s+)?(https?:\/\/\S+)\s*$/i);
  if (urlMatch) {
    const url = urlMatch[1];
    return {
      steps: [{ tool: "web.scrape", args: { url }, rationale: "single URL — render in Playwright", label: humanStepLabel("web.scrape", { url }) }],
      summary: `Scrape ${url}`,
      waves: [[0]],
    };
  }

  // Vault path read: "read 2-Permanent/x.md" or "show me 0-Inbox/note.md"
  const pathMatch = t.match(/^\s*(?:read|show(?:\s+me)?|open|cat)\s+([\w./_-]+\.md)\s*$/i);
  if (pathMatch) {
    const path = pathMatch[1];
    return {
      steps: [{ tool: "vault.read", args: { path }, rationale: "direct vault read", label: humanStepLabel("vault.read", { path }) }],
      summary: `Read ${path}`,
      waves: [[0]],
    };
  }

  // "search the web for X" (forces research.deep instead of just web.search,
  // because the user usually wants synthesis too)
  const webSearchMatch = t.match(/^\s*(?:search|google|look\s+up)\s+(?:the\s+)?(?:web|online|internet)\s+(?:for\s+)?(.+?)\s*$/i);
  if (webSearchMatch) {
    const query = webSearchMatch[1];
    return {
      steps: [{ tool: "research.deep", args: { query, depth: 3, capture: true }, rationale: "web research with vault capture", label: humanStepLabel("research.deep", { query }) }],
      summary: `Research: ${query}`,
      waves: [[0]],
    };
  }

  // GitHub "ALL repos" overview: "summarize all GitHub repos", "list all my
  // repos and give an overview", "what repos do we have on GitHub". MUST match
  // before the per-repo lookup below and does NOT require a possessive ("my"/
  // "our") — caught live 2026-07-20: "Summarize all GitHub repos and give me
  // an overview" (no "my") fell past the possessive-gated plan() hint into
  // research.deep, which web-searched generic GitHub docs and reported "no
  // repositories available". Routes to github.list_repos → ollama.generate
  // overview. github.list_repos enumerates the authenticated user's repos
  // (owner/collaborator/org) — the web can't see private repos at all.
  const ghAllReposMatch =
    /\b(?:summari[sz]e|list|show|overview\s+of|enumerate|what)\b[^.\n]{0,40}\b(?:all\s+|my\s+|our\s+|the\s+)?(?:git\s?hub|gh)\s+(?:repos?|repositories)\b/i.test(t) ||
    /\b(?:summari[sz]e|list|show|enumerate)\b[^.\n]{0,20}\b(?:all\s+)?(?:my|our)\s+(?:repos?|repositories)\b/i.test(t) ||
    /\b(?:all|list)\s+(?:my|our|the)\s+(?:git\s?hub\s+)?(?:repos?|repositories)\b/i.test(t);
  if (ghAllReposMatch) {
    return {
      steps: [
        { tool: "github.list_repos", args: {}, rationale: "enumerate every GitHub repo the user can access", label: humanStepLabel("github.list_repos", {}) },
        { tool: "ollama.generate", args: { prompt: `Write a concise overview of these GitHub repositories — one short bullet per repo (name — what it is, primary language, last push if notable). Group or highlight the most active. Repositories:\n$step_0.repos`, profile: "synthesis" }, rationale: "summarise the repo list into an overview", label: humanStepLabel("ollama.generate", {}) },
      ],
      summary: "List all GitHub repos, then write a per-repo overview.",
      waves: [[0], [1]],
    };
  }

  // GitHub-repo lookups: "list the open PRs in <repo>", "show me PRs/issues
  // for <repo>", "what's in <owner>/<repo>". Routes to github.read_repo
  // which returns commits + PRs + issues + README in one call. Without
  // this heuristic, the LLM planner often picks research.deep (web
  // search) which doesn't know GitHub state and answers with "no info
  // available" — graded B at best, refuses-without-trying.
  //
  // Repo name resolution:
  //   - "owner/name" → exact owner + name
  //   - bare "name"   → use config.githubOwner from env
  const ghRepoMatch = t.match(/^\s*(?:please\s+|could\s+you\s+|can\s+you\s+)?(?:list|show(?:\s+me)?|what(?:'?s|\s+are)?)\s+(?:the\s+)?(?:open\s+|all\s+|recent\s+|current\s+)?(?:prs?|pull\s+requests?|issues?|commits?|pr|pull-requests?)\s+(?:in|for|on|of)\s+(?:the\s+)?(?:repo\s+)?([\w./-]+?)\s*[.?!]?\s*$/i);
  if (ghRepoMatch) {
    const target = ghRepoMatch[1].trim();
    let owner: string, name: string;
    if (target.includes("/")) {
      [owner, name] = target.split("/");
    } else {
      owner = config.githubOwner || "";
      name = target;
    }
    if (owner && name) {
      return {
        steps: [{
          tool: "github.read_repo",
          args: { owner, name },
          rationale: `GitHub repo lookup — pull commits, PRs, issues, README for ${owner}/${name}`,
          label: humanStepLabel("github.read_repo", { owner, name }),
        }],
        summary: `Read ${owner}/${name} from GitHub`,
        waves: [[0]],
      };
    }
  }

  // GitHub README lookups: "fetch the README of <repo> on github" /
  // "read the readme of <repo>" / "show me what <repo> does on github" /
  // "what does <repo>'s README say". Routes to github.read_repo so the
  // README + recent state come back in one call. Without this heuristic,
  // the LLM planner often picks github.get_file with path="README.md"
  // but forgets to resolve the owner from "the clawbot repo" → the
  // call fails with "no such file" because owner defaults to empty.
  const ghReadmeMatch =
    t.match(/^\s*(?:please\s+|could\s+you\s+|can\s+you\s+)?(?:fetch|read|show(?:\s+me)?|get|grab|pull)\s+(?:the\s+)?(?:readme|read[\s-]?me)\s+(?:of\s+|for\s+|from\s+)?(?:the\s+)?([\w./-]+?)(?:\s+repo(?:sitory)?)?(?:\s+(?:on|from|in)\s+(?:github|gh))?(?:\s+and\s+.+)?\s*[.?!]?\s*$/i) ??
    t.match(/^\s*(?:please\s+|could\s+you\s+|can\s+you\s+)?(?:what\s+(?:does|is\s+in)|tell\s+me\s+about)\s+(?:the\s+)?([\w./-]+?)(?:'s)?(?:\s+repo(?:sitory)?)?\s+(?:readme|read[\s-]?me)(?:\s+(?:say|cover|describe))?(?:\s+(?:on|from)\s+(?:github|gh))?(?:\s+and\s+.+)?\s*[.?!]?\s*$/i);
  if (ghReadmeMatch) {
    const target = ghReadmeMatch[1].trim();
    let owner: string, name: string;
    if (target.includes("/")) {
      [owner, name] = target.split("/");
    } else {
      owner = config.githubOwner || "";
      name = target;
    }
    if (owner && name) {
      return {
        steps: [{
          tool: "github.read_repo",
          args: { owner, name },
          rationale: "GitHub README lookup — uses read_repo to return README + recent state",
          label: humanStepLabel("github.read_repo", { owner, name }),
        }],
        summary: `Read ${owner}/${name} from GitHub`,
        waves: [[0]],
      };
    }
  }

  // "tell me about X" / "explain X" / "what is X" / "whats X" / "describe X" —
  // these are research/explainer prompts. We use research.deep so vault is
  // checked first, web only if vault is thin. (Apostrophe in "what's" is
  // optional — users frequently type "whats".)
  //
  // SPEED: short definition queries (≤ 40 chars after the verb) drop to
  // depth=2 and capture=false. Quick look-ups don't need three web fetches
  // plus a vault commit — that's where the "5 minutes for 'whats the hanta
  // virus'" came from. Longer / open-ended explanations keep depth=3 and
  // still capture, because they tend to be non-trivial research notes.
  const aboutMatch = t.match(/^\s*(?:tell\s+me\s+about|explain|what(?:'?s|\s+is|\s+are|\s+does)|describe|how\s+does|how\s+do|summari[sz]e|recap|brief\s+me\s+on|tldr)\s+(.+?)[?.!]?\s*$/i);
  // Bail when the "explainer" verb is actually wrapping an action task —
  // research.deep can only answer from web/vault evidence, so it has no
  // way to see the operator's own GitHub activity, and its single-step
  // passthrough skips persona synthesis entirely, producing a raw,
  // unbranded refusal ("I operate as a synthesiser... I cannot connect to
  // your GitHub account") instead of composing github.list_repos/read_repo
  // + email.send like the task actually needs. 2026-07-11: "summarize
  // recent commits across my repos and email me" reproduced this exactly.
  // Two tells: (a) the query names the operator's OWN repos/commits/PRs/
  // issues — that needs a live github.* call, not a web search; (b) the
  // task chains a completion action ("...and email/send/notify/post it")
  // after the informational part — that's a multi-step compose the LLM
  // planner (plan()) should build from the full primitive catalog, not a
  // single-shot guess. Falls through instead of returning.
  const explainerNeedsLiveTools = aboutMatch && (
    /\b(?:my|our)\s+(?:repos?|repositories|commits?|pull\s+requests?|prs?|issues?)\b/i.test(aboutMatch[1])
    || /\bcommits?\b.{0,25}\b(?:repos?|repositories)\b/i.test(aboutMatch[1])
    || /\b(?:and|then)\s+(?:email|send|notify|message|post|dm|text)\b/i.test(t)
  );
  if (aboutMatch && !explainerNeedsLiveTools && !hasAttachments && aboutMatch[1].length >= 2 && aboutMatch[1].length <= 80) {
    const query = aboutMatch[1].trim();
    const isQuickLookup = query.length <= 40;
    const depth = isQuickLookup ? 2 : 3;
    const capture = !isQuickLookup;
    return {
      steps: [{
        tool: "research.deep",
        args: { query, depth, capture },
        rationale: isQuickLookup
          ? "short definition lookup — 2 sources, no vault capture (keeps the second brain tidy)"
          : "explainer — vault + web research",
        label: humanStepLabel("research.deep", { query }),
      }],
      summary: `Research: ${query}`,
      waves: [[0]],
    };
  }

  // Multi-perspective trigger phrases — when the task name-drops
  // "perspectives", "compare", "side by side", "pros and cons", "investigate"
  // / "analyse" we skip the planner LLM and go straight to the right tool.
  // Was: the planner usually picks research.multiperspective for these but
  // pays a 30-90s LLM call to decide; this saves that.
  const multiPerspMatch = t.match(/\b(?:multi[\s-]?perspective|from\s+(?:different\s+|multiple\s+)?perspectives|pros?\s+and\s+cons?|investigate|analy[sz]e|compare\s+.+?\s+(?:and|vs\.?|versus)\s+.+|side[\s-]?by[\s-]?side)\b/i);
  if (multiPerspMatch && t.length < 600) {
    // Pull a topic from the task — strip filler verbs but keep the body.
    const topic = t
      .replace(/^\s*(?:use\s+(?:research\.multiperspective|multi[\s-]?perspective)[^:]*?(?::|to|on|of|for|about)\s*)/i, "")
      .replace(/^\s*(?:investigate|analy[sz]e|explore|look\s+into|examine|compare)\s+/i, "")
      .replace(/\s+from\s+(?:multiple|different)\s+perspectives.*$/i, "")
      .trim()
      .slice(0, 200);
    if (topic.length >= 3) {
      return {
        steps: [{ tool: "research.multiperspective", args: { topic, perspectives: "mainstream, critical, practitioner, recent", sourcesPerPerspective: 5, capture: true }, rationale: "multi-perspective shape recognised — skipping planner LLM", label: humanStepLabel("research.multiperspective", { topic }) }],
        summary: `Multi-perspective: ${topic}`,
        waves: [[0]],
      };
    }
  }

  // Research-signal heuristic. When the task TEXT contains strong cues
  // that the customer expects fresh external sources ("look up X",
  // "research Y", "as of 2026", "industry benchmark", "according to a
  // recent report"), force a research.deep step BEFORE the LLM planner
  // gets a chance to short-circuit to a memory-only ollama.generate.
  //
  // Why this exists: rs1 harness showed 1/6 above B- because the LLM
  // planner kept answering long persona tasks ("I have a discovery call
  // Friday — research Anthropic's pricing as of 2026, then prep MEDDIC")
  // from training memory. The planner-side hint we added in plan()
  // wasn't enough — the LLM still chose the cheaper path.
  //
  // Bypass conditions:
  //   • detectResearchSignals fires (look-up verbs, recency markers,
  //     benchmark / industry-typical asks, named research firms, etc.)
  //   • Task is non-trivial (>= 60 chars) — short asks already get
  //     caught by aboutMatch / webSearchMatch above.
  //   • No URL in the task (URLs go to web.scrape via the earlier
  //     heuristic).
  // DB-intent override for the research shortcut below. "Query the Neon
  // Cloud DB data source and summarize the findings" carries research-y
  // words ("summarize the findings") that fired this shortcut and sent the
  // task to a WEB search — which came back with public Neon marketing docs
  // instead of touching db.query at all (live 2026-07-12, first external-DB
  // integration test). Same failure family as the FinanceFlow incident:
  // heuristicPlan runs before the LLM planner, so plan()'s registered-
  // databases hint never gets a chance. When the task names a database
  // concept OR a registered data-source label, fall through to the LLM
  // planner, which knows the db.list_sources → db.schema → db.query chain.
  let dbIntent = /\b(?:database|data\s+sources?|db|sql|postgres(?:ql)?|mysql|mongodb|sqlite|mssql)\b/i.test(t);
  if (!dbIntent) {
    try {
      dbIntent = listDataSources().some(s => s.label && t.toLowerCase().includes(s.label.toLowerCase()));
    } catch { /* registry unreadable — keep regex verdict */ }
  }
  const researchTrigger = detectResearchSignals(t);
  if (researchTrigger && !dbIntent && t.length >= 60 && !/https?:\/\/\S+/.test(t)) {
    // Extract a focused research query. Try in order:
    //   1. "look up X" / "research X" / "investigate X" anywhere in body
    //   2. "benchmarks for X" / "the current state of X"
    //   3. Fall back to extractTopic over the whole task
    let query: string | undefined;
    const lookupMatch = t.match(/\b(?:look\s+up|research|investigate|dig\s+into|look\s+into|find\s+out\s+(?:about|what|how))\s+(?:the\s+|a\s+|an\s+|some\s+|how\s+|what\s+|whether\s+)?(.{8,140}?)(?:[.,;:!?\n]|\s+then\b|\s+and\s+(?:then\s+)?(?:prep|draft|write|build|create|compose)\b|$)/i);
    if (lookupMatch) query = lookupMatch[1].trim();
    if (!query) {
      const benchmarkMatch = t.match(/\b(?:benchmarks?|industry[- ]?(?:standard|typical|average|median)|current\s+(?:state|landscape|consensus|best\s+practices?))\s+(?:for|of|on|about|in)\s+(.{6,120}?)(?:[.,;:!?\n]|$)/i);
      if (benchmarkMatch) query = benchmarkMatch[1].trim();
    }
    if (!query) {
      // Final fallback: just compress the first 140 chars of the task as
      // the search query. Imperfect but keeps the heuristic robust.
      query = extractTopic(t).slice(0, 140);
    }
    // Strip persona-prefix wrappers that might've slipped in via enriched
    // task (research.deep's query is user-facing in the captured note —
    // we want it clean, not "You are Drew operating as ...").
    query = query
      .replace(/^[\s.,;:()]+|[\s.,;:()]+$/g, "")
      .replace(/\s{2,}/g, " ")
      .slice(0, 140);
    if (query.length >= 6) {
      return {
        steps: [{
          tool: "research.deep",
          args: { query, depth: 3, capture: true },
          rationale: `research signal detected ("${researchTrigger}") — fetching external sources before synth so the persona answer is grounded, not memory-only`,
          label: humanStepLabel("research.deep", { query }),
        }],
        summary: `Research: ${query}`,
        waves: [[0]],
      };
    }
  }

  // "draft / write / compose / create a [doc type] for/about X" — grounded
  // synthesis. Was previously a bare ollama.generate which let the model
  // fabricate meanings for proper nouns / acronyms (e.g. "draft an Aiia
  // Reference Letter" → hallucinated "Association of International Investors").
  // Now we preflight: vault.search (the user's second brain) AND fs.find_in
  // (Downloads + Desktop + Documents + Inbox) in parallel. The synth then
  // has REAL evidence — prior notes on the topic, prior versions of the
  // document on the PC — and the anti-hallucination rules in POLISHED_SYNTH
  // kick in when both searches return empty (model must ask, not invent).
  const draftMatch = t.match(/^\s*(?:draft|write|compose|create|prepare|produce|generate|build|put\s+together|make)\s+(?:a\s+|an\s+|the\s+|some\s+|new\s+)?(?:short\s+|quick\s+|brief\s+|long\s+|formal\s+|professional\s+)?(.+?)\s*$/i);
  if (draftMatch && draftMatch[1].length >= 3 && draftMatch[1].length <= 200) {
    const body = draftMatch[1].trim();
    // Search topic: strip generic doc-type suffix so we hunt the SUBJECT,
    // not the type. "an Aiia Reference Letter" → search for "Aiia Reference",
    // which finds your existing vault notes about Aiia AND any Aiia-named
    // file in Downloads. Keep the full body for the synth so it knows the
    // deliverable shape (reference letter, memo, brief, etc.).
    const searchTopic = body
      .replace(/\s+(?:letter|email|memo|report|brief|proposal|plan|note|doc|document|update|summary|spec|prd|adr|deck|pitch|post)$/i, "")
      .trim() || body;
    return {
      steps: [
        {
          tool: "vault.search",
          args: { query: searchTopic },
          rationale: "ground the draft in any prior context in the user's second brain — avoid fabricating meaning for unfamiliar terms",
          label: humanStepLabel("vault.search", { query: searchTopic }),
        },
        {
          tool: "fs.find_in",
          args: { folder: "all", name: searchTopic, limit: 3 },
          rationale: "check the user's PC (Downloads + Desktop + Documents + Inbox) for prior versions of this doc — runs in parallel with the vault search",
          label: humanStepLabel("fs.find_in", { folder: "all", name: searchTopic }),
        },
      ],
      summary: `Find context for "${body.slice(0, 80)}" then draft it`,
      // Both searches run in the same wave — they're independent.
      waves: [[0, 1]],
    };
  }

  return null;
}

// Pull the tightest plausible topic from a free-form task. Used to seed
// fs.find_in's needle when the task is "look through my downloads and
// summarize what you see about Aiia" — the raw noise-strip pipeline leaves
// too many tokens, every one of which must match a filename for fs.find_in
// to hit. Returns the first hit from a priority ladder, or null if nothing
// strong stands out (caller falls back to the noise-strip pipeline).
function extractAnchorTopic(taskHead: string): string | null {
  // 1) Quoted phrase ("the foo bar doc") — most reliable.
  const quoted = taskHead.match(/["'`]([^"'`\n]{2,80})["'`]/);
  if (quoted) {
    const q = quoted[1].trim().replace(/\s+/g, " ");
    if (q.length >= 2) return q;
  }
  // 2) "about / regarding / concerning / related to / on the topic of X".
  //    We stop the capture at conjunctions ("and what they do") and
  //    punctuation so "about Aiia and what they do" gives just "Aiia".
  const aboutMatch = taskHead.match(
    /\b(?:about|regarding|concerning|related\s+to|on\s+the\s+(?:topic|subject)\s+of)\s+(?:an?\s+|the\s+)?([A-Za-z0-9][A-Za-z0-9 _\-]{1,60}?)(?=\s+(?:and|or|then|to|in|on|for|so|but|with|that|which|who|whose)\b|[.,;:?!]|$)/i,
  );
  if (aboutMatch) {
    let candidate = aboutMatch[1].trim().replace(/\s*[\/|]\s*/g, " ");
    // Dedupe ("Aiia Aiia" → "Aiia") and drop pure-noise tokens.
    const STOP = new Set(["a", "an", "the", "what", "they", "do", "does", "is", "are", "was", "were"]);
    const seen = new Set<string>();
    const tokens = candidate.split(/\s+/).filter(t => {
      const k = t.toLowerCase();
      if (STOP.has(k)) return false;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    candidate = tokens.join(" ").trim();
    if (candidate.length >= 2 && candidate.length <= 80) return candidate;
  }
  // 3) "called / named / titled X" — explicit naming.
  const calledMatch = taskHead.match(
    /\b(?:called|named|titled|labelled|labeled)\s+(?:an?\s+|the\s+)?([A-Za-z0-9][A-Za-z0-9 _\-\.]{1,60}?)(?=\s+(?:and|or|then|to|in|on|for|so|but|with)\b|[.,;:?!]|$)/i,
  );
  if (calledMatch) {
    const c = calledMatch[1].trim();
    if (c.length >= 2) return c;
  }
  // 4) ALL-CAPS acronyms (2–6 chars). Common topic shape in this corpus
  //    (Aiia, ZB, AFC, ADRS, POSB…). Skip generic tech acronyms.
  const GENERIC = new Set([
    "I", "PC", "AI", "ID", "URL", "API", "PDF", "DOC", "DOCX", "OK", "TL", "DR",
    "FYI", "ASAP", "EOD", "EOM", "USA", "UK", "EU",
  ]);
  const acronyms: string[] = [];
  const seen = new Set<string>();
  for (const m of taskHead.matchAll(/\b([A-Z]{2,6})\b/g)) {
    const a = m[1];
    if (GENERIC.has(a) || seen.has(a)) continue;
    seen.add(a);
    acronyms.push(a);
  }
  if (acronyms.length >= 1 && acronyms.length <= 3) return acronyms.join(" ");
  return null;
}

export function defaultVaultPlan(task: string, opts: { hasAttachments?: boolean } = {}): Plan {
  // Attachments present → don't research.deep on a pronoun. The user
  // already pasted the source material into the task; the synth has it
  // inline as an "Attached documents" block and will produce an answer
  // from that content directly. An empty plan is the right answer.
  if (opts.hasAttachments === true) {
    return { steps: [], summary: "Direct synth from attached documents", waves: [] };
  }
  // Last-line-of-defense URL detection — if the bare task is "fetch <url>"
  // or just a URL, route to web.scrape instead of pushing the URL through
  // research.deep as a search query (which would search for the URL string,
  // not fetch it, wasting minutes for zero value). The SSRF gate inside
  // web.scrape will reject dangerous targets in milliseconds.
  // LOCAL-FS detection — when the task is about a file that lives on the
  // user's PC ("in my downloads", "on my desktop", "from my documents",
  // "the file called X on my computer"), research.deep cannot answer it.
  // It searches the web and the vault, never the operator's Downloads /
  // Desktop / Documents. If the planner didn't reach for fs.find_in, do
  // it here so the default plan can still resolve a local file request.
  const localFsHint = task.match(LOCAL_FS_HINT_RE);
  if (localFsHint) {
    const folderWord = (localFsHint[1] ?? "").toLowerCase();
    const folder = folderWord.startsWith("download") ? "downloads"
      : folderWord.startsWith("desktop")  ? "desktop"
      : folderWord.startsWith("document") ? "documents"
      : folderWord === "music"            ? "music"
      : folderWord === "pictures" || folderWord === "photos" ? "pictures"
      : folderWord === "videos"           ? "videos"
      :                                     "all";
    // Trim the task to the first paragraph/sentence — governance prefixes
    // ("Alignment check — required before responding...") and chat-history
    // boilerplate can pollute a multi-line task. The user's actual ask
    // sits in the first chunk, before the first blank-line break.
    const taskHead = task.split(/\n\s*\n/)[0].split("\n")[0].slice(0, 300);
    // Tightest topic first: prefer a quoted phrase, an "about/regarding X"
    // anchor, a "called/named X" anchor, or an ALL-CAPS acronym. Without this,
    // open-ended asks like "look through my downloads and summarize what you
    // see about Aiia" leave the noise-strip pipeline below with a needle like
    // "look through and what you see about aiia Aiia and what they do" — every
    // token must appear in the filename for fs.find_in to hit, so 0 matches.
    // Using just "Aiia" recovers the obvious match set.
    const anchorTopic = extractAnchorTopic(taskHead);
    // Pull a likely filename phrase from the head. Common shapes:
    //   "find X in my downloads", "the doc called X", "search for X on my PC".
    let needle = anchorTopic ?? taskHead
      // Drop the "and summarize/attach/send/email ... " tail FIRST, while the
      // trigger verb is still intact. This MUST run before the generic
      // leading-verb strip below — that strip deletes bare "summarize" /
      // "attach" wherever they appear, which used to eat the trigger word
      // out from under this pattern so the tail-strip silently no-op'd,
      // corrupting the needle into "Summit Recon and it in an email to X"
      // (the exact shape observed in the 2026-07-08 Summit Recon incident).
      .replace(/\band\s+(summari[sz]e|read|review|analy[sz]e|tell\s+me\s+about|describe|attach|send|email)\b.*$/gi, " ")
      .replace(/\b(please\s+)?(find|search\s+for|look\s+(for|in|up)|check|read|open|summari[sz]e|locate|grab|fetch|browse|view|show)\b/gi, " ")
      // Strip "<preposition> my <folder>" — covers "in/on/from/at/inside/
      // within/under/into my downloads". Without this, "on" leaks into the
      // needle and "Master Tender on" never matches "Master Tender".
      .replace(/\b(?:in|on|from|at|inside|within|under|into|to|via)\s+my\s+(downloads?|desktop|documents?|pc|computer)\b/gi, " ")
      .replace(/\bmy\s+(downloads?|desktop|documents?|pc|computer)\b/gi, " ")
      .replace(/\b(file|doc|document|pdf|docx?|xlsx?|pptx?)\s+(called|named)\b/gi, " ")
      .replace(/\bcalled\b/gi, " ")
      .replace(/[\"'\.\?\!\:,]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Strip trailing fluff like "thanks", "for me", common verbs left over.
    // Also strip dangling single prepositions/articles left at the edges.
    needle = needle
      .replace(/\b(for\s+me|please|thanks?|now|the\s+document)\b/gi, " ")
      .replace(/^(?:the|a|an|on|in|of|for|with|and|or|to|from|at)\s+/i, "")
      .replace(/\s+(?:the|a|an|on|in|of|for|with|and|or|to|from|at)$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (needle.length >= 2 && needle.length <= 120) {
      // ATTACH-AND-SEND — "find X in my downloads and attach/send it in an
      // email to Y". Distinct from wantsContent below: the deliverable is
      // the REAL FILE reaching the recipient, not a text description of it.
      // Only handled here when a literal address is present in the task —
      // this function's return type is Plan (not nullable), and it's the
      // LAST-resort deterministic fallback (after both heuristicPlan and the
      // LLM planner already declined), so a NAMED recipient with no literal
      // address ("email Godswill") degrades to the plain find(+read) plan
      // below rather than guessing an address.
      // Guard regression: the 2026-07-08 Summit Recon incident, where this
      // exact shape ("find ... and attach it to an email to X") produced a
      // corrupted fs.find_in needle (the whole tail became the "filename")
      // AND never sent anything — fixed by the tail-strip regex above plus
      // this branch.
      const wantsAttachSend = /\battach(?:ment|ed|ing)?\b/i.test(task) && /\bemail\b/i.test(task);
      const attachEmailMatch = wantsAttachSend ? task.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) : null;
      if (wantsAttachSend && attachEmailMatch) {
        const to = attachEmailMatch[0];
        return {
          steps: [
            {
              tool: "fs.find_in",
              args: { folder, name: needle },
              rationale: `default fallback: task mentions ${folderWord} — search the user's PC instead of the web`,
              label: humanStepLabel("fs.find_in", { folder, name: needle }),
            },
            {
              tool: "email.send",
              args: {
                to,
                subject: needle,
                body: `Please find the ${needle} document attached.`,
                attach_paths: "$step_0.matches.0.path",
              },
              rationale: "task asks to attach/send the file — send it as a real attachment, not inline content",
              label: humanStepLabel("email.send", { to }),
            },
          ],
          summary: `Find "${needle}" in ${folder} and email it to ${to} as an attachment`,
          waves: [[0], [1]],
        };
      }
      const wantsContent = /\b(summari[sz]e|summary|read|open|extract|analy[sz]e|tell\s+me\s+about|what.+(says?|contains?)|review)\b/i.test(task);
      const steps: PlanStep[] = [
        {
          tool: "fs.find_in",
          args: { folder, name: needle },
          rationale: `default fallback: task mentions ${folderWord} — search the user's PC instead of the web`,
          label: humanStepLabel("fs.find_in", { folder, name: needle }),
        },
      ];
      const waves: number[][] = [[0]];
      if (wantsContent) {
        // Chain a read + a synth so the user gets the actual content,
        // not just "I found the file, please paste the text" — which is
        // the failure mode when the planner over-stops at fs.find_in.
        steps.push({
          tool: "fs.read_external",
          args: { path: "$step_0.matches.0.path" },
          rationale: "task asks for content — read the top match",
          label: humanStepLabel("fs.read_external", { path: needle }),
        });
        waves.push([1]);
      }
      return {
        steps,
        summary: wantsContent ? `Find "${needle}" in ${folder}, read it, summarise` : `Find "${needle}" in ${folder}`,
        waves,
      };
    }
  }
  const urlMatch = task.trim().match(/^\s*(?:(?:scrape|browse|open|fetch|read|visit|get)\s+)?(https?:\/\/\S+)\s*$/i);
  if (urlMatch) {
    const url = urlMatch[1];
    return {
      steps: [{
        tool: "web.scrape",
        args: { url },
        rationale: "default fallback: bare URL request — scrape directly instead of researching the URL string",
        label: humanStepLabel("web.scrape", { url }),
      }],
      summary: `Scrape ${url}`,
      waves: [[0]],
    };
  }
  const topic = extractTopic(task);
  const steps: PlanStep[] = [
    {
      tool: "research.deep",
      args: { query: topic, depth: 3, capture: true },
      rationale: "default fallback: search vault + web, synthesise, capture findings to 0-Inbox/",
      label: humanStepLabel("research.deep", { query: topic }),
    },
  ];
  return { steps, summary: `Default research plan for: ${topic}`, waves: [[0]] };
}

// SynthResult bundles the synth body with the picker telemetry the
// reflection loop wants to learn from. answer is the same string the
// previous string-returning shape produced; skillUsed/skillScore are
// undefined when no skill matched. Callers that only need the text can
// destructure { answer }.
type SynthResult = {
  answer: string;
  skillUsed?: string;
  skillScore?: number;
};

async function synthesize(
  task: string,
  p: Plan,
  runs: StepRun[],
  personaSystemSuffix?: string,
  onPartial?: (partial: string) => void,
  opts: { forceComplex?: boolean; push?: (msg: string) => void } = {},
): Promise<SynthResult> {
  const succeeded = runs.filter(r => r.ok);
  const failed = runs.filter(r => !r.ok);

  // MEDIA SHORT-CIRCUIT — a generated image/audio/video is a binary
  // deliverable, not prose. When media.image produced a file, hand back a
  // deterministic answer with an inline preview + a real download link,
  // instead of letting the LLM synth narrate (or hallucinate) around it —
  // caught live 2026-07-19 when synth wrote a "content plan" over a real PNG.
  const mediaRun = runs.find(r => r.ok && r.step.tool === "media.image" && r.result && typeof r.result === "object" && !(r.result as any).error);
  if (mediaRun) {
    const m = mediaRun.result as any;
    // Relative URL so the browser resolves it against whatever host serves the
    // UI (same-origin) — the absolute 127.0.0.1 downloadUrl only works on this
    // machine and is meant for off-box consumers like email.
    const url = m.filename ? `/api/media/${encodeURIComponent(m.filename)}` : m.downloadUrl;
    const kb = m.bytes ? Math.round(m.bytes / 1024) : undefined;
    if (url) {
      const mediaBlock = [
        `![generated image](${url})`,
        "",
        `**[Download the image](${url}?download=1)** · saved to \`${m.path ?? m.filename}\``,
      ].join("\n");
      // Ad/campaign creative wants COPY alongside the visual. Draft the copy
      // with the synth model, then append the deterministic media block so
      // the download link survives regardless of what the LLM writes — and
      // it can never claim media tools are "not configured": the asset is
      // already on disk.
      if (AD_CREATIVE_RE.test(task)) {
        try {
          const { POLISHED_DIRECT } = await import("./agent-prompts.js");
          const system = personaSystemSuffix
            ? `${injectLanguagePrompt(POLISHED_DIRECT, "direct")}\n\n${personaSystemSuffix}`
            : injectLanguagePrompt(POLISHED_DIRECT, "direct");
          const copy = await ollamaGenerate(
            `${task}\n\nIMPORTANT: the ad's visual asset has ALREADY been generated and will be attached below your text automatically. Write ONLY the final ad copy (headline, body/script, call-to-action). Do NOT mention tool availability or API configuration, and do NOT describe or link the image yourself.`,
            system,
            { profile: "synthesis", complexity: "high", maxTokens: 1024 } as any,
          );
          if (copy.trim().length > 0) {
            const answer = `${copy.trim()}\n\n---\n\n### Visual asset — generated with **${m.provider ?? "the studio"}**${m.model ? ` (${m.model})` : ""}${kb ? `, ${kb} KB` : ""}\n\n${mediaBlock}`;
            onPartial?.(answer);
            return { answer };
          }
        } catch (e: any) {
          opts.push?.(`Ad-copy synth failed (${String(e?.message ?? e).slice(0, 120)}) — returning the visual alone.`);
        }
      }
      const answer = [
        `Here's your image — generated with **${m.provider ?? "the studio"}**${m.model ? ` (${m.model})` : ""}${kb ? `, ${kb} KB` : ""}.`,
        "",
        mediaBlock,
      ].join("\n");
      onPartial?.(answer);
      return { answer };
    }
  }
  // SEND-MEDIA SHORT-CIRCUIT — deterministic report for "email the generated
  // images" plans. On success: confirm recipient + attached files. On email
  // failure: state the failure + the real error + where the files are. The
  // LLM synth handled this badly live (2026-07-19): a persona lane-refused
  // ("outside my lane as a Multimedia Producer") over a transient send error.
  const mediaListRun = runs.find(r => r.ok && r.step.tool === "media.list" && Array.isArray((r.result as any)?.images));
  const emailRun = runs.find(r => r.step.tool === "email.send");
  if (mediaListRun && emailRun) {
    const imgs: any[] = (mediaListRun.result as any).images;
    const fileLines = imgs.map((i: any) => `- \`${i.filename}\` (${Math.round((i.bytes ?? 0) / 1024)} KB) — [download](${i.downloadUrl?.replace(/^https?:\/\/[^/]+/, "") ?? `/api/media/${encodeURIComponent(i.filename)}`}?download=1)`).join("\n");
    if (emailRun.ok && !(emailRun.result as any)?.error) {
      const er: any = emailRun.result ?? {};
      const answer = `Sent ${imgs.length} image${imgs.length === 1 ? "" : "s"} to **${er.to ?? "the recipient"}** (${er.transport ?? "email"})${er.sentAt ? ` at ${er.sentAt}` : ""}.\n\n${fileLines}`;
      onPartial?.(answer);
      return { answer };
    }
    const err = String(emailRun.error ?? (emailRun.result as any)?.error ?? "unknown send error").slice(0, 300);
    const answer = `I found the image${imgs.length === 1 ? "" : "s"}, but the email failed to send: ${err}\n\nThe file${imgs.length === 1 ? " is" : "s are"} ready — you can download ${imgs.length === 1 ? "it" : "them"} directly:\n\n${fileLines}\n\nRetry the send once the transport recovers ("resend those images to <address>").`;
    onPartial?.(answer);
    return { answer };
  }

  // media.image ran but returned an error (e.g. no provider / bad model id) —
  // relay it HONESTLY rather than letting the LLM synth hand-draw an inline SVG
  // and present it as the logo (caught live 2026-07-24: an "invalid model ID"
  // from the image provider fell through to a truncated SVG). The auto-appended
  // QA/meta steps (quality/security/governance/peer.review) always "succeed", so
  // they must be EXCLUDED when deciding whether media.image was the real work —
  // otherwise this relay never fires.
  const META_STEP_TOOLS = new Set(["quality.check", "security.scan", "governance.check", "peer.review", "curation.check"]);
  const mediaErr = runs.find(r => r.step.tool === "media.image" && (r.result as any)?.error);
  if (mediaErr && succeeded.every(r => r.step.tool === "media.image" || META_STEP_TOOLS.has(r.step.tool))) {
    const e = String((mediaErr.result as any).error ?? "");
    const friendly = /invalid model|no image|returned no image|OPENROUTER_IMAGE_MODEL|not configured|no provider|401|403/i.test(e)
      ? `I couldn't generate the image — the studio's image provider isn't available on this deployment (the configured image model was rejected). To enable real image generation, an operator needs to set a working \`OPENROUTER_IMAGE_MODEL\` or add an \`IDEOGRAM_API_KEY\` / \`MUAPI_API_KEY\`. I won't hand back a placeholder image.`
      : `I couldn't generate the image: ${e.slice(0, 300)}`;
    return { answer: friendly };
  }

  // VIDEO / AUDIO MEDIA SHORT-CIRCUIT — same principle as media.image. A
  // produced clip/track is a binary deliverable: relay a real download link.
  // And relay an unconfigured/errored return HONESTLY so the model can't
  // fabricate a "sent to media.video" success (caught live 2026-07-23: a
  // promo-video task narrated a fake media.video call — the tool never ran).
  const AV_TOOLS = ["media.video", "media.music", "media.tts"];
  for (const toolName of AV_TOOLS) {
    const run = runs.find(r => r.step.tool === toolName);
    if (!run) continue;
    const res: any = run.result ?? {};
    const label = toolName === "media.video" ? "video" : toolName === "media.music" ? "music track" : "audio";
    if (run.ok && !res.error) {
      // media.music/tts return a local path/filename; media.video returns a
      // remote MiniMax downloadUrl (or a taskId while it renders).
      const url = res.filename ? `/api/media/${encodeURIComponent(res.filename)}` : (res.downloadUrl ?? res.url);
      const where = res.path ?? res.filename ?? res.taskId;
      if (url || res.taskId) {
        const link = url
          ? `**[Download the ${label}](${url}${url.startsWith("/api/media/") ? "?download=1" : ""})**${where && !url.includes(String(where)) ? ` · \`${where}\`` : ""}`
          : `Generation task \`${res.taskId}\` is still processing — it'll be available shortly.`;
        const answer = `Here's your ${label} — generated with **${res.provider ?? "the studio"}**${res.model ? ` (${res.model})` : ""}.\n\n${link}`;
        onPartial?.(answer);
        return { answer };
      }
    }
    // Errored / unconfigured — relay honestly, but only when nothing else
    // substantive succeeded (so a multi-step plan still synthesises normally).
    if ((res.error || !run.ok) && succeeded.filter(r => !AV_TOOLS.includes(r.step.tool)).length === 0) {
      const err = String(res.error ?? run.error ?? "generation failed").slice(0, 300);
      onPartial?.(`I couldn't generate the ${label}: ${err}`);
      return { answer: `I couldn't generate the ${label}: ${err}` };
    }
  }

  if (succeeded.length === 0) {
    // ATTACHMENT-ONLY SYNTH — when the plan was intentionally empty
    // because attachments carry the source material, there are no runs
    // to grade and humanizeAllFail's "nothing executed" message is the
    // wrong response. Route the task (which contains the attached doc
    // inline) through the direct synth path. The synth model reads the
    // task body, sees the attached content, and answers from it.
    const hasAttachments = /\nAttached documents \(user uploaded as context/.test(task);
    const planWasEmptyByDesign = (p.steps?.length ?? 0) === 0 && hasAttachments;
    // Finance-connector attempt that ran but failed (e.g. the FinanceFlow
    // session cookie expired — it's a 24h cookie with no refresh mechanism,
    // see connectors.ts). Falling all the way to humanizeAllFail would
    // silently drop the attached deliverable; falling through to the
    // fabricate-a-plan synth would invent numbers. Neither is right — tell
    // the model the connector failed AND why, and let it complete the
    // deliverable honestly (no invented figures) from the attached context.
    const financeConnectorFailed = hasAttachments && !planWasEmptyByDesign
      && runs.every(r => r.step.tool === "connector.call") && runs.length > 0;
    if (planWasEmptyByDesign || financeConnectorFailed) {
      opts.push?.(financeConnectorFailed
        ? "Live finance connector call failed — synthesising from the attached context with an honest note instead of fabricating figures."
        : "Synthesising directly from the attached document(s).");
      // Reuse the polished-direct path. The task already has the deliverable
      // shape hint + the attachment block; the synth model reads the
      // attachment as primary evidence and produces the requested transform.
      try {
        const { POLISHED_DIRECT } = await import("./agent-prompts.js");
        const system = personaSystemSuffix
          ? `${injectLanguagePrompt(POLISHED_DIRECT, "direct")}\n\n${personaSystemSuffix}`
          : injectLanguagePrompt(POLISHED_DIRECT, "direct");
        const effectiveTask = financeConnectorFailed
          ? `${task}\n\nNOTE: the live Aiia FinanceFlow connector call FAILED just now (${String(failed[0]?.error ?? "connector error").slice(0, 200)}). State this plainly and briefly (the connector needs re-authentication — its session cookie expires ~24h after each manual setup, see the Connectors page). Do NOT claim the connector "is not set up" — it IS registered, the call just failed. Do NOT invent or estimate financial figures to fill the gap — proceed with the rest of the deliverable using only the attached context, and mark any finance-figure section as pending real data.`
          : task;
        const answer = await ollamaGenerate(effectiveTask, system, { profile: "synthesis", complexity: "high", maxTokens: 1024 } as any);
        onPartial?.(answer.trim());
        return { answer: answer.trim() };
      } catch (e: any) {
        opts.push?.(`Direct synth failed: ${String(e?.message ?? e).slice(0, 120)}`);
        // Fall through to humanizeAllFail (empty failed[] → bare prompt).
      }
    }
    // KNOWLEDGE-DELIVERABLE SYNTH — when the plan is intentionally empty
    // because this is a creative / procedural / code deliverable that draws on
    // the persona's own knowledge (no research to run, no attachments), the
    // planner routed here on purpose. humanizeAllFail's "nothing executed"
    // message is wrong. Produce the deliverable via the SYNTH prompt (its
    // citation rule is inert with no evidence catalog) at a generous budget so
    // a runbook or announcement isn't truncated.
    const bareForClass = parseUserRequestFromTask(task);
    const dClass = classifyDeliverable(bareForClass);
    const knowledgeDeliverable = (p.steps?.length ?? 0) === 0 && !hasAttachments
      && (dClass === "creative" || dClass === "procedural" || dClass === "code");
    if (knowledgeDeliverable) {
      opts.push?.(`Drafting the ${dClass} deliverable from professional knowledge.`);
      try {
        const system = personaSystemSuffix
          ? `${injectLanguagePrompt(POLISHED_SYNTH, "synth")}\n\n${personaSystemSuffix}`
          : injectLanguagePrompt(POLISHED_SYNTH, "synth");
        const answer = await ollamaGenerate(task, system, { profile: "synthesis", complexity: "high", maxTokens: 1024 } as any);
        if (answer.trim().length > 0) {
          onPartial?.(answer.trim());
          return { answer: answer.trim() };
        }
      } catch (e: any) {
        opts.push?.(`Knowledge-deliverable synth failed: ${String(e?.message ?? e).slice(0, 120)}`);
        // Fall through to humanizeAllFail.
      }
    }
    return { answer: humanizeAllFail(task, failed) };
  }

  // Passthrough: when a single primitive (e.g. research.deep, peer.delegate)
  // already returned a complete answer, skip the synthesis LLM call entirely.
  // Saves 30-60s on the most common ad-hoc shape — the primitive did the work,
  // re-LLMing it would just paraphrase what we already have.
  //
  // EXCEPTION: when an active persona is set AND the customer's task is
  // long-form (>= 200 chars — implying a persona-specific deliverable like
  // MEDDIC notes / fact-check verdict / competitive brief), DON'T pass
  // through. We need to reshape the research result into the persona's
  // signature output format. Without this carve-out, the rs1 harness saw
  // raw research notes returned instead of MEDDIC / brief / verdict shapes,
  // and the graders dinged the shape even though the citations were there.
  //
  // CAPTURE the raw research answer here so it can serve as a fallback if
  // the synth path below returns empty/very short output. Without this
  // safety net, the emp1 harness saw 4/8 probes return 0 chars because
  // synth had OpenRouter timeouts and we threw the perfectly-good research
  // result away.
  const taskIsLongForm = task.length >= 200;
  const hasPersona = !!personaSystemSuffix && personaSystemSuffix.trim().length > 50;
  const skipPassthroughForPersona = hasPersona && taskIsLongForm;
  let rawPrimitiveAnswer: string | null = null;
  if ((succeeded.length === 1 || (succeeded.length > 0 && hasOnlyOneSemanticStep(succeeded)))) {
    const candidate = succeeded[0]?.result;
    if (candidate && typeof candidate === "object" && typeof candidate.answer === "string" && candidate.answer.trim().length >= 60) {
      if (!skipPassthroughForPersona) {
        onPartial?.(candidate.answer.trim());
        return { answer: candidate.answer.trim() };
      }
      // Stash the raw answer for the synth-fallback check below.
      rawPrimitiveAnswer = candidate.answer.trim();
    }
  }

  // Build a numbered evidence catalog the LLM can cite as [N]. Sources come
  // straight from each step's result so the model has a concrete anchor for
  // citation_coverage to score well on.
  const evidence: { ref: number; tool: string; from: string; body: string }[] = [];
  for (let i = 0; i < succeeded.length; i++) {
    const r = succeeded[i];
    const compact = compactResult(r.result);
    const body = typeof compact === "string" ? compact : JSON.stringify(compact, null, 2);
    evidence.push({
      ref: i + 1,
      tool: r.step.tool,
      from: describeStepProvenance(r),
      body: body.slice(0, 4000),
    });
  }

  // POLISHED_SYNTH body lives in agent-prompts.ts. The persona's
  // systemPromptOverride (when set) prefaces it; the matched skill
  // playbook gets appended below.
  // Auto-attach a skill playbook for this task. Picker uses TWO signals:
  //   1. The intent label stamped on the enriched task ("Interpretation:
  //      intent=draft-email, ..."). Highest weight when present.
  //   2. Doc-type keywords in the bare user text (e.g. "PRD", "ADR",
  //      "post-mortem", "1:1"). Catches the case where the intent classifier
  //      missed but the user literally named the deliverable.
  // Both signals score together; the skill with the highest composite score
  // wins. When nothing matches, the synth runs without skill guidance.
  let skillBlock = "";
  let pickedSkill: string | undefined;
  let pickedSkillScore: number | undefined;
  try {
    const intent = parseIntentFromTask(task);
    const bareTaskForSkill = parseUserRequestFromTask(task);
    // Use topSkillScoreForTask so we get the composite score for the
    // feedback loop, then re-fetch the body via suggestSkillsForTask only
    // when we have a hit. Two lookups but both are O(skills) and cheap.
    const top = topSkillScoreForTask(bareTaskForSkill, intent);
    if (top) {
      const skills = suggestSkillsForTask(bareTaskForSkill, intent, 1);
      if (skills.length > 0) {
        const s = skills[0];
        pickedSkill = s.name;
        pickedSkillScore = top.score;
        // Cap the skill body so a verbose playbook doesn't blow the synth's
        // context budget. 3000 chars ~ 750 tokens — enough for any of our
        // built-in skills, which are all under that.
        skillBlock = `\n\n--- Skill playbook: ${s.name} ---\n${s.body.slice(0, 3000)}\n--- end playbook ---`;
      }
    }
  } catch { /* skill lookup failure shouldn't block synthesis */ }
  // Escalate failed data-fetch tools into the prompt so the synth can't
  // silently answer around a broken data path. 2026-07-09 reflection:
  // db.query/db.describe_table failed 6/6 combined runs, yet every task
  // still reported "succeeded" — nothing told the synth the data path was
  // down, so it just answered from whatever else it had (or fabricated a
  // plausible-sounding gap-fill) without flagging the missing data. Scoped
  // to db.* per the reflection's ask; the pattern generalizes to any tool
  // prefix worth escalating the same way.
  const criticalFailures = failed.filter(r => /^db\./.test(r.step.tool));
  const gapsNote = criticalFailures.length > 0
    ? `\n\nDATA GAP — the following database quer${criticalFailures.length === 1 ? "y" : "ies"} FAILED and returned NO data: ${criticalFailures.map(r => `${r.step.tool} (${String(r.error ?? "").slice(0, 120)})`).join("; ")}. State plainly that this data could not be retrieved instead of answering as if it were available — do not paper over the gap with a plausible-sounding but ungrounded figure.\n`
    : "";
  // Company-knowledge grounding (Feature C): when the evidence comes from the
  // company's OWN systems (vault/KB, databases, connectors, memory, org/people
  // catalog), force the answer to be grounded in and cite that evidence rather
  // than answered from the model's training memory or a public-web guess. This
  // is the synth-side complement to the planner's COMPANY KNOWLEDGE MAP.
  const COMPANY_SOURCE_RE = /^(vault\.|db\.|connector\.|data\.|memory\.|company\.|org\.|users\.|personas\.|knowledge\.)/;
  const usedCompanySources = evidence.some(e => COMPANY_SOURCE_RE.test(e.tool));
  const groundingNote = usedCompanySources
    ? `\n\nGROUNDING — this answer draws on the company's OWN knowledge (its knowledge base, databases, connectors, and people/org catalog). Base every company-specific claim STRICTLY on the numbered evidence above and cite the [ref] it came from. Do NOT substitute general world-knowledge or public-web guesses for the company's own data, and do NOT invent figures, names, or policies not present in the evidence. If the evidence doesn't cover part of the question, say so plainly rather than filling the gap.\n`
    : "";
  // STATIC synth base first so the large stable prefix caches on the cloud
  // providers (measured: this prefix drives the ~50%+ input-token cache hit on
  // the main synth path); skill block next; persona suffix LAST so its language
  // directive overrides (documented invariant — see language-prompts.ts).
  const sys = POLISHED_SYNTH + skillBlock + (personaSystemSuffix ? "\n\n" + personaSystemSuffix : "");
  const prompt = `Task: ${task}\n\nNumbered evidence:\n${evidence.map(e => `[${e.ref}] (${e.tool} — ${e.from})\n${e.body}`).join("\n\n")}${gapsNote}${groundingNote}\n\nWrite the report:`;

  // Stream tokens as they arrive so the UI can show the answer materialising.
  // Empty/very-short outputs (LLM returned blank, "ok", or a single sentence)
  // get the fallback treatment too — a blank chat reply is the worst possible
  // experience after waiting through plan + execute.
  //
  // Synthesis with ≥4 evidence sources OR ≥6k chars of total evidence is
  // "complex" — the dispatcher will hand off to the large-tier OR model
  // when available so the answer isn't gimped by a small model trying to
  // reason over a lot of evidence.
  const totalEvidenceChars = evidence.reduce((n, e) => n + e.body.length, 0);
  // Complexity inference: caller's forceComplex (quality rescue path) wins,
  // otherwise size-based heuristic.
  // Raised the complexity bar from 4-evidence / 6k-chars to 6-evidence
  // / 10k-chars after the OR-free-tier grading round showed that
  // bumping to LARGE on every modest research task was 429ing the
  // large model. Most research.deep results sit at 3-5 evidence chunks
  // and the small model handles those fine.
  const synthComplexity: "high" | "normal" = opts.forceComplex
    ? "high"
    : ((evidence.length >= 6 || totalEvidenceChars > 10000) ? "high" : "normal");
  // COMPACT-SYNTH detection. When the task is a short "what is X" /
  // "summarise X" research question AND the evidence is small, route
  // the synth through the TRIAGE profile (smallest/fastest model —
  // qwen3.5:0.8b on this machine) with a 256-token budget. Measured
  // win on this grade test: ~60s synth → ~15s, taking "summarise
  // neuroworks" from 174s end-to-end to ~120s. The output quality
  // stays usable because the answer shape is a one-paragraph
  // definition, not a multi-section report.
  //
  // Triggered when: task is single research.deep step OR research.multi
  // (the heuristic-planner shapes), evidence is short, AND complexity
  // wasn't escalated.
  const bareTask = parseUserRequestFromTask(task);
  const looksDefinitional = /^(?:what(?:'?s|\s+is|\s+are)|tell\s+me\s+about|explain|describe|summari[sz]e|recap|brief\s+me\s+on|tldr)\s+/i.test(bareTask) && bareTask.length <= 80;
  const singleResearchStep = p.steps.length === 1 && /^research\./.test(p.steps[0].tool);
  const compactSynth = !opts.forceComplex && synthComplexity === "normal" && looksDefinitional && singleResearchStep && totalEvidenceChars < 4000;
  // Token budget tracks complexity. Compact synth = 256 (one paragraph).
  // Simple = 512 (80-250 words). Complex = 1024 (multi-section).
  const synthMaxTokens = compactSynth ? 256 : (synthComplexity === "high" ? 1024 : 512);
  const synthProfile: "synthesis" | "triage" = compactSynth ? "triage" : "synthesis";
  const MIN_USEFUL_SYNTH = 40;
  // Single retry on transient fetch failures. The big synth call is the
  // most likely place for an Ollama hiccup (concurrent quality.check +
  // peer.review can saturate the single-threaded local model). Without
  // a retry, a one-time TCP reset nukes the entire run — research.deep
  // already gathered the evidence and the customer gets a "synthesiser
  // couldn't run" dump instead of the actual answer. One retry catches
  // the transient case; the second failure falls through to the
  // structured fallback as before.
  let lastErr: any;
  // Track whether the prior attempt failed with a rate-limit on the
  // LARGE-tier model. If so, retry by DROPPING complexity to "normal"
  // — that routes to the cheaper default model (or local Ollama),
  // which is more reliable than retrying the same large-tier endpoint.
  let downgradeOnRetry = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const meta = await ollamaGenerateWithMeta(prompt, sys, {
        profile: synthProfile,
        complexity: downgradeOnRetry ? "normal" : synthComplexity,
        maxTokens: synthMaxTokens,
        onToken: onPartial ? (_chunk: string, accumulated: string) => onPartial(accumulated) : undefined,
        onRoutingDecision: (attempt === 0 && opts.push) ? (info) => {
          // Only surface the decision when it's non-default — a complexity
          // bump, a remote model handoff. Routine local synth doesn't need a
          // log line every time. Suppress on retry to avoid double-logging.
          if (info.backend === "openrouter") {
            opts.push!(`Thinking with ${info.model} (~${info.tokenEstimate.toLocaleString()} tokens of context). ${info.reason ? `Reason: ${info.reason}.` : ""}`);
          } else if (synthComplexity === "high") {
            // Big synth ran locally. Be accurate about WHY — the old message
            // always blamed "not configured", which is wrong when a key IS set
            // but the large-tier model is unavailable on the plan (e.g. a paid
            // model on a free key → 402) or OpenRouter is temporarily down.
            const why = !config.openrouterEnabled
              ? "OpenRouter isn't configured — set OPENROUTER_API_KEY to route big synths to a bigger model."
              : openrouterBillingExhausted()
                ? "The cloud provider's credit balance is exhausted — running locally until the account is topped up (check the provider's billing page)."
                : openrouterDailyQuotaExhausted()
                ? "OpenRouter's free daily quota is used up (free-models-per-day) — running locally until it resets. Add credits or your own key on OpenRouter to lift the cap."
                : openrouterCircuitOpen()
                  ? "OpenRouter is temporarily unavailable (circuit open after recent failures) — this ran locally."
                  : "OpenRouter is configured but the large-tier model was unavailable (check OPENROUTER_LARGE_MODEL is a model your plan can call) — ran locally.";
            opts.push!(`Thinking with local ${info.model} on a complex synth (~${info.tokenEstimate.toLocaleString()} tokens). ${why}`);
          }
        } : undefined,
      });
      const text = meta.text.trim();
      if (text.length < MIN_USEFUL_SYNTH) {
        // Model produced nothing useful — that's a content failure, not
        // a transport one. No point retrying. PREFER the raw primitive
        // answer when we captured one (skipped passthrough for persona
        // reshaping but synth then failed) — that's still real evidence-
        // grounded content, and a research note beats a templated rescue
        // copy any day.
        if (rawPrimitiveAnswer) {
          if (opts.push) opts.push(`Synth produced empty output — falling back to the raw research result.`);
          onPartial?.(rawPrimitiveAnswer);
          return { answer: rawPrimitiveAnswer, skillUsed: pickedSkill, skillScore: pickedSkillScore };
        }
        return { answer: fallbackSynthesis(task, p, runs), skillUsed: pickedSkill, skillScore: pickedSkillScore };
      }
      if (attempt > 0 && opts.push) opts.push(`Synth recovered on retry — keeping the rescue draft.`);
      return { answer: text, skillUsed: pickedSkill, skillScore: pickedSkillScore };
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e);
      // Only retry on transport-class failures. Content errors (model
      // refused, prompt-too-large) won't get better on retry.
      // Match HTTP 5xx + 429 (rate limit) + connection-class errors.
      // The free OR tier returns 429 frequently when the large model is
      // hot — separate-class retry waits longer (5s) since it's an
      // upstream throttle, not a transport blip.
      const isRateLimit = /(?:OpenRouter|HTTP)\s*429|rate[- ]?limit/i.test(msg);
      const isTransport = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|aborted|stream closed|HTTP 5\d\d|OpenRouter 5\d\d|EAI_AGAIN|terminated|other side closed/i.test(msg);
      if (attempt === 0 && (isRateLimit || isTransport)) {
        const waitMs = isRateLimit ? 5_000 : 2_000;
        // On a rate-limit OR transient on the LARGE tier, downgrade to
        // the cheaper default model on retry. Stops "free large model
        // is rate-limited upstream" from killing the whole run.
        if (isRateLimit && synthComplexity === "high") downgradeOnRetry = true;
        if (opts.push) opts.push(`Synth hiccup (${msg.slice(0, 80)}) — retrying once in ${waitMs/1000}s${downgradeOnRetry ? " on the smaller model" : ""}.`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      break;
    }
  }
  // Two attempts failed. Prefer the raw research result over the
  // synthetic fallback copy — same reasoning as the < MIN_USEFUL_SYNTH
  // branch above. The fallbackSynthesis is informational ("synth couldn't
  // run because X"), while the raw research has real cited content.
  if (rawPrimitiveAnswer) {
    if (opts.push) opts.push(`Synth retries exhausted — returning the raw research result instead.`);
    onPartial?.(rawPrimitiveAnswer);
    return { answer: rawPrimitiveAnswer, skillUsed: pickedSkill, skillScore: pickedSkillScore };
  }
  return { answer: fallbackSynthesis(task, p, runs, String(lastErr?.message ?? lastErr)), skillUsed: pickedSkill, skillScore: pickedSkillScore };
}

// One "semantic" step = ignore non-LLM-impacting steps when deciding whether
// the run had a single meaningful action. Used by passthrough to recognise
// research.deep + nothing-else patterns.
function hasOnlyOneSemanticStep(succeeded: StepRun[]): boolean {
  const semantic = succeeded.filter(r => !["clock.now"].includes(r.step.tool));
  return semantic.length === 1;
}

// Pluck a useful provenance string from a step's args — paths, URLs, repo names —
// so citations can read like `[2] (vault.search — query="cognify")` instead of
// just the tool name. Aids the citation_coverage score downstream.
function describeStepProvenance(r: StepRun): string {
  const a = r.step.args ?? {};
  const fields = ["url", "path", "query", "name", "repo", "owner"];
  const bits: string[] = [];
  for (const k of fields) {
    const v = (a as any)[k];
    if (typeof v === "string" && v.length > 0) bits.push(`${k}="${v.slice(0, 80)}"`);
  }
  return bits.length > 0 ? bits.join(", ") : r.step.tool;
}

function compactResult(r: any): any {
  if (!r) return r;
  if (typeof r === "string") return r.slice(0, 800);
  if (Array.isArray(r)) return r.slice(0, 10);
  if (typeof r === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(r)) {
      if (Array.isArray(v)) out[k] = v.slice(0, 10);
      else if (typeof v === "string") out[k] = v.slice(0, 1500);
      else out[k] = v;
    }
    return out;
  }
  return r;
}

// Produce a polished, customer-facing message when EVERY plan step failed.
// Replaces the old "I tried, but step 1 (web.scrape) failed: <stack>" dump
// that exposed internal step indices, tool names, and env-var hints.
//
// Strategy:
//   1. Categorise each failure — security gate, network, auth, missing
//      file, planning gap, other.
//   2. Pick the dominant failure (the first one usually exposes the root
//      cause; the rest are often cascades).
//   3. Render a short, employee-style explanation with the relevant
//      next-action — never the raw stack trace, never tool names.
//
// Categories produce different copy. The output reads as one paragraph of
// prose to the customer; technical detail (the original error text) is
// folded into a small italic line at the bottom for debugging without
// being the headline.
function humanizeAllFail(task: string, failed: StepRun[]): string {
  if (failed.length === 0) {
    return "I couldn't get anywhere on this — nothing executed. Could you rephrase what you'd like me to do?";
  }
  // Pick the first failure as the headline. Subsequent failures are usually
  // cascades from the same root cause.
  const head = failed[0];
  const err = String(head.error ?? "").trim();
  const tool = head.step.tool;
  const args = head.step.args ?? {};
  const targetUrl = typeof (args as any).url === "string" ? (args as any).url : "";
  const targetPath = typeof (args as any).path === "string" ? (args as any).path : "";

  // 1. SECURITY REFUSAL — SSRF gate on a web tool. The error message starts
  //    with "Refused to fetch …". Reframe in plain language with the
  //    specific target named, and offer the override path WITHOUT exposing
  //    the env var name (the curious customer can find it in .env.example).
  if (/^Refused to fetch/i.test(err) && targetUrl) {
    const host = (() => { try { return new URL(targetUrl).hostname; } catch { return targetUrl; } })();
    const why =
      /169\.254\.169\.254/.test(host) ? "the cloud-metadata service, which agents are blocked from to prevent credential leaks"
      : /^(?:127\.|::1$|localhost)/i.test(host) ? "a loopback address (your own machine)"
      : /^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(host) ? "a private internal network"
      : "a non-public address";
    return `I can't reach **${host}** — it's ${why}, and my web tools are scoped to the public internet so secrets stored on internal services aren't exposed accidentally.\n\nIf this is a deliberate request (you're testing reachability or fetching from your own dev server), enable private-host access in \`.env\` (see \`.env.example\` — look for \`NEUROWORKS_WEB_ALLOW_PRIVATE\`) and try again. Otherwise, share a public URL or tell me what you're trying to find out and I'll dig differently.`;
  }

  // 2. PATH SECURITY REFUSAL — fs gate on .env / .ssh / cred stores.
  if (/^Refused to read/i.test(err) && targetPath) {
    return `That path looks like a sensitive file (credentials, keys, or browser cookie store), so I won't read it by default — it's the kind of thing that would leak if I quoted it back in a reply or wrote it to your vault.\n\nIf you genuinely need me to read it (you're debugging a config), there's an override in \`.env\` (\`NEUROWORKS_FS_UNRESTRICTED\` in \`.env.example\`). Otherwise tell me what you're after and I'll find a safer path.`;
  }

  // 3. NETWORK — couldn't reach the public web. Common: timeouts, DNS,
  //    transient TLS issues. Suggest retry; don't blame the customer.
  if (/\b(?:ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|abort|timeout)\b/i.test(err)) {
    const targetBit = targetUrl ? ` reaching **${(() => { try { return new URL(targetUrl).hostname; } catch { return targetUrl; } })()}**` : "";
    return `I hit a network snag${targetBit} — the connection dropped, timed out, or couldn't resolve the host. Often this clears up in a few seconds. Want me to try again, or do you have a different source in mind?`;
  }

  // 4. AUTH / FORBIDDEN — 401/403, missing token, expired creds.
  if (/\b(?:401|403|unauthori[sz]ed|forbidden|invalid_request_error|API key|missing.*token)\b/i.test(err)) {
    return `I'm not authorised to access that resource — looks like the token / key is missing, expired, or doesn't have permission. Check the relevant entry in your \`.env\` (GitHub PAT, API keys, etc.) and try again.`;
  }

  // 5a. VAULT UNREACHABLE — the vault root itself doesn't exist. Hits
  //    EVERY vault.* tool now that searchVault/listVault/readVaultFile
  //    throw VaultUnreachable on a missing root. Without this branch the
  //    user would see either "No matches" (if it's a read tool) or a
  //    generic mkdir-ENOENT (if it's a write). Either way, the real
  //    cause is "your vault drive isn't mounted" and the fix path is
  //    the same.
  const isVaultTool = /^vault\./.test(tool);
  const isVaultWriteTool = /^(?:vault\.(?:write|append|create_zettel|import_binary)|fs\.(?:write|append|copy))/.test(tool);
  const isMkdirError = /\b(?:mkdir|ENOENT.*(?:mkdir|writeFile))\b/i.test(err);
  const isVaultUnreachable = /VaultUnreachable|vault path .* is unreachable|vault.*unreachable/i.test(err);
  if (isVaultUnreachable || ((isVaultTool || isVaultWriteTool || isMkdirError) && /\bENOENT\b/i.test(err))) {
    const driveMatch = err.match(/['"]?([A-Z]:[\\/][^'"\n)]+|\/[\w/.-]+)['"]?/);
    const where = driveMatch ? ` (path: \`${driveMatch[1].slice(0, 80)}\`)` : "";
    const verb = isVaultWriteTool || isMkdirError ? "write to" : "reach";
    return `I can't ${verb} your vault${where} — the configured path doesn't resolve on this machine. Common causes: the drive is unmounted (e.g. D: was unplugged on Windows), the folder was renamed, or VAULT_PATH in \`.env\` doesn't match your actual vault. Mount the drive (or fix the path) and try again, or rephrase the task so I produce the answer inline without touching disk.`;
  }

  // 5. NOT FOUND — file or repo doesn't exist where I looked.
  if (/\b(?:file not found|no such file|ENOENT|404|not found)\b/i.test(err)) {
    if (targetPath) return `I couldn't find anything at \`${targetPath}\`. Could the path be slightly different (typo, wrong folder), or should I look somewhere else?`;
    if (targetUrl) return `That URL returned a 404 — the page doesn't exist (or moved). Want me to try a search for the same topic instead?`;
    return `I couldn't find what you were pointing me at. Want to share a path, URL, or topic and I'll try again?`;
  }

  // 6. RATE LIMIT — 429.
  if (/\b(?:429|rate.?limit|too many requests)\b/i.test(err)) {
    return `We're being rate-limited by the upstream service. Give it a minute and ask again; if it keeps happening, this provider may need an API key upgrade.`;
  }

  // 7. PLANNING / TOOL CATALOG MISMATCH — the planner picked a tool that
  //    doesn't exist, or args didn't validate.
  if (/(?:invalid tool|no such tool|unknown tool|missing.*arg|args.*invalid)/i.test(err)) {
    return `I planned this in a way that didn't quite fit my actual tools — that's on me. Want to rephrase the request or share a bit more about what you need? Sometimes naming the deliverable (email, brief, code, etc.) helps me pick the right approach.`;
  }

  // 8. FALLBACK — unknown class. Give the customer something useful: name
  //    the kind of work that failed (vault read, web fetch, research, etc.)
  //    without exposing tool name, and tuck the technical detail in italic
  //    at the end so a developer-customer can still see what happened.
  const friendlyAction = humanWorkKind(tool);
  const errSnippet = err.length > 240 ? err.slice(0, 240) + "…" : err;
  return `I tried to ${friendlyAction} and hit an error I don't have a clean recovery for. Could you tell me a bit more about what you're trying to achieve, or try a different angle?\n\n_Technical detail: ${errSnippet}_`;
}

// Friendly verb-phrase for a tool name. Used in the fallback message so we
// don't expose names like "web.scrape" to the customer.
function humanWorkKind(tool: string): string {
  switch (tool) {
    case "vault.search":            return "search your notes";
    case "vault.read":              return "read a note from your vault";
    case "vault.list":              return "list your vault";
    case "vault.write":             return "save a note to your vault";
    case "vault.edit":              return "edit a note in your vault";
    case "vault.scan_docs":         return "scan documents in your vault";
    case "research.deep":           return "research the topic";
    case "research.multiperspective": return "investigate the topic from multiple angles";
    case "web.fetch":               return "read the webpage";
    case "web.scrape":              return "open the page in a browser";
    case "web.firecrawl":           return "fetch the page via Firecrawl";
    case "web.search":              return "search the web";
    case "brave.list_tabs":
    case "brave.read_tab":
    case "brave.search_tabs":       return "read your open Brave tabs";
    case "github.list_repos":
    case "github.read_repo":
    case "github.get_file":         return "pull from GitHub";
    case "github.create_issue":     return "open a GitHub issue";
    case "fs.read_external":        return "read the file";
    case "fs.list_external":        return "list the folder";
    case "ollama.generate":         return "draft a response";
    case "peer.delegate":           return "hand the work off to a peer";
    case "peer.review":             return "ask a peer to review the draft";
    case "quality.check":           return "quality-check the draft";
    case "security.scan":           return "security-scan the draft";
    case "skill.draft":
    case "skill.fetch_remote":
    case "skill.load":
    case "skill.list":
    case "skill.suggest":           return "look up a skill playbook";
    default:                        return "complete this part of the task";
  }
}

// Rescue synth — runs when the LLM synth call threw OR returned blank. Builds
// a coherent answer directly from the evidence by digesting each successful
// step's result. NOT just a "Ran N steps" stub — that's user-hostile after a
// long wait. We surface the actual content (sources, answers, paths) and
// honestly flag what failed so the user knows where the work stopped.
function fallbackSynthesis(task: string, p: Plan, runs: StepRun[], synthError?: string): string {
  const ok = runs.filter(r => r.ok);
  const failed = runs.filter(r => !r.ok);
  const parts: string[] = [];
  // Use the bare user request in the headline — the enriched task is prefixed
  // with persona framing + interpretation/deliverable blocks that look like
  // garbage to the customer. parseUserRequestFromTask peels those off.
  const headlineTask = parseUserRequestFromTask(task).slice(0, 200);

  // Single-step research success + synth failure is the most common shape:
  // the search step already produced a usable answer, the LLM rendering on
  // top failed (429, transport, etc.). Lift that answer directly instead of
  // burying it under "Partial result / What worked / What failed" framing.
  if (ok.length === 1 && failed.length === 0 && /^research\./.test(ok[0].step.tool)) {
    const direct = compactStepSummary(ok[0]).trim();
    if (direct.length >= 40) {
      return `${direct}\n\n---\n_The synthesis step couldn't render this cleanly${synthError ? ` (${synthError.slice(0, 80)})` : ""}, so here's the research result directly. Ask again for a polished version._`;
    }
  }

  parts.push(`## Partial result\n\nThe synthesis step didn't complete cleanly${synthError ? ` (\`${synthError.slice(0, 100)}\`)` : ""}, so here is the raw evidence we gathered for: **${headlineTask}**`);

  if (ok.length > 0) {
    parts.push(`### What worked`);
    for (let i = 0; i < ok.length; i++) {
      const r = ok[i];
      parts.push(`**Step ${i + 1} — ${r.step.label ?? r.step.tool}**\n${compactStepSummary(r)}`);
    }
  } else {
    parts.push(`### What worked\n\n_No steps completed successfully._`);
  }

  if (failed.length > 0) {
    parts.push(`### What failed`);
    for (const r of failed) {
      parts.push(`- **${r.step.label ?? r.step.tool}** — ${(r.error ?? "no error message").slice(0, 200)}`);
    }
  }

  parts.push(`---\n_Auto-generated rescue summary. Try the task again — the next attempt may have the model available._`);
  return parts.join("\n\n");
}

// Per-step digest used by the rescue path. Pulls the most readable part of
// each tool's result (answer / text / title / path / snippets) — never raw
// JSON unless every more-readable shape failed.
export function compactStepSummary(r: StepRun): string {
  const result: any = r.result;
  if (result == null) return "_(no output)_";
  if (typeof result === "string") return result.slice(0, 800);
  if (typeof result.answer === "string" && result.answer.trim().length > 0) {
    return result.answer.slice(0, 800);
  }
  if (typeof result.text === "string" && result.text.trim().length > 0) {
    return result.text.slice(0, 800);
  }
  // Document reads (fs.read_external / doc extraction) put the body in
  // `content` — without this branch a read step rendered as a raw-JSON dump
  // in rescue summaries (which then got emailed out verbatim).
  if (typeof result.content === "string" && result.content.trim().length > 0) {
    return result.content.slice(0, 800);
  }
  // File searches (fs.find_in / fs.search) return `matches` — render as a
  // readable file list, not internal JSON with absolute paths + mtimes.
  if (Array.isArray(result.matches) && result.matches.length > 0) {
    return result.matches.slice(0, 5).map((h: any, idx: number) =>
      `${idx + 1}. ${h.name ?? h.title ?? h.path ?? "(match)"}${typeof h.snippet === "string" ? ` — ${h.snippet.slice(0, 120)}` : ""}`
    ).join("\n");
  }
  if (typeof result.path === "string") return `Wrote/read: \`${result.path}\``;
  if (Array.isArray(result.results) && result.results.length > 0) {
    return result.results.slice(0, 5).map((h: any, idx: number) =>
      `${idx + 1}. ${h.title ?? h.path ?? h.url ?? "(item)"} — ${(h.snippet ?? h.preview ?? "").slice(0, 160)}`
    ).join("\n");
  }
  if (Array.isArray(result.sources) && result.sources.length > 0) {
    return result.sources.slice(0, 5).map((s: any, idx: number) =>
      `${idx + 1}. [${s.title ?? s.url ?? "source"}](${s.url ?? ""})`
    ).join("\n");
  }
  try {
    const json = JSON.stringify(result);
    return "```\n" + json.slice(0, 500) + (json.length > 500 ? "…" : "") + "\n```";
  } catch { return "_(unprintable result)_"; }
}

// Resolve $step_N or $step_N.path.to.value references in args
function resolveArgs(args: Record<string, any>, runs: StepRun[]): Record<string, any> {
  const resolved: Record<string, any> = {};
  for (const [k, v] of Object.entries(args ?? {})) resolved[k] = resolveValue(v, runs);
  return resolved;
}

function resolveValue(v: any, runs: StepRun[]): any {
  if (typeof v !== "string") return v;
  // Whole-string reference: "$step_2" or "$step_2.field.0.x"
  const whole = v.match(/^\$step_(\d+)(\..+)?$/);
  if (whole) {
    const idx = Number(whole[1]);
    const path = whole[2] ?? "";
    const base = runs[idx]?.result;
    if (base === undefined) return v;
    const direct = path ? deepGet(base, path) : base;
    // An explicit reference to a field gets the REAL bytes back, even if
    // that field was archived by context-offload.ts to shrink what rides
    // through the plan's intermediate steps — otherwise a later step that
    // forwards this value verbatim (e.g. vault.write content: "$step_N.text")
    // would silently write the short preview instead of the real content.
    if (direct !== undefined) return typeof direct === "string" ? recoverFullText(direct) : direct;
    // Planner-shape-error fallback. The planner sometimes writes
    // "$step_0.path" or "$step_0.content" when the actual result is a
    // collection-shaped object (matches[], results[], etc.). Without this
    // fallback the substitution returns undefined and the next step gets
    // an empty arg (e.g. fs.read_external sees path="" and errors).
    // We try a small set of common shapes — first match wins.
    if (path && base && typeof base === "object") {
      const tail = path.replace(/^\./, "");
      const candidates = [
        ["matches", 0, tail],
        ["results", 0, tail],
        ["matches", 0],
        ["results", 0],
      ];
      for (const c of candidates) {
        let cur: any = base;
        for (const seg of c) cur = cur?.[seg as any];
        if (cur !== undefined) return cur;
      }
      // Top-level extraction: fs.find_in's first match's `path` is the most
      // common target — if the planner asked for ANYTHING that doesn't exist
      // and the base has a non-empty matches[0], hand back matches[0].path
      // as the most useful default (works for fs.read_external chains).
      const firstMatch = (base as any).matches?.[0];
      if (firstMatch && typeof firstMatch === "object") {
        const guess = firstMatch[tail] ?? firstMatch.path;
        if (guess !== undefined) return guess;
      }
    }
    return v;
  }
  // Embedded $step_N inside a longer string
  return v.replace(/\$step_(\d+)(\.[a-zA-Z0-9_.-]+)?/g, (_, n, p) => {
    const base = runs[Number(n)]?.result;
    if (base === undefined) return "";
    const target = p ? deepGet(base, p) : base;
    // Guard the undefined case explicitly. `JSON.stringify(undefined)`
    // returns the JS value `undefined`, not the string "undefined", and
    // calling `.slice()` on it throws "Cannot read properties of undefined
    // (reading 'slice')". That was the recurring general-task crash where
    // a plan referenced `$step_N.missingField` (B4 in the bug review).
    if (target === undefined) return "";
    if (typeof target === "string") return recoverFullText(target);
    const serialized = JSON.stringify(target);
    return serialized === undefined ? "" : serialized.slice(0, 4000);
  });
}

// "*" as a path segment maps over an array and resolves the REMAINING path
// on each element, returning an array — e.g. "users.*.email" on
// {users:[{email:"a@x"},{email:"b@y"}]} returns ["a@x","b@y"]. Planners
// reach for this natural-looking syntax when they need every value of a
// field across a list (e.g. broadcasting an email to users.list's result);
// without it the reference resolves to undefined/falls through to the
// literal unresolved "$step_N.users.*.email" string (2026-07-08 regression —
// a broadcast-send task passed that literal string straight to email.send's
// `to` arg, which then failed silently while the synth narrated a fake
// "sent to all 5 users" success on top of the failure).
export function deepGet(obj: any, path: string): any {
  const parts = path.replace(/^\./, "").split(".");
  return deepGetParts(obj, parts);
}

function deepGetParts(obj: any, parts: string[]): any {
  if (parts.length === 0) return obj;
  const [part, ...rest] = parts;
  if (part === "*") {
    if (!Array.isArray(obj)) return undefined;
    return obj.map(item => deepGetParts(item, rest));
  }
  if (obj === null || obj === undefined) return undefined;
  return deepGetParts(obj[/^\d+$/.test(part) ? Number(part) : part], rest);
}

function extractJson(s: string): any {
  // Strip code fences if present
  const fenced = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  const raw = fenced ? fenced[1] : s;
  // Find first {...} balanced enough to parse
  const open = raw.indexOf("{");
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        const slice = raw.slice(open, i + 1);
        try { return JSON.parse(slice); } catch { return null; }
      }
    }
  }
  return null;
}

void primitives;
