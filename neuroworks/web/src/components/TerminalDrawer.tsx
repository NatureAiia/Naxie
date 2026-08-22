import { useEffect } from "react";
import { Terminal as TerminalIcon, ChevronDown, Maximize2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTerminal } from "../lib/terminalContext";
import { TerminalPanel } from "./TerminalPanel";

// VSCode-style docked terminal — a bottom-anchored drawer available from any
// page (Ctrl+` toggles it), backed by the same TerminalContext the /terminal
// route reads. Collapsed by default; a slim handle bar stays visible so it's
// discoverable without hunting through nav.

export function TerminalDrawer() {
  const { open, setOpen, toggle, enabled } = useTerminal();
  const navigate = useNavigate();

  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  return (
    <div className={`shrink-0 border-t border-ink-800 bg-ink-950 ${open ? "" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
        className="w-full flex items-center justify-between px-4 py-1.5 text-xs text-cream-300/60 hover:text-cream-100 hover:bg-ink-900/60 transition-colors cursor-pointer select-none"
        title="Toggle terminal (Ctrl+`)"
      >
        <span className="flex items-center gap-2">
          <TerminalIcon size={13} />
          Terminal
          {enabled === false && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/40">disabled</span>}
        </span>
        <span className="flex items-center gap-3">
          <button
            type="button"
            onClick={e => { e.stopPropagation(); navigate("/terminal"); }}
            title="Open full-page"
            className="hover:text-cream-100 text-cream-300/50"
          >
            <Maximize2 size={12} />
          </button>
          <ChevronDown size={13} className={`transition-transform ${open ? "" : "rotate-180"}`} />
        </span>
      </div>
      {open && (
        <div className="px-3 pb-3 pt-1">
          <TerminalPanel scrollHeightClass="h-[26vh]" />
        </div>
      )}
    </div>
  );
}
