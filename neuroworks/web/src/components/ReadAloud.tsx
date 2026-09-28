import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Volume2, X } from "lucide-react";
import { Modal } from "./Modal";
import { Button, showToast } from "./Card";
import { useSpeechRecognition } from "../lib/useSpeechRecognition";
import { useSpeaker } from "../lib/useSpeaker";
import { matchVoiceCommand } from "../lib/voiceCommands";
import { api } from "../lib/api";

// "Read this aloud, with interrupts" — first application of the voice
// command grammar (lib/voiceCommands.ts) ported from Sebastian's Chef Mode.
// Chunks markdown by heading, reads each chunk aloud, and listens for
// "next"/"back"/"repeat"/"stop" — or, for anything else, asks Naxie the
// question with the current chunk as context and speaks the answer back.
// Nothing here is a new TTS/STT mechanism: useSpeaker/useSpeechRecognition
// wrap the same server-then-browser and Web-Speech paths
// components/VoiceDiscussion.tsx already uses.

function chunkMarkdown(markdown: string): { heading: string; body: string }[] {
  const stripped = markdown.replace(/^---[\s\S]*?---\n+/, "");
  const parts = stripped.split(/\n(?=##?\s)/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return [{ heading: "Note", body: stripped }];
  return parts.map(p => {
    const m = p.match(/^#+\s*(.+?)\n/);
    return { heading: m ? m[1].trim() : "Note", body: p.replace(/^#+\s*.+\n/, "").trim() };
  }).filter(c => c.body.length > 0);
}

function speakableText(md: string): string {
  // Strip markdown syntax the TTS shouldn't read literally (tables, links,
  // emphasis markers, code fences) — same spirit as the voiceRouter's own
  // "no markdown, no bullet lists read out character by character" rule.
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\|.*\|/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>`]/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

export function ReadAloud({ open, onClose, title, markdown }: { open: boolean; onClose: () => void; title: string; markdown: string }) {
  const chunks = useRef(chunkMarkdown(markdown)).current;
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const speaker = useSpeaker();
  const mic = useSpeechRecognition();
  const listeningRef = useRef(false);

  function speakChunk(i: number) {
    setAnswer(null);
    const c = chunks[Math.max(0, Math.min(chunks.length - 1, i))];
    void speaker.speak(speakableText(`${c.heading}. ${c.body}`));
  }

  useEffect(() => {
    if (open) speakChunk(0);
    else { speaker.stop(); mic.stop(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleTranscript(transcript: string) {
    const match = matchVoiceCommand(transcript);
    if (match.action === "stop") { speaker.stop(); mic.stop(); onClose(); return; }
    if (match.action === "repeat") return speakChunk(idx);
    if (match.action === "restart") { setIdx(0); return speakChunk(0); }
    if (match.action === "next") { const n = idx + 1; if (n < chunks.length) { setIdx(n); speakChunk(n); } else speaker.speak("That's the end of the note."); return; }
    if (match.action === "back") { const n = idx - 1; if (n >= 0) { setIdx(n); speakChunk(n); } return; }
    // Unmatched — falls through to asking Naxie, with the current chunk as
    // context, exactly the "command-or-ask, never a dead end" shape.
    if (!match.question) return;
    setAsking(true);
    try {
      const r = await api.chat([
        { role: "system", content: `The operator is listening to a note titled "${title}". Current section: ${chunks[idx].heading}\n${chunks[idx].body.slice(0, 1500)}\n\nAnswer their spoken question about it in 2-4 short spoken sentences, no markdown.` },
        { role: "user", content: match.question },
      ]);
      const text = r.kind === "message" ? r.text : "I'm looking into that — check the Tasks page for the answer.";
      setAnswer(text);
      void speaker.speak(text);
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setAsking(false); }
  }

  async function toggleMic() {
    if (mic.active) { mic.stop(); listeningRef.current = false; return; }
    listeningRef.current = true;
    try {
      await mic.start((transcript, isFinal) => { if (isFinal) void handleTranscript(transcript); });
    } catch { /* useSpeechRecognition already surfaces mic.error */ }
  }

  if (!open) return null;
  const c = chunks[idx];

  return (
    <Modal open={open} onClose={onClose} title={`Reading aloud — ${title}`}>
      <div className="space-y-3">
        <div className="text-xs text-cream-300/50">Section {idx + 1} of {chunks.length}</div>
        <div className="max-h-56 overflow-y-auto text-sm text-cream-100 space-y-1">
          <div className="font-medium">{c.heading}</div>
          <p className="text-cream-300/80 whitespace-pre-wrap">{c.body.slice(0, 600)}{c.body.length > 600 ? "…" : ""}</p>
        </div>
        {answer && (
          <div className="text-xs bg-violet-500/10 border border-violet-500/20 rounded-lg p-2 text-violet-200">{answer}</div>
        )}
        {mic.error && <div className="text-xs text-coral-400">{mic.error}</div>}
        <div className="flex items-center justify-between pt-1">
          <div className="flex items-center gap-1.5 text-[11px] text-cream-300/50">
            <Volume2 size={12} className={speaker.speaking ? "animate-pulse text-violet-400" : ""} />
            {mic.supported
              ? "Say \"next\", \"back\", \"repeat\", \"stop\" — or ask a question"
              : "Voice commands need Chrome or Edge — use the buttons below"}
          </div>
          <div className="flex items-center gap-2">
            {mic.supported && (
              <Button variant={mic.active ? "primary" : "subtle"} onClick={() => void toggleMic()} disabled={asking}>
                {mic.active ? <MicOff size={14} /> : <Mic size={14} />} {mic.active ? "Listening…" : "Talk"}
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}><X size={14} /> Close</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
