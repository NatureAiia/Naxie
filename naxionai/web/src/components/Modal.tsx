import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "./Card";

export type ModalSize = "sm" | "md" | "lg" | "xl" | "full";

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
  full: "max-w-[90vw] max-h-[90vh]",
};

// Modal + ConfirmDialog — shared accessible dialog with animations.
// Features:
// - Framer-style scale + fade entrance/exit (respects prefers-reduced-motion)
// - Full focus trap (Tab cycles within dialog, Escape closes)
// - Body scroll lock with modal-open class
// - Size variants: sm, md, lg, xl, full
// - Auto-scroll for tall content
export function Modal({
  open,
  onClose,
  title,
  children,
  className = "",
  size = "md",
  closeOnOverlayClick = true,
  showCloseButton = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  size?: ModalSize;
  closeOnOverlayClick?: boolean;
  showCloseButton?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [isExiting, setIsExiting] = useState(false);
  const [isEntered, setIsEntered] = useState(false);

  // Entrance animation
  useEffect(() => {
    if (open) {
      setIsExiting(false);
      // Force reflow to trigger entrance animation
      requestAnimationFrame(() => {
        setIsEntered(true);
      });
    }
  }, [open]);

  // Exit animation
  useEffect(() => {
    if (!open && isEntered && !isExiting) {
      setIsExiting(true);
      const timer = setTimeout(() => {
        setIsEntered(false);
      }, 200); // Match nw-scale-out duration
      return () => clearTimeout(timer);
    }
  }, [open, isEntered, isExiting]);

  // Focus trap + scroll lock + keyboard handling
  useEffect(() => {
    if (!open && !isExiting) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    document.body.classList.add("modal-open");
    document.body.style.overflow = "hidden";

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      // Focus trap: Tab cycles within dialog
      if (e.key === "Tab") {
        const dialog = dialogRef.current;
        if (!dialog) return;

        const focusableElements = dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement?.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement?.focus();
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.classList.remove("modal-open");
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKeyDown);
      if (!isExiting) {
        previouslyFocused.current?.focus?.();
      }
    };
  }, [open, onClose, isExiting]);

  if (!open && !isEntered) return null;

  const overlayClass =
    "fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm transition-opacity";
  const dialogClass = `
    w-full ${SIZE_CLASSES[size]} bg-ink-950 border border-ink-800 rounded-2xl shadow-2xl outline-none
    ${isExiting ? "nw-scale-out" : "nw-scale-in"}
    ${size === "full" ? "max-h-[90vh] flex flex-col" : ""}
    ${className}
  `.trim();

  return createPortal(
    <div
      className={overlayClass}
      onClick={closeOnOverlayClick ? onClose : undefined}
      role="presentation"
      aria-hidden="true"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={dialogClass}
      >
        {(title || showCloseButton) && (
          <div className="flex items-center justify-between mb-4 flex-shrink-0">
            {title && <h2 className="text-lg font-medium text-cream-50">{title}</h2>}
            {showCloseButton && (
              <button
                onClick={onClose}
                className="p-1.5 text-cream-300/50 hover:text-cream-100 hover:bg-ink-800 rounded-lg transition-colors flex-shrink-0"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}
        <div
          className={size === "full" ? "overflow-y-auto flex-1 pr-2" : ""}
          style={size === "full" ? { scrollbarGutter: "stable" } : undefined}
        >
          {children}
        </div>
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
export function ConfirmDialog({
  open,
  title,
  rows,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  danger = false,
  busy = false,
}: {
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
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
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
