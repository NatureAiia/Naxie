import { useState } from "react";
import { api } from "../../lib/api";

// Toolbar shown on a file open under _imports/. The bulk-import flow drops
// 880+ files in there with content-less sidecars; this lets the user act on
// each one without leaving the Library browser:
//   - Process — kicks off the extractor job that fills sidecars with PDF/DOCX text
//   - Promote — re-uses the 2-Permanent flow (sidecar becomes a permanent note)
//   - Discard — deletes BOTH sidecar + binary (only legal under _imports/)
// Moved verbatim from Knowledge.tsx — same gating, same api.brain* calls.
export function ImportsActions({ path, onChange }: { path: string; onChange: () => void }) {
  const [busy, setBusy] = useState<"process" | "discard" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!path.startsWith("_imports/") || !path.endsWith(".md")) return null;

  async function discard() {
    if (!confirm("Delete this sidecar AND the original binary file? This can't be undone (unless you re-bulk-import).")) return;
    setBusy("discard"); setErr(null); setMsg(null);
    try {
      const r = await api.brainDiscard(path);
      setMsg(`Deleted ${r.count} file${r.count === 1 ? "" : "s"}.`);
      setTimeout(onChange, 800);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  }
  async function process() {
    setBusy("process"); setErr(null); setMsg(null);
    try {
      const r = await api.brainProcessImports("_imports");
      setMsg(`Extractor job ${r.jobId.slice(0, 8)} started — refresh in a minute to see content.`);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(null); }
  }
  return (
    <div className="flex items-center gap-3 mb-4 pb-4 border-b border-ink-800 flex-wrap">
      <div className="text-[10px] uppercase tracking-wider text-cream-300/50">Imported file</div>
      <button
        type="button"
        onClick={process}
        disabled={busy !== null}
        title="Extract text from every binary in _imports/ into its sidecar (runs once across the whole folder)"
        className="text-xs px-3 py-1.5 rounded-md bg-violet-500/15 border border-violet-500/40 text-violet-300 hover:bg-violet-500/25 disabled:opacity-40"
      >
        {busy === "process" ? "Starting…" : "Process imports →"}
      </button>
      <button
        type="button"
        onClick={discard}
        disabled={busy !== null}
        title="Delete this sidecar AND its source binary"
        className="text-xs px-3 py-1.5 rounded-md bg-coral-500/15 border border-coral-500/40 text-coral-300 hover:bg-coral-500/25 disabled:opacity-40"
      >
        {busy === "discard" ? "Deleting…" : "Discard"}
      </button>
      {msg && <span className="text-[11px] text-leaf-400">{msg}</span>}
      {err && <span className="text-[11px] text-coral-400">{err}</span>}
      <span className="text-[11px] text-cream-300/40">Promote moves a content-bearing sidecar into 2-Permanent/.</span>
    </div>
  );
}
