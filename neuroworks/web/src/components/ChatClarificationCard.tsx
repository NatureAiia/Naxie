"use client";
/**
 * Kuwana chat → Naxion: inline clarification card
 * "Any particular bank you're looking for?" + inline input + teal send
 * Used when narrowingSlots / clarify flow needs a follow-up before grounding.
 */
import { Send } from "lucide-react";
import { useState } from "react";
import { GlassCard } from "./GlassCard";

export function ChatClarificationCard({ question, placeholder = "Type your answer…", onAnswer, options, answered }: {
  question: string;
  placeholder?: string;
  onAnswer: (answer: string) => void;
  options?: string[] | null;
  answered?: { question: string; value: string }[];
}) {
  const [val, setVal] = useState("");
  const submit = () => { if (val.trim()) { onAnswer(val.trim()); setVal(""); } };
  return (
    <GlassCard className="p-3.5 border-teal-500/20 max-w-[560px] mx-auto">
      {answered && answered.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2.5">
          {answered.map((a, i) => (
            <span key={i} className="text-[11px] px-2 py-1 rounded-full bg-ink-800 border border-ink-700 text-cream-300">{a.question}: <b className="text-cream-50">{a.value}</b></span>
          ))}
        </div>
      )}
      <div className="text-sm font-medium text-cream-50 mb-2.5">{question}</div>
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {options.map(o => (
            <button key={o} type="button" onClick={() => onAnswer(o)} className="text-xs px-2.5 py-1.5 rounded-full border border-teal-500/30 bg-teal-500/10 text-teal-300 hover:bg-teal-500/20 transition-colors">{o}</button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }}
          placeholder={placeholder}
          className="flex-1 bg-ink-950 border border-ink-700 rounded-full px-3.5 py-2 text-sm text-cream-100 placeholder:text-cream-300/40 focus:outline-none focus:border-teal-500/50"
        />
        <button type="button" onClick={submit} disabled={!val.trim()} className="shrink-0 w-9 h-9 rounded-full bg-teal-500/20 border border-teal-500/30 grid place-items-center text-teal-300 hover:bg-teal-500/30 disabled:opacity-40 transition-colors">
          <Send size={14} />
        </button>
      </div>
    </GlassCard>
  );
}

export function ChatDayPill({ label = "Today" }: { label?: string }) {
  return <div className="mx-auto text-[11px] px-2.5 py-1 rounded-full bg-ink-800 border border-ink-700 text-cream-300/70">{label}</div>;
}
