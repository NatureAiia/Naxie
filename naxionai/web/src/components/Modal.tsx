import { ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "./Card";

// Modal + ConfirmDialog — ported from KimmyDeku/sebastian's src/components/ui/Modal.tsx.
// Naxie's pages each rolled their own full-screen overlay (McpServers.tsx,
// Extensions.tsx, Connectors.tsx, GithubAccounts.tsx, ...); this is the first
// shared, accessible one. Existing ad hoc overlays are left as-is — this is
// additive, not a forced migration (see McpServers.tsx for the one adopted
// call site).
//
// Focus-trap-lite: focuses the dialog on open, restores focus to whatever
// was focused before on close, Escape closes, body scroll is locked while
// open. Not a full focus-trap (Tab can still leave the dialog) — good enough
// for a confirm-or-cancel dialog with 1-2 actions.
export function Modal({ open, onClose, title, children, className = "" }: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        className={`w-full max-w-lg bg-ink-950 border border-ink-800 rounded-2xl p-6 shadow-2xl outline-none ${className}`}
      >
        {title && (
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-cream-50">{title}</h2>
            <button
              onClick={onClose}
              className="p-1.5 text-cream-300/50 hover:text-cream-100 hover:bg-ink-800 rounded-lg transition-colors"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export type ConfirmRow = [string, string];

// "This is a suggestion, not an executed action" discipline in one reusable
// shape: rows renders a key/value confirmation table, body states plainly
// what happens and what doesn't, danger tints the confirm button for a
// destructive action. Nothing the caller passes here actually runs until
// onConfirm fires — the component itself never calls an API.
export function ConfirmDialog({ open, title, rows, body, confirmLabel = "Confirm", cancelLabel = "Cancel", onConfirm, onCancel, danger = false, busy = false }: {
  open: boolean;
  title: ReactNode;
  rows?: ConfirmRow[];
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      {body && <div className="text-sm text-cream-300/80 mb-4 leading-relaxed">{body}</div>}
      {rows && rows.length > 0 && (
        <dl className="mb-5 divide-y divide-ink-800 border border-ink-800 rounded-lg overflow-hidden">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
              <dt className="text-cream-300/50 shrink-0">{k}</dt>
              <dd className="text-cream-100 text-right break-words">{v || "—"}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
        <Button
          onClick={onConfirm}
          disabled={busy}
          noise={!danger}
          className={danger ? "bg-coral-500 hover:bg-coral-600 text-white" : undefined}
        >
          {busy ? "…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
