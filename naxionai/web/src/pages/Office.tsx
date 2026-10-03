import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Loader2, Send, X, ChevronDown, RefreshCw } from "lucide-react";
import { api, type WorkMode } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { OfficeScene, type OfficeRoom, type OfficeMember } from "../components/office/OfficeScene";
import { OfficeDirectory } from "../components/office/OfficeDirectory";

// Office — a 3D isometric floor showing every persona at a desk, grouped into
// department rooms. New *view* on top of Naxie's existing task-routing/chat
// pipeline (routes/chat.ts, persona-router.ts) — no new backend behavior:
//   - click a desk  → POST /api/chat with an explicit persona (chat.ts already
//     honors req.body.persona)
//   - the task bar   → POST /api/chat with no persona, so autoRoutePersona()
//     picks the desk exactly like an unaddressed task anywhere else
//   - busy indicator → poll the existing job list, no new live-update channel
//
// The per-desk chat panel also carries the roster-management actions that
// used to live on the standalone Agent Roster page (activate/deactivate,
// retire, work mode, starter-template refresh) — one place per persona
// instead of a separate page duplicating the same list. Creating a NEW
// persona from a job description is intentionally not here: that's Naxie's
// job now (personas.manage, primitives.ts), proposed conversationally and
// approved like any other roster change, not a manual form.
//
// Naxie sits at a fixed front desk (not a department room); Naxie Agent
// is filtered out entirely — it's documented as an internal tool persona the
// operator doesn't talk to directly, not a hire.
const JOB_POLL_MS = 5000;
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // running > 5 min gets the distinct warning marker
const HIDDEN_PERSONA_IDS = new Set(["naxie-agent"]);
const GENERAL_ROOM: OfficeRoom = { id: "general", name: "General", color: "slate", members: [] };

type PersonaRow = {
  id: string; name: string; department?: string;
  role?: string; description?: string; tone?: string;
  responsibilities?: string[]; workMode?: WorkMode; builtin?: boolean;
};
type DeptRow = { id: string; name: string; color?: string };

type ChatMsg = { role: "user" | "assistant"; content: string };

export function Office() {
  const navigate = useNavigate();
  const [personas, setPersonas] = useState<PersonaRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [departments, setDepartments] = useState<DeptRow[] | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [stuckIds, setStuckIds] = useState<Set<string>>(new Set());
  const [pendingApprovalCounts, setPendingApprovalCounts] = useState<Map<string, number>>(new Map());
  const [panelPersonaId, setPanelPersonaId] = useState<string | null>(null);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string | null>(null);
  const [taskText, setTaskText] = useState("");
  const [sendingTask, setSendingTask] = useState(false);
  const [highlightPersonaId, setHighlightPersonaId] = useState<string | null>(null);

  // H — selecting someone from the directory opens the same chat panel a
  // desk click would, plus a brief highlight pulse on their desk so it's
  // obvious which one just got picked.
  function selectFromDirectory(personaId: string) {
    setPanelPersonaId(personaId);
    setSelectedDepartmentId(null);
    setHighlightPersonaId(personaId);
    setTimeout(() => setHighlightPersonaId(cur => (cur === personaId ? null : cur)), 1000);
  }

  // Only one rail is open at a time — picking a persona from inside the
  // department panel hands off to the persona chat rail, not a stack of two.
  function selectPersonaFromDepartment(personaId: string) {
    setSelectedDepartmentId(null);
    setPanelPersonaId(personaId);
  }

  function loadPersonas() {
    return api.listPersonas()
      .then(r => { setPersonas(r.personas); setActiveId(r.activeId); })
      .catch(e => showToast(e?.message ?? String(e), "error"));
  }

  // Roster-management actions (moved here from the old Agent Roster page —
  // one desk, one place to manage the persona sitting at it).
  async function activatePersona(id: string) { try { await api.activatePersona(id); await loadPersonas(); } catch (e: any) { showToast(e?.message ?? String(e), "error"); } }
  async function deactivatePersona() { try { await api.deactivatePersona(); await loadPersonas(); } catch (e: any) { showToast(e?.message ?? String(e), "error"); } }
  async function setPersonaWorkMode(id: string, workMode: WorkMode) { try { await api.updatePersona(id, { workMode }); await loadPersonas(); } catch (e: any) { showToast(e?.message ?? String(e), "error"); } }
  async function retirePersona(id: string) {
    try {
      await api.deletePersona(id);
      setPanelPersonaId(null);
      await loadPersonas();
      showToast("Persona retired", "success");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  useEffect(() => {
    loadPersonas();
    api.listDepartments().then(r => setDepartments(r.departments)).catch(e => showToast(e?.message ?? String(e), "error"));
  }, []);

  // personaId → roomId, kept current via a ref so the poll effect below
  // (mounted once, deps []) can bucket jobs by department without having to
  // restart its interval every time `rooms` recomputes. Populated below, once
  // `rooms` itself is computed (see the useMemo further down) — declared here
  // so the poll effect (which runs first) can already close over the ref.
  const roomsRef = useRef<OfficeRoom[]>([]);

  // Busy-desk polling — same job list the Runs/Approvals pages already read,
  // just filtered down to "does this personaId have a live job right now."
  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const { jobs } = await api.listJobs();
        if (stopped) return;
        const live = new Set<string>();
        const stuck = new Set<string>();
        const now = Date.now();
        const personaToRoom = new Map<string, string>();
        for (const r of roomsRef.current) for (const m of r.members) personaToRoom.set(m.personaId, r.id);
        const pending = new Map<string, number>();
        for (const j of jobs as any[]) {
          if ((j.status === "running" || j.status === "pending") && j.personaId) {
            live.add(j.personaId);
            // 4B/7D — a job running well past a normal duration gets the
            // distinct warning marker instead of (well, alongside) the plain
            // busy indicator, so a hung job is obvious at a glance.
            if (j.status === "running" && j.startedAt && now - new Date(j.startedAt).getTime() > STUCK_THRESHOLD_MS) {
              stuck.add(j.personaId);
            }
          }
          // Org-wide approval-pending digest, bucketed by department — feeds
          // OfficeScene's badge glow so "N things await your sign-off" is
          // visible on the floor plan itself, not just the Approvals page.
          if (j.status === "awaiting-approval" && j.personaId) {
            const roomId = personaToRoom.get(j.personaId);
            if (roomId) pending.set(roomId, (pending.get(roomId) ?? 0) + 1);
          }
        }
        setBusyIds(live);
        setStuckIds(stuck);
        setPendingApprovalCounts(pending);
      } catch { /* best-effort — a failed poll just leaves indicators as they were */ }
    }
    poll();
    const id = setInterval(poll, JOB_POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  const { rooms, frontDeskMember } = useMemo(() => {
    if (!personas || !departments) return { rooms: [] as OfficeRoom[], frontDeskMember: null as OfficeMember | null };
    const byId = new Map<string, OfficeRoom>();
    for (const d of departments) byId.set(d.id, { id: d.id, name: d.name, color: d.color ?? "slate", members: [] });
    if (!byId.has(GENERAL_ROOM.id)) byId.set(GENERAL_ROOM.id, { ...GENERAL_ROOM, members: [] });

    let frontDeskMember: OfficeMember | null = null;
    for (const p of personas) {
      if (HIDDEN_PERSONA_IDS.has(p.id)) continue;
      if (p.id === "naxie") { frontDeskMember = { personaId: p.id, name: p.name }; continue; }
      const deptId = p.department && byId.has(p.department) ? p.department : GENERAL_ROOM.id;
      byId.get(deptId)!.members.push({ personaId: p.id, name: p.name });
    }
    // Drop any department with no hires — an empty floor is just noise on
    // the office view, not a useful "you could hire here" signal.
    const rooms = [...byId.values()].filter(r => r.members.length > 0);
    return { rooms, frontDeskMember };
  }, [personas, departments]);
  useEffect(() => { roomsRef.current = rooms; }, [rooms]);

  const panelPersona = panelPersonaId ? personas?.find(p => p.id === panelPersonaId) ?? null : null;
  const selectedRoom = selectedDepartmentId ? rooms.find(r => r.id === selectedDepartmentId) ?? null : null;

  async function submitTask() {
    const text = taskText.trim();
    if (!text) return;
    setSendingTask(true);
    try {
      const r = await api.chat([{ role: "user", content: text }]);
      const who = r.handledBy?.personaName ?? r.activePersona?.name ?? "Naxie";
      showToast(`Routed to ${who}`, "success");
      setTaskText("");
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setSendingTask(false);
    }
  }

  if (!personas || !departments) {
    return <div className="flex items-center gap-2 text-sm text-cream-300/60"><Loader2 size={16} className="animate-spin" /> Loading the office…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Building2 size={22} />
        <div>
          <h1 className="font-display text-2xl text-cream-50">Office</h1>
          <p className="text-sm text-cream-300/60">Every hire, at their desk. Click a desk to chat 1:1, or drop a task below to route it automatically.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 tablet:grid-cols-[1fr_260px] gap-4 items-start">
        <OfficeScene
          rooms={rooms}
          frontDeskMember={frontDeskMember}
          busyPersonaIds={busyIds}
          stuckPersonaIds={stuckIds}
          pendingApprovalCounts={pendingApprovalCounts}
          highlightPersonaId={highlightPersonaId}
          onSelectPersona={id => { setPanelPersonaId(id); setSelectedDepartmentId(null); }}
          onSelectMeetingTable={() => navigate("/chat")}
          onSelectDepartment={id => { setSelectedDepartmentId(id); setPanelPersonaId(null); }}
          height="min(70vh, 640px)"
        />
        <OfficeDirectory rooms={rooms} onSelectPersona={selectFromDirectory} />
      </div>

      <Card>
        <div className="flex items-center gap-2">
          <input
            value={taskText}
            onChange={e => setTaskText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitTask(); } }}
            placeholder="Type a task — it'll route to the right desk automatically…"
            className="flex-1 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60"
          />
          <Button onClick={submitTask} disabled={sendingTask || !taskText.trim()}>
            {sendingTask ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send
          </Button>
        </div>
      </Card>

      {panelPersona && (
        <PersonaChatPanel
          persona={panelPersona}
          isActive={panelPersona.id === activeId}
          onClose={() => setPanelPersonaId(null)}
          onActivate={() => activatePersona(panelPersona.id)}
          onDeactivate={deactivatePersona}
          onWorkModeChange={mode => setPersonaWorkMode(panelPersona.id, mode)}
          onRetire={() => retirePersona(panelPersona.id)}
        />
      )}

      {selectedRoom && (
        <DepartmentPanel
          room={selectedRoom}
          busyPersonaIds={busyIds}
          pendingApprovalCount={pendingApprovalCounts.get(selectedRoom.id) ?? 0}
          onClose={() => setSelectedDepartmentId(null)}
          onSelectPersona={selectPersonaFromDepartment}
        />
      )}
    </div>
  );
}

// Docked frosted-glass chat rail — replaces the old center-screen modal with
// a right-docked panel that slides in over a dimming scrim, closer to how a
// focused department/agent view should feel than a blocking dialog box.
// Stays mounted through its exit transition: `requestClose` flips `closing`
// and only calls the real `onClose` (which unmounts it) after the transition
// duration, so the slide-out actually plays instead of the panel vanishing
// instantly.
const RAIL_TRANSITION_MS = 300;

type PersonaChatPanelProps = {
  persona: PersonaRow;
  isActive: boolean;
  onClose: () => void;
  onActivate: () => void;
  onDeactivate: () => void;
  onWorkModeChange: (mode: WorkMode) => void;
  onRetire: () => void;
};

function PersonaChatPanel({ persona, isActive, onClose, onActivate, onDeactivate, onWorkModeChange, onRetire }: PersonaChatPanelProps) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [entered, setEntered] = useState(false);
  const [closing, setClosing] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [templateCount, setTemplateCount] = useState<number | null>(null);
  const [refreshState, setRefreshState] = useState<{ state: "idle" | "running" | "ok" | "fail"; info?: string }>({ state: "idle" });
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  // One frame after mount, so the initial (off-screen) state actually paints
  // before the transition to `entered` kicks in.
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Starter-template count — fetched lazily per persona when their panel
  // opens, rather than for the whole roster up front (only one panel is ever
  // open at a time, unlike the old Agent Roster page's all-at-once fetch).
  useEffect(() => {
    setTemplateCount(null);
    setConfirmingRetire(false);
    api.listPersonaTemplates(persona.id).then(r => setTemplateCount(r.templates.length)).catch(() => setTemplateCount(0));
  }, [persona.id]);

  async function refreshTemplates() {
    setRefreshState({ state: "running" });
    try {
      const r = await api.refreshPersonaTemplates(persona.id);
      setTemplateCount(r.ids.length);
      setRefreshState({ state: "ok", info: `+${r.added} new · ${r.kept} kept · ${r.removed} removed` });
      setTimeout(() => setRefreshState(s => (s.state === "ok" ? { state: "idle" } : s)), 3500);
    } catch (e: any) {
      setRefreshState({ state: "fail", info: e?.message ?? String(e) });
    }
  }

  function requestClose() {
    setClosing(true);
    setTimeout(onClose, RAIL_TRANSITION_MS);
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    const next: ChatMsg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setSending(true);
    try {
      const r = await api.chat(next, { persona: persona.id });
      setMessages(m => [...m, { role: "assistant", content: r.text }]);
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setSending(false);
    }
  }

  const open = entered && !closing;

  return (
    <div
      className={`fixed inset-0 z-50 transition-colors duration-300 ease-settle ${open ? "bg-black/50" : "bg-black/0"}`}
      onClick={requestClose}
    >
      <div
        className={`fixed inset-y-0 right-0 w-full max-w-md bg-ink-900/90 backdrop-blur-xl border-l border-ink-700 p-4 space-y-3 h-full flex flex-col shadow-2xl shadow-black/40 transition-transform duration-300 ease-settle ${open ? "translate-x-0" : "translate-x-full"}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-lg text-cream-50 font-medium truncate">{persona.name}</h2>
            {persona.role && <div className="text-xs text-cream-300/60 truncate">{persona.role}</div>}
          </div>
          <button onClick={requestClose} className="text-cream-300/50 hover:text-cream-100 shrink-0"><X size={18} /></button>
        </div>

        <div className="border border-ink-800 rounded-lg bg-ink-950/40">
          <button
            type="button"
            onClick={() => setManageOpen(o => !o)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs text-cream-300/70 hover:text-cream-100"
          >
            <span className="flex items-center gap-2">
              Manage
              {isActive && <span className="text-[10px] uppercase tracking-wider bg-violet-500/20 text-violet-300 px-1.5 py-0.5 rounded-full border border-violet-500/30">active</span>}
            </span>
            <ChevronDown size={14} className={`transition-transform ${manageOpen ? "rotate-180" : ""}`} />
          </button>
          {manageOpen && (
            <div className="px-3 pb-3 space-y-2.5 border-t border-ink-800 pt-2.5">
              {persona.description && <div className="text-xs text-cream-300/80">{persona.description}</div>}
              {persona.tone && <div className="text-[10px] text-cream-300/50">tone: {persona.tone}</div>}
              {!!persona.responsibilities?.length && (
                <details>
                  <summary className="text-[11px] text-cream-300 cursor-pointer hover:text-cream-100">Responsibilities ({persona.responsibilities.length})</summary>
                  <ul className="list-disc pl-5 mt-1 text-[11px] text-cream-200 space-y-0.5">
                    {persona.responsibilities.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </details>
              )}

              <div className="flex items-center gap-2">
                <span className="text-[10px] text-cream-300/50 uppercase tracking-wider">work mode</span>
                <select
                  value={persona.workMode ?? "agent"}
                  onChange={e => onWorkModeChange(e.target.value as WorkMode)}
                  className="bg-ink-800 border border-ink-700 text-[11px] text-cream-200 rounded px-1.5 py-0.5"
                  title="agent = fully autonomous · hybrid = agent + pauses for your input"
                >
                  <option value="agent">agent</option>
                  <option value="hybrid">hybrid</option>
                </select>
              </div>

              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[11px] text-cream-300/60">
                  {templateCount != null ? `${templateCount} starter template${templateCount === 1 ? "" : "s"}` : "templates: —"}
                </span>
                <button
                  type="button"
                  onClick={refreshTemplates}
                  disabled={refreshState.state === "running"}
                  className="inline-flex items-center gap-1 text-[11px] text-cream-300 hover:text-violet-300 disabled:opacity-40"
                  title="Regenerate starter templates from this persona's responsibilities. Keeps run history on unchanged ones."
                >
                  <RefreshCw size={11} className={refreshState.state === "running" ? "animate-spin" : ""} />
                  {refreshState.state === "running" ? "Refreshing…" : "Refresh templates"}
                </button>
              </div>
              {refreshState.state === "ok" && <div className="text-[11px] text-leaf-400">✓ {refreshState.info}</div>}
              {refreshState.state === "fail" && <div className="text-[11px] text-coral-400">{refreshState.info}</div>}

              <div className="flex items-center justify-between pt-2 border-t border-ink-800">
                {!confirmingRetire ? (
                  <button type="button" onClick={() => setConfirmingRetire(true)} className="text-xs text-cream-300/50 hover:text-coral-400">Retire persona</button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-coral-300">Retire {persona.name}? Deletes their templates too.</span>
                    <button type="button" onClick={onRetire} className="text-[11px] text-coral-300 hover:text-coral-200 font-medium">Confirm</button>
                    <button type="button" onClick={() => setConfirmingRetire(false)} className="text-[11px] text-cream-300/60 hover:text-cream-100">Cancel</button>
                  </div>
                )}
                {isActive ? (
                  <Button variant="subtle" onClick={onDeactivate}>Deactivate</Button>
                ) : (
                  <Button variant="subtle" onClick={onActivate}>Activate</Button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto space-y-2 min-h-[200px]">
          {messages.length === 0 && <div className="text-xs text-cream-300/40">Say hi to {persona.name} — this chat is scoped to them specifically.</div>}
          {messages.map((m, i) => (
            <div key={i} className={`text-sm rounded-lg px-3 py-2 max-w-[85%] ${m.role === "user" ? "ml-auto bg-violet-600 text-white" : "bg-ink-950 text-cream-100"}`}>
              {m.content}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={`Message ${persona.name}…`}
            className="flex-1 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60"
            autoFocus
          />
          <Button onClick={send} disabled={sending || !input.trim()}>
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Department detail rail — the same docked frosted-glass treatment as
// PersonaChatPanel, opened by clicking a department badge in OfficeScene.
// Shows the room's live status (member count, who's busy, anything awaiting
// the operator's approval) and hands off to the per-persona chat rail on
// member click — only one rail is ever open at a time (see Office()'s
// selectPersonaFromDepartment).
type DepartmentPanelProps = {
  room: OfficeRoom;
  busyPersonaIds: Set<string>;
  pendingApprovalCount: number;
  onClose: () => void;
  onSelectPersona: (personaId: string) => void;
};

function DepartmentPanel({ room, busyPersonaIds, pendingApprovalCount, onClose, onSelectPersona }: DepartmentPanelProps) {
  const [entered, setEntered] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  function requestClose() {
    setClosing(true);
    setTimeout(onClose, RAIL_TRANSITION_MS);
  }

  const open = entered && !closing;
  const busyCount = room.members.filter(m => busyPersonaIds.has(m.personaId)).length;

  return (
    <div
      className={`fixed inset-0 z-50 transition-colors duration-300 ease-settle ${open ? "bg-black/50" : "bg-black/0"}`}
      onClick={requestClose}
    >
      <div
        className={`fixed inset-y-0 right-0 w-full max-w-md bg-ink-900/90 backdrop-blur-xl border-l border-ink-700 p-4 space-y-3 h-full flex flex-col shadow-2xl shadow-black/40 transition-transform duration-300 ease-settle ${open ? "translate-x-0" : "translate-x-full"}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            {room.id === "general" ? (
              <span className="w-2.5 h-2.5 rounded-full shrink-0 nw-dot-glow" />
            ) : (
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: room.color }} />
            )}
            <h2 className="text-lg text-cream-50 font-medium truncate">{room.name}</h2>
          </div>
          <button onClick={requestClose} className="text-cream-300/50 hover:text-cream-100 shrink-0"><X size={18} /></button>
        </div>

        <div className="flex items-center gap-4 text-xs text-cream-300/70 border border-ink-800 rounded-lg bg-ink-950/40 px-3 py-2">
          <span>{room.members.length} member{room.members.length === 1 ? "" : "s"}</span>
          <span>{busyCount} busy now</span>
          {pendingApprovalCount > 0 && (
            <span className="text-coral-400 font-medium">{pendingApprovalCount} awaiting your sign-off</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto space-y-1">
          {room.members.length === 0 ? (
            <div className="text-xs text-cream-300/40 py-2">No one here yet.</div>
          ) : room.members.map(m => (
            <button
              key={m.personaId}
              type="button"
              onClick={() => onSelectPersona(m.personaId)}
              className="w-full flex items-center justify-between text-left text-sm text-cream-100 hover:text-violet-300 px-2 py-1.5 rounded hover:bg-ink-800/60"
            >
              <span className="truncate">{m.name}</span>
              {busyPersonaIds.has(m.personaId) && <span className="text-[10px] text-leaf-400 shrink-0">busy</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
