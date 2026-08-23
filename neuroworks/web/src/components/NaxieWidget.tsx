import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Mic, Square, Loader2, Send, Sparkles, X, Maximize2 } from "lucide-react";
import { api } from "../lib/api";
import { useSpeechRecognition } from "../lib/useSpeechRecognition";
import { Button, showToast } from "./Card";

type Turn = { role: "user" | "assistant"; text: string; routing?: { tier: string; complexity: string } };
const STORAGE_KEY = "neuroworks.naxie.turns";
const WIDGET_OPEN_KEY = "neuroworks.naxieWidget.open";

function loadTurns(): Turn[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function loadOpen(): boolean {
  try { return sessionStorage.getItem(WIDGET_OPEN_KEY) === "1"; } catch { return false; }
}
function saveOpen(open: boolean) {
  try { sessionStorage.setItem(WIDGET_OPEN_KEY, open ? "1" : "0"); } catch { /* ignore */ }
}

// Delegate a raw ask to Naxie's org backlog — she classifies + files it.
async function delegateToNaxie(text: string, priority = "normal") {
  const r = await fetch("/api/naxie/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, priority }) });
  if (!r.ok) throw new Error(`delegate ${r.status}`);
  return r.json() as Promise<{ role: string; task: { id: string; title: string } }>;
}

// Tiny helper to persist — same key as Naxie.tsx so both views share history.
function saveTurns(turns: Turn[]) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-40))); } catch { /* ignore */ }
}

export function NaxieWidget() {
  const location = useLocation();
  const [open, setOpen] = useState<boolean>(loadOpen);
  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [pendingNudge, setPendingNudge] = useState(false);
  const mic = useSpeechRecognition();
  const micRef = useRef("");
  const logRef = useRef<HTMLDivElement | null>(null);

  // Don't show floating orb on /naxie itself and during onboarding
  const hidden = location.pathname.startsWith("/naxie") || location.pathname === "/onboarding";

  // Keep in sync with Naxie page (storage events + open-time reload)
  useEffect(() => {
    if (open) setTurns(loadTurns());
  }, [open]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setTurns(loadTurns());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, open]);

  // Persist widget open state so it survives route changes within the session.
  useEffect(() => { saveOpen(open); }, [open]);

  // Nudge: local + server. Polls /api/naxie/status (10s) for waiting approvals
  // so daemon/org-tasks surface as badge even when you haven't chatted.
  useEffect(() => {
    if (open) { setPendingNudge(false); return; }
    if (turns.length > 0 && turns[turns.length - 1]?.role === "assistant") setPendingNudge(true);
  }, [turns, open]);
  useEffect(() => {
    if (open) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/naxie/status");
        if (!r.ok) return;
        const j = await r.json();
        if (alive && j.pendingApprovals > 0) setPendingNudge(true);
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => { alive = false; clearInterval(id); };
  }, [open]);

  function stopSpeaking() {
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    setSpeaking(false);
  }

  async function speak(text: string) {
    stopSpeaking();
    setSpeaking(true);
    try {
      const blob = await api.voiceTts(text, "naxie");
      const audio = new Audio(URL.createObjectURL(blob));
      audio.onended = () => setSpeaking(false);
      await audio.play();
      return;
    } catch { /* fall through */ }
    try {
      const u = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith("en"));
      const preferred = voices.find(v => /daniel|david|male|uk english male/i.test(v.name));
      u.voice = preferred ?? voices[0];
      u.rate = 1.02; u.pitch = 0.9; u.onend = () => setSpeaking(false);
      window.speechSynthesis.speak(u);
    } catch { setSpeaking(false); }
  }

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setInput("");
    const next: Turn[] = [...turns, { role: "user", text: q }];
    setTurns(next);
    saveTurns(next);
    try {
      const r = await api.voiceConverse(next.map(t => ({ role: t.role, content: t.text })));
      const updated: Turn[] = [...next, { role: "assistant", text: r.text, routing: r.routing }];
      setTurns(updated);
      saveTurns(updated);
      void speak(r.text);
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function micToggle() {
    if (mic.active) { mic.stop(); return; }
    stopSpeaking();
    micRef.current = "";
    try {
      await mic.start((transcript, isFinal) => {
        if (isFinal) micRef.current = (micRef.current ? micRef.current.replace(/\s+$/, "") + " " : "") + transcript;
      });
    } catch { /* mic.error handled */ }
  }

  const micWasActiveRef = useRef(false);
  useEffect(() => {
    if (micWasActiveRef.current && !mic.active) {
      const t = micRef.current.trim();
      micRef.current = "";
      if (t) void ask(t);
    }
    micWasActiveRef.current = mic.active;
  }, [mic.active]);

  if (hidden) return null;

  const orbState: "listening" | "thinking" | "speaking" | "idle" =
    mic.active ? "listening" : busy ? "thinking" : speaking ? "speaking" : "idle";

  return (
    <>
      {/* Floating orb button */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title={open ? "Close Naxie" : "Ask Naxie — PA master (every page)"}
        className={`fixed bottom-5 right-5 z-40 w-12 h-12 rounded-full border-2 bg-ink-900 flex items-center justify-center shadow-xl transition-all ${
          orbState === "listening" ? "border-orange-400/80 shadow-orange-500/30" :
          orbState === "thinking" ? "border-emerald-400/80 shadow-emerald-500/30" :
          orbState === "speaking" ? "border-fuchsia-400/80 shadow-fuchsia-500/30" :
          "border-violet-500/50"
        } ${pendingNudge && !open ? "animate-pulse" : ""}`}
        style={{ boxShadow: orbState === "idle" ? "0 0 20px rgba(125,87,246,0.4)" : undefined }}
      >
        {orbState === "listening" || orbState === "thinking" || orbState === "speaking" ? (
          <img src={orbState === "listening" ? "/naxie/naxie-mascot.gif" : "/naxie/naxie-waveform.gif"} alt="" className="w-full h-full object-contain rounded-full" />
        ) : (
          <Sparkles size={18} className="text-violet-400" />
        )}
        {pendingNudge && !open && <span className="absolute -top-1 -right-1 w-3 h-3 bg-violet-500 rounded-full border border-ink-900" />}
      </button>

      {/* Inline popup — compact chat panel, not a navigation */}
      {open && (
        <div className="fixed bottom-20 right-5 z-40 w-80 max-h-[70vh] bg-ink-950 border border-ink-800 rounded-xl shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-ink-800 bg-ink-900/50">
            <div className="flex items-center gap-2">
              <Sparkles size={14} className="text-violet-400" />
              <span className="text-xs font-semibold text-cream-50">Naxie</span>
              <span className="text-[10px] text-cream-300/50">PA master</span>
            </div>
            <div className="flex items-center gap-1">
              <Link to="/naxie" onClick={() => setOpen(false)} className="p-1 text-cream-300/60 hover:text-cream-100" title="Open full Naxie"><Maximize2 size={13} /></Link>
              <button onClick={() => setOpen(false)} className="p-1 text-cream-300/60 hover:text-cream-100"><X size={13} /></button>
            </div>
          </div>

          <div ref={logRef} className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2 min-h-[160px]">
            {turns.length === 0 ? (
              <div className="text-[11px] text-cream-300/60 text-center py-6">Ask Naxie anything — she routes complex work to the right worker. <Link to="/chat" className="text-violet-400 hover:text-violet-300">Chat</Link> is for direct worker talk.</div>
            ) : turns.slice(-12).map((t, i) => (
              <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                {t.role === "user" ? (
                  <div className="text-[11px] bg-ink-900 border border-ink-800 rounded-lg px-2.5 py-1.5 max-w-[85%] text-cream-300/80">{t.text}</div>
                ) : (
                  <div className="flex flex-col gap-1 max-w-[85%]">
                    <div className="text-[11px] bg-violet-500/10 border border-violet-500/20 rounded-lg px-2.5 py-1.5 text-cream-100">{t.text}</div>
                    {t.routing && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full border w-fit opacity-70"
                        style={{ borderColor: t.routing.tier.includes("free") ? "rgba(34,197,94,0.35)" : "rgba(251,146,60,0.35)", color: t.routing.tier.includes("free") ? "#4ade80" : "#fb923c" }}>
                        {t.routing.tier === "free-small" ? "⚡ quick" : t.routing.tier === "free-large" ? "🧠 deep" : t.routing.tier === "ollama-small" ? "💻 local" : "💻 local deep"} · {t.routing.complexity}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="text-[10px] text-violet-400 flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> Thinking…</div>}
          </div>

          <div className="flex items-center gap-1.5 p-2 border-t border-ink-800">
            <button onClick={micToggle} disabled={busy && !mic.active} className={`p-2 rounded-md border ${mic.active ? "bg-coral-500/15 border-coral-500/40 text-coral-300" : "bg-ink-900 border-ink-800 text-cream-300"}`}>
              {mic.active ? <Square size={12} /> : <Mic size={12} />}
            </button>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { if (input.startsWith("/task ")) { void delegateToNaxie(input.slice(6).trim()).then(r => showToast(`Filed to ${r.role}: ${r.task.title.slice(0,50)}`, "success")).catch(e => showToast(String(e?.message ?? e), "error")); setInput(""); } else void ask(input); } }}
              placeholder='Ask Naxie…  (/task to file work)'
              disabled={busy}
              className="flex-1 bg-ink-900 border border-ink-800 rounded-md px-2 py-1.5 text-xs text-cream-100 focus:outline-none focus:border-violet-500/50 disabled:opacity-50"
            />
            <Button onClick={() => input.startsWith("/task ") ? void delegateToNaxie(input.slice(6).trim()).then(r => showToast(`Filed to ${r.role}: ${r.task.title.slice(0,50)}`, "success")).catch((e: any) => showToast(String(e?.message ?? e), "error")) : ask(input)} disabled={busy || !input.trim()}><Send size={12} /></Button>
          </div>
        </div>
      )}
    </>
  );
}
