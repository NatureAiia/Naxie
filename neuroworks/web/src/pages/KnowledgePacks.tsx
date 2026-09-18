import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api, type KnowledgePack, type DatasetManifest, type OmniSourceKindInfo, type OmniSourceKind, type OmniSpec } from "../lib/api";
import { Loader2, BookOpen, CheckCircle2, Download, FileText, Database, Sparkles } from "lucide-react";
import { Card, Button } from "../components/Card";

export function KnowledgePacks() {
  const nav = useNavigate();
  const [packs, setPacks] = useState<KnowledgePack[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.listKnowledgePacks().then(r => setPacks(r.packs)).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const install = async (sectorId: string) => {
    setInstalling(sectorId);
    await api.installKnowledgePack(sectorId);
    setInstalling(null);
    load();
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin w-6 h-6 text-violet-400" /></div>;

  return (
    <div className="space-y-6">
      <div>
        <div className="nw-eyebrow">Library</div>
        <h1 className="text-2xl font-semibold tracking-tight text-cream-50 flex items-center gap-2">
          <BookOpen className="w-6 h-6 text-violet-400" /> Knowledge Packs
        </h1>
        <p className="text-sm text-cream-300/70 mt-1 max-w-3xl">
          Curated sector packs live in your vault under <span className="font-mono text-cream-200">_knowledge-packs/</span>, and are retrievable by agents via vault search.
        </p>
      </div>

      <DatasetsSection />

      <div>
        <h2 className="text-sm font-semibold text-cream-100 mb-3">Sector packs</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {packs.map(pack => (
            <Card key={pack.sectorId} hoverable className={pack.installed ? "border-leaf-500/40" : ""}>
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-semibold text-cream-50">{pack.name}</h3>
                {pack.installed && <CheckCircle2 className="w-5 h-5 text-leaf-400 shrink-0" />}
              </div>

              {pack.installed ? (
                <div className="space-y-2">
                  <p className="text-xs text-leaf-400 font-medium">Installed ({pack.files.length} files)</p>
                  <div className="space-y-1">
                    {pack.files.map(f => (
                      <button
                        key={f.path}
                        onClick={() => nav("/library/" + f.path.replace(/\\/g, "/"))}
                        className="w-full flex items-center gap-2 text-xs text-cream-300/70 hover:text-violet-300 text-left"
                      >
                        <FileText className="w-3 h-3 shrink-0" />
                        <span className="truncate">{f.title}</span>
                        <span className="shrink-0 text-cream-300/40">({f.wordCount} words)</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-xs text-cream-300/40 mb-3">Not installed</p>
                  <button
                    onClick={() => install(pack.sectorId)}
                    disabled={installing === pack.sectorId}
                    className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-md bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50"
                  >
                    {installing === pack.sectorId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    Install Pack
                  </button>
                </div>
              )}
            </Card>
          ))}
        </div>
      </div>

      {packs.every(p => p.installed) && packs.length > 0 && (
        <div className="bg-violet-500/10 border border-violet-500/30 rounded-lg px-4 py-3 text-sm text-violet-200">
          All sector packs installed. Use vault search to query them — they're indexed alongside your other notes.
        </div>
      )}
    </div>
  );
}

// ── Datasets (Omnisignal → ADRS) ──────────────────────────────────────────
// Acquire raw signal (web/db/file/vault), publish it through the ADRS
// pipeline (hash/score/entity-resolve), and it becomes a dataset agents can
// RAG against — same "reusable knowledge asset" idea as a sector pack, just
// built from live signal instead of a curated file bundle.

const OUTPUT_KINDS: { kind: "csv" | "jsonl" | "rag" | "card"; label: string }[] = [
  { kind: "card", label: "Card" },
  { kind: "csv", label: "CSV" },
  { kind: "jsonl", label: "JSONL" },
  { kind: "rag", label: "RAG" },
];

function DatasetsSection() {
  const [datasets, setDatasets] = useState<DatasetManifest[]>([]);
  const [dsLoading, setDsLoading] = useState(true);
  const [kinds, setKinds] = useState<OmniSourceKindInfo[]>([]);
  const [open, setOpen] = useState(false);

  const loadDatasets = () => {
    setDsLoading(true);
    api.listDatasets().then(r => setDatasets(r.datasets)).catch(() => {}).finally(() => setDsLoading(false));
  };
  useEffect(loadDatasets, []);
  useEffect(() => { api.listOmniKinds().then(r => setKinds(r.kinds)).catch(() => {}); }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-cream-100 flex items-center gap-2">
          <Database className="w-4 h-4 text-teal-400" /> Datasets
        </h2>
        <Button variant={open ? "subtle" : "primary"} onClick={() => setOpen(o => !o)}>
          <Sparkles className="w-4 h-4" /> {open ? "Close" : "Acquire & publish"}
        </Button>
      </div>
      <p className="text-xs text-cream-300/60 -mt-2 mb-3">
        Pulled from the web, a connected database, a local file, or the vault — then hashed, scored, and entity-resolved by the ADRS pipeline into a dataset agents can learn from.
      </p>

      {open && <AcquirePublishPanel kinds={kinds} onPublished={() => { setOpen(false); loadDatasets(); }} />}

      {dsLoading ? (
        <div className="flex items-center gap-2 text-xs text-cream-300/60"><Loader2 className="w-4 h-4 animate-spin" /> Loading datasets…</div>
      ) : datasets.length === 0 ? (
        <p className="text-xs text-cream-300/40">No datasets published yet — use "Acquire & publish" above.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {datasets.map(d => (
            <Card key={d.id}>
              <div className="flex items-start justify-between mb-1">
                <h3 className="font-semibold text-cream-50 text-sm">{d.name}</h3>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-teal-500/15 text-teal-300 shrink-0">{Math.round(d.avgConfidence * 100)}% conf</span>
              </div>
              <p className="text-[11px] text-cream-300/60">
                {d.recordCount} records{d.sector ? ` · ${d.sector}` : ""} · via {d.source}
              </p>
              {(d.reviewQueue > 0 || d.ambiguousMatches > 0) && (
                <p className="text-[11px] text-flame-400 mt-1">
                  {d.reviewQueue > 0 ? `${d.reviewQueue} need review` : ""}{d.reviewQueue > 0 && d.ambiguousMatches > 0 ? " · " : ""}{d.ambiguousMatches > 0 ? `${d.ambiguousMatches} ambiguous matches` : ""}
                </p>
              )}
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {OUTPUT_KINDS.map(o => (
                  <a key={o.kind} href={api.datasetOutputUrl(d.id, o.kind)} download className="text-[11px] text-violet-400 hover:text-violet-300 inline-flex items-center gap-1">
                    <Download className="w-3 h-3" /> {o.label}
                  </a>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AcquirePublishPanel({ kinds, onPublished }: { kinds: OmniSourceKindInfo[]; onPublished: () => void }) {
  const [kind, setKind] = useState<OmniSourceKind>("web_search");
  const [query, setQuery] = useState("");
  const [urls, setUrls] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [sector, setSector] = useState("");
  const [acquireResult, setAcquireResult] = useState<{ total: number; report: { source: string; count: number; error?: string }[] } | null>(null);
  const [acquiring, setAcquiring] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [err, setErr] = useState("");

  const needs = kinds.find(k => k.kind === kind)?.needs ?? "";

  function buildSpec(): OmniSpec {
    return {
      kind,
      query: kind === "web_search" || kind === "vault" ? query.trim() : (kind === "db" ? query.trim() : undefined),
      urls: kind === "web_page" ? urls.split(",").map(u => u.trim()).filter(Boolean) : undefined,
      sourceLabel: kind === "db" ? sourceLabel.trim() : undefined,
      path: kind === "local_file" ? path.trim() : undefined,
    };
  }

  async function acquire() {
    setErr(""); setAcquiring(true); setAcquireResult(null);
    try {
      const r = await api.acquireOmni([buildSpec()]);
      setAcquireResult({ total: r.total, report: r.report });
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setAcquiring(false);
    }
  }

  async function publish() {
    if (!name.trim()) { setErr("Name the dataset before publishing."); return; }
    setErr(""); setPublishing(true);
    try {
      const r = await api.publishOmniDataset({ name: name.trim(), sources: [buildSpec()], sector: sector.trim() || undefined });
      if (r.note && !r.published) { setErr(r.note); return; }
      onPublished();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setPublishing(false);
    }
  }

  return (
    <Card className="mb-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-cream-300/60">Source kind</label>
            <select value={kind} onChange={e => { setKind(e.target.value as OmniSourceKind); setAcquireResult(null); }} className="text-sm border rounded px-2 py-1 bg-ink-900 border-ink-800 text-cream-100">
              {kinds.map(k => <option key={k.kind} value={k.kind}>{k.kind} — {k.description}</option>)}
            </select>
            {needs && <span className="text-[10px] text-cream-300/40">needs: {needs}</span>}
          </div>

          {(kind === "web_search" || kind === "vault") && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-cream-300/60">Query</label>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="e.g. Africa AI funding 2026" className="text-sm border rounded px-2 py-1 bg-ink-900 border-ink-800 text-cream-100" />
            </div>
          )}
          {kind === "web_page" && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-cream-300/60">URLs (comma-separated)</label>
              <input value={urls} onChange={e => setUrls(e.target.value)} placeholder="https://..., https://..." className="text-sm border rounded px-2 py-1 bg-ink-900 border-ink-800 text-cream-100" />
            </div>
          )}
          {kind === "db" && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-cream-300/60">Data source label</label>
                <input value={sourceLabel} onChange={e => setSourceLabel(e.target.value)} placeholder="from the Library connections tab" className="text-sm border rounded px-2 py-1 bg-ink-900 border-ink-800 text-cream-100" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-cream-300/60">SQL query</label>
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="select * from ..." className="text-sm border rounded px-2 py-1 bg-ink-900 border-ink-800 text-cream-100 font-mono" />
              </div>
            </>
          )}
          {kind === "local_file" && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-cream-300/60">File path</label>
              <input value={path} onChange={e => setPath(e.target.value)} placeholder="C:\path\to\file.pdf" className="text-sm border rounded px-2 py-1 bg-ink-900 border-ink-800 text-cream-100" />
            </div>
          )}

          <Button variant="subtle" onClick={acquire} disabled={acquiring}>
            {acquiring ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Acquire (preview)
          </Button>
        </div>

        <div className="space-y-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-cream-300/60">Dataset name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Africa AI news — Sept 2026" className="text-sm border rounded px-2 py-1 bg-ink-900 border-ink-800 text-cream-100" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-cream-300/60">Sector (optional)</label>
            <input value={sector} onChange={e => setSector(e.target.value)} placeholder="optional tag" className="text-sm border rounded px-2 py-1 bg-ink-900 border-ink-800 text-cream-100" />
          </div>

          {acquireResult && (
            <div className="text-xs text-cream-300/70 bg-ink-900 border border-ink-800 rounded-lg px-3 py-2">
              {acquireResult.total} record{acquireResult.total === 1 ? "" : "s"} acquired.
              {acquireResult.report.some(r => r.error) && (
                <div className="text-flame-400 mt-1">{acquireResult.report.filter(r => r.error).map(r => r.error).join("; ")}</div>
              )}
            </div>
          )}
          {err && <div className="text-xs text-coral-400 bg-coral-500/10 border border-coral-500/30 rounded-lg px-3 py-2">{err}</div>}

          <Button variant="primary" onClick={publish} disabled={publishing || !acquireResult || acquireResult.total === 0}>
            {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />} Publish dataset
          </Button>
        </div>
      </div>
    </Card>
  );
}
