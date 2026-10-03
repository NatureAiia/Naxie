import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, WaitingTask, User } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { useLoadMore, LoadMoreButton } from "../components/LoadMore";
import {
  Inbox, Send, Loader2, Bot,
  ChevronDown, ChevronUp,
  ListChecks, History, Radar,
} from "lucide-react";
import { Runs } from "./Runs";
import { AgentApprovals } from "./AgentApprovals";
import { AmbientWatch } from "./AmbientWatch";

// Unified Work page — My Inbox (Naxie approvals + agent handoffs) +
// Runs (timeline/board) + Ambient (background watcher, stub) + History
// (prompts). One canonical list route (/my-work); /runs redirects here and
// /runs/:jobId stays standalone for deep links. Single-operator model: you
// are the only human, so every approval from Naxie lands in your inbox.
export function MyWork() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  const tab: "inbox" | "runs" | "ambient" | "history" =
    raw === "runs" ? "runs" : raw === "ambient" ? "ambient" : raw === "history" ? "history" : "inbox";
  // Legacy aliases (approvals tab merged into inbox; work/reports predate tabs)
  const legacy = raw === "approvals" ? "inbox" : raw === "work" ? "inbox" : raw === "reports" ? "runs" : null;
  useEffect(() => {
    if (legacy) {
      const n = new URLSearchParams(searchParams);
      n.set("tab", legacy);
      setSearchParams(n, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  function setTab(next: typeof tab) {
    setSearchParams(prev => {
      const n = new URLSearchParams(prev);
      if (next === "inbox") n.delete("tab");
      else n.set("tab", next);
      return n;
    }, { replace: true });
  }
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1 border-b border-ink-800">
        {([["inbox", "Inbox", Inbox], ["runs", "Runs", ListChecks], ["ambient", "Ambient", Radar], ["history", "History", History]] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id as typeof tab)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors inline-flex items-center gap-1.5 ${
              tab === id ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-100"
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {tab === "inbox" ? <MyWorkInner /> : tab === "runs" ? <Runs /> : tab === "ambient" ? <AmbientWatch /> : <MyWorkHistory />}
    </div>
  );
}

function MyWorkHistory() {
  const [history, setHistory] = useState<PromptExchange[]>([]);
  const [loaded, setLoaded] = useState(false);
  return <MyWorkHistoryInner history={history} setHistory={setHistory} loaded={loaded} setLoaded={setLoaded} />;
}

// My Inbox — the single-operator workbench. Where you:
//   1. Greenlight APPROVALS from Naxie (agents that want to write to
//      GitHub or your vault ask here first).
//   2. Answer HANDOFFS from agents (agent jobs parked in waiting_on_human —
//      answering resumes the agent loop with your input).
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
  const [err, setErr] = useState("");

  async function load() {
    try {
      const [sess, w] = await Promise.all([
        api.session().catch(() => ({ user: null })),
        api.tasksWaiting().catch(() => ({ waiting: [] as WaitingTask[] })),
      ]);
      setMe(sess.user);
      setWaiting(w.waiting);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); const i = setInterval(load, 8000); return () => clearInterval(i); }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-3xl text-cream-50">My Inbox</h1>
          <p className="text-sm text-cream-300/70 mt-1">
            Approvals from Naxie and handoffs from agents — greenlight, answer, done.
          </p>
        </div>
        {me && <div className="text-xs text-cream-300/50">signed in as <span className="text-cream-100">{me.name}</span></div>}
      </div>
      {err && <div className="text-coral-400 text-sm">Error: {err}</div>}

      <AgentApprovals embedded />

      <HandoffsSection waiting={waiting} onDone={load} />

    </div>
  );
}

// History tab — no sign-in required for local single-operator use.
function MyWorkHistoryInner({ history, setHistory, loaded, setLoaded }: {
  history: PromptExchange[]; setHistory: React.Dispatch<React.SetStateAction<PromptExchange[]>>;
  loaded: boolean; setLoaded: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const promptList = useLoadMore(history);
  useEffect(() => {
    let alive = true;
    const pull = () => api.chatHistory(50)
      .then(r => { if (alive) { setHistory(r.history); setLoaded(true); } })
      .catch(() => { if (alive) setLoaded(true); });
    pull();
    const i = setInterval(pull, 15000);
    return () => { alive = false; clearInterval(i); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section>
      <Card title={`Prompts & results · ${history.length}`}>
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
        <div className="text-xs uppercase tracking-[0.25em] text-cream-300/60">Naxie handoffs — waiting on you · {waiting.length}</div>
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
      showToast("Sent — the agent is continuing the task", "success");
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
            placeholder="Anything else the agent should know (optional)…"
          />
          <Button onClick={send} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send &amp; resume the agent
          </Button>
        </div>
      )}
    </div>
  );
}

// Assignment / delegation panels removed — single-operator system:
// you're the only human, so there are no colleagues to assign to.
// What's left: Naxie approvals + agent handoffs.
