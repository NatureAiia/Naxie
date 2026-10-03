import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Mic, MicOff, Loader2, Send, Sparkles, X, Maximize2, ChevronDown } from "lucide-react";
import { Button } from "./Card";
import { NaxieOrb } from "./NaxieOrb";
import { NaxieResultCard } from "./NaxieResultCard";
import { ToggleRow } from "./ToggleRow";
import { CapabilityToggles } from "./CapabilityToggles";
import { MicLevelMeter } from "./MicLevelMeter";
import { useNaxieAssistant, type Turn } from "../lib/useNaxieAssistant";
import { useMicLevel } from "../lib/useMicLevel";
import { t } from "../lib/i18n";

const WIDGET_OPEN_KEY = "naxie.widget.open";

function loadOpen(): boolean {
  try { return sessionStorage.getItem(WIDGET_OPEN_KEY) === "1"; } catch { return false; }
}
function saveOpen(open: boolean) {
  try { sessionStorage.setItem(WIDGET_OPEN_KEY, open ? "1" : "0"); } catch { /* ignore */ }
}

export function NaxieWidget() {
  const location = useLocation();
  const [open, setOpen] = useState<boolean>(loadOpen);
  const [input, setInput] = useState("");
  const [pendingNudge, setPendingNudge] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Don't show floating orb on /naxie itself — also tells the shared hook
  // not to auto-listen here, so the widget and the full /naxie page (which
  // has its own hook instance) never fight over the microphone at the same
  // time.
  const hidden = location.pathname.startsWith("/naxie");
  const {
    turns, chatTurns, lastExchange, busy, speaking, mic, orbState, alwaysListening, setAlwaysListening,
    pendingApprovals, waitingTasks, resolveWaitingTask, briefing, dismissBriefing,
    onboardingNudge, dismissOnboardingNudge,
    ask, speak, micToggle, delegate,
  } = useNaxieAssistant({ autoListen: !hidden });

  // Persist widget open state so it survives route changes within the session.
  useEffect(() => { saveOpen(open); }, [open]);

  // Nudge badge — an unread reply, a pending approval, or an undismissed
  // briefing all count as "something to look at" while the popup is closed.
  useEffect(() => {
    if (open) { setPendingNudge(false); return; }
    const hasUnreadReply = turns.length > 0 && turns[turns.length - 1]?.role === "assistant";
    setPendingNudge(hasUnreadReply || pendingApprovals > 0 || briefing != null || onboardingNudge);
  }, [turns, open, pendingApprovals, briefing, onboardingNudge]);

  if (hidden) return null;

  function submit() {
    if (input.startsWith("/task ")) {
      void delegate(input.slice(6).trim());
      setInput("");
    } else {
      void ask(input);
      setInput("");
    }
  }

  const waitingCards: Turn[] = waitingTasks.map(t => ({
    role: "assistant",
    text: t.pendingApproval?.actionDescription ?? `Waiting on your approval: ${t.title}`,
    kind: "approval",
    meta: { taskId: t.id, diff: t.pendingApproval?.diff, actionKind: t.pendingApproval?.kind },
  }));
  const resultTurns = [...waitingCards, ...turns.filter(t => t.kind === "delegation")].slice(-2);
  const recentChat = chatTurns.slice(-8);
  const micLevel = useMicLevel(mic.active);

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
        {orbState === "idle" ? <Sparkles size={18} className="text-violet-400" /> : <NaxieOrb state={orbState} size="sm" />}
        {pendingNudge && !open && <span className="absolute -top-1 -right-1 w-3 h-3 bg-violet-500 rounded-full border border-ink-900" />}
      </button>

      {/* Inline popup — compact HUD panel, not a navigation */}
      {open && (
        <div className="fixed bottom-20 right-5 left-5 tablet:left-auto z-40 w-auto tablet:w-80 max-h-[70vh] bg-ink-950 border border-ink-800 rounded-xl shadow-2xl flex flex-col overflow-hidden">
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

          <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2 min-h-[160px]">
            <div className="flex flex-col items-center gap-2 py-2">
              <div className="w-16 h-16"><NaxieOrb state={orbState} size="sm" /></div>
              <div className="text-[11px] text-cream-300/60 text-center max-w-[220px]">
                {lastExchange && orbState === "idle" ? lastExchange.answer : "Ask Naxie anything — she routes complex work to the right worker."}
              </div>
            </div>

            {onboardingNudge && (
              <NaxieResultCard turn={{ role: "assistant", text: t("onboarding.nudge.text"), kind: "onboarding" }} onDismiss={dismissOnboardingNudge} compact />
            )}

            {briefing && (
              <NaxieResultCard turn={{ role: "assistant", text: briefing.text, kind: "briefing" }} onReplay={speak} onDismiss={dismissBriefing} compact />
            )}

            {resultTurns.length > 0 && (
              <div className="space-y-1.5">
                {resultTurns.map((t, i) => <NaxieResultCard key={i} turn={t} onApprove={id => resolveWaitingTask(id, true)} onReject={id => resolveWaitingTask(id, false)} compact />)}
              </div>
            )}

            {busy && <div className="text-[10px] text-violet-400 flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> Thinking…</div>}

            {recentChat.length > 0 && (
              <details open={historyOpen} onToggle={e => setHistoryOpen((e.target as HTMLDetailsElement).open)}>
                <summary className="flex items-center gap-1.5 text-[10px] text-cream-300/50 hover:text-cream-300/80 cursor-pointer select-none list-none">
                  <ChevronDown size={11} className={`transition-transform ${historyOpen ? "" : "-rotate-90"}`} />
                  Recent exchanges
                </summary>
                <div className="mt-1.5 space-y-1.5">
                  {recentChat.map((t, i) => (
                    <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                      <NaxieResultCard turn={t} compact />
                    </div>
                  ))}
                </div>
              </details>
            )}

            {turns.length === 0 && (
              <div className="text-[11px] text-cream-300/60 text-center py-4"><Link to="/chat" className="text-violet-400 hover:text-violet-300">Chat</Link> is for direct worker talk.</div>
            )}

            <div className="pt-1.5 mt-1 border-t border-ink-800/60 flex flex-col gap-1.5">
              <ToggleRow label="Always listening" checked={alwaysListening} onChange={setAlwaysListening} compact />
              <CapabilityToggles compact />
              <Link to="/onboarding" className="text-[11px] text-cream-300/60 hover:text-cream-100">Edit your profile</Link>
            </div>
          </div>

          <div className="flex items-center gap-1.5 p-2 border-t border-ink-800">
            <button onClick={micToggle} disabled={busy && !mic.active} title={mic.active ? "Mute" : "Unmute"} className={`p-2 rounded-md border ${mic.active ? "bg-coral-500/15 border-coral-500/40 text-coral-300" : "bg-ink-900 border-ink-800 text-cream-300"}`}>
              {mic.active ? <Mic size={12} /> : <MicOff size={12} />}
            </button>
            {mic.active && <MicLevelMeter level={micLevel} size="sm" />}
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") submit(); }}
              placeholder='Ask Naxie…  (/task to file work)'
              disabled={busy}
              className="flex-1 bg-ink-900 border border-ink-800 rounded-md px-2 py-1.5 text-xs text-cream-100 focus:outline-none focus:border-violet-500/50 disabled:opacity-50"
            />
            <Button onClick={submit} disabled={busy || !input.trim()}><Send size={12} /></Button>
          </div>
        </div>
      )}
    </>
  );
}
