import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { BookOpen, Folder, HardDrive, Search, Sparkles } from "lucide-react";
import { api, type FileBackendId, type FileEntry } from "../lib/api";
import { FileExplorer } from "../components/FileExplorer";
import { VaultHealthBanner, type VaultHealth } from "../components/library/VaultHealthBanner";
import { LibrarySearch } from "../components/library/LibrarySearch";
import { MarkdownPreviewPanel } from "../components/library/MarkdownPreviewPanel";
import { PromoteBar } from "../components/library/PromoteBar";
import { ImportsActions } from "../components/library/ImportsActions";
import { DatasetsPanel } from "../components/library/DatasetsPanel";

// The vault path lives in the URL (e.g. /library/Naxie%20Data%20Migration.md)
// so spaces arrive percent-encoded. Decode ONCE here — otherwise api.brainFile()
// re-encodes it and the server tries to open a literal "%20" path → ENOENT.
function decodePath(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}

function isPreviewable(name: string): boolean {
  return name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".json");
}

// The Datasets tab lives at its own URL so deep-linking works whether the
// user clicks the tab or hits the URL directly. Database connections moved
// to the Connectors page (tab "databases").
const DATASETS_PATH = "/library/datasets";

export function Library() {
  const nav = useNavigate();
  const loc = useLocation();

  const onDatasetsRoute = loc.pathname === DATASETS_PATH || loc.pathname.startsWith(DATASETS_PATH + "/");
  const tab: "files" | "datasets" = onDatasetsRoute ? "datasets" : "files";

  // ---- vault deep-linking (Files tab, vault backend only) ----
  // FileExplorer owns its own path/selection state internally (no controlled
  // path prop — see components/FileExplorer.tsx), so we can mirror the URL
  // one level: a URL that names a previewable vault file loads + shows that
  // file's content directly here, and selecting a previewable vault file in
  // FileExplorer pushes the URL to match. Folder browsing stays FileExplorer's
  // own client-side state, same as every other backend.
  const subPath = !onDatasetsRoute ? decodePath(loc.pathname.replace(/^\/library\/?/, "")) : "";

  const [sel, setSel] = useState<{ backend: FileBackendId; path: string; entries: FileEntry[]; selectedEntry: FileEntry | null }>(
    { backend: "vault", path: "", entries: [], selectedEntry: null },
  );
  const [vaultHealth, setVaultHealth] = useState<VaultHealth | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentErr, setContentErr] = useState("");

  useEffect(() => {
    if (tab !== "files") return;
    api.brainHealth().then(setVaultHealth).catch(() => setVaultHealth(null));
  }, [tab, subPath]);

  async function retryVaultHealth() {
    try { const h = await api.brainHealth(); setVaultHealth(h); } catch { /* tolerate */ }
  }

  // URL → content: a deep link naming a previewable file loads it directly
  // (independent of whatever folder FileExplorer itself is browsing).
  useEffect(() => {
    if (tab !== "files") return;
    setContentErr("");
    if (subPath && isPreviewable(subPath)) {
      api.brainFile(subPath).then(r => setContent(r.content)).catch(e => { setContent(null); setContentErr(e.message); });
    } else {
      setContent(null);
    }
  }, [tab, subPath]);

  // Selection → URL: opening (double-click) or selecting a previewable vault
  // file pushes /library/<path> so the link is shareable/bookmarkable and the
  // browser back button works, mirroring Knowledge.tsx's old behavior.
  function onSelectionChange(next: { backend: FileBackendId; path: string; entries: FileEntry[]; selectedEntry: FileEntry | null }) {
    setSel(next);
    if (next.backend === "vault" && next.selectedEntry?.type === "file" && isPreviewable(next.selectedEntry.name)) {
      const target = "/library/" + next.selectedEntry.path;
      if (loc.pathname !== target) nav(target);
    }
  }

  const showVaultChrome = tab === "files" && sel.backend === "vault";
  const previewPath = subPath && isPreviewable(subPath) ? subPath : (sel.selectedEntry && isPreviewable(sel.selectedEntry.name) ? sel.selectedEntry.path : "");
  // A deep link naming a folder (not a previewable file) has nowhere else to
  // go — hand it to FileExplorer as its starting position so e.g. an old
  // /knowledge/_naxie link lands browsing that vault folder instead of root.
  const initialPath = subPath && !isPreviewable(subPath) ? { backend: "vault" as const, path: subPath } : undefined;

  return (
    <div className="space-y-5 pb-4">
      <section className="relative isolate overflow-hidden rounded-3xl border border-ink-700/80 bg-gradient-to-br from-[#1a202a] via-ink-900 to-[#1c1828] p-5 shadow-[0_24px_80px_-48px_rgba(95,191,169,.3)] tablet:p-7">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-28 h-72 w-72 rounded-full bg-teal-400/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute bottom-[-9rem] right-[28%] h-64 w-64 rounded-full bg-violet-500/[0.12] blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-teal-300/20 bg-teal-300/10 text-teal-200 shadow-[inset_0_1px_0_rgba(255,255,255,.08)]"><BookOpen size={22} /></div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-teal-200/80">Memory & knowledge</span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-600 bg-ink-950/40 px-2 py-1 text-[10px] text-cream-200/70"><HardDrive size={11} /> Storage locations</span>
              </div>
              <h1 className="mt-2 font-display text-3xl tracking-tight text-cream-50 tablet:text-4xl">Knowledge, in one place.</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-cream-200/70">Search, browse, and shape the information your team works from—across your vault and connected storage.</p>
            </div>
          </div>
        </div>

        <div role="group" aria-label="Knowledge workspace" className="relative mt-6 inline-flex max-w-full rounded-xl border border-ink-700 bg-ink-950/60 p-1">
          <button
            type="button"
            aria-pressed={tab === "files"}
            onClick={() => nav("/library")}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-medium transition-colors ${tab === "files" ? "bg-ink-700 text-cream-50 shadow-sm" : "text-cream-300/65 hover:text-cream-100"}`}
          >
            <Folder size={14} /> Files
          </button>
          <button
            type="button"
            aria-pressed={tab === "datasets"}
            onClick={() => nav(DATASETS_PATH)}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-medium transition-colors ${tab === "datasets" ? "bg-ink-700 text-cream-50 shadow-sm" : "text-cream-300/65 hover:text-cream-100"}`}
          >
            <Sparkles size={14} /> Datasets
          </button>
        </div>
      </section>

      {tab === "datasets" ? (
        <DatasetsPanel />
      ) : (
        <div className="space-y-4">
          {showVaultChrome && <VaultHealthBanner vaultHealth={vaultHealth} onRetry={retryVaultHealth} />}
          {showVaultChrome && (
            <section className="rounded-2xl border border-ink-700/80 bg-gradient-to-br from-ink-900/90 to-ink-850/70 p-4 tablet:p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-teal-400/10 text-teal-200"><Search size={15} /></span>
                  <div>
                    <h2 className="text-sm font-semibold text-cream-50">Search your vault</h2>
                    <p className="text-[11px] text-cream-300/55">Find a phrase across your saved notes and files.</p>
                  </div>
                </div>
                <kbd className="hidden rounded-md border border-ink-700 bg-ink-950/60 px-2 py-1 text-[10px] text-cream-300/60 tablet:inline">/ to search</kbd>
              </div>
              <LibrarySearch onNavigateToResult={(path) => nav("/library/" + path)} />
            </section>
          )}
          {contentErr && <div className="text-coral-400 text-sm">{contentErr}</div>}

          {showVaultChrome && content !== null && previewPath ? (
            <MarkdownPreviewPanel path={previewPath} content={content}>
              <PromoteBar path={previewPath} onPromoted={(to) => nav("/library/" + to)} />
              <ImportsActions
                path={previewPath}
                onChange={() => {
                  const up = previewPath.split("/").slice(0, -1).join("/");
                  nav("/library/" + up);
                }}
              />
            </MarkdownPreviewPanel>
          ) : null}

          <FileExplorer onSelectionChange={onSelectionChange} initialPath={initialPath} />
        </div>
      )}
    </div>
  );
}
