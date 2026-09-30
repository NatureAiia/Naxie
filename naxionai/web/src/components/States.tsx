import { ReactNode } from "react";
import { Inbox, AlertTriangle, WifiOff, type LucideIcon } from "lucide-react";
import { Button } from "./Card";

// EmptyState / ErrorState — ported from KimmyDeku/sebastian's
// src/components/ui/States.tsx. Every page today hand-rolls its own
// "nothing here yet" / "something went wrong" copy inline; these give both a
// consistent look without forcing an immediate rewrite of existing pages.
export function EmptyState({ icon: Icon = Inbox, title, body, action }: {
  icon?: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-10 px-4">
      <Icon size={28} className="text-cream-300/30 mb-1" />
      <div className="text-sm text-cream-100 font-medium">{title}</div>
      {body && <div className="text-xs text-cream-300/60 max-w-sm">{body}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", body, offline = false, onRetry }: {
  title?: string;
  body?: ReactNode;
  offline?: boolean;
  onRetry?: () => void;
}) {
  const Icon = offline ? WifiOff : AlertTriangle;
  return (
    <div className="flex flex-col items-center text-center gap-2 py-10 px-4">
      <Icon size={28} className={offline ? "text-cream-300/30 mb-1" : "text-coral-400/70 mb-1"} />
      <div className="text-sm text-cream-100 font-medium">{offline ? "You're offline" : title}</div>
      {body && <div className="text-xs text-cream-300/60 max-w-sm">{body}</div>}
      {onRetry && (
        <Button variant="subtle" onClick={onRetry} className="mt-2">Retry</Button>
      )}
    </div>
  );
}
