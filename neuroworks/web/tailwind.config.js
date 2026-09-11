/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Under theme.extend so Tailwind's default sm/md/lg/xl/2xl breakpoints
      // stay available — `tablet` used to live under bare `theme.screens`,
      // which replaces the defaults outright and silently broke every
      // sm:/md:/lg:/xl: class in the app (they were valid classNames but
      // matched no generated variant, so they never applied).
      screens: {
        tablet: "820px",
      },
      // Each token is a CSS var so light mode can override at the :root[data-theme="light"]
      // level without rewriting every className across 17 components in one go. Existing
      // bg-ink-900 / text-cream-100 etc. keep working — they just resolve to different
      // hex codes in light mode.
      colors: {
        ink: {
          950: "var(--c-ink-950)",
          900: "var(--c-ink-900)",
          850: "var(--c-ink-850)",
          800: "var(--c-ink-800)",
          700: "var(--c-ink-700)",
          600: "var(--c-ink-600)",
        },
        cream: {
          50:  "var(--c-cream-50)",
          100: "var(--c-cream-100)",
          200: "var(--c-cream-200)",
          300: "var(--c-cream-300)",
        },
        // Accent tokens as CSS vars (see index.css) so dark mode can carry
        // Atom One Dark's syntax palette while light mode keeps the original
        // Midnight-blueprint accents unchanged.
        flame: { 400: "var(--c-flame-400)", 500: "var(--c-flame-500)", 600: "var(--c-flame-600)" },
        coral: { 400: "var(--c-coral-400)", 500: "var(--c-coral-500)", 600: "var(--c-coral-600)" },
        violet: { 400: "var(--c-violet-400)", 500: "var(--c-violet-500)", 600: "var(--c-violet-600)" },
        leaf: { 400: "var(--c-leaf-400)", 500: "var(--c-leaf-500)" },
      },
      fontFamily: {
        // Display face = Playfair Display (2026-07-13) — a transitional serif
        // for a sleeker, editorial/luxury feel on headings. Body copy stays
        // Inter; monospace stays JetBrains Mono (code, tabular data).
        display: ["'Playfair Display'", "Georgia", "serif"],
        // Plus Jakarta Sans kept as a named family for the two components that
        // animate its variable weight (DynamicWeightText, WeightHoverText) and
        // the particle wordmark (PixelDriftText) — a serif's thin strokes
        // sample poorly into particles, so those stay on the sans variable face.
        jakarta: ["'Plus Jakarta Sans'", "system-ui", "sans-serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
      // Heavy, real-world-mass easing for the Editorial Evolution motion language.
      transitionTimingFunction: {
        settle: "cubic-bezier(0.32, 0.72, 0, 1)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(14px)", filter: "blur(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)", filter: "blur(0)" },
        },
        "mesh-drift": {
          "0%, 100%": { transform: "translate3d(0,0,0) scale(1)" },
          "50%": { transform: "translate3d(2%, -1.5%, 0) scale(1.08)" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.7s cubic-bezier(0.32,0.72,0,1) both",
      },
    },
  },
  plugins: [],
};
