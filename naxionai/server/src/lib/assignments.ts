// Assignments — the human-in-the-loop work ledger behind the My Work page.
//
// An assignment is a unit of work handed TO a human: by an agent run
// that needs a person to do something, by their boss, or by any colleague.
// The human picks it up, works it, and submits their output (text and/or
// uploaded files) back into the system — which is how human work re-enters
// the org's record alongside agent work.
//
// This complements (not replaces) the job-level waiting_on_human loop in
// routes/tasks.ts: that pauses a RUNNING agent job on a structured question;
// an assignment is a standalone piece of delegated work with its own
// lifecycle: open → in_progress → submitted → done (or declined).
//
// Hierarchy rule (enforced in routes/assignments.ts via users.isUpTheChain):
// a human never assigns work UP their own reporting chain — staff don't
// delegate to their boss.
//
// Persisted under .naxion/assignments.json; submitted files land in
// .naxion/assignment-files/<assignmentId>/.

import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.naxion");
const STORE_PATH = resolve(CONFIG_DIR, "assignments.json");
const FILES_DIR = resolve(CONFIG_DIR, "assignment-files");

const MAX_ASSIGNMENTS = 2000;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // matches the uploads route cap

export type AssignmentStatus = "open" | "in_progress" | "submitted" | "done" | "declined";

export type AssignmentSubmission = {
  at: string;
  byEmail: string;
  text?: string;
  files: { name: string; path: string; bytes: number }[];
};

export type Assignment = {
  id: string;
  title: string;
  details?: string;
  // Who does the work. Always a real directory email.
  assignedToEmail: string;
  // Who handed it over. Humans carry their email; agents carry their
  // persona/agent name with kind "agent".
  assignedByEmail?: string;
  assignedByName: string;
  assignedByKind: "human" | "agent";
  status: AssignmentStatus;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  // Agent job that spawned this, when an agent delegated it.
  fromJobId?: string;
  // Docs handed over WITH the work (the brief) — uploaded at creation by the
  // assigner. Submissions carry the assignee's files back the other way.
  attachments?: { name: string; path: string; bytes: number }[];
  submissions: AssignmentSubmission[];
};

function load(): Assignment[] {
  try {
    if (existsSync(STORE_PATH)) return JSON.parse(readFileSync(STORE_PATH, "utf8")) as Assignment[];
  } catch { /* corrupted store → start clean rather than crash the API */ }
  return [];
}
function save(list: Assignment[]): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(list.slice(-MAX_ASSIGNMENTS), null, 2), { encoding: "utf8", mode: 0o600 });
}

const normEmail = (e: string) => String(e ?? "").trim().toLowerCase();

// Decode base64 files and write them under assignment-files/<id>/<sub>/.
// basename() strips path components — a submitted name like "..\\..\\evil.exe"
// must never escape the assignment's own folder. Shared by the creation-time
// brief (sub="brief") and the assignee's submissions (sub="").
function writeFiles(assignmentId: string, sub: string, filesIn: { name: string; contentBase64: string }[]): { name: string; path: string; bytes: number }[] {
  const stored: { name: string; path: string; bytes: number }[] = [];
  for (const f of filesIn.slice(0, 10)) {
    const safeName = basename(String(f.name ?? "file")).replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";
    let buf: Buffer;
    try { buf = Buffer.from(String(f.contentBase64 ?? ""), "base64"); }
    catch { throw new Error(`file "${safeName}": base64 decode failed`); }
    if (buf.length === 0) throw new Error(`file "${safeName}" is empty`);
    if (buf.length > MAX_FILE_BYTES) throw new Error(`file "${safeName}" exceeds the 25 MB cap`);
    const dir = sub ? resolve(FILES_DIR, assignmentId, sub) : resolve(FILES_DIR, assignmentId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const full = resolve(dir, safeName);
    writeFileSync(full, buf, { mode: 0o600 });
    stored.push({ name: safeName, path: full, bytes: buf.length });
  }
  return stored;
}

export function listAssignments(filter?: { forEmail?: string; byEmail?: string; status?: AssignmentStatus }): Assignment[] {
  let out = load();
  if (filter?.forEmail) out = out.filter(a => normEmail(a.assignedToEmail) === normEmail(filter.forEmail!));
  if (filter?.byEmail) out = out.filter(a => a.assignedByEmail && normEmail(a.assignedByEmail) === normEmail(filter.byEmail!));
  if (filter?.status) out = out.filter(a => a.status === filter.status);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getAssignment(id: string): Assignment | undefined {
  return load().find(a => a.id === id);
}

export function createAssignment(input: {
  title: string;
  details?: string;
  assignedToEmail: string;
  assignedByEmail?: string;
  assignedByName: string;
  assignedByKind: "human" | "agent";
  dueAt?: string;
  fromJobId?: string;
  attachments?: { name: string; contentBase64: string }[];
}): Assignment {
  const title = String(input.title ?? "").trim();
  const assignedToEmail = normEmail(input.assignedToEmail);
  if (!title) throw new Error("title is required");
  if (!assignedToEmail || !assignedToEmail.includes("@")) throw new Error("assignedToEmail must be a valid email");
  const now = new Date().toISOString();
  const a: Assignment = {
    id: randomUUID(),
    title: title.slice(0, 200),
    details: input.details ? String(input.details).trim().slice(0, 8000) || undefined : undefined,
    assignedToEmail,
    assignedByEmail: input.assignedByEmail ? normEmail(input.assignedByEmail) : undefined,
    assignedByName: String(input.assignedByName ?? "unknown").trim().slice(0, 120) || "unknown",
    assignedByKind: input.assignedByKind === "agent" ? "agent" : "human",
    status: "open",
    dueAt: input.dueAt && !Number.isNaN(new Date(input.dueAt).getTime()) ? new Date(input.dueAt).toISOString() : undefined,
    createdAt: now,
    updatedAt: now,
    fromJobId: input.fromJobId ? String(input.fromJobId).slice(0, 64) : undefined,
    submissions: [],
  };
  if (Array.isArray(input.attachments) && input.attachments.length > 0) {
    a.attachments = writeFiles(a.id, "brief", input.attachments);
  }
  const list = load();
  list.push(a);
  save(list);
  return a;
}

// Lifecycle: open → in_progress → submitted → done; declined is terminal from
// open/in_progress. Submitting is its own path (addSubmission) — this handles
// the plain status moves.
const ALLOWED_MOVES: Record<AssignmentStatus, AssignmentStatus[]> = {
  open: ["in_progress", "declined", "done"],
  in_progress: ["open", "declined", "done", "submitted"],
  submitted: ["done", "in_progress"], // reopen = boss sends it back for rework
  done: [],
  declined: ["open"], // re-raise
};

export function setAssignmentStatus(id: string, next: AssignmentStatus): Assignment {
  const list = load();
  const a = list.find(x => x.id === id);
  if (!a) throw new Error("assignment not found");
  if (!ALLOWED_MOVES[a.status]?.includes(next)) {
    throw new Error(`can't move an assignment from "${a.status}" to "${next}"`);
  }
  a.status = next;
  a.updatedAt = new Date().toISOString();
  save(list);
  return a;
}

// The human turns in their work: text and/or base64 files. Files are written
// under .naxion/assignment-files/<id>/ with sanitized names; the stored
// record keeps name + absolute path + size so Reports/exports can pick them up.
export function addSubmission(id: string, input: {
  byEmail: string;
  text?: string;
  files?: { name: string; contentBase64: string }[];
}): Assignment {
  const list = load();
  const a = list.find(x => x.id === id);
  if (!a) throw new Error("assignment not found");
  if (a.status === "done" || a.status === "declined") throw new Error(`assignment is already ${a.status}`);

  const text = input.text ? String(input.text).trim().slice(0, 20000) : "";
  const filesIn = Array.isArray(input.files) ? input.files.slice(0, 10) : [];
  if (!text && filesIn.length === 0) throw new Error("submit some text or at least one file");

  const stored = writeFiles(a.id, "", filesIn);

  a.submissions.push({
    at: new Date().toISOString(),
    byEmail: normEmail(input.byEmail),
    text: text || undefined,
    files: stored,
  });
  a.status = "submitted";
  a.updatedAt = new Date().toISOString();
  save(list);
  return a;
}
