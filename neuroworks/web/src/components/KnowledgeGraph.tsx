import { useEffect, useRef, useState } from "react";
import { api, type WorkMode } from "../lib/api";

// Naxie as a living system map: a glowing brain at the center, with four
// "legs" (limbs) reaching out to the four kinds of things Naxie is made of —
// Knowledge (the vault), Agents/Neuros (hired personas), Storage (the 5
// storage backends), and Integrations (connectors + third-party
// integrations). Each leg ends in its own live force-simulated cluster of
// nodes, all sharing one canvas/physics loop (no d3/three — a plain
// all-pairs repulsion + spring loop is fast enough at these sizes and keeps
// this dependency-free).

type LegId = "knowledge" | "agents" | "storage" | "integrations";
// "file-item" = a vault file revealed under a storage backend (Local/
// Obsidian/GitHub all mirror the same vault, so expanding any of them lists
// the same files). "placeholder" = a backend with nothing to show yet
// (Drive/Supabase — not configured / no pipeline built).
// "department" = a hub node grouping personas in the Agents leg by their
// real department (api.getWorkforce()) — personas are its children via
// parentId, same mechanism storage uses for expanded files.
type NodeKind = "note" | "tag" | "persona" | "storage" | "connector" | "file-item" | "placeholder" | "department";
type GraphNode = {
  id: string; label: string; group: string; kind: NodeKind; leg: LegId; status?: "ok" | "warn" | "off";
  // Set on nodes revealed by expanding a storage backend, or on personas
  // under a department hub — pulled toward that parent's live position
  // instead of the leg anchor.
  parentId?: string;
  // Link count — computed once the graph is built. Hub notes/tags (heavily
  // wikilinked/tagged) render larger, same visual language as a force-graph
  // where degree signals importance.
  degree?: number;
  // Autonomy tier — only set on persona nodes (defaults to "agent").
  workMode?: WorkMode;
};
type GraphLink = { source: string; target: string };
type SimNode = GraphNode & { x: number; y: number; vx: number; vy: number };
type SimLink = { a: SimNode; b: SimNode };
type VaultFileRef = { id: string; label: string; group: string };

// How many files reveal when a storage backend is expanded — local/GitHub/
// Obsidian all mirror the same vault, which can run into the hundreds.
const MAX_EXPANDED_FILES = 150;

// Simulation cost is O(n^2) per frame — plenty for a personal instance, but
// cap the knowledge leg (the one that can genuinely grow large) so an
// unexpectedly huge vault degrades to "partial graph" instead of a frozen tab.
const MAX_KNOWLEDGE_NODES = 900;

const LEGS: Record<LegId, { label: string; color: string; angle: number }> = {
  knowledge: { label: "Knowledge", color: "hsl(200, 75%, 62%)", angle: -Math.PI / 2 },
  agents: { label: "Agents / Neuros", color: "hsl(280, 65%, 70%)", angle: 0 },
  storage: { label: "Storage", color: "hsl(150, 55%, 55%)", angle: Math.PI / 2 },
  integrations: { label: "Integrations", color: "hsl(35, 85%, 62%)", angle: Math.PI },
};
const LEG_ORDER: LegId[] = ["knowledge", "agents", "storage", "integrations"];

function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 58%, 64%)`;
}

export function KnowledgeGraph({ focusId }: { focusId?: string | null }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  // Vault note Naxie's last answer drew from — highlighted + panned to, the
  // same "answer highlights its source" pattern as jarvis-claude-code's
  // setFocus(), except riding on the RAG scoring already computed server-side.
  const focusIdRef = useRef<string | null | undefined>(focusId);
  const focusPannedRef = useRef<string | null | undefined>(null);
  useEffect(() => { focusIdRef.current = focusId; }, [focusId]);

  // Simulation lives in refs, not state — the rAF loop mutates positions
  // every frame and re-rendering React for that would be far too slow.
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const groupColorRef = useRef<Map<string, string>>(new Map());
  const legAnchorRef = useRef<Record<LegId, { x: number; y: number }>>({
    knowledge: { x: 0, y: 0 }, agents: { x: 0, y: 0 }, storage: { x: 0, y: 0 }, integrations: { x: 0, y: 0 },
  });
  const hoverRef = useRef<SimNode | null>(null);
  const draggingRef = useRef<SimNode | null>(null);
  const transformRef = useRef({ x: 0, y: 0, scale: 1 });
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);
  const movedRef = useRef(false);
  const clickStartRef = useRef<{ x: number; y: number } | null>(null);
  // The vault's files (note-kind knowledge nodes only, no tags) — reused to
  // populate a storage backend's expansion instead of a second fetch, since
  // Local/Obsidian/GitHub all mirror this same file set.
  const vaultFilesRef = useRef<VaultFileRef[]>([]);
  const expandedStorageRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;

    // Each leg's data comes from an independent endpoint — fetch them all in
    // parallel and let each fail/succeed on its own, so (say) the vault being
    // unreachable doesn't blank out the agents or storage legs.
    Promise.allSettled([
      api.brainGraph(),
      api.getWorkforce(),
      api.storageStatus(),
      api.listConnectors(),
      api.listIntegrations(),
    ]).then(([graphR, workforceR, storageR, connectorsR, integrationsR]) => {
      if (!alive) return;

      const nodes: GraphNode[] = [];
      const rawLinks: GraphLink[] = [];

      if (graphR.status === "fulfilled") {
        const g = graphR.value;
        const capped = g.nodes.slice(0, MAX_KNOWLEDGE_NODES);
        const allowed = new Set(capped.map(n => n.id));
        for (const n of capped) nodes.push({ id: n.id, label: n.label, group: n.group, kind: n.kind, leg: "knowledge" });
        for (const l of g.links) if (allowed.has(l.source) && allowed.has(l.target)) rawLinks.push(l);
        vaultFilesRef.current = g.nodes.filter(n => n.kind === "note").map(n => ({ id: n.id, label: n.label, group: n.group }));
      } else {
        setError(prev => prev ?? "Knowledge vault unreachable — showing the rest of the map.");
      }

      if (workforceR.status === "fulfilled") {
        for (const dept of workforceR.value.departments) {
          if (dept.agents.length === 0) continue;
          const deptSlug = dept.department.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "general";
          const deptId = `dept:${deptSlug}`;
          nodes.push({ id: deptId, label: `${dept.department} · ${dept.agents.length}`, group: dept.department, kind: "department", leg: "agents" });
          for (const p of dept.agents) {
            nodes.push({
              id: `persona:${p.id}`, label: p.name, group: dept.department, kind: "persona", leg: "agents",
              parentId: deptId, workMode: p.workMode ?? "agent",
            });
          }
        }
      }

      if (storageR.status === "fulfilled") {
        for (const b of storageR.value.backends) {
          nodes.push({
            id: `storage:${b.id}`, label: b.label, group: b.id, kind: "storage", leg: "storage",
            status: b.reachable ? "ok" : b.configured ? "warn" : "off",
          });
        }
      }

      if (connectorsR.status === "fulfilled") {
        for (const c of connectorsR.value.connectors) {
          nodes.push({
            id: `connector:${c.id}`, label: c.label, group: "connector", kind: "connector", leg: "integrations",
            status: c.lastTest ? (c.lastTest.ok ? "ok" : "warn") : "off",
          });
        }
      }
      if (integrationsR.status === "fulfilled") {
        for (const c of integrationsR.value.connections) {
          nodes.push({
            id: `integration:${c.id}`, label: c.label || c.providerName, group: "integration", kind: "connector", leg: "integrations",
            status: c.lastTest ? (c.lastTest.ok ? "ok" : "warn") : "off",
          });
        }
      }

      // Seed positions scattered near each node's leg anchor (set below, once
      // the container has a size) so clusters don't have to migrate far from
      // a shared origin on first paint.
      const simNodes: SimNode[] = nodes.map(n => ({ ...n, x: 0, y: 0, vx: 0, vy: 0 }));
      const byId = new Map(simNodes.map(n => [n.id, n]));
      const links: SimLink[] = [];
      for (const l of rawLinks) {
        const a = byId.get(l.source), b = byId.get(l.target);
        if (a && b) links.push({ a, b });
      }
      for (const l of links) {
        l.a.degree = (l.a.degree ?? 0) + 1;
        l.b.degree = (l.b.degree ?? 0) + 1;
      }

      nodesRef.current = simNodes;
      linksRef.current = links;
      setCount(simNodes.length);
      setLoading(false);
    });

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

    // Pre-rendered soft-white radial sprite, reused for every node's glow via
    // drawImage — far cheaper per-frame than a fresh gradient/shadowBlur per
    // node at 900+ nodes. Composited with "lighter" so it reads as a bloom
    // over whatever color the node's sharp core is drawn in afterward.
    const glowSprite = document.createElement("canvas");
    glowSprite.width = 64; glowSprite.height = 64;
    {
      const gctx = glowSprite.getContext("2d")!;
      const g = gctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(255,255,255,0.85)");
      g.addColorStop(0.4, "rgba(255,255,255,0.3)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      gctx.fillStyle = g;
      gctx.beginPath();
      gctx.arc(32, 32, 32, 0, Math.PI * 2);
      gctx.fill();
    }
    // tint (a fillStyle-compatible color) gets layered into the bloom at low
    // alpha so the glow reads as that node's own color, not a generic white
    // halo — cheap (one extra fill, no per-node gradient) but reads far
    // closer to the colorful reference "neural web" glows.
    function drawGlow(x: number, y: number, size: number, alpha: number, tint?: string) {
      ctx!.save();
      ctx!.globalCompositeOperation = "lighter";
      ctx!.globalAlpha = alpha;
      ctx!.drawImage(glowSprite, x - size / 2, y - size / 2, size, size);
      if (tint) {
        ctx!.globalAlpha = alpha * 0.55;
        ctx!.fillStyle = tint;
        ctx!.beginPath();
        ctx!.arc(x, y, size * 0.3, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.restore();
    }

    function computeLegAnchors() {
      // Anchor distance scales gently with total node count so a handful of
      // agents/connectors don't sit awkwardly close to a large note cluster.
      const n = nodesRef.current.length;
      const dist = Math.max(220, Math.min(520, 200 + Math.sqrt(n) * 16));
      for (const leg of LEG_ORDER) {
        const { angle } = LEGS[leg];
        legAnchorRef.current[leg] = { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
      }
      // Scatter any node still sitting at the origin (first paint) out near
      // its own leg anchor instead of the shared (0,0) origin.
      for (const node of nodesRef.current) {
        if (node.x !== 0 || node.y !== 0) continue;
        const anchor = legAnchorRef.current[node.leg];
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 90;
        node.x = anchor.x + Math.cos(a) * r;
        node.y = anchor.y + Math.sin(a) * r;
      }
    }

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
      // Nodes revealed by expanding a storage backend, or personas under a
      // department hub, pull toward that parent's live (moving/draggable)
      // position rather than a fixed leg anchor — built fresh each frame
      // since the parent itself drifts. Hoisted above the n>0 guard so the
      // structural-edge render pass further down can reuse it too.
      const byId = new Map(nodes.map(node => [node.id, node]));
      if (n > 0) {
        computeLegAnchors();
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
          // Gentle pull toward this node's own leg anchor (or, if it was
          // revealed by expanding a backend, toward that backend node's
          // live position) — keeps each cluster together at the end of its
          // own limb instead of one shared blob at the center.
          if (draggingRef.current !== ni) {
            const parent = ni.parentId ? byId.get(ni.parentId) : undefined;
            const anchor = parent ?? legAnchorRef.current[ni.leg];
            ni.vx += (anchor.x - ni.x) * (parent ? 0.02 : 0.006);
            ni.vy += (anchor.y - ni.y) * (parent ? 0.02 : 0.006);
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

      // Fully transparent clear — no painted backdrop here. The real
      // "universe" is GlitterBackground behind the page, showing through
      // this panel's frosted-glass container; painting our own starfield on
      // top would just compete with it.
      ctx!.clearRect(0, 0, width, height);

      const t = transformRef.current;
      ctx!.save();
      ctx!.translate(t.x, t.y);
      ctx!.scale(t.scale, t.scale);

      // Links within a leg's own cluster (currently only the knowledge leg
      // has real edges — wikilinks/shared tags). Additive blending so edges
      // crossing near a hub (a heavily-tagged/linked note) stack up into a
      // brighter glow there, same read as the reference "neural web" graphs.
      ctx!.save();
      ctx!.globalCompositeOperation = "lighter";
      ctx!.strokeStyle = "rgba(160, 200, 255, 0.22)";
      ctx!.lineWidth = 1.1 / t.scale;
      for (const l of links) {
        ctx!.beginPath();
        ctx!.moveTo(l.a.x, l.a.y);
        ctx!.lineTo(l.b.x, l.b.y);
        ctx!.stroke();
      }
      ctx!.restore();

      // Structural edges — a thin line from every node with a parentId to
      // that parent's LIVE position. Covers both existing/new uses:
      // storage's expanded file-items → their backend, and department hubs
      // → their personas.
      ctx!.save();
      ctx!.globalCompositeOperation = "lighter";
      ctx!.strokeStyle = "rgba(255,255,255,0.14)";
      ctx!.lineWidth = 0.8 / t.scale;
      for (const node of nodes) {
        if (!node.parentId) continue;
        const parent = byId.get(node.parentId);
        if (!parent) continue;
        ctx!.beginPath();
        ctx!.moveTo(node.x, node.y);
        ctx!.lineTo(parent.x, parent.y);
        ctx!.stroke();
      }
      ctx!.restore();

      const now = Date.now();

      // Soft nebula haze behind each leg's cluster — a big, faint radial
      // wash in the leg's own color, so each region of the map reads like
      // its own patch of sky rather than nodes floating on flat glass.
      for (const leg of LEG_ORDER) {
        const def = LEGS[leg];
        const anchor = legAnchorRef.current[leg];
        const nebula = ctx!.createRadialGradient(anchor.x, anchor.y, 0, anchor.x, anchor.y, 170);
        nebula.addColorStop(0, def.color.replace("hsl", "hsla").replace(")", ", 0.10)"));
        nebula.addColorStop(1, def.color.replace("hsl", "hsla").replace(")", ", 0)"));
        ctx!.fillStyle = nebula;
        ctx!.fillRect(anchor.x - 170, anchor.y - 170, 340, 340);
      }

      // The four limbs — thick glowing lines from the brain out to each
      // leg's anchor, colored per leg, with the leg's label + node count
      // near the anchor end so the map reads at a glance without a legend.
      const nodesByLeg: Record<LegId, number> = { knowledge: 0, agents: 0, storage: 0, integrations: 0 };
      for (const node of nodes) if (node.kind !== "department") nodesByLeg[node.leg]++;
      for (const leg of LEG_ORDER) {
        const def = LEGS[leg];
        const anchor = legAnchorRef.current[leg];
        const pulse = 0.6 + 0.4 * Math.sin(now / 1100 + def.angle);
        ctx!.save();
        ctx!.strokeStyle = def.color.replace("hsl", "hsla").replace(")", `, ${0.22 + 0.18 * pulse})`);
        ctx!.lineWidth = 5 / t.scale;
        ctx!.lineCap = "round";
        ctx!.shadowBlur = 10;
        ctx!.shadowColor = def.color;
        ctx!.beginPath();
        ctx!.moveTo(0, 0);
        ctx!.lineTo(anchor.x, anchor.y);
        ctx!.stroke();
        ctx!.restore();

        ctx!.font = `600 12px ui-sans-serif, system-ui, sans-serif`;
        ctx!.fillStyle = def.color;
        ctx!.textAlign = "center";
        ctx!.fillText(`${def.label} · ${nodesByLeg[leg]}`, anchor.x, anchor.y - 18);
        ctx!.textAlign = "left";
      }

      // Nodes — colored/sized per kind. Notes stay dots colored by folder
      // (hover-to-label, since a vault can have hundreds). Persona/storage/
      // connector clusters are small enough to always show their label.
      const groupColors = groupColorRef.current;
      const hovered = hoverRef.current;
      const focusedNode = focusIdRef.current ? byId.get(focusIdRef.current) : undefined;
      // Pan the camera to the source note once per new focus, rather than on
      // every frame — the user is still free to pan/zoom away afterward.
      if (focusedNode && focusPannedRef.current !== focusIdRef.current) {
        focusPannedRef.current = focusIdRef.current;
        transformRef.current.x = width / 2 - focusedNode.x * transformRef.current.scale;
        transformRef.current.y = height / 2 - focusedNode.y * transformRef.current.scale;
      }
      for (const node of nodes) {
        const isHover = hovered === node;
        const isFocused = focusedNode === node;
        let radius = 3.5;
        let fill = "rgba(255,255,255,0.7)";
        let alwaysLabel = false;

        // Hub sizing — notes/tags with more wikilinks/shared-tag connections
        // render bigger, same visual language as the reference force-graphs
        // where degree signals importance instead of every node being the
        // same flat size.
        const hubBoost = Math.min(6, Math.sqrt(node.degree ?? 0) * 1.15);

        if (node.kind === "tag") {
          radius = 5 + hubBoost; fill = "rgba(255,166,130,0.92)";
        } else if (node.kind === "note") {
          if (!groupColors.has(node.group)) groupColors.set(node.group, hashColor(node.group));
          radius = 3.5 + hubBoost; fill = groupColors.get(node.group)!;
        } else if (node.kind === "department") {
          radius = 9; fill = LEGS.agents.color; alwaysLabel = true;
        } else if (node.kind === "persona") {
          // Colored by department so the department clusters read visually
          // even before the eye picks out the dashed hub ring below.
          if (!groupColors.has(node.group)) groupColors.set(node.group, hashColor(node.group));
          radius = 6; fill = groupColors.get(node.group)!; alwaysLabel = true;
        } else if (node.kind === "storage") {
          const alpha = node.status === "ok" ? 1 : node.status === "warn" ? 0.6 : 0.3;
          radius = 7; fill = LEGS.storage.color.replace("hsl", "hsla").replace(")", `, ${alpha})`); alwaysLabel = true;
        } else if (node.kind === "connector") {
          const alpha = node.status === "ok" ? 1 : node.status === "warn" ? 0.6 : 0.35;
          radius = 5.5; fill = LEGS.integrations.color.replace("hsl", "hsla").replace(")", `, ${alpha})`); alwaysLabel = true;
        } else if (node.kind === "file-item") {
          // A vault file revealed by expanding a storage backend — styled
          // like a note (colored by its vault folder), hover-to-label only
          // since a backend can reveal up to MAX_EXPANDED_FILES of these.
          if (!groupColors.has(node.group)) groupColors.set(node.group, hashColor(node.group));
          radius = 2.5; fill = groupColors.get(node.group)!;
        } else if (node.kind === "placeholder") {
          radius = 4; fill = "rgba(255,255,255,0.3)"; alwaysLabel = true;
        }

        if (isHover) radius *= 1.7;
        else if (isFocused) radius *= 1.4;

        // Bloom pass first (drawn underneath, additive) so the sharp core
        // painted after it stays crisp — this is what makes nodes read as
        // glowing light sources rather than flat dots against the ambient
        // GlitterBackground star field, which has no bloom of its own.
        drawGlow(node.x, node.y, radius * (isHover ? 5.5 : isFocused ? 5 : 4.2), isHover ? 0.9 : isFocused ? 0.85 : 0.55, isFocused ? "rgba(255,255,255,0.95)" : fill);

        ctx!.beginPath();
        ctx!.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx!.fillStyle = fill;
        ctx!.fill();

        // A thin bright ring on top of the bloom gives every real node a
        // crisp edge the background's flat dots don't have.
        if (node.kind === "note" || node.kind === "file-item" || node.kind === "tag") {
          ctx!.beginPath();
          ctx!.arc(node.x, node.y, radius + 1.2, 0, Math.PI * 2);
          ctx!.strokeStyle = "rgba(255,255,255,0.5)";
          ctx!.lineWidth = 0.9 / t.scale;
          ctx!.stroke();
        }

        // Pulsing white ring on the note that answered Naxie's last reply —
        // the visible "this is where that came from" cue.
        if (isFocused) {
          const pulse = 0.6 + 0.4 * Math.sin(now / 260);
          ctx!.beginPath();
          ctx!.arc(node.x, node.y, radius + 6 + pulse * 2, 0, Math.PI * 2);
          ctx!.strokeStyle = `rgba(255,255,255,${0.55 + 0.35 * pulse})`;
          ctx!.lineWidth = 1.8 / t.scale;
          ctx!.stroke();
        }

        if (node.kind === "storage" && expandedStorageRef.current.has(node.id)) {
          ctx!.beginPath();
          ctx!.arc(node.x, node.y, radius + 4, 0, Math.PI * 2);
          ctx!.strokeStyle = "rgba(255,255,255,0.5)";
          ctx!.lineWidth = 1.2 / t.scale;
          ctx!.stroke();
        }

        // Autonomy-tier ring — agent (fully autonomous) green, hybrid amber.
        // Absent workMode is already normalized to "agent" at
        // fetch time.
        if (node.kind === "persona") {
          const tierColor = node.workMode === "hybrid" ? "hsl(40, 90%, 60%)"
            : "hsl(140, 60%, 55%)";
          ctx!.beginPath();
          ctx!.arc(node.x, node.y, radius + 3, 0, Math.PI * 2);
          ctx!.strokeStyle = tierColor;
          ctx!.lineWidth = 1.6 / t.scale;
          ctx!.stroke();
        }

        // Dashed hub ring so a department reads as structural grouping,
        // not a leaf.
        if (node.kind === "department") {
          ctx!.save();
          ctx!.setLineDash([3, 3]);
          ctx!.beginPath();
          ctx!.arc(node.x, node.y, radius + 5, 0, Math.PI * 2);
          ctx!.strokeStyle = "rgba(255,255,255,0.35)";
          ctx!.lineWidth = 1 / t.scale;
          ctx!.stroke();
          ctx!.restore();
        }

        if (alwaysLabel || node.kind === "tag" || isHover || isFocused) {
          const labelText = node.kind === "persona" && node.workMode && node.workMode !== "agent"
            ? `${node.label} · ${node.workMode}`
            : node.label;
          ctx!.font = `${alwaysLabel ? 11 : node.kind === "tag" ? 11 : 12}px ui-sans-serif, system-ui, sans-serif`;
          ctx!.fillStyle = node.kind === "placeholder" ? "rgba(255,255,255,0.4)" : (isHover || isFocused) ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.6)";
          ctx!.fillText(labelText, node.x + radius + 4, node.y + 4);
        }
      }

      // The Naxie brain — the center of the map. A big soft nebula halo, a
      // pulsing glow, and a bright solid core, so it reads as the dominant
      // feature of the map rather than a faint ring among the node clusters.
      {
        const pulse = 0.75 + 0.25 * Math.sin(now / 700);

        // Wide outer halo — a large low-opacity wash that gives the brain
        // presence even when zoomed out, well beyond the glow radius below.
        const halo = ctx!.createRadialGradient(0, 0, 0, 0, 0, 90);
        halo.addColorStop(0, "rgba(160, 190, 255, 0.35)");
        halo.addColorStop(0.5, "rgba(140, 160, 255, 0.14)");
        halo.addColorStop(1, "rgba(140, 160, 255, 0)");
        ctx!.beginPath();
        ctx!.arc(0, 0, 90, 0, Math.PI * 2);
        ctx!.fillStyle = halo;
        ctx!.fill();

        ctx!.save();
        ctx!.shadowBlur = 55 * pulse;
        ctx!.shadowColor = "rgba(190, 215, 255, 1)";
        const grad = ctx!.createRadialGradient(0, 0, 2, 0, 0, 26);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(0.45, "rgba(170, 205, 255, 0.95)");
        grad.addColorStop(1, "rgba(120, 140, 255, 0.35)");
        ctx!.beginPath();
        ctx!.arc(0, 0, 22 * pulse, 0, Math.PI * 2);
        ctx!.fillStyle = grad;
        ctx!.fill();
        ctx!.restore();

        ctx!.strokeStyle = `rgba(210, 228, 255, ${0.35 + 0.15 * pulse})`;
        ctx!.lineWidth = 1.5 / t.scale;
        ctx!.beginPath();
        ctx!.arc(0, 0, 34, 0, Math.PI * 2);
        ctx!.stroke();

        ctx!.font = `700 13px ui-sans-serif, system-ui, sans-serif`;
        ctx!.fillStyle = "rgba(255,255,255,0.95)";
        ctx!.textAlign = "center";
        ctx!.fillText("NAXIE", 0, 52);
        ctx!.textAlign = "left";
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
        const r = node.kind === "tag" || node.kind === "storage" || node.kind === "department" ? 9 : node.kind === "persona" || node.kind === "connector" ? 8 : 7;
        if ((node.x - x) ** 2 + (node.y - y) ** 2 <= r * r) return node;
      }
      return null;
    }

    // Click (not drag) a storage backend to reveal/hide its stored items.
    // Local/Obsidian/GitHub all mirror the same vault, so they reuse the
    // already-fetched file list; Drive/Supabase have nothing to reveal yet
    // (no credentials / pipeline), so a single "not configured" node stands
    // in for them instead of pretending there's data.
    function toggleExpand(storageNode: SimNode) {
      const backendId = storageNode.id.slice("storage:".length);
      if (expandedStorageRef.current.has(storageNode.id)) {
        expandedStorageRef.current.delete(storageNode.id);
        nodesRef.current = nodesRef.current.filter(n => n.parentId !== storageNode.id);
        setCount(nodesRef.current.length);
        return;
      }
      expandedStorageRef.current.add(storageNode.id);
      let extra: SimNode[];
      if (backendId === "local" || backendId === "obsidian" || backendId === "github") {
        extra = vaultFilesRef.current.slice(0, MAX_EXPANDED_FILES).map(f => {
          const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 70;
          return {
            id: `file:${backendId}:${f.id}`, label: f.label, group: f.group, kind: "file-item", leg: storageNode.leg,
            parentId: storageNode.id,
            x: storageNode.x + Math.cos(a) * r, y: storageNode.y + Math.sin(a) * r, vx: 0, vy: 0,
          };
        });
      } else {
        extra = [{
          id: `empty:${backendId}`, label: "Not configured yet", group: "empty", kind: "placeholder", leg: storageNode.leg,
          parentId: storageNode.id, x: storageNode.x + 20, y: storageNode.y + 20, vx: 0, vy: 0,
        }];
      }
      nodesRef.current = [...nodesRef.current, ...extra];
      setCount(nodesRef.current.length);
    }

    function onPointerDown(e: PointerEvent) {
      movedRef.current = false;
      clickStartRef.current = { x: e.clientX, y: e.clientY };
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
      const held = draggingRef.current;
      const start = clickStartRef.current;
      if (held && held.kind === "storage" && start) {
        const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (dist < 6) toggleExpand(held);
      }
      draggingRef.current = null;
      panRef.current = null;
      clickStartRef.current = null;
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
    <div
      ref={containerRef}
      className="relative w-full h-full min-h-[320px] rounded-2xl border border-white/10 bg-black/55 backdrop-blur-2xl shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_80px_-20px_rgba(140,160,255,0.35)] overflow-hidden"
    >
      {loading && <div className="absolute inset-0 grid place-items-center text-xs text-cream-300/50">Mapping Naxie…</div>}
      {error && <div className="absolute top-2 left-3 text-[10px] text-coral-400/80">{error}</div>}
      {!loading && count === 0 && (
        <div className="absolute inset-0 grid place-items-center text-xs text-cream-300/50">Nothing to map yet.</div>
      )}
      <canvas ref={canvasRef} className="block w-full h-full" />

      {!loading && count > 0 && (
        <div className="absolute bottom-2 right-3 text-[10px] text-cream-300/40 pointer-events-none">
          {count} nodes · drag to rearrange · scroll to zoom
        </div>
      )}
    </div>
  );
}
