import { useEffect, useRef, useState } from "react";

// Lightweight 0..1 mic input level via a Web Audio AnalyserNode, running
// alongside the Web Speech recognizer (its own getUserMedia stream — the
// SpeechRecognition API exposes no volume data of its own). Purely for the
// visual meter; audio never leaves the browser or gets recorded.
export function useMicLevel(active: boolean): number {
  const [level, setLevel] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) { setLevel(0); return; }
    let cancelled = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          // Raw RMS sits low for normal speech volume — scale + clamp for a
          // meter that visibly moves on a normal talking voice.
          setLevel(Math.min(1, rms * 4));
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* mic denied/unavailable — meter stays flat; recognition handles its own permission prompt */ }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      stream?.getTracks().forEach(t => t.stop());
      ctx?.close().catch(() => {});
    };
  }, [active]);

  return level;
}
