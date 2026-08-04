'use client'

import { useState } from "react";

// Text Lift (adapted from the Originkit Framer component) — each letter is a
// stack of copies pushed toward one direction; hovering a letter expands its
// stack so it lifts off the surface. The Framer source animates with
// framer-motion springs; this app has no framer-motion dependency, so the
// per-layer offsets ride a CSS transition with an overshoot bezier instead —
// same read, no new package.

const DIRS = {
  topLeft: { x: -0.72, y: -0.72 },
  top: { x: 0, y: -1 },
  topRight: { x: 0.72, y: -0.72 },
  bottomLeft: { x: -0.72, y: 0.72 },
  bottom: { x: 0, y: 1 },
  bottomRight: { x: 0.72, y: 0.72 },
} as const;
type Dir = keyof typeof DIRS;

function Letter({ char, depth, spread, expand, dir, fade }: {
  char: string; depth: number; spread: number; expand: number;
  dir: { x: number; y: number }; fade: boolean;
}) {
  const [hover, setHover] = useState(false);
  const space = char === " ";
  return (
    <span style={{ position: "relative", display: "inline-block", whiteSpace: "pre", zIndex: hover ? 1000 : "auto" }}>
      {/* In-flow spacer defines the footprint + owns the hover hit-area. */}
      <span
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        aria-hidden
        style={{ display: "inline-block", color: "transparent" }}
      >
        {space ? " " : char}
      </span>
      {Array.from({ length: depth }).map((_, i) => {
        const isTop = i === depth - 1;
        const s = hover ? i * expand : i * spread;
        return (
          <span
            key={i}
            aria-hidden={!isTop}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              pointerEvents: "none",
              transform: `translate(${s * dir.x}px, ${s * dir.y}px)`,
              transition: "transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)",
              opacity: fade ? Math.max(0.2, 1 - ((depth - 1 - i) / depth) * 0.85) : 1,
              zIndex: i + 1,
              display: "inline-block",
              willChange: "transform",
              color: "inherit",
            }}
          >
            {space ? " " : char}
          </span>
        );
      })}
    </span>
  );
}

export function TextLift({ text, depth = 6, spread = 0, expand = 3, direction = "bottomRight", fade = true, className = "" }: {
  text: string;
  depth?: number;
  spread?: number;
  expand?: number;
  direction?: Dir;
  fade?: boolean;
  className?: string;
}) {
  const dir = DIRS[direction] ?? DIRS.bottomRight;
  return (
    <span className={className} style={{ display: "inline-flex", flexWrap: "wrap", maxWidth: "100%" }}>
      {text.split("").map((c, i) => (
        <Letter key={i} char={c} depth={Math.max(1, Math.round(depth))} spread={spread} expand={expand} dir={dir} fade={fade} />
      ))}
    </span>
  );
}
