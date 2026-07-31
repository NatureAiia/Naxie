import { useRef, useState } from "react";

// Direction Hover (adapted from the Originkit Framer component) — the label
// swaps to an accent copy that slides in from whichever edge (top/bottom) the
// cursor entered, and slides back on leave. Three stacked copies
// [accent, base, accent]; rest shows the middle, hover shifts the stack one
// step toward the entered edge. Pure CSS transition — no framer-motion.

export function DirectionHover({ text, className = "", accentClassName = "text-violet-400", heightEm = 1.05, gapPx = 6 }: {
  text: string;
  className?: string;
  accentClassName?: string;
  heightEm?: number;   // visible line box, in em of the inherited font size
  gapPx?: number;      // spacing between stacked copies
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [dir, setDir] = useState<"none" | "top" | "bottom">("none");

  const onEnter = (e: React.MouseEvent) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setDir(e.clientY - rect.top < rect.height / 2 ? "top" : "bottom");
  };

  // Offsets are computed in CSS: one step = line box + gap.
  const step = `calc(${heightEm}em + ${gapPx}px)`;
  const y = dir === "none" ? `calc(-1 * ${step})` : dir === "top" ? "0px" : `calc(-2 * ${step})`;

  const line: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    height: `${heightEm}em`,
    lineHeight: 1,
    whiteSpace: "pre",
    overflow: "hidden",
  };

  return (
    <span
      ref={ref}
      onMouseEnter={onEnter}
      onMouseLeave={() => setDir("none")}
      className={className}
      style={{ position: "relative", display: "inline-block", overflow: "hidden", height: `${heightEm}em`, cursor: "default", userSelect: "none", verticalAlign: "bottom" }}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: gapPx, transform: `translateY(${y})`, transition: "transform 0.3s ease-in-out" }}>
        <span className={accentClassName} style={line}>{text}</span>
        <span style={line}>{text}</span>
        <span className={accentClassName} style={line}>{text}</span>
      </span>
    </span>
  );
}
