// Block-bar mic level meter — a cheap, distinctive alternative to a
// waveform/orb for showing "is it actually hearing me". Center bars react
// first, like a compact EQ, rather than filling left-to-right.
export function MicLevelMeter({ level, bars = 5, size = "md" }: { level: number; bars?: number; size?: "sm" | "md" }) {
  const barW = size === "sm" ? 3 : 4;
  const gap = size === "sm" ? 2 : 3;
  const maxH = size === "sm" ? 14 : 22;
  const minH = 3;
  const mid = (bars - 1) / 2 || 1;
  return (
    <div className="flex items-end" style={{ height: maxH, gap }} aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => {
        const dist = Math.abs(i - mid) / mid;
        const local = Math.max(0, Math.min(1, level * (1.15 - dist * 0.5)));
        const h = minH + local * (maxH - minH);
        return (
          <span
            key={i}
            className="rounded-sm bg-coral-400 transition-[height] duration-75"
            style={{ width: barW, height: h, opacity: 0.35 + local * 0.65 }}
          />
        );
      })}
    </div>
  );
}
