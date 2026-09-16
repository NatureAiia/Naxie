"use client";
/**
 * Kuwana SignalBloom → Naxion glass variant.
 * Segmented radial arc meter (value score / XP / AI confidence).
 * Glassmorphism: uses --c-ink / --c-flame tokens + backdrop-blur-ready container.
 */
type SignalBloomProps = {
  value: number; // 0-100
  size?: number;
  color?: "sky" | "teal" | "flame";
  segments?: number;
  strokeWidth?: number;
  label?: string;
  sublabel?: string;
};

export function SignalBloom({ value, size = 72, color = "sky", segments = 12, strokeWidth = 6, label, sublabel }: SignalBloomProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = size / 2 - strokeWidth;
  const circumference = 2 * Math.PI * radius;
  const gap = circumference / segments / 3;
  const dash = circumference / segments - gap;
  const filled = Math.round((clamped / 100) * segments);
  const accent = color === "teal" ? "var(--c-coral-400, #d19a66)" : color === "flame" ? "var(--c-flame-400, #e06c75)" : "var(--c-ink-600, #3c4049)";
  // glass ring uses hairline + glow
  return (
    <div role="img" aria-label={`${label ?? "Score"}: ${Math.round(clamped)}${sublabel ? ` (${sublabel})` : ""}`} className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      {/* glass halo */}
      <div className="absolute inset-0 rounded-full" style={{ background: "rgba(255,255,255,0.02)", backdropFilter: "blur(6px)", border: "1px solid rgba(255,255,255,0.06)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05), 0 4px 24px rgba(0,0,0,0.2)" }} />
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90 relative">
        {Array.from({ length: segments }).map((_, i) => {
          const rotation = (360 / segments) * i;
          return (
            <circle key={i} cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={i < filled ? accent : "rgba(255,255,255,0.08)"} strokeWidth={strokeWidth} strokeDasharray={`${dash} ${circumference - dash}`} strokeLinecap="round" transform={`rotate(${rotation} ${size / 2} ${size / 2})`} style={{ transition: "stroke 300ms ease-out" }} />
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono font-semibold text-cream-50" style={{ fontSize: size * 0.24 }}>{Math.round(clamped)}</span>
        {sublabel ? <span className="text-[9px] tracking-widest text-cream-300 uppercase">{sublabel}</span> : null}
      </div>
    </div>
  );
}
