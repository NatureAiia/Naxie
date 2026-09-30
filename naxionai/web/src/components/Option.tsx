import { ReactNode } from "react";

// Option — ported from KimmyDeku/sebastian's src/components/ui/Chip.tsx: one
// selectable-button API behind three render variants, instead of every page
// hand-rolling its own day-of-week/tool-picker toggle button (Schedules.tsx
// and pages/WorkflowTree.tsx each independently wrote near-identical
// "pill that highlights when selected" markup before this existed).
//
// multi=true renders role="checkbox" (any number selected, e.g. a tools
// picker); multi=false renders role="radio" (single-select, e.g. a day
// toggle used as part of a larger multi-select list is still `multi` at the
// group level — see Schedules.tsx's day picker, which selects several days).
export type OptionVariant = "pill" | "row" | "chip";

export function Option({ selected, onToggle, children, variant = "pill", multi = true, disabled = false, className = "" }: {
  selected: boolean;
  onToggle: () => void;
  children: ReactNode;
  variant?: OptionVariant;
  multi?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const base = "transition-colors text-xs disabled:opacity-40 disabled:cursor-not-allowed";
  const skin = {
    pill: `px-3 py-1.5 rounded-full border ${selected ? "bg-violet-500/15 border-violet-500/40 text-violet-200" : "bg-ink-950 border-ink-800 text-cream-300 hover:border-ink-700"}`,
    chip: `px-2 py-0.5 rounded-full border ${selected ? "bg-violet-500/15 border-violet-500/40 text-violet-200" : "bg-ink-950 border-ink-800 text-cream-300/70 hover:border-ink-700"}`,
    row: `w-full text-left px-3 py-2 rounded-md border flex items-center justify-between ${selected ? "bg-violet-500/10 border-violet-500/30 text-cream-100" : "bg-ink-950 border-ink-800 text-cream-300 hover:border-ink-700"}`,
  }[variant];
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onToggle}
      className={`${base} ${skin} ${className}`}
    >
      {children}
    </button>
  );
}
