import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

// The vault as a living node graph — Obsidian's Graph View, reimplemented as
// a small self-contained force simulation on <canvas> (no d3/three — the
// vault is a few hundred notes at most, so a plain all-pairs repulsion +
// spring-link loop is more than fast enough and keeps this dependency-free).
// Notes are dots colored by their top-level vault folder; tags are slightly
// larger accent-colored hub nodes. A gentle centering force keeps everything
// clustered like a "brain" instead of drifting off-canvas.

type GraphNode = { id: string; label: string; group: string; kind: "note" | "tag" };
type GraphLink = { source: string; target: string };
type SimNode = GraphNode & { x: number; y: number; vx: number; vy: number };
type SimLink = { a: SimNode; b: SimNode };

// Simulation cost is O(n^2) per frame — plenty for a personal vault, but cap
// it so an unexpectedly huge vault degrades to "partial graph" instead of a
// frozen tab.
const MAX_SIM_NODES = 900;

function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 58%, 64%)`;
}

export function KnowledgeGraph() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  // Simulation lives in refs, not state — the rAF loop mutates positions
  // every frame and re-rendering React for that would be far too slow.
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const groupColorRef = useRef<Map<string, string>>(new Map());
  const hoverRef = useRef<SimNode | null>(null);
  const draggingRef = useRef<SimNode | null>(null);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    api.brainGraph().then(g => {
      if (!alive) return;
      const raw = g.nodes.slice(0, MAX_SIM_NODES);
      const allowed = new Set(raw.map(n => n.id));
      const spread = Math.max(160, Math.sqrt(raw.length) * 24);
      const nodes: SimNode[] = raw.map(n => {
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * spread;
        return { ...n, x: Math.cos(angle) * r, y: Math.sin(angle) * r, vx: 0, vy: 0 };
      });
      const byId = new Map(nodes.map(n => [n.id, n]));
      const links: SimLink[] = [];
      for (const l of g.links) {
        if (!allowed.has(l.source) || !allowed.has(l.target)) continue;
        const a = byId.get(l.source), b = byId.get(l.target);
        if (a && b) links.push({ a, b });
      }
      nodesRef.current = nodes;
      linksRef.current = links;
      setCount(nodes.length);
      setLoading(false);
    }).catch(e => { if (alive) { setError(e?.message ?? String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let width = 0, height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    function resize() {
      width = container!.clientWidth;
      height = container!.clientHeight;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Center the transform once so the simulation's origin-centered
      // coordinates land in the middle of the canvas on first paint.
      if (transformRef.current.x === 0 && transformRef.current.y === 0) {
        transformRef.current.x = width / 2;
        transformRef.current.y = height / 2;
      }
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    function step() {
      const nodes = nodesRef.current;
      const links = linksRef.current;
      const n = nodes.length;
      if (n > 0) {
        for (let i = 0; i < n; i++) {
          const ni = nodes[i];
          for (let j = i + 1; j < n; j++) {
            const nj = nodes[j];
            let dx = ni.x - nj.x, dy = ni.y - nj.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) d2 = 1;
            const force = 1400 / d2;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * force, fy = (dy / d) * force;
            if (draggingRef.current !== ni) { ni.vx += fx; ni.vy += fy; }
            if (draggingRef.current !== nj) { nj.vx -= fx; nj.vy -= fy; }
          }
          // Gentle pull to center — keeps the cluster in frame like a brain
          // instead of the graph drifting or flying apart.
          if (draggingRef.current !== ni) {
            ni.vx += -ni.x * 0.0012;
            ni.vy += -ni.y * 0.0012;
          }
        }
        for (const l of links) {
          const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
          const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const restLength = l.a.kind === "tag" || l.b.kind === "tag" ? 85 : 46;
          const f = (d - restLength) * 0.02;
          const fx = (dx / d) * f, fy = (dy / d) * f;
          if (draggingRef.current !== l.a) { l.a.vx += fx; l.a.vy += fy; }
          if (draggingRef.current !== l.b) { l.b.vx -= fx; l.b.vy -= fy; }
        }
        for (const node of nodes) {
          if (draggingRef.current === node) continue;
          node.vx *= 0.82; node.vy *= 0.82;
          node.x += node.vx; node.y += node.vy;
        }
      }

      ctx!.clearRect(0, 0, width, height);
      const t = transformRef.current;
      ctx!.save();
      ctx!.translate(t.x, t.y);
      ctx!.scale(t.scale, t.scale);

      ctx!.strokeStyle = "rgba(216,236,248,0.09)";
      ctx!.lineWidth = 1 / t.scale;
      for (const l of links) {
        ctx!.beginPath();
        ctx!.moveTo(l.a.x, l.a.y);
        ctx!.lineTo(l.b.x, l.b.y);
        ctx!.stroke();
      }

      const groupColors = groupColorRef.current;
      const hovered = hoverRef.current;
      for (const node of nodes) {
        if (!groupColors.has(node.group)) groupColors.set(node.group, hashColor(node.group));
        const isTag = node.kind === "tag";
        const isHover = hovered === node;
        const radius = (isTag ? 5 : 3) * (isHover ? 1.7 : 1);
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx!.fillStyle = isTag ? "rgba(255,166,130,0.92)" : groupColors.get(node.group)!;
        ctx!.fill();
        if (isTag || isHover) {
          ctx!.font = `${isTag ? 11 : 12}px ui-sans-serif, system-ui, sans-serif`;
          ctx!.fillStyle = isHover ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.55)";
          ctx!.fillText(node.label, node.x + radius + 4, node.y + 4);
        }
      }
      ctx!.restore();
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);

    function toWorld(clientX: number, clientY: number) {
      const rect = canvas!.getBoundingClientRect();
      const t = transformRef.current;
      return { x: (clientX - rect.left - t.x) / t.scale, y: (clientY - rect.top - t.y) / t.scale };
    }
    function findNodeAt(x: number, y: number): SimNode | null {
      const nodes = nodesRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        const r = node.kind === "tag" ? 9 : 7;
        if ((node.x - x) ** 2 + (node.y - y) ** 2 <= r * r) return node;
      }
      return null;
    }

    function onPointerDown(e: PointerEvent) {
      movedRef.current = false;
      const p = toWorld(e.clientX, e.clientY);
      const hit = findNodeAt(p.x, p.y);
      if (hit) draggingRef.current = hit;
      else panRef.current = { startX: e.clientX, startY: e.clientY, ox: transformRef.current.x, oy: transformRef.current.y };
      canvas!.setPointerCapture(e.pointerId);
    }
    function onPointerMove(e: PointerEvent) {
      movedRef.current = true;
      const p = toWorld(e.clientX, e.clientY);
      if (draggingRef.current) {
        draggingRef.current.x = p.x;
        draggingRef.current.y = p.y;
        draggingRef.current.vx = 0;
        draggingRef.current.vy = 0;
      } else if (panRef.current) {
        const ps = panRef.current;
        transformRef.current.x = ps.ox + (e.clientX - ps.startX);
        transformRef.current.y = ps.oy + (e.clientY - ps.startY);
      } else {
        hoverRef.current = findNodeAt(p.x, p.y);
        canvas!.style.cursor = hoverRef.current ? "pointer" : "grab";
      }
    }
    function onPointerUp(e: PointerEvent) {
      draggingRef.current = null;
      panRef.current = null;
      try { canvas!.releasePointerCapture(e.pointerId); } catch { /* tolerate */ }
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const t = transformRef.current;
      const rect = canvas!.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const newScale = Math.min(Math.max(t.scale * factor, 0.2), 4);
      t.x = mx - ((mx - t.x) / t.scale) * newScale;
      t.y = my - ((my - t.y) / t.scale) * newScale;
      t.scale = newScale;
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[320px] rounded-2xl border border-ink-800 bg-ink-950/40 overflow-hidden">
      {loading && <div className="absolute inset-0 grid place-items-center text-xs text-cream-300/50">Mapping the vault…</div>}
      {error && <div className="absolute inset-0 grid place-items-center text-xs text-coral-400 px-6 text-center">{error}</div>}
      {!loading && !error && count === 0 && (
        <div className="absolute inset-0 grid place-items-center text-xs text-cream-300/50">Vault is empty — nothing to map yet.</div>
      )}
      <canvas ref={canvasRef} className="block w-full h-full" />
      {!loading && !error && count > 0 && (
        <div className="absolute bottom-2 right-3 text-[10px] text-cream-300/40 pointer-events-none">
          {count} notes · drag to rearrange · scroll to zoom
        </div>
      )}
    </div>
  );
}
