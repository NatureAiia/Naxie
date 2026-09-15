import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Mic, MicOff, Loader2, VolumeX, Sparkles, ChevronDown, Bot, Activity as ActivityIcon, DollarSign, Phone, PhoneOff, Share2, MessageSquare } from "lucide-react";
import { Button } from "../components/Card";
import { KnowledgeGraph } from "../components/KnowledgeGraph";
import { NaxieOrb } from "../components/NaxieOrb";
import { NaxieResultCard } from "../components/NaxieResultCard";
import { ToggleRow } from "../components/ToggleRow";
import { CapabilityToggles } from "../components/CapabilityToggles";
import { MicLevelMeter } from "../components/MicLevelMeter";
import { ChatClarificationCard, ChatDayPill } from "../components/ChatClarificationCard";
import { KuwanaBottomComposer } from "../components/KuwanaBottomComposer";
import { useNaxieAssistant, type Turn } from "../lib/useNaxieAssistant";
import { useRealtimeCall } from "../lib/useRealtimeCall";
import { useMicLevel } from "../lib/useMicLevel";
import { api } from "../lib/api";
import { t } from "../lib/i18n";

// Ambient status — ports Dashboard's headline stats (agent count, running
// jobs, spend) and Activity's timeline into Naxie now that both of those
// pages are gone; this is deliberately a thin strip + a collapsible list,
// not a rebuild of Dashboard's 12-call "mission control" — Naxie is the
// landing surface now, so it gets a glance, not a report.
function useAmbientStatus() {
  const [personaCount, setPersonaCount] = useState<number | null>(null);
  const [todaySpend, setTodaySpend] = useState<number | null>(null);
  const [recentJobs, setRecentJobs] = useState<any[]>([]);

  useEffect(() => {
    api.listPersonas().then(r => setPersonaCount((r.personas ?? []).length)).catch(() => {});
    api.getCostSummary().then(s => setTodaySpend(typeof s?.todayUsd === "number" ? s.todayUsd : (typeof s?.today === "number" ? s.today : null))).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const { jobs } = await api.listJobs();
        if (!alive) return;
        setRecentJobs([...jobs].sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? ""))).slice(0, 6));
      } catch { /* ambient — tolerate a missed poll */ }
    }
    void tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const runningCount = recentJobs.filter(j => j.status === "running").length;
  return { personaCount, todaySpend, recentJobs, runningCount };
}

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
    requireWakeWord, setRequireWakeWord, voice,
    waitingTasks, resolveWaitingTask, briefing, dismissBriefing,
    onboardingNudge, dismissOnboardingNudge,
    ask, speak, stopSpeaking, micToggle,
  } = useNaxieAssistant();
  const [input, setInput] = useState("");
  // §8.2 layout — chat is the visual center by default; the knowledge graph
  // ("the brain") moves into an on-demand panel instead of always filling
  // half the screen. Toggled, not routed, so switching back doesn't lose the
  // live conversation state.
  const [showGraph, setShowGraph] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [liveCallCaption, setLiveCallCaption] = useState("");
  const { live: callLive, startCall: startLiveCall, endCall: endLiveCall } = useRealtimeCall({
    // No jobId — a live call with Naxie herself, not a report discussion.
    mintSession: () => api.voiceRealtimeSession(),
    onTranscript: setLiveCallCaption,
  });
  const { personaCount, todaySpend, recentJobs, runningCount } = useAmbientStatus();
  // A live call and the always-listening/push-to-talk mic can't both own the
  // microphone — keep this simple and safe rather than reaching into
  // useNaxieAssistant's internals to arbitrate a real conflict: only offer
  // the live call when neither is active.
  const liveCallBlocked = alwaysListening || mic.active;

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

  const waitingCards: Turn[] = waitingTasks.map(t => ({
    role: "assistant",
    text: t.pendingApproval?.actionDescription ?? `Waiting on your approval: ${t.title}`,
    kind: "approval",
    meta: { taskId: t.id, diff: t.pendingApproval?.diff, actionKind: t.pendingApproval?.kind },
  }));
  const resultTurns = [...waitingCards, ...turns.filter(t => t.kind === "delegation")].slice(-3);
  const recentChat = chatTurns.slice(-10);
  const micLevel = useMicLevel(mic.active);

  return (
    <div className={`flex flex-col gap-4 lg:gap-6 h-full min-h-0 ${showGraph ? "lg:flex-row" : ""}`}>
      {showGraph && (
        <div className="order-2 lg:order-1 lg:flex-1 lg:min-w-0 h-[42vh] lg:h-full lg:max-h-full rounded-xl overflow-hidden border border-ink-800 bg-ink-900/40 shrink-0">
          <KnowledgeGraph focusId={sourceNoteId} />
        </div>
      )}

      <div className={`order-1 lg:order-2 flex flex-col min-h-0 h-full overflow-hidden w-full ${showGraph ? "lg:w-[380px] lg:shrink-0" : "flex-1 max-w-2xl mx-auto"}`}>
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between gap-2 pt-1 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-lg bg-violet-500/15 border border-violet-500/30 grid place-items-center">
              <Sparkles size={14} className="text-violet-400" />
            </span>
            <div>
              <div className="text-[15px] font-semibold tracking-tight text-cream-50 leading-none">Naxie</div>
              <div className="text-[11px] text-cream-300/60 leading-none mt-1">Personal assistant — talk or type</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowGraph(g => !g)}
              className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-full border transition-colors ${showGraph ? "bg-violet-500/15 border-violet-500/30 text-violet-300" : "bg-ink-800 border-ink-700 text-cream-300 hover:bg-ink-700 hover:border-ink-600"}`}
            >
              {showGraph ? <><MessageSquare size={12} /> Chat</> : <><Share2 size={12} /> Knowledge graph</>}
            </button>
            <Link to="/naxie/memory" className="text-[11px] px-2.5 py-1.5 rounded-full bg-ink-800 border border-ink-700 text-cream-300 hover:bg-ink-700">Memory</Link>
          </div>
        </div>

        {/* Status pills */}
        <div className="shrink-0 flex flex-wrap items-center gap-1.5 pb-3">
          <Link to="/agents" className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ink-800/70 border border-violet-500/20 text-[11px] text-cream-300 hover:bg-ink-800 hover:border-violet-500/30 transition-colors">
            <Bot size={11} className="text-violet-400" /> {personaCount ?? "…"} agents
          </Link>
          <Link to="/runs" className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ink-800/70 border border-ink-700 text-[11px] text-cream-300 hover:bg-ink-800 transition-colors">
            <ActivityIcon size={11} className={runningCount > 0 ? "text-emerald-400" : "text-cream-300/50"} /> {runningCount} running
          </Link>
          {todaySpend !== null && (
            <Link to="/cost" className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ink-800/70 border border-ink-700 text-[11px] text-cream-300 hover:bg-ink-800 transition-colors">
              <DollarSign size={11} className="text-coral-400" /> ${todaySpend.toFixed(2)} today
            </Link>
          )}
        </div>

        {/* Scrollable body — orb + results. Composer stays outside so it never scrolls away */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin -mx-1 px-1">
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="relative">
              <div className="absolute inset-0 blur-2xl bg-violet-500/10 rounded-full pointer-events-none" />
              <NaxieOrb state={orbState} size="lg" />
            </div>

            <div className="text-center max-w-sm">
              <div className="text-[10px] uppercase tracking-[0.2em] text-cream-300/60">{orbLabel}</div>
              <div className="text-sm leading-relaxed text-cream-200 mt-2 px-2">
                {orbState === "idle" && lastExchange ? (
                  <span className="line-clamp-3">{lastExchange.answer}</span>
                ) : (
                  orbDescription
                )}
              </div>
            </div>

            {orbState === "listening" && (
              <div className="w-full max-w-sm text-center bg-ink-900/70 backdrop-blur border border-coral-500/20 rounded-xl px-3 py-3 flex flex-col items-center gap-2">
                <MicLevelMeter level={micLevel} />
                <span className="text-sm text-cream-100/90">{liveCaption || <span className="text-cream-300/40">Say something…</span>}</span>
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
                className={`relative w-14 h-14 grid place-items-center rounded-full border shadow-sm transition-all active:scale-95 ${
                  mic.active
                    ? "bg-coral-500 text-white border-coral-400 shadow-coral-500/20"
                    : "bg-ink-800 text-cream-100 border-ink-700 hover:bg-ink-700 hover:border-violet-500/30"
                } disabled:opacity-50`}
              >
                {mic.active ? <Mic size={20} /> : busy ? <Loader2 size={20} className="animate-spin" /> : <MicOff size={18} />}
              </button>
            </div>
            {!mic.supported && <div className="text-[11px] text-cream-300/40 text-center">Mic not supported — type below</div>}

            {voice?.realtime && (
              <div className="w-full max-w-[260px]">
                {callLive === "off" ? (
                  <button
                    type="button"
                    onClick={() => startLiveCall()}
                    disabled={liveCallBlocked}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-full border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/15 disabled:opacity-40 text-xs font-medium transition-colors"
                  >
                    <Phone size={13} /> Start live call
                  </button>
                ) : (
                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={() => { endLiveCall(); setLiveCallCaption(""); }}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-full border border-coral-500/30 bg-coral-500/10 text-coral-300 hover:bg-coral-500/15 text-xs font-medium"
                    >
                      {callLive === "connecting" ? <Loader2 size={13} className="animate-spin" /> : <PhoneOff size={13} />}
                      {callLive === "connecting" ? "Connecting…" : "End call"}
                    </button>
                    {liveCallCaption && (
                      <div className="text-[11px] leading-relaxed text-cream-200 bg-ink-900 border border-violet-500/20 rounded-xl px-3 py-2 text-center">{liveCallCaption}</div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="w-full max-w-[320px] rounded-xl border border-ink-800 bg-ink-900/40 overflow-hidden">
              <button
                type="button"
                onClick={() => setControlsOpen(o => !o)}
                aria-expanded={controlsOpen}
                aria-controls="naxie-controls-panel"
                className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-medium text-cream-200 hover:bg-ink-800/50 transition-colors"
              >
                <span className="flex items-center gap-2"><span className="w-1.5 h-1.5 rounded-full bg-violet-400" /> Controls</span>
                <ChevronDown size={14} className={`transition-transform text-cream-300/60 ${controlsOpen ? "" : "-rotate-90"}`} />
              </button>
              {controlsOpen && (
                <div id="naxie-controls-panel" className="px-3 pb-3 pt-1 flex flex-col gap-2.5 border-t border-ink-800/60">
                  <ToggleRow label="Always listening" checked={alwaysListening} onChange={setAlwaysListening} />
                  {alwaysListening && <ToggleRow label={'Require "Hey Naxie"'} checked={requireWakeWord} onChange={setRequireWakeWord} />}
                  <div className="pt-2 border-t border-ink-800/40">
                    <CapabilityToggles />
                  </div>
                  <Link to="/onboarding" className="text-xs text-violet-300 hover:text-violet-200 pt-1">Edit your profile →</Link>
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3 pb-4">
            {recentChat.length === 0 && resultTurns.length === 0 && !briefing && !onboardingNudge && !busy && (
              <div className="py-6 text-center">
                <div className="inline-flex flex-wrap gap-1.5 justify-center max-w-sm">
                  {["Summarize my latest vault notes", "What did my team ship today?", "Draft a follow-up email to a client", "Show system health"].map(p => (
                    <button key={p} type="button" onClick={() => { setInput(p); void ask(p); setInput(""); }} className="text-xs px-3 py-1.5 rounded-full bg-ink-800 border border-ink-700 text-cream-300 hover:bg-ink-700 hover:text-cream-100 hover:border-violet-500/30 transition-colors">
                      {p}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] text-cream-300/30 mt-3">Tap a prompt or type below</div>
              </div>
            )}
            {busy && orbState === "thinking" && (
              <div className="flex gap-2.5 items-start">
                <span className="w-7 h-7 rounded-full bg-violet-500/15 border border-violet-500/25 grid place-items-center shrink-0"><Sparkles size={13} className="text-violet-400" /></span>
                <div className="bg-ink-800 border border-ink-700 rounded-2xl rounded-tl-md px-4 py-3 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-cream-300/60 animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-cream-300/60 animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-cream-300/60 animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            )}
            <ChatDayPill />
            {onboardingNudge && (
              <NaxieResultCard turn={{ role: "assistant", text: t("onboarding.nudge.text"), kind: "onboarding" }} onDismiss={dismissOnboardingNudge} />
            )}
            {briefing && (
              <NaxieResultCard turn={{ role: "assistant", text: briefing.text, kind: "briefing" }} onReplay={speak} onDismiss={dismissBriefing} />
            )}
            {resultTurns.length > 0 && (
              <div className="space-y-2">
                {resultTurns.map((t, i) => <NaxieResultCard key={i} turn={t} onReplay={speak} onApprove={id => resolveWaitingTask(id, true)} onReject={id => resolveWaitingTask(id, false)} />)}
              </div>
            )}
            {recentChat.length > 0 && (
              <div className="space-y-3">
                {recentChat.map((t, i) => (
                  <NaxieResultCard key={i} turn={t} onReplay={speak} />
                ))}
              </div>
            )}
            {recentChat.length > 5 && (
              <details open={historyOpen} onToggle={e => setHistoryOpen((e.target as HTMLDetailsElement).open)} className="rounded-xl border border-ink-800 bg-ink-900/30 p-3">
                <summary className="flex items-center gap-1.5 text-[11px] font-medium text-cream-300/70 hover:text-cream-300 cursor-pointer select-none list-none">
                  <ChevronDown size={12} className={`transition-transform ${historyOpen ? "" : "-rotate-90"}`} />
                  Older exchanges
                </summary>
                <div className="mt-3 text-[11px] text-cream-300/40">All recent chats already shown above — this keeps the view tidy.</div>
              </details>
            )}
            {recentJobs.length > 0 && (
              <details open={activityOpen} onToggle={e => setActivityOpen((e.target as HTMLDetailsElement).open)} className="rounded-xl border border-ink-800 bg-ink-900/30 p-3">
                <summary className="flex items-center gap-1.5 text-[11px] font-medium text-cream-300/70 hover:text-cream-300 cursor-pointer select-none list-none">
                  <ChevronDown size={12} className={`transition-transform ${activityOpen ? "" : "-rotate-90"}`} />
                  Recent activity
                </summary>
                <div className="mt-3 space-y-1">
                  {recentJobs.map(j => (
                    <Link key={j.id} to={`/runs/${j.id}`} className="flex items-center gap-2 text-xs text-cream-300 hover:text-cream-100 px-2 py-1.5 rounded-lg hover:bg-ink-800/60 transition-colors">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${j.status === "running" ? "bg-emerald-400 animate-pulse" : j.status === "failed" ? "bg-red-400" : "bg-cream-300/30"}`} />
                      <span className="truncate flex-1">{j.title ?? j.template ?? j.kind ?? "Task"}</span>
                      <span className="text-[10px] text-cream-300/40 shrink-0 capitalize">{j.status}</span>
                    </Link>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>

        {/* Sticky composer — stays at bottom while body scrolls */}
        <div className="shrink-0 sticky bottom-0 -mx-1 px-1 pt-3 pb-1 bg-gradient-to-t from-ink-950 via-ink-950 to-transparent">
          {(() => {
            const last = turns[turns.length - 1];
            const isClarify = last?.role === "assistant" && /Any particular|Which one|Looking for\?/i.test(last.text) && last.kind !== "approval" && last.kind !== "delegation";
            return isClarify ? (
              <div className="pb-3">
                <ChatClarificationCard question={last.text} onAnswer={a => { void ask(a); }} placeholder="Type your answer…" />
              </div>
            ) : null;
          })()}
          <KuwanaBottomComposer
            value={input}
            onChange={setInput}
            onSend={() => { if (input.trim()) { void ask(input); setInput(""); } }}
            onMic={micToggle}
            busy={busy}
            placeholder="Ask the Naxie Assistant…"
            disclaimer="Naxie is AI. Check the vault citation before you act."
          />
          {speaking && (
            <div className="flex justify-center pt-2">
              <Button variant="subtle" onClick={stopSpeaking}><VolumeX size={13} /> Stop</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
