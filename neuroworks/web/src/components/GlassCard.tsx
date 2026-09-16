"use client";
/**
 * Glassmorphism card — Kuwana tech + Naxion Obsidian & Neon tokens.
 * Use for analytics, chat bubbles, knowledge packs. Backdrop-blur + inset hairline + glow.
 */
import type { ReactNode } from "react";

export function GlassCard({ children, className = "", glow = false, hover = false }: { children: ReactNode; className?: string; glow?: boolean; hover?: boolean }) {
  return (
    <div
      className={`relative rounded-2xl border bg-ink-850/60 backdrop-blur-xl ${hover ? "transition-all hover:bg-ink-800/70 hover:shadow-lg hover:-translate-y-0.5" : ""} ${className}`}
      style={{
        borderColor: "rgba(255,255,255,0.06)",
        boxShadow: glow ? "inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 32px rgba(0,0,0,0.3), 0 0 24px var(--bg-glow, rgba(97,175,239,0.1))" : "inset 0 1px 0 rgba(255,255,255,0.05), 0 4px 24px rgba(0,0,0,0.2)",
      }}
    >
      {children}
    </div>
  );
}

export function GlassSkeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-xl bg-ink-800/50 ${className}`} style={{ background: "linear-gradient(45deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.03) 75%)", backgroundSize: "200% 100%" }} />
  );
}
