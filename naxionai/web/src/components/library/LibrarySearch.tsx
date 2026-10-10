import { useState, useEffect, useRef } from "react";
import { Loader2, Search as SearchIcon, X } from "lucide-react";
import { api } from "../../lib/api";
import { Card } from "../Card";

// Vault full-text search box + results list. Moved out of Knowledge.tsx —
// navigation to a hit is now a callback so the parent decides the route
// (Library.tsx maps it to /library/<path>).
export function LibrarySearch({ onNavigateToResult }: { onNavigateToResult: (path: string) => void }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<{ path: string; line: number; preview: string }[] | null>(null);
  const [err, setErr] = useState("");
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function doSearch() {
    if (!search.trim()) { setResults(null); return; }
    setSearching(true);
    setErr("");
    try { const r = await api.brainSearch(search.trim()); setResults(r.results); }
    catch (e: any) { setErr(e.message); setResults(null); }
    finally { setSearching(false); }
  }

  return (
    <>
      <form onSubmit={event => { event.preventDefault(); void doSearch(); }} className="flex flex-col gap-2 tablet:flex-row">
        <input
          ref={inputRef}
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Search the knowledge vault"
          placeholder="Search notes, decisions, and reference material…"
          className="min-w-0 flex-1 rounded-xl border border-ink-700 bg-ink-950/80 px-4 py-3 text-sm text-cream-100 placeholder:text-cream-300/40 focus:border-teal-300/60 focus:outline-none focus:ring-2 focus:ring-teal-300/10"
        />
        <button type="submit" disabled={searching || !search.trim()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-teal-200/15 bg-gradient-to-r from-teal-500 to-teal-600 px-5 text-sm font-semibold text-[#071512] shadow-[0_8px_24px_-12px_rgba(95,191,169,.75)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50">
          {searching ? <Loader2 size={15} className="animate-spin" /> : <SearchIcon size={15} />}
          {searching ? "Searching" : "Search vault"}
        </button>
        {results && <button type="button" onClick={() => { setResults(null); setSearch(""); setErr(""); }} aria-label="Clear search" className="inline-flex items-center justify-center gap-1 rounded-xl px-3 text-xs text-cream-300 hover:bg-ink-800 hover:text-cream-100"><X size={13} /> Clear</button>}
      </form>

      {err && <div role="alert" className="mt-3 rounded-lg border border-coral-400/20 bg-coral-400/[0.06] px-3 py-2 text-sm text-coral-200">{err}</div>}

      {results !== null && (
        <Card title={<span role="status">{results.length} result{results.length === 1 ? "" : "s"}</span>} className="mt-3 border border-ink-700/70">
          {results.length === 0 && <div className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center text-xs text-cream-300/60">No matches yet. Try a broader phrase or a different keyword.</div>}
          <ul className="space-y-1">
            {results.map((r, i) => (
              <li key={i} className="rounded-xl border border-transparent p-3 transition-colors hover:border-ink-700 hover:bg-ink-800/35">
                <button type="button" onClick={() => onNavigateToResult(r.path)} className="font-mono text-xs text-teal-200 hover:text-teal-100 nw-haptic-press">{r.path}:{r.line}</button>
                <div className="mt-1 text-xs leading-relaxed text-cream-200/75">{r.preview}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
