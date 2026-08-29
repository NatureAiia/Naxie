import type { OrbState } from "../lib/useNaxieAssistant";

// Presentational HUD orb — shared between the full /naxie page (size="lg")
// and the floating widget button (size="sm"). Colour/animation state comes
// from the nw-state-* / nw-orb-* classes in index.css; this component just
// wires the right classes + mascot gifs to the current orbState.

const ORB_COLOR: Record<OrbState, string> = {
  idle: "border-violet-500/50",
  listening: "border-orange-400/80",
  thinking: "border-emerald-400/80",
  speaking: "border-fuchsia-400/80",
};

const ORB_ACCENT: Record<OrbState, string> = {
  idle: "rgba(125,87,246,0.55)",
  listening: "rgba(255,130,60,0.75)",
  thinking: "rgba(34,197,94,0.72)",
  speaking: "rgba(192,106,255,0.72)",
};

function orbShadow(state: OrbState, accent: string): string {
  if (state === "listening") return "0 0 38px 12px rgba(255,130,60,0.55), 0 0 70px 24px rgba(170,120,255,0.25)";
  if (state === "thinking") return "0 0 38px 12px rgba(34,197,94,0.55), 0 0 70px 24px rgba(110,231,183,0.25)";
  if (state === "speaking") return "0 0 38px 12px rgba(192,106,255,0.65), 0 0 72px 24px rgba(124,58,237,0.28)";
  return `0 0 40px 10px ${accent}`;
}

const STATE_CLASS: Record<OrbState, string> = {
  idle: "",
  listening: "nw-state-listening",
  thinking: "nw-state-thinking",
  speaking: "nw-state-speaking",
};

export function NaxieOrb({ state, size = "lg" }: { state: OrbState; size?: "lg" | "sm" }) {
  const color = ORB_COLOR[state];
  const accent = ORB_ACCENT[state];
  const shadow = orbShadow(state, accent);
  const gif = state === "listening" ? "/naxie/naxie-mascot.gif" : (state === "thinking" || state === "speaking") ? "/naxie/naxie-waveform.gif" : null;

  if (size === "sm") {
    return gif ? (
      <img src={gif} alt="" className="w-full h-full object-contain rounded-full" />
    ) : (
      <div className={`w-full h-full rounded-full border-2 ${color}`} style={{ boxShadow: shadow }} />
    );
  }

  return (
    <div className={`relative w-48 h-48 grid place-items-center ${STATE_CLASS[state]}`}>
      <div className={`nw-orb-ring-a absolute inset-0 rounded-full border-2 ${color} ${state !== "idle" ? "opacity-40" : ""}`} />
      <div className={`nw-orb-ring-b absolute inset-6 rounded-full border ${color} opacity-70`} />
      {gif && (
        <img
          src={gif}
          alt={state === "speaking" ? "Voice/agent waveform" : ""}
          aria-hidden={state !== "speaking"}
          className="absolute inset-0 w-full h-full object-contain rounded-full"
        />
      )}
      <div
        className={`nw-orb-glow ${state !== "idle" ? "is-active" : ""} absolute inset-12 rounded-full bg-gradient-to-br from-violet-500/30 to-transparent border ${color}`}
        style={{ boxShadow: shadow }}
      />
    </div>
  );
}
