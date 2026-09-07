import { useState, type ReactNode } from "react";

// Small from-scratch hover tooltip — no headless-UI dependency exists in this
// app yet, so this is deliberately minimal: position near the trigger, show
// on hover/focus, no portal (fine at the sizes this is used at; revisit if a
// future caller needs to escape a clipping ancestor).
export function Tooltip({ content, children, className = "" }: { content: ReactNode; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`relative inline-flex ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2.5 py-1.5 rounded-md bg-ink-950 border border-ink-700 text-[11px] text-cream-200 whitespace-nowrap shadow-lg pointer-events-none"
        >
          {content}
        </span>
      )}
    </span>
  );
}
