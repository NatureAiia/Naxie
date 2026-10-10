import {
  ReactNode,
  forwardRef,
  type TextareaHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
} from "react";
import { AlertCircle, type LucideIcon } from "lucide-react";

// ── Field ───────────────────────────────────────────────────────────────────
// Label + hint + error wrapper. Renders nothing on its own — compose it with
// Input/Textarea/Select to get a consistent vertical rhythm.

export type FieldProps = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
};

export function Field({ label, hint, error, required, className = "", children }: FieldProps) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      {label && (
        <label className="block text-[12px] font-medium text-cream-300/70">
          {label}
          {required && <span className="text-coral-400 ml-0.5">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="text-[11px] text-cream-300/40 leading-relaxed">{hint}</p>}
      {error && (
        <p className="text-[11px] text-coral-400 flex items-center gap-1 leading-relaxed">
          <AlertCircle size={12} className="shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}

// ── Input ───────────────────────────────────────────────────────────────────
// Single shared text input. Replaces the 5+ inline FIELD constants spread
// across pages (MyTasks, Brands, Integrations, etc.) with one component.

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
  error?: string;
  label?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  icon?: LucideIcon;
  className?: string;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error, label, hint, required, icon: Icon, className = "", ...rest }, ref) => {
    const input = (
      <input
        ref={ref}
        {...rest}
        className={`w-full bg-ink-950 border ${error ? "border-coral-500/50 focus:border-coral-500/70" : "border-ink-800 focus:border-violet-500/60"} text-sm text-cream-100 rounded-lg px-3 py-2 outline-none transition-colors placeholder:text-cream-300/30 ${Icon ? "pl-9" : ""} ${className}`}
      />
    );

    if (!Icon) return input;

    return (
      <div className="relative">
        {input}
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-cream-300/40 pointer-events-none">
          <Icon size={15} />
        </span>
      </div>
    );
  },
);
Input.displayName = "Input";

// ── Textarea ────────────────────────────────────────────────────────────────

export type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & {
  error?: string;
  label?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
};

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ error, label, hint, required, className = "", ...rest }, ref) => {
    return (
      <textarea
        ref={ref}
        {...rest}
        rows={rest.rows ?? 3}
        className={`w-full bg-ink-950 border ${error ? "border-coral-500/50 focus:border-coral-500/70" : "border-ink-800 focus:border-violet-500/60"} text-sm text-cream-100 rounded-lg px-3 py-2 outline-none transition-colors placeholder:text-cream-300/30 resize-y ${className}`}
      />
    );
  },
);
Textarea.displayName = "Textarea";

// ── Select ──────────────────────────────────────────────────────────────────

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & {
  error?: string;
  label?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ error, label, hint, required, className = "", children, ...rest }, ref) => {
    return (
      <select
        ref={ref}
        {...rest}
        className={`w-full bg-ink-950 border ${error ? "border-coral-500/50 focus:border-coral-500/70" : "border-ink-800 focus:border-violet-500/60"} text-sm text-cream-100 rounded-lg px-3 py-2 outline-none transition-colors appearance-none ${className}`}
      >
        {children}
      </select>
    );
  },
);
Select.displayName = "Select";