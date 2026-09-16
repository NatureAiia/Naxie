import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, Loader2, Send, X } from "lucide-react";
import { api } from "../lib/api";
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
// Naxie sits at a fixed front desk (not a department room); Neuro (clawbot)
// is filtered out entirely — it's documented as an internal tool persona the
// operator doesn't talk to directly, not a hire.
const JOB_POLL_MS = 5000;
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // running > 5 min gets the distinct warning marker
const HIDDEN_PERSONA_IDS = new Set(["clawbot"]);
const GENERAL_ROOM: OfficeRoom = { id: "general", name: "General", color: "slate", members: [] };

type PersonaRow = { id: string; name: string; department?: string };
type DeptRow = { id: string; name: string; color?: string };

type ChatMsg = { role: "user" | "assistant"; content: string };

export function Office() {
  const navigate = useNavigate();
  const [personas, setPersonas] = useState<PersonaRow[] | null>(null);
  const [departments, setDepartments] = useState<DeptRow[] | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [stuckIds, setStuckIds] = useState<Set<string>>(new Set());
  const [panelPersonaId, setPanelPersonaId] = useState<string | null>(null);
  const [taskText, setTaskText] = useState("");
  const [sendingTask, setSendingTask] = useState(false);
  const [highlightPersonaId, setHighlightPersonaId] = useState<string | null>(null);

  // H — selecting someone from the directory opens the same chat panel a
  // desk click would, plus a brief highlight pulse on their desk so it's
  // obvious which one just got picked.
  function selectFromDirectory(personaId: string) {
    setPanelPersonaId(personaId);
    setHighlightPersonaId(personaId);
    setTimeout(() => setHighlightPersonaId(cur => (cur === personaId ? null : cur)), 1000);
  }

  useEffect(() => {
    api.listPersonas().then(r => setPersonas(r.personas)).catch(e => showToast(e?.message ?? String(e), "error"));
    api.listDepartments().then(r => setDepartments(r.departments)).catch(e => showToast(e?.message ?? String(e), "error"));
  }, []);

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
        }
        setBusyIds(live);
        setStuckIds(stuck);
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
    // Keep every department as a room even if empty (proves "more departments"
    // works both ways — a freshly-applied or custom department with no hires
    // yet still shows up on the floor), but drop "general" if nothing landed
    // there so a fully-departmentalized roster doesn't show a stray empty room.
    const rooms = [...byId.values()].filter(r => r.id !== GENERAL_ROOM.id || r.members.length > 0);
    return { rooms, frontDeskMember };
  }, [personas, departments]);

  const panelPersona = panelPersonaId ? personas?.find(p => p.id === panelPersonaId) ?? null : null;

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
          highlightPersonaId={highlightPersonaId}
          onSelectPersona={id => setPanelPersonaId(id)}
          onSelectMeetingTable={() => navigate("/chat")}
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
        <PersonaChatPanel persona={panelPersona} onClose={() => setPanelPersonaId(null)} />
      )}
    </div>
  );
}

function PersonaChatPanel({ persona, onClose }: { persona: PersonaRow; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

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

  return (
    <div className="fixed inset-0 z-50 grid place-items-end sm:place-items-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-ink-900 border border-ink-700 rounded-2xl p-4 space-y-3 max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg text-cream-50 font-medium">{persona.name}</h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={18} /></button>
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
