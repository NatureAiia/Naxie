import { useState } from "react";
import { api } from "../../lib/api";
import { Card } from "../Card";

// Vault full-text search box + results list. Moved out of Knowledge.tsx —
// navigation to a hit is now a callback so the parent decides the route
// (Library.tsx maps it to /library/<path>).
export function LibrarySearch({ onNavigateToResult }: { onNavigateToResult: (path: string) => void }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<{ path: string; line: number; preview: string }[] | null>(null);
  const [err, setErr] = useState("");

  async function doSearch() {
    if (!search.trim()) { setResults(null); return; }
    try { const r = await api.brainSearch(search.trim()); setResults(r.results); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <>
      <div className="flex gap-2">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === "Enter" && doSearch()}
          placeholder="search knowledge…"
          className="flex-1 bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-violet-500"
        />
        <button onClick={doSearch} className="px-4 py-2 rounded-md bg-violet-500 hover:bg-violet-600 text-white text-sm">Search</button>
        {results && <button onClick={() => { setResults(null); setSearch(""); }} className="text-xs text-cream-300 hover:text-cream-100">clear</button>}
      </div>

      {err && <div className="text-coral-400 text-sm">{err}</div>}

      {results !== null && (
        <Card title={`${results.length} match${results.length === 1 ? "" : "es"}`}>
          {results.length === 0 && <div className="text-xs text-cream-300/60">No matches.</div>}
          <ul className="space-y-2">
            {results.map((r, i) => (
              <li key={i} className="text-sm">
                <button onClick={() => onNavigateToResult(r.path)} className="text-violet-400 hover:text-violet-500 font-mono text-xs">{r.path}:{r.line}</button>
                <div className="text-xs text-cream-300/70 mt-0.5">{r.preview}</div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
