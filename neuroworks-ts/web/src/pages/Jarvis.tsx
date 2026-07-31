import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2, Send, VolumeX, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { Button, showToast } from "../components/Card";
import { useAudioRecorder } from "../lib/useAudioRecorder";

// A general-purpose, always-listening-by-push-to-talk voice assistant, styled
// as a HUD orb (Iron Man / JARVIS inspiration — see assets/jarvis-reference
// at the repo root and the linked README section). Talks to the same
// /api/chat the text Chat page uses — this is a voice front end for the
// same assistant, not a separate agent. Unlike VoiceDiscussion.tsx (which is
// scoped to one job's report and needs a jobId), this page has no job
// context: it's a standalone conversation, kept in sessionStorage only.

type Turn = { role: "user" | "assistant"; text: string };

const STORAGE_KEY = "neuroworks.jarvis.turns";

function loadTurns(): Turn[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export function Jarvis() {
  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voice, setVoice] = useState<{ realtime: boolean; localTts: boolean } | null>(null);
  const rec = useAudioRecorder();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.voiceStatus().then(setVoice).catch(() => setVoice({ realtime: false, localTts: false }));
    return () => stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-40))); } catch { /* ignore */ }
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  function stopSpeaking() {
    try { window.speechSynthesis?.cancel(); } catch { /* not supported */ }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setSpeaking(false);
  }

  // Same two-tier speak strategy as VoiceDiscussion: local TTS sidecar first,
  // the browser's own speechSynthesis as the always-available fallback.
  async function speak(text: string) {
    stopSpeaking();
    setSpeaking(true);
    if (voice?.localTts) {
      try {
        const blob = await api.voiceTts(text);
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio.onended = () => setSpeaking(false);
        await audio.play();
        return;
      } catch { /* sidecar hiccup → fall through to Web Speech */ }
    }
    try {
      const u = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith("en"));
      const preferred = voices.find(v => /daniel|david|male|uk english male/i.test(v.name));
      u.voice = preferred ?? voices[0];
      u.rate = 1.02;
      u.pitch = 0.9;
      u.onend = () => setSpeaking(false);
      window.speechSynthesis.speak(u);
    } catch { setSpeaking(false); }
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setInput("");
    const next = [...turns, { role: "user" as const, text: question }];
    setTurns(next);
    try {
      const r = await api.chat(next.map(t => ({ role: t.role, content: t.text })));
      setTurns(prev => [...prev, { role: "assistant", text: r.text }]);
      void speak(r.text);
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  // Push-to-talk: tap to start recording, tap again to stop + transcribe +
  // ask. Mirrors VoiceDiscussion's micAsk, minus the jobId dependency.
  async function micToggle() {
    if (rec.recording) {
      const blob = await rec.stop();
      if (!blob) return;
      setBusy(true);
      try {
        const b64 = await blobToDataUrl(blob);
        const t = await api.transcribe(b64);
        setBusy(false);
        if (t.text.trim()) await ask(t.text);
        else showToast("Didn't catch that — try again", "error");
      } catch (e: any) {
        setBusy(false);
        showToast(e?.message ?? String(e), "error");
      }
    } else {
      stopSpeaking();
      await rec.start();
      if (rec.error) showToast(rec.error, "error");
    }
  }

  const orbState: "listening" | "thinking" | "speaking" | "idle" =
    rec.recording ? "listening" : busy ? "thinking" : speaking ? "speaking" : "idle";

  // Border colour + glow accent per state — orbColor drives the ring/border
  // classes, orbAccent is the same colour as an rgba() for the glow's
  // box-shadow (Tailwind's arbitrary shadow utility doesn't pick up a
  // color from a separate border-* class, so this is set inline below).
  const orbColor = {
    idle: "border-violet-500/50",
    listening: "border-coral-500/70",
    thinking: "border-cream-300/50",
    speaking: "border-leaf-500/70",
  }[orbState];
  const orbAccent = {
    idle: "rgba(125,87,246,0.55)",
    listening: "rgba(255,118,87,0.6)",
    thinking: "rgba(216,236,248,0.4)",
    speaking: "rgba(63,179,160,0.6)",
  }[orbState];

  const orbLabel = {
    idle: "Standing by",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking…",
  }[orbState];
  // The sentence under the orb — always says, in plain language, what JARVIS
  // is doing right now.
  const orbDescription = {
    idle: "Tap the mic and say something, or type a message below.",
    listening: "Listening — speak now, tap the mic again to send.",
    thinking: "Thinking — your question is with the assistant.",
    speaking: "Speaking the response out loud.",
  }[orbState];

  const RADIAL_BARS = 16;

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto">
      <div className="flex items-center gap-2 pt-2 pb-4">
        <Sparkles size={18} className="text-violet-400" />
        <div>
          <div className="text-lg font-semibold text-cream-50">JARVIS</div>
          <div className="text-xs text-cream-300/60">Voice assistant — talk or type</div>
        </div>
      </div>

      <div className="flex flex-col items-center justify-center gap-4 py-8">
        <div className="relative w-48 h-48 grid place-items-center">
          {/* Idle base — two counter-rotating rings, dimmed while another
              state's visual (waveform/scan/pulse) is layered on top. */}
          <div className={`nw-orb-ring-a absolute inset-0 rounded-full border-2 ${orbColor} ${orbState !== "idle" ? "opacity-40" : ""}`} />
          <div className={`nw-orb-ring-b absolute inset-6 rounded-full border ${orbColor} opacity-70`} />

          {/* Listening — a radial waveform: bars arranged in a circle,
              each scaling independently. The "audio visualizer" look,
              built from ~16 DOM nodes instead of the heavy waveform gif. */}
          {orbState === "listening" && (
            <div className="absolute inset-0" aria-hidden>
              {Array.from({ length: RADIAL_BARS }).map((_, i) => {
                const angle = (360 / RADIAL_BARS) * i;
                const delay = (i % 4) * 0.09;
                return (
                  <span key={i} className="absolute left-1/2 top-1/2" style={{ transform: `rotate(${angle}deg) translateY(-64px)` }}>
                    <span className="nw-radial-bar block w-[3px] h-5 rounded-full origin-bottom bg-coral-400" style={{ "--d": `${delay}s` } as React.CSSProperties} />
                  </span>
                );
              })}
            </div>
          )}

          {/* Thinking — a conic "radar sweep", the mascot-gif's energy
              (something visibly working) without importing an actual mascot
              asset — same "recreate the effect in CSS" call the codebase
              already made for the mic waveform. */}
          {orbState === "thinking" && (
            <div
              className="nw-orb-scan absolute inset-1 rounded-full"
              aria-hidden
              style={{ background: "conic-gradient(from 0deg, rgba(216,236,248,0.4), transparent 45%)" }}
            />
          )}

          {/* Speaking — concentric rings expanding outward and fading, like
              sound leaving the orb. */}
          {orbState === "speaking" && (
            <>
              {[0, 0.5, 1].map(d => (
                <div key={d} className="nw-orb-pulse-out absolute inset-6 rounded-full border-2 border-leaf-500/60" aria-hidden style={{ "--d": `${d}s` } as React.CSSProperties} />
              ))}
            </>
          )}

          <div
            className={`nw-orb-glow ${orbState !== "idle" ? "is-active" : ""} absolute inset-12 rounded-full bg-gradient-to-br from-violet-500/30 to-transparent border ${orbColor}`}
            style={{ boxShadow: `0 0 40px 10px ${orbAccent}` }}
          />
        </div>

        {/* Status — always written out below the orb, not overlaid on it. */}
        <div className="text-center">
          <div className="text-[10px] uppercase tracking-[0.25em] text-cream-300/70">{orbLabel}</div>
          <div className="text-sm text-cream-200 mt-1 max-w-xs mx-auto">{orbDescription}</div>
        </div>

        <button
          type="button"
          onClick={micToggle}
          disabled={busy && !rec.recording}
          title={rec.recording ? "Stop and send" : "Talk to JARVIS"}
          className={`p-4 rounded-full border transition-colors ${
            rec.recording
              ? "bg-coral-500/15 border-coral-500/60 text-coral-400 animate-pulse"
              : "bg-ink-800 border-ink-700 text-cream-100 hover:border-violet-500/50"
          }`}
        >
          {rec.recording ? <Square size={20} /> : busy ? <Loader2 size={20} className="animate-spin" /> : <Mic size={20} />}
        </button>
        {!rec.supported && <div className="text-[11px] text-cream-300/40">Mic capture isn't supported in this browser — type below instead.</div>}
      </div>

      {turns.length > 0 && (
        <div ref={logRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin space-y-2.5 px-1 pb-3">
          {turns.map((t, i) => (
            <div key={i} className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}>
              {t.role === "user" ? (
                <div className="text-xs text-cream-300/70 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 w-fit max-w-[85%]">{t.text}</div>
              ) : (
                <div className="text-sm text-cream-100 bg-violet-500/5 border border-violet-500/20 rounded-lg px-3 py-2 w-fit max-w-[85%] flex items-start gap-2">
                  <button type="button" title="Replay" onClick={() => speak(t.text)} className="text-violet-400 hover:text-violet-300 mt-0.5 shrink-0">
                    <Sparkles size={13} />
                  </button>
                  <span>{t.text}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 py-3 border-t border-ink-800">
        {speaking && (
          <Button variant="subtle" onClick={stopSpeaking}><VolumeX size={13} /> Stop</Button>
        )}
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void ask(input); }}
          placeholder="Ask JARVIS anything…"
          disabled={busy}
          className="flex-1 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2.5 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60 disabled:opacity-50"
        />
        <Button onClick={() => ask(input)} disabled={busy || !input.trim()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Ask
        </Button>
      </div>
    </div>
  );
}
