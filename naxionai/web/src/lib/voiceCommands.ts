// Voice command grammar — ported from KimmyDeku/sebastian's Chef Mode
// (src/components/recipes/ChefMode.tsx's onVoice): a small ordered list of
// {pattern, action} pairs tried against each FINAL transcript. The valuable
// part of Sebastian's design isn't the literal regexes (those were
// recipe-step-specific) — it's the shape: command-or-ask, never a dead end.
// Anything that doesn't match a command falls through to the caller's
// "ask" action instead of being silently dropped.
//
// Framework-agnostic (no React) so it's independently reasoned-about/reused
// — first application is components/ReadAloud.tsx's "read this note aloud,
// with interrupts" mode.

export type VoiceCommandAction = "stop" | "repeat" | "next" | "back" | "restart" | "ask";

export type VoiceCommandMatch = { action: VoiceCommandAction; question?: string };

const COMMANDS: { action: Exclude<VoiceCommandAction, "ask">; pattern: RegExp }[] = [
  { action: "stop", pattern: /\b(stop|exit|quit|cancel|that's all|thanks? that's it)\b/i },
  { action: "repeat", pattern: /\b(repeat|again|say that|what was that)\b/i },
  { action: "restart", pattern: /\b(start over|restart|from the (top|beginning|start))\b/i },
  { action: "next", pattern: /\b(next|continue|go on|keep going)\b/i },
  { action: "back", pattern: /\b(back|previous|go back)\b/i },
];

// Matches a final transcript against the command grammar. Anything that
// doesn't match a known command is treated as a question for the caller's
// normal ask-Naxie path — never silently dropped. A command word is only
// recognised when it's essentially the whole utterance (short transcript),
// so "next, what does the report say about pricing" is correctly treated as
// a question, not a false "next" match.
export function matchVoiceCommand(transcript: string): VoiceCommandMatch {
  const t = transcript.trim();
  if (!t) return { action: "ask", question: "" };
  const short = t.length <= 40;
  if (short) {
    for (const c of COMMANDS) {
      if (c.pattern.test(t)) return { action: c.action };
    }
  }
  return { action: "ask", question: t };
}
