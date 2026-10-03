import { useEffect, useState } from "react";
import { Link2, Plus, Trash2, ExternalLink } from "lucide-react";
import { api, type CompanyLink } from "../../lib/api";
import { Card, Button, showToast } from "../Card";

// Company reference links — ported from the earlier prototype'
// CompanyLinksCard.tsx. A named URL an agent can resolve by name (company.links
// primitive) and fetch for current content, instead of the operator having to
// paste it into every task. Lives alongside LibraryConnections (DB sources) —
// both are "named external source" registries.
export function CompanyLinksPanel() {
  const [links, setLinks] = useState<CompanyLink[]>([]);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [department, setDepartment] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try { const r = await api.listCompanyLinks(); setLinks(r.links); } catch { /* ignore */ }
  }
  useEffect(() => { void refresh(); }, []);

  async function submit() {
    if (!label.trim() || !url.trim()) return;
    setBusy(true);
    try {
      await api.addCompanyLink({ label: label.trim(), url: url.trim(), description: description.trim() || undefined, department: department.trim() || undefined });
      setLabel(""); setUrl(""); setDescription(""); setDepartment(""); setAdding(false);
      void refresh();
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this company link? Agents will no longer be able to resolve it by name.")) return;
    try { await api.removeCompanyLink(id); void refresh(); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  return (
    <Card
      title={<span className="flex items-center gap-2"><Link2 size={18} /> Company links</span>}
      action={<Button onClick={() => setAdding(a => !a)} variant="subtle"><Plus size={14} /> {adding ? "Cancel" : "Add"}</Button>}
    >
      <p className="text-xs text-cream-300/60 mb-3">
        Named URLs an agent can resolve by name (e.g. "check the pricing page") and fetch for current content — the
        <span className="font-mono mx-1">company.links</span>primitive. Only public https URLs can be registered.
      </p>

      {adding && (
        <div className="space-y-2 mb-4 bg-ink-950 border border-ink-800 rounded-lg p-3">
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label (e.g. Pricing page)" className="w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-1.5 text-sm text-cream-100" />
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/pricing" className="w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-1.5 text-sm text-cream-100" />
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description (optional) — why it exists" className="w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-1.5 text-sm text-cream-100" />
          <input value={department} onChange={e => setDepartment(e.target.value)} placeholder="Department tag (optional)" className="w-full bg-ink-900 border border-ink-800 rounded-md px-3 py-1.5 text-sm text-cream-100" />
          <div className="flex justify-end">
            <Button onClick={() => void submit()} disabled={busy || !label.trim() || !url.trim()}>{busy ? "…" : "Add"}</Button>
          </div>
        </div>
      )}

      {links.length === 0 ? (
        <div className="text-xs text-cream-300/40 py-4 text-center">No company links registered yet.</div>
      ) : (
        <div className="space-y-1.5">
          {links.map(l => (
            <div key={l.id} className="flex items-center gap-2 text-xs rounded-md bg-ink-950/50 border border-ink-800 px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-cream-100 truncate">{l.label}{l.department && <span className="text-cream-300/40 ml-1.5">· {l.department}</span>}</div>
                <a href={l.url} target="_blank" rel="noreferrer" className="text-cream-300/50 hover:text-violet-300 truncate flex items-center gap-1">
                  {l.url} <ExternalLink size={10} />
                </a>
              </div>
              {l.lastStatus && <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${l.lastError ? "bg-coral-500/15 text-coral-400" : "bg-leaf-500/15 text-leaf-400"}`}>{l.lastStatus}</span>}
              <button type="button" onClick={() => void remove(l.id)} className="p-1 rounded-md border border-ink-800 hover:border-coral-500/40 text-cream-300/60 hover:text-coral-400 shrink-0">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
