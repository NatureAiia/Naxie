import { useState } from "react";
import { Link } from "react-router-dom";
import { Mic, MicOff, Loader2, Send, VolumeX, Sparkles, ChevronDown } from "lucide-react";
import { Button } from "../components/Card";
import { KnowledgeGraph } from "../components/KnowledgeGraph";
import { NaxieOrb } from "../components/NaxieOrb";
import { NaxieResultCard } from "../components/NaxieResultCard";
import { ToggleRow } from "../components/ToggleRow";
import { CapabilityToggles } from "../components/CapabilityToggles";
import { MicLevelMeter } from "../components/MicLevelMeter";
import { useNaxieAssistant, type Turn } from "../lib/useNaxieAssistant";
import { useMicLevel } from "../lib/useMicLevel";

// A general-purpose, always-listening-by-push-to-talk voice assistant, styled
// as a HUD orb (Iron Man / JARVIS inspiration — see assets/jarvis-reference
// at the repo root and the linked README section). Talks over
// /api/voice/converse — a direct model passthrough, NOT the task/template
// pipeline the text Chat page uses, so every reply is genuinely generated
// (no calculator shortcut, no template matching, no canned strings).
//
// Mission-control layout, not a chat log: the orb shows current state, the
// last exchange fades in as a one-line caption underneath it, and anything
// structured (delegated tasks, briefings) shows as a result card. Full
// recent history is one click away via "Recent exchanges" rather than a
// permanent scrolling transcript — see useNaxieAssistant for the shared
// state machine (also used by NaxieWidget.tsx on every other page).
//
// Layout: the app's own left nav (Layout.tsx) is the first section; this
// page then splits into the vault's knowledge graph — the "brain" — filling
// the center, with the Naxie panel on the right, Obsidian-style.

export function Naxie() {
  const {
    turns, chatTurns, lastExchange, sourceNoteId, busy, speaking, liveCaption, mic, orbState, alwaysListening, setAlwaysListening,
    waitingTasks, briefing, dismissBriefing,
    ask, speak, stopSpeaking, micToggle,
  } = useNaxieAssistant();
  const [input, setInput] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);

  const orbLabel = {
    idle: "Standing by",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Peaking…",
  }[orbState];
  const orbDescription = {
    idle: alwaysListening ? "Always listening — just start talking, or type below." : "Tap the mic and say something, or type a message below.",
    listening: alwaysListening ? "Listening — tap the mic to mute." : "Listening — speak now, tap the mic again to send.",
    thinking: "Thinking — your question is with the assistant.",
    speaking: "Peaking the response with a live voice output.",
  }[orbState];

  const waitingCards: Turn[] = waitingTasks.map(t => ({ role: "assistant", text: `Waiting on your approval: ${t.title}`, kind: "delegation" }));
  const resultTurns = [...waitingCards, ...turns.filter(t => t.kind === "delegation")].slice(-3);
  const recentChat = chatTurns.slice(-10);
  const micLevel = useMicLevel(mic.active);

  return (
    <div className="flex h-full gap-6">
      <div className="flex-1 min-w-0 h-full py-2">
        <KnowledgeGraph focusId={sourceNoteId} />
      </div>

      <div className="flex flex-col h-full w-[380px] shrink-0">
        <div className="flex items-center justify-between gap-2 pt-2 pb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-violet-400" />
            <div>
              <div className="text-lg font-semibold text-cream-50">Naxie</div>
              <div className="text-xs text-cream-300/60">Personal assistant — talk or type</div>
            </div>
          </div>
          <Link to="/naxie/memory" className="text-[11px] px-2 py-1 rounded-md bg-ink-800 hover:bg-ink-700 border border-ink-700 text-cream-300">Memory</Link>
        </div>

        <div className="flex flex-col items-center justify-center gap-4 py-4">
          <NaxieOrb state={orbState} size="lg" />

          <div className="text-center">
            <div className="text-[10px] uppercase tracking-[0.25em] text-cream-300/70">{orbLabel}</div>
            <div className="text-sm text-cream-200 mt-1 max-w-xs mx-auto">
              {orbState === "idle" && lastExchange ? lastExchange.answer : orbDescription}
            </div>
          </div>

          {orbState === "listening" && (
            <div className="min-h-[2.5rem] max-w-xs w-full text-center text-sm text-cream-100/90 bg-ink-950/70 border border-coral-500/20 rounded-lg px-3 py-2 flex flex-col items-center gap-1.5">
              <MicLevelMeter level={micLevel} />
              <span>{liveCaption || <span className="text-cream-300/40">Say something…</span>}</span>
            </div>
          )}

          <div className="relative">
            {mic.active && (
              <span
                className="absolute inset-0 rounded-full bg-coral-400 pointer-events-none"
                style={{ opacity: 0.12 + micLevel * 0.28, transform: `scale(${1.15 + micLevel * 0.35})`, transition: "transform 75ms, opacity 75ms" }}
              />
            )}
            <button
              type="button"
              onClick={micToggle}
              disabled={(busy && !mic.active) || !mic.supported}
              title={mic.active ? (alwaysListening ? "Mute" : "Stop and send") : (alwaysListening ? "Unmute" : "Talk to Naxie")}
              className={`relative p-4 rounded-full border transition-colors ${
                mic.active
                  ? "bg-coral-500/15 border-coral-500/60 text-coral-400"
                  : "bg-ink-800 border-ink-700 text-cream-100 hover:border-violet-500/50"
              }`}
            >
              {mic.active ? <Mic size={20} /> : busy ? <Loader2 size={20} className="animate-spin" /> : <MicOff size={20} />}
            </button>
          </div>
          {!mic.supported && <div className="text-[11px] text-cream-300/40">Mic capture isn't supported in this browser — type below instead.</div>}
          <div className="w-full max-w-[220px] flex flex-col gap-2 pt-1 border-t border-ink-800/60">
            <ToggleRow label="Always listening" checked={alwaysListening} onChange={setAlwaysListening} />
            <CapabilityToggles />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin space-y-2.5 px-1 pb-3">
          {briefing && (
            <NaxieResultCard turn={{ role: "assistant", text: briefing.text, kind: "briefing" }} onReplay={speak} onDismiss={dismissBriefing} />
          )}

          {resultTurns.length > 0 && (
            <div className="space-y-2 nw-fade-up">
              {resultTurns.map((t, i) => <NaxieResultCard key={i} turn={t} onReplay={speak} />)}
            </div>
          )}

          {recentChat.length > 0 && (
            <details open={historyOpen} onToggle={e => setHistoryOpen((e.target as HTMLDetailsElement).open)} className="pt-1">
              <summary className="flex items-center gap-1.5 text-[11px] text-cream-300/50 hover:text-cream-300/80 cursor-pointer select-none list-none">
                <ChevronDown size={12} className={`transition-transform ${historyOpen ? "" : "-rotate-90"}`} />
                Recent exchanges
              </summary>
              <div className="mt-2 space-y-2.5">
                {recentChat.map((t, i) => (
                  <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                    <NaxieResultCard turn={t} onReplay={speak} />
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        <div className="flex items-center gap-2 py-3 border-t border-ink-800">
          {speaking && (
            <Button variant="subtle" onClick={stopSpeaking}><VolumeX size={13} /> Stop</Button>
          )}
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { void ask(input); setInput(""); } }}
            placeholder="Ask Naxie anything…"
            disabled={busy}
            className="flex-1 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2.5 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60 disabled:opacity-50"
          />
          <Button onClick={() => { void ask(input); setInput(""); }} disabled={busy || !input.trim()}>
            <span title="Ask Naxie">{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
