import { ReactNode } from "react";
import { Info, AlertTriangle, ShieldAlert, WifiOff, CheckCircle2, Sparkles, type LucideIcon } from "lucide-react";

// A tone system for persistent inline banners — ported from
// KimmyDeku/sebastian's src/components/ui/States.tsx Notice component.
// Distinct from Card.tsx's showToast() (transient, auto-dismisses): a Notice
// stays on the page as long as its condition holds — "this needs admin
// access", "you're offline", "this is a suggestion, not an executed action".
export type NoticeTone = "info" | "warning" | "permission" | "offline" | "confirm" | "ai";

const TONE: Record<NoticeTone, { icon: LucideIcon; cls: string }> = {
  info: { icon: Info, cls: "bg-violet-500/10 border-violet-500/25 text-violet-200" },
  warning: { icon: AlertTriangle, cls: "bg-amber-500/10 border-amber-500/25 text-amber-200" },
  permission: { icon: ShieldAlert, cls: "bg-coral-500/10 border-coral-500/25 text-coral-200" },
  offline: { icon: WifiOff, cls: "bg-ink-800 border-ink-700 text-cream-300/80" },
  confirm: { icon: CheckCircle2, cls: "bg-leaf-500/10 border-leaf-500/25 text-leaf-200" },
  ai: { icon: Sparkles, cls: "bg-violet-500/10 border-violet-500/25 text-violet-200" },
};

export function Notice({ tone = "info", children, className = "" }: { tone?: NoticeTone; children: ReactNode; className?: string }) {
  const { icon: Icon, cls } = TONE[tone];
  return (
    <div className={`flex items-start gap-2 text-xs px-3 py-2.5 rounded-lg border leading-relaxed ${cls} ${className}`}>
      <Icon size={14} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
