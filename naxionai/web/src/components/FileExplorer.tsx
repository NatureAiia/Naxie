import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight, ChevronDown, Folder, FolderPlus, Download, Trash2, Pencil,
  RefreshCw, HardDrive, Cloud, Database as DatabaseIcon, Upload as UploadIcon,
} from "lucide-react";
import { api, type FileBackendId, type FileBackendInfo, type FileEntry } from "../lib/api";
import { FileIcon } from "./FileIcon";
import { showToast } from "./Card";
import { Tooltip } from "./Tooltip";

const DRAG_MIME = "application/x-naxie-file";
type DragPayload = { backend: FileBackendId; paths: string[] };

function fmtSize(n?: number): string {
  if (n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  return btoa(binary);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

const BACKEND_ICON: Record<FileBackendId, any> = {
  vault: Folder,
  localdisk: HardDrive,
  drive: Cloud,
  supabase: DatabaseIcon,
};

export type FileExplorerProps = {
  // Fires whenever backend / path / selection changes so a parent (e.g. the
  // Library page) can render backend-specific chrome (health banner, search,
  // markdown preview) without FileExplorer itself knowing about any of that.
  onSelectionChange?: (sel: { backend: FileBackendId; path: string; entries: FileEntry[]; selectedEntry: FileEntry | null }) => void;
  // Lets a parent inject extra controls into the toolbar row (next to
  // Refresh/breadcrumb) without forking this component.
  renderOverlay?: (ctx: { backend: FileBackendId; path: string; selectedEntry: FileEntry | null }) => React.ReactNode;
  // Where to start browsing on first mount (e.g. a deep link to a vault
  // folder). Read once via useState's lazy initializer — not a controlled
  // prop, so it never fights the user's own navigation afterward.
  initialPath?: { backend: FileBackendId; path: string };
};

export function FileExplorer({ onSelectionChange, renderOverlay, initialPath }: FileExplorerProps = {}) {
  const [backends, setBackends] = useState<FileBackendInfo[]>([]);
  const [backend, setBackend] = useState<FileBackendId>(() => initialPath?.backend ?? "vault");
  const [path, setPath] = useState(() => initialPath?.path ?? "");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClickIdx, setLastClickIdx] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null); // path being hovered as drop target ("" = current folder)
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const active = backends.find(b => b.id === backend);
  const unavailable = active?.kind === "unavailable";

  const refreshBackends = useCallback(async () => {
    try { const r = await api.filesBackends(); setBackends(r.backends); } catch {}
  }, []);
  const refreshEntries = useCallback(async () => {
    if (unavailable) { setEntries([]); return; }
    setLoading(true); setErr(null);
    try {
      const r = await api.filesList(backend, path);
      setEntries(r.entries);
    } catch (e: any) { setErr(e?.message ?? String(e)); setEntries([]); }
    finally { setLoading(false); }
  }, [backend, path, unavailable]);

  useEffect(() => { void refreshBackends(); }, [refreshBackends]);
  useEffect(() => { void refreshEntries(); setSelected(new Set()); }, [refreshEntries]);
  useEffect(() => {
    function closeMenu() { setMenu(null); }
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, []);

  // Report backend/path/selection to the parent whenever any of them change
  // (including a fresh entries list — the selected paths may now resolve to
  // different FileEntry objects, e.g. after a rename/refresh).
  const selectedEntry = selected.size === 1 ? (entries.find(e => e.path === Array.from(selected)[0]) ?? null) : null;
  useEffect(() => {
    onSelectionChange?.({ backend, path, entries, selectedEntry });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, path, entries, selected]);

  function switchBackend(id: FileBackendId) {
    setBackend(id); setPath(""); setMenu(null);
  }

  function openEntry(e: FileEntry) {
    if (e.type === "dir") { setPath(e.path); return; }
    // Vault text files: double-click selects (rather than no-op'ing) so a
    // parent watching onSelectionChange's selectedEntry can render a preview
    // (see Library.tsx's MarkdownPreviewPanel). Every other backend/file type
    // keeps the previous no-op double-click behavior.
    if (backend === "vault" && (e.name.endsWith(".md") || e.name.endsWith(".txt") || e.name.endsWith(".json"))) {
      setSelected(new Set([e.path]));
    }
  }

  function onRowClick(e: FileEntry, idx: number, ev: React.MouseEvent) {
    ev.stopPropagation();
    if (ev.shiftKey && lastClickIdx !== null) {
      const [a, b] = [lastClickIdx, idx].sort((x, y) => x - y);
      setSelected(new Set(entries.slice(a, b + 1).map(x => x.path)));
    } else if (ev.ctrlKey || ev.metaKey) {
      setSelected(prev => {
        const next = new Set(prev);
        if (next.has(e.path)) next.delete(e.path); else next.add(e.path);
        return next;
      });
      setLastClickIdx(idx);
    } else {
      setSelected(new Set([e.path]));
      setLastClickIdx(idx);
    }
  }

  // ---- drag and drop ----
  function onDragStart(e: FileEntry, ev: React.DragEvent) {
    const paths = selected.has(e.path) && selected.size > 1 ? Array.from(selected) : [e.path];
    const payload: DragPayload = { backend, paths };
    ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    ev.dataTransfer.setData("text/plain", paths.join(", "));
    ev.dataTransfer.effectAllowed = "move";
  }

  // destBackend is explicit (not read from `backend` state) so dropping onto
  // a DIFFERENT backend's sidebar row works correctly even though switching
  // panes via setBackend() wouldn't take effect until the next render.
  async function handleDrop(destBackend: FileBackendId, destFolder: string, ev: React.DragEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    setDragOver(null);
    const destInfo = backends.find(b => b.id === destBackend);
    if (destInfo?.kind === "unavailable") { showToast(`${destInfo.label} isn't connected yet`, "error"); return; }

    const raw = ev.dataTransfer.getData(DRAG_MIME);
    if (raw) {
      let payload: DragPayload;
      try { payload = JSON.parse(raw); } catch { return; }
      if (payload.paths.every(p => dirname(p) === destFolder) && payload.backend === destBackend) return; // no-op, already there
      let moved = 0;
      for (const srcPath of payload.paths) {
        const dstPath = joinPath(destFolder, basename(srcPath));
        try {
          if (payload.backend === destBackend) await api.filesMove(destBackend, srcPath, dstPath);
          else await api.filesTransfer(payload.backend, srcPath, destBackend, dstPath);
          moved++;
        } catch (e: any) { showToast(e?.message ?? String(e), "error", 4000); }
      }
      if (moved) { showToast(`Moved ${moved} item${moved === 1 ? "" : "s"}`, "success"); if (destBackend === backend) await refreshEntries(); }
      return;
    }

    // Native OS files dragged in.
    const files = Array.from(ev.dataTransfer.files ?? []);
    if (files.length === 0) return;
    let uploaded = 0;
    for (const file of files) {
      try {
        const contentBase64 = await fileToBase64(file);
        await api.filesUpload({ backend: destBackend, path: destFolder, filename: file.name, contentBase64 });
        uploaded++;
      } catch (e: any) { showToast(`${file.name}: ${e?.message ?? String(e)}`, "error", 4000); }
    }
    if (uploaded) { showToast(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}`, "success"); if (destBackend === backend) await refreshEntries(); }
  }

  async function handlePickFiles(ev: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(ev.target.files ?? []);
    ev.target.value = "";
    let uploaded = 0;
    for (const file of files) {
      try {
        const contentBase64 = await fileToBase64(file);
        await api.filesUpload({ backend, path, filename: file.name, contentBase64 });
        uploaded++;
      } catch (e: any) { showToast(`${file.name}: ${e?.message ?? String(e)}`, "error", 4000); }
    }
    if (uploaded) { showToast(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}`, "success"); await refreshEntries(); }
  }

  async function submitRename(e: FileEntry) {
    const name = renameValue.trim();
    setRenaming(null);
    if (!name || name === e.name) return;
    try {
      await api.filesMove(backend, e.path, joinPath(dirname(e.path), name));
      showToast(`Renamed to ${name}`, "success");
      await refreshEntries();
    } catch (err: any) { showToast(err?.message ?? String(err), "error"); }
  }

  async function deleteEntry(e: FileEntry) {
    if (!confirm(`Delete "${e.name}"? ${e.type === "dir" ? "This deletes everything inside it. " : ""}This can't be undone.`)) return;
    try {
      await api.filesDelete(backend, e.path);
      showToast(`Deleted ${e.name}`, "success");
      await refreshEntries();
    } catch (err: any) { showToast(err?.message ?? String(err), "error"); }
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} selected item${selected.size === 1 ? "" : "s"}? This can't be undone.`)) return;
    let ok = 0;
    for (const p of selected) {
      try { await api.filesDelete(backend, p); ok++; } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    }
    if (ok) { showToast(`Deleted ${ok} item${ok === 1 ? "" : "s"}`, "success"); await refreshEntries(); }
  }

  async function submitNewFolder() {
    const name = newFolderName.trim();
    setCreatingFolder(false); setNewFolderName("");
    if (!name) return;
    try {
      await api.filesMkdir(backend, joinPath(path, name));
      await refreshEntries();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  const segments = path ? path.split("/") : [];

  return (
    <div className="flex h-[72vh] min-h-[500px] flex-col overflow-hidden rounded-2xl border border-violet-500/20 bg-ink-950/90 shadow-[0_0_40px_-20px_rgba(139,92,246,0.22)] tablet:h-[70vh] tablet:min-h-[520px] tablet:flex-row">
      {/* Sidebar: backends + folder tree */}
      <div className="w-full shrink-0 border-b border-violet-500/10 bg-ink-900/50 p-2 tablet:h-full tablet:w-64 tablet:overflow-y-auto tablet:border-b-0 tablet:border-r tablet:bg-ink-900/40 tablet:backdrop-blur-sm">
        <div role="group" aria-label="Storage locations" className="flex gap-1 overflow-x-auto scrollbar-thin tablet:block">
        {backends.map(b => (
          <BackendRow
            key={b.id}
            info={b}
            active={b.id === backend}
            onClick={() => switchBackend(b.id)}
            onDrop={ev => { setBackend(b.id); setPath(""); void handleDrop(b.id, "", ev); }}
          />
        ))}
        </div>
        {backend !== "drive" && backend !== "supabase" && (
          <div className="mt-2 hidden border-t border-ink-800 pt-2 tablet:block">
            <FolderTree
              backend={backend}
              currentPath={path}
              onNavigate={setPath}
              expanded={treeExpanded}
              setExpanded={setTreeExpanded}
              onDropInto={(folderPath, ev) => handleDrop(backend, folderPath, ev)}
              dragOver={dragOver}
              setDragOver={setDragOver}
            />
          </div>
        )}
      </div>

      {/* Main pane */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-violet-500/10 bg-ink-900/30 backdrop-blur-sm">
          <button onClick={() => void refreshEntries()} className="p-1.5 rounded hover:bg-ink-800 text-cream-300/70" title="Refresh"><RefreshCw size={14} /></button>
          <div className="flex-1 flex items-center gap-1 text-xs min-w-0 overflow-x-auto scrollbar-thin">
            <button onClick={() => setPath("")} className="px-1.5 py-0.5 rounded hover:bg-ink-800 text-cream-300/80 shrink-0 font-mono">{active?.label ?? backend}</button>
            {segments.map((s, i) => (
              <span key={i} className="flex items-center gap-1 shrink-0">
                <span className="text-cream-300/30">/</span>
                <button
                  onClick={() => setPath(segments.slice(0, i + 1).join("/"))}
                  onDragOver={ev => { ev.preventDefault(); setDragOver(segments.slice(0, i + 1).join("/")); }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={ev => handleDrop(backend, segments.slice(0, i + 1).join("/"), ev)}
                  className={`px-1.5 py-0.5 rounded hover:bg-ink-800 text-cream-100 font-mono ${dragOver === segments.slice(0, i + 1).join("/") ? "bg-violet-500/20 ring-1 ring-violet-500/50" : ""}`}
                >
                  {s}
                </button>
              </span>
            ))}
          </div>
          {selected.size > 0 && (
            <button onClick={deleteSelected} className="text-xs px-2 py-1 rounded border border-coral-500/40 text-coral-300 hover:bg-coral-500/10 inline-flex items-center gap-1">
              <Trash2 size={12} /> Delete ({selected.size})
            </button>
          )}
          {!unavailable && (
            <>
              <button onClick={() => setCreatingFolder(true)} className="text-xs px-2 py-1 rounded border border-ink-700 text-cream-200 hover:bg-ink-800 inline-flex items-center gap-1">
                <FolderPlus size={12} /> New folder
              </button>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handlePickFiles} />
              <button onClick={() => fileInputRef.current?.click()} className="text-xs px-2 py-1 rounded border border-violet-500/40 text-violet-300 hover:bg-violet-500/10 inline-flex items-center gap-1">
                <UploadIcon size={12} /> Upload
              </button>
            </>
          )}
          {renderOverlay?.({ backend, path, selectedEntry })}
        </div>

        {/* Grid */}
        <div
          className="flex-1 overflow-y-auto scrollbar-thin p-2"
          onClick={() => setSelected(new Set())}
          onDragOver={ev => { if (!unavailable) { ev.preventDefault(); setDragOver(path); } }}
          onDragLeave={() => setDragOver(null)}
          onDrop={ev => handleDrop(backend, path, ev)}
        >
          {unavailable ? (
            <div className="h-full flex items-center justify-center text-sm text-cream-300/50 italic text-center px-8">
              {active?.label} isn't connected yet.<br />{active?.detail}
            </div>
          ) : loading ? (
            <div className="text-sm text-cream-300/50 px-2 py-4">Loading…</div>
          ) : err ? (
            <div className="text-sm text-coral-400 px-2 py-4">{err}</div>
          ) : entries.length === 0 && !creatingFolder ? (
            <div className={`h-full flex items-center justify-center text-sm text-cream-300/40 italic rounded-lg ${dragOver === path ? "bg-violet-500/10 ring-1 ring-violet-500/40" : ""}`}>
              Empty folder — drag files here or click Upload.
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-1">
              {creatingFolder && (
                <div className="flex flex-col items-center gap-1 p-2 rounded-lg">
                  <Folder size={36} className="text-violet-400" />
                  <input
                    autoFocus
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") void submitNewFolder(); if (e.key === "Escape") { setCreatingFolder(false); setNewFolderName(""); } }}
                    onBlur={() => void submitNewFolder()}
                    onClick={e => e.stopPropagation()}
                    placeholder="Folder name"
                    className="w-full bg-ink-900 border border-violet-500/50 rounded px-1 py-0.5 text-[11px] text-cream-100 text-center focus:outline-none"
                  />
                </div>
              )}
              {entries.map((e, idx) => (
                <FileTile
                  key={e.path}
                  entry={e}
                  backend={backend}
                  selected={selected.has(e.path)}
                  dragOver={dragOver === e.path}
                  renaming={renaming === e.path}
                  renameValue={renameValue}
                  setRenameValue={setRenameValue}
                  onDragStart={ev => onDragStart(e, ev)}
                  onDragOver={ev => { if (e.type === "dir") { ev.preventDefault(); ev.stopPropagation(); setDragOver(e.path); } }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={ev => { if (e.type === "dir") { ev.stopPropagation(); void handleDrop(backend, e.path, ev); } }}
                  onClick={ev => onRowClick(e, idx, ev)}
                  onDoubleClick={() => openEntry(e)}
                  onContextMenu={ev => { ev.preventDefault(); ev.stopPropagation(); setSelected(new Set([e.path])); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }); }}
                  onSubmitRename={() => submitRename(e)}
                  onEscapeRename={() => setRenaming(null)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {menu && (
        <div
          className="fixed z-50 bg-ink-900 border border-ink-700 rounded-lg shadow-2xl py-1 min-w-[160px] text-xs"
          style={{ left: menu.x, top: menu.y }}
          onClick={ev => ev.stopPropagation()}
        >
          {menu.entry.type === "dir" && (
            <button onClick={() => { openEntry(menu.entry); setMenu(null); }} className="w-full text-left px-3 py-1.5 hover:bg-ink-800 text-cream-200 flex items-center gap-2"><Folder size={12} /> Open</button>
          )}
          {menu.entry.type === "file" && (
            <a href={api.filesDownloadUrl(backend, menu.entry.path)} download onClick={() => setMenu(null)} className="w-full text-left px-3 py-1.5 hover:bg-ink-800 text-cream-200 flex items-center gap-2"><Download size={12} /> Download</a>
          )}
          <button onClick={() => { setRenaming(menu.entry.path); setRenameValue(menu.entry.name); setMenu(null); }} className="w-full text-left px-3 py-1.5 hover:bg-ink-800 text-cream-200 flex items-center gap-2"><Pencil size={12} /> Rename</button>
          <button onClick={() => { void deleteEntry(menu.entry); setMenu(null); }} className="w-full text-left px-3 py-1.5 hover:bg-coral-500/10 text-coral-300 flex items-center gap-2"><Trash2 size={12} /> Delete</button>
        </div>
      )}
    </div>
  );
}

// Session-scoped cache — a folder full of files shouldn't fire a git-log
// call per row on every render; only the hovered file fetches, and every
// backend keeps its own cache entry keyed by full path.
const lineageCache = new Map<string, { commitHash: string; commitDate: string; commitMessage: string } | null>();

function useVaultLineage(path: string, enabled: boolean) {
  const [lineage, setLineage] = useState<{ commitHash: string; commitDate: string; commitMessage: string } | null | undefined>(() => lineageCache.get(path));
  useEffect(() => {
    if (!enabled || lineageCache.has(path)) return;
    let alive = true;
    api.filesLineage("vault", path).then(r => {
      lineageCache.set(path, r.lineage);
      if (alive) setLineage(r.lineage);
    }).catch(() => { lineageCache.set(path, null); if (alive) setLineage(null); });
    return () => { alive = false; };
  }, [path, enabled]);
  return lineage;
}

function fmtRelativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function FileTile({
  entry: e, backend, selected, dragOver, renaming, renameValue, setRenameValue,
  onDragStart, onDragOver, onDragLeave, onDrop, onClick, onDoubleClick, onContextMenu,
  onSubmitRename, onEscapeRename,
}: {
  entry: FileEntry; backend: FileBackendId; selected: boolean; dragOver: boolean; renaming: boolean;
  renameValue: string; setRenameValue: (v: string) => void;
  onDragStart: (ev: React.DragEvent) => void; onDragOver: (ev: React.DragEvent) => void;
  onDragLeave: () => void; onDrop: (ev: React.DragEvent) => void;
  onClick: (ev: React.MouseEvent) => void; onDoubleClick: () => void; onContextMenu: (ev: React.MouseEvent) => void;
  onSubmitRename: () => void; onEscapeRename: () => void;
}) {
  const [hovering, setHovering] = useState(false);
  const showLineage = backend === "vault" && e.type === "file";
  const lineage = useVaultLineage(e.path, showLineage && hovering);

  const tileContent = (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className={`flex flex-col items-center gap-1 p-2 rounded-lg cursor-pointer select-none group ${
        selected ? "bg-violet-500/20 ring-1 ring-violet-500/50" : dragOver ? "bg-violet-500/10 ring-1 ring-violet-500/40" : "hover:bg-ink-800/70"
      }`}
      title={showLineage ? undefined : e.name}
    >
      <FileIcon path={e.name} isDirectory={e.type === "dir"} size={36} />
      {renaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={ev => setRenameValue(ev.target.value)}
          onClick={ev => ev.stopPropagation()}
          onKeyDown={ev => { if (ev.key === "Enter") onSubmitRename(); if (ev.key === "Escape") onEscapeRename(); }}
          onBlur={onSubmitRename}
          className="w-full bg-ink-900 border border-violet-500/50 rounded px-1 py-0.5 text-[11px] text-cream-100 text-center focus:outline-none"
        />
      ) : (
        <span className="text-[11px] text-cream-200 text-center break-all line-clamp-2 leading-tight">{e.name}</span>
      )}
      {e.type === "file" && <span className="text-[9px] text-cream-300/40">{fmtSize(e.size)}</span>}
    </div>
  );

  if (!showLineage) return tileContent;

  const lineageLines: string[] = [e.name];
  if (e.mtimeMs) lineageLines.push(`modified ${fmtRelativeTime(e.mtimeMs)}`);
  if (lineage === undefined) lineageLines.push("loading lineage…");
  else if (lineage === null) lineageLines.push("no commit history");
  else lineageLines.push(`${lineage.commitHash.slice(0, 7)} · ${lineage.commitMessage || "(no message)"}`);

  return (
    <Tooltip content={<span className="flex flex-col gap-0.5">{lineageLines.map((l, i) => <span key={i}>{l}</span>)}</span>}>
      {tileContent}
    </Tooltip>
  );
}

function BackendRow({ info, active, onClick, onDrop }: { info: FileBackendInfo; active: boolean; onClick: () => void; onDrop: (ev: React.DragEvent) => void }) {
  const Icon = BACKEND_ICON[info.id] ?? Folder;
  const dimmed = info.kind === "unavailable" && !info.configured;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      onDragOver={ev => { if (info.kind !== "unavailable") ev.preventDefault(); }}
      onDrop={onDrop}
      className={`flex min-w-max items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors tablet:w-full tablet:min-w-0 tablet:text-sm ${active ? "bg-violet-500/15 text-violet-300" : dimmed ? "text-cream-300/35" : "text-cream-200 hover:bg-ink-800/70"}`}
    >
      <Icon size={16} className="shrink-0" />
      <span className="flex-1 truncate">{info.label}</span>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${info.reachable ? "bg-leaf-500" : info.configured ? "bg-flame-400" : "bg-ink-700"}`} title={info.detail} />
    </button>
  );
}

function FolderTree({
  backend, currentPath, onNavigate, expanded, setExpanded, onDropInto, dragOver, setDragOver,
}: {
  backend: FileBackendId;
  currentPath: string;
  onNavigate: (p: string) => void;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  onDropInto: (path: string, ev: React.DragEvent) => void;
  dragOver: string | null;
  setDragOver: (p: string | null) => void;
}) {
  return (
    <TreeNode
      backend={backend}
      path=""
      label="/"
      depth={0}
      currentPath={currentPath}
      onNavigate={onNavigate}
      expanded={expanded}
      setExpanded={setExpanded}
      onDropInto={onDropInto}
      dragOver={dragOver}
      setDragOver={setDragOver}
      forceOpen
    />
  );
}

function TreeNode({
  backend, path, label, depth, currentPath, onNavigate, expanded, setExpanded, onDropInto, dragOver, setDragOver, forceOpen,
}: {
  backend: FileBackendId;
  path: string;
  label: string;
  depth: number;
  currentPath: string;
  onNavigate: (p: string) => void;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  onDropInto: (path: string, ev: React.DragEvent) => void;
  dragOver: string | null;
  setDragOver: (p: string | null) => void;
  forceOpen?: boolean;
}) {
  const open = forceOpen || expanded.has(path);
  const [dirs, setDirs] = useState<FileEntry[] | null>(null);

  useEffect(() => {
    if (!open || dirs !== null) return;
    api.filesList(backend, path).then(r => setDirs(r.entries.filter(e => e.type === "dir"))).catch(() => setDirs([]));
  }, [open, dirs, backend, path]);

  // Reload children when the tree re-mounts for a different backend.
  useEffect(() => { setDirs(null); }, [backend]);

  function toggle() {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path); else next.add(path);
    setExpanded(next);
  }

  return (
    <div>
      <div
        onClick={() => onNavigate(path)}
        onDragOver={ev => { ev.preventDefault(); ev.stopPropagation(); setDragOver(path); }}
        onDragLeave={() => setDragOver(null)}
        onDrop={ev => { ev.preventDefault(); ev.stopPropagation(); onDropInto(path, ev); }}
        className={`flex items-center gap-1 px-1.5 py-1 rounded cursor-pointer text-xs ${
          currentPath === path ? "bg-violet-500/15 text-violet-300" : dragOver === path ? "bg-violet-500/10 ring-1 ring-violet-500/40" : "text-cream-300/80 hover:bg-ink-800/70"
        }`}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        {!forceOpen && (
          <button onClick={ev => { ev.stopPropagation(); toggle(); }} className="p-0.5 -ml-1 text-cream-300/50 hover:text-cream-100">
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        )}
        <Folder size={12} className="shrink-0 text-violet-400/80" />
        <span className="truncate">{label}</span>
      </div>
      {open && dirs && dirs.map(d => (
        <TreeNode
          key={d.path}
          backend={backend}
          path={d.path}
          label={d.name}
          depth={depth + 1}
          currentPath={currentPath}
          onNavigate={onNavigate}
          expanded={expanded}
          setExpanded={setExpanded}
          onDropInto={onDropInto}
          dragOver={dragOver}
          setDragOver={setDragOver}
        />
      ))}
    </div>
  );
}
