import { useEffect, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { showToast } from "./Card";

// Header "Go offline" switch (server/src/lib/offline-mode.ts). Offline keeps
// Naxie on this machine + the LAN: local Ollama, the vault, local search.
// Cloud models, web search, Telegram/email polling and vault git sync pause
// until it's switched back. POST is admin-only server-side; a 403 reverts.
//
// State is shared at module level so the header pill and the sidebar footer
// label stay in sync without a context provider.

let shared: boolean | null = null;
const subscribers = new Set<(v: boolean | null) => void>();
let loading: Promise<void> | null = null;

function publish(v: boolean | null) {
  shared = v;
  for (const fn of subscribers) fn(v);
}

function ensureLoaded() {
  if (shared !== null || loading) return;
  loading = api
    .offlineMode()
    .then((r) => publish(r.offline))
    .catch(() => {
      /* leave null — the toggle just doesn't render */
    })
    .finally(() => {
      loading = null;
    });
}

export function useOfflineMode(): boolean | null {
  const [v, setV] = useState<boolean | null>(shared);
  useEffect(() => {
    subscribers.add(setV);
    ensureLoaded();
    return () => {
      subscribers.delete(setV);
    };
  }, []);
  return v;
}

export function OfflineToggle() {
  const offline = useOfflineMode();
  const [pending, setPending] = useState(false);

  if (offline === null) return null;

  async function flip() {
    const next = !offline;
    publish(next);
    setPending(true);
    try {
      const r = await api.setOfflineMode(next);
      publish(r.offline);
      showToast(r.offline ? "Offline — working locally only" : "Back online", "success");
    } catch (e) {
      publish(!next);
      showToast(
        e instanceof ApiError && e.status === 403
          ? "Admin access required to switch offline mode"
          : e instanceof Error
            ? e.message
            : String(e),
        "error",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void flip()}
      disabled={pending}
      role="switch"
      aria-checked={offline}
      aria-label={offline ? "Go back online" : "Go offline (work locally only)"}
      title={
        offline
          ? "Offline: local models, vault and LAN only. Click to reconnect."
          : "Go offline: disconnect from the internet and work locally only"
      }
      className={`nw-shiny-pill flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors disabled:opacity-60 ${
        offline
          ? "bg-amber-400/15 border-amber-400/40 text-amber-300"
          : "border-ink-700 text-cream-300 hover:text-cream-100 hover:border-violet-500/40"
      }`}
    >
      {offline ? <WifiOff size={12} /> : <Wifi size={12} />}
      <span className="hidden tablet:inline">{offline ? "Offline · local only" : "Go offline"}</span>
    </button>
  );
}

export function OfflineFooterLabel() {
  const offline = useOfflineMode();
  return (
    <div className="px-3 text-[10px] text-cream-300/40">
      local, 127.0.0.1{offline ? <span className="text-amber-300/80"> · offline</span> : null}
    </div>
  );
}
