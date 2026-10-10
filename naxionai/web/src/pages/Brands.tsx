import { FormEvent, useEffect, useState } from "react";
import {
  Megaphone, User, Briefcase, Store, Loader2, Plug, X, Save, Radar, Check, Ban, type LucideIcon,
} from "lucide-react";
import { api, type Brand, type BrandChannel, type BrandSignal } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { Modal } from "../components/Modal";
import { Input } from "../components/forms";

// Brand registry — one card per marketing identity (Personal / Work /
// Business=Variety Vault, seeded on server boot). Each brand owns a voice,
// audience, values block, an optional vault guidelines doc, and one or more
// channel bindings (which Buffer/social connection speaks for it). This is
// deliberately lighter than a department-apply flow — a brand is
// "one voice, one calendar, one set of channels," not a multi-agent workflow.

const ICON_MAP: Record<string, LucideIcon> = { megaphone: Megaphone, user: User, briefcase: Briefcase, store: Store };

const COLOR_MAP: Record<string, string> = {
  violet: "border-violet-500/30 bg-violet-500/5 text-violet-300",
  coral: "border-coral-500/30 bg-coral-500/5 text-coral-300",
  leaf: "border-leaf-500/30 bg-leaf-500/5 text-leaf-300",
  flame: "border-flame-500/30 bg-flame-500/5 text-flame-300",
  amber: "border-amber-500/30 bg-amber-500/5 text-amber-300",
};

export function Brands() {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Brand | null>(null);
  const [channelsFor, setChannelsFor] = useState<Brand | null>(null);
  const [signalsFor, setSignalsFor] = useState<Brand | null>(null);

  async function refresh() {
    try { setBrands((await api.listBrands()).brands); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><Megaphone size={24} /> Brands</h1>
        <p className="text-sm text-cream-300/70 mt-1 max-w-3xl">
          Your marketing identities — each with its own voice, audience, channels, and content calendar, kept isolated
          from each other. The news and brand templates (africa-ai-news, world-ai-news, brand-signal-scan) take a Brand as an input.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-cream-300/60"><Loader2 size={16} className="animate-spin" /> Loading brands…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {brands.map(b => {
            const Icon = ICON_MAP[b.icon] ?? Megaphone;
            const colors = COLOR_MAP[b.color] ?? COLOR_MAP.violet;
            const filledIn = !!(b.voice.trim() || b.audience.trim() || b.values.trim());
            return (
              <Card key={b.id}>
                <div className="flex items-start justify-between mb-3">
                  <div className={`p-2 rounded-lg border ${colors}`}><Icon size={20} /></div>
                  {!filledIn && <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-amber-500/30 text-amber-300">needs voice</span>}
                </div>
                <div className="font-display text-lg text-cream-50">{b.name}</div>
                <div className="text-xs text-cream-300/70 mt-1">{b.tagline}</div>
                {b.voice.trim() && <div className="text-xs text-cream-300/60 mt-2 line-clamp-2">{b.voice}</div>}
                {b.calendarCadence && <div className="text-[10px] text-cream-300/50 mt-2">Cadence: {b.calendarCadence}</div>}
                <div className="flex flex-wrap gap-2 mt-3 text-[10px] text-cream-300/60">
                  <span className="inline-flex items-center gap-1"><Plug size={11} /> {b.channels.length} channel{b.channels.length === 1 ? "" : "s"}</span>
                  {b.guidelinesVaultPath && <span className="font-mono">{b.guidelinesVaultPath}</span>}
                </div>
                <div className="flex gap-2 mt-4">
                  <Button variant="subtle" className="flex-1" onClick={() => setEditing(b)}>Edit voice</Button>
                  <Button variant="subtle" className="flex-1" onClick={() => setChannelsFor(b)}>Channels</Button>
                </div>
                <Button variant="subtle" className="w-full mt-2" onClick={() => setSignalsFor(b)}><Radar size={13} /> Signals</Button>
              </Card>
            );
          })}
        </div>
      )}

      {editing && <EditBrandModal brand={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />}
      {channelsFor && <ChannelsModal brand={channelsFor} onClose={() => setChannelsFor(null)} onSaved={() => { setChannelsFor(null); void refresh(); }} />}
      {signalsFor && <SignalsModal brand={signalsFor} onClose={() => setSignalsFor(null)} onBrandSaved={() => void refresh()} />}
    </div>
  );
}

const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60 placeholder:text-cream-300/30";

function EditBrandModal({ brand, onClose, onSaved }: { brand: Brand; onClose: () => void; onSaved: () => void }) {
  const [voice, setVoice] = useState(brand.voice);
  const [audience, setAudience] = useState(brand.audience);
  const [values, setValues] = useState(brand.values);
  const [calendarCadence, setCalendarCadence] = useState(brand.calendarCadence ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.updateBrand(brand.id, { voice, audience, values, calendarCadence: calendarCadence || undefined });
      showToast(`Updated ${brand.name}`, "success");
      onSaved();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <Modal open onClose={onClose} title={`Edit ${brand.name}`} size="lg">
      <div className="space-y-4">
        <div className="space-y-2">
          <label className="block text-[12px] font-medium text-cream-300/70">Voice</label>
          <Input value={voice} onChange={(e: FormEvent<HTMLInputElement>) => setVoice((e.target as HTMLInputElement).value)} placeholder="e.g. warm, direct, story-first" />
        </div>
        <div className="space-y-2">
          <label className="block text-[12px] font-medium text-cream-300/70">Audience</label>
          <textarea value={audience} onChange={(e: FormEvent<HTMLTextAreaElement>) => setAudience((e.target as HTMLTextAreaElement).value)} rows={3} placeholder="Who this brand speaks to" className={FIELD} />
        </div>
        <div className="space-y-2">
          <label className="block text-[12px] font-medium text-cream-300/70">Values</label>
          <textarea value={values} onChange={(e: FormEvent<HTMLTextAreaElement>) => setValues((e.target as HTMLTextAreaElement).value)} rows={5} placeholder="Bullet-style values this brand always reflects" className={`${FIELD} font-mono text-[13px]`} />
        </div>
        <div className="space-y-2">
          <label className="block text-[12px] font-medium text-cream-300/70">Content calendar cadence</label>
          <Input value={calendarCadence} onChange={(e: FormEvent<HTMLInputElement>) => setCalendarCadence((e.target as HTMLInputElement).value)} placeholder="e.g. 3x/week: Mon/Wed/Fri 9am" />
        </div>
        {brand.guidelinesVaultPath && (
          <div className="text-xs text-cream-300/50 bg-ink-900/50 border border-ink-800 rounded-xl px-4 py-3">
            Full guidelines doc: <span className="font-mono text-violet-400">{brand.guidelinesVaultPath}</span> — edit it in the vault for longer-form brand guidelines beyond this quick form.
          </div>
        )}
      </div>
      <div className="flex justify-end pt-2">
        <Button onClick={save} disabled={saving} className="px-6 py-2">{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save Changes</Button>
      </div>
    </Modal>
  );
}

function ChannelsModal({ brand, onClose, onSaved }: { brand: Brand; onClose: () => void; onSaved: () => void }) {
  // "buffer" only for now — social.ts (Ayrshare) reads a single global
  // AYRSHARE_API_KEY env var and has no per-connection lookup at all, so
  // there's genuinely nothing to bind per-brand there yet. Don't offer a
  // choice that silently does nothing.
  const [provider] = useState<"buffer">("buffer");
  const [connectionLabel, setConnectionLabel] = useState("");
  const [platforms, setPlatforms] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!connectionLabel.trim()) { showToast("Connection label is required — see the label on the Integrations page", "error"); return; }
    setSaving(true);
    const channel: BrandChannel = {
      provider, connectionLabel: connectionLabel.trim(),
      platforms: platforms.trim() ? platforms.split(",").map(p => p.trim()).filter(Boolean) : undefined,
    };
    try {
      await api.addBrandChannel(brand.id, channel);
      showToast(`Channel bound to ${brand.name}`, "success");
      onSaved();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setSaving(false); }
  }

  return (
    <Modal open onClose={onClose} title={`Channels — ${brand.name}`} size="lg">
      {brand.channels.length > 0 && (
        <div className="space-y-2">
          <label className="block text-[12px] font-medium text-cream-300/70">Active Bindings</label>
          <div className="grid grid-cols-1 gap-2">
            {brand.channels.map((c, i) => (
              <div key={i} className="text-sm rounded-xl bg-ink-900 border border-ink-800 p-3 flex items-center justify-between">
                <span className="font-mono text-cream-100">{c.provider}: {c.connectionLabel}</span>
                {c.platforms?.length ? <span className="text-cream-300/50 text-xs">{c.platforms.join(", ")}</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4 border-t border-ink-800 pt-6">
        <div className="text-xs text-cream-300/60 leading-relaxed">
          Bind a connection from the <a href="/extensions" className="text-violet-400 hover:text-violet-300 font-medium underline-offset-4 hover:underline">Integrations page</a> to this brand by its label.
        </div>
        <div className="space-y-3">
          <div className="space-y-2">
            <label className="block text-[12px] font-medium text-cream-300/70">Provider</label>
            <Input value="Buffer" disabled className="opacity-60 cursor-not-allowed" />
            <p className="text-[11px] text-cream-300/40">Ayrshare/Social isn't multi-account yet — it uses a shared server key.</p>
          </div>
          <div className="space-y-2">
            <label className="block text-[12px] font-medium text-cream-300/70">Connection label</label>
            <Input value={connectionLabel} onChange={(e: FormEvent<HTMLInputElement>) => setConnectionLabel((e.target as HTMLInputElement).value)} placeholder="e.g. Buffer – Variety Vault" />
          </div>
          <div className="space-y-2">
            <label className="block text-[12px] font-medium text-cream-300/70">Platforms (optional, comma-separated)</label>
            <Input value={platforms} onChange={(e: FormEvent<HTMLInputElement>) => setPlatforms((e.target as HTMLInputElement).value)} placeholder="twitter, linkedin" />
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <Button onClick={save} disabled={saving} className="px-6 py-2">{saving ? <Loader2 size={16} className="animate-spin" /> : <Plug size={16} />} Bind channel</Button>
      </div>
    </Modal>
  );
}

// Phase 2 — own-brand mention/opportunity monitoring, MAIA-shaped (ingest ->
// gate -> provenance-labelled draft -> human validate/reject -> gated export).
// No dedicated review page by design (Telegram/email is the primary review
// channel — see lib/brand-signals.ts); this modal is a lightweight secondary
// way to act on drafts without leaving the Brands page.
function SignalsModal({ brand, onClose, onBrandSaved }: { brand: Brand; onClose: () => void; onBrandSaved: () => void }) {
  const [watchTermsText, setWatchTermsText] = useState((brand.watchTerms ?? []).join(", "));
  const [riskTermsText, setRiskTermsText] = useState((brand.riskTerms ?? []).join(", "));
  const [ownDomainsText, setOwnDomainsText] = useState((brand.ownDomains ?? []).join(", "));
  const [savingTerms, setSavingTerms] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [signals, setSignals] = useState<BrandSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    document.body.classList.add('modal-open');
    return () => { document.body.classList.remove('modal-open'); };
  }, []);

  async function load() {
    setLoading(true);
    try { setSignals((await api.listBrandSignals({ brandId: brand.id, status: "draft" })).signals); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [brand.id]);

  async function saveTerms() {
    setSavingTerms(true);
    try {
      const watchTerms = watchTermsText.split(",").map(t => t.trim()).filter(Boolean);
      const riskTerms = riskTermsText.split(",").map(t => t.trim()).filter(Boolean);
      const ownDomains = ownDomainsText.split(",").map(t => t.trim()).filter(Boolean);
      await api.updateBrand(brand.id, { watchTerms, riskTerms, ownDomains });
      showToast("Monitoring settings updated", "success");
      onBrandSaved();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setSavingTerms(false); }
  }

  async function scan() {
    setScanning(true);
    try {
      const { run } = await api.scanBrandSignals(brand.id);
      if (run.error) showToast(run.error, "error");
      else showToast(`Scan done — ${run.signalCount} new signal${run.signalCount === 1 ? "" : "s"}, ${run.refusedCount} refused`, "success");
      await load();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setScanning(false); }
  }

  async function decide(id: string, decision: "validated" | "rejected") {
    setBusyId(id);
    try { await api.validateBrandSignal(id, decision); await load(); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusyId(null); }
  }

  return (
    <Modal open onClose={onClose} title={<><Radar size={24} /> Signals — {brand.name}</>} size="full">
      <div className="grid grid-cols-1 lg:grid-cols-4 h-full">
        <div className="lg:col-span-1 p-6 space-y-8 border-r border-ink-800 overflow-y-auto bg-ink-950/30">
          <div className="space-y-6">
            <div className="space-y-3">
              <label className="block text-[12px] font-medium text-cream-300/70">Watch list</label>
              <Input value={watchTermsText} onChange={(e: FormEvent<HTMLInputElement>) => setWatchTermsText((e.target as HTMLInputElement).value)} placeholder="e.g. Variety Vault, @varietyvault" />
              <p className="text-[11px] text-cream-300/40">Comma-separated terms this brand monitors for</p>
            </div>
            <div className="space-y-3">
              <label className="block text-[12px] font-medium text-cream-300/70">Own domains/handles</label>
              <Input value={ownDomainsText} onChange={(e: FormEvent<HTMLInputElement>) => setOwnDomainsText((e.target as HTMLInputElement).value)} placeholder="e.g. varietyvault.com" />
              <p className="text-[11px] text-cream-300/40">Scores a hit as "primary" provenance</p>
            </div>
            <div className="space-y-3">
              <label className="block text-[12px] font-medium text-cream-300/70">Reputation-risk terms</label>
              <Input value={riskTermsText} onChange={(e: FormEvent<HTMLInputElement>) => setRiskTermsText((e.target as HTMLInputElement).value)} placeholder="e.g. recall, lawsuit" />
              <p className="text-[11px] text-cream-300/40">Overrides shared default list for "critical" alerts</p>
            </div>
          </div>
          <div className="flex gap-3">
            <Button variant="subtle" className="flex-1" onClick={saveTerms} disabled={savingTerms}>{savingTerms ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save</Button>
            <Button className="flex-1" onClick={scan} disabled={scanning || !watchTermsText.trim()}>
              {scanning ? <Loader2 size={14} className="animate-spin" /> : <Radar size={14} />} Scan now
            </Button>
          </div>
          <div className="p-4 rounded-xl bg-ink-950/50 border border-ink-800 text-xs text-cream-300/50 leading-relaxed">
            Alerts (critical risk hits, and new signal kinds) go to Telegram/email. This list contains drafts awaiting your decision.
            <div className="mt-3 pt-3 border-t border-ink-800/50 font-medium text-cream-300/70">
              Tip: Pair with a recurring Schedule (template: "Scan for brand signals") to automate this.
            </div>
          </div>
        </div>

        <div className="lg:col-span-3 p-6 space-y-4 overflow-y-auto bg-ink-900">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-sm font-medium text-cream-300/70 uppercase tracking-widest">Draft Signals</h3>
            {signals.length > 0 && <span className="text-xs bg-ink-800 text-cream-300 px-3 py-1 rounded-full border border-ink-700">{signals.length} pending review</span>}
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-cream-300/60 py-20 justify-center"><Loader2 size={20} className="animate-spin" /> Loading signals…</div>
          ) : signals.length === 0 ? (
            <div className="text-sm text-cream-300/50 text-center py-32 border-2 border-dashed border-ink-800 rounded-2xl">No draft signals awaiting review.</div>
          ) : signals.map(s => (
            <div key={s.id} className="rounded-2xl bg-ink-950/50 border border-ink-800 p-5 hover:border-violet-500/40 transition-all group">
              <div className="text-base text-cream-100 leading-relaxed">{s.text}</div>
              <div className="flex items-center justify-between mt-6">
                <div className="flex items-center gap-4 text-xs text-cream-300/50">
                  {s.sourceUrl && <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-violet-400 hover:text-violet-300 font-medium flex items-center gap-1 underline-offset-4 hover:underline">source <X size={12} className="rotate-45" /></a>}
                  <span className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${s.provenance >= 0.6 ? "bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.5)]" : "bg-cream-300/30"}`} />
                    {s.provenance >= 0.6 ? "primary provenance" : "third-party provenance"}
                  </span>
                  {s.seenCount > 1 && <span className="bg-ink-800 px-2 py-0.5 rounded text-cream-300 border border-ink-700">seen {s.seenCount}x</span>}
                </div>
                <div className="flex gap-3">
                  <Button variant="subtle" className="px-4 py-1.5" onClick={() => decide(s.id, "validated")} disabled={busyId === s.id}><Check size={14} /> Validate</Button>
                  <Button variant="subtle" className="px-4 py-1.5" onClick={() => decide(s.id, "rejected")} disabled={busyId === s.id}><Ban size={14} /> Reject</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
