// Architect role (docs/naxie-architecture.md §7) — Naxie's self-improvement
// role, deliberately the highest-risk piece and built last. Architect reads
// its own audit trail + OrgTask history + (read-only, sandboxed) source code
// and proposes ONE small, concrete diff at a time. It never writes anything
// to disk, never runs shell/git commands, and never applies its own
// proposal — `runArchitectReview()` below is the ONLY function allowed to
// create a `role: "architect"` OrgTask, and every task it creates lands in
// waiting-on-approval so a human reviews the diff before anything happens.
//
// Governance is already decided elsewhere: ROLE_AUTONOMY.architect and
// forceApprovalForRole("architect") in org-tasks.ts make approval
// unconditional for this role, with no override. This file is everything
// downstream of that decision.
//
// The private file reader/lister below are intentionally NOT registered in
// lib/primitives.ts — there is no role-scoped tool-allowlist mechanism
// anywhere else in this codebase, so keeping them un-exported and private to
// this module is the only way to guarantee no other persona/role can reach
// repo source through them.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { queryAudit } from "./audit-log.js";
import { listOrgTasks, createOrgTask, requestApproval, type ArchitectProposal } from "./org-tasks.js";
import { llmGenerate } from "./llm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The actual git repo root (NaxionAI-Powered-by-Neuroworks/), NOT the
// neuroworks/ app dir — computed relative to this file's own location
// (neuroworks/server/src/lib/architect.ts is 4 levels below it) rather than
// hardcoded, so it survives a repo move/rename.
export const REPO_ROOT = resolve(__dirname, "../../../..");

// naxionai/backend's retirement timing is explicitly undecided (docs
// §naxionai/backend note) — Architect must never read or write anything
// under it, full stop. Excluded before any other check.
const EXCLUDED_ROOTS = [resolve(REPO_ROOT, "naxionai", "backend")];

// Case-insensitive deny-list, checked against the path relative to
// REPO_ROOT with forward slashes, before any read/list. Deliberately
// conservative — secrets/credentials/keys of any shape, never `.env*`.
const DENY_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,          // .env, .env.local, .env.*
  /(^|\/)node_modules\//i,
  /(^|\/)secrets[^/]*(\/|$)/i,   // **/secrets*
  /\.pem$/i,
  /\.key$/i,
];

function toRepoRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split("\\").join("/");
}

function isDenied(absPath: string): boolean {
  const rel = toRepoRelative(absPath);
  if (rel.startsWith("..")) return true; // outside REPO_ROOT entirely
  for (const excludedRoot of EXCLUDED_ROOTS) {
    const excludedRel = toRepoRelative(excludedRoot);
    if (rel === excludedRel || rel.startsWith(`${excludedRel}/`)) return true;
  }
  return DENY_PATTERNS.some(re => re.test(rel));
}

// Resolves a caller-supplied relative path against REPO_ROOT and asserts it
// stays inside it. Returns null (never throws) for anything out of bounds or
// denied — callers treat null as "not readable," which is also what the LLM
// tool-loop below reports back on a denied request, so a curious proposal
// just gets "not accessible," never a stack trace or path disclosure.
function resolveSafe(relPath: string): string | null {
  const abs = resolve(REPO_ROOT, relPath);
  if (!abs.startsWith(REPO_ROOT)) return null;
  if (isDenied(abs)) return null;
  return abs;
}

// ─── private, repo-root-scoped read tools (NOT in lib/primitives.ts) ──────

function architectReadFile(relPath: string): string | null {
  const abs = resolveSafe(relPath);
  if (!abs) return null;
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function architectListDir(relPath: string): string[] | null {
  const abs = resolveSafe(relPath);
  if (!abs) return null;
  try {
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return null;
    return readdirSync(abs, { withFileTypes: true })
      .filter(e => !isDenied(join(abs, e.name)))
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    return null;
  }
}

// ─── minimal unified-diff builder (no `diff` npm dependency present) ──────
// Whole-file LCS line diff — fine for v1's single-file whole-content
// proposals. Not a general-purpose diff library; just enough to produce
// clean unified-diff-format text for a review UI.
function unifiedDiff(path: string, oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length, m = b.length;
  // LCS table (small single-file proposals only — O(n*m) is fine here).
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  type Op = { t: "="; l: string } | { t: "-"; l: string } | { t: "+"; l: string };
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: "=", l: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ t: "-", l: a[i] }); i++; }
    else { ops.push({ t: "+", l: b[j] }); j++; }
  }
  while (i < n) { ops.push({ t: "-", l: a[i] }); i++; }
  while (j < m) { ops.push({ t: "+", l: b[j] }); j++; }

  const lines = [`--- a/${path}`, `+++ b/${path}`];
  let oldLine = 1, newLine = 1;
  let oldStart = 1, newStart = 1, hunk: string[] = [], oldCount = 0, newCount = 0;
  const flush = () => {
    if (hunk.length === 0) return;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...hunk);
    hunk = []; oldCount = 0; newCount = 0;
  };
  for (const op of ops) {
    if (op.t === "=") {
      flush();
      oldLine++; newLine++;
      oldStart = oldLine; newStart = newLine;
    } else if (op.t === "-") {
      if (hunk.length === 0) { oldStart = oldLine; newStart = newLine; }
      hunk.push(`-${op.l}`); oldCount++; oldLine++;
    } else {
      if (hunk.length === 0) { oldStart = oldLine; newStart = newLine; }
      hunk.push(`+${op.l}`); newCount++; newLine++;
    }
  }
  flush();
  return lines.length > 2 ? lines.join("\n") : ""; // no diff => empty string
}

// ─── the LLM tool-loop ──────────────────────────────────────────────────

type ToolCall = { name: "read_file" | "list_dir" | "recent_audit" | "recent_org_tasks" | "propose"; args: Record<string, unknown> };

const SYSTEM_PROMPT = `You are Naxie's Architect subroutine — a read-only code-review assistant.
You may inspect the repository's own source code and recent operational history to find ONE small, concrete, SAFE improvement to propose (a bug fix, a small refactor, a doc fix, a small robustness improvement). You must propose exactly one change to exactly one file.

You have NO ability to write, execute, or apply anything — you can only read and, at the end, describe a proposed change as plain text.

Tools available (call by responding with a single JSON object, nothing else):
- {"tool":"list_dir","path":"relative/dir"} — list a directory relative to the repo root
- {"tool":"read_file","path":"relative/file"} — read a file relative to the repo root
- {"tool":"recent_audit"} — recent audit log events
- {"tool":"recent_org_tasks"} — recent OrgTask history
- {"tool":"propose","path":"relative/file","newContent":"<entire new file content>","rationale":"<plain-language explanation>"} — submit your final proposal (call this when ready; only one target file)

Never propose changes under naxionai/backend/ — it is out of scope. Respond with ONLY the JSON object for your next tool call, no other text.`;

async function callArchitectLLM(prompt: string): Promise<ToolCall | null> {
  // Bounded per step (6 steps max) so an LLM outage fails the button in
  // ~9 min worst case instead of hanging it for ~90 min on 15-min defaults.
  const raw = await llmGenerate(prompt, SYSTEM_PROMPT, { profile: "planning", maxTokens: 4000, temperature: 0.2, timeoutMs: 90_000 });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.tool !== "string") return null;
    return { name: parsed.tool, args: parsed };
  } catch {
    return null;
  }
}

const MAX_TOOL_LOOP_STEPS = 6;

// The files a diff's rationale must be flagged for, per docs §7's governance
// note — Architect can read/propose changes to its own constraints, but a
// reviewer must not be able to miss that it's doing so.
const GOVERNANCE_SENSITIVE_FILES = ["org-tasks.ts", "governance.ts", "architect.ts"];

function flagIfGovernanceSensitive(filePath: string, rationale: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  if (GOVERNANCE_SENSITIVE_FILES.includes(base)) {
    return `\u26a0 This proposal changes Naxie's own governance rules — review carefully: ${rationale}`;
  }
  return rationale;
}

// The one function allowed to create role:"architect" OrgTasks. Runs a small
// bounded tool-loop (own LLM call, bypassing agent.ts's shared primitives
// dispatcher entirely) offering only read-only tools, then files a single
// pending-approval OrgTask with the resulting proposal. Never writes to
// disk, never runs shell/git, never auto-applies — see docs §7 and the
// module header above.
// `focus` — an operator-approved improvement (from the weekly
// self-improvement review) the architect should turn into a concrete diff,
// instead of picking its own target. The diff is still its own approval.
export async function runArchitectReview(opts: { focus?: string } = {}): Promise<{ created: boolean; taskId?: string; reason?: string }> {
  const auditContext = queryAudit({ limit: 30 }).events
    .map(e => `${e.ts} [${e.level}] ${e.actor} ${e.action} ${e.target} — ${e.result}`)
    .join("\n");
  const orgTaskContext = listOrgTasks()
    .slice(0, 20)
    .map(t => `${t.role} | ${t.status} | ${t.title}`)
    .join("\n");

  const sourceFilesRead: string[] = [];
  let auditQueried = false;
  let orgTasksQueried = false;
  const focusBlock = opts.focus
    ? `The operator approved this improvement — implement it (or the smallest first step of it) as your ONE proposal:\n${opts.focus.slice(0, 3000)}\n\n`
    : "";
  let transcript = focusBlock + `Recent audit log (most recent first, up to 30):\n${auditContext || "(empty)"}\n\nRecent OrgTasks (up to 20):\n${orgTaskContext || "(empty)"}\n\nBegin. Call a tool.`;

  for (let step = 0; step < MAX_TOOL_LOOP_STEPS; step++) {
    const call = await callArchitectLLM(transcript);
    if (!call) return { created: false, reason: "architect LLM did not return a parseable tool call" };

    if (call.name === "propose") {
      const targetPath = String(call.args.path ?? "").trim();
      const newContent = String(call.args.newContent ?? "");
      const rationale = String(call.args.rationale ?? "").trim();
      if (!targetPath || !rationale) {
        transcript += `\n\nYour propose call was missing "path" or "rationale" — try again.`;
        continue;
      }
      const abs = resolveSafe(targetPath);
      if (!abs) {
        transcript += `\n\n"${targetPath}" is not a readable/allowed path. Choose a different file or try list_dir first.`;
        continue;
      }
      const oldContent = architectReadFile(targetPath) ?? "";
      const diff = unifiedDiff(targetPath, oldContent, newContent);
      if (!diff) {
        transcript += `\n\nYour proposed content is identical to the current file — that's not a change. Propose something concrete.`;
        continue;
      }
      // Dedup: never stack an identical proposal on top of one already
      // waiting. Hot reloads (and the weekly tick after a restart) re-run
      // the same analysis and converge on the same file — without this the
      // inbox fills with byte-identical "Proposed improvement: X" triplets.
      const dupe = listOrgTasks({ status: "waiting-on-approval" } as any).find(
        (t: any) => t.role === "architect" && (t.pendingApproval?.proposal?.filesTouched ?? []).includes(targetPath),
      );
      if (dupe) {
        return { created: false, reason: `identical proposal already waiting (${dupe.id.slice(0, 8)})` };
      }
      const proposal: ArchitectProposal = {
        diff,
        filesTouched: [targetPath],
        rationale: flagIfGovernanceSensitive(targetPath, rationale),
        basedOn: {
          auditQuery: auditQueried ? "recent audit log (limit 30)" : undefined,
          sourceFilesRead: sourceFilesRead.length ? sourceFilesRead.slice() : undefined,
        },
      };
      const task = createOrgTask({
        role: "architect",
        title: `Proposed improvement: ${targetPath}`,
        detail: rationale.slice(0, 400),
        priority: "low",
        createdBy: "naxie",
      });
      const updated = requestApproval(task.id, {
        actionDescription: `A small code improvement has been proposed for review — see the attached diff.`,
        kind: "architect-change",
        diff,
        proposal,
      });
      return { created: true, taskId: updated?.id ?? task.id };
    }

    if (call.name === "read_file") {
      const p = String(call.args.path ?? "");
      const content = architectReadFile(p);
      if (content !== null) sourceFilesRead.push(p);
      transcript += `\n\nread_file("${p}") ->\n${content === null ? "(not found / not accessible)" : content.slice(0, 8000)}`;
      continue;
    }
    if (call.name === "list_dir") {
      const p = String(call.args.path ?? "");
      const entries = architectListDir(p);
      transcript += `\n\nlist_dir("${p}") ->\n${entries === null ? "(not found / not accessible)" : entries.join("\n")}`;
      continue;
    }
    if (call.name === "recent_audit") {
      auditQueried = true;
      transcript += `\n\nrecent_audit ->\n${auditContext || "(empty)"}`;
      continue;
    }
    if (call.name === "recent_org_tasks") {
      orgTasksQueried = true;
      transcript += `\n\nrecent_org_tasks ->\n${orgTaskContext || "(empty)"}`;
      continue;
    }
    transcript += `\n\nUnknown tool "${call.name}". Available tools: read_file, list_dir, recent_audit, recent_org_tasks, propose.`;
  }
  return { created: false, reason: `no proposal after ${MAX_TOOL_LOOP_STEPS} tool-loop steps` };
}
