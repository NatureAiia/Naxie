import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, Loader2, Send, X, ChevronDown, RefreshCw } from "lucide-react";
import { api, type WorkMode } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { OfficeDirectory } from "../components/office/OfficeDirectory";
import { DepartmentCard } from "../components/office/DepartmentCard";
import { TaskStatusPanel } from "../components/office/TaskStatusPanel";
import type { OfficeRoom, OfficeMember, OfficeJob, OfficeStatusCounts } from "../components/office/types";
import { departmentColor } from "../lib/departmentColor";

// Office — a flat dashboard: one card per department (agent count, custom
// stat lines, a DOING/NEXT/DONE job-status footer, member chips), a
// floating task-status panel, and a task-add bar. Was a full 3D Three.js
// isometric scene (OfficeScene.tsx/sceneObjects.ts) — replaced entirely, see
// docs/plans history for the reference this borrowed its visual language
// from. A view on top of Naxie's existing task-routing/chat pipeline
// (routes/chat.ts, persona-router.ts) — no new backend behavior for chat
// itself:
//   - click a member  → POST /api/chat with an explicit persona (chat.ts
//     already honors req.body.persona)
//   - the task bar    → POST /api/chat with no persona, so autoRoutePersona()
//     picks the right agent exactly like an unaddressed task anywhere else
//   - busy indicator  → poll the existing job list, no new live-update channel
//
// The per-persona chat panel also carries the roster-management actions that
// used to live on the standalone Agent Roster page (activate/deactivate,
// retire, work mode, starter-template refresh) — one place per persona
// instead of a separate page duplicating the same list. Creating a NEW
// persona from a job description is intentionally not here: that's Naxie's
// job now (personas.manage, primitives.ts), proposed conversationally and
// approved like any other roster change, not a manual form.
//
// Naxie sits at a fixed front desk (not a department card); Neuro (clawbot)
// is filtered out entirely — it's documented as an internal tool persona the
// operator doesn't talk to directly, not a hire.
const JOB_POLL_MS = 5000;
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // running > 5 min gets the distinct warning marker
const HIDDEN_PERSONA_IDS = new Set(["clawbot"]);
const GENERAL_ROOM: OfficeRoom = { id: "general", name: "General", color: "slate", members: [] };
const EMPTY_STATUS: OfficeStatusCounts = { doing: 0, next: 0, waiting: 0, done: 0, failed: 0 };

type PersonaRow = {
  id: string; name: string; department?: string;
  role?: string; description?: string; tone?: string;
  responsibilities?: string[]; workMode?: WorkMode; builtin?: boolean;
};
type DeptRow = { id: string; name: string; color?: string };

type ChatMsg = { role: "user" | "assistant"; content: string };

// Raw fields we read off a job for the dashboard — a subset of the full
// server Job shape (server/src/lib/jobs.ts), which api.listJobs() returns
// untyped. `log`/`plan` back the running-job progress heuristic below.
type RawJob = {
  id: string; status: string; personaId?: string; personaName?: string;
  title?: string; template?: string; kind?: string;
  startedAt?: string; finishedAt?: string;
  log?: unknown[]; plan?: { steps?: unknown[] };
};

function jobTitle(j: RawJob): string {
  const t = (j.title ?? "").replace(/^Ad-hoc:\s*/i, "").trim();
  return t || j.template || j.kind || "Task";
}

// Coarse, explicitly-approximate progress for a running job — there's no
// real numeric progress field on a Job, so this is log entries emitted so
// far against the planned step count, capped short of 100% (never claim
// "done" for a job that's still running). Every other status shows elapsed/
// finished time instead (see TaskStatusPanel), not a fabricated percentage.
function progressHeuristic(j: RawJob): number | null {
  if (j.status !== "running") return null;
  const steps = j.plan?.steps?.length ?? 0;
  if (steps <= 0) return null;
  const logLen = j.log?.length ?? 0;
  return Math.max(2, Math.min(95, Math.round((logLen / steps) * 100)));
}

export function Office() {
  const [personas, setPersonas] = useState<PersonaRow[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [departments, setDepartments] = useState<DeptRow[] | null>(null);
  const [rawJobs, setRawJobs] = useState<RawJob[]>([]);
  const [officeNotes, setOfficeNotes] = useState<Record<string, string[]>>({});
  const [panelPersonaId, setPanelPersonaId] = useState<string | null>(null);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState<string | null>(null);
  const [taskText, setTaskText] = useState("");
  const [sendingTask, setSendingTask] = useState(false);
  const [highlightPersonaId, setHighlightPersonaId] = useState<string | null>(null);

  // H — selecting someone from the directory opens the same chat panel a
  // member chip click would, plus a brief highlight (kept for the directory's
  // own visual feedback even though there's no 3D desk to pulse anymore).
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

  async function saveDepartmentNotes(departmentId: string, lines: string[]) {
    try {
      const r = await api.setOfficeNotes(departmentId, lines);
      setOfficeNotes(prev => ({ ...prev, [departmentId]: r.lines }));
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  useEffect(() => {
    loadPersonas();
    api.listDepartments().then(r => setDepartments(r.departments)).catch(e => showToast(e?.message ?? String(e), "error"));
    api.listOfficeNotes().then(r => setOfficeNotes(r.notes)).catch(() => {});
  }, []);

  // Job-list polling — same feed the Runs/Approvals pages already read. Kept
  // as raw jobs in state; every derived view (busy dots, per-department
  // status counts, the task-status panel) is computed from this in memos
  // below, so the poll itself stays a dumb, cheap fetch.
  useEffect(() => {
    let stopped = false;
    async function poll() {
      try {
        const { jobs } = await api.listJobs();
        if (!stopped) setRawJobs(jobs as RawJob[]);
      } catch { /* best-effort — a failed poll just leaves the last-known list */ }
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
    // Drop any department with no hires — an empty card is just noise on
    // the office view, not a useful "you could hire here" signal.
    const rooms = [...byId.values()].filter(r => r.members.length > 0);
    return { rooms, frontDeskMember };
  }, [personas, departments]);

  // personaId -> room, so jobs (which only carry personaId) can be bucketed
  // by department and every card's busy/status counts stay in sync with jobs.
  const personaRoom = useMemo(() => {
    const m = new Map<string, OfficeRoom>();
    for (const r of rooms) for (const mem of r.members) m.set(mem.personaId, r);
    return m;
  }, [rooms]);

  const busyIds = useMemo(() => new Set(
    rawJobs.filter(j => (j.status === "running" || j.status === "pending") && j.personaId).map(j => j.personaId!),
  ), [rawJobs]);

  // Per-department DOING/NEXT/DONE(+failed) breakdown feeding each
  // DepartmentCard's footer and the expanded DepartmentPanel.
  const roomStatusCounts = useMemo(() => {
    const map = new Map<string, OfficeStatusCounts>();
    for (const r of rooms) map.set(r.id, { doing: 0, next: 0, waiting: 0, done: 0, failed: 0 });
    for (const j of rawJobs) {
      if (!j.personaId) continue;
      const room = personaRoom.get(j.personaId);
      if (!room) continue;
      const c = map.get(room.id);
      if (!c) continue;
      if (j.status === "running") c.doing++;
      else if (j.status === "pending") c.next++;
      else if (j.status === "awaiting-approval" || j.status === "waiting_on_human") c.waiting++;
      else if (j.status === "succeeded") c.done++;
      else if (j.status === "failed" || j.status === "rejected") { c.done++; c.failed++; }
    }
    return map;
  }, [rawJobs, rooms, personaRoom]);

  // Flattened, dashboard-shaped job list for the TaskStatusPanel.
  const officeJobs: OfficeJob[] = useMemo(() => rawJobs
    .filter(j => !j.personaId || !HIDDEN_PERSONA_IDS.has(j.personaId))
    .map(j => {
      const room = j.personaId ? personaRoom.get(j.personaId) : undefined;
      const stuck = j.status === "running" && !!j.startedAt && Date.now() - new Date(j.startedAt).getTime() > STUCK_THRESHOLD_MS;
      return {
        id: j.id,
        title: jobTitle(j),
        status: j.status as OfficeJob["status"],
        personaId: j.personaId,
        personaName: j.personaName,
        department: room?.name,
        startedAt: j.startedAt,
        finishedAt: j.finishedAt,
        stuck,
        progressPct: progressHeuristic(j),
      };
    })
    // Most recently started first — same convention Runs.tsx uses.
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")),
  [rawJobs, personaRoom]);

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
          <p className="text-sm text-cream-300/60">Every hire, by department. Click a card for details, a member to chat 1:1, or drop a task below to route it automatically.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 items-start">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {frontDeskMember && (
            <button
              type="button"
              onClick={() => setPanelPersonaId(frontDeskMember.personaId)}
              className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-3.5 text-left hover:border-violet-500/50 transition-colors flex items-center gap-3"
            >
              <span className="w-9 h-9 rounded-full bg-violet-500/20 border border-violet-500/40 flex items-center justify-center text-sm font-medium text-violet-200 shrink-0">
                {frontDeskMember.name.slice(0, 1)}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-cream-50 truncate">{frontDeskMember.name}</div>
                <div className="text-[10px] uppercase tracking-wider text-violet-300/70">Front desk — always on</div>
              </div>
            </button>
          )}
          {rooms.map(r => (
            <DepartmentCard
              key={r.id}
              room={r}
              statusCounts={roomStatusCounts.get(r.id) ?? EMPTY_STATUS}
              busyPersonaIds={busyIds}
              notes={officeNotes[r.id] ?? []}
              onSaveNotes={lines => saveDepartmentNotes(r.id, lines)}
              onOpenDepartment={() => setSelectedDepartmentId(r.id)}
              onSelectPersona={selectFromDirectory}
            />
          ))}
        </div>

        <div className="space-y-4">
          <TaskStatusPanel jobs={officeJobs} />
          <OfficeDirectory rooms={rooms} onSelectPersona={selectFromDirectory} />
        </div>
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
          statusCounts={roomStatusCounts.get(selectedRoom.id) ?? EMPTY_STATUS}
          onClose={() => setSelectedDepartmentId(null)}
          onSelectPersona={selectPersonaFromDepartment}
        />
      )}
    </div>
  );
}

// Docked frosted-glass chat rail — a right-docked panel that slides in over a
// dimming scrim, closer to how a focused department/agent view should feel
// than a blocking dialog box. Stays mounted through its exit transition:
// `requestClose` flips `closing` and only calls the real `onClose` (which
// unmounts it) after the transition duration, so the slide-out actually
// plays instead of the panel vanishing instantly.
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
                  title="agent = fully autonomous · hybrid = agent + pauses for your input · human = person does the work, system tracks it"
                >
                  <option value="agent">agent</option>
                  <option value="hybrid">hybrid</option>
                  <option value="human">human</option>
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
// PersonaChatPanel, opened by clicking a department card. Shows the room's
// live status (member count, who's busy, the same DOING/NEXT/DONE breakdown
// the card footer shows, anything awaiting the operator's approval) and
// hands off to the per-persona chat rail on member click — only one rail is
// ever open at a time (see Office()'s selectPersonaFromDepartment).
type DepartmentPanelProps = {
  room: OfficeRoom;
  busyPersonaIds: Set<string>;
  statusCounts: OfficeStatusCounts;
  onClose: () => void;
  onSelectPersona: (personaId: string) => void;
};

function DepartmentPanel({ room, busyPersonaIds, statusCounts, onClose, onSelectPersona }: DepartmentPanelProps) {
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
  const color = room.id === "general" ? "#7d57f6" : departmentColor(room.color);

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
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
            <h2 className="text-lg text-cream-50 font-medium truncate">{room.name}</h2>
          </div>
          <button onClick={requestClose} className="text-cream-300/50 hover:text-cream-100 shrink-0"><X size={18} /></button>
        </div>

        <div className="flex items-center gap-4 text-xs text-cream-300/70 border border-ink-800 rounded-lg bg-ink-950/40 px-3 py-2 flex-wrap">
          <span>{room.members.length} member{room.members.length === 1 ? "" : "s"}</span>
          <span>{busyCount} busy now</span>
          {statusCounts.waiting > 0 && (
            <span className="text-coral-400 font-medium">{statusCounts.waiting} awaiting your sign-off</span>
          )}
        </div>

        <div className="flex items-center justify-between text-[10px] text-cream-300/60 border-b border-ink-800 pb-2">
          <span>DOING <b className="text-cream-100">{statusCounts.doing}</b></span>
          <span>NEXT <b className="text-cream-100">{statusCounts.next}</b></span>
          <span>
            DONE <b className="text-cream-100">{statusCounts.done}</b>
            {statusCounts.failed > 0 && <span className="text-coral-400 ml-1">({statusCounts.failed} failed)</span>}
          </span>
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
