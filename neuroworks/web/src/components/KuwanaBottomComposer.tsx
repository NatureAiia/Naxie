"use client";
/**
 * Kuwana bottom composer → Naxion: glass pill with image (+) left, mic right, disclaimer
 */
import { ImagePlus, Mic } from "lucide-react";

export function KuwanaBottomComposer({ value, onChange, onSend, onImage, onMic, busy, placeholder = "Ask the Kuwana Assistant…", disclaimer = "Written by AI. Not money advice — check the details before you decide." }: {
  value: string; onChange: (v: string)=>void; onSend: ()=>void; onImage?: ()=>void; onMic?: ()=>void; busy?: boolean; placeholder?: string; disclaimer?: string;
}) {
  return (
    <div className="sticky bottom-0 border-t border-ink-800 bg-ink-950/80 backdrop-blur-xl pt-3 pb-2">
      <div className="max-w-2xl mx-auto flex items-center gap-2 px-2 py-2 rounded-full border border-ink-700 bg-ink-900/60 backdrop-blur-xl" style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)" }}>
        <button type="button" onClick={onImage} title="Attach image" className="shrink-0 w-9 h-9 rounded-full grid place-items-center text-cream-300 hover:text-cream-50 hover:bg-ink-800 transition-colors">
          <ImagePlus size={16} />
        </button>
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          placeholder={placeholder}
          disabled={!!busy}
          className="flex-1 bg-transparent text-sm text-cream-100 placeholder:text-cream-300/40 focus:outline-none"
        />
        <button type="button" onClick={onMic} title="Voice input" className="shrink-0 w-9 h-9 rounded-full border border-ink-700 grid place-items-center text-cream-300 hover:text-cream-50 transition-colors">
          <Mic size={14} />
        </button>
      </div>
      {disclaimer ? <div className="text-[11px] text-center text-cream-300/40 mt-2">{disclaimer}</div> : null}
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
