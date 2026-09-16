import { useMemo, useState } from "react";
import { Search, ChevronDown, ChevronRight } from "lucide-react";
import type { OfficeRoom } from "./OfficeScene";

// H — an always-legible "who's where" that doesn't depend on the 3D view
// being readable at a given moment: the same room data OfficeScene renders,
// as a plain list. Selecting a persona here does the exact same thing as
// clicking their desk (onSelectPersona) — this is a second entry point to
// one action, not a separate feature.
type Props = {
  rooms: OfficeRoom[];
  onSelectPersona: (personaId: string) => void;
};

export function OfficeDirectory({ rooms, onSelectPersona }: Props) {
  const [query, setQuery] = useState("");
  // Closed by default — a dozen fully-expanded department lists is more
  // scrolling than scanning. Opting a room open is a click; search below
  // still force-opens whatever matches regardless of this state.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rooms;
    return rooms
      .map(r => ({ ...r, members: r.members.filter(m => m.name.toLowerCase().includes(q)) }))
      .filter(r => r.members.length > 0);
  }, [rooms, query]);

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="bg-ink-900 border border-ink-800 rounded-lg p-3 space-y-2 max-h-[min(70vh,640px)] overflow-y-auto">
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cream-300/40" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Find a person…"
          className="w-full bg-ink-950 border border-ink-800 rounded-md pl-7 pr-2 py-1.5 text-xs text-cream-100 focus:outline-none focus:border-violet-500/60"
        />
      </div>
      {filtered.length === 0 && (
        <div className="text-xs text-cream-300/40 px-1 py-2">No one matches "{query}".</div>
      )}
      {filtered.map(room => {
        const isOpen = query.trim().length > 0 || expanded.has(room.id);
        return (
          <div key={room.id}>
            <button
              type="button"
              onClick={() => toggle(room.id)}
              className="w-full flex items-center gap-1.5 text-left px-1 py-1 rounded hover:bg-ink-800/60"
            >
              {isOpen ? <ChevronDown size={12} className="text-cream-300/40" /> : <ChevronRight size={12} className="text-cream-300/40" />}
              {room.id === "general" ? (
                <span className="w-2 h-2 rounded-full shrink-0 nw-dot-glow" />
              ) : (
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: room.color }} />
              )}
              <span className="text-xs font-medium text-cream-100">{room.name}</span>
              <span className="text-[10px] text-cream-300/40 ml-auto">{room.members.length}</span>
            </button>
            {isOpen && (
              <div className="pl-6 space-y-0.5 mb-1">
                {room.members.length === 0 ? (
                  <div className="text-[11px] text-cream-300/30 py-0.5">no one yet</div>
                ) : room.members.map(m => (
                  <button
                    key={m.personaId}
                    type="button"
                    onClick={() => onSelectPersona(m.personaId)}
                    className="w-full text-left text-xs text-cream-300/80 hover:text-violet-300 px-1 py-0.5 rounded hover:bg-ink-800/60 truncate"
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
