"use client";
/**
 * Kuwana bottom composer → Naxion: polished pill, auto-resize, send pops
 */
import { ImagePlus, Mic, Send, Loader2 } from "lucide-react";
import { useRef, useEffect } from "react";

export function KuwanaBottomComposer({ value, onChange, onSend, onImage, onMic, busy, placeholder = "Ask the Naxie Assistant…", disclaimer = "Naxie is AI. Check the vault citation before you act." }: {
  value: string; onChange: (v: string)=>void; onSend: ()=>void; onImage?: ()=>void; onMic?: ()=>void; busy?: boolean; placeholder?: string; disclaimer?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [value]);
  const canSend = value.trim().length > 0 && !busy;
  return (
    <div className="sticky bottom-0 bg-gradient-to-t from-ink-950 via-ink-950 to-transparent pt-4 pb-2">
      <div className="max-w-2xl mx-auto flex items-end gap-2 px-3 py-2.5 rounded-[24px] border border-ink-700 bg-ink-900/70 backdrop-blur-xl shadow-lg shadow-black/20 focus-within:border-violet-500/40 focus-within:shadow-violet-500/10 transition-colors">
        <button type="button" onClick={onImage} title="Attach image" className="shrink-0 w-9 h-9 rounded-full bg-ink-800 border border-ink-700 grid place-items-center text-cream-300 hover:text-cream-50 hover:border-ink-600 transition-colors">
          <ImagePlus size={16} />
        </button>
        <textarea
          ref={taRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (canSend) onSend(); } }}
          placeholder={placeholder}
          disabled={!!busy}
          rows={1}
          className="flex-1 bg-transparent text-sm leading-relaxed text-cream-100 placeholder:text-cream-300/40 focus:outline-none resize-none py-2 max-h-[120px]"
        />
        <div className="flex items-center gap-1.5 shrink-0 pb-0.5">
          <button type="button" onClick={onMic} title="Voice input" className="w-9 h-9 rounded-full bg-ink-800 border border-ink-700 grid place-items-center text-cream-300 hover:text-cream-50 transition-colors">
            <Mic size={14} />
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            title="Send"
            className={`w-9 h-9 rounded-full grid place-items-center transition-all active:scale-95 ${canSend ? "bg-violet-600 text-white shadow-md hover:bg-violet-500" : "bg-ink-800 border border-ink-700 text-cream-300/40"}`}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} className={canSend ? "ml-0.5" : ""} />}
          </button>
        </div>
      </div>
      {disclaimer ? <div className="text-[11px] text-center text-cream-300/40 mt-2.5 tracking-wide">{disclaimer}</div> : null}
    </div>
  );
}

export function KuwanaTopPillNav({ items, active }: { items: { label: string; icon?: any; to: string }[]; active?: string }) {
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-full border border-ink-700 bg-ink-900/50 backdrop-blur">
      {items.map(it => (
        <a key={it.label} href={it.to} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-colors ${active===it.label ? "bg-ink-800 text-cream-50" : "text-cream-300 hover:text-cream-50"}`}>
          {it.icon ? <it.icon size={14} /> : null} {it.label}
        </a>
      ))}
    </div>
  );
}
