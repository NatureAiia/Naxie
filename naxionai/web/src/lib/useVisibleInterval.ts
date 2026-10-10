import { useEffect, useRef } from "react";

/** Runs a polling callback on mount and at the requested cadence while the tab is visible. */
export function useVisibleInterval(callback: () => void | Promise<void>, delayMs: number) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (document.visibilityState === "visible") void callbackRef.current();

    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === "visible") {
        timer = setInterval(() => void callbackRef.current(), delayMs);
      }
    };
    const onVisibilityChange = () => {
      start();
      if (document.visibilityState === "visible") void callbackRef.current();
    };

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [delayMs]);
}
