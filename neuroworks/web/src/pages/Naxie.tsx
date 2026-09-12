import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Mic, MicOff, Loader2, Send, VolumeX, Sparkles, ChevronDown, Bot, Activity as ActivityIcon, DollarSign, Phone, PhoneOff, Share2, MessageSquare } from "lucide-react";
import { Button } from "../components/Card";
import { KnowledgeGraph } from "../components/KnowledgeGraph";
import { NaxieOrb } from "../components/NaxieOrb";
import { NaxieResultCard } from "../components/NaxieResultCard";
import { ToggleRow } from "../components/ToggleRow";
import { CapabilityToggles } from "../components/CapabilityToggles";
import { MicLevelMeter } from "../components/MicLevelMeter";
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
    <div className={`flex flex-col tablet:h-full gap-4 tablet:gap-6 ${showGraph ? "tablet:flex-row" : ""}`}>
      {/* Below `tablet` this stacks — Naxie's panel first (the primary
          surface), the knowledge graph second as a fixed-height pane you
          scroll to, rather than squeezed to nothing beside a 380px column
          that alone exceeds a phone's width. */}
      {showGraph && (
        <div className="order-2 tablet:order-1 tablet:flex-1 tablet:min-w-0 h-80 tablet:h-full py-2">
          <KnowledgeGraph focusId={sourceNoteId} />
        </div>
      )}

      <div className={`order-1 tablet:order-2 flex flex-col tablet:h-full w-full ${showGraph ? "tablet:w-[380px] tablet:shrink-0" : "flex-1 min-w-0 max-w-2xl mx-auto"}`}>
        <div className="flex items-center justify-between gap-2 pt-2 pb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-violet-400" />
            <div>
              <div className="text-lg font-semibold text-cream-50">Naxie</div>
              <div className="text-xs text-cream-300/60">Personal assistant — talk or type</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowGraph(g => !g)}
              title={showGraph ? "Back to chat" : "Open the knowledge graph"}
              className={`flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border ${showGraph ? "bg-violet-500/15 border-violet-500/40 text-violet-300" : "bg-ink-800 hover:bg-ink-700 border-ink-700 text-cream-300"}`}
            >
              {showGraph ? <><MessageSquare size={12} /> Chat</> : <><Share2 size={12} /> Knowledge graph</>}
            </button>
            <Link to="/naxie/memory" className="text-[11px] px-2 py-1 rounded-md bg-ink-800 hover:bg-ink-700 border border-ink-700 text-cream-300">Memory</Link>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 pb-3 text-[11px] text-cream-300/70">
          <Link to="/agents" className="flex items-center gap-1 px-2 py-1 rounded-md bg-ink-800/50 backdrop-blur-sm hover:bg-ink-800/80 border border-violet-500/20">
            <Bot size={11} className="text-violet-400" /> {personaCount ?? "…"} agent{personaCount === 1 ? "" : "s"}
          </Link>
          <Link to="/runs" className="flex items-center gap-1 px-2 py-1 rounded-md bg-ink-800/50 backdrop-blur-sm hover:bg-ink-800/80 border border-violet-500/20">
            <ActivityIcon size={11} className={runningCount > 0 ? "text-leaf-400" : "text-cream-300/50"} /> {runningCount} running
          </Link>
          {todaySpend !== null && (
            <Link to="/cost" className="flex items-center gap-1 px-2 py-1 rounded-md bg-ink-800/50 backdrop-blur-sm hover:bg-ink-800/80 border border-violet-500/20">
              <DollarSign size={11} className="text-coral-400" /> ${todaySpend.toFixed(2)} today
            </Link>
          )}
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

          {voice?.realtime && (
            <div className="w-full max-w-[220px]">
              {callLive === "off" ? (
                <button
                  type="button"
                  onClick={() => startLiveCall()}
                  disabled={liveCallBlocked}
                  title={liveCallBlocked ? "Turn off Always listening (or stop the mic) to start a live call" : "Start a live duplex call with Naxie"}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                >
                  <Phone size={13} /> Start live call
                </button>
              ) : (
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => { endLiveCall(); setLiveCallCaption(""); }}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md border border-coral-500/40 bg-coral-500/10 text-coral-300 hover:bg-coral-500/20 text-xs"
                  >
                    {callLive === "connecting" ? <Loader2 size={13} className="animate-spin" /> : <PhoneOff size={13} />}
                    {callLive === "connecting" ? "Connecting…" : "End call"}
                  </button>
                  {liveCallCaption && (
                    <div className="text-[11px] text-cream-300/70 bg-ink-950/70 border border-violet-500/20 rounded-lg px-2.5 py-1.5 text-center">{liveCallCaption}</div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="w-full max-w-[220px] flex flex-col gap-2 pt-1 border-t border-ink-800/60">
            <ToggleRow label="Always listening" checked={alwaysListening} onChange={setAlwaysListening} />
            {alwaysListening && (
              <ToggleRow label={'Require "Hey Naxie"'} checked={requireWakeWord} onChange={setRequireWakeWord} />
            )}
            <CapabilityToggles />
            <Link to="/onboarding" className="text-xs text-cream-300/60 hover:text-cream-100">Edit your profile</Link>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin space-y-2.5 px-1 pb-3">
          {onboardingNudge && (
            <NaxieResultCard turn={{ role: "assistant", text: t("onboarding.nudge.text"), kind: "onboarding" }} onDismiss={dismissOnboardingNudge} />
          )}
          {briefing && (
            <NaxieResultCard turn={{ role: "assistant", text: briefing.text, kind: "briefing" }} onReplay={speak} onDismiss={dismissBriefing} />
          )}

          {resultTurns.length > 0 && (
            <div className="space-y-2 nw-fade-up">
              {resultTurns.map((t, i) => <NaxieResultCard key={i} turn={t} onReplay={speak} onApprove={id => resolveWaitingTask(id, true)} onReject={id => resolveWaitingTask(id, false)} />)}
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

          {recentJobs.length > 0 && (
            <details open={activityOpen} onToggle={e => setActivityOpen((e.target as HTMLDetailsElement).open)} className="pt-1">
              <summary className="flex items-center gap-1.5 text-[11px] text-cream-300/50 hover:text-cream-300/80 cursor-pointer select-none list-none">
                <ChevronDown size={12} className={`transition-transform ${activityOpen ? "" : "-rotate-90"}`} />
                Recent activity
              </summary>
              <div className="mt-2 space-y-1">
                {recentJobs.map(j => (
                  <Link key={j.id} to={`/runs/${j.id}`} className="flex items-center gap-2 text-[12px] text-cream-300/80 hover:text-cream-100 px-1 py-1 rounded hover:bg-ink-800/50">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${j.status === "running" ? "bg-leaf-400 animate-pulse" : j.status === "failed" ? "bg-flame-400" : "bg-cream-300/30"}`} />
                    <span className="truncate flex-1">{j.title ?? j.template ?? j.kind ?? "Task"}</span>
                    <span className="text-[10px] text-cream-300/40 shrink-0">{j.status}</span>
                  </Link>
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
