// Minimal switch row — shared by the always-listening toggle and (Phase 3)
// the capability toggles, so both use one consistent control instead of
// each inventing its own.
export function ToggleRow({ label, checked, onChange, disabled = false, compact = false }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; compact?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-2 text-cream-300 ${compact ? "text-[11px]" : "text-xs"}`}>
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${compact ? "w-8 h-4" : "w-9 h-5"} ${checked ? "bg-violet-500" : "bg-ink-700"}`}
      >
        <span className={`absolute top-0.5 left-0.5 rounded-full bg-white transition-transform ${compact ? "w-3 h-3" : "w-4 h-4"} ${checked ? "translate-x-4" : ""}`} />
      </button>
    </div>
  );
}
