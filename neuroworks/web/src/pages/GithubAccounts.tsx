import { useEffect, useState } from "react";
import { GitBranch, Plus, Trash2, Pencil, KeyRound, Loader2, X, AlertTriangle, FolderGit2 } from "lucide-react";
import { api, type GithubAccount, type Project, type GithubEvent } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";

// GitHub multi-account credentials + projects — personal/work/business PATs,
// each project (a name + repos) picks one to watch under. The
// github-commit-watcher engine (server/src/lib/github-watcher.ts) polls
// these on a schedule; the events list below shows what it's found.

function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60 placeholder:text-cream-300/30";

export function GithubAccounts() {
  const [accounts, setAccounts] = useState<GithubAccount[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [events, setEvents] = useState<GithubEvent[]>([]);
  const [editingAccount, setEditingAccount] = useState<GithubAccount | "new" | null>(null);
  const [rotating, setRotating] = useState<GithubAccount | null>(null);
  const [editingProject, setEditingProject] = useState<Project | "new" | null>(null);

  async function refresh() {
    try { const r = await api.listGithubAccounts(); setAccounts(r.accounts); } catch {}
    try { const r = await api.listProjects(); setProjects(r.projects); } catch {}
    try { const r = await api.githubEvents(); setEvents(r.events); } catch {}
  }
  useEffect(() => { void refresh(); }, []);

  async function removeAccount(id: string, label: string) {
    if (!confirm(`Remove GitHub account "${label}"? Any project using it will stop being watched.`)) return;
    try { await api.removeGithubAccount(id); showToast("Account removed", "success"); refresh(); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  async function removeProject(id: string, name: string) {
    if (!confirm(`Remove project "${name}"?`)) return;
    try { await api.removeProject(id); showToast("Project removed", "success"); refresh(); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  const accountLabel = (id: string) => accounts.find(a => a.id === id)?.label ?? "(unknown account)";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><GitBranch size={24} /> GitHub Accounts</h1>
        <p className="text-sm text-cream-300/70 mt-1">
          Fine-grained PATs for your personal, work, and business GitHub accounts — each project below picks one, so
          different repos get watched under the right identity. Tokens are <span className="text-cream-200">encrypted at rest</span>.
        </p>
      </div>

      <Card title="Accounts" action={<Button onClick={() => setEditingAccount("new")}><Plus size={14} /> Add account</Button>}>
        {accounts.length === 0 ? (
          <div className="text-center py-4 text-cream-300/60 text-sm">No accounts yet — add one to start watching repos.</div>
        ) : (
          <div className="space-y-2">
            {accounts.map(a => (
              <div key={a.id} className="flex items-center gap-3 py-2 border-b border-ink-800 last:border-0">
                <div className="w-9 h-9 rounded-lg bg-violet-500/15 grid place-items-center text-violet-300 text-xs font-semibold shrink-0">{a.label.slice(0, 2).toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-cream-100">{a.label}</div>
                  <div className="text-[11px] text-cream-300/50">
                    {a.tokenSet ? "token set" : "no token"}{a.lastRotatedAt ? ` · rotated ${relTime(a.lastRotatedAt)}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" onClick={() => setRotating(a)} className="text-cream-300/50 hover:text-cream-100 p-1.5" title="Rotate token"><KeyRound size={15} /></button>
                  <button type="button" onClick={() => setEditingAccount(a)} className="text-cream-300/50 hover:text-cream-100 p-1.5" title="Rename"><Pencil size={15} /></button>
                  <button type="button" onClick={() => removeAccount(a.id, a.label)} className="text-cream-300/50 hover:text-coral-400 p-1.5" title="Remove"><Trash2 size={15} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Projects" action={<Button onClick={() => setEditingProject("new")}><Plus size={14} /> Add project</Button>}>
        {projects.length === 0 ? (
          <div className="text-center py-4 text-cream-300/60 text-sm">No projects yet — group repos under an account to start watching commits.</div>
        ) : (
          <div className="space-y-2">
            {projects.map(p => (
              <div key={p.id} className="flex items-start gap-3 py-2 border-b border-ink-800 last:border-0">
                <FolderGit2 size={16} className="text-violet-400 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-cream-100 flex items-center gap-2 flex-wrap">
                    {p.name}
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/70">{accountLabel(p.accountId)}</span>
                  </div>
                  <div className="text-[11px] text-cream-300/50 mt-0.5 space-y-0.5">
                    {p.repos.map(repo => (
                      <div key={repo} className="font-mono">{repo}{p.lastSeenShas[repo] ? ` · ${p.lastSeenShas[repo]}` : ""}</div>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" onClick={() => setEditingProject(p)} className="text-cream-300/50 hover:text-cream-100 p-1.5" title="Edit"><Pencil size={15} /></button>
                  <button type="button" onClick={() => removeProject(p.id, p.name)} className="text-cream-300/50 hover:text-coral-400 p-1.5" title="Remove"><Trash2 size={15} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {events.length > 0 && (
        <Card title="Recent commits">
          <div className="space-y-1.5">
            {events.slice(0, 20).map((e, i) => (
              <div key={`${e.repo}-${e.sha}-${i}`} className="flex items-center justify-between text-xs text-cream-300/70 gap-2">
                <span className="truncate"><span className="font-mono text-cream-300/50">{e.repo}</span> · {e.message}</span>
                <span className="shrink-0 text-cream-300/40">{relTime(e.at)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {editingAccount && (
        <AccountModal existing={editingAccount === "new" ? null : editingAccount} onClose={() => setEditingAccount(null)} onSaved={() => { setEditingAccount(null); refresh(); }} />
      )}
      {rotating && <RotateModal account={rotating} onClose={() => setRotating(null)} onSaved={() => { setRotating(null); refresh(); }} />}
      {editingProject && (
        <ProjectModal existing={editingProject === "new" ? null : editingProject} accounts={accounts} onClose={() => setEditingProject(null)} onSaved={() => { setEditingProject(null); refresh(); }} />
      )}
    </div>
  );
}

function AccountModal({ existing, onClose, onSaved }: { existing: GithubAccount | null; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setSaving(true);
    try {
      if (existing) await api.updateGithubAccount(existing.id, { label });
      else await api.addGithubAccount(label, token);
      showToast(existing ? "Account updated" : "Account added", "success");
      onSaved();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-sm bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">{existing ? "Rename account" : "Add GitHub account"}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Label <span className="text-coral-400">*</span></label>
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Personal / Work / Business" className={FIELD} />
          </div>
          {!existing && (
            <div>
              <label className="block text-[11px] text-cream-300/70 mb-1">Fine-grained PAT <span className="text-coral-400">*</span></label>
              <input type="password" value={token} onChange={e => setToken(e.target.value)} className={`${FIELD} font-mono`} autoComplete="off" spellCheck={false} />
            </div>
          )}
        </div>
        {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
        <div className="flex justify-end pt-1">
          <Button onClick={submit} disabled={saving || !label || (!existing && !token)}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {existing ? "Save" : "Add account"}</Button>
        </div>
      </div>
    </div>
  );
}

function RotateModal({ account, onClose, onSaved }: { account: GithubAccount; onClose: () => void; onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    setSaving(true);
    try {
      await api.rotateGithubAccount(account.id, token);
      showToast("Token rotated", "success");
      onSaved();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-sm bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">Rotate token — {account.label}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">New fine-grained PAT <span className="text-coral-400">*</span></label>
          <input type="password" value={token} onChange={e => setToken(e.target.value)} className={`${FIELD} font-mono`} autoComplete="off" spellCheck={false} />
        </div>
        {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
        <div className="flex justify-end pt-1">
          <Button onClick={submit} disabled={saving || !token}>{saving ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Rotate</Button>
        </div>
      </div>
    </div>
  );
}

function ProjectModal({ existing, accounts, onClose, onSaved }: { existing: Project | null; accounts: GithubAccount[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(existing?.name ?? "");
  const [accountId, setAccountId] = useState(existing?.accountId ?? accounts[0]?.id ?? "");
  const [reposText, setReposText] = useState(existing?.repos.join("\n") ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setErr(null);
    const repos = reposText.split("\n").map(r => r.trim()).filter(Boolean);
    setSaving(true);
    try {
      if (existing) await api.updateProject(existing.id, { name, accountId, repos });
      else await api.addProject({ name, accountId, repos });
      showToast(existing ? "Project updated" : "Project added", "success");
      onSaved();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-lg bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">{existing ? "Edit project" : "Add project"}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Name <span className="text-coral-400">*</span></label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Client website" className={FIELD} />
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Account <span className="text-coral-400">*</span></label>
            <select value={accountId} onChange={e => setAccountId(e.target.value)} className={FIELD}>
              {accounts.length === 0 && <option value="">No accounts yet — add one first</option>}
              {accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Repos (one "owner/repo" per line) <span className="text-coral-400">*</span></label>
            <textarea value={reposText} onChange={e => setReposText(e.target.value)} rows={4} placeholder={"acme/website\nacme/api"} className={`${FIELD} font-mono text-[12px]`} spellCheck={false} />
          </div>
        </div>
        {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
        <div className="flex justify-end pt-1">
          <Button onClick={submit} disabled={saving || !name || !accountId || !reposText.trim()}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {existing ? "Save" : "Add project"}</Button>
        </div>
      </div>
    </div>
  );
}
