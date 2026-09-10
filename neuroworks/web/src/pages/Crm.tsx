import { useEffect, useMemo, useState } from "react";
import { Contact as ContactIcon, Plus, Loader2, X, Mail, Phone, Building2, ArrowRight } from "lucide-react";
import { api, type Contact, type Deal, type Pipeline } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";

// Minimal CRM — contacts + a single-pipeline kanban board. Local JSON store
// (server/src/lib/crm.ts), no external CRM required. Inbound email already
// links into this store for free (see lib/email.ts's CRM linkage).

const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60 placeholder:text-cream-300/30";

export function Crm() {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [addingContact, setAddingContact] = useState(false);
  const [addingDeal, setAddingDeal] = useState(false);

  async function refresh() {
    try { setContacts((await api.listContacts()).contacts); } catch { setContacts([]); }
    try { setDeals((await api.listDeals()).deals); } catch { setDeals([]); }
    try { const r = await api.listPipelines(); setPipeline(r.pipelines[0] ?? null); } catch { setPipeline(null); }
  }
  useEffect(() => { void refresh(); }, []);

  const contactById = useMemo(() => new Map((contacts ?? []).map(c => [c.id, c])), [contacts]);

  async function moveStage(deal: Deal, stage: string) {
    try {
      await api.moveDealStage(deal.id, stage);
      showToast(`Moved "${deal.title}" to ${stage}`, "success");
      await refresh();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><ContactIcon size={24} /> CRM</h1>
        <p className="text-sm text-cream-300/70 mt-1 max-w-3xl">
          Contacts and a sales pipeline, local to this install. Inbound email auto-creates a contact and logs an
          activity — see the timeline on any contact below.
        </p>
      </div>

      <Card title={`Contacts${contacts ? ` (${contacts.length})` : ""}`} action={<Button onClick={() => setAddingContact(true)}><Plus size={13} /> Add contact</Button>}>
        {contacts === null ? (
          <div className="text-sm text-cream-300/60 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : contacts.length === 0 ? (
          <div className="text-center py-6 text-cream-300/60 text-sm">No contacts yet — add one, or wait for an inbound email to create one automatically.</div>
        ) : (
          <div className="space-y-2">
            {contacts.map(c => <ContactRow key={c.id} contact={c} />)}
          </div>
        )}
      </Card>

      <Card title="Pipeline" action={<Button onClick={() => setAddingDeal(true)} disabled={!contacts?.length}><Plus size={13} /> New deal</Button>}>
        {!pipeline || deals === null ? (
          <div className="text-sm text-cream-300/60 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${pipeline.stages.length}, minmax(0, 1fr))` }}>
            {pipeline.stages.map(stage => {
              const stageDeals = deals.filter(d => d.stage === stage);
              return (
                <div key={stage} className="min-w-0">
                  <div className="text-[11px] uppercase tracking-wide text-cream-300/50 mb-2 px-1">{stage} · {stageDeals.length}</div>
                  <div className="space-y-2">
                    {stageDeals.map(deal => {
                      const contact = contactById.get(deal.contactId);
                      const stageIdx = pipeline.stages.indexOf(deal.stage);
                      const nextStage = pipeline.stages[stageIdx + 1];
                      return (
                        <div key={deal.id} className="rounded-lg bg-ink-950/50 border border-ink-800 p-2.5 space-y-1.5">
                          <div className="text-sm text-cream-100 truncate">{deal.title}</div>
                          <div className="text-[11px] text-cream-300/50 truncate">{contact?.name || contact?.email || "unknown contact"}</div>
                          {deal.value !== undefined && <div className="text-[11px] text-leaf-400">${deal.value.toLocaleString()}</div>}
                          {nextStage && (
                            <button
                              type="button"
                              onClick={() => void moveStage(deal, nextStage)}
                              className="text-[11px] text-violet-400 hover:text-violet-300 inline-flex items-center gap-1"
                            >
                              {nextStage} <ArrowRight size={11} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {addingContact && <AddContactModal onClose={() => setAddingContact(false)} onCreated={refresh} />}
      {addingDeal && contacts && <AddDealModal contacts={contacts} pipeline={pipeline} onClose={() => setAddingDeal(false)} onCreated={refresh} />}
    </div>
  );
}

function ContactRow({ contact }: { contact: Contact }) {
  const [open, setOpen] = useState(false);
  const [activities, setActivities] = useState<{ id: string; kind: string; body: string; at: string }[] | null>(null);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && activities === null) {
      try { setActivities((await api.listContactActivities(contact.id)).activities); } catch { setActivities([]); }
    }
  }

  return (
    <div className="rounded-lg bg-ink-950/50 border border-ink-800 overflow-hidden">
      <button type="button" onClick={toggle} className="w-full flex items-center gap-3 py-2 px-3 text-left">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-cream-100 truncate">{contact.name || contact.email || "Unnamed contact"}</div>
          <div className="text-[11px] text-cream-300/50 flex items-center gap-3 flex-wrap">
            {contact.email && <span className="inline-flex items-center gap-1"><Mail size={11} /> {contact.email}</span>}
            {contact.phone && <span className="inline-flex items-center gap-1"><Phone size={11} /> {contact.phone}</span>}
            {contact.company && <span className="inline-flex items-center gap-1"><Building2 size={11} /> {contact.company}</span>}
          </div>
        </div>
        <span className="text-[10px] text-cream-300/40 uppercase">{contact.source}</span>
      </button>
      {open && (
        <div className="border-t border-ink-800 px-3 py-2 space-y-1.5">
          {activities === null ? (
            <div className="text-[12px] text-cream-300/50 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading activity…</div>
          ) : activities.length === 0 ? (
            <div className="text-[12px] text-cream-300/40">No activity yet.</div>
          ) : activities.map(a => (
            <div key={a.id} className="text-[12px] text-cream-200/80">
              <span className="text-cream-300/40 uppercase text-[10px] mr-2">{a.kind}</span>{a.body}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddContactModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.upsertContact({ name: name.trim() || undefined, email: email.trim() || undefined, phone: phone.trim() || undefined, company: company.trim() || undefined });
      showToast("Contact saved", "success");
      await onCreated();
      onClose();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-md bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-3 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">Add contact</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" className={FIELD} />
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" className={FIELD} />
        <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone" className={FIELD} />
        <input value={company} onChange={e => setCompany(e.target.value)} placeholder="Company" className={FIELD} />
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving || !(name.trim() || email.trim())}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddDealModal({ contacts, pipeline, onClose, onCreated }: { contacts: Contact[]; pipeline: Pipeline | null; onClose: () => void; onCreated: () => Promise<void> }) {
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [stage, setStage] = useState(pipeline?.stages[0] ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.createDeal({ contactId, title: title.trim(), stage: stage || undefined, value: value.trim() ? Number(value) : undefined });
      showToast("Deal created", "success");
      await onCreated();
      onClose();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-md bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-3 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">New deal</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>
        <select value={contactId} onChange={e => setContactId(e.target.value)} className={FIELD}>
          {contacts.map(c => <option key={c.id} value={c.id}>{c.name || c.email || c.id}</option>)}
        </select>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Deal title" className={FIELD} />
        <input value={value} onChange={e => setValue(e.target.value)} placeholder="Value (optional)" type="number" className={FIELD} />
        {pipeline && (
          <select value={stage} onChange={e => setStage(e.target.value)} className={FIELD}>
            {pipeline.stages.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving || !contactId || !title.trim()}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create
          </Button>
        </div>
      </div>
    </div>
  );
}
