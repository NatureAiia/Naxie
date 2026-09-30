import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";

// Shared terminal session state, lifted out of the Terminal page so it
// survives route navigation — the docked drawer (Layout) and the standalone
// /terminal page both read/write the same context instead of each owning a
// throwaway useState that resets on unmount.

export type TerminalEntry = {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  elapsedMs: number;
  error?: string;
};

type TerminalState = {
  enabled: boolean | null;
  hint?: string;
  shell: string;
  cwd: string;
  entries: TerminalEntry[];
  history: string[];
  running: boolean;
  // Drawer visibility — independent of which route is mounted, so opening
  // the drawer on one page keeps it open when you navigate to another.
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  run: (command: string) => Promise<void>;
  clear: () => void;
};

const TerminalCtx = createContext<TerminalState | null>(null);

export function TerminalProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [hint, setHint] = useState<string | undefined>();
  const [shell, setShell] = useState("");
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    api.terminalStatus()
      .then(s => { setEnabled(s.enabled); setHint(s.hint); setShell(s.shell); setCwd(s.cwd); })
      .catch(() => setEnabled(false));
  }, []);

  async function run(commandRaw: string) {
    const command = commandRaw.trim();
    if (!command || running) return;
    if (command === "clear" || command === "cls") { setEntries([]); return; }
    setHistory(h => [...h, command]);
    setRunning(true);
    try {
      const r = await api.terminalExec(command, cwdRef.current || undefined);
      setCwd(r.cwd);
      setEntries(e => [...e, {
        command, cwd: cwdRef.current || r.cwd, stdout: r.stdout, stderr: r.stderr,
        exitCode: r.exitCode, timedOut: r.timedOut, elapsedMs: r.elapsedMs,
      }]);
    } catch (e: any) {
      setEntries(prev => [...prev, {
        command, cwd: cwdRef.current, stdout: "", stderr: "", exitCode: null, timedOut: false,
        elapsedMs: 0, error: e?.message ?? String(e),
      }]);
    } finally {
      setRunning(false);
    }
  }

  function clear() { setEntries([]); }
  function toggle() { setOpen(o => !o); }

  return (
    <TerminalCtx.Provider value={{ enabled, hint, shell, cwd, entries, history, running, open, setOpen, toggle, run, clear }}>
      {children}
    </TerminalCtx.Provider>
  );
}

export function useTerminal(): TerminalState {
  const ctx = useContext(TerminalCtx);
  if (!ctx) throw new Error("useTerminal must be used within a TerminalProvider");
  return ctx;
}
