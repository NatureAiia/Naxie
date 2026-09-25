import { Command } from "cmdk";
import { useEffect, useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import {
  MessageSquare, Users, ListChecks, CheckCircle2,
  BookOpen, Sparkles, Terminal,
  UserCircle, PlusCircle, Search as SearchIcon, Calendar,
  Plug,
} from "lucide-react";
import { Kbd, MetaKey } from "./Kbd";
import { matIcon } from "./FileIcon";
import { api } from "../lib/api";

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
  const nav = useNavigate();

  // Kuwana quick-search: vault semantic hits alongside commands
  async function searchVault(q: string) {
    if (!q.trim() || q.length < 2) { setVaultHits([]); return; }
    try { const r = await api.brainSearch(q); setVaultHits((r.results ?? []).slice(0, 5)); } catch { /* ignore */ }
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

  function go(to: string) {
    return () => { nav(to); setOpen(false); };
  }

  const items: Item[] = [
    { id: "n-naxie", group: "Navigate", label: "Naxie", icon: Sparkles, onSelect: go("/naxie"), keywords: "home overview voice assistant mic talk speak naxie jarvis" },
    { id: "n-chat", group: "Navigate", label: "Board Meeting", icon: MessageSquare, onSelect: go("/chat"), keywords: "talk message council" },
    { id: "n-agents", group: "Navigate", label: "Office", icon: UserCircle, onSelect: go("/office"), keywords: "agents personas roles employees workforce roster office desk" },
    { id: "n-terminal", group: "Navigate", label: "IDE", icon: Terminal, onSelect: go("/ide"), keywords: "shell console command exec code editor" },
    { id: "n-runs", group: "Navigate", label: "Runs", icon: ListChecks, onSelect: go("/runs"), keywords: "jobs queue tasks results outputs activity" },
    { id: "n-knowledge", group: "Navigate", label: "Library", icon: BookOpen, onSelect: go("/library"), keywords: "vault notes search files" },
    { id: "n-approvals", group: "Navigate", label: "Agent Approvals", icon: CheckCircle2, onSelect: go("/approvals"), keywords: "review pending" },
    { id: "n-my-work", group: "Navigate", label: "My Work", icon: Users, onSelect: go("/my-work"), keywords: "handoffs assignments human loop upload submit delegate" },
    { id: "n-schedules", group: "Navigate", label: "Schedules", icon: Calendar, onSelect: go("/schedules"), keywords: "cron recurring schedule" },

    { id: "a-new-chat", group: "Actions", label: "New board meeting", icon: PlusCircle, onSelect: go("/chat"), keywords: "start fresh session council" },
    { id: "a-search-vault", group: "Actions", label: "Search the vault", icon: SearchIcon, onSelect: go("/library") },
    { id: "a-new-schedule", group: "Actions", label: "Create a schedule", icon: Calendar, onSelect: go("/schedules"), keywords: "recurring template fire" },

    { id: "l-templates", group: "Library", label: "Templates", icon: TemplateIcon, onSelect: go("/templates") },
    { id: "l-skills", group: "Library", label: "Skills", icon: Sparkles, onSelect: go("/skills") },
    { id: "l-policies", group: "Library", label: "Policies", icon: CertificateIcon, onSelect: go("/connectors?tab=policies"), keywords: "policy guardrail compliance governance instructions" },
    { id: "l-audit", group: "Library", label: "Audit Log", icon: LogIcon, onSelect: go("/extensions?tab=audit"), keywords: "security intrusion blocked ip log" },
    { id: "l-integrations", group: "Library", label: "Extensions — Integrations", icon: Plug, onSelect: go("/extensions?tab=integrations"), keywords: "connect slack telegram github notion social oauth api integrations" },
    { id: "l-connectors", group: "Library", label: "Connectors", icon: Plug, onSelect: go("/connectors"), keywords: "connect company api base url auth connectors google microsoft personal accounts email calendar" },
    { id: "l-mcp", group: "Library", label: "MCP Servers", icon: Plug, onSelect: go("/mcp-servers"), keywords: "model context protocol tool server filesystem browser" },
    { id: "l-hermes", group: "Library", label: "Hermes", icon: Plug, onSelect: go("/hermes"), keywords: "hermes nous research executor launch mcp bridge clawbot" },
    { id: "l-brands", group: "Library", label: "Brands", icon: Plug, onSelect: go("/brands"), keywords: "brand voice marketing personal work business aiia variety vault social" },
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
                <Command.Item key={`vault-${h.path}`} value={h.path} onSelect={() => { nav(`/library?path=${encodeURIComponent(h.path)}`); setOpen(false); }} className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-cream-200 cursor-pointer aria-selected:bg-ink-800 aria-selected:text-cream-50">
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
