import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, Assignment, AssignmentStatus, AssignPerson, WaitingTask, User } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { useLoadMore, LoadMoreButton } from "../components/LoadMore";
import { FileUpload } from "../components/FileUpload";
import {
  Inbox, Send, Loader2, CheckCircle2, XCircle, Play, Paperclip, Bot,
  User as UserIcon, Clock, ChevronDown, ChevronUp, AlertTriangle, RotateCcw, Download,
  FileText, FileEdit,
} from "lucide-react";
import { getToken } from "../lib/api";
import { Runs } from "./Runs";
import { DocEditor } from "./DocEditor";

// Combined personal workspace: My Work (handoffs + assignments), Reports (the
// deliverables the workforce produced — the merged Runs list), and the Doc
// editor — three tabs on one page instead of three nav entries. The
// individual routes (/runs, /edit) still work for deep links.
export function MyWork() {
  const [tab, setTab] = useState<"work" | "reports" | "editor">("work");
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1 border-b border-ink-800">
        {([["work", "My Work", Inbox], ["reports", "Reports", FileText], ["editor", "Doc editor", FileEdit]] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors inline-flex items-center gap-1.5 ${
              tab === id ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-100"
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {tab === "work" ? <MyWorkInner /> : tab === "reports" ? <Runs /> : <DocEditor />}
    </div>
  );
}

// Download an assignment file (brief attachment or a submission) through the
// access-checked endpoint, carrying the session token, then save via a blob
// URL so the browser shows a real Save dialog with the right filename.
async function downloadFile(assignmentId: string, kind: "brief" | "submission", name: string) {
  try {
    const token = getToken();
    const r = await fetch(`/api/assignments/${encodeURIComponent(assignmentId)}/files/${kind}/${encodeURIComponent(name)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!r.ok) { showToast(`Download failed (${r.status})`, "error"); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
}

// My Work — the human-in-the-loop workbench. Where a person:
//   1. Answers HANDOFFS from neuros (agent jobs parked in waiting_on_human —
//      answering resumes the agent loop with their input).
//   2. Works their ASSIGNMENTS (handed over by a neuro or their boss):
//      start, upload the finished work (text + files), or decline.
//   3. Sees work they DELEGATED to others and signs it off when submitted.
//   4. Hands new work to a colleague — the server blocks assigning UP the
//      caller's own reporting chain (staff never delegate to their boss),
//      and the picker greys those people out.

const STATUS_STYLE: Record<AssignmentStatus, string> = {
  open: "border-ink-700 text-cream-300/70",
  in_progress: "border-flame-400/40 text-flame-400",
  submitted: "border-violet-500/40 text-violet-300",
  done: "border-leaf-500/40 text-leaf-400",
  declined: "border-coral-500/40 text-coral-400",
};
const STATUS_LABEL: Record<AssignmentStatus, string> = {
  open: "open", in_progress: "in progress", submitted: "submitted", done: "done", declined: "declined",
};

// Browser File objects → { name, contentBase64 } payloads (25 MB cap each,
// max 10). Shared by the submit-work box and the hand-work-over form.
async function encodeFiles(list: FileList | File[] | null): Promise<{ name: string; contentBase64: string }[]> {
  if (!list) return [];
  const out: { name: string; contentBase64: string }[] = [];
  for (const f of Array.from(list).slice(0, 10)) {
    if (f.size > 25 * 1024 * 1024) { showToast(`${f.name} is over the 25 MB cap`, "error"); continue; }
    const buf = await f.arrayBuffer();
    let bin = "";
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    out.push({ name: f.name, contentBase64: btoa(bin) });
  }
  return out;
}

function ago(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function MyWorkInner() {
  const [me, setMe] = useState<User | null>(null);
  const [waiting, setWaiting] = useState<WaitingTask[]>([]);
  const [mine, setMine] = useState<Assignment[]>([]);
  const [delegated, setDelegated] = useState<Assignment[]>([]);
  const [people, setPeople] = useState<AssignPerson[]>([]);
  const [err, setErr] = useState("");

  async function load() {
    try {
      const [sess, w, a, dir] = await Promise.all([
        api.session().catch(() => ({ user: null })),
        api.tasksWaiting().catch(() => ({ waiting: [] as WaitingTask[] })),
        api.listAssignments().catch(() => ({ mine: [], delegated: [] } as any)),
        api.assignmentsDirectory().catch(() => ({ people: [] as AssignPerson[] })),
      ]);
      setMe(sess.user);
      setWaiting(w.waiting);
      // Token-less local operator: "mine"/"delegated" come back empty but
      // "all" is present — show everything, this machine IS the operator.
      // A SIGNED-IN user (even an admin whose response carries "all") only
      // ever sees their own slice here — the whole-org board is not "my work".
      setMine(sess.user ? (a.mine ?? []) : (a.all ?? a.mine ?? []));
      setDelegated(a.delegated ?? []);
      setPeople(dir.people);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); const i = setInterval(load, 8000); return () => clearInterval(i); }, []);

  const openMine = mine.filter(a => a.status === "open" || a.status === "in_progress");
  const restMine = mine.filter(a => a.status !== "open" && a.status !== "in_progress");

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-3xl text-cream-50">My Work</h1>
          <p className="text-sm text-cream-300/70 mt-1">
            Handoffs from neuros, assignments from your boss, and the work you delegated — answer, upload, sign off.
          </p>
        </div>
        {me && <div className="text-xs text-cream-300/50">signed in as <span className="text-cream-100">{me.name}</span></div>}
      </div>
      {err && <div className="text-coral-400 text-sm">Error: {err}</div>}

      <HandoffsSection waiting={waiting} onDone={load} />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title={`Assigned to me · ${openMine.length} open`}>
          {openMine.length === 0 && <div className="text-sm text-cream-300/60">Nothing on your desk. Assignments from neuros or colleagues land here.</div>}
          <div className="space-y-3">
            {openMine.map(a => <AssignmentRow key={a.id} a={a} me={me} onChanged={load} canSubmit />)}
          </div>
          {restMine.length > 0 && (
            <details className="mt-3">
              <summary className="text-xs text-cream-300/50 cursor-pointer hover:text-cream-100">History · {restMine.length}</summary>
              <div className="space-y-3 mt-3">
                {restMine.map(a => <AssignmentRow key={a.id} a={a} me={me} onChanged={load} canSubmit={a.status === "submitted"} />)}
              </div>
            </details>
          )}
        </Card>

        <div className="space-y-4">
          <Card title={`Delegated by me · ${delegated.filter(d => d.status !== "done" && d.status !== "declined").length} open`}>
            {delegated.length === 0 && <div className="text-sm text-cream-300/60">Work you hand to colleagues shows up here for sign-off.</div>}
            <div className="space-y-3">
              {delegated.map(a => <AssignmentRow key={a.id} a={a} me={me} onChanged={load} canSignOff />)}
            </div>
          </Card>
          <AssignForm people={people} onCreated={load} />
        </div>
      </section>

      <MyPromptsSection signedIn={!!me} />
    </div>
  );
}

// ── My prompts & results: everything this user asked in chat, with the
// output each prompt produced. Server-side per-user store (GET /api/chat/history
// resolves the caller from their token — no one else's turns can appear here).
// Prompts that became background jobs show the finished job's deliverable and
// deep-link into /runs/<jobId>.
type PromptExchange = { id: string; at: string; prompt: string; response: string; kind?: string; jobId?: string; persona?: string; jobStatus?: string };

// Hoisted to module scope (NOT nested in MyPromptsSection) so its identity is
// stable across the 15s poll re-render — a nested definition gets a new
// identity each render and React remounts every row, snapping expanded rows
// shut. Its own `open` state now survives refreshes.
function PromptRow({ h }: { h: PromptExchange }) {
  const [open, setOpen] = useState(false);
  const when = new Date(h.at).toLocaleString();
  const running = h.jobStatus === "running" || h.jobStatus === "queued" || h.jobStatus === "waiting_on_human";
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/40">
      <button type="button" onClick={() => setOpen(!open)} className="w-full text-left px-3 py-2.5 flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-cream-300/40">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-cream-100 truncate">{h.prompt}</span>
          <span className="block text-[11px] text-cream-300/50 mt-0.5">
            {when}
            {h.persona ? <> · answered by <span className="text-cream-200">{h.persona}</span></> : null}
            {h.jobStatus ? <> · <span className={running ? "text-amber-400" : h.jobStatus === "succeeded" ? "text-emerald-400" : "text-coral-400"}>{h.jobStatus}</span></> : null}
          </span>
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-ink-800/60">
          <div className="text-sm text-cream-200/90 whitespace-pre-wrap break-words max-h-96 overflow-y-auto">{h.response || "(no output yet)"}</div>
          {h.jobId && (
            <Link to={`/runs/${h.jobId}`} className="inline-block mt-2 text-xs text-violet-400 hover:text-violet-300">
              Open full result →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function MyPromptsSection({ signedIn }: { signedIn: boolean }) {
  const [history, setHistory] = useState<PromptExchange[]>([]);
  const [loaded, setLoaded] = useState(false);
  const promptList = useLoadMore(history);

  useEffect(() => {
    if (!signedIn) { setLoaded(true); return; }
    let alive = true;
    const pull = () => api.chatHistory(50)
      .then(r => { if (alive) { setHistory(r.history); setLoaded(true); } })
      .catch(() => { if (alive) setLoaded(true); });
    pull();
    const i = setInterval(pull, 15000);
    return () => { alive = false; clearInterval(i); };
  }, [signedIn]);

  if (!signedIn) return null;
  return (
    <section>
      <Card title={`My prompts & results · ${history.length}`}>
        {!loaded && <div className="text-sm text-cream-300/60">Loading…</div>}
        {loaded && history.length === 0 && (
          <div className="text-sm text-cream-300/60">Everything you ask in Chat lands here with its result — nothing yet.</div>
        )}
        <div className="space-y-2">
          {promptList.visible.map(h => <PromptRow key={h.id} h={h} />)}
        </div>
        <LoadMoreButton state={promptList} noun="prompts" />
      </Card>
    </section>
  );
}

// ── Handoffs: agent jobs parked on a structured human ask ──────────────────
function HandoffsSection({ waiting, onDone }: { waiting: WaitingTask[]; onDone: () => void }) {
  if (waiting.length === 0) return null;
  return (
    <section>
      <div className="flex items-center gap-2 mb-3 px-1">
        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        <div className="text-xs uppercase tracking-[0.25em] text-cream-300/60">Neuro handoffs — waiting on you · {waiting.length}</div>
      </div>
      <div className="space-y-3">
        {waiting.map(w => <HandoffCard key={w.id} w={w} onDone={onDone} />)}
      </div>
    </section>
  );
}

function HandoffCard({ w, onDone }: { w: WaitingTask; onDone: () => void }) {
  const [openForm, setOpenForm] = useState(false);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const responses = (w.items ?? [])
      .map((it, i) => ({ prompt: it.prompt, response: (answers[i] ?? "").trim() }))
      .filter(r => r.response);
    if (responses.length === 0 && !note.trim()) { showToast("Answer at least one item or add a note", "error"); return; }
    setBusy(true);
    try {
      await api.submitHumanInput(w.id, responses, note.trim() || undefined);
      showToast("Sent — the neuro is continuing the task", "success");
      setOpenForm(false);
      onDone();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(false); }
  }

  return (
    <div className="bg-ink-900 border border-amber-500/25 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-cream-100">
            <Bot size={14} className="text-amber-400 shrink-0" />
            <span className="truncate">{w.title}</span>
          </div>
          <div className="text-[11px] text-cream-300/50 mt-0.5">
            {w.persona ? `${w.persona} · ` : ""}waiting {ago(w.waitingSince)}
            {w.reason ? ` · ${w.reason}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link to={`/runs?focus=${w.id}`} className="text-xs text-cream-300/60 hover:text-cream-100">task →</Link>
          <Button variant="subtle" onClick={() => setOpenForm(v => !v)}>
            {openForm ? <ChevronUp size={13} /> : <ChevronDown size={13} />} Respond
          </Button>
        </div>
      </div>
      {openForm && (
        <div className="mt-3 pt-3 border-t border-ink-800 space-y-2.5">
          {(w.items ?? []).map((it, i) => (
            <div key={i}>
              <div className="text-xs text-cream-300/70 mb-1">{it.type === "upload" ? "📎 " : ""}{it.prompt}</div>
              <textarea
                value={answers[i] ?? ""}
                onChange={e => setAnswers(prev => ({ ...prev, [i]: e.target.value }))}
                rows={2}
                className="w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60"
                placeholder="Your answer…"
              />
            </div>
          ))}
          <textarea
            value={note} onChange={e => setNote(e.target.value)} rows={2}
            className="w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60"
            placeholder="Anything else the neuro should know (optional)…"
          />
          <Button onClick={send} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send &amp; resume the neuro
          </Button>
        </div>
      )}
    </div>
  );
}

// ── One assignment row: status, provenance, submit-work / sign-off actions ─
function AssignmentRow({ a, me, onChanged, canSubmit, canSignOff }: {
  a: Assignment; me: User | null; onChanged: () => void; canSubmit?: boolean; canSignOff?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ name: string; contentBase64: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const overdue = a.dueAt && a.status !== "done" && new Date(a.dueAt).getTime() < Date.now();

  async function move(status: AssignmentStatus) {
    setBusy(status);
    try { await api.setAssignmentStatus(a.id, status); onChanged(); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(null); }
  }


  async function submit() {
    if (!text.trim() && files.length === 0) { showToast("Add some text or a file first", "error"); return; }
    setBusy("submit");
    try {
      await api.submitAssignment(a.id, { text: text.trim() || undefined, files: files.length ? files : undefined });
      showToast("Work submitted", "success");
      setText(""); setFiles([]); setOpen(false);
      onChanged();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(null); }
  }

  const isAssignee = me ? me.email.toLowerCase() === a.assignedToEmail.toLowerCase() : true;

  return (
    <div className={`rounded-xl border p-3.5 bg-ink-950 ${overdue ? "border-coral-500/40" : "border-ink-800"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-cream-100 leading-tight">{a.title}</div>
          <div className="flex items-center gap-2 text-[11px] text-cream-300/50 mt-1 flex-wrap">
            <span className="inline-flex items-center gap-1">
              {a.assignedByKind === "neuro" ? <Bot size={10} className="text-violet-400" /> : <UserIcon size={10} />}
              from {a.assignedByName}
            </span>
            <span>→ {a.assignedToEmail}</span>
            <span className="inline-flex items-center gap-1"><Clock size={10} />{ago(a.createdAt)}</span>
            {a.dueAt && <span className={overdue ? "text-coral-400" : ""}>{overdue ? "⚠ overdue " : "due "}{new Date(a.dueAt).toLocaleDateString()}</span>}
            {a.fromJobId && <Link to={`/runs?focus=${a.fromJobId}`} className="text-violet-400 hover:text-violet-300">source task →</Link>}
          </div>
        </div>
        <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
      </div>

      {a.details && <div className="text-xs text-cream-300/70 mt-2 whitespace-pre-wrap">{a.details}</div>}

      {(a.attachments ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          <span className="text-[10px] uppercase tracking-wider text-cream-300/40 self-center">brief:</span>
          {(a.attachments ?? []).map((f, i) => (
            <button key={i} type="button" onClick={() => downloadFile(a.id, "brief", f.name)}
              className="inline-flex items-center gap-1 text-[10px] bg-ink-900 border border-violet-500/25 rounded-full px-2 py-0.5 text-cream-300/70 hover:text-cream-50 hover:border-violet-500/50 transition-colors" title={`Download ${f.name}`}>
              <Download size={9} className="text-violet-400" /> {f.name} · {(f.bytes / 1024).toFixed(0)} KB
            </button>
          ))}
        </div>
      )}

      {a.submissions.length > 0 && (
        <div className="mt-2.5 space-y-1.5">
          {a.submissions.map((s, i) => (
            <div key={i} className="text-xs bg-ink-900 border border-ink-800 rounded-lg px-2.5 py-2">
              <div className="text-cream-300/50 text-[10px] mb-0.5">submitted by {s.byEmail} · {ago(s.at)}</div>
              {s.text && <div className="text-cream-200 whitespace-pre-wrap">{s.text}</div>}
              {s.files.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {s.files.map((f, j) => (
                    <button key={j} type="button" onClick={() => downloadFile(a.id, "submission", f.name)}
                      className="inline-flex items-center gap-1 text-[10px] bg-ink-950 border border-ink-700 rounded-full px-2 py-0.5 text-cream-300/70 hover:text-cream-50 hover:border-violet-500/50 transition-colors" title={`Download ${f.name}`}>
                      <Download size={9} /> {f.name} · {(f.bytes / 1024).toFixed(0)} KB
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mt-2.5 flex-wrap">
        {canSubmit && isAssignee && a.status === "open" && (
          <Button variant="subtle" onClick={() => move("in_progress")} disabled={!!busy}><Play size={12} /> Start</Button>
        )}
        {canSubmit && isAssignee && (a.status === "open" || a.status === "in_progress") && (
          <>
            <Button variant="subtle" onClick={() => setOpen(v => !v)}>{open ? <ChevronUp size={12} /> : <Paperclip size={12} />} Upload work</Button>
            <Button variant="subtle" onClick={() => move("declined")} disabled={!!busy}><XCircle size={12} /> Decline</Button>
          </>
        )}
        {canSignOff && a.status === "submitted" && (
          <>
            <Button onClick={() => move("done")} disabled={!!busy}><CheckCircle2 size={12} /> Sign off</Button>
            <Button variant="subtle" onClick={() => move("in_progress")} disabled={!!busy}><RotateCcw size={12} /> Send back</Button>
          </>
        )}
        {canSignOff && a.status === "declined" && (
          <Button variant="subtle" onClick={() => move("open")} disabled={!!busy}><RotateCcw size={12} /> Re-raise</Button>
        )}
      </div>

      {open && (
        <div className="mt-2.5 pt-2.5 border-t border-ink-800 space-y-2">
          <textarea
            value={text} onChange={e => setText(e.target.value)} rows={3}
            className="w-full bg-ink-900 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60"
            placeholder="Describe what you did / paste the deliverable…"
          />
          <FileUpload onChange={async fs => setFiles(await encodeFiles(fs))} />
          <Button onClick={submit} disabled={busy === "submit"}>
            {busy === "submit" ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Submit work
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Hand work to a colleague (hierarchy-gated server-side; greyed here) ────
function AssignForm({ people, onCreated }: { people: AssignPerson[]; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [to, setTo] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [docs, setDocs] = useState<{ name: string; contentBase64: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const choices = useMemo(() => people.filter(p => !p.isSelf), [people]);
  const blocked = useMemo(() => choices.filter(p => !p.eligible), [choices]);

  async function create() {
    if (!title.trim() || !to) { showToast("Title and assignee are required", "error"); return; }
    setBusy(true);
    try {
      await api.createAssignment({ title: title.trim(), details: details.trim() || undefined, assignedToEmail: to, dueAt: dueAt || undefined, files: docs.length ? docs : undefined });
      showToast("Assigned — they'll get an email", "success");
      setTitle(""); setDetails(""); setTo(""); setDueAt(""); setDocs([]);
      onCreated();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(false); }
  }

  return (
    <Card title="Hand work to a colleague">
      <div className="space-y-2.5">
        <input
          value={title} onChange={e => setTitle(e.target.value)}
          className="w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60"
          placeholder="What needs doing…"
        />
        <textarea
          value={details} onChange={e => setDetails(e.target.value)} rows={2}
          className="w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60"
          placeholder="Details, context, links (optional)…"
        />
        <div className="flex gap-2">
          <select
            value={to} onChange={e => setTo(e.target.value)}
            title="Who does this work"
            className="flex-1 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60"
          >
            <option value="">Assign to…</option>
            {choices.map(p => (
              <option key={p.email} value={p.email} disabled={!p.eligible}>
                {p.name}{p.department ? ` — ${p.department}` : ""}{p.eligible ? "" : " (your manager — can't delegate up)"}
              </option>
            ))}
          </select>
          <input
            type="date" value={dueAt} onChange={e => setDueAt(e.target.value)}
            className="bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60"
            title="Due date (optional)"
          />
        </div>
        {/* Upload docs WITH the work — the brief travels with the assignment
            (stored server-side, listed on the assignee's card + named in
            their notification email). */}
        <div className="flex items-center gap-2 flex-wrap">
          <label className="inline-flex items-center gap-1.5 text-xs text-cream-300/70 hover:text-cream-100 cursor-pointer bg-ink-950 border border-ink-800 rounded-lg px-3 py-1.5">
            <Paperclip size={12} /> Upload docs
            <input type="file" multiple className="hidden" onChange={async e => { const next = await encodeFiles(e.target.files); setDocs(prev => [...prev, ...next]); e.target.value = ""; }} />
          </label>
          {docs.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1 text-[10px] bg-ink-950 border border-ink-700 rounded-full px-2 py-0.5 text-cream-300/70">
              {f.name}
              <button type="button" onClick={() => setDocs(prev => prev.filter((_, j) => j !== i))} className="text-coral-400 hover:text-coral-500">×</button>
            </span>
          ))}
        </div>
        {blocked.length > 0 && (
          <div className="text-[11px] text-cream-300/50 flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-400" />
            <span>Org rule: work never flows up your reporting chain — {blocked.map(b => b.name).join(", ")} {blocked.length === 1 ? "is" : "are"} above you.</span>
          </div>
        )}
        <Button onClick={create} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Inbox size={14} />} Assign
        </Button>
      </div>
    </Card>
  );
}
