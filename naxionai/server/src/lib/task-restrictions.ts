// Task restrictions — company-structure guardrails on WHAT a person may ask
// the workforce to do. "Certain employees aren't supposed to do certain
// things": a staffer in Support shouldn't be moving money; someone outside
// Finance shouldn't be querying the finance database; only admins send org
// email; etc.
//
// A restriction denies a CAPABILITY to a SCOPE. Scope is one of:
//   role:staff | role:admin      — everyone at that access layer
//   dept:Finance                 — everyone in that department (case-insensitive)
//   user:alice@example.com        — one specific person
// Capabilities are coarse task categories, detected from the task text at the
// chat/template entry point (see detectCapabilities). Enforced in the run
// routes: a restricted caller asking for a denied capability gets a 403 that
// names the block, before any agent work runs.
//
// Token-less machine callers (agents, schedules, MCP) are NEVER restricted —
// restrictions govern HUMANS using the product, same contract as the access
// layers. Superadmins are never restricted either (they own the org).
//
// Persisted under .naxion/task-restrictions.json (gitignored).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PublicUser } from "./users.js";
import { layerOfRole } from "./access.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.naxion");
const STORE = resolve(CONFIG_DIR, "task-restrictions.json");

// Local-machine access — reading/acting on the SERVER OPERATOR's own PC
// (Notepad, the user folders, absolute paths, credential dotfiles, terminal).
// This is a HARD default gate (not an opt-in restriction): those primitives
// touch the operator's device, not the requesting user's, so only a superadmin
// (or a token-less machine/loopback caller = the operator's own automation) may
// trigger them. Enforced at EVERY task-submission entry (chat, team, schedule
// create, plan) so a low-privilege user can't exfiltrate the operator's files —
// including via a scheduled task that would otherwise run as machine context.
const LOCAL_MACHINE_RE = /\bnote\s?pad\b|\b(?:my|the)\s+(?:pc|computer|laptop|desktop|downloads?|documents?|home\s+folder|file\s?system)\b|\b(?:in|on|from|check|open|read|list|browse|scan)\s+(?:my|the)\s+(?:downloads?|desktop|documents?|pictures?|photos?|videos?|music|files?)\b|[a-zA-Z]:\\\\|[a-zA-Z]:\\[^\s]|\/(?:Users|home|etc|var|root)\/|\.(?:env|ssh|aws|npmrc|git-credentials)\b|\bid_rsa\b|\b(?:run|execute|exec)\s+(?:a\s+)?(?:command|shell|terminal|bash|powershell|cmd|python\s+script)\b|\bterminal\b|\bshell\s+command\b/i;

export function isLocalMachineTask(text: string): boolean {
  return LOCAL_MACHINE_RE.test(String(text ?? ""));
}

// The capability taxonomy — deliberately small and business-legible, not a
// mirror of the primitive list. Each maps to detection patterns below.
export const CAPABILITIES = [
  "payments",          // moving money / invoices / payment links
  "email",             // sending mail as the org
  "database",          // querying/writing external company databases
  "external-systems",  // calling connectors / integrations / other apps
  "file-write",        // writing to the vault / filesystem
  "research",          // open web research
  "hiring",            // creating/activating agents, departments, users
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type Restriction = {
  id: string;
  scope: string;          // role:staff | dept:Finance | user:email
  capability: Capability;
  note?: string;
  createdAt: string;
  createdBy?: string;
};

function load(): Restriction[] {
  try { if (existsSync(STORE)) return JSON.parse(readFileSync(STORE, "utf8")) as Restriction[]; }
  catch { /* corrupt → empty */ }
  return [];
}
function save(list: Restriction[]): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STORE, JSON.stringify(list, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function listRestrictions(): Restriction[] { return load(); }

export function addRestriction(input: { scope: string; capability: string; note?: string; createdBy?: string }): Restriction {
  const scope = String(input.scope ?? "").trim().toLowerCase();
  if (!/^(role:(staff|admin|superadmin)|dept:.+|user:.+@.+)$/.test(scope)) {
    throw new Error('scope must be "role:staff", "dept:<name>", or "user:<email>"');
  }
  const capability = String(input.capability ?? "").trim() as Capability;
  if (!CAPABILITIES.includes(capability)) throw new Error(`capability must be one of: ${CAPABILITIES.join(", ")}`);
  const list = load();
  if (list.some(r => r.scope === scope && r.capability === capability)) {
    throw new Error("that restriction already exists");
  }
  const r: Restriction = {
    id: randomUUID(), scope, capability,
    note: input.note ? String(input.note).trim().slice(0, 200) : undefined,
    createdAt: new Date().toISOString(), createdBy: input.createdBy,
  };
  list.push(r);
  save(list);
  return r;
}

export function removeRestriction(id: string): boolean {
  const list = load();
  const next = list.filter(r => r.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

// Which capabilities does this task text call for? Coarse keyword detection —
// the goal is to catch a person TRYING to do a restricted thing, not to
// perfectly classify. Over-detection just means a restricted user is asked to
// route it through someone who's allowed.
const CAPABILITY_PATTERNS: Record<Capability, RegExp> = {
  payments: /\b(pay(ment|out|s)?|invoice|charge|refund|stripe|paynow|checkout|transfer\s+(money|funds)|wire|send\s+money)\b/i,
  email: /\b(email|e-mail|send\s+(a\s+)?(mail|message|note)\s+to|reach\s+out\s+to|notify\s+.*\bby\s+email|mailjet)\b/i,
  database: /\b(database|db\b|sql|query\s+the\s+\w+|neon|postgres|the\s+finance\s+(db|database)|records?\s+in\s+the)\b/i,
  "external-systems": /\b(connector|integration|slack|telegram|notion|github|sync\s+with|push\s+to\s+\w+|call\s+the\s+\w+\s+api)\b/i,
  "file-write": /\b(write\s+to\s+(the\s+)?vault|save\s+.*\b(note|file)\b|create\s+a\s+(note|file|zettel)|append\s+to|overwrite)\b/i,
  research: /\b(research|look\s+up|search\s+the\s+web|find\s+out\s+about|investigate|scan\s+the\s+(market|landscape))\b/i,
  hiring: /\b(hire|create\s+(a\s+)?(persona|agent|employee|department|user)|onboard|activate\s+.*\bpersona|add\s+(a\s+)?(person|user|employee))\b/i,
};

export function detectCapabilities(taskText: string): Capability[] {
  const t = String(taskText ?? "").slice(0, 4000);
  return CAPABILITIES.filter(c => CAPABILITY_PATTERNS[c].test(t));
}

// The scopes that apply to a given user, most-specific first.
function scopesForUser(u: PublicUser): string[] {
  const scopes = [`role:${layerOfRole(u.role)}`];
  if (u.department) scopes.push(`dept:${u.department.trim().toLowerCase()}`);
  scopes.push(`user:${u.email.trim().toLowerCase()}`);
  return scopes;
}

// Is this human blocked from this capability? Superadmins never are.
export function isCapabilityDenied(u: PublicUser, capability: Capability): { denied: boolean; via?: Restriction } {
  if (layerOfRole(u.role) === "superadmin") return { denied: false };
  const mine = new Set(scopesForUser(u));
  const hit = load().find(r => r.capability === capability && mine.has(r.scope));
  return hit ? { denied: true, via: hit } : { denied: false };
}

// Entry-point gate: given a human and a task, return the FIRST denied
// capability the task calls for (or null if clear). Machine callers pass null
// straight through by never being given a user.
export function checkTaskAllowed(u: PublicUser | null, taskText: string): { allowed: boolean; capability?: Capability; note?: string } {
  if (!u) return { allowed: true };
  if (layerOfRole(u.role) === "superadmin") return { allowed: true };
  for (const cap of detectCapabilities(taskText)) {
    const d = isCapabilityDenied(u, cap);
    if (d.denied) return { allowed: false, capability: cap, note: d.via?.note };
  }
  return { allowed: true };
}
