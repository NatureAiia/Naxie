import { Terminal as TerminalIcon } from "lucide-react";
import { useTerminal } from "../lib/terminalContext";
import { TerminalPanel } from "../components/TerminalPanel";

// Full-page terminal — a deep-link onto the same session the docked drawer
// (Layout) uses. Session state (cwd, scrollback, history) lives in
// TerminalContext, so switching between this page and the drawer never
// resets anything.

export function Terminal() {
  const { shell } = useTerminal();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><TerminalIcon size={24} /> Terminal</h1>
        <p className="text-sm text-cream-300/70 mt-1">
          Run shell commands on the host{shell ? <> via <span className="font-mono">{shell}</span></> : null}. Each line runs in a fresh shell and <span className="font-mono">cd</span> persists.
          {shell === "powershell"
            ? <> Chain with <span className="font-mono">;</span> or <span className="font-mono">|</span> — Windows PowerShell 5.1 has no <span className="font-mono">&amp;&amp;</span>.</>
            : <> Chain with <span className="font-mono">&amp;&amp;</span> / <span className="font-mono">;</span> / <span className="font-mono">|</span>.</>}
          {" "}Non-interactive — no <span className="font-mono">vim</span>/<span className="font-mono">top</span>. This is the same session as the docked terminal (<span className="font-mono">Ctrl+`</span>) on every other page.
        </p>
      </div>
      <TerminalPanel scrollHeightClass="h-[58vh]" />
    </div>
  );
}
