import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, Brain, Users, Database, Radio, Save, Search, RefreshCw, Trash2 } from "lucide-react";
import { ToggleRow } from "../components/ToggleRow";
import { ConfirmDialog } from "../components/Modal";

type ToolDna = { templates: Record<string, number>; skills: Record<string, number>; personas: Record<string, number> };
type ToolDnaState = { dna: ToolDna; settings: { personalizationEnabled: boolean } };

function topEntries(counts: Record<string, number>, n = 8): [string, number][] {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

type Ctx = {
  operator: { name: string; email: string; title?: string; sector?: string; orgName?: string; language: string; summary: string };
  cag: { hash: string; cached: boolean; ageMs: number; prefixChars: number };
  magChars: number;
  rag: string;
  ragRaw: string;
  roster: { count: number; workers: { id: string; name: string; role: string }[] };
  memorySubjects: { subject: string; count: number; lastTs?: string }[];
  connectivity: { cached: boolean | null; probeNeeded: boolean };
  voice: { realtime: boolean; openaiTts: boolean; localTts: boolean };
  query: string;
};

export function NaxieMemory() {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [q, setQ] = useState("operator and subagents");
  const [busy, setBusy] = useState(false);
  const [teach, setTeach] = useState({ subject: "operator", fact: "", date: "" });
  const [teachBusy, setTeachBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [dna, setDna] = useState<ToolDnaState | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  async function loadDna() {
    try { setDna(await (await fetch("/api/tool-dna")).json()); } catch { /* panel just doesn't render */ }
  }
  useEffect(() => { void loadDna(); }, []);

  async function togglePersonalization(next: boolean) {
    const prev = dna;
    setDna(d => d ? { ...d, settings: { personalizationEnabled: next } } : d);
    try {
      const r = await fetch("/api/tool-dna/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personalizationEnabled: next }) });
      if (!r.ok) throw new Error((await r.json()).error);
    } catch (e: any) { setDna(prev); setMsg(String(e?.message ?? e)); }
  }

  async function confirmResetDna() {
    setResetting(true);
    try {
      await fetch("/api/tool-dna", { method: "DELETE" });
      await loadDna();
      setConfirmReset(false);
    } catch (e: any) { setMsg(String(e?.message ?? e)); }
    finally { setResetting(false); }
  }

  async function load(query = q) {
    setBusy(true);
    try {
      const r = await fetch(`/api/naxie/context?q=${encodeURIComponent(query)}`);
      const j = await r.json();
      if (r.ok) setCtx(j);
      else setMsg(j.error ?? "load failed");
    } catch (e: any) { setMsg(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line

  async function remember() {
    if (!teach.fact.trim()) return;
    setTeachBusy(true);
    try {
      const r = await fetch("/api/naxie/remember", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(teach) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setMsg(`Saved to ${j.saved.subject}: ${j.saved.fact.slice(0,60)}`);
      setTeach(s => ({ ...s, fact: "" }));
      load();
    } catch (e: any) { setMsg(String(e?.message ?? e)); }
    finally { setTeachBusy(false); }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Brain size={20} className="text-violet-400" /> Naxie Memory</h1>
          <p className="text-xs text-cream-300/60">RAG · MAG · CAG inspector — what your second-in-command remembers. <Link to="/naxie" className="text-violet-400 hover:underline">Back to Naxie</Link></p>
        </div>
        <button onClick={() => load()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-ink-800 hover:bg-ink-700 border border-ink-700 text-xs"><RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Refresh</button>
      </div>

      {msg && <div className="text-xs bg-violet-500/10 border border-violet-500/20 rounded-md px-3 py-2 text-violet-300">{msg}</div>}

      {!ctx ? <div className="text-sm text-cream-300/60">{busy ? "Loading…" : "No data"}</div> : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-ink-900 border border-ink-800 rounded-xl p-4">
              <div className="text-xs font-semibold flex items-center gap-1.5"><Sparkles size={12} className="text-violet-400" /> Operator (MAG)</div>
              <div className="mt-2 text-sm text-cream-100">{ctx.operator.summary}</div>
              <div className="mt-2 text-[11px] text-cream-300/60 space-y-0.5">
                <div>Name: {ctx.operator.name} · {ctx.operator.email || "no email"}</div>
                <div>Org: {ctx.operator.orgName || "—"} · Sector: {ctx.operator.sector || "—"}</div>
                <div>Lang: {ctx.operator.language}</div>
              </div>
              <div className="mt-3 text-[10px] text-cream-300/40">Source: vault/_neuroworks/identity/operator.md + users.json + memory subject "operator"</div>
            </div>

            <div className="bg-ink-900 border border-ink-800 rounded-xl p-4">
              <div className="text-xs font-semibold flex items-center gap-1.5"><Brain size={12} className="text-emerald-400" /> CAG + MAG</div>
              <div className="mt-2 text-[11px] font-mono space-y-1">
                <div>CAG hash: <span className="text-cream-100">{ctx.cag.hash}</span> {ctx.cag.cached ? "· cached" : "· fresh"} · {Math.round(ctx.cag.ageMs/1000)}s ago</div>
                <div>CAG chars: {ctx.cag.prefixChars} · MAG chars: {ctx.magChars}</div>
                <div>Connectivity: {ctx.connectivity.cached === null ? "no probe yet" : ctx.connectivity.cached ? "online" : "offline"} {ctx.connectivity.probeNeeded ? "· will probe" : ""}</div>
              </div>
              <div className="mt-2 text-[11px] text-cream-300/60">Core prefix is prompt-cache friendly — rebusts only on identity mtime.</div>
            </div>

            <div className="bg-ink-900 border border-ink-800 rounded-xl p-4">
              <div className="text-xs font-semibold flex items-center gap-1.5"><Radio size={12} className="text-coral-400" /> Voices</div>
              <div className="mt-2 text-[11px] font-mono space-y-1">
                <div>Realtime: {ctx.voice.realtime ? "yes" : "no"} · OpenAI TTS: {ctx.voice.openaiTts ? "yes" : "no"} · LocalTTS: {ctx.voice.localTts ? "yes" : "no"}</div>
              </div>
            </div>
          </div>

          <div className="bg-ink-900 border border-ink-800 rounded-xl p-4">
            <div className="text-xs font-semibold flex items-center gap-1.5"><Users size={12} className="text-amber-400" /> Subagent Roster — {ctx.roster.count}</div>
            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-1 text-[11px]">
              {ctx.roster.workers.map(w => <div key={w.id} className="flex items-center gap-2 py-0.5"><span className="font-mono text-cream-300/60">{w.id}</span><span className="text-cream-100">{w.name}</span><span className="text-cream-300/50">— {w.role}</span></div>)}
            </div>
            <div className="mt-2 text-[10px] text-cream-300/40">Source: vault/_neuroworks/identity/subagents.md — rewritten on every new persona.</div>
          </div>

          <div className="bg-ink-900 border border-ink-800 rounded-xl p-4">
            <div className="text-xs font-semibold flex items-center gap-1.5"><Database size={12} className="text-cyan-400" /> Memory Subjects (MAG JSONL)</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ctx.memorySubjects.length === 0 ? <span className="text-[11px] text-cream-300/50">none yet — use Teach below</span> : ctx.memorySubjects.map(s => (
                <span key={s.subject} className="px-2 py-0.5 rounded-full bg-ink-950 border border-ink-800 text-[11px]">{s.subject} · {s.count}</span>
              ))}
            </div>
          </div>

          <div className="bg-ink-900 border border-ink-800 rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold flex items-center gap-1.5"><Search size={12} /> RAG Tester (vault-index + memory)</div>
            <div className="flex gap-2">
              <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === "Enter" && load()} placeholder="query" className="flex-1 bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs" />
              <button onClick={() => load()} disabled={busy} className="px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-700 text-xs text-white">Search</button>
            </div>
            <pre className="text-[11px] font-mono bg-ink-950 border border-ink-800 rounded-md p-3 whitespace-pre-wrap max-h-64 overflow-auto">{ctx.rag || "(no hits)"}</pre>
          </div>

          {dna && (
            <div className="bg-ink-900 border border-ink-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-semibold flex items-center gap-1.5"><Sparkles size={12} className="text-violet-400" /> Naxie's learned habits (Tool DNA)</div>
                <button onClick={() => setConfirmReset(true)} disabled={resetting} className="inline-flex items-center gap-1 text-[11px] text-cream-300/60 hover:text-coral-400" title="Reset learned habits">
                  <Trash2 size={11} /> Reset
                </button>
              </div>
              <ToggleRow
                label="Let Naxie learn from what I use"
                checked={dna.settings.personalizationEnabled}
                onChange={next => void togglePersonalization(next)}
                compact
              />
              <p className="text-[10px] text-cream-300/40">
                Frequency counts of templates and skills you've actually used — nothing else. Off means nothing new is
                recorded, not just hidden. Naxie folds your top habits into her own context so she can anticipate what
                you reach for most.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-cream-300/40 mb-1">Templates</div>
                  <div className="flex flex-wrap gap-1.5">
                    {topEntries(dna.dna.templates).length === 0
                      ? <span className="text-[11px] text-cream-300/50">nothing learned yet</span>
                      : topEntries(dna.dna.templates).map(([name, count]) => (
                          <span key={name} className="px-2 py-0.5 rounded-full bg-ink-950 border border-ink-800 text-[11px]">{name} · {count}</span>
                        ))}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-cream-300/40 mb-1">Skills</div>
                  <div className="flex flex-wrap gap-1.5">
                    {topEntries(dna.dna.skills).length === 0
                      ? <span className="text-[11px] text-cream-300/50">nothing learned yet</span>
                      : topEntries(dna.dna.skills).map(([name, count]) => (
                          <span key={name} className="px-2 py-0.5 rounded-full bg-ink-950 border border-ink-800 text-[11px]">{name} · {count}</span>
                        ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="bg-ink-900 border border-ink-800 rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold flex items-center gap-1.5"><Save size={12} /> Teach Naxie (so she never forgets)</div>
            <div className="grid grid-cols-1 md:grid-cols-[140px_1fr_140px_auto] gap-2">
              <input value={teach.subject} onChange={e => setTeach(s => ({ ...s, subject: e.target.value }))} placeholder="subject (operator)" className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs" />
              <input value={teach.fact} onChange={e => setTeach(s => ({ ...s, fact: e.target.value }))} placeholder="fact — e.g. Nature prefers USD pricing" className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs" />
              <input value={teach.date} onChange={e => setTeach(s => ({ ...s, date: e.target.value }))} placeholder="date YYYY-MM-DD (opt)" className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs" />
              <button onClick={remember} disabled={teachBusy || !teach.fact.trim()} className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-xs text-white">Save</button>
            </div>
            <div className="text-[10px] text-cream-300/40">Writes to _neuroworks/memory/&lt;subject&gt;.jsonl + vault git + busts CAG cache. Query it next via RAG.</div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmReset}
        title="Reset Naxie's learned habits?"
        body="This clears every template and skill usage count. Naxie won't lose your teachings above or her memory — only this habit tracker."
        confirmLabel="Reset"
        danger
        busy={resetting}
        onConfirm={confirmResetDna}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
