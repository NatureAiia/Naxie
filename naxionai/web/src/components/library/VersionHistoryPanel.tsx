import { useEffect, useState } from "react";
import { History, Loader2, X } from "lucide-react";
import { api } from "../../lib/api";
import { VersionDiffView } from "./VersionDiffView";

type Version = { commitHash: string; commitDate: string; author: string; commitMessage: string };

// Operator-friendly relative time — same style as Runs.tsx's friendlyTimeAgo,
// duplicated locally rather than exported/shared since it's a one-liner and
// the two callers format slightly different inputs (Date object vs. this
// component's raw ISO string from git).
function relativeDate(iso: string): string {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return d.toLocaleDateString();
}

// Fetches this vault file's git history on mount, lets the operator pick a
// "from" commit and either a "to" commit or the current working copy, then
// fetches the diff and shows it in a hand-rolled modal (this codebase has no
// shared Modal component — every page rolls its own overlay; this matches
// the pattern in Crm.tsx / Brands.tsx).
export function VersionHistoryPanel({ path }: { path: string }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fromHash, setFromHash] = useState<string | null>(null);
  const [toHash, setToHash] = useState<string>("WORKING");
  const [diff, setDiff] = useState<{ before: string | null; after: string | null } | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setVersions(null);
    setError(null);
    setFromHash(null);
    setToHash("WORKING");
    setDiff(null);
    setDiffError(null);
    setShowModal(false);
    api.brainHistory(path)
      .then(r => {
        if (cancelled) return;
        setVersions(r.versions);
        // Default to comparing the previous version against the current one
        // — the single most useful diff ("what changed last edit").
        setFromHash(r.versions[1]?.commitHash ?? r.versions[0]?.commitHash ?? null);
      })
      .catch(e => { if (!cancelled) setError(e?.message ?? String(e)); });
    return () => { cancelled = true; };
  }, [path]);

  async function compare() {
    if (!fromHash || diffBusy) return;
    setDiffBusy(true);
    setDiffError(null);
    try {
      const r = await api.brainDiff(path, fromHash, toHash);
      setDiff({ before: r.before, after: r.after });
      setShowModal(true);
    } catch (e: any) {
      setDiffError(e?.message ?? String(e));
    } finally {
      setDiffBusy(false);
    }
  }

  if (error) {
    return <div className="text-xs text-coral-400 px-1">Could not load history: {error}</div>;
  }
  if (versions === null) {
    return <div className="text-xs text-cream-300/50 px-1">Loading history…</div>;
  }
  if (versions.length <= 1) {
    return <div className="text-xs text-cream-300/50 px-1">No earlier versions yet.</div>;
  }

  return (
    <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-wider text-cream-300/50">Version history</div>
        <button
          type="button"
          onClick={compare}
          disabled={diffBusy || !fromHash}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-violet-500/15 border border-violet-500/40 text-violet-300 hover:bg-violet-500/25 disabled:opacity-40"
        >
          {diffBusy ? <Loader2 size={12} className="animate-spin" /> : <History size={12} />}
          {diffBusy ? "Comparing…" : "Compare"}
        </button>
      </div>
      {diffError && <div className="text-[11px] text-coral-400">{diffError}</div>}
      <div className="text-[10px] text-cream-300/40 flex gap-6 px-2">
        <span>From</span>
        <span>To</span>
      </div>
      <div className="space-y-0.5 max-h-64 overflow-auto">
        {versions.map(v => (
          <div key={v.commitHash} className="flex items-center gap-3 text-xs px-2 py-1.5 rounded-md hover:bg-ink-900/60">
            <input
              type="radio"
              name="version-diff-from"
              checked={fromHash === v.commitHash}
              onChange={() => setFromHash(v.commitHash)}
              title="Compare from this version"
            />
            <input
              type="radio"
              name="version-diff-to"
              checked={toHash === v.commitHash}
              onChange={() => setToHash(v.commitHash)}
              title="Compare to this version"
            />
            <span className="font-mono text-cream-300/40">{v.commitHash.slice(0, 7)}</span>
            <span className="text-cream-100 truncate flex-1">{v.commitMessage || "(no message)"}</span>
            <span className="text-cream-300/50 whitespace-nowrap">{v.author}</span>
            <span className="text-cream-300/40 whitespace-nowrap">{relativeDate(v.commitDate)}</span>
          </div>
        ))}
        <div className="flex items-center gap-3 text-xs px-2 py-1.5 rounded-md hover:bg-ink-900/60">
          <input type="radio" disabled className="opacity-20" title="the working copy has no further edits to diff from" />
          <input
            type="radio"
            name="version-diff-to"
            checked={toHash === "WORKING"}
            onChange={() => setToHash("WORKING")}
            title="Compare to the current (working) copy"
          />
          <span className="text-leaf-400">Current (working copy)</span>
        </div>
      </div>

      {showModal && diff && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-auto" onClick={() => setShowModal(false)}>
          <div className="w-full max-w-3xl bg-ink-900 border border-ink-700 rounded-2xl p-5 space-y-3 my-8" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg text-cream-50 font-medium">
                Diff · <span className="font-mono">{fromHash?.slice(0, 7)}</span> → {toHash === "WORKING" ? "working copy" : <span className="font-mono">{toHash.slice(0, 7)}</span>}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
            </div>
            <div className="max-h-[70vh] overflow-auto">
              <VersionDiffView before={diff.before ?? ""} after={diff.after ?? ""} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
