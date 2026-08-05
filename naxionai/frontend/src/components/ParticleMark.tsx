'use client'

import { useEffect, useRef } from "react";

// Particle brand mark (SVG Particle effect, Originkit-style) — renders the
// BrandMark SVG into an offscreen canvas, samples its opaque pixels into
// particles (keeping each pixel's own color), then floats them with a gentle
// idle drift and cursor repulsion; they spring home when the cursor leaves.
// The pasted Framer source arrived truncated, so this is a compact
// reimplementation of the same effect: sample → home positions → repulsion.

const BRAND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="y" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#f6a623"/><stop offset="100%" stop-color="#e9911a"/></linearGradient>
    <linearGradient id="v" x1="1" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#9d6bff"/><stop offset="100%" stop-color="#6438c9"/></linearGradient>
    <linearGradient id="c" x1="0.5" y1="1" x2="0.5" y2="0"><stop offset="0%" stop-color="#ee5a3c"/><stop offset="100%" stop-color="#ff7657"/></linearGradient>
  </defs>
  <circle cx="32" cy="11" r="7" fill="#15140f" stroke="#cdc6b4" stroke-width="1.5"/>
  <path d="M32 22 L8 56 L32 44 Z" fill="url(#y)"/>
  <path d="M32 22 L56 56 L32 44 Z" fill="url(#v)"/>
  <path d="M8 56 L56 56 L32 44 Z" fill="url(#c)"/>
</svg>`;

type P = { x: number; y: number; vx: number; vy: number; hx: number; hy: number; r: number; g: number; b: number; a: number };

export function ParticleMark({ size = 56, gap = 2 }: { size?: number; gap?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: -9999, y: -9999 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = size, H = size;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    let particles: P[] = [];
    let raf = 0;
    let alive = true;

    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      const off = document.createElement("canvas");
      off.width = W; off.height = H;
      const oc = off.getContext("2d");
      if (!oc) return;
      oc.drawImage(img, 0, 0, W, H);
      let px: ImageData;
      try { px = oc.getImageData(0, 0, W, H); } catch { return; }
      const d = px.data;
      for (let y = 0; y < H; y += gap) {
        for (let x = 0; x < W; x += gap) {
          const i = (y * W + x) * 4;
          if (d[i + 3] < 30) continue;
          particles.push({
            x: x + (Math.random() - 0.5) * 20, y: y + (Math.random() - 0.5) * 20,
            vx: 0, vy: 0, hx: x, hy: y,
            r: d[i], g: d[i + 1], b: d[i + 2], a: d[i + 3] / 255,
          });
        }
      }
      const tick = () => {
        if (!alive) return;
        raf = requestAnimationFrame(tick);
        ctx.clearRect(0, 0, W, H);
        const { x: mx, y: my } = mouse.current;
        for (const p of particles) {
          // Spring home + cursor repulsion inside an 18px radius.
          const dx = p.x - mx, dy = p.y - my;
          const distSq = dx * dx + dy * dy;
          if (distSq < 18 * 18 && distSq > 0.01) {
            const dist = Math.sqrt(distSq);
            const push = (1 - dist / 18) * 1.6;
            p.vx += (dx / dist) * push;
            p.vy += (dy / dist) * push;
          }
          p.vx += (p.hx - p.x) * 0.06;
          p.vy += (p.hy - p.y) * 0.06;
          p.vx *= 0.82; p.vy *= 0.82;
          p.x += p.vx; p.y += p.vy;
          ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${p.a})`;
          ctx.fillRect(p.x, p.y, 1.6, 1.6);
        }
      };
      tick();
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(BRAND_SVG)}`;

    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [size, gap]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: "block" }}
      aria-label="NaxionAI"
      onPointerMove={e => {
        const rect = e.currentTarget.getBoundingClientRect();
        mouse.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }}
      onPointerLeave={() => { mouse.current = { x: -9999, y: -9999 }; }}
    />
  );
}
