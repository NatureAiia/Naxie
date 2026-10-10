import { Command } from "cmdk";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import {
  MessageSquare, Users, ListChecks,
  BookOpen, Sparkles, Terminal,
  UserCircle, PlusCircle, Search as SearchIcon, Calendar,
  Plug, PiggyBank, Brain, LayoutDashboard,
  Webhook, GitBranch,
  ShieldAlert,
} from "lucide-react";
import { Kbd, MetaKey } from "./Kbd";
import { matIcon } from "./FileIcon";
import { api } from "../lib/api";
import { PAGE_CATALOG, type PageId } from "../lib/pageCatalog";

// Same Atom Material icon matches used in Layout.tsx's nav rail, applied
// here so the command palette reads as the same reskinned system.
const ChangelogIcon = matIcon("changelog");
const LogIcon = matIcon("log");
const TemplateIcon = matIcon("template");
const CertificateIcon = matIcon("certificate");

type Item = {
  id: string;
  label: string;
  group: "Navigate" | "Actions" | "Library";
  icon: ComponentType<{ size?: number | string; className?: string }>;
  onSelect: () => void;
  keywords?: string;
  shortcut?: string;
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [vaultHits, setVaultHits] = useState<{ path: string; preview: string }[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSequence = useRef(0);
  const nav = useNavigate();

  // Kuwana quick-search: vault semantic hits alongside commands
  function searchVault(q: string) {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const sequence = ++searchSequence.current;
    const query = q.trim();
    if (query.length < 2) { setVaultHits([]); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await api.brainSearch(query);
        if (sequence === searchSequence.current) setVaultHits((r.results ?? []).slice(0, 5));
      } catch {
        if (sequence === searchSequence.current) setVaultHits([]);
      }
    }, 250);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(o => !o);
      }
      if (e.key === "Escape" && open) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) return;
    searchSequence.current++;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setVaultHits([]);
  }, [open]);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  function go(to: string) {
    return () => { nav(to); setOpen(false); };
  }

  const pageIcons: Record<PageId, Item["icon"]> = {
    naxie: Sparkles, office: UserCircle, inbox: Users, council: MessageSquare, schedules: Calendar,
    dailyReports: ChangelogIcon, command: LayoutDashboard, brands: Plug, planner: Calendar,
    myFinances: PiggyBank, businessFinance: PiggyBank, memory: Brain, library: BookOpen,
    templates: TemplateIcon, skills: Sparkles, extensions: Plug, connectors: Plug, mcp: Plug,
    hermes: Plug, github: GitBranch, automation: Webhook, ide: Terminal, models: Brain,
    cost: PiggyBank, policies: CertificateIcon, security: ShieldAlert, whatsapp: Plug,
  };
  const libraryPages = new Set<PageId>(["memory", "library", "templates", "skills", "extensions", "connectors", "mcp", "hermes", "github", "policies", "security", "whatsapp"]);
  const pageItems: Item[] = (Object.entries(PAGE_CATALOG) as [PageId, typeof PAGE_CATALOG[PageId]][]).map(([id, page]) => ({
    id: `page-${id}`,
    group: libraryPages.has(id) ? "Library" : "Navigate",
    label: page.label,
    icon: pageIcons[id],
    onSelect: go(page.path),
    keywords: page.keywords,
  }));
  const items: Item[] = [
    ...pageItems,
    { id: "n-runs", group: "Navigate", label: "Runs", icon: ListChecks, onSelect: go("/my-work?tab=runs"), keywords: "active completed agent executions reports quality" },
    { id: "n-board", group: "Navigate", label: "Board Meeting", icon: MessageSquare, onSelect: go("/council?tab=board"), keywords: "talk message council board" },
    { id: "n-orchestrate", group: "Navigate", label: "Orchestrate", icon: MessageSquare, onSelect: go("/council?tab=orchestrate"), keywords: "decompose parallel tasks" },
    { id: "a-new-chat", group: "Actions", label: "New board meeting", icon: PlusCircle, onSelect: go("/council?tab=board"), keywords: "start fresh session council" },
    { id: "a-search-vault", group: "Actions", label: "Search the vault", icon: SearchIcon, onSelect: go("/library") },
    { id: "a-new-schedule", group: "Actions", label: "Create a schedule", icon: Calendar, onSelect: go("/schedules"), keywords: "recurring template fire" },
    { id: "a-export-cal", group: "Actions", label: "Download agenda (.ics)", icon: Calendar, onSelect: () => { window.open("/api/calendar/export.ics", "_blank"); setOpen(false); }, keywords: "calendar export ics google agenda daily rhythm" },
    { id: "l-audit", group: "Library", label: "Audit Log", icon: LogIcon, onSelect: go("/extensions?tab=audit"), keywords: "security intrusion blocked ip log" },
    { id: "l-integrations", group: "Library", label: "Extensions — Integrations", icon: Plug, onSelect: go("/extensions?tab=integrations"), keywords: "connect slack telegram github notion social oauth api integrations" },
  ];

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4" onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" />
      <Command
        label="Command palette"
        className="relative w-full max-w-xl bg-ink-900 border border-ink-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 border-b border-ink-800">
          <SearchIcon size={16} className="text-cream-300/60" />
          <Command.Input
            autoFocus
            placeholder="Search commands, pages, actions… (vault hits appear below)"
            className="flex-1 bg-transparent py-3 text-sm text-cream-50 placeholder:text-cream-300/40 focus:outline-none"
            onValueChange={searchVault}
          />
          <Kbd>Esc</Kbd>
        </div>
        <Command.List className="max-h-[60vh] overflow-y-auto scrollbar-thin p-2">
          <Command.Empty className="text-sm text-cream-300/60 text-center py-8">
            No results.
          </Command.Empty>
          {vaultHits.length > 0 && (
            <Command.Group heading="Vault" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-cream-300/50">
              {vaultHits.map(h => (
                <Command.Item key={`vault-${h.path}`} value={h.path} onSelect={() => { const path = h.path.split("/").map(encodeURIComponent).join("/"); nav(`/library/${path}`); setOpen(false); }} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-cream-200 cursor-pointer aria-selected:bg-ink-800 aria-selected:text-cream-50">
                  <BookOpen size={16} className="text-violet-400" />
                  <span className="flex-1 truncate">{h.path}</span>
                  <span className="text-[11px] text-cream-300/40 truncate max-w-[16rem]">{h.preview.slice(0,60)}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {(["Navigate", "Actions", "Library"] as const).map(group => (
            <Command.Group
              key={group}
              heading={group}
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-cream-300/50"
            >
              {items.filter(i => i.group === group).map(i => {
                const Icon = i.icon;
                return (
                  <Command.Item
                    key={i.id}
                    value={`${i.label} ${i.keywords ?? ""}`}
                    onSelect={i.onSelect}
                    className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-cream-200 cursor-pointer aria-selected:bg-ink-800 aria-selected:text-cream-50"
                  >
                    <Icon size={16} className="text-cream-300/70" />
                    <span className="flex-1">{i.label}</span>
                    {i.shortcut && <Kbd>{i.shortcut}</Kbd>}
                  </Command.Item>
                );
              })}
            </Command.Group>
          ))}
        </Command.List>
        <div className="border-t border-ink-800 px-4 py-2 flex items-center gap-3 text-[10px] text-cream-300/50">
          <span className="flex items-center gap-1"><Kbd>↑↓</Kbd> navigate</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> select</span>
          <span className="ml-auto flex items-center gap-1"><MetaKey /><Kbd>K</Kbd> toggle</span>
        </div>
      </Command>
    </div>
  );
}
