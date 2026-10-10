import { useEffect, useState, ChangeEvent } from "react";
import { GitBranch, Plus, Trash2, Pencil, KeyRound, Loader2, AlertTriangle, FolderGit2 } from "lucide-react";
import { api, type GithubAccount, type Project, type GithubEvent } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { Modal } from "../components/Modal";
import { Input, Textarea, Select } from "../components/forms";
import { relTime } from "../lib/time";

// GitHub multi-account credentials + projects — personal/work/business PATs,
// each project (a name + repos) picks one to watch under. The
// github-commit-watcher engine (server/src/lib/github-watcher.ts) polls
// these on a schedule; the events list below shows what it's found.

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
      <PageHeader
        title="GitHub Accounts"
        subtitle="Fine-grained PATs for your personal, work, and business GitHub accounts — each project below picks one, so different repos get watched under the right identity. Tokens are encrypted at rest."
        icon={<GitBranch size={28} />}
      />

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
    <Modal open onClose={onClose} title={existing ? "Rename account" : "Add GitHub account"} size="md">
      <div className="space-y-4">
        <Input
          label="Label"
          value={label}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
          placeholder="Personal / Work / Business"
          required
        />
        {!existing && (
          <Input
            label="Fine-grained PAT"
            type="password"
            value={token}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            required
          />
        )}
        {err && <div className="text-sm text-coral-400 flex items-center gap-2 p-3 rounded-lg bg-coral-500/5 border border-coral-500/20"><AlertTriangle size={16} /> {err}</div>}
      </div>
      <div className="flex justify-end pt-2">
        <Button onClick={submit} disabled={saving || !label || (!existing && !token)} className="px-6 py-2">{saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} {existing ? "Save" : "Add account"}</Button>
      </div>
    </Modal>
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
    <Modal open onClose={onClose} title={`Rotate token — ${account.label}`} size="sm">
      <div className="space-y-3">
        <Input
          label="New fine-grained PAT"
          type="password"
          value={token}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setToken(e.target.value)}
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
          required
        />
        {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
      </div>
      <div className="flex justify-end pt-2">
        <Button onClick={submit} disabled={saving || !token}>{saving ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Rotate</Button>
      </div>
    </Modal>
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
    <Modal open onClose={onClose} title={existing ? "Edit project" : "Add project"} size="lg">
      <div className="space-y-3">
        <Input
          label="Name"
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          placeholder="Client website"
          required
        />
        <Select
          label="Account"
          value={accountId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => setAccountId(e.target.value)}
          required
        >
          {accounts.length === 0 && <option value="">No accounts yet — add one first</option>}
          {accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </Select>
        <Textarea
          label='Repos (one "owner/repo" per line)'
          value={reposText}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setReposText(e.target.value)}
          rows={4}
          placeholder={"acme/website\nacme/api"}
          spellCheck={false}
          className="font-mono text-[12px]"
          required
        />
      </div>
      {err && <div className="text-[12px] text-coral-400 flex items-center gap-1.5"><AlertTriangle size={13} /> {err}</div>}
      <div className="flex justify-end pt-2">
        <Button onClick={submit} disabled={saving || !name || !accountId || !reposText.trim()}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {existing ? "Save" : "Add project"}</Button>
      </div>
    </Modal>
  );
}
