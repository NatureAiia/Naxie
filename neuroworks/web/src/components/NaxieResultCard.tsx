import { Link } from "react-router-dom";
import { Sparkles, Send as DelegateIcon, Newspaper as BriefingIcon, Compass, X, Check, ShieldAlert } from "lucide-react";
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

export function NaxieResultCard({ turn, onReplay, onDismiss, onApprove, onReject, compact = false }: {
  turn: Turn; onReplay?: (text: string) => void; onDismiss?: () => void;
  // §8.3 inline approve/reject — called with turn.meta.taskId. Only wired up
  // by callers that actually have a live OrgTask id (the waiting-cards path);
  // historical "delegation" turns replayed from session storage never carry
  // these, so the card just renders read-only for those.
  onApprove?: (taskId: string) => void; onReject?: (taskId: string) => void;
  compact?: boolean;
}) {
  if (turn.kind === "approval") {
    const taskId = turn.meta?.taskId as string | undefined;
    const diff = turn.meta?.diff as string | undefined;
    const actionKind = turn.meta?.actionKind as string | undefined;
    // The one deliberate exception in §8.3: a diff (or an architect-change,
    // which is always a diff in practice) never gets a spoken/tapped "yes" —
    // it forces a real look on the full Approvals page.
    const forcesFullPage = !!diff || actionKind === "architect-change";
    return (
      <div className={`flex flex-col gap-2 rounded-lg border border-amber-400/25 bg-amber-400/5 ${compact ? "px-2.5 py-1.5" : "px-3 py-2.5"}`}>
        <div className="flex items-start gap-2">
          <ShieldAlert size={compact ? 11 : 13} className="text-amber-300 mt-0.5 shrink-0" />
          <span className={compact ? "text-[11px] text-cream-100" : "text-sm text-cream-100"}>{turn.text}</span>
        </div>
        {forcesFullPage ? (
          <Link to="/my-work" className={`text-amber-300 hover:text-amber-200 font-medium ${compact ? "text-[11px]" : "text-sm"}`}>
            This needs a real look — review in My Inbox →
          </Link>
        ) : taskId && onApprove && onReject ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onApprove(taskId)}
              className={`inline-flex items-center gap-1 rounded-md bg-leaf-500/15 border border-leaf-500/40 text-leaf-300 hover:bg-leaf-500/25 ${compact ? "text-[11px] px-2 py-1" : "text-xs px-2.5 py-1.5"}`}
            ><Check size={compact ? 11 : 12} /> Approve</button>
            <button
              type="button"
              onClick={() => onReject(taskId)}
              className={`inline-flex items-center gap-1 rounded-md bg-ink-800 border border-ink-700 text-cream-300 hover:text-coral-400 hover:border-coral-500/40 ${compact ? "text-[11px] px-2 py-1" : "text-xs px-2.5 py-1.5"}`}
            ><X size={compact ? 11 : 12} /> Reject</button>
          </div>
        ) : (
          <Link to="/my-work" className={`text-amber-300 hover:text-amber-200 font-medium ${compact ? "text-[11px]" : "text-sm"}`}>Review in My Inbox →</Link>
        )}
      </div>
    );
  }

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

  if (turn.kind === "onboarding") {
    return (
      <div className={`flex items-start gap-2 rounded-lg border border-violet-500/20 bg-violet-500/5 ${compact ? "px-2.5 py-1.5" : "px-3 py-2"}`}>
        <Compass size={compact ? 11 : 13} className="text-violet-400 mt-0.5 shrink-0" />
        <span className={`flex-1 ${compact ? "text-[11px] text-cream-100" : "text-sm text-cream-100"}`}>{turn.text}</span>
        <div className="flex items-center gap-2 shrink-0">
          <Link to="/onboarding" className={`text-violet-400 hover:text-violet-300 font-medium ${compact ? "text-[11px]" : "text-sm"}`}>
            Set up
          </Link>
          {onDismiss && (
            <button type="button" title="Dismiss" onClick={onDismiss} className="text-cream-300/50 hover:text-cream-100">
              <X size={compact ? 11 : 13} />
            </button>
          )}
        </div>
      </div>
    );
  }

  // "chat" — polished bubbles with avatar, copy, routing pill
  if (compact) {
    return (
      <div className={`flex w-full ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
        <div className={`${turn.role === "user" ? "bg-violet-600 text-white rounded-2xl rounded-br-md" : "bg-ink-800 border border-ink-700 text-cream-100 rounded-2xl rounded-tl-md"} max-w-[85%] px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words shadow-sm`}>
          {turn.text}
        </div>
      </div>
    );
  }
  return (
    <div className={`flex w-full gap-2.5 ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
      {turn.role === "assistant" && (
        <span className="w-7 h-7 rounded-full bg-violet-500/15 border border-violet-500/25 grid place-items-center shrink-0 mt-0.5">
          <Sparkles size={13} className="text-violet-400" />
        </span>
      )}
      <div className={`flex flex-col gap-1.5 max-w-[82%] ${turn.role === "user" ? "items-end" : "items-start"}`}>
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words shadow-sm ${
            turn.role === "user"
              ? "bg-violet-600 text-white rounded-br-md"
              : "bg-ink-800 border border-ink-700 text-cream-100 rounded-tl-md"
          }`}
        >
          {turn.text}
        </div>
        {turn.role === "assistant" && (
          <div className="flex items-center gap-1.5 px-1">
            {onReplay && (
              <button type="button" title="Read aloud" onClick={() => onReplay(turn.text)} className="w-6 h-6 rounded-full bg-ink-800 border border-ink-700 grid place-items-center text-cream-300/60 hover:text-violet-300 hover:border-violet-500/30 transition-colors">
                <Sparkles size={11} />
              </button>
            )}
            <button
              type="button"
              title="Copy"
              onClick={() => { try { navigator.clipboard.writeText(turn.text); } catch {} }}
              className="w-6 h-6 rounded-full bg-ink-800 border border-ink-700 grid place-items-center text-cream-300/60 hover:text-cream-100 hover:border-ink-600 transition-colors"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v3" /></svg>
            </button>
            {turn.routing && (
              <span className="text-[10px] px-2 py-0.5 rounded-full border opacity-80" title={turn.routing.reason} style={TIER_STYLE(turn.routing.tier)}>
                {TIER_LABEL[turn.routing.tier] ?? turn.routing.tier}
              </span>
            )}
          </div>
        )}
      </div>
      {turn.role === "user" && (
        <span className="w-7 h-7 rounded-full bg-ink-700 border border-ink-600 grid place-items-center shrink-0 mt-0.5 text-[10px] font-medium text-cream-300">You</span>
      )}
    </div>
  );
}
