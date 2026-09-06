import { useState, useEffect, useCallback, useRef, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  Save,
  X,
  RefreshCw,
  Search,
  Copy,
  Trash2,
  Pencil,
  FolderPlus,
  FilePlus,
  Files,
  BrainCircuit,
  Puzzle,
  MoreHorizontal,
  Send,
  CheckCircle2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api, type FileBackendId, type FileEntry } from "../lib/api";

interface OpenFile {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
  language: string;
}
type SidePanel = "explorer" | "search" | "extensions" | "ai";
type AgentId = "claude" | "codex" | "opencode" | "hermes";
type AgentStatus = "ready" | "thinking" | "approval";

interface AgentDefinition {
  id: AgentId;
  name: string;
  runtime: string;
  status: AgentStatus;
  icon: ComponentType<{ size?: string | number }>;
  color: string;
  statusLabel: string;
}

function langFromExt(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const m: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    scss: "scss",
    html: "html",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    sh: "shell",
    bash: "shell",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    sql: "sql",
    graphql: "graphql",
    txt: "plaintext",
  };
  return m[ext] ?? "plaintext";
}
function langLabel(l: string): string {
  const m: Record<string, string> = {
    typescript: "TypeScript",
    javascript: "JavaScript",
    json: "JSON",
    markdown: "Markdown",
    css: "CSS",
    scss: "SCSS",
    html: "HTML",
    python: "Python",
    ruby: "Ruby",
    go: "Go",
    rust: "Rust",
    java: "Java",
    shell: "Shell",
    yaml: "YAML",
    toml: "TOML",
    xml: "XML",
    sql: "SQL",
    graphql: "GraphQL",
    plaintext: "Plain Text",
  };
  return m[l] ?? l;
}

// Claude Code logo — coral starburst with rounded rays
function ClaudeCodeIcon({ size = 15 }: { size?: string | number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#D4775C">
      <circle cx="12" cy="12" r="3" />
      <rect x="10.8" y="1" width="2.4" height="5" rx="1.2" />
      <rect x="10.8" y="18" width="2.4" height="5" rx="1.2" />
      <rect x="1" y="10.8" width="5" height="2.4" rx="1.2" />
      <rect x="18" y="10.8" width="5" height="2.4" rx="1.2" />
      <rect x="4.5" y="3.5" width="2.4" height="5.5" rx="1.2" transform="rotate(-45 5.7 6.25)" />
      <rect x="17.1" y="15" width="2.4" height="5.5" rx="1.2" transform="rotate(-45 18.3 17.75)" />
      <rect x="4.5" y="15" width="2.4" height="5.5" rx="1.2" transform="rotate(45 5.7 17.75)" />
      <rect x="17.1" y="3.5" width="2.4" height="5.5" rx="1.2" transform="rotate(45 18.3 6.25)" />
    </svg>
  );
}

// Hermes agent — winged figure silhouette
function HermesIcon({ size = 15 }: { size?: string | number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="4.5" r="2.5" />
      <path d="M12 8c-3 0-5.5 2-6 5l-1 4.5c-.1.5.3 1 .8 1h12.4c.5 0 .9-.5.8-1l-1-4.5c-.5-3-3-5-6-5z" />
      <path d="M6 9c-2-1.5-4-.5-5 1l3 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M18 9c2-1.5 4-.5 5 1l-3 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const agents: AgentDefinition[] = [
  {
    id: "claude",
    name: "Claude Code",
    runtime: "Claude runner",
    status: "ready",
    icon: ClaudeCodeIcon,
    color: "text-[#D4775C]",
    statusLabel: "Ready",
  },
  {
    id: "codex",
    name: "Codex",
    runtime: "OpenAI runner",
    status: "thinking",
    icon: BrainCircuit,
    color: "text-emerald-400",
    statusLabel: "Indexing workspace",
  },
  {
    id: "opencode",
    name: "OpenCode",
    runtime: "Local runner",
    status: "ready",
    icon: Puzzle,
    color: "text-violet-400",
    statusLabel: "Ready",
  },
  {
    id: "hermes",
    name: "Hermes",
    runtime: "Private runner",
    status: "approval",
    icon: HermesIcon,
    color: "text-amber-300",
    statusLabel: "Needs approval",
  },
];

const starterPrompts = ["Explain this file", "Find bugs", "Plan a change"];

function FileTreeNode({
  entry,
  backend,
  depth,
  onOpen,
  onRename,
  onDelete,
  onCopyPath,
  onNewFile,
  onNewFolder,
}: {
  entry: FileEntry;
  backend: FileBackendId;
  depth: number;
  onOpen: (p: string, n: string) => void;
  onRename: (p: string) => void;
  onDelete: (p: string) => void;
  onCopyPath: (p: string) => void;
  onNewFile: (d: string) => void;
  onNewFolder: (d: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const isDir = entry.type === "dir";
  function toggle() {
    if (!isDir) {
      onOpen(entry.path, entry.name);
      return;
    }
    setOpen((o) => !o);
    if (!open)
      api
        .filesList(backend, entry.path)
        .then((r) => setChildren(r.entries))
        .catch(() => {});
  }
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [ctx]);
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtx({ x: e.clientX, y: e.clientY });
        }}
        className="w-full flex items-center gap-1.5 py-1 px-2 text-xs text-cream-300/80 hover:text-cream-50 hover:bg-white/5 rounded transition-colors truncate"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {isDir ? (
          open ? (
            <ChevronDown size={12} className="shrink-0" />
          ) : (
            <ChevronRight size={12} className="shrink-0" />
          )
        ) : (
          <span className="w-3" />
        )}
        {isDir ? (
          open ? (
            <FolderOpen size={13} className="shrink-0 text-violet-400" />
          ) : (
            <Folder size={13} className="shrink-0 text-violet-400/70" />
          )
        ) : (
          <FileText size={13} className="shrink-0 text-cream-300/50" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>
      {open &&
        children.map((c) => (
          <FileTreeNode
            key={c.path}
            entry={c}
            backend={backend}
            depth={depth + 1}
            onOpen={onOpen}
            onRename={onRename}
            onDelete={onDelete}
            onCopyPath={onCopyPath}
            onNewFile={onNewFile}
            onNewFolder={onNewFolder}
          />
        ))}
      {ctx && (
        <div
          className="fixed z-50 bg-ink-900 border border-ink-700 rounded-lg shadow-2xl py-1 min-w-[180px]"
          style={{ left: ctx.x, top: ctx.y }}
        >
          {isDir && (
            <CtxItem
              icon={FilePlus}
              label="New File"
              onClick={() => {
                onNewFile(entry.path);
                setCtx(null);
              }}
            />
          )}
          {isDir && (
            <CtxItem
              icon={FolderPlus}
              label="New Folder"
              onClick={() => {
                onNewFolder(entry.path);
                setCtx(null);
              }}
            />
          )}
          <CtxItem
            icon={Pencil}
            label="Rename"
            onClick={() => {
              onRename(entry.path);
              setCtx(null);
            }}
          />
          <CtxItem
            icon={Copy}
            label="Copy Path"
            onClick={() => {
              onCopyPath(entry.path);
              setCtx(null);
            }}
          />
          <div className="my-1 border-t border-ink-700" />
          <CtxItem
            icon={Trash2}
            label="Delete"
            onClick={() => {
              onDelete(entry.path);
              setCtx(null);
            }}
            danger
          />
        </div>
      )}
    </div>
  );
}

function CtxItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: any;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${danger ? "text-coral-400 hover:bg-coral-500/10" : "text-cream-200 hover:bg-white/5"}`}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}

export function IDE() {
  const [backend, setBackend] = useState<FileBackendId>("localdisk");
  const [backends, setBackends] = useState<{ id: FileBackendId; label: string }[]>([]);
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidePanel, setSidePanel] = useState<SidePanel>("explorer");
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ path: string; line: number; preview: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [activeAgentId, setActiveAgentId] = useState<AgentId>("codex");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentMessages, setAgentMessages] = useState<Record<AgentId, string[]>>({
    claude: ["I can inspect your workspace and propose a focused change."],
    codex: ["Workspace context is ready. What would you like to build?"],
    opencode: ["Local agent standing by. I will present every edit for review."],
    hermes: ["Private runner is available. Terminal and file-write permissions require approval."],
  });
  const editorRef = useRef<any>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .filesBackends()
      .then((r) => {
        const cfg = r.backends.filter((b) => b.configured && b.kind === "filesystem");
        setBackends(cfg);
        if (cfg.length && !cfg.find((b) => b.id === backend)) setBackend(cfg[0].id);
      })
      .catch(() => {});
  }, []);

  const refreshTree = useCallback(() => {
    api
      .filesList(backend, "")
      .then((r) => setTree(r.entries))
      .catch(() => {});
  }, [backend]);
  useEffect(refreshTree, [refreshTree]);

  const openFile = useCallback(
    async (path: string, name: string) => {
      const existing = openFiles.findIndex((f) => f.path === path);
      if (existing !== -1) {
        setActiveIdx(existing);
        return;
      }
      try {
        const r = await api.brainFile(path).catch(() => null);
        const content = r?.content ?? "";
        setOpenFiles((prev) => {
          const next = [...prev, { path, name, content, dirty: false, language: langFromExt(name) }];
          setActiveIdx(next.length - 1);
          return next;
        });
      } catch {
        try {
          const resp = await fetch(api.filesDownloadUrl(backend, path));
          const text = await resp.text();
          setOpenFiles((prev) => {
            const next = [...prev, { path, name, content: text, dirty: false, language: langFromExt(name) }];
            setActiveIdx(next.length - 1);
            return next;
          });
        } catch {
          /* ignore */
        }
      }
    },
    [openFiles, backend],
  );

  const saveFile = useCallback(
    async (idx: number) => {
      const file = openFiles[idx];
      if (!file) return;
      try {
        await api.brainSave(file.path, file.content);
        setOpenFiles((prev) => prev.map((f, i) => (i === idx ? { ...f, dirty: false } : f)));
      } catch {
        /* ignore */
      }
    },
    [openFiles],
  );

  const closeFile = useCallback(
    (idx: number) => {
      setOpenFiles((prev) => {
        const next = prev.filter((_, i) => i !== idx);
        if (activeIdx >= next.length) setActiveIdx(Math.max(0, next.length - 1));
        else if (activeIdx > idx) setActiveIdx(activeIdx - 1);
        return next;
      });
    },
    [activeIdx],
  );

  const onEditorChange = useCallback(
    (value: string | undefined) => {
      if (activeIdx < 0 || !value) return;
      setOpenFiles((prev) => prev.map((f, i) => (i === activeIdx ? { ...f, content: value, dirty: true } : f)));
    },
    [activeIdx],
  );

  const onEditorMount: OnMount = useCallback((ed) => {
    editorRef.current = ed;
    ed.onDidChangeCursorPosition((e) => setCursorPos({ line: e.position.lineNumber, col: e.position.column }));
  }, []);

  const handleCopyPath = useCallback((p: string) => {
    navigator.clipboard.writeText(p).catch(() => {});
  }, []);
  const handleDelete = useCallback(
    async (p: string) => {
      if (!confirm(`Delete ${p}?`)) return;
      await api.filesDelete(backend, p).catch(() => {});
      refreshTree();
      setOpenFiles((prev) => prev.filter((f) => f.path !== p));
    },
    [backend, refreshTree],
  );
  const handleRename = useCallback((p: string) => {
    setRenameTarget(p);
    setRenameValue(p.split(/[\\/]/).pop() ?? "");
  }, []);
  const confirmRename = useCallback(async () => {
    if (!renameTarget || !renameValue) {
      setRenameTarget(null);
      return;
    }
    const dir = renameTarget.split(/[\\/]/).slice(0, -1).join("/");
    const newPath = dir ? `${dir}/${renameValue}` : renameValue;
    await api.filesMove(backend, renameTarget, newPath).catch(() => {});
    setRenameTarget(null);
    refreshTree();
    setOpenFiles((prev) => prev.map((f) => (f.path === renameTarget ? { ...f, path: newPath, name: renameValue } : f)));
  }, [renameTarget, renameValue, backend, refreshTree]);
  const handleNewFile = useCallback(
    async (dirPath: string) => {
      const name = prompt("New file name:");
      if (!name) return;
      const fp = dirPath ? `${dirPath}/${name}` : name;
      await api.filesUpload({ backend, path: fp, filename: name, contentBase64: btoa("") }).catch(() => {});
      refreshTree();
    },
    [backend, refreshTree],
  );
  const handleNewFolder = useCallback(
    async (dirPath: string) => {
      const name = prompt("New folder name:");
      if (!name) return;
      const fp = dirPath ? `${dirPath}/${name}` : name;
      await api.filesMkdir(backend, fp).catch(() => {});
      refreshTree();
    },
    [backend, refreshTree],
  );

  const doSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const r = await api.brainSearch(searchQuery);
      setSearchResults(r.results);
    } catch {
      setSearchResults([]);
    }
    setSearching(false);
  }, [searchQuery]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "s") {
        e.preventDefault();
        saveFile(activeIdx);
      }
      if (mod && e.key === "b") {
        e.preventDefault();
        setSidebarOpen((s) => !s);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIdx, saveFile]);

  const activeFile = openFiles[activeIdx] ?? null;
  const breadcrumbs = activeFile ? activeFile.path.split(/[\\/]/) : [];
  const activeAgent = agents.find((agent) => agent.id === activeAgentId) ?? agents[0];
  const ActiveAgentIcon = activeAgent.icon;

  const openAgent = useCallback((id: AgentId) => {
    setActiveAgentId(id);
    setSidePanel("ai");
    setSidebarOpen(true);
  }, []);

  const sendAgentPrompt = useCallback(
    (prompt = agentPrompt) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      setAgentMessages((previous) => ({
        ...previous,
        [activeAgentId]: [
          ...previous[activeAgentId],
          `You: ${trimmed}`,
          `${activeAgent.name}: I’ll analyse ${activeFile?.name ?? "the workspace"} and prepare any edits as a reviewable diff.`,
        ],
      }));
      setAgentPrompt("");
    },
    [activeAgent, activeAgentId, activeFile, agentPrompt],
  );

  const activityItems: { id: SidePanel; icon: any; label: string; color?: string; agentId?: AgentId }[] = [
    { id: "explorer", icon: Files, label: "Explorer" },
    { id: "search", icon: Search, label: "Search" },
    ...agents.map((agent) => ({
      id: "ai" as SidePanel,
      icon: agent.icon,
      label: agent.name,
      color: agent.color,
      agentId: agent.id,
    })),
    { id: "extensions", icon: Puzzle, label: "Extensions" },
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] -m-6 select-none">
      {/* ── toolbar ── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/10 bg-ink-900/60 backdrop-blur-xl text-xs shrink-0">
        <select
          value={backend}
          onChange={(e) => setBackend(e.target.value as FileBackendId)}
          className="bg-ink-800 text-cream-200 border border-ink-700 rounded px-2 py-1 text-xs"
        >
          {backends.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={refreshTree}
          className="p-1 text-cream-300/60 hover:text-cream-100 transition-colors"
          title="Refresh"
        >
          <RefreshCw size={13} />
        </button>
        <div className="flex-1" />
        <a
          href="http://127.0.0.1:7472"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 hover:text-violet-100 transition-colors text-[11px] font-medium"
          title="Open full Naxion IDE (Theia)"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
          Open in Naxion IDE
        </a>
        <div className="flex items-center gap-1">
          {[...agents, { icon: MoreHorizontal, name: "More", color: "text-cream-300/50" }].map((ext) => {
            const Icon = ext.icon;
            return (
              <button
                key={ext.name}
                type="button"
                onClick={"id" in ext ? () => openAgent(ext.id) : undefined}
                className={`p-1.5 rounded-md hover:bg-white/10 transition-colors ${ext.color}`}
                title={ext.name}
              >
                <Icon size={15} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ── activity bar ── */}
        <div className="w-11 shrink-0 border-r border-white/10 bg-ink-950/70 backdrop-blur-xl flex flex-col items-center py-2 gap-1">
          {activityItems.map((item) => {
            const Icon = item.icon;
            const active = sidePanel === item.id && sidebarOpen && (!item.agentId || item.agentId === activeAgentId);
            return (
              <button
                key={item.id}
                type="button"
                title={item.label}
                onClick={() => {
                  if (item.agentId) {
                    openAgent(item.agentId);
                    return;
                  }
                  if (sidePanel === item.id && sidebarOpen) setSidebarOpen(false);
                  else {
                    setSidePanel(item.id);
                    setSidebarOpen(true);
                  }
                }}
                className={`w-9 h-9 grid place-items-center rounded-lg transition-colors ${active ? "bg-white/10 text-cream-50" : `${item.color ?? "text-cream-300/50"} hover:text-cream-100 hover:bg-white/5`}`}
              >
                <Icon size={18} />
              </button>
            );
          })}
        </div>

        {/* ── sidebar ── */}
        {sidebarOpen && (
          <div className="w-60 shrink-0 border-r border-white/10 bg-ink-950/50 backdrop-blur-xl flex flex-col overflow-hidden">
            {sidePanel === "explorer" && (
              <>
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-cream-300/40 font-semibold flex items-center justify-between">
                  Explorer
                  <span className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => handleNewFile("")}
                      title="New File"
                      className="hover:text-cream-100"
                    >
                      <FilePlus size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNewFolder("")}
                      title="New Folder"
                      className="hover:text-cream-100"
                    >
                      <FolderPlus size={12} />
                    </button>
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto scrollbar-thin">
                  {tree.map((entry) => (
                    <FileTreeNode
                      key={entry.path}
                      entry={entry}
                      backend={backend}
                      depth={0}
                      onOpen={openFile}
                      onRename={handleRename}
                      onDelete={handleDelete}
                      onCopyPath={handleCopyPath}
                      onNewFile={handleNewFile}
                      onNewFolder={handleNewFolder}
                    />
                  ))}
                  {tree.length === 0 && <div className="px-4 py-6 text-xs text-cream-300/40 text-center">No files</div>}
                </div>
              </>
            )}
            {sidePanel === "search" && (
              <div className="flex flex-col h-full">
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-cream-300/40 font-semibold">
                  Search
                </div>
                <div className="px-2 pb-2">
                  <div className="flex items-center gap-1 bg-ink-800 border border-ink-700 rounded px-2 py-1">
                    <Search size={12} className="text-cream-300/40 shrink-0" />
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") doSearch();
                      }}
                      placeholder="Search files..."
                      className="flex-1 bg-transparent text-xs text-cream-100 outline-none placeholder:text-cream-300/30"
                    />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto scrollbar-thin px-2">
                  {searching && <div className="text-xs text-cream-300/40 py-2">Searching...</div>}
                  {!searching && searchResults.length === 0 && searchQuery && (
                    <div className="text-xs text-cream-300/40 py-2">No results</div>
                  )}
                  {searchResults.map((r, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => openFile(r.path, r.path.split(/[\\/]/).pop() ?? r.path)}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-white/5 transition-colors"
                    >
                      <div className="text-[10px] text-cream-300/50 truncate">
                        {r.path}:{r.line}
                      </div>
                      <div className="text-xs text-cream-200/80 truncate font-mono">{r.preview}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {sidePanel === "ai" && (
              <div className="flex flex-col h-full">
                <div className="px-3 pt-2 pb-2 border-b border-white/5">
                  <div className="flex items-center gap-2">
                    <span className={`grid h-7 w-7 place-items-center rounded-md bg-white/5 ${activeAgent.color}`}>
                      <ActiveAgentIcon size={16} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-cream-100">{activeAgent.name}</div>
                      <div className="text-[10px] text-cream-300/45">{activeAgent.runtime}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-[10px] text-cream-300/60">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${activeAgent.status === "ready" ? "bg-leaf-500" : activeAgent.status === "thinking" ? "bg-cyan-400 animate-pulse" : "bg-amber-400"}`}
                    />
                    {activeAgent.statusLabel}
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
                  {agentMessages[activeAgentId].map((message, index) => {
                    const fromUser = message.startsWith("You:");
                    return (
                      <div
                        key={`${message}-${index}`}
                        className={`rounded-lg px-2.5 py-2 text-[11px] leading-relaxed ${fromUser ? "bg-violet-500/15 text-violet-100" : "bg-white/5 text-cream-200/80"}`}
                      >
                        {message}
                      </div>
                    );
                  })}
                  {activeAgent.status === "approval" && (
                    <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-2.5 text-[11px] text-amber-100/80">
                      <div className="flex items-center gap-1.5 font-medium text-amber-200">
                        <ShieldCheck size={13} /> Approval required
                      </div>
                      <p className="mt-1 text-amber-100/60">
                        Hermes can inspect files, but edits and terminal commands stay blocked until you approve them.
                      </p>
                    </div>
                  )}
                  <div className="rounded-lg border border-dashed border-white/10 p-2.5 text-[11px] text-cream-300/55">
                    <div className="flex items-center gap-1.5 text-cream-200/80">
                      <Sparkles size={13} className={activeAgent.color} /> Proposed changes
                    </div>
                    <p className="mt-1">Agent edits will appear here as a Monaco diff before anything is written.</p>
                    <button
                      type="button"
                      className="mt-2 inline-flex items-center gap-1 text-[10px] text-leaf-400 hover:text-leaf-300"
                    >
                      <CheckCircle2 size={12} /> Review is always required
                    </button>
                  </div>
                </div>
                <div className="border-t border-white/10 p-2">
                  <div className="flex flex-wrap gap-1 pb-2">
                    {starterPrompts.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => sendAgentPrompt(prompt)}
                        className="rounded border border-white/10 px-1.5 py-1 text-[10px] text-cream-300/65 hover:bg-white/5 hover:text-cream-100"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 rounded-md border border-ink-700 bg-ink-900 px-2 py-1">
                    <input
                      value={agentPrompt}
                      onChange={(event) => setAgentPrompt(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") sendAgentPrompt();
                      }}
                      placeholder={`Ask ${activeAgent.name}...`}
                      className="min-w-0 flex-1 bg-transparent text-xs text-cream-100 outline-none placeholder:text-cream-300/30"
                    />
                    <button
                      type="button"
                      onClick={() => sendAgentPrompt()}
                      title="Send prompt"
                      className={`${activeAgent.color} hover:text-cream-50`}
                    >
                      <Send size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}
            {sidePanel === "extensions" && (
              <div className="flex flex-col h-full">
                <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-cream-300/40 font-semibold">
                  Extensions
                </div>
                <div className="flex-1 px-3 py-4 text-xs text-center">
                  <button
                    type="button"
                    onClick={() => navigate("/extensions")}
                    className="text-violet-400 hover:text-violet-300 transition-colors"
                  >
                    Open Extensions Hub
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── editor area ── */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* breadcrumbs */}
          {activeFile && breadcrumbs.length > 0 && (
            <div className="flex items-center gap-1 px-3 py-1 text-[11px] text-cream-300/50 border-b border-white/5 bg-ink-900/30 shrink-0 overflow-x-auto scrollbar-none">
              {breadcrumbs.map((seg, i) => (
                <span key={i} className="flex items-center gap-1 shrink-0">
                  {i > 0 && <ChevronRight size={10} className="text-cream-300/30" />}
                  <span className={i === breadcrumbs.length - 1 ? "text-cream-200" : ""}>{seg}</span>
                </span>
              ))}
            </div>
          )}

          {/* tab bar */}
          {openFiles.length > 0 && (
            <div className="flex items-center border-b border-white/10 bg-ink-900/40 backdrop-blur-md shrink-0 overflow-x-auto scrollbar-none">
              {openFiles.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => setActiveIdx(i)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-white/10 transition-colors shrink-0 ${i === activeIdx ? "bg-ink-800 text-cream-50" : "text-cream-300/60 hover:text-cream-100 hover:bg-ink-800/40"}`}
                >
                  <FileText size={12} className="shrink-0" />
                  <span className="truncate max-w-[20ch]">{f.name}</span>
                  {f.dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeFile(i);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.stopPropagation();
                        closeFile(i);
                      }
                    }}
                    className="ml-1 text-cream-300/40 hover:text-coral-400 cursor-pointer"
                  >
                    <X size={11} />
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* monaco */}
          <div className="flex-1 min-h-0">
            {activeFile ? (
              <Editor
                language={activeFile.language}
                value={activeFile.content}
                onChange={onEditorChange}
                onMount={onEditorMount}
                theme="vs-dark"
                options={{
                  fontSize: 13,
                  fontFamily: "'JetBrains Mono','Fira Code',monospace",
                  minimap: { enabled: true, maxColumn: 80 },
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  automaticLayout: true,
                  padding: { top: 8 },
                  renderLineHighlight: "line",
                  bracketPairColorization: { enabled: true },
                  smoothScrolling: true,
                  cursorBlinking: "smooth",
                  cursorSmoothCaretAnimation: "on",
                  stickyScroll: { enabled: true },
                  folding: true,
                  showFoldingControls: "mouseover",
                  links: true,
                  colorDecorators: true,
                  contextmenu: true,
                }}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-cream-300/30 text-sm">
                Open a file from the sidebar to start editing
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── status bar ── */}
      <div className="flex items-center justify-between px-3 py-0.5 border-t border-white/10 bg-ink-900/80 backdrop-blur-xl text-[11px] text-cream-300/60 shrink-0">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-leaf-500" />
            Ready
          </span>
          <button
            type="button"
            onClick={() => openAgent(activeAgentId)}
            className={`flex items-center gap-1 hover:text-cream-100 ${activeAgent.color}`}
            title={`Open ${activeAgent.name}`}
          >
            <ActiveAgentIcon size={12} />
            {activeAgent.name} · {activeAgent.statusLabel}
          </button>
          {activeFile && <span>{activeFile.path}</span>}
        </div>
        <div className="flex items-center gap-3">
          {activeFile && (
            <span>
              Ln {cursorPos.line}, Col {cursorPos.col}
            </span>
          )}
          {activeFile && <span>{langLabel(activeFile.language)}</span>}
          <span>UTF-8</span>
          <span>LF</span>
          <span>Spaces: 2</span>
        </div>
      </div>

      {/* ── rename modal ── */}
      {renameTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 backdrop-blur-sm"
          onClick={() => setRenameTarget(null)}
        >
          <div
            className="bg-ink-900 border border-ink-700 rounded-xl shadow-2xl p-4 w-80"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm text-cream-100 font-medium mb-3">Rename</div>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmRename();
                if (e.key === "Escape") setRenameTarget(null);
              }}
              className="w-full bg-ink-800 border border-ink-700 rounded px-3 py-1.5 text-sm text-cream-100 outline-none focus:border-violet-500/50"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="px-3 py-1 text-xs text-cream-300/60 hover:text-cream-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmRename}
                className="px-3 py-1 text-xs bg-violet-500/20 text-violet-300 rounded hover:bg-violet-500/30"
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
