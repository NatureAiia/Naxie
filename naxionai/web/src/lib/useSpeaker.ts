import { useCallback, useRef, useState } from "react";
import { api } from "./api";

// Server-TTS-first, browser-fallback speaker — generalizes the pattern
// components/VoiceDiscussion.tsx's inline speak() already uses (local
// sidecar via api.voiceTts, falling back to window.speechSynthesis on any
// failure), pulled out so a second caller (components/ReadAloud.tsx) doesn't
// have to re-derive it. VoiceDiscussion.tsx is left as-is — this doesn't
// replace it, it's a second, independent use of the same shape.
export type UseSpeaker = {
  speaking: boolean;
  speak: (text: string) => Promise<void>;
  stop: () => void;
};

export function useSpeaker(personaId?: string, purpose: "main" | "readaloud" = "main"): UseSpeaker {
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    try { window.speechSynthesis?.cancel(); } catch { /* not supported */ }
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setSpeaking(false);
  }, []);

  const speak = useCallback(async (text: string) => {
    stop();
    if (!text.trim()) return;
    setSpeaking(true);
    try {
      const blob = await api.voiceTts(text, personaId, purpose);
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      audio.onended = () => setSpeaking(false);
      await audio.play();
      return;
    } catch { /* server TTS unavailable (503, network, no audio support) — fall through */ }
    try {
      const u = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith("en"));
      if (voices.length > 0) u.voice = voices.find(v => /female|UK|GB/i.test(v.name)) ?? voices[0];
      u.rate = 1.02;
      u.onend = () => setSpeaking(false);
      window.speechSynthesis.speak(u);
    } catch { setSpeaking(false); }
  }, [personaId, purpose, stop]);

  return { speaking, speak, stop };
}
