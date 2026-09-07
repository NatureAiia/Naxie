import { Router } from "express";
import { listProjects, createProject, updateProject, deleteProject } from "../lib/projects.js";
import { listGithubEvents } from "../lib/github-watcher.js";
import { logAudit } from "../lib/audit-log.js";

// Projects — name + repos + which GithubAccount watches them. The
// github-commit-watcher engine (github-watcher.ts) polls these on a
// schedule; GET /events surfaces what it's found.

export const projectsRouter = Router();

projectsRouter.get("/events", (_req, res) => res.json({ events: listGithubEvents() }));

projectsRouter.get("/", (_req, res) => res.json({ projects: listProjects() }));

// Add a project. body: { name, accountId, repos: string[] }
projectsRouter.post("/", (req, res) => {
  try {
    const project = createProject(req.body ?? {});
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "project.add", target: project.id, detail: project.name, result: "success" });
    res.json({ project });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

projectsRouter.patch("/:id", (req, res) => {
  try {
    const project = updateProject(String(req.params.id), req.body ?? {});
    if (!project) return res.status(404).json({ error: "project not found" });
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "project.update", target: String(req.params.id), detail: Object.keys(req.body ?? {}).join(","), result: "success" });
    res.json({ project });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

projectsRouter.delete("/:id", (req, res) => {
  const id = String(req.params.id);
  const ok = deleteProject(id);
  if (!ok) return res.status(404).json({ error: "project not found" });
  logAudit({ level: "warn", actor: (req as any).user?.email ?? "system", action: "project.remove", target: id, detail: "removed", result: "success" });
  res.json({ ok: true });
});
