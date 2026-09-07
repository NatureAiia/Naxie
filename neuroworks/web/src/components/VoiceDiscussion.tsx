import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { Button, showToast } from "./Card";
import { Mic, MicOff, Square, Loader2, Volume2, VolumeX, Phone, PhoneOff, Send, MessageCircle } from "lucide-react";
import { useSpeechRecognition } from "../lib/useSpeechRecognition";
import { useRealtimeCall } from "../lib/useRealtimeCall";

// Talk to the employee about their report. Three tiers, best available wins:
//   A. Live call — WebRTC full-duplex with the provider (server mints a
//      short-lived secret; report preloaded as session context).
//   B. Ask → answer spoken by the LOCAL TTS sidecar (/api/voice/tts).
//   C. Ask → answer spoken by the browser's own speechSynthesis.
// Question input is typed or spoken (browser SpeechRecognition, no key) in tiers B/C.

type Turn = { q: string; a: string };

// Mic-listening indicator — a handful of CSS-animated bars, staggered by
// animation-delay. Replaces a looping gif/video asset (which cost multiple
// MB for this exact visual) with a few DOM nodes and one shared keyframe
// (nw-mic-wave in index.css).
function MicWaveform({ className = "" }: { className?: string }) {
  const bars = [0, 0.12, 0.24, 0.12, 0];
  return (
    <span className={`inline-flex items-end gap-[2px] h-3.5 ${className}`} aria-hidden="true">
      {bars.map((delay, i) => (
        <span
          key={i}
          className="w-[3px] h-full rounded-full bg-coral-400 origin-bottom"
          style={{ animation: "nw-mic-wave 0.9s ease-in-out infinite", animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

export function VoiceDiscussion({ jobId, personaId, personaName }: { jobId: string; personaId?: string; personaName?: string }) {
  const [status, setStatus] = useState<{ realtime: boolean; localTts: boolean } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const mic = useSpeechRecognition();
  const micTextRef = useRef("");
  const micWasActiveRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { live, startCall: startRealtimeCall, endCall, sendToCall } = useRealtimeCall({
    mintSession: () => api.voiceRealtimeSession(jobId, personaId),
    // A spoken reply during a live call renders exactly like a typed one did
    // before — same turn shape, same "🎙 (spoken)" question marker.
    onTranscript: text => setTurns(prev => [...prev, { q: "🎙 (spoken)", a: text }]),
  });

  useEffect(() => {
    api.voiceStatus().then(setStatus).catch(() => setStatus({ realtime: false, localTts: false }));
    return () => { stopSpeaking(); endCall(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Mic stopped (button tap or the browser auto-ending recognition) — send
  // whatever final transcript accumulated during this listening session.
  useEffect(() => {
    if (micWasActiveRef.current && !mic.active) {
      const text = micTextRef.current.trim();
      micTextRef.current = "";
      if (text) void ask(text);
    }
    micWasActiveRef.current = mic.active;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic.active]);

  function stopSpeaking() {
    try { window.speechSynthesis?.cancel(); } catch { /* not supported */ }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setSpeaking(false);
  }

  // Speak via the best non-realtime tier: local sidecar first, Web Speech after.
  async function speak(text: string) {
    stopSpeaking();
    setSpeaking(true);
    if (status?.localTts) {
      try {
        const blob = await api.voiceTts(text, personaId);
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio.onended = () => setSpeaking(false);
        await audio.play();
        return;
      } catch { /* sidecar hiccup → fall through to Web Speech */ }
    }
    try {
      const u = new SpeechSynthesisUtterance(text);
      // Stable voice per employee: pick from the installed list by name hash.
      const voices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith("en"));
      if (voices.length > 0) {
        let h = 0; const key = (personaId ?? personaName ?? "n").toLowerCase();
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        u.voice = voices[h % voices.length];
      }
      u.rate = 1.04;
      u.onend = () => setSpeaking(false);
      window.speechSynthesis.speak(u);
    } catch { setSpeaking(false); }
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    // In a live call, a typed prompt goes INTO the call (spoken back), not to
    // the REST ask path.
    if (live === "on") {
      if (sendToCall(question)) { setTurns(prev => [...prev, { q: question, a: "…" }]); setQ(""); return; }
      showToast("Call channel not ready yet — one moment.", "error");
      return;
    }
    setBusy(true); setQ("");
    try {
      const r = await api.voiceAsk(jobId, question, personaId, turns.slice(-4));
      setTurns(prev => [...prev, { q: question, a: r.text }]);
      void speak(r.text);
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(false); }
  }

  async function micAsk() {
    if (mic.active) {
      mic.stop();
      return;
    }
    micTextRef.current = "";
    try {
      await mic.start((transcript, isFinal) => {
        if (isFinal) micTextRef.current = (micTextRef.current ? micTextRef.current.replace(/\s+$/, "") + " " : "") + transcript;
      });
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    }
  }

  // ── Tier A: live WebRTC call ──────────────────────────────────────────
  // The connection mechanics live in useRealtimeCall now; this wrapper keeps
  // the realtime-availability check + its specific error message, which is
  // this component's own UX concern, not the shared hook's.
  function startCall() {
    if (live !== "off") return;
    if (!status?.realtime) {
      showToast("Live calls need an OpenAI provider — set OPENROUTER_API_KEY or OPENAI_API_KEY in .env and restart. Meanwhile, ask below and I'll speak the answer.", "error");
      return;
    }
    void startRealtimeCall();
  }

  const name = personaName ?? "the employee";

  return (
    <section className="mt-8 bg-ink-900 border border-ink-800 rounded-2xl p-5">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm font-medium text-cream-100">
          <MessageCircle size={15} className="text-violet-400" />
          Talk it through with {name}
          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border border-ink-700 text-cream-300/50">
            {live === "on" ? "live call" : status?.localTts ? "local voice" : status?.realtime ? "voice ready" : "browser voice"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {speaking && (
            <Button variant="subtle" onClick={stopSpeaking}><VolumeX size={13} /> Stop</Button>
          )}
          {live === "off"
            ? <Button variant="subtle" onClick={startCall}><Phone size={13} /> Start live call</Button>
            : <Button onClick={endCall}>{live === "connecting" ? <Loader2 size={13} className="animate-spin" /> : <PhoneOff size={13} />} {live === "connecting" ? "Connecting…" : "End call"}</Button>
          }
        </div>
      </div>

      {live === "on" && (
        <div className="text-xs text-leaf-400 bg-leaf-500/10 border border-leaf-500/30 rounded-lg px-3 py-2 mb-3">
          Live — just talk, or type a prompt below to steer {name}. They have the report in front of them; interrupt any time.
        </div>
      )}

      {turns.length > 0 && (
        <div className="space-y-2.5 mb-3 max-h-72 overflow-y-auto scrollbar-thin">
          {turns.map((t, i) => (
            <div key={i} className="space-y-1.5">
              <div className="text-xs text-cream-300/70 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 w-fit max-w-[85%] ml-auto">{t.q}</div>
              <div className="text-sm text-cream-100 bg-violet-500/5 border border-violet-500/20 rounded-lg px-3 py-2 w-fit max-w-[85%] flex items-start gap-2">
                <button type="button" title="Replay" onClick={() => speak(t.a)} className="text-violet-400 hover:text-violet-300 mt-0.5 shrink-0"><Volume2 size={13} /></button>
                <span>{t.a}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void ask(q); }}
          placeholder={live === "on" ? `Type a prompt to steer ${name}…` : `Ask ${name} about this report…`}
          disabled={busy}
          className="flex-1 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2.5 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60 disabled:opacity-50"
        />
        {mic.supported && live !== "on" && (
          <button
            type="button"
            onClick={micAsk}
            disabled={busy}
            title={mic.active ? "Stop and send" : "Ask by voice"}
            className={`p-2.5 rounded-lg border transition-colors ${mic.active ? "bg-coral-500/15 border-coral-500/50 text-coral-400 animate-pulse" : "bg-ink-950 border-ink-800 text-cream-300/70 hover:border-violet-500/40"}`}
          >
            {mic.active ? <Square size={15} /> : busy ? <Loader2 size={15} className="animate-spin" /> : <Mic size={15} />}
          </button>
        )}
        {mic.active && <MicWaveform />}
        {!mic.supported && live !== "on" && <MicOff size={15} className="text-cream-300/30" />}
        <Button onClick={() => ask(q)} disabled={busy || !q.trim()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} {live === "on" ? "Send" : "Ask"}
        </Button>
      </div>
    </section>
  );
}
