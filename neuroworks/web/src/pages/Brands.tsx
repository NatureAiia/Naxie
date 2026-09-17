import { useEffect, useState } from "react";
import {
  Megaphone, User, Briefcase, Store, Loader2, Plug, X, Save, Radar, Check, Ban, type LucideIcon,
} from "lucide-react";
import { api, type Brand, type BrandChannel, type BrandSignal } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";

// Brand registry — one card per marketing identity (Personal / Work=AIIA /
// Business=Variety Vault, seeded on server boot). Each brand owns a voice,
// audience, values block, an optional vault guidelines doc, and one or more
// channel bindings (which Buffer/social connection speaks for it). This is
// deliberately lighter than the Squads.tsx department-apply flow — a brand is
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
          from each other. The social-drafting templates (buffer-story-post, social-optimize) take a Brand as an input.
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-lg bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">Edit {brand.name}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Voice</label>
            <input value={voice} onChange={e => setVoice(e.target.value)} placeholder="e.g. warm, direct, story-first" className={FIELD} />
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Audience</label>
            <textarea value={audience} onChange={e => setAudience(e.target.value)} rows={2} placeholder="Who this brand speaks to" className={FIELD} />
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Values</label>
            <textarea value={values} onChange={e => setValues(e.target.value)} rows={4} placeholder="Bullet-style values this brand always reflects" className={`${FIELD} font-mono text-[12px]`} />
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Content calendar cadence</label>
            <input value={calendarCadence} onChange={e => setCalendarCadence(e.target.value)} placeholder="e.g. 3x/week: Mon/Wed/Fri 9am" className={FIELD} />
          </div>
          {brand.guidelinesVaultPath && (
            <div className="text-[11px] text-cream-300/50 bg-ink-950/40 border border-ink-800 rounded-lg px-3 py-2">
              Full guidelines doc: <span className="font-mono">{brand.guidelinesVaultPath}</span> — edit it in the vault for longer-form brand guidelines beyond this quick form.
            </div>
          )}
        </div>
        <div className="flex justify-end pt-1">
          <Button onClick={save} disabled={saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save</Button>
        </div>
      </div>
    </div>
  );
}

function ChannelsModal({ brand, onClose, onSaved }: { brand: Brand; onClose: () => void; onSaved: () => void }) {
  const [provider, setProvider] = useState<"buffer" | "social">("buffer");
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-lg bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">Channels — {brand.name}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>

        {brand.channels.length > 0 && (
          <div className="space-y-1.5">
            {brand.channels.map((c, i) => (
              <div key={i} className="text-[12px] rounded-lg bg-ink-950/50 border border-ink-800 p-2.5 flex items-center justify-between">
                <span className="font-mono text-cream-100">{c.provider}: {c.connectionLabel}</span>
                {c.platforms?.length ? <span className="text-cream-300/50">{c.platforms.join(", ")}</span> : null}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-3 border-t border-ink-800 pt-3">
          <div className="text-[11px] text-cream-300/60">
            Bind a connection from the <a href="/extensions" className="text-violet-400 hover:text-violet-300">Integrations page</a> to this brand by its label —
            posting for this brand will use that connection instead of whichever one connects first.
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Provider</label>
            <select value={provider} onChange={e => setProvider(e.target.value as "buffer" | "social")} className={FIELD}>
              <option value="buffer">Buffer</option>
              <option value="social">Social (Ayrshare)</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Connection label</label>
            <input value={connectionLabel} onChange={e => setConnectionLabel(e.target.value)} placeholder="e.g. Buffer – Variety Vault" className={FIELD} />
          </div>
          <div>
            <label className="block text-[11px] text-cream-300/70 mb-1">Platforms (optional, comma-separated)</label>
            <input value={platforms} onChange={e => setPlatforms(e.target.value)} placeholder="twitter, linkedin" className={FIELD} />
          </div>
        </div>

        <div className="flex justify-end pt-1">
          <Button onClick={save} disabled={saving}>{saving ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />} Bind channel</Button>
        </div>
      </div>
    </div>
  );
}

// Phase 2 — own-brand mention/opportunity monitoring, MAIA-shaped (ingest ->
// gate -> provenance-labelled draft -> human validate/reject -> gated export).
// No dedicated review page by design (Telegram/email is the primary review
// channel — see lib/brand-signals.ts); this modal is a lightweight secondary
// way to act on drafts without leaving the Brands page.
function SignalsModal({ brand, onClose, onBrandSaved }: { brand: Brand; onClose: () => void; onBrandSaved: () => void }) {
  const [watchTermsText, setWatchTermsText] = useState((brand.watchTerms ?? []).join(", "));
  const [savingTerms, setSavingTerms] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [signals, setSignals] = useState<BrandSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

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
      await api.updateBrand(brand.id, { watchTerms });
      showToast("Watch list updated", "success");
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={onClose}>
      <div className="w-full max-w-xl bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-4 my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium flex items-center gap-2"><Radar size={18} /> Signals — {brand.name}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
        </div>

        <div className="space-y-2">
          <label className="block text-[11px] text-cream-300/70">Watch list (comma-separated terms this brand monitors for)</label>
          <div className="flex gap-2">
            <input value={watchTermsText} onChange={e => setWatchTermsText(e.target.value)} placeholder="e.g. Variety Vault, @varietyvault" className={FIELD} />
            <Button variant="subtle" onClick={saveTerms} disabled={savingTerms}>{savingTerms ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}</Button>
          </div>
          <Button onClick={scan} disabled={scanning || !watchTermsText.trim()}>
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <Radar size={14} />} Scan now
          </Button>
          <div className="text-[10px] text-cream-300/40">
            Alerts (critical reputation-risk hits, and the first-ever signal of a new kind) go to Telegram/email — this list is drafts still awaiting your decision.
          </div>
        </div>

        <div className="border-t border-ink-800 pt-3 space-y-2 max-h-80 overflow-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-cream-300/60"><Loader2 size={16} className="animate-spin" /> Loading…</div>
          ) : signals.length === 0 ? (
            <div className="text-sm text-cream-300/50 text-center py-4">No draft signals awaiting review.</div>
          ) : signals.map(s => (
            <div key={s.id} className="rounded-lg bg-ink-950/50 border border-ink-800 p-3">
              <div className="text-[12px] text-cream-100">{s.text.slice(0, 220)}</div>
              <div className="flex items-center justify-between mt-2">
                <div className="text-[10px] text-cream-300/50">
                  {s.sourceUrl && <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-violet-400 hover:text-violet-300">source</a>}
                  {" · sourced: "}{s.provenance >= 0.6 ? "primary (own domain)" : "third-party"}
                  {s.seenCount > 1 ? ` · seen ${s.seenCount}x` : ""}
                </div>
                <div className="flex gap-1.5">
                  <Button variant="subtle" onClick={() => decide(s.id, "validated")} disabled={busyId === s.id}><Check size={12} /> Validate</Button>
                  <Button variant="subtle" onClick={() => decide(s.id, "rejected")} disabled={busyId === s.id}><Ban size={12} /> Reject</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
