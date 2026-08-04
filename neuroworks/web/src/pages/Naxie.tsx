import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2, Send, VolumeX, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { Button, showToast } from "../components/Card";
import { useSpeechRecognition } from "../lib/useSpeechRecognition";
import { KnowledgeGraph } from "../components/KnowledgeGraph";

// A general-purpose, always-listening-by-push-to-talk voice assistant, styled
// as a HUD orb (Iron Man / JARVIS inspiration — see assets/jarvis-reference
// at the repo root and the linked README section). Talks over
// /api/voice/converse — a direct model passthrough, NOT the task/template
// pipeline the text Chat page uses, so every reply is genuinely generated
// (no calculator shortcut, no template matching, no canned strings). Unlike
// VoiceDiscussion.tsx (scoped to one job's report), this page has no job
// context: it's a standalone conversation, kept in sessionStorage only.
//
// Layout: the app's own left nav (Layout.tsx) is the first section; this
// page then splits into the vault's knowledge graph — the "brain" — filling
// the center, with the Naxie panel on the right, Obsidian-style.

type Turn = { role: "user" | "assistant"; text: string };
type ModelOption = { value: string; label: string; kind: "ollama" | "provider" };

const STORAGE_KEY = "neuroworks.naxie.turns";
const MODEL_KEY = "neuroworks.naxie.model";

function loadTurns(): Turn[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function Naxie() {
  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voice, setVoice] = useState<{ realtime: boolean; localTts: boolean } | null>(null);
  // Speech-to-text — the browser's own recognition, no server key needed.
  const mic = useSpeechRecognition();
  const micTextRef = useRef("");
  // Live caption while listening — the "write it so I can see" ask: interim
  // text updates on screen as the user talks, Whisper-Flow style, not just
  // after they stop.
  const [liveCaption, setLiveCaption] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Model access — every locally-pulled Ollama model plus every configured
  // cloud provider, so Naxie isn't pinned to one hardcoded model.
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try { return localStorage.getItem(MODEL_KEY) ?? ""; } catch { return ""; }
  });

  useEffect(() => {
    api.voiceStatus().then(setVoice).catch(() => setVoice({ realtime: false, localTts: false }));
    refreshModels();
    return () => stopSpeaking();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (mic.error) showToast(mic.error, "error"); }, [mic.error]);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-40))); } catch { /* ignore */ }
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  async function refreshModels() {
    try {
      const [m, p] = await Promise.all([api.listModels(), api.listModelProviders()]);
      const options: ModelOption[] = [
        ...m.models.map(mo => ({ value: `ollama:${mo.name}`, label: `${mo.name}${mo.name === m.default ? " (default)" : ""}`, kind: "ollama" as const })),
        ...p.providers.map(pr => ({ value: `provider:${pr.id}`, label: `${pr.label} — ${pr.model}${pr.active ? " (active)" : ""}`, kind: "provider" as const })),
      ];
      setModelOptions(options);
      setSelectedModel(prev => {
        if (prev && options.some(o => o.value === prev)) return prev;
        const activeProvider = p.providers.find(pr => pr.active);
        const fallback = activeProvider ? `provider:${activeProvider.id}` : `ollama:${m.default}`;
        try { localStorage.setItem(MODEL_KEY, fallback); } catch { /* ignore */ }
        return fallback;
      });
    } catch { /* Models page unreachable — Naxie still works on the current default. */ }
  }

  async function selectModel(value: string) {
    setSelectedModel(value);
    try { localStorage.setItem(MODEL_KEY, value); } catch { /* ignore */ }
    if (value.startsWith("provider:")) {
      const id = value.slice("provider:".length);
      try { await api.activateModelProvider(id); await refreshModels(); }
      catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    }
  }

  const currentModelLabel = modelOptions.find(o => o.value === selectedModel)?.label ?? "model";

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
      const modelParam = selectedModel.startsWith("ollama:") ? selectedModel.slice("ollama:".length) : undefined;
      const r = await api.voiceConverse(next.map(t => ({ role: t.role, content: t.text })), modelParam);
      setTurns(prev => [...prev, { role: "assistant", text: r.text }]);
      void speak(r.text);
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  // Voice-driven model switching — "switch to llama3.1", "use qwen 7b",
  // "change model to <provider>". Matched against installed models/providers
  // by loose substring match (spoken model names rarely land exactly).
  // Returns true if it handled the command (caller should NOT also ask()).
  function tryVoiceModelSwitch(text: string): boolean {
    const m = text.match(/^(?:switch|change|use)\s+(?:to\s+)?(?:model\s+)?(?:to\s+)?(.+)$/i);
    if (!m) return false;
    const wanted = normalize(m[1]);
    if (wanted.length < 2) return false;
    const hit = modelOptions.find(o => {
      const n = normalize(o.label);
      return n.includes(wanted) || wanted.includes(n.replace(/default|active/g, ""));
    });
    if (!hit) return false;
    void selectModel(hit.value);
    showToast(`Switched Naxie to ${hit.label}`, "success");
    return true;
  }

  // Push-to-talk: tap to start listening, tap again to stop + ask. Browser
  // speech recognition — no key, no setup. Live text is composed onto
  // liveCaption as interim results arrive (Whisper-Flow style).
  async function micToggle() {
    if (mic.active) {
      mic.stop();
      return;
    }
    stopSpeaking();
    micTextRef.current = "";
    setLiveCaption("");
    try {
      await mic.start((transcript, isFinal) => {
        if (isFinal) {
          micTextRef.current = (micTextRef.current ? micTextRef.current.replace(/\s+$/, "") + " " : "") + transcript;
          setLiveCaption(micTextRef.current);
        } else {
          const base = micTextRef.current;
          setLiveCaption(base ? base.replace(/\s+$/, "") + " " + transcript : transcript);
        }
      });
    } catch { /* mic.error already set for display */ }
  }

  // Mic stopped — send whatever final transcript accumulated while listening
  // (unless it was a "switch model" voice command, which is handled inline).
  const micWasActiveRef = useRef(false);
  useEffect(() => {
    if (micWasActiveRef.current && !mic.active) {
      const text = micTextRef.current.trim();
      micTextRef.current = "";
      setLiveCaption("");
      if (text && !tryVoiceModelSwitch(text)) void ask(text);
    }
    micWasActiveRef.current = mic.active;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic.active]);

  const orbState: "listening" | "thinking" | "speaking" | "idle" =
    mic.active ? "listening" : busy ? "thinking" : speaking ? "speaking" : "idle";

  // Border colour + glow accent per state — orbColor drives the ring/border
  // classes, orbAccent is the same colour as an rgba() for the glow's
  // box-shadow (Tailwind's arbitrary shadow utility doesn't pick up a
  // color from a separate border-* class, so this is set inline below).
  const orbColor = {
    idle: "border-violet-500/50",
    listening: "border-orange-400/80",
    thinking: "border-emerald-400/80",
    speaking: "border-fuchsia-400/80",
  }[orbState];
  const orbAccent = {
    idle: "rgba(125,87,246,0.55)",
    listening: "rgba(255,130,60,0.75)",
    thinking: "rgba(34,197,94,0.72)",
    speaking: "rgba(192,106,255,0.72)",
  }[orbState];
  const orbShadow = orbState === "listening"
    ? "0 0 38px 12px rgba(255,130,60,0.55), 0 0 70px 24px rgba(170,120,255,0.25)"
    : orbState === "thinking"
    ? "0 0 38px 12px rgba(34,197,94,0.55), 0 0 70px 24px rgba(110,231,183,0.25)"
    : orbState === "speaking"
    ? "0 0 38px 12px rgba(192,106,255,0.65), 0 0 72px 24px rgba(124,58,237,0.28)"
    : `0 0 40px 10px ${orbAccent}`;

  const orbLabel = {
    idle: "Standing by",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Peaking…",
  }[orbState];
  const orbDescription = {
    idle: "Tap the mic and say something, or type a message below.",
    listening: "Listening — speak now, tap the mic again to send.",
    thinking: "Thinking — your question is with the assistant.",
    speaking: "Peaking the response with a live voice output.",
  }[orbState];

  return (
    <div className="flex h-full gap-6">
      <div className="flex-1 min-w-0 h-full py-2">
        <KnowledgeGraph />
      </div>

      <div className="flex flex-col h-full w-[380px] shrink-0">
        <div className="flex items-center justify-between gap-2 pt-2 pb-4">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-violet-400" />
            <div>
              <div className="text-lg font-semibold text-cream-50">Naxie</div>
              <div className="text-xs text-cream-300/60">Voice assistant — talk or type</div>
            </div>
          </div>
        </div>

        {modelOptions.length > 0 && (
          <label className="flex items-center gap-2 text-[11px] text-cream-300/50 mb-3">
            <span className="shrink-0">Model</span>
            <select
              value={selectedModel}
              onChange={e => void selectModel(e.target.value)}
              title={currentModelLabel}
              className="flex-1 min-w-0 bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-[11px] text-cream-200 focus:outline-none focus:border-violet-500/60"
            >
              {modelOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}

        <div className="flex flex-col items-center justify-center gap-4 py-4">
          <div className={`relative w-48 h-48 grid place-items-center ${orbState === "listening" ? "nw-state-listening" : orbState === "thinking" ? "nw-state-thinking" : orbState === "speaking" ? "nw-state-speaking" : ""}`}>
            <div className={`nw-orb-ring-a absolute inset-0 rounded-full border-2 ${orbColor} ${orbState !== "idle" ? "opacity-40" : ""}`} />
            <div className={`nw-orb-ring-b absolute inset-6 rounded-full border ${orbColor} opacity-70`} />

            {orbState === "listening" && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative w-full h-full">
                  {[...Array(16)].map((_, index) => (
                    <span
                      key={index}
                      className="nw-radial-bar absolute left-1/2 top-1/2 h-12 w-1 rounded-full bg-orange-400/90"
                      style={{ transform: `rotate(${index * 22.5}deg) translate(-50%, -140%)`, animationDelay: `${(index % 8) * 0.055}s` }}
                    />
                  ))}
                </div>
              </div>
            )}

            {orbState === "thinking" && (
              <>
                <img
                  src="/jarvis/jarvis-waveform.gif"
                  alt=""
                  aria-hidden
                  className="absolute inset-0 w-full h-full object-contain rounded-full"
                />
                <div className="absolute inset-0 grid place-items-center">
                  <div className="relative w-full h-full">
                    {[...Array(12)].map((_, index) => (
                      <span
                        key={index}
                        className="nw-radial-bar nw-radial-bar-think absolute left-1/2 top-1/2 h-12 w-1 rounded-full"
                        style={{ transform: `rotate(${index * 30}deg) translate(-50%, -140%)`, animationDelay: `${index * 0.045}s` }}
                      />
                    ))}
                  </div>
                </div>
              </>
            )}

            {orbState === "speaking" && (
              <>
                <img
                  src="/jarvis/jarvis-waveform.gif"
                  alt="Voice/agent waveform"
                  className="absolute inset-0 w-full h-full object-contain rounded-full"
                />
                <div className="absolute inset-0 grid place-items-center">
                  <div className="relative w-full h-full">
                    {[...Array(10)].map((_, index) => (
                      <span
                        key={index}
                        className="nw-radial-bar nw-radial-bar-speak absolute left-1/2 top-1/2 h-14 w-1 rounded-full"
                        style={{ transform: `rotate(${index * 36}deg) translate(-50%, -140%)`, animationDelay: `${(index % 5) * 0.05}s` }}
                      />
                    ))}
                  </div>
                </div>
              </>
            )}

            <div
              className={`nw-orb-glow ${orbState !== "idle" ? "is-active" : ""} absolute inset-12 rounded-full bg-gradient-to-br from-violet-500/30 to-transparent border ${orbColor}`}
              style={{ boxShadow: orbShadow }}
            />
          </div>

          {/* Status — always written out below the orb, not overlaid on it. */}
          <div className="text-center">
            <div className="text-[10px] uppercase tracking-[0.25em] text-cream-300/70">{orbLabel}</div>
            <div className="text-sm text-cream-200 mt-1 max-w-xs mx-auto">{orbDescription}</div>
          </div>

          {/* Whisper-Flow-style live caption — the words appear as you say
              them, not just after you stop. */}
          {orbState === "listening" && (
            <div className="min-h-[2.5rem] max-w-xs text-center text-sm text-cream-100/90 bg-ink-950/70 border border-coral-500/20 rounded-lg px-3 py-2">
              {liveCaption || <span className="text-cream-300/40">Say something…</span>}
            </div>
          )}

          <button
            type="button"
            onClick={micToggle}
            disabled={(busy && !mic.active) || !mic.supported}
            title={mic.active ? "Stop and send" : "Talk to Naxie"}
            className={`p-4 rounded-full border transition-colors ${
              mic.active
                ? "bg-coral-500/15 border-coral-500/60 text-coral-400 animate-pulse"
                : "bg-ink-800 border-ink-700 text-cream-100 hover:border-violet-500/50"
            }`}
          >
            {mic.active ? <Square size={20} /> : busy ? <Loader2 size={20} className="animate-spin" /> : <Mic size={20} />}
          </button>
          {!mic.supported && <div className="text-[11px] text-cream-300/40">Mic capture isn't supported in this browser — type below instead.</div>}
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
            placeholder="Ask Naxie anything…"
            disabled={busy}
            className="flex-1 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2.5 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60 disabled:opacity-50"
          />
          <Button onClick={() => ask(input)} disabled={busy || !input.trim()}>
            <span title="Ask Naxie">{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
