import { Router } from "express";
import { listAccounts, addAccount, updateAccount, rotateAccountToken, removeAccount } from "../lib/github-accounts.js";
import { logAudit } from "../lib/audit-log.js";

// GitHub multi-account credentials — personal/work/business PATs, each
// project (routes/projects.ts) picks one to watch its repos under. Secrets
// are encrypted at rest and never returned here — same posture as
// routes/connectors.ts.

export const githubAccountsRouter = Router();

githubAccountsRouter.get("/", (_req, res) => res.json({ accounts: listAccounts() }));

// Add an account. body: { label, token }
githubAccountsRouter.post("/", (req, res) => {
  try {
    const account = addAccount(req.body?.label, req.body?.token);
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "github-account.add", target: account.id, detail: account.label, result: "success" });
    res.json({ account });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

githubAccountsRouter.patch("/:id", (req, res) => {
  try {
    const account = updateAccount(String(req.params.id), req.body ?? {});
    if (!account) return res.status(404).json({ error: "account not found" });
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "github-account.update", target: String(req.params.id), detail: Object.keys(req.body ?? {}).join(","), result: "success" });
    res.json({ account });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

githubAccountsRouter.post("/:id/rotate", (req, res) => {
  try {
    const id = String(req.params.id);
    const account = rotateAccountToken(id, req.body?.token);
    if (!account) return res.status(404).json({ error: "account not found" });
    logAudit({ level: "info", actor: (req as any).user?.email ?? "system", action: "github-account.rotate", target: id, detail: "token rotated", result: "success" });
    res.json({ account });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

githubAccountsRouter.delete("/:id", (req, res) => {
  const id = String(req.params.id);
  const ok = removeAccount(id);
  if (!ok) return res.status(404).json({ error: "account not found" });
  logAudit({ level: "warn", actor: (req as any).user?.email ?? "system", action: "github-account.remove", target: id, detail: "removed", result: "success" });
  res.json({ ok: true });
});
