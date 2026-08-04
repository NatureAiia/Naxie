/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    screens: {
      // tablet breakpoint, ported from neuroworks for components that share
      // its compact/tablet layout logic.
      tablet: '820px',
    },
    extend: {
      colors: {
        // ink/cream/flame/coral/violet/leaf — ported from neuroworks so its
        // components (Card, CommandPalette, etc.) resolve unchanged. Values
        // live as CSS vars in globals.css (dark palette only — this app has
        // no light/dark toggle yet).
        ink: {
          950: 'var(--c-ink-950)',
          900: 'var(--c-ink-900)',
          850: 'var(--c-ink-850)',
          800: 'var(--c-ink-800)',
          700: 'var(--c-ink-700)',
          600: 'var(--c-ink-600)',
        },
        cream: {
          50: 'var(--c-cream-50)',
          100: 'var(--c-cream-100)',
          200: 'var(--c-cream-200)',
          300: 'var(--c-cream-300)',
        },
        flame: { 400: 'var(--c-flame-400)', 500: 'var(--c-flame-500)', 600: 'var(--c-flame-600)' },
        coral: { 400: 'var(--c-coral-400)', 500: 'var(--c-coral-500)', 600: 'var(--c-coral-600)' },
        violet: { 400: 'var(--c-violet-400)', 500: 'var(--c-violet-500)', 600: 'var(--c-violet-600)' },
        leaf: { 400: 'var(--c-leaf-400)', 500: 'var(--c-leaf-500)' },
        // Brand palette - Electric Sapphire
        primary: {
          DEFAULT: '#00A3FF',
          50: '#E6F6FF',
          100: '#CCEDFF',
          400: '#33BAFF',
          500: '#00A3FF',
          600: '#0082CC',
          700: '#006199',
          900: '#004166',
        },
        accent: {
          DEFAULT: '#22D3EE',
          400: '#67E8F9',
          500: '#22D3EE',
        },
        success: '#10B981',
        warning: '#F59E0B',
        danger: '#EF4444',
        // Dark surface palette - Obsidian
        surface: {
          DEFAULT: '#080B12',
          50: '#0F172A',
          100: '#151D31',
          200: '#1E293B',
          300: '#334155',
          400: '#475569',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
        // ported from neuroworks for PixelDriftText/DynamicWeightText/WeightHoverText
        display: ["'Playfair Display'", 'Georgia', 'serif'],
        jakarta: ["'Plus Jakarta Sans'", 'system-ui', 'sans-serif'],
      },
      transitionTimingFunction: {
        settle: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-agent': 'linear-gradient(135deg, #00A3FF 0%, #22D3EE 100%)',
        'gradient-dark': 'linear-gradient(135deg, #080B12 0%, #0F172A 100%)',
        'glass': 'linear-gradient(135deg, rgba(15,23,42,0.6) 0%, rgba(15,23,42,0.2) 100%)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-up': 'slideUp 0.4s ease-out',
        'fade-in': 'fadeIn 0.3s ease-out',
        'glow': 'glow 2s ease-in-out infinite alternate',
        'thinking': 'thinking 1.5s ease-in-out infinite',
        'fade-up': 'fade-up 0.7s cubic-bezier(0.32,0.72,0,1) both',
      },
      keyframes: {
        slideUp: {
          '0%': { transform: 'translateY(20px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        glow: {
          '0%': { boxShadow: '0 0 20px rgba(0, 163, 255, 0.3)' },
          '100%': { boxShadow: '0 0 40px rgba(0, 163, 255, 0.6)' },
        },
        thinking: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(14px)', filter: 'blur(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)', filter: 'blur(0)' },
        },
        'mesh-drift': {
          '0%, 100%': { transform: 'translate3d(0,0,0) scale(1)' },
          '50%': { transform: 'translate3d(2%, -1.5%, 0) scale(1.08)' },
        },
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
}
