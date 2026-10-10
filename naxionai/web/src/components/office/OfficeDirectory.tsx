import { useMemo, useState } from "react";
import { Activity, ChevronDown, ChevronRight, Search, Users } from "lucide-react";
import type { OfficeRoom } from "./types";
import { departmentColor } from "../../lib/departmentColor";

type Props = {
  rooms: OfficeRoom[];
  busyPersonaIds?: Set<string>;
  stuckPersonaIds?: Set<string>;
  pendingApprovalCounts?: Map<string, number>;
  onSelectPersona: (personaId: string) => void;
  onSelectDepartment?: (roomId: string) => void;
};

function initials(name: string): string {
  return name.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase();
}

/** A searchable roster that complements the isometric office floor. */
export function OfficeDirectory({
  rooms,
  busyPersonaIds = new Set(),
  stuckPersonaIds = new Set(),
  pendingApprovalCounts = new Map(),
  onSelectPersona,
  onSelectDepartment,
}: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(rooms.map(room => room.id)));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.flatMap(room => {
      if (room.name.toLowerCase().includes(q)) return [room];
      const members = room.members.filter(member => member.name.toLowerCase().includes(q));
      return members.length ? [{ ...room, members }] : [];
    });
  }, [rooms, query]);

  function toggle(id: string) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const totalPeople = rooms.reduce((count, room) => count + room.members.length, 0);
  const totalWorking = rooms.reduce((count, room) => count + room.members.filter(person => busyPersonaIds.has(person.personaId)).length, 0);
  const totalApprovals = [...pendingApprovalCounts.values()].reduce((count, value) => count + value, 0);

  return (
    <section className="relative isolate overflow-hidden rounded-2xl border border-ink-700/80 bg-gradient-to-b from-ink-850 to-ink-900 shadow-[0_20px_60px_-38px_rgba(0,0,0,.8)]">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-violet-500/10 blur-3xl" />
      <div className="relative border-b border-ink-700/70 px-4 pb-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-300/80">People & teams</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-cream-50">Office directory</h2>
          </div>
          <div className="grid h-10 w-10 place-items-center rounded-xl border border-violet-400/20 bg-violet-400/10 text-violet-300">
            <Users size={18} />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-xl border border-ink-700/80 bg-ink-950/45 px-2.5 py-2">
            <div className="text-lg font-semibold leading-none text-cream-50">{rooms.length}</div>
            <div className="mt-1 text-[10px] text-cream-300/60">departments</div>
          </div>
          <div className="rounded-xl border border-ink-700/80 bg-ink-950/45 px-2.5 py-2">
            <div className="text-lg font-semibold leading-none text-cream-50">{totalPeople}</div>
            <div className="mt-1 text-[10px] text-cream-300/60">team members</div>
          </div>
          <div className="rounded-xl border border-leaf-500/20 bg-leaf-500/[0.06] px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-lg font-semibold leading-none text-leaf-300">
              <span className="h-1.5 w-1.5 rounded-full bg-leaf-400 shadow-[0_0_10px_currentColor]" />{totalWorking}
            </div>
            <div className="mt-1 text-[10px] text-cream-300/60">working now</div>
          </div>
        </div>

        {totalApprovals > 0 && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.07] px-3 py-2 text-xs text-amber-200">
            <Activity size={13} /> {totalApprovals} item{totalApprovals === 1 ? "" : "s"} waiting for your review
          </div>
        )}

        <label className="relative mt-4 block">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-cream-300/40" />
          <span className="sr-only">Search departments and people</span>
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Find a person or department"
            className="w-full rounded-xl border border-ink-700 bg-ink-950/70 py-2.5 pl-9 pr-3 text-xs text-cream-100 placeholder:text-cream-300/40 focus:border-violet-400/70 focus:outline-none focus:ring-2 focus:ring-violet-400/15"
          />
        </label>
      </div>

      <div className="relative max-h-[min(48vh,420px)] space-y-2 overflow-y-auto p-3 scrollbar-thin">
        {filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-ink-700 px-4 py-8 text-center">
            <Search size={18} className="mx-auto text-cream-300/40" />
            <p className="mt-2 text-xs text-cream-200">No matches for “{query}”</p>
            <p className="mt-1 text-[11px] text-cream-300/50">Try another name or department.</p>
          </div>
        ) : filtered.map(room => {
          const isOpen = query.trim().length > 0 || expanded.has(room.id);
          const working = room.members.filter(member => busyPersonaIds.has(member.personaId)).length;
          const stuck = room.members.filter(member => stuckPersonaIds.has(member.personaId)).length;
          const approvals = pendingApprovalCounts.get(room.id) ?? 0;
          const roomListId = `office-directory-${room.id}`;
          return (
            <article key={room.id} className="overflow-hidden rounded-xl border border-ink-700/70 bg-ink-950/35 transition-colors hover:border-ink-600">
              <div className="flex items-center gap-2.5 px-3 py-2.5">
                <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: departmentColor(room.color) }} />
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={roomListId}
                  onClick={() => toggle(room.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {isOpen ? <ChevronDown size={14} className="shrink-0 text-cream-300/50" /> : <ChevronRight size={14} className="shrink-0 text-cream-300/50" />}
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-cream-100">{room.name}</span>
                  <span className="rounded-md bg-ink-800 px-1.5 py-0.5 text-[10px] tabular-nums text-cream-200/80">{room.members.length}</span>
                </button>
                {approvals > 0 && <span title={`${approvals} waiting for review`} className="rounded-full bg-amber-400/10 px-2 py-1 text-[10px] font-semibold text-amber-200">{approvals} review</span>}
                {working > 0 && <span title={`${working} working`} className="flex items-center gap-1 text-[10px] text-leaf-300"><span className="h-1.5 w-1.5 rounded-full bg-leaf-400" />{working}</span>}
                {onSelectDepartment && (
                  <button type="button" onClick={() => onSelectDepartment(room.id)} className="rounded-lg px-2 py-1 text-[10px] font-medium text-violet-300 hover:bg-violet-400/10" aria-label={`Open ${room.name} team details`}>
                    View
                  </button>
                )}
              </div>

              <div id={roomListId} hidden={!isOpen} className="border-t border-ink-700/50 px-3 pb-2 pt-1">
                  {room.members.length === 0 ? (
                    <div className="py-3 pl-3 text-[11px] text-cream-300/50">This department is ready for its first hire.</div>
                  ) : room.members.map(member => {
                    const isBusy = busyPersonaIds.has(member.personaId);
                    const isStuck = stuckPersonaIds.has(member.personaId);
                    return (
                      <button
                        key={member.personaId}
                        type="button"
                        onClick={() => onSelectPersona(member.personaId)}
                        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-ink-800/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
                      >
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-ink-700 bg-gradient-to-br from-ink-700 to-ink-900 text-[10px] font-semibold text-cream-100">{initials(member.name)}</span>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-cream-200 group-hover:text-cream-50">{member.name}</span>
                        <span className={`h-2 w-2 shrink-0 rounded-full ${isStuck ? "bg-amber-400 shadow-[0_0_9px_rgba(251,191,36,.8)]" : isBusy ? "bg-leaf-400 shadow-[0_0_9px_rgba(134,239,172,.65)]" : "bg-ink-600"}`} />
                        <span className="text-[10px] text-cream-300/50">{isStuck ? "Check in" : isBusy ? "Working" : "Ready"}</span>
                      </button>
                    );
                  })}
              </div>
            </article>
          );
        })}
      </div>
      <div className="relative border-t border-ink-700/70 px-4 py-3 text-[10px] text-cream-300/50">
        Select a teammate to open their desk and start a conversation.
      </div>
    </section>
  );
}
