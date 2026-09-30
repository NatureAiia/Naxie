import { useState } from "react";
import { api } from "../../lib/api";

// Show "Promote to 2-Permanent" affordance ONLY for fleeting notes in
// 0-Inbox/ (and imported sidecars once they have content) — that's the
// explicit Zettelkasten flow. Moved verbatim from Knowledge.tsx; the
// `nav()` call becomes an `onPromoted(toPath)` callback so the parent
// decides how to navigate (Library.tsx maps it to /library/<path>).
export function PromoteBar({ path, onPromoted }: { path: string; onPromoted: (toPath: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Promote is legal for fleeting captures (0-Inbox/) AND for imported sidecars
  // once they have content (_imports/ post-process). Other vault folders are
  // intentionally excluded — promoting them would create accidental duplicates.
  if (!path.endsWith(".md")) return null;
  if (!path.startsWith("0-Inbox/") && !path.startsWith("_imports/")) return null;
  async function promote() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.brainPromote(path);
      setDone(r.to);
      setTimeout(() => onPromoted(r.to), 1200);
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex items-center gap-3 mb-4 pb-4 border-b border-ink-800 flex-wrap">
      <div className="text-[10px] uppercase tracking-wider text-cream-300/50">Fleeting note in 0-Inbox</div>
      {done ? (
        <span className="text-[11px] text-leaf-400">✓ promoted to <span className="font-mono">{done}</span></span>
      ) : err ? (
        <span className="text-[11px] text-coral-400">{err}</span>
      ) : (
        <button
          type="button"
          onClick={promote}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-md bg-violet-500/15 border border-violet-500/40 text-violet-300 hover:bg-violet-500/25 disabled:opacity-40"
        >
          {busy ? "Promoting…" : "Promote to 2-Permanent →"}
        </button>
      )}
      <span className="text-[11px] text-cream-300/40">Rewrites frontmatter with a Zettel id and archives the original.</span>
    </div>
  );
}
