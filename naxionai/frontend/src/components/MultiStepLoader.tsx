'use client'

import { useEffect, useState } from "react";

// Multi-Step Loader (adapted from the Aceternity component) — a full-screen
// overlay that walks a vertical list of steps, checking off completed ones and
// spotlighting the current one. The Aceternity source animates with
// framer-motion; this app has none, so the reveal/dim rides CSS transitions.
//
// Two drive modes:
//   • timed (default): advances one step every `duration` ms while `loading`.
//   • controlled: pass `currentState` (0-based index) to sync it to a real
//     running task's live progress instead of a timer.

export type LoaderStep = { text: string };

function CheckIcon({ done }: { done: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`h-5 w-5 shrink-0 transition-colors duration-300 ${done ? "text-leaf-400" : "text-cream-300/40"}`} fill="none" stroke="currentColor" strokeWidth="2.2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

export function MultiStepLoader({
  loadingStates,
  loading,
  duration = 2000,
  loop = false,
  currentState,
  onClose,
}: {
  loadingStates: LoaderStep[];
  loading: boolean;
  duration?: number;
  loop?: boolean;
  currentState?: number;
  onClose?: () => void;
}) {
  const controlled = typeof currentState === "number";
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!loading || controlled) return;
    if (!loop && tick >= loadingStates.length - 1) return;
    const t = setTimeout(() => {
      setTick(prev => (loop ? (prev + 1) % loadingStates.length : Math.min(prev + 1, loadingStates.length - 1)));
    }, duration);
    return () => clearTimeout(t);
  }, [loading, controlled, tick, duration, loop, loadingStates.length]);

  // Reset the timed walk each time a fresh run starts.
  useEffect(() => { if (loading && !controlled) setTick(0); }, [loading, controlled]);

  if (!loading) return null;
  const active = controlled ? Math.max(0, Math.min(currentState!, loadingStates.length - 1)) : tick;

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-ink-950/80 backdrop-blur-sm nw-page-fade">
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="fixed right-4 top-4 z-[120] rounded-md p-1 text-cream-200 hover:bg-ink-800 hover:text-cream-50"
          aria-label="Dismiss"
        >
          <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="4" /><path strokeLinecap="round" d="M9 9l6 6M15 9l-6 6" /></svg>
        </button>
      )}
      <div className="relative flex max-h-[70vh] w-full max-w-md flex-col gap-4 overflow-hidden px-6">
        {loadingStates.map((s, i) => {
          const done = i < active;
          const current = i === active;
          // Fade steps by distance from the active one, so the list reads as a
          // moving spotlight rather than a flat checklist.
          const dist = Math.abs(i - active);
          const opacity = current ? 1 : Math.max(0.25, 1 - dist * 0.28);
          return (
            <div
              key={i}
              className={`flex items-center gap-3 transition-all duration-500 ${current ? "scale-[1.02]" : ""}`}
              style={{ opacity }}
            >
              {done
                ? <CheckIcon done />
                : current
                  ? <span className="h-5 w-5 shrink-0 rounded-full border-2 border-violet-400 border-t-transparent animate-spin" />
                  : <span className="h-5 w-5 shrink-0 rounded-full border-2 border-cream-300/25" />}
              <span className={`text-left text-sm ${current ? "font-medium text-cream-50" : done ? "text-cream-200" : "text-cream-300/70"}`}>
                {s.text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
