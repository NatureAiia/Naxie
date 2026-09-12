// Governance policies — admin-curated vault documents that become guardrails
// applied to every general-task / synth call.
//
// Layout: every `*.md` file under `<vault>/_governance/` is treated as a
// policy. We load them at request time, cap the total bytes to fit in any
// reasonable context budget, and concat them into a single prefix string
// that callers prepend to their system prompt.
//
// Cache: 60-second TTL. Vault watcher events also bust the cache so an
// admin upload via the /governance page is reflected within seconds, not
// minutes.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { llmGenerate } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONSTRAINT_DIR = resolve(__dirname, "../../../.neuroworks/constraints");

const POLICY_DIR_REL = "_governance";

// Hard cap so a runaway admin upload can't blow up planner context. 32KB
// fits ~6-8 typical policy docs at a few KB each, leaves room for the rest
// of the system prompt + the task body.
const MAX_PREFIX_BYTES = 32 * 1024;
const CACHE_TTL_MS = 60_000;

export type GovernancePolicy = {
  path: string;        // relative to vault root, e.g. "_governance/data-privacy.md"
  name: string;        // filename without extension, used as the section header
  bytes: number;
  lastModified: string;
  reference?: boolean; // true = a manual/reference doc — listed + downloadable, but NOT injected into the prompt prefix
};

// A doc can opt out of the guardrail prefix with frontmatter `reference: true`
// (e.g. the API-creation blueprint — useful to agents on demand, but pure noise
// prepended to every task). We only need to peek at the leading frontmatter.
function isReferenceDoc(full: string): boolean {
  try {
    const head = readFileSync(full, "utf8").slice(0, 1024);
    const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return false;
    return /^\s*reference\s*:\s*true\s*$/im.test(m[1]);
  } catch { return false; }
}

let prefixCache: { value: string; builtAt: number } | null = null;
let listCache: { value: GovernancePolicy[]; builtAt: number } | null = null;

function policyRoot(): string {
  return join(config.vaultPath, POLICY_DIR_REL);
}

export function invalidateGovernanceCache(): void {
  prefixCache = null;
  listCache = null;
}

export function listGovernance(): GovernancePolicy[] {
  if (listCache && Date.now() - listCache.builtAt < CACHE_TTL_MS) return listCache.value;
  const root = policyRoot();
  if (!existsSync(root)) {
    listCache = { value: [], builtAt: Date.now() };
    return [];
  }
  const out: GovernancePolicy[] = [];
  try {
    for (const f of readdirSync(root)) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      const full = join(root, f);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        out.push({
          path: `${POLICY_DIR_REL}/${f}`,
          name: f.replace(/\.md$/i, ""),
          bytes: st.size,
          lastModified: st.mtime.toISOString(),
          reference: isReferenceDoc(full),
        });
      } catch { /* tolerate one bad file */ }
    }
  } catch { /* tolerate readdir error (e.g. perms) */ }
  // Sort newest first so admin sees the freshest policy at the top of the
  // page; the prefix order matches so latest policies get loaded first.
  out.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  listCache = { value: out, builtAt: Date.now() };
  return out;
}

// Build the system-prompt prefix. Empty string when no policies exist
// (caller can safely concat unconditionally). Each policy is wrapped in
// a labelled section so the model can cite which one is active when it
// declines a task.
export function loadGovernancePrefix(): string {
  if (prefixCache && Date.now() - prefixCache.builtAt < CACHE_TTL_MS) return prefixCache.value;
  const policies = listGovernance();
  if (policies.length === 0) {
    prefixCache = { value: "", builtAt: Date.now() };
    return "";
  }
  const root = policyRoot();
  const parts: string[] = [
    "=== GOVERNANCE POLICIES (organizational guardrails) ===",
    "The customer's organization has set the policies below. These OVERRIDE any user request that conflicts. When you decline, name the specific policy you're honoring.",
    "",
  ];
  let bytesSoFar = parts.join("\n").length;
  let included = 0;
  let skipped = 0;
  for (const p of policies) {
    // Reference/manual docs are listed + downloadable on the page but are NOT
    // guardrails — keep them out of the system-prompt prefix.
    if (p.reference) continue;
    try {
      const body = readFileSync(join(root, p.path.replace(`${POLICY_DIR_REL}/`, "")), "utf8").trim();
      const header = `--- Policy: ${p.name} ---`;
      const block = `${header}\n${body}\n`;
      if (bytesSoFar + block.length > MAX_PREFIX_BYTES) { skipped += 1; continue; }
      parts.push(block);
      bytesSoFar += block.length;
      included += 1;
    } catch { /* tolerate read failure */ }
  }
  if (skipped > 0) parts.push(`(${skipped} policy file${skipped === 1 ? "" : "s"} omitted to fit context budget)`);
  parts.push("=== END GOVERNANCE ===");
  parts.push("");
  const value = parts.join("\n");
  prefixCache = { value, builtAt: Date.now() };
  if (included > 0) console.log(`[governance] loaded ${included} policy file${included === 1 ? "" : "s"} into system prefix (${(value.length / 1024).toFixed(1)}KB)`);
  return value;
}

// ─── Constraint extraction ───
// Extracted from policy docs by the LLM. Each constraint is a structured rule
// the agent must follow. Hard constraints are enforced (the agent must obey)
// while soft constraints are preferences (the agent should prefer).

export type ConstraintSeverity = "hard" | "soft";

export type ExtractedConstraint = {
  id: string;
  policyName: string;       // source policy doc
  rule: string;             // one-sentence rule
  severity: ConstraintSeverity;
  category: string;         // e.g. "data-privacy", "brand-voice", "security"
  details?: string;         // longer explanation or exception conditions
  reviewed: boolean;        // operator has reviewed this constraint
  accepted: boolean;        // operator accepted or rejected
  createdAt: string;
};

// Store constraints per-policy as JSON files in .neuroworks/constraints/
function constraintPath(policyName: string): string {
  return join(CONSTRAINT_DIR, `${policyName}.json`);
}

function loadConstraintsForPolicy(policyName: string): ExtractedConstraint[] {
  const path = constraintPath(policyName);
  try {
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, "utf8")) as ExtractedConstraint[];
  } catch { return []; }
}

function saveConstraintsForPolicy(policyName: string, constraints: ExtractedConstraint[]): void {
  if (!existsSync(CONSTRAINT_DIR)) mkdirSync(CONSTRAINT_DIR, { recursive: true });
  writeFileSync(constraintPath(policyName), JSON.stringify(constraints, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function getConstraints(policyName?: string): { constraints: ExtractedConstraint[]; byPolicy: Record<string, ExtractedConstraint[]> } {
  const all = listGovernance();
  const byPolicy: Record<string, ExtractedConstraint[]> = {};
  for (const p of all) {
    if (p.reference) continue;
    const cs = loadConstraintsForPolicy(p.name);
    if (cs.length > 0) byPolicy[p.name] = cs;
  }
  const constraints = policyName ? loadConstraintsForPolicy(policyName) : Object.values(byPolicy).flat();
  return { constraints, byPolicy };
}

export function updateConstraint(policyName: string, constraintId: string, patch: Partial<ExtractedConstraint>): ExtractedConstraint | null {
  const cs = loadConstraintsForPolicy(policyName);
  const idx = cs.findIndex(c => c.id === constraintId);
  if (idx === -1) return null;
  cs[idx] = { ...cs[idx], ...patch };
  saveConstraintsForPolicy(policyName, cs);
  return cs[idx];
}

// LLM extraction: given a policy doc body, ask the LLM to extract constraints.
const EXTRACT_SYSTEM = `You are a policy analyst. Extract every explicit rule, restriction, requirement, or preference from the given policy document.

For each rule, output a JSON object with these fields:
- rule: a one-sentence description of what the agent must or should do
- severity: "hard" if the rule uses MUST, MUST NOT, REQUIRED, PROHIBITED, FORBIDDEN, SHALL, SHALL NOT, NEVER, ALWAYS, BANNED, or similar absolute language. "soft" if it uses SHOULD, RECOMMENDED, MAY, OPTIONAL, PREFER, AVOID, or similar advisory language.
- category: one of: data-privacy, security, brand-voice, compliance, ethical, operational, access-control, communication, quality, other
- details: (optional) any exceptions, conditions, or additional context

Output a JSON array. Do NOT add commentary outside the JSON.`;

// Pull a JSON array of rule objects out of an LLM response, tolerant of
// prose wrappers / ```json fences / a {constraints:[…]} envelope.
function parseRuleArray(result: string): { rule: string; severity: string; category: string; details?: string }[] {
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) return parsed;
    return parsed.constraints ?? parsed.rules ?? [];
  } catch { /* fall through to a bracket scan */ }
  const m = result.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* noise */ } }
  return [];
}

// Boilerplate that is NOT a rule — citation lines, section headers, dates.
// The old extractor returned "This Act may be cited as…" as its ONE
// constraint for an entire Data Protection Act because the doc was truncated
// to its preamble; this guards against that class of junk surviving.
function isRuleNoise(rule: string): boolean {
  const r = rule.trim().toLowerCase();
  if (r.length < 12) return true;
  // Citation / structural boilerplate.
  if (/\b(may be cited as|short title|comes into operation|date of commencement|this (act|section|part|chapter)\b.*\b(cited|entitled|divided))\b/.test(r)) return true;
  if (/^(part|chapter|section|schedule)\s+[ivxlc\d]+/.test(r)) return true;
  // Pure DEFINITIONS aren't rules — a constraint has to constrain an ACTION.
  // "A \"computer device\" is defined as…" / "\"Data\" means…" / "X refers to…"
  // flooded the review queue with dictionary entries. Drop the definitional
  // shape unless the sentence also carries obligation language.
  const hasObligation = /\b(must|shall|must not|shall not|may not|required|prohibited|forbidden|never|always|should|shall be|is required to|is prohibited)\b/.test(r);
  if (!hasObligation && /^(a |an |the )?["“']?[\w .]+["”']?\s+(is defined as|means|refers to|is an?\b|are\b)/.test(r)) return true;
  return false;
}

export async function extractConstraints(policyName: string, opts: { force?: boolean } = {}): Promise<ExtractedConstraint[]> {
  const path = join(config.vaultPath, "_governance", `${policyName}.md`);
  if (!existsSync(path)) throw new Error(`Policy "${policyName}" not found`);

  // Re-extraction is opt-in via `force` — a cached (possibly stale/thin) set
  // no longer silently short-circuits a deliberate re-extract. Accepted
  // review state is preserved across a re-extract by rule text below.
  const existing = loadConstraintsForPolicy(policyName);
  if (existing.length > 0 && !opts.force) return existing;

  const body = readFileSync(path, "utf8");
  const clean = body.replace(/^---[\s\S]*?---\r?\n/, "").trim();

  // Chunk the WHOLE document (a statute runs tens of KB; truncating to 8000
  // chars left only the preamble, so only the citation line got extracted).
  // ~7000-char windows on paragraph boundaries, capped so a pathological doc
  // can't fan out into dozens of LLM calls.
  const CHUNK = 7000;
  const MAX_CHUNKS = 8;
  const chunks: string[] = [];
  for (let i = 0; i < clean.length && chunks.length < MAX_CHUNKS; ) {
    let end = Math.min(i + CHUNK, clean.length);
    if (end < clean.length) {
      const br = clean.lastIndexOf("\n\n", end);
      if (br > i + 1000) end = br;
    }
    chunks.push(clean.slice(i, end));
    i = end;
  }

  const raw: { rule: string; severity: string; category: string; details?: string }[] = [];
  for (const chunk of chunks) {
    try {
      const result = await llmGenerate(
        `Extract rules from this policy document (an excerpt from a larger document — extract every rule you see in it):\n\n${chunk}`,
        EXTRACT_SYSTEM,
        { profile: "extraction", temperature: 0.1, maxTokens: 2048 },
      );
      raw.push(...parseRuleArray(result));
    } catch { /* a bad chunk shouldn't sink the whole extraction */ }
  }

  // Dedup by normalised rule text; preserve accepted/reviewed state from any
  // prior extraction so re-running doesn't wipe a human's review decisions.
  const priorByRule = new Map(existing.map(c => [c.rule.trim().toLowerCase(), c]));
  const seen = new Set<string>();
  const now = new Date().toISOString();
  const extracted: ExtractedConstraint[] = [];
  for (const c of raw) {
    if (!c.rule || typeof c.rule !== "string") continue;
    const rule = String(c.rule).trim();
    const key = rule.toLowerCase();
    if (seen.has(key) || isRuleNoise(rule)) continue;
    seen.add(key);
    const prior = priorByRule.get(key);
    extracted.push({
      id: `${policyName}-${extracted.length}`,
      policyName,
      rule,
      severity: (c.severity === "hard" || c.severity === "soft") ? c.severity : "soft",
      category: String(c.category ?? "other"),
      details: c.details ? String(c.details).trim() : undefined,
      reviewed: prior?.reviewed ?? false,
      accepted: prior?.accepted ?? false,
      createdAt: prior?.createdAt ?? now,
    });
  }

  saveConstraintsForPolicy(policyName, extracted);
  return extracted;
}

// Generic / filler words that carry no topical signal. Overlap on these used
// to trip the gate constantly — a rule "always maintain accurate customer
// records" and any step mentioning "customer records" would both share
// "customer"+"records" and block, even a read-only lookup. Filtering them is
// what stops governance from killing unrelated tasks.
const GOV_STOPWORDS = new Set([
  "this", "that", "these", "those", "with", "without", "from", "into", "when", "where",
  "which", "what", "your", "their", "them", "they", "there", "here", "have", "has", "had",
  "will", "would", "could", "should", "shall", "must", "must", "does", "did", "been", "being",
  "any", "all", "each", "every", "some", "only", "also", "than", "then", "such", "other",
  "another", "about", "over", "under", "between", "within", "across", "upon", "per", "via",
  "always", "never", "ensure", "ensures", "provide", "provides", "provided", "maintain",
  "maintains", "include", "includes", "including", "following", "above", "below", "using",
  "used", "make", "makes", "made", "need", "needs", "want", "like", "more", "most", "very",
  "data", "information", "record", "records", "report", "reports", "system", "systems",
  "company", "business", "process", "content", "document", "documents", "request", "requests",
  "task", "tasks", "work", "team", "service", "services", "policy", "policies", "user", "users",
  "customer", "customers", "person", "people", "staff", "member", "members", "employee", "employees",
  "action", "actions", "item", "items", "thing", "things", "part", "parts", "case", "cases",
]);

function govContentWords(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !GOV_STOPWORDS.has(w));
}

// A rule only gates a step/answer if it PROHIBITS something. Obligations
// ("must include a disclaimer", "always sign off as Finance") can't be judged
// violated by a keyword match on an action string — enforcing them via overlap
// only ever produces false blocks — so they never hard-block; the governance
// system-prompt prefix nudges the model on those instead.
function isProhibitive(rule: string): boolean {
  return /\b(not|never|no|nor|don't|cannot|can't|without|prohibit(?:ed|s)?|forbid(?:den|s)?|ban(?:ned|s)?|refrain|avoid|prevent(?:ed|s)?|disallow(?:ed|s)?|restrict(?:ed|s)?|exclude[ds]?|off-limits|outside)\b/i.test(rule);
}

// Check a proposed action string against all active constraints.
// Returns any constraints the action would violate.
//
// Blocks only on a HIGH-CONFIDENCE match: the rule must be prohibitive, and the
// action must share at least 2 distinctive (stopword-filtered) words with it
// that also cover a real fraction of the rule's distinctive terms. This keeps
// the gate from firing on incidental topical overlap while still catching a
// step that plainly does the prohibited thing.
export function checkActionAgainstConstraints(action: string, constraints: ExtractedConstraint[]): { violated: ExtractedConstraint[]; reason: string }[] {
  const results: { violated: ExtractedConstraint[]; reason: string }[] = [];
  const actionWords = new Set(govContentWords(action));
  if (actionWords.size === 0) return results;
  for (const c of constraints) {
    if (!c.accepted) continue;
    if (!isProhibitive(c.rule)) continue;              // obligations don't gate
    const ruleWords = [...new Set(govContentWords(c.rule))];
    if (ruleWords.length < 2) continue;                // too thin to match on
    const overlap = ruleWords.filter(w => actionWords.has(w));
    const strong = overlap.length >= 2 && overlap.length >= Math.ceil(ruleWords.length * 0.4);
    if (strong) {
      results.push({ violated: [c], reason: `"${c.rule}" (${c.severity} constraint, category: ${c.category})` });
    }
  }
  return results;
}

// ─── Enforcement ───
// Everything above this line (extract/review/checkAction) already existed as
// a standalone review workbench — an admin could upload a policy, extract
// constraints, accept/reject them, and manually paste an action into the
// "test" box. None of that touched real agent execution: quality.check and
// security.scan run automatically after every synth, but there was no third
// gate reading accepted constraints, and no gate on the plan steps
// themselves. A hard "never email outside the finance domain" constraint
// could sit accepted in the review UI while email.send fired anyway — the
// exact class of incident this system exists to prevent. The functions below
// close that gap: one pre-execution check on side-effecting plan steps
// (blocks before the tool runs), one post-synth check on the final answer
// text (mirrors quality.check/security.scan's Phase-A wiring in agent.ts).

// Tools whose side effects are worth gating before they run. Deliberately a
// narrow, explicit allowlist — read-only tools (vault.read, web.fetch,
// research.*) can't violate an org policy by running, only by what they DO
// with the result, which the post-synth content check catches instead.
export const CONSEQUENTIAL_TOOLS = new Set([
  "email.send",
  "vault.write", "vault.edit", "vault.create_zettel", "vault.append", "vault.write_pdf",
  "vault.capture_note", "vault.capture_youtube",
  "fs.import_to_vault",
  "github.create_issue", "github.comment_on_issue", "github.update_issue", "github.request_review",
  "webhook.post", "slack.post", "telegram.send", "discord.post", "msteams.post", "googlechat.post",
  "connector.call",
  "n8n.trigger_webhook", "n8n.trigger_workflow_by_name", "n8n.create_workflow",
  "crm.upsert_contact", "crm.move_deal_stage",
  "db.write",
  "data.publish", "omnisignal.publish",
  "code.exec",
  // Naxie org additions (docs/naxie-architecture.md §5) — a calendar change
  // affecting people other than you, and the host-tool actions (§2.2) that
  // reach real OS-level access on this machine. Host tools are also gated by
  // their own Settings > System Access toggle (§2.2/§8.5); this entry is what
  // routes them through the SAME governance gate as everything else here,
  // not a parallel check.
  "calendar.write_external_attendee",
  "system_control", "manage_clipboard", "git_pull",
]);

// Prefix form of the same allowlist, for tool families that don't have a
// fixed enumerable set of names yet (docs §5's "a finance.* category") —
// CONSEQUENTIAL_TOOLS itself stays an exact-match Set (existing callers that
// do `.has("email.send")` etc. keep working unchanged); isConsequentialTool
// below is what actually decides gating and checks both.
const CONSEQUENTIAL_TOOL_PREFIXES = ["finance."];

export function isConsequentialTool(tool: string): boolean {
  return CONSEQUENTIAL_TOOLS.has(tool) || CONSEQUENTIAL_TOOL_PREFIXES.some(p => tool.startsWith(p));
}

// Build a compact, keyword-rich description of a plan step so the overlap
// check in checkActionAgainstConstraints has real signal to match against —
// the tool name alone ("email.send") shares no words with a policy rule
// ("never email customer financial data to external domains"), but the
// resolved args usually do.
export function describeStepAction(tool: string, args: Record<string, any>): string {
  const parts: string[] = [tool];
  for (const key of ["to", "path", "vaultFolder", "title", "subject", "body", "content", "url", "channel", "source", "code", "kind"]) {
    const v = args?.[key];
    if (v === undefined || v === null) continue;
    const s = Array.isArray(v) ? v.join(", ") : String(v);
    if (s.trim().length === 0) continue;
    parts.push(s.slice(0, 500));
  }
  return parts.join(" | ");
}

export type GovernanceGate = {
  blocked: boolean;
  violations: { rule: string; policyName: string; severity: ConstraintSeverity; category: string }[];
};

// Only "reviewed && accepted && hard" constraints are enforceable — matches
// the bar the /check-action route already uses for "accepted" (an
// extracted-but-unreviewed constraint is a draft, not policy yet), narrowed
// further to hard since soft constraints are preferences, not something a
// step or answer should be blocked over.
export function filterEnforceable(constraints: ExtractedConstraint[]): ExtractedConstraint[] {
  return constraints.filter(c => c.reviewed && c.accepted && c.severity === "hard");
}

// Pure core: given an action/content string and an already-filtered
// enforceable set, decide block/pass. Disk-free and deterministic — the I/O
// wrappers below (checkStepAgainstGovernance, checkContentAgainstGovernance)
// just supply the enforceable set from getConstraints().
// Global safety valve: NEUROWORKS_GOVERNANCE_MODE=monitor keeps constraints
// active and logged but STOPS them from blocking execution — an operator can
// flip this if a mis-tuned rule is halting real work, without deleting the
// policy or un-accepting every constraint one by one. Default is "enforce".
function governanceEnforces(): boolean {
  return String(process.env.NEUROWORKS_GOVERNANCE_MODE ?? "enforce").trim().toLowerCase() !== "monitor";
}

export function gateAction(action: string, enforceable: ExtractedConstraint[]): GovernanceGate {
  if (enforceable.length === 0) return { blocked: false, violations: [] };
  const hits = checkActionAgainstConstraints(action, enforceable);
  if (hits.length === 0) return { blocked: false, violations: [] };
  const violations = hits.map(h => ({ rule: h.violated[0].rule, policyName: h.violated[0].policyName, severity: h.violated[0].severity, category: h.violated[0].category }));
  // Monitor mode: surface the match but don't block.
  if (!governanceEnforces()) {
    console.log(`[governance] MONITOR — would block (${violations.map(v => v.rule).join("; ").slice(0, 160)})`);
    return { blocked: false, violations: [] };
  }
  return { blocked: true, violations };
}

// Pre-execution gate for a single plan step.
export function checkStepAgainstGovernance(tool: string, args: Record<string, any>): GovernanceGate {
  if (!isConsequentialTool(tool)) return { blocked: false, violations: [] };
  const enforceable = filterEnforceable(getConstraints().constraints);
  if (enforceable.length === 0) return { blocked: false, violations: [] };
  return gateAction(describeStepAction(tool, args), enforceable);
}

// Post-synth gate for the final answer text — checked against the drafted
// answer rather than a tool call. Wired into agent.ts's Phase A alongside
// quality.check/security.scan via the governance.check primitive.
export function checkContentAgainstGovernance(content: string): GovernanceGate {
  const enforceable = filterEnforceable(getConstraints().constraints);
  return gateAction(content, enforceable);
}

// Fast pre-check so callers on a hot path (runStep, once per consequential
// step) can skip the getConstraints() read entirely when governance isn't in
// use. listGovernance() is already 60s-cached, so this is cheap even when
// called often, but most installs will never touch _governance/ at all.
export function hasEnforceableConstraints(): boolean {
  return filterEnforceable(getConstraints().constraints).length > 0;
}
