import { useCallback, useRef, useState } from "react";

// Sole speech-to-text path for the whole app: the browser's own
// SpeechRecognition (Web Speech API). No server key, no signup, no audio
// round-trip to a third party through our backend — Chrome/Edge/Brave route
// it through their own on-device/vendor speech service. Firefox/Safari don't
// implement it; callers gate on `supported` and let the user type instead.
//
// Shaped like the old AssemblyAI-streaming hook it replaces (start/stop,
// onTurn(transcript, isFinal)) so callers that want live "type as you talk"
// UX keep working unchanged: continuous + interim results are on, and each
// result index behaves like an AssemblyAI turn — interim text for that index
// is REPLACED by the next event for the same index, then finalized once
// isFinal is true and a new index starts for the next phrase.

type SpeechRecognitionCtor = new () => any;

function getCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
}

export type UseSpeechRecognition = {
  supported: boolean;
  active: boolean;
  error: string | null;
  /** Start listening. onTurn fires for every interim/final transcript update. Resolves once recognition has actually started (mic granted); rejects on denial/unsupported. */
  start: (onTurn: (transcript: string, isFinal: boolean) => void) => Promise<void>;
  stop: () => void;
};

export function useSpeechRecognition(): UseSpeechRecognition {
  const [supported] = useState(() => !!getCtor());
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<any>(null);

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* tolerate */ }
  }, []);

  const start = useCallback((onTurn: (transcript: string, isFinal: boolean) => void): Promise<void> => {
    return new Promise((resolve, reject) => {
      const Ctor = getCtor();
      if (!Ctor) {
        const m = "Speech recognition isn't supported in this browser — try Chrome or Edge, or type instead";
        setError(m);
        reject(new Error(m));
        return;
      }
      setError(null);
      const rec = new Ctor();
      recRef.current = rec;
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.continuous = true;

      let started = false;
      rec.onstart = () => { started = true; setActive(true); resolve(); };
      rec.onresult = (e: any) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          onTurn(result[0].transcript, !!result.isFinal);
        }
      };
      rec.onerror = (e: any) => {
        const m = e?.error === "not-allowed" || e?.error === "service-not-allowed"
          ? "Microphone access denied"
          : e?.error === "no-speech"
          ? "Didn't catch that — try again"
          : `Speech recognition error: ${e?.error ?? "unknown"}`;
        setError(m);
        if (!started) reject(new Error(m));
      };
      rec.onend = () => {
        setActive(false);
        recRef.current = null;
      };

      try {
        rec.start();
      } catch (e: any) {
        const m = e?.message ?? "Could not start speech recognition";
        setError(m);
        recRef.current = null;
        reject(new Error(m));
      }
    });
  }, []);

  return { supported, active, error, start, stop };
}
