// Assignments API — human-in-the-loop work behind the My Work page.
//
// GET    /api/assignments            → mine (assigned to me) + delegated (by me);
//                                      machine/admin callers see everything.
// POST   /api/assignments            → create. HIERARCHY GATE: a signed-in human
//                                      can never assign work UP their own
//                                      reporting chain (staff → boss = 403).
//                                      Token-less callers are neuros/machine
//                                      context and pass (a neuro may brief anyone).
// POST   /api/assignments/:id/submit → assignee turns in text and/or files.
// POST   /api/assignments/:id/status → lifecycle moves (start / done / decline /
//                                      reopen). Closing out (done) belongs to the
//                                      assigner or an admin, not the assignee.

import { Router } from "express";
import { listAssignments, createAssignment, getAssignment, setAssignmentStatus, addSubmission, type AssignmentStatus } from "../lib/assignments.js";
import { getUserByEmail, isUpTheChain, directory } from "../lib/users.js";
import { callerOf, callerLayer } from "../lib/access.js";

export const assignmentsRouter = Router();

const normEmail = (e: string) => String(e ?? "").trim().toLowerCase();

// Slim directory for the assign-work picker. /api/users is admin-gated, but
// staff still need to SEE colleagues to hand work over — name/email/dept only,
// no salaries, no login telemetry. eligible=false marks people up the caller's
// own chain so the UI can grey them out (the POST gate still enforces it).
assignmentsRouter.get("/directory", (req, res) => {
  const caller = callerOf(req);
  const people = directory()
    .filter(u => u.status === "active" || u.status === "invited")
    .map(u => ({
      name: u.name, email: u.email, title: u.title, department: u.department, workMode: u.workMode,
      eligible: !caller || !isUpTheChain(caller.email, u.email),
      isSelf: caller ? normEmail(u.email) === normEmail(caller.email) : false,
    }));
  res.json({ people });
});

assignmentsRouter.get("/", (req, res) => {
  const caller = callerOf(req);
  const layer = callerLayer(req);
  // Admins + machine context get the whole board; staff get their own slices.
  if (layer === null || layer === "superadmin" || layer === "admin") {
    const all = listAssignments();
    return res.json({
      mine: caller ? all.filter(a => normEmail(a.assignedToEmail) === normEmail(caller.email)) : [],
      delegated: caller ? all.filter(a => a.assignedByEmail && normEmail(a.assignedByEmail) === normEmail(caller.email)) : [],
      all,
    });
  }
  res.json({
    mine: listAssignments({ forEmail: caller!.email }),
    delegated: listAssignments({ byEmail: caller!.email }),
  });
});

assignmentsRouter.post("/", (req, res) => {
  const b = req.body ?? {};
  const caller = callerOf(req);
  const toEmail = normEmail(b.assignedToEmail ?? b.to ?? "");

  // Assignee must exist in the directory — work can't be handed to a stranger.
  const target = getUserByEmail(toEmail);
  if (!target) return res.status(400).json({ error: `no user "${toEmail}" in the directory` });
  if (target.status === "disabled") return res.status(400).json({ error: "that account is disabled" });

  if (caller) {
    // Hierarchy gate: no delegating up your own reporting chain. Applies to
    // every signed-in human, whatever their layer — a boss assigning DOWN is
    // fine; anyone assigning to their own boss (or boss's boss…) is not.
    if (isUpTheChain(caller.email, toEmail)) {
      return res.status(403).json({
        error: "you can't assign work up your own reporting chain — take it to them directly",
        assignee: toEmail,
      });
    }
  }

  try {
    const a = createAssignment({
      title: b.title,
      details: b.details,
      assignedToEmail: toEmail,
      assignedByEmail: caller?.email ?? (b.assignedByEmail ? normEmail(b.assignedByEmail) : undefined),
      assignedByName: caller?.name ?? String(b.assignedByName ?? "Neuro"),
      assignedByKind: caller ? "human" : (b.assignedByKind === "human" ? "human" : "neuro"),
      dueAt: b.dueAt,
      fromJobId: b.fromJobId,
      attachments: b.files,
    });
    res.json({ assignment: a });

    // Delegation is an org-level action — record who handed what to whom.
    void import("../lib/audit-log.js").then(({ logAudit }) => logAudit({
      level: "info", actor: caller?.email ?? a.assignedByName, action: "assignment.create",
      target: a.assignedToEmail, detail: a.title.slice(0, 120), result: "success",
    })).catch(() => {});

    // Notify the assignee by email — best-effort AFTER the response so a
    // mail outage never blocks the assignment itself. Substance per the org
    // email rule: what, from whom, due when, where to act.
    void (async () => {
      try {
        const { sendEmail, emailConfigured } = await import("../lib/email.js");
        if (!emailConfigured()) return;
        const lines = [
          `**${a.assignedByName}** (${a.assignedByKind === "neuro" ? "neuro agent" : "colleague"}) handed you a new assignment:`,
          "",
          `**${a.title}**`,
          ...(a.details ? ["", a.details] : []),
          ...(a.dueAt ? ["", `Due: ${new Date(a.dueAt).toDateString()}`] : []),
          ...((a.attachments ?? []).length ? ["", `Attached: ${(a.attachments ?? []).map(f => f.name).join(", ")}`] : []),
          "",
          `Open **My Work** in NeuroWorks to start it, upload your work, or decline: http://127.0.0.1:${(await import("../config.js")).config.port}/my-work`,
        ];
        await sendEmail({
          to: a.assignedToEmail,
          // Newlines stripped — a multi-line title must never reach a mail
          // subject (header-injection hygiene, even through JSON transports).
          subject: `New assignment: ${a.title.replace(/[\r\n]+/g, " ")}`,
          body: lines.join("\n"),
        });
      } catch { /* notification is best-effort */ }
    })();
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

assignmentsRouter.post("/:id/submit", (req, res) => {
  const id = String(req.params.id);
  const caller = callerOf(req);
  const a = getAssignment(id);
  if (!a) return res.status(404).json({ error: "assignment not found" });
  // Only the assignee submits their own work (machine context passes — the
  // operator console and agents act on the org's behalf).
  if (caller && normEmail(caller.email) !== normEmail(a.assignedToEmail)) {
    return res.status(403).json({ error: "only the assignee can submit work on this assignment" });
  }
  try {
    const updated = addSubmission(id, {
      byEmail: caller?.email ?? a.assignedToEmail,
      text: req.body?.text,
      files: req.body?.files,
    });
    res.json({ assignment: updated });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

assignmentsRouter.post("/:id/status", (req, res) => {
  const id = String(req.params.id);
  const next = String(req.body?.status ?? "") as AssignmentStatus;
  if (!["open", "in_progress", "submitted", "done", "declined"].includes(next)) {
    return res.status(400).json({ error: "status must be one of open | in_progress | submitted | done | declined" });
  }
  const caller = callerOf(req);
  const layer = callerLayer(req);
  const a = getAssignment(id);
  if (!a) return res.status(404).json({ error: "assignment not found" });

  if (caller && layer === "staff") {
    const isAssignee = normEmail(caller.email) === normEmail(a.assignedToEmail);
    const isAssigner = a.assignedByEmail && normEmail(caller.email) === normEmail(a.assignedByEmail);
    if (!isAssignee && !isAssigner) return res.status(403).json({ error: "not your assignment" });
    // Sign-off stays with whoever handed the work over (or an admin) — the
    // assignee can start/decline but never mark their own work done.
    if (next === "done" && !isAssigner) {
      return res.status(403).json({ error: "only the person who assigned this (or an admin) can mark it done" });
    }
  }

  try {
    res.json({ assignment: setAssignmentStatus(id, next) });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// GET /api/assignments/:id/files/:kind/:name — download an attached brief
// (kind=brief) or a submitted file (kind=submission). Access: the assignee,
// the assigner, admin+, or machine context. The stored absolute path is
// resolved from the assignment record and re-confirmed to sit inside this
// assignment's own file directory, so a crafted :name can't traverse out.
assignmentsRouter.get("/:id/files/:kind/:name", async (req, res) => {
  const id = String(req.params.id);
  const kind = String(req.params.kind);
  const wantName = String(req.params.name);
  const a = getAssignment(id);
  if (!a) return res.status(404).json({ error: "assignment not found" });

  const caller = callerOf(req);
  if (caller) {
    const isParty = normEmail(caller.email) === normEmail(a.assignedToEmail)
      || (a.assignedByEmail && normEmail(caller.email) === normEmail(a.assignedByEmail));
    const layer = callerLayer(req);
    if (!isParty && layer !== "admin" && layer !== "superadmin") {
      return res.status(403).json({ error: "not your assignment" });
    }
  }

  // Look the file up in the RECORD (never trust the raw :name for the path) —
  // match by basename across the brief attachments or every submission.
  const pool = kind === "brief"
    ? (a.attachments ?? [])
    : a.submissions.flatMap(s => s.files);
  const { basename, resolve } = await import("node:path");
  const { existsSync, createReadStream } = await import("node:fs");
  const rec = pool.find(f => f.name === wantName || basename(f.path) === wantName);
  if (!rec) return res.status(404).json({ error: "file not found on this assignment" });

  // Defence in depth: the stored path must resolve inside the assignment-files
  // store AND carry this assignment's id before we stream it.
  const full = resolve(rec.path);
  if (!/[\\/]assignment-files[\\/]/.test(full) || !full.includes(id)) {
    return res.status(400).json({ error: "refusing to serve a file outside the assignment store" });
  }
  if (!existsSync(full)) return res.status(404).json({ error: "file missing on disk" });

  res.setHeader("Content-Disposition", `attachment; filename="${rec.name.replace(/[\r\n"]/g, "_")}"`);
  res.setHeader("Content-Type", "application/octet-stream");
  createReadStream(full).on("error", () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
});
