import { Sparkles, Send as DelegateIcon, Newspaper as BriefingIcon, X } from "lucide-react";
import type { Turn } from "../lib/useNaxieAssistant";

// Renders one non-chat (or, via compact mode, one chat) turn as a
// structured card instead of a scrolling chat bubble — the "mission
// control" result surface: delegation receipts, briefings, etc.

const TIER_STYLE = (tier: string) => ({
  borderColor: tier.includes("free-large") ? "rgba(168,85,247,0.4)" : tier.includes("free-small") ? "rgba(34,197,94,0.4)" : tier.includes("ollama") ? "rgba(251,146,60,0.4)" : "rgba(100,116,139,0.4)",
  color: tier.includes("free-large") ? "#c084fc" : tier.includes("free-small") ? "#4ade80" : "#fb923c",
  background: tier.includes("free-large") ? "rgba(168,85,247,0.08)" : tier.includes("free-small") ? "rgba(34,197,94,0.08)" : "rgba(251,146,60,0.08)",
});

const TIER_LABEL: Record<string, string> = {
  "free-small": "⚡ quick free",
  "free-large": "🧠 deep free",
  "ollama-small": "💻 local quick",
  "ollama-large": "💻 local deep",
};

export function NaxieResultCard({ turn, onReplay, onDismiss, compact = false }: { turn: Turn; onReplay?: (text: string) => void; onDismiss?: () => void; compact?: boolean }) {
  if (turn.kind === "delegation") {
    return (
      <div className={`flex items-start gap-2 rounded-lg border border-violet-500/20 bg-violet-500/5 ${compact ? "px-2.5 py-1.5" : "px-3 py-2"}`}>
        <DelegateIcon size={compact ? 11 : 13} className="text-violet-400 mt-0.5 shrink-0" />
        <span className={compact ? "text-[11px] text-cream-100" : "text-sm text-cream-100"}>{turn.text}</span>
      </div>
    );
  }

  if (turn.kind === "briefing") {
    return (
      <div className={`flex items-start gap-2 rounded-lg border border-flame-500/20 bg-flame-500/5 whitespace-pre-line ${compact ? "px-2.5 py-1.5" : "px-3 py-2"}`}>
        <BriefingIcon size={compact ? 11 : 13} className="text-flame-400 mt-0.5 shrink-0" />
        <span className={`flex-1 ${compact ? "text-[11px] text-cream-100" : "text-sm text-cream-100"}`}>{turn.text}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {onReplay && (
            <button type="button" title="Read aloud" onClick={() => onReplay(turn.text)} className="text-flame-400 hover:text-flame-300">
              <Sparkles size={compact ? 11 : 13} />
            </button>
          )}
          {onDismiss && (
            <button type="button" title="Dismiss" onClick={onDismiss} className="text-cream-300/50 hover:text-cream-100">
              <X size={compact ? 11 : 13} />
            </button>
          )}
        </div>
      </div>
    );
  }

  // "chat" — Q + A card with replay + routing pill.
  return (
    <div className="flex flex-col gap-1 w-full">
      {turn.role === "user" ? (
        <div className={`text-cream-300/70 bg-ink-950 border border-ink-800 rounded-lg w-fit max-w-full ${compact ? "text-[11px] px-2.5 py-1.5" : "text-xs px-3 py-2"}`}>{turn.text}</div>
      ) : (
        <>
          <div className={`text-cream-100 bg-violet-500/5 border border-violet-500/20 rounded-lg flex items-start gap-2 ${compact ? "text-[11px] px-2.5 py-1.5" : "text-sm px-3 py-2"}`}>
            {onReplay && (
              <button type="button" title="Replay" onClick={() => onReplay(turn.text)} className="text-violet-400 hover:text-violet-300 mt-0.5 shrink-0">
                <Sparkles size={compact ? 11 : 13} />
              </button>
            )}
            <span>{turn.text}</span>
          </div>
          {turn.routing && (
            <span className="text-[10px] px-2 py-0.5 rounded-full border w-fit opacity-90" title={turn.routing.reason} style={TIER_STYLE(turn.routing.tier)}>
              {TIER_LABEL[turn.routing.tier] ?? turn.routing.tier} · {turn.routing.complexity}{turn.routing.online != null ? (turn.routing.online ? " · online" : " · offline") : ""}
            </span>
          )}
        </>
      )}
    </div>
  );
}
