import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Trash2, CornerDownLeft, Loader2 } from "lucide-react";
import { useTerminal } from "../lib/terminalContext";

// Presentational terminal console. Used both full-page (pages/Terminal.tsx)
// and docked (components/TerminalDrawer.tsx) — all session state (cwd,
// scrollback, history) lives in TerminalContext so it's identical either way.

function prompt(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  const tail = parts.slice(-2).join("/");
  return tail || dir;
}

export function TerminalPanel({ scrollHeightClass = "h-[58vh]" }: { scrollHeightClass?: string }) {
  const { enabled, hint, shell, cwd, entries, running, history, run, clear } = useTerminal();
  const [input, setInput] = useState("");
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries, running]);

  function submit() {
    if (!input.trim() || running) return;
    void run(input);
    setInput("");
    setHistIdx(null);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setInput(history[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx === null) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(null);
        setInput("");
      } else {
        setHistIdx(next);
        setInput(history[next]);
      }
    } else if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      clear();
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-ink-950/50 backdrop-blur-xl overflow-hidden shadow-inner shadow-black/20">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 bg-white/5 backdrop-blur-md">
        <div className="flex items-center gap-2 text-xs text-cream-300/60 font-mono">
          <span className="w-2.5 h-2.5 rounded-full bg-flame-500/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-leaf-500/60" />
          <span className="ml-2 truncate max-w-[40ch]" title={cwd}>
            {cwd || "—"}
          </span>
        </div>
        <button
          type="button"
          onClick={clear}
          className="flex items-center gap-1.5 text-xs text-cream-300/60 hover:text-cream-100 transition-colors"
          title="Clear scrollback (Ctrl+L)"
        >
          <Trash2 size={13} /> Clear
        </button>
      </div>

      {enabled === false && (
        <div className="flex items-start gap-3 px-4 py-3 text-sm text-flame-300 border-b border-white/10 bg-flame-500/10 backdrop-blur-md">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-flame-200">Terminal is disabled</div>
            <div className="mt-0.5 text-flame-300/90">
              {hint ?? "set NEUROWORKS_TERMINAL=1 in clawbot/.env and restart the server to enable."}
            </div>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        className={`${scrollHeightClass} overflow-y-auto scrollbar-thin px-4 py-3 font-mono text-[13px] leading-relaxed`}
      >
        {entries.length === 0 && !running && (
          <div className="text-cream-300/40 select-none">
            {enabled === false
              ? "Enable the terminal to start running commands."
              : "Type a command below and press Enter. ↑/↓ for history, Ctrl+L to clear, 'clear' to reset."}
          </div>
        )}
        {entries.map((en, i) => (
          <div key={i} className="mb-2">
            <div className="flex items-baseline gap-2">
              <span className="text-violet-400 shrink-0">{prompt(en.cwd)} ❯</span>
              <span className="text-cream-100 break-all whitespace-pre-wrap">{en.command}</span>
            </div>
            {en.error && <div className="text-flame-400 whitespace-pre-wrap break-all">{en.error}</div>}
            {en.stdout && <div className="text-cream-200 whitespace-pre-wrap break-all">{en.stdout}</div>}
            {en.stderr && <div className="text-amber-300/90 whitespace-pre-wrap break-all">{en.stderr}</div>}
            {(en.exitCode !== null && en.exitCode !== 0) || en.timedOut ? (
              <div className="text-flame-400/80 text-[11px] mt-0.5">
                {en.timedOut ? "timed out" : `exit ${en.exitCode}`} · {en.elapsedMs} ms
              </div>
            ) : en.error ? null : (
              <div className="text-cream-300/40 text-[11px] mt-0.5">exit 0 · {en.elapsedMs} ms</div>
            )}
          </div>
        ))}
        {running && (
          <div className="flex items-center gap-2 text-cream-300/60">
            <Loader2 size={14} className="animate-spin" /> running…
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-white/10 bg-white/5 backdrop-blur-md">
        <span className="font-mono text-[13px] text-violet-400 shrink-0">{prompt(cwd)} ❯</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={enabled === false || running}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={enabled === false ? "terminal disabled" : `command…${shell ? ` (${shell})` : ""}`}
          className="flex-1 bg-transparent outline-none font-mono text-[13px] text-cream-100 placeholder:text-cream-300/30 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={enabled === false || running || !input.trim()}
          className="flex items-center gap-1 text-xs text-cream-300/60 hover:text-cream-100 disabled:opacity-30 disabled:hover:text-cream-300/60 transition-colors"
          title="Run (Enter)"
        >
          <CornerDownLeft size={14} />
        </button>
      </div>
    </div>
  );
}
