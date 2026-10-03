import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Database, Folder, Sparkles } from "lucide-react";
import { api, type FileBackendId, type FileEntry, type User } from "../lib/api";
import { FileExplorer } from "../components/FileExplorer";
import { VaultHealthBanner, type VaultHealth } from "../components/library/VaultHealthBanner";
import { LibrarySearch } from "../components/library/LibrarySearch";
import { MarkdownPreviewPanel } from "../components/library/MarkdownPreviewPanel";
import { PromoteBar } from "../components/library/PromoteBar";
import { ImportsActions } from "../components/library/ImportsActions";
import { LibraryConnections } from "../components/library/LibraryConnections";
import { CompanyLinksPanel } from "../components/library/CompanyLinksPanel";
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

// Connections/Datasets tabs live at their own URL so gating (Connections) and
// deep-linking apply the same whether the user clicks the tab or hits the
// URL directly.
const CONNECTIONS_PATH = "/library/data";
const DATASETS_PATH = "/library/datasets";

export function Library() {
  const nav = useNavigate();
  const loc = useLocation();

  // ---- access gating (mirrors Layout.tsx's layer computation) ----
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => { api.session().then(s => setUser(s.user)).catch(() => setUser(null)); }, []);
  const role = (user?.role ?? "") as string;
  const layer = !user ? "superadmin" : role === "superadmin" ? "superadmin" : role === "admin" ? "admin" : "staff";
  const canSeeConnections = layer !== "staff";

  const onConnectionsRoute = loc.pathname === CONNECTIONS_PATH || loc.pathname.startsWith(CONNECTIONS_PATH + "/");
  const onDatasetsRoute = loc.pathname === DATASETS_PATH || loc.pathname.startsWith(DATASETS_PATH + "/");
  const tab: "files" | "connections" | "datasets" =
    onConnectionsRoute && canSeeConnections ? "connections" : onDatasetsRoute ? "datasets" : "files";

  // ---- vault deep-linking (Files tab, vault backend only) ----
  // FileExplorer owns its own path/selection state internally (no controlled
  // path prop — see components/FileExplorer.tsx), so we can mirror the URL
  // one level: a URL that names a previewable vault file loads + shows that
  // file's content directly here, and selecting a previewable vault file in
  // FileExplorer pushes the URL to match. Folder browsing stays FileExplorer's
  // own client-side state, same as every other backend.
  const subPath = !onConnectionsRoute && !onDatasetsRoute ? decodePath(loc.pathname.replace(/^\/library\/?/, "")) : "";

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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-cream-50">Library</h1>
        <p className="text-sm text-cream-300/70 mt-1">
          Every storage location in one file explorer — the Obsidian vault, a sandboxed local-disk folder, and (once connected) Google Drive or Supabase.
          {canSeeConnections && " Plus company database connections and curated department data for agents to query."}
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-ink-800">
        <button
          type="button"
          onClick={() => nav("/library")}
          className={`flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 -mb-px ${tab === "files" ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-100"}`}
        >
          <Folder size={14} /> Files
        </button>
        {canSeeConnections && (
          <button
            type="button"
            onClick={() => nav(CONNECTIONS_PATH)}
            className={`flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 -mb-px ${tab === "connections" ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-100"}`}
          >
            <Database size={14} /> Connections
          </button>
        )}
        <button
          type="button"
          onClick={() => nav(DATASETS_PATH)}
          className={`flex items-center gap-1.5 text-sm px-3 py-2 border-b-2 -mb-px ${tab === "datasets" ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-100"}`}
        >
          <Sparkles size={14} /> Datasets
        </button>
      </div>

      {tab === "connections" ? (
        canSeeConnections ? (
          <div className="space-y-4">
            <LibraryConnections />
            <CompanyLinksPanel />
          </div>
        ) : (
          <div className="text-sm text-cream-300/70 bg-ink-900 border border-ink-800 rounded-lg px-4 py-3">
            You don't have permission to view database connections. Ask an admin for access.
          </div>
        )
      ) : tab === "datasets" ? (
        <DatasetsPanel />
      ) : (
        <div className="space-y-4">
          {showVaultChrome && <VaultHealthBanner vaultHealth={vaultHealth} onRetry={retryVaultHealth} />}
          {showVaultChrome && <LibrarySearch onNavigateToResult={(path) => nav("/library/" + path)} />}
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
