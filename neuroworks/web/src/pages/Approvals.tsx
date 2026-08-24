import { useEffect, useState } from "react";
import { api, type OrgTask } from "../lib/api";
import { Card } from "../components/Card";
import { useLoadMore, LoadMoreButton } from "../components/LoadMore";

// Tools that carry a real external side effect — their args are shown in full
// (not hidden behind "raw inputs") and made editable so an admin can correct
// the SQL / recipient / body before approving. Keys listed here render as
// editable fields; everything else shows read-only.
const SENSITIVE_TOOLS = new Set(["db.query", "connector.call", "email.send"]);
const EDITABLE_ARGS: Record<string, string[]> = {
  "db.query": ["sql", "query"],
  "email.send": ["to", "subject", "body"],
  "connector.call": ["connector", "id", "path", "endpoint"],
};

export function Approvals() {
  const [jobs, setJobs] = useState<any[]>([]);
  const jobList = useLoadMore(jobs);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  // Per-job edited plan (deep copy of j.plan), created lazily on first edit.
  // Keyed by job id so the 3s poll refresh doesn't clobber in-progress edits.
  const [edits, setEdits] = useState<Record<string, any>>({});
  async function load() {
    try { const r = await api.listJobs(); setJobs(r.jobs.filter(j => j.status === "awaiting-approval")); }
    catch {}
  }
  useEffect(() => { load(); const i = setInterval(load, 3000); return () => clearInterval(i); }, []);

  // Naxie's OrgTask approval inbox (docs/naxie-architecture.md §5/§8.5) —
  // separate data shape from Job (a plain-language actionDescription, never a
  // diff/plan), so it gets its own small section rather than being forced
  // into the Job-plan rendering above.
  const [orgTasks, setOrgTasks] = useState<OrgTask[]>([]);
  const [orgBusy, setOrgBusy] = useState<string | null>(null);
  async function loadOrgTasks() {
    try { const r = await api.orgTasks({ status: "waiting-on-approval" }); setOrgTasks(r.tasks); }
    catch { /* org-tasks route is admin-gated — a non-admin session just sees none */ }
  }
  useEffect(() => { loadOrgTasks(); const i = setInterval(loadOrgTasks, 3000); return () => clearInterval(i); }, []);
  async function resolveOrgTask(id: string, approved: boolean) {
    setOrgBusy(id); setErr("");
    try { await api.resolveOrgTaskApproval(id, approved); await loadOrgTasks(); }
    catch (e: any) { setErr(e.message); }
    finally { setOrgBusy(null); }
  }

  function setArg(job: any, stepIdx: number, key: string, value: string) {
    setEdits(prev => {
      const base = prev[job.id] ?? structuredClone(job.plan);
      if (!base?.steps?.[stepIdx]) return prev;
      base.steps[stepIdx].args = { ...(base.steps[stepIdx].args ?? {}), [key]: value };
      return { ...prev, [job.id]: base };
    });
  }
  const effectivePlan = (job: any) => edits[job.id] ?? job.plan;

  async function approve(id: string) {
    setBusy(id); setErr("");
    try {
      // Send the edited plan only when the operator actually changed something.
      await api.approveJob(id, edits[id]);
      setEdits(prev => { const n = { ...prev }; delete n[id]; return n; });
      await load();
    }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  }
  async function reject(id: string) {
    setBusy(id); setErr("");
    try { await api.rejectJob(id); await load(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-cream-50">Approvals</h1>
        <p className="text-sm text-cream-300/70 mt-1">Tasks that write to GitHub or your vault wait here for your sign-off.</p>
      </div>

      {orgTasks.length > 0 && (
        <ul className="space-y-2">
          {orgTasks.map(t => (
            <li key={t.id}>
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-cream-50">{t.title}</div>
                    <div className="text-xs text-cream-300/60 mt-0.5">{new Date(t.pendingApproval?.requestedAt ?? t.updatedAt).toLocaleString()}</div>
                    <div className="mt-3 rounded-md border border-violet-500/30 bg-violet-500/5 p-3 text-xs">
                      <div className="text-[10px] uppercase tracking-wider text-violet-300/70 mb-1.5">Naxie would like to:</div>
                      <div className="text-cream-100">{t.pendingApproval?.actionDescription ?? t.detail}</div>
                      {t.pendingApproval?.diff && (
                        <pre className="mt-2 rounded-md border border-ink-700 bg-ink-950 p-2 text-[11px] font-mono overflow-x-auto whitespace-pre">
                          {t.pendingApproval.diff.split("\n").map((line, i) => {
                            const cls = line.startsWith("+") && !line.startsWith("+++")
                              ? "text-leaf-300 bg-leaf-500/5"
                              : line.startsWith("-") && !line.startsWith("---")
                              ? "text-flame-300 bg-flame-500/5"
                              : "text-cream-300/70";
                            return <div key={i} className={`px-1 ${cls}`}>{line || " "}</div>;
                          })}
                        </pre>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => resolveOrgTask(t.id, false)} disabled={orgBusy === t.id} className="px-3 py-1.5 rounded-md text-xs text-cream-300 hover:text-cream-100 border border-ink-700 disabled:opacity-50">Reject</button>
                    <button onClick={() => resolveOrgTask(t.id, true)} disabled={orgBusy === t.id} className="px-3 py-1.5 rounded-md text-xs bg-leaf-500 hover:bg-leaf-400 text-ink-950 font-medium disabled:opacity-50">{orgBusy === t.id ? "…" : "Approve"}</button>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {jobs.length === 0 && orgTasks.length === 0 ? (
        <Card>
          <div className="text-center py-12">
            <div className="text-cream-300/40 text-4xl mb-3">✓</div>
            <div className="text-sm text-cream-200">Nothing waiting for approval.</div>
            <div className="text-xs text-cream-300/50 mt-1">Tasks with destructive scope (publishing folders, writing to vault) will queue here.</div>
          </div>
        </Card>
      ) : jobs.length > 0 && (
        <ul className="space-y-2">
          {jobList.visible.map(j => {
            const plan = effectivePlan(j);
            const planSteps = plan?.steps as { tool: string; label?: string; rationale?: string; args?: Record<string, any> }[] | undefined;
            const hasPlan = Array.isArray(planSteps) && planSteps.length > 0;
            const edited = !!edits[j.id];
            const effects = describeEffects(j);
            return (
              <li key={j.id}>
                <Card>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-cream-50">{j.title ?? j.kind}</div>
                      <div className="text-xs text-cream-300/60 mt-0.5">{new Date(j.startedAt).toLocaleString()}</div>
                      {hasPlan ? (
                        <div className="mt-3 rounded-md border border-violet-500/30 bg-violet-500/5 p-3 text-xs">
                          <div className="text-[10px] uppercase tracking-wider text-violet-300/70 mb-2">Proposed plan — {planSteps!.length} step{planSteps!.length === 1 ? "" : "s"}</div>
                          <ol className="space-y-2">
                            {planSteps!.map((s, i) => {
                              const sensitive = SENSITIVE_TOOLS.has(s.tool);
                              const editableKeys = EDITABLE_ARGS[s.tool] ?? [];
                              const args = s.args ?? {};
                              return (
                                <li key={i} className="flex gap-2">
                                  <span className="text-violet-400/70 font-mono shrink-0">{i + 1}.</span>
                                  <span className="min-w-0 flex-1">
                                    <span className="font-mono text-violet-200">{s.tool}</span>
                                    {sensitive && <span className="ml-1.5 text-[9px] uppercase tracking-wider px-1 py-0.5 rounded bg-flame-500/15 text-flame-300 border border-flame-500/30">needs approval</span>}
                                    {s.label && s.label !== s.tool && <span className="text-cream-200"> — {s.label}</span>}
                                    {s.rationale && <span className="block text-cream-300/50 text-[11px]">{s.rationale}</span>}
                                    {/* Full args — for sensitive steps the reviewer MUST see (and can
                                        correct) the actual SQL / recipient / body before approving. */}
                                    {Object.keys(args).length > 0 && (
                                      <div className="mt-1.5 space-y-1">
                                        {Object.entries(args).map(([k, v]) => {
                                          const isEditable = sensitive && editableKeys.includes(k);
                                          const val = typeof v === "string" ? v : JSON.stringify(v);
                                          const isLong = k === "sql" || k === "query" || k === "body" || val.length > 60;
                                          if (isEditable) {
                                            return (
                                              <label key={k} className="block">
                                                <span className="text-[10px] text-flame-300/80 font-mono">{k}</span>
                                                {isLong ? (
                                                  <textarea value={val} onChange={e => setArg(j, i, k, e.target.value)} rows={k === "sql" || k === "body" ? 3 : 1}
                                                    className="w-full mt-0.5 bg-ink-950 border border-flame-500/30 focus:border-flame-500/60 rounded px-2 py-1 text-[11px] font-mono text-cream-100 resize-y focus:outline-none" />
                                                ) : (
                                                  <input value={val} onChange={e => setArg(j, i, k, e.target.value)}
                                                    className="w-full mt-0.5 bg-ink-950 border border-flame-500/30 focus:border-flame-500/60 rounded px-2 py-1 text-[11px] font-mono text-cream-100 focus:outline-none" />
                                                )}
                                              </label>
                                            );
                                          }
                                          return (
                                            <div key={k} className="text-[11px] font-mono">
                                              <span className="text-cream-300/50">{k}:</span> <span className="text-cream-200 break-all">{val.length > 200 ? val.slice(0, 200) + "…" : val}</span>
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </span>
                                </li>
                              );
                            })}
                          </ol>
                          <div className="text-[10px] text-cream-300/40 mt-2 pt-2 border-t border-violet-500/15">
                            {edited ? "You edited this plan — approving runs your edited version." : "Approving runs these steps as-is, then synthesises the answer."}
                          </div>
                        </div>
                      ) : (
                      <div className={`mt-3 rounded-md border p-3 text-xs ${effects.severity === "high" ? "bg-flame-500/5 border-flame-500/30" : "bg-ink-950 border-ink-800"}`}>
                        <div className="text-[10px] uppercase tracking-wider text-cream-300/50 mb-1.5">If you approve, Neuro will:</div>
                        <ul className="space-y-1 text-cream-200">
                          {effects.bullets.map((b, i) => <li key={i}>· {b}</li>)}
                        </ul>
                        {effects.severity === "high" && (
                          <div className="text-[10px] text-flame-400 mt-2 pt-2 border-t border-flame-500/20">⚠ This action is hard to reverse — double-check the inputs.</div>
                        )}
                      </div>
                      )}
                      {j.inputs && Object.keys(j.inputs).length > 0 && (
                        <details className="mt-2">
                          <summary className="text-[11px] text-cream-300/60 cursor-pointer hover:text-cream-100">Raw inputs</summary>
                          <div className="mt-1.5 grid grid-cols-2 gap-1 text-[11px] font-mono">
                            {Object.entries(j.inputs).map(([k, v]) => (
                              <div key={k}><span className="text-cream-300/50">{k}:</span> <span className="text-cream-200 break-all">{String(v)}</span></div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => reject(j.id)} disabled={busy === j.id} className="px-3 py-1.5 rounded-md text-xs text-cream-300 hover:text-cream-100 border border-ink-700 disabled:opacity-50">Reject</button>
                      <button onClick={() => approve(j.id)} disabled={busy === j.id} className="px-3 py-1.5 rounded-md text-xs bg-leaf-500 hover:bg-leaf-400 text-ink-950 font-medium disabled:opacity-50">{busy === j.id ? "…" : "Approve"}</button>
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
          <LoadMoreButton state={jobList} noun="approvals" />
        </ul>
      )}

      {err && <div className="text-xs text-coral-400">{err}</div>}
    </div>
  );
}

// Plain-English preview of what an awaiting-approval job will actually do.
// Severity gates the warning band: "high" for hard-to-reverse external writes,
// "medium" for vault-only writes, "low" for everything else.
function describeEffects(job: any): { bullets: string[]; severity: "high" | "medium" | "low" } {
  const inputs = job.inputs ?? {};
  const tpl = job.template as string | undefined;
  switch (tpl) {
    case "paynow-payment": {
      const amount = Number(inputs.amount ?? 0);
      return {
        severity: "high",
        bullets: [
          `Create a REAL Paynow payment for ${Number.isFinite(amount) ? amount.toFixed(2) : String(inputs.amount)} — ${String(inputs.description ?? "")}`,
          `Issue a pay link the client can settle via EcoCash, OneMoney, card, or bank`,
          inputs.email ? `Payer email: ${String(inputs.email)}` : `No payer email — Paynow will use the merchant default`,
          `Money moves once the client pays — approve only if the amount and description are right`,
        ],
      };
    }
    case "publish-folder": {
      const path = String(inputs.path ?? "(missing path)");
      const isPublic = Boolean(inputs.public);
      const repoName = String(inputs.name ?? "").trim() || "(auto-named from folder)";
      return {
        severity: "high",
        bullets: [
          `Create a ${isPublic ? "public" : "private"} GitHub repo named ${repoName}`,
          `Initialize git in ${path} (if not already a repo)`,
          `Push the folder contents to the new remote`,
        ],
      };
    }
    case "general-task": {
      const task = String(inputs.task ?? "").slice(0, 200);
      return {
        severity: "medium",
        bullets: [
          `Plan tool steps for: "${task}"`,
          `Execute the plan against the vault, GitHub, and local LLM`,
          `Save the successful plan as a reusable template`,
        ],
      };
    }
    case "add-note": {
      return {
        severity: "low",
        bullets: [
          `Write a new note to 0-Inbox/ titled "${String(inputs.title ?? "")}"`,
          `Commit and push the vault repo`,
        ],
      };
    }
    case "summarize-repo": {
      return {
        severity: "low",
        bullets: [
          `Fetch ${String(inputs.repo ?? "")} from GitHub and summarize via Ollama`,
          `Write the summary to _clawbot/summaries/ in the vault and push`,
        ],
      };
    }
    case "run-digest": {
      return {
        severity: "low",
        bullets: [
          `Trigger the daily-digest GitHub Actions workflow (lookback ${String(inputs.lookbackDays ?? 7)}d)`,
        ],
      };
    }
    case "sync-downloads": {
      return {
        severity: "medium",
        bullets: [
          `Mirror new files from ${String(inputs.source || "~/Downloads")} into the vault`,
          `Source files are not moved or deleted — only copies are made`,
          `Commit and push the vault`,
        ],
      };
    }
    default: {
      return {
        severity: "medium",
        bullets: [
          `Run template "${tpl ?? "unknown"}" with the inputs shown below`,
        ],
      };
    }
  }
}
