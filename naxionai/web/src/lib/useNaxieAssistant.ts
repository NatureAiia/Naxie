import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { showToast } from "../components/Card";
import { useSpeechRecognition } from "./useSpeechRecognition";

// Shared brain for both the full /naxie page and the floating NaxieWidget —
// owns turn history, TTS playback, mic (push-to-talk or always-listening),
// and delegation, so neither caller re-implements ask()/speak()/micToggle()
// (they used to, ~150 duplicated lines each).

export type Turn = {
  role: "user" | "assistant";
  text: string;
  routing?: { tier: string; complexity: string; reason?: string; online?: boolean; backend?: string };
  kind?: "chat" | "delegation" | "briefing" | "onboarding" | "approval";
  meta?: Record<string, unknown>;
  // Vault path of the note that most likely answered this turn — set on
  // assistant chat turns only, so KnowledgeGraph can highlight the source.
  sourceNoteId?: string | null;
};

const STORAGE_KEY = "naxie.turns";
const ALWAYS_LISTENING_KEY = "naxie.alwaysListening";
const REQUIRE_WAKE_WORD_KEY = "naxie.requireWakeWord";
const BRIEFING_DISMISSED_KEY = "naxie.briefingDismissedAt";
// Session-scoped, matching BRIEFING_DISMISSED_KEY exactly — quiet for the
// rest of this tab session once dismissed, but resurfaces next session
// until onboarding is actually completed (no "generatedAt" to compare
// against here, so the flag is just a plain boolean rather than a value).
const ONBOARDING_DISMISSED_KEY = "naxie.onboardingDismissedAt";
// Low-frequency: pendingApprovals/briefing don't need the same cadence a
// live conversation would — this replaces the widget's old private 10s poll.
const STATUS_POLL_MS = 30_000;

export type NaxieBriefing = { text: string; generatedAt: string };
// pendingApproval carries enough of the OrgTask shape (docs/naxie-
// architecture.md §8.3) to decide inline-approve vs. "go read the diff":
// present + no diff → inline Approve/Reject renders right in the chat flow;
// a diff (or kind === "architect-change") → Naxie only links to the full
// Approvals page, since a spoken/tapped "yes" can't meaningfully approve a
// code change you haven't read.
export type WaitingTask = {
  id: string; role: string; title: string;
  pendingApproval?: { actionDescription: string; kind: string; diff?: string; requestedAt: string };
};

// Mirrors the server's StepRun (agent.ts) shape closely enough for the
// Workbench view — one entry per tool call in the currently-running (or most
// recently finished) job driving Naxie's chat reply.
export type WorkbenchStep = {
  step: { tool: string; label?: string; rationale?: string };
  ok: boolean;
  error?: string;
  result?: unknown;
  durationMs: number;
  modelUsed?: string;
};

// How long to wait after the last finalized phrase before treating the
// accumulated speech as one complete ask (continuous mode never cleanly
// goes inactive on a pause, unlike push-to-talk).
const FINALIZE_DEBOUNCE_MS = 600;
// Auto-restart backoff: if the browser's recognizer keeps ending on its own
// (e.g. repeated no-speech timeouts) more than this many times inside the
// window below, stop retrying and let the user restart manually.
const RESTART_BACKOFF_WINDOW_MS = 10_000;
const RESTART_BACKOFF_MAX = 5;
// Zero-dependency wake-word gate — matched against each FINALIZED chunk only
// (never interim), so a partial "hey nax..." mid-utterance doesn't false-arm.
// Tolerates an optional comma ("hey, naxie") and either order isn't needed —
// this is always "hey" first, matching how people actually address her.
const WAKE_PHRASE_RE = /\bhey,?\s+naxie\b/i;

function loadTurns(): Turn[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  // One-time migration: prior versions used sessionStorage — pick it up once
  try {
    const legacy = sessionStorage.getItem(STORAGE_KEY);
    if (legacy) {
      const parsed = JSON.parse(legacy) as Turn[];
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed.slice(-40))); } catch { /* ignore */ }
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return parsed;
    }
  } catch { /* ignore */ }
  return [];
}

function saveTurns(turns: Turn[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(turns.slice(-40))); } catch { /* ignore */ }
}

function loadAlwaysListening(): boolean {
  try {
    const raw = localStorage.getItem(ALWAYS_LISTENING_KEY);
    if (raw != null) return raw === "1";
  } catch { /* ignore */ }
  return true;
}

// Off by default — this changes existing always-listening behavior (nothing
// gets sent until the phrase is heard), so it's opt-in rather than silently
// applied to everyone already using always-listening today.
function loadRequireWakeWord(): boolean {
  try {
    const raw = localStorage.getItem(REQUIRE_WAKE_WORD_KEY);
    if (raw != null) return raw === "1";
  } catch { /* ignore */ }
  return false;
}

export type OrbState = "listening" | "thinking" | "speaking" | "idle";

export function useNaxieAssistant(opts?: { autoListen?: boolean }) {
  const autoListen = opts?.autoListen ?? true;

  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  // Workbench — live step feed for the job currently driving a chat reply
  // (see ask()/watchJob() below). activeJobId is set while one is running.
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [workbenchSteps, setWorkbenchSteps] = useState<WorkbenchStep[]>([]);
  const [workbenchPhase, setWorkbenchPhase] = useState<string | undefined>(undefined);
  const [voice, setVoice] = useState<{ realtime: boolean; openaiTts: boolean; localTts: boolean } | null>(null);
  const [liveCaption, setLiveCaption] = useState("");
  const [alwaysListening, setAlwaysListeningState] = useState<boolean>(loadAlwaysListening);
  const [requireWakeWord, setRequireWakeWordState] = useState<boolean>(loadRequireWakeWord);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [waitingTasks, setWaitingTasks] = useState<WaitingTask[]>([]);
  const [briefing, setBriefing] = useState<NaxieBriefing | null>(null);
  const [briefingDismissedAt, setBriefingDismissedAt] = useState<string | null>(() => {
    try { return sessionStorage.getItem(BRIEFING_DISMISSED_KEY); } catch { return null; }
  });
  const [onboardingNeeded, setOnboardingNeeded] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(() => {
    try { return sessionStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1"; } catch { return false; }
  });
  const mic = useSpeechRecognition();
  const micTextRef = useRef("");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Refs mirroring state that async callbacks (mic events, timers) need to
  // read without capturing a stale closure.
  const alwaysListeningRef = useRef(alwaysListening);
  const requireWakeWordRef = useRef(requireWakeWord);
  const wakeArmedRef = useRef(false);
  const autoListenRef = useRef(autoListen);
  const micIntentionallyStopped = useRef(true); // starts stopped until the auto-start effect below flips it
  const micPausedForTts = useRef(false);
  const finalizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartAttemptsRef = useRef(0);
  const restartWindowStartRef = useRef(0);

  useEffect(() => { alwaysListeningRef.current = alwaysListening; }, [alwaysListening]);
  useEffect(() => { requireWakeWordRef.current = requireWakeWord; wakeArmedRef.current = false; }, [requireWakeWord]);
  useEffect(() => { autoListenRef.current = autoListen; }, [autoListen]);

  useEffect(() => {
    api.voiceStatus().then(setVoice).catch(() => setVoice({ realtime: false, openaiTts: false, localTts: false }));
    return () => {
      stopSpeaking();
      if (finalizeTimerRef.current) clearTimeout(finalizeTimerRef.current);
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (mic.error) showToast(mic.error, "error"); }, [mic.error]);

  useEffect(() => { saveTurns(turns); }, [turns]);

  // Cross-tab / page<->widget sync — now localStorage so StorageEvent fires across tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setTurns(loadTurns());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Consolidated /api/naxie/status poll — pendingApprovals, waiting OrgTasks,
  // and any proactive briefing the daemon generated. Every caller (the full
  // page and the widget) gets the same data from one place, replacing the
  // widget's old private 10s poll.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/api/naxie/status");
        if (!r.ok) return;
        const j = await r.json();
        if (!alive) return;
        setPendingApprovals(j.pendingApprovals ?? 0);
        setWaitingTasks(Array.isArray(j.waiting) ? j.waiting.map((t: any) => ({ id: t.id, role: t.role, title: t.title, pendingApproval: t.pendingApproval })) : []);
        setBriefing(j.briefing ?? null);
        setOnboardingNeeded(j.onboardingNeeded === true);
      } catch { /* ignore — next poll retries */ }
    };
    poll();
    const id = setInterval(poll, STATUS_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  function dismissBriefing() {
    const at = briefing?.generatedAt ?? new Date().toISOString();
    setBriefingDismissedAt(at);
    try { sessionStorage.setItem(BRIEFING_DISMISSED_KEY, at); } catch { /* ignore */ }
  }
  const briefingVisible = briefing != null && briefing.generatedAt !== briefingDismissedAt ? briefing : null;

  function dismissOnboardingNudge() {
    setOnboardingDismissed(true);
    try { sessionStorage.setItem(ONBOARDING_DISMISSED_KEY, "1"); } catch { /* ignore */ }
  }
  const onboardingNudgeVisible = onboardingNeeded && !onboardingDismissed;

  function setAlwaysListening(next: boolean) {
    setAlwaysListeningState(next);
    try { localStorage.setItem(ALWAYS_LISTENING_KEY, next ? "1" : "0"); } catch { /* ignore */ }
    if (next) {
      micIntentionallyStopped.current = false;
      if (autoListenRef.current && !mic.active) void beginListening();
    } else {
      micIntentionallyStopped.current = true;
      if (mic.active) mic.stop();
    }
  }

  function setRequireWakeWord(next: boolean) {
    setRequireWakeWordState(next);
    try { localStorage.setItem(REQUIRE_WAKE_WORD_KEY, next ? "1" : "0"); } catch { /* ignore */ }
  }

  function clearFinalizeTimer() {
    if (finalizeTimerRef.current) { clearTimeout(finalizeTimerRef.current); finalizeTimerRef.current = null; }
  }

  function flushPendingSpeech() {
    clearFinalizeTimer();
    const text = micTextRef.current.trim();
    micTextRef.current = "";
    setLiveCaption("");
    // Require the phrase again for the next utterance — a wake word arms
    // one ask, not the rest of the session.
    wakeArmedRef.current = false;
    if (text) void ask(text);
  }

  async function beginListening() {
    micTextRef.current = "";
    setLiveCaption("");
    try {
      await mic.start((transcript, isFinal) => {
        if (isFinal) {
          let chunk = transcript;
          if (requireWakeWordRef.current && !wakeArmedRef.current) {
            const m = chunk.match(WAKE_PHRASE_RE);
            if (!m) return; // ambient speech pre-wake-word — never touches micTextRef/caption
            wakeArmedRef.current = true;
            chunk = chunk.slice(m.index! + m[0].length).trim();
            if (!chunk) { setLiveCaption("Listening…"); return; } // armed, nothing said yet this chunk
          }
          micTextRef.current = (micTextRef.current ? micTextRef.current.replace(/\s+$/, "") + " " : "") + chunk;
          setLiveCaption(micTextRef.current);
          if (alwaysListeningRef.current) {
            clearFinalizeTimer();
            finalizeTimerRef.current = setTimeout(flushPendingSpeech, FINALIZE_DEBOUNCE_MS);
          }
        } else {
          if (requireWakeWordRef.current && !wakeArmedRef.current) return; // no caption noise pre-wake-word
          const base = micTextRef.current;
          setLiveCaption(base ? base.replace(/\s+$/, "") + " " + transcript : transcript);
        }
      });
    } catch { /* mic.error already set for display */ }
  }

  function scheduleRestart() {
    const now = Date.now();
    if (now - restartWindowStartRef.current > RESTART_BACKOFF_WINDOW_MS) {
      restartWindowStartRef.current = now;
      restartAttemptsRef.current = 0;
    }
    restartAttemptsRef.current += 1;
    if (restartAttemptsRef.current > RESTART_BACKOFF_MAX) {
      showToast("Mic kept dropping — tap it to listen again", "info");
      micIntentionallyStopped.current = true;
      return;
    }
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = setTimeout(() => {
      if (!micIntentionallyStopped.current && !micPausedForTts.current && alwaysListeningRef.current && autoListenRef.current) {
        void beginListening();
      }
    }, 300);
  }

  function stopSpeaking() {
    try { window.speechSynthesis?.cancel(); } catch { /* not supported */ }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    finishSpeaking();
  }

  // Runs once, whichever way TTS playback ends (natural finish or manual stop) —
  // clears the speaking flag and, if we paused the mic to avoid Naxie hearing
  // her own voice, resumes always-listening.
  function finishSpeaking() {
    setSpeaking(false);
    if (micPausedForTts.current) {
      micPausedForTts.current = false;
      if (alwaysListeningRef.current && autoListenRef.current && !micIntentionallyStopped.current) void beginListening();
    }
  }

  // TTS: server (Rachel on ElevenLabs first), then Web Speech.
  async function speak(text: string) {
    try { window.speechSynthesis?.cancel(); } catch { /* not supported */ }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (mic.active) {
      micPausedForTts.current = true;
      mic.stop();
    }
    setSpeaking(true);
    try {
      // Streamed playback: the server starts sending audio bytes as they're
      // synthesized (chunked transfer), and the native <audio> element plays
      // progressively — no need to wait for the whole clip to finish
      // generating AND downloading before anything is heard, unlike a
      // fetch-the-whole-Blob-then-play approach.
      const { streamUrl } = await api.voiceTtsToken(text, "naxie");
      const audio = new Audio(streamUrl);
      audioRef.current = audio;
      audio.onended = finishSpeaking;
      await new Promise<void>((resolve, reject) => {
        audio.oncanplay = () => resolve();
        audio.onerror = () => reject(new Error("tts stream failed"));
        void audio.play().catch(reject);
      });
      return;
    } catch { /* server TTS hiccup -> Web Speech fallback */ }
    try {
      const u = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith("en"));
      // Free, on-device fallback voice — pick a female-coded system voice by
      // the common cross-platform naming (Windows/Chrome "Zira", macOS
      // "Samantha"/"Victoria"/"Karen"/"Moira"/"Tessa", or an explicit
      // "female" label), falling back to whatever the browser offers first.
      const preferred = voices.find(v => /zira|samantha|victoria|karen|moira|tessa|susan|female/i.test(v.name));
      u.voice = preferred ?? voices[0];
      u.rate = 1.02;
      u.pitch = 1.05;
      u.onend = finishSpeaking;
      window.speechSynthesis.speak(u);
    } catch { finishSpeaking(); }
  }

  // Watches a job created by /api/voice/converse to completion: subscribes
  // to its live SSE stream for Workbench step updates, falling back to
  // short-polling if the stream errors (e.g. an intermediary that buffers
  // SSE), then appends the final answer as a chat turn.
  async function watchJob(jobId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = async () => {
        if (settled) return;
        settled = true;
        try {
          const job: any = await api.getJob(jobId);
          const result = job?.result ?? {};
          const answerText = String(result.answer ?? result.partialAnswer ?? "").trim() || "I couldn't produce an answer for that.";
          setTurns(prev => [...prev, { role: "assistant", text: answerText, kind: "chat", sourceNoteId: result.sourceNoteId ?? null }]);
          void speak(answerText);
        } catch (e: any) {
          showToast(e?.message ?? String(e), "error");
        } finally {
          setBusy(false);
          setActiveJobId(null);
          resolve();
        }
      };
      const pollFallback = async () => {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          try {
            const job: any = await api.getJob(jobId);
            if (Array.isArray(job?.result?.runs)) setWorkbenchSteps(job.result.runs);
            // awaiting-approval is NOT terminal — show approval card, don't fake-fail
            if (job?.status && job.status !== "running" && job.status !== "queued" && job.status !== "awaiting-approval" && job.status !== "waiting_on_human") { void finish(); return; }
            // If parked for approval, exit polling and let waitingTasks poll surface the card
            if (job?.status === "awaiting-approval" || job?.status === "waiting_on_human") {
              setBusy(false);
              setActiveJobId(null);
              resolve();
              return;
            }
          } catch { /* transient — keep polling */ }
          await new Promise(r => setTimeout(r, 1500));
        }
        void finish(); // give up waiting — show whatever we have
      };
      try {
        const es = api.jobStream(jobId);
        es.addEventListener("patch", (ev: MessageEvent) => {
          try {
            const patch = JSON.parse(ev.data);
            if (Array.isArray(patch.runs)) setWorkbenchSteps(patch.runs);
            if (typeof patch.phase === "string") setWorkbenchPhase(patch.phase);
          } catch { /* malformed patch — ignore */ }
        });
        es.addEventListener("done", () => { es.close(); void finish(); });
        es.onerror = () => { es.close(); void pollFallback(); };
      } catch {
        void pollFallback();
      }
    });
  }

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setWorkbenchSteps([]);
    setWorkbenchPhase(undefined);
    const next: Turn[] = [...turns, { role: "user", text: question, kind: "chat" }];
    setTurns(next);
    try {
      const r = await api.voiceConverse(next.map(t => ({ role: t.role, content: t.text })));
      if (r.delegated) {
        setTurns(prev => [...prev, { role: "assistant", text: "I'll take care of that and follow up.", kind: "delegation", meta: { role: r.delegated!.role, task: { id: r.delegated!.taskId } } }]);
        setBusy(false);
        return;
      }
      if (!r.jobId) throw new Error("no jobId returned");
      setActiveJobId(r.jobId);
      await watchJob(r.jobId);
    } catch (e: any) {
      // Rollback optimistic user turn — don't pollute next context with failed input
      setTurns(prev => prev.slice(0, -1));
      showToast(e?.message ?? String(e), "error");
      setBusy(false);
    }
  }

  // §8.3 inline approve/reject — for a waiting OrgTask with no diff, this is
  // the whole approval flow (no trip to the full Approvals page needed).
  // Optimistically drops it from the list so the chat card disappears the
  // moment you act, rather than waiting a full poll cycle.
  async function resolveWaitingTask(id: string, approved: boolean) {
    try {
      await api.resolveOrgTaskApproval(id, approved);
      setWaitingTasks(prev => prev.filter(t => t.id !== id));
      setPendingApprovals(prev => Math.max(0, prev - 1));
      showToast(approved ? "Approved" : "Rejected", "success");
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    }
  }

  function clearHistory() {
    stopSpeaking();
    clearFinalizeTimer();
    micTextRef.current = "";
    setLiveCaption("");
    setTurns([]);
    setWorkbenchSteps([]);
    setWorkbenchPhase(undefined);
    setActiveJobId(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore — legacy */ }
    showToast("Chat history cleared", "success");
  }

  // File a raw ask to Naxie's org backlog — she classifies + queues it —
  // and record it as a delegation turn (not a chat bubble) so callers can
  // render it as a result card.
  async function delegate(text: string, priority = "normal") {
    const q = text.trim();
    if (!q) return;
    try {
      const r = await fetch("/api/naxie/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: q, priority }) });
      if (!r.ok) throw new Error(`delegate ${r.status}`);
      const j = (await r.json()) as { role: string; task: { id: string; title: string } };
      setTurns(prev => [...prev, { role: "assistant", text: `Filed to ${j.role}: ${j.task.title}`, kind: "delegation", meta: { role: j.role, task: j.task } }]);
      showToast(`Filed to ${j.role}: ${j.task.title.slice(0, 50)}`, "success");
      return j;
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
      throw e;
    }
  }

  // Manual control layered over the automatic loop: in always-listening mode
  // this is mute/unmute; otherwise it's classic push-to-talk (tap to start,
  // tap to stop-and-send).
  async function micToggle() {
    if (mic.active) {
      micIntentionallyStopped.current = true;
      mic.stop();
      return;
    }
    micIntentionallyStopped.current = false;
    await beginListening();
  }

  // Mic stopped — behavior depends on mode.
  const micWasActiveRef = useRef(false);
  useEffect(() => {
    if (micWasActiveRef.current && !mic.active) {
      if (!alwaysListening) {
        // Push-to-talk: send whatever accumulated while listening.
        flushPendingSpeech();
      } else if (!micIntentionallyStopped.current && !micPausedForTts.current) {
        // Continuous mode: the browser ended recognition on its own
        // (silence timeout, network hiccup) — flush anything pending, then
        // auto-restart with backoff.
        flushPendingSpeech();
        scheduleRestart();
      }
    }
    micWasActiveRef.current = mic.active;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mic.active, alwaysListening]);

  // Bring the mic up/down as this surface becomes visible/hidden (the
  // widget disables autoListen on /naxie itself, so the two hook instances
  // never fight over the microphone) or as always-listening is toggled on
  // mount.
  useEffect(() => {
    if (!autoListen) {
      if (mic.active) { micIntentionallyStopped.current = true; mic.stop(); }
      return;
    }
    if (alwaysListeningRef.current && mic.supported && !mic.active) {
      micIntentionallyStopped.current = false;
      void beginListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoListen, mic.supported]);

  const orbState: OrbState = mic.active ? "listening" : busy ? "thinking" : speaking ? "speaking" : "idle";

  const chatTurns = turns.filter(t => (t.kind ?? "chat") === "chat");
  const lastExchange = (() => {
    const last = chatTurns[chatTurns.length - 1];
    if (!last || last.role !== "assistant") return null;
    const prevUser = [...chatTurns].reverse().find(t => t.role === "user");
    return { question: prevUser?.text ?? "", answer: last.text };
  })();
  // The vault note the most recent answer drew from, if any — KnowledgeGraph
  // reads this to highlight the source node the way jarvis-claude-code's
  // graph does, riding on the RAG scoring the server already computes.
  const sourceNoteId = [...chatTurns].reverse().find(t => t.role === "assistant")?.sourceNoteId ?? null;

  return {
    turns, chatTurns, lastExchange, sourceNoteId,
    busy, speaking, voice, liveCaption,
    mic, orbState,
    alwaysListening, setAlwaysListening,
    requireWakeWord, setRequireWakeWord,
    pendingApprovals, waitingTasks, resolveWaitingTask, briefing: briefingVisible, dismissBriefing,
    onboardingNudge: onboardingNudgeVisible, dismissOnboardingNudge,
    ask, speak, stopSpeaking, micToggle, delegate, clearHistory,
    activeJobId, workbenchSteps, workbenchPhase,
  };
}
