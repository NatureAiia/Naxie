import { ReactNode } from "react";

// ── TabGroup ────────────────────────────────────────────────────────────────
// Unified tab navigation. Replaces the 7+ hand-rolled tab patterns in
// DailyReports, Skills, MyWork, Council, BoardMeeting, CommandCenter,
// Connectors, Extensions, and others with one accessible, keyboard-navigable
// component. Syncs the active tab to local state; callers can pass `value`
// + `onChange` for URL-param sync instead.

export type TabDef = {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  badge?: number | string;
  disabled?: boolean;
};

export function TabGroup({
  tabs,
  value,
  onChange,
  variant = "underline",
  className = "",
}: {
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
  variant?: "underline" | "pill" | "row";
  className?: string;
}) {
  const skin = {
    underline: "border-b border-ink-800",
    pill: "bg-ink-900 border border-ink-800 rounded-lg p-1 gap-1",
    row: "border-b border-ink-800",
  }[variant];

  return (
    <div className={`flex items-center gap-0.5 ${skin} ${className}`} role="tablist">
      {tabs.map(tab => {
        const isActive = tab.id === value;
        const isDisabled = tab.disabled ?? false;

        const buttonSkin = {
          underline: `px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            isActive ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-200"
          }`,
          pill: `px-3 py-1.5 text-xs font-medium rounded-md transition-colors inline-flex items-center gap-1.5 ${
            isActive ? "bg-violet-500/15 text-violet-200" : "text-cream-300/70 hover:text-cream-100 hover:bg-ink-800"
          }`,
          row: `px-3 py-2 text-sm font-medium transition-colors inline-flex items-center gap-1.5 ${
            isActive ? "text-cream-50 border-b-2 border-violet-500 -mb-px" : "text-cream-300/60 hover:text-cream-200"
          }`,
        }[variant];

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-disabled={isDisabled}
            disabled={isDisabled}
            onClick={() => !isDisabled && onChange(tab.id)}
            className={buttonSkin}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge !== undefined && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/70 font-mono">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── TabPanel ────────────────────────────────────────────────────────────────
// Renders only the active tab's content. Use alongside TabGroup.

export function TabPanel({
  tabs,
  value,
  children,
}: {
  tabs: TabDef[];
  value: string;
  children: ReactNode[];
}) {
  const idx = tabs.findIndex(t => t.id === value);
  return <div role="tabpanel">{children[idx]}</div>;
}