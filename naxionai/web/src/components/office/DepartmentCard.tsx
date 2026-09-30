import { useState } from "react";
import { Pencil, Check, X as XIcon } from "lucide-react";
import type { OfficeRoom, OfficeStatusCounts } from "./types";
import { colorFromName, initialsFromName } from "./personaVisuals";
import { departmentColor } from "../../lib/departmentColor";

// A department "pod" card — the flat-dashboard replacement for one of the
// old 3D office's floor islands. Real data (agent count, DOING/NEXT/DONE
// footer) plus up to two operator-editable free-text stat lines (stored via
// office-notes.ts, NOT computed — there's no backend metric behind an
// "emails sent" style stat, so we never fabricate one).
type Props = {
  room: OfficeRoom;
  statusCounts: OfficeStatusCounts;
  busyPersonaIds: Set<string>;
  notes: string[];
  onSaveNotes: (lines: string[]) => void;
  onOpenDepartment: () => void;
  onSelectPersona: (personaId: string) => void;
};

const MAX_CHIPS = 6;

export function DepartmentCard({ room, statusCounts, busyPersonaIds, notes, onSaveNotes, onOpenDepartment, onSelectPersona }: Props) {
  const [editingNotes, setEditingNotes] = useState(false);
  const [draft, setDraft] = useState<[string, string]>([notes[0] ?? "", notes[1] ?? ""]);
  const color = room.id === "general" ? "#7d57f6" : departmentColor(room.color);

  function startEdit() {
    setDraft([notes[0] ?? "", notes[1] ?? ""]);
    setEditingNotes(true);
  }
  function save() {
    onSaveNotes(draft.map(l => l.trim()).filter(Boolean));
    setEditingNotes(false);
  }

  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900 overflow-hidden flex flex-col">
      <div className="h-1" style={{ backgroundColor: color }} />
      <div className="p-3.5 space-y-3 flex-1 flex flex-col">
        <button type="button" onClick={onOpenDepartment} className="w-full text-left">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
            <span className="text-sm font-medium text-cream-50 truncate">{room.name}</span>
          </div>
          <div className="text-2xl font-display text-cream-50 mt-1 leading-none">{room.members.length}</div>
          <div className="text-[10px] uppercase tracking-wider text-cream-300/50">agent{room.members.length === 1 ? "" : "s"}</div>
        </button>

        {editingNotes ? (
          <div className="space-y-1.5">
            {([0, 1] as const).map(i => (
              <input
                key={i}
                value={draft[i]}
                onChange={e => setDraft(d => { const next: [string, string] = [...d]; next[i] = e.target.value; return next; })}
                placeholder={`stat ${i + 1}, e.g. "emails sent: 128"`}
                maxLength={60}
                className="w-full bg-ink-950 border border-ink-800 rounded px-2 py-1 text-[11px] text-cream-100 focus:outline-none focus:border-violet-500/60"
              />
            ))}
            <div className="flex items-center gap-3">
              <button type="button" onClick={save} className="text-[11px] text-leaf-400 hover:text-leaf-300 inline-flex items-center gap-1"><Check size={11} /> Save</button>
              <button type="button" onClick={() => setEditingNotes(false)} className="text-[11px] text-cream-300/60 hover:text-cream-100 inline-flex items-center gap-1"><XIcon size={11} /> Cancel</button>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {notes.length > 0 ? notes.map((n, i) => (
              <div key={i} className="text-[11px] text-cream-300/70 truncate">{n}</div>
            )) : (
              <div className="text-[11px] text-cream-300/30">No notes yet</div>
            )}
            <button type="button" onClick={startEdit} className="text-[10px] text-cream-300/50 hover:text-violet-300 inline-flex items-center gap-1 mt-0.5">
              <Pencil size={10} /> {notes.length ? "Edit" : "Add"} stats
            </button>
          </div>
        )}

        {room.members.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {room.members.slice(0, MAX_CHIPS).map(m => (
              <button
                key={m.personaId}
                type="button"
                onClick={() => onSelectPersona(m.personaId)}
                title={m.name}
                className="relative w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-medium text-white shrink-0"
                style={{ backgroundColor: colorFromName(m.name) }}
              >
                {initialsFromName(m.name)}
                {busyPersonaIds.has(m.personaId) && (
                  <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-leaf-400 border border-ink-900" />
                )}
              </button>
            ))}
            {room.members.length > MAX_CHIPS && (
              <span className="text-[10px] text-cream-300/50 self-center">+{room.members.length - MAX_CHIPS}</span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between text-[10px] text-cream-300/60 pt-2 mt-auto border-t border-ink-800">
          <span>DOING <b className="text-cream-100">{statusCounts.doing}</b></span>
          <span>NEXT <b className="text-cream-100">{statusCounts.next}</b></span>
          <span>
            DONE <b className="text-cream-100">{statusCounts.done}</b>
            {statusCounts.failed > 0 && <span className="text-coral-400 ml-1">({statusCounts.failed} failed)</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
