import type { CSSProperties, ReactNode } from "react";

// Noise Background (adapted from the Aceternity component) — wraps children in
// a container with a slowly-panning multi-colour gradient plus a fine grain
// overlay behind them. The Aceternity source animates the gradient with
// framer-motion; this app has no framer-motion dependency, so the pan rides a
// CSS keyframe (see `.noise-bg-*` in index.css) instead — same read, no new
// package. Used to give primary buttons a living, textured backdrop.

const DEFAULT_COLORS = ["#663af3", "#3fb3a0", "#ff7657"]; // Electric Iris / Cipher Mint / Coral

// A tiny fractal-noise tile as a data URI, tinted white and laid over the
// gradient at low opacity to give it grain. Inlined so the component is
// self-contained (no asset request, works inside the CSP'd shell too).
const NOISE_DATA_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";

export function NoiseBackground({
  children,
  containerClassName = "",
  className = "",
  gradientColors = DEFAULT_COLORS,
}: {
  children: ReactNode;
  containerClassName?: string;
  className?: string;
  gradientColors?: string[];
}) {
  const colors = gradientColors.length >= 2 ? gradientColors : DEFAULT_COLORS;
  // Repeat the first colour at the end so the panning gradient loops seamlessly.
  const stops = [...colors, colors[0]].join(", ");
  const gradientStyle: CSSProperties = {
    backgroundImage: `linear-gradient(115deg, ${stops})`,
    backgroundSize: "300% 300%",
  };

  return (
    <div className={`relative isolate overflow-hidden ${containerClassName}`}>
      {/* panning gradient */}
      <span aria-hidden className="noise-bg-pan absolute inset-0 -z-10" style={gradientStyle} />
      {/* grain overlay */}
      <span
        aria-hidden
        className="absolute inset-0 -z-10 opacity-[0.18] mix-blend-overlay"
        style={{ backgroundImage: NOISE_DATA_URI, backgroundSize: "120px 120px" }}
      />
      <div className={`relative ${className}`}>{children}</div>
    </div>
  );
}

// Drop-in primary button riding a NoiseBackground: a thin animated gradient
// ring wraps the button so the grain/gradient reads as a living backdrop
// without swallowing the label. Same props surface as a normal <button>.
export function NoiseButton({
  children,
  className = "",
  wrapClassName = "",
  gradientColors,
  type = "button",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  wrapClassName?: string;
  gradientColors?: string[];
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <NoiseBackground
      containerClassName={`inline-block rounded-lg p-[1.5px] ${wrapClassName}`}
      gradientColors={gradientColors}
    >
      <button
        type={type}
        className={`w-full rounded-[6.5px] transition-transform duration-100 active:scale-[0.98] ${className}`}
        {...rest}
      >
        {children}
      </button>
    </NoiseBackground>
  );
}
