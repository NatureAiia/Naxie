import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Loader2, Send, X, ChevronDown, RefreshCw, Sparkles } from "lucide-react";
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
  const [businessOpsTemplateId, setBusinessOpsTemplateId] = useState<string | null>(null);
  const [businessOpsObjective, setBusinessOpsObjective] = useState("");
  const [dispatchingBusinessOps, setDispatchingBusinessOps] = useState(false);
  const [refreshingOffice, setRefreshingOffice] = useState(false);
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
    api.listTeams().then(r => {
      setBusinessOpsTemplateId(r.templates.find(t => t.teamId === "business-ops")?.id ?? null);
    }).catch(() => {});
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
    // Keep the four approved rooms visible even before their first hire.
    const rooms = [...byId.values()];
    return { rooms, frontDeskMember };
  }, [personas, departments]);
  useEffect(() => { roomsRef.current = rooms; }, [rooms]);

  const panelPersona = panelPersonaId ? personas?.find(p => p.id === panelPersonaId) ?? null : null;
  const selectedRoom = selectedDepartmentId ? rooms.find(r => r.id === selectedDepartmentId) ?? null : null;
  const departmentCount = rooms.length;
  const hireCount = rooms.reduce((n, room) => n + room.members.length, 0);
  const workingCount = rooms.reduce((n, room) => n + room.members.filter(member => busyIds.has(member.personaId)).length, 0);
  const approvalCount = [...pendingApprovalCounts.values()].reduce((n, count) => n + count, 0);

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

  async function dispatchBusinessOpsSprint() {
    const objective = businessOpsObjective.trim();
    if (!businessOpsTemplateId || !objective) return;
    setDispatchingBusinessOps(true);
    try {
      await api.dispatchTeamTemplate(businessOpsTemplateId, objective);
      setBusinessOpsObjective("");
      showToast("Business Ops sprint dispatched to the specialists in parallel. Track the jobs in Runs.", "success");
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setDispatchingBusinessOps(false);
    }
  }

  async function refreshOffice() {
    setRefreshingOffice(true);
    try {
      const [roster, departmentList, teamList] = await Promise.all([
        api.listPersonas(), api.listDepartments(), api.listTeams(),
      ]);
      setPersonas(roster.personas);
      setActiveId(roster.activeId);
      setDepartments(departmentList.departments);
      setBusinessOpsTemplateId(teamList.templates.find(t => t.teamId === "business-ops")?.id ?? null);
      showToast("Office roster refreshed", "success");
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setRefreshingOffice(false);
    }
  }

  if (!personas || !departments) {
    return <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-cream-300/60"><Loader2 size={16} className="animate-spin" /> Loading the office…</div>;
  }

  return (
    <div className="space-y-5 pb-4">
      <section className="relative isolate overflow-hidden rounded-3xl border border-ink-700/80 bg-gradient-to-br from-ink-850 via-ink-900 to-[#171821] p-5 shadow-[0_24px_80px_-48px_rgba(125,87,246,.55)] tablet:p-7">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-32 h-80 w-80 rounded-full bg-violet-500/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute bottom-[-8rem] right-[28%] h-64 w-64 rounded-full bg-cyan-400/[0.07] blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-violet-300/20 bg-violet-400/10 text-violet-200 shadow-[inset_0_1px_0_rgba(255,255,255,.08)]">
              <Building2 size={22} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-violet-200/80">NaxionAI · People operations</span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-leaf-400/20 bg-leaf-400/[0.07] px-2 py-1 text-[10px] font-medium text-leaf-200"><span className="h-1.5 w-1.5 rounded-full bg-leaf-300 shadow-[0_0_10px_currentColor]" /> Live office</span>
              </div>
              <h1 className="mt-2 font-display text-3xl tracking-tight text-cream-50 tablet:text-4xl">Your people, in motion.</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-cream-200/70">A living view of every department. Find the right specialist, see what needs attention, and send work directly to the team.</p>
            </div>
          </div>
          <Button variant="subtle" onClick={refreshOffice} disabled={refreshingOffice} className="border-ink-600 bg-ink-800/70 px-4">
            <RefreshCw size={14} className={refreshingOffice ? "animate-spin" : ""} /> Refresh roster
          </Button>
        </div>

        <div className="relative mt-6 grid grid-cols-2 gap-2 tablet:grid-cols-4 tablet:gap-3">
          {[
            { label: "Departments", value: departmentCount, detail: "connected teams", tint: "text-violet-200", glow: "bg-violet-400/10" },
            { label: "People", value: hireCount, detail: "ready to help", tint: "text-cyan-200", glow: "bg-cyan-400/10" },
            { label: "In motion", value: workingCount, detail: "active assignments", tint: "text-leaf-200", glow: "bg-leaf-400/10" },
            { label: "Needs review", value: approvalCount, detail: approvalCount ? "your decision needed" : "all clear for now", tint: approvalCount ? "text-amber-200" : "text-cream-100", glow: approvalCount ? "bg-amber-400/10" : "bg-ink-800/50" },
          ].map(item => (
            <div key={item.label} className="relative overflow-hidden rounded-2xl border border-ink-700/80 bg-ink-950/45 px-4 py-3 backdrop-blur-sm">
              <div aria-hidden className={`absolute -right-4 -top-8 h-20 w-20 rounded-full ${item.glow} blur-2xl`} />
              <div className="relative flex items-end justify-between gap-2">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-cream-300/60">{item.label}</div>
                  <div className={`mt-1 text-2xl font-semibold tabular-nums leading-none ${item.tint}`}>{item.value}</div>
                </div>
                <div className="pb-0.5 text-right text-[10px] text-cream-300/50">{item.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 items-start gap-4 tablet:grid-cols-[minmax(0,1fr)_320px] tablet:gap-5">
        <section className="min-w-0 overflow-hidden rounded-2xl border border-ink-700/80 bg-ink-900/55 shadow-[0_20px_60px_-42px_rgba(0,0,0,.8)]">
          <div className="flex items-center justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-400/10 text-violet-200"><Building2 size={15} /></span>
              <div>
                <h2 className="text-sm font-semibold text-cream-50">Department floor</h2>
                <p className="text-[10px] text-cream-300/55">Select a room or teammate to open their workspace</p>
              </div>
            </div>
            <span className="hidden rounded-full border border-ink-700 px-2.5 py-1 text-[10px] text-cream-300/60 tablet:inline-flex">Drag to explore · Scroll to zoom</span>
          </div>
          <OfficeScene
            rooms={rooms}
            frontDeskMember={frontDeskMember}
            busyPersonaIds={busyIds}
            stuckPersonaIds={stuckIds}
            pendingApprovalCounts={pendingApprovalCounts}
            highlightPersonaId={highlightPersonaId}
            onSelectPersona={id => { setPanelPersonaId(id); setSelectedDepartmentId(null); }}
            onSelectMeetingTable={() => navigate("/council?tab=board")}
            onSelectDepartment={id => { setSelectedDepartmentId(id); setPanelPersonaId(null); }}
            height="min(68vh, 620px)"
          />
        </section>
        <OfficeDirectory
          rooms={rooms}
          busyPersonaIds={busyIds}
          stuckPersonaIds={stuckIds}
          pendingApprovalCounts={pendingApprovalCounts}
          onSelectPersona={selectFromDirectory}
          onSelectDepartment={id => { setSelectedDepartmentId(id); setPanelPersonaId(null); }}
        />
      </div>

      <Card title="Send work to the right desk" className="border border-ink-700/70 bg-gradient-to-r from-ink-900 to-ink-850">
        <p className="mb-3 text-xs text-cream-300/60">Describe the outcome. Naxie will route it to the best-fit teammate.</p>
        <div className="flex items-center gap-2">
          <input
            value={taskText}
            aria-label="Task to assign to the right department"
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

      {businessOpsTemplateId && (
        <Card title="Business Ops · weekly sprint">
          <p className="text-xs text-cream-300/60 mb-3">
            Give the team one business goal. Six specialists will prepare their work in parallel; anything sent, published, or paid for still needs approval.
          </p>
          <div className="flex flex-col tablet:flex-row gap-2">
            <input
              value={businessOpsObjective}
              onChange={e => setBusinessOpsObjective(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void dispatchBusinessOpsSprint(); } }}
              placeholder="Business + goal, e.g. Varity Vault: prepare a spring launch campaign"
              aria-label="Business Ops sprint objective"
              className="flex-1 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 focus:outline-none focus:border-amber-500/60"
            />
            <Button onClick={dispatchBusinessOpsSprint} disabled={dispatchingBusinessOps || !businessOpsObjective.trim()}>
              {dispatchingBusinessOps ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              Run sprint
            </Button>
          </div>
        </Card>
      )}

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
            <div className="text-xs text-cream-300/50 py-2">In the department catalog; no hires assigned yet.</div>
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
