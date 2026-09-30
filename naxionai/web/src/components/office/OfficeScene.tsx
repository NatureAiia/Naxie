import { useEffect, useRef, useState } from "react";
import {
  Scene, OrthographicCamera, WebGLRenderer, Color, AmbientLight, DirectionalLight,
  Mesh, MeshLambertMaterial, MeshBasicMaterial, PlaneGeometry, BoxGeometry, SphereGeometry,
  CylinderGeometry, Group, Raycaster, Vector2, Vector3, Object3D, PCFSoftShadowMap, AdditiveBlending,
} from "three";
import { buildSceneObject, colorFromName, initialsFromName, type HubCoreHandle } from "./sceneObjects";

// Office floor — an isometric view (drag to orbit azimuth, wheel to zoom,
// elevation angle fixed) of every persona seated in their department room,
// following WorkforceGlobe.tsx's
// house style for the Three.js renderer lifecycle (manual setup in a
// useEffect, resize via ResizeObserver, prefers-reduced-motion, WebGL
// fallback, explicit disposal). Camera differs from WorkforceGlobe's
// PerspectiveCamera: a true isometric look needs an OrthographicCamera at a
// fixed elevation/azimuth, so this is new setup/resize math, not a copy.
//
// v1.1 legibility pass: dynamic camera fit (was a hardcoded, too-small view),
// brighter lighting, per-desk name tags + initials nameplates, room-name
// headers, low room-border walls, a ground plane, and a wandering/seated
// mascot per persona (an original abstract "peg-doll" shape — see
// sceneObjects.ts) that walks back and sits when its persona picks up a job.

export type OfficeMember = { personaId: string; name: string };
export type OfficeRoom = { id: string; name: string; color: string; members: OfficeMember[] };

type Props = {
  rooms: OfficeRoom[];
  frontDeskMember?: OfficeMember | null;
  busyPersonaIds: Set<string>;
  stuckPersonaIds?: Set<string>;
  // roomId → count of jobs parked at awaiting-approval for a member of that
  // room. Drives the department badge's amber pulse — a real "needs your
  // sign-off" signal instead of a decorative sweep.
  pendingApprovalCounts?: Map<string, number>;
  onSelectPersona: (personaId: string) => void;
  onSelectMeetingTable: () => void;
  // Clicking a department badge — opens a department-level detail panel
  // (member list + status) distinct from the per-persona chat rail.
  onSelectDepartment?: (roomId: string) => void;
  highlightPersonaId?: string | null;
  height?: number | string;
};

// Department status badge — one plain DOM pill per room, reprojected to
// screen space every tick (see tick() below) so it stays legible at any zoom
// level, unlike the baked-in 3D name-tag sprites which shrink into
// illegibility zoomed out. Built imperatively to match this file's existing
// non-React Three.js/DOM style rather than introducing per-frame React
// re-renders.
type Badge = {
  el: HTMLDivElement;
  countEl: HTMLSpanElement;
  pendingEl: HTMLSpanElement;
  cx: number;
  cz: number;
  glowColor: Color;
  lastPending: number;
};

const DESK_SPACING = 1.6;
const ROOM_GAP = 1.4;
const ISLAND_GAP = 3.2; // clear space between adjacent department islands
const WANDER_AVOID_RADIUS = 0.55;
const WALK_SPEED = 0.6; // units/sec
// Avatars are built at 1.75x scale (sceneObjects.ts) — collision radii sized
// to that footprint so avatars never visually overlap each other or a desk.
const AVATAR_COLLIDE_R = 0.5;
const DESK_COLLIDE_R = 0.68;
// Boardroom isolated in the open southeast gap — well clear of every
// department pod so the oval table never touches a room wall or its
// connector studs.
const BOARDROOM_POS = { x: 8.5, z: 3.2 };
const BOARDROOM_CLEAR_R = 1.6;

type Placed = { room: OfficeRoom; x: number; z: number; w: number; d: number; cx: number; cz: number };

// Radial "islands around a hub" layout — each department is a separate room
// placed around a ring centered on the entrance/hub area (Naxie's front desk
// + the meeting table), with a real gap (ISLAND_GAP) between neighbors so
// rooms never crowd into one packed mass. The ring's radius is derived from
// the total arc-length every room actually needs (each room's angular slice
// is proportional to its own footprint), so it scales correctly whether
// there are 3 departments or 15, instead of a fixed grid that either wastes
// space or overflows.
function layoutRooms(rooms: OfficeRoom[]): Placed[] {
  const sorted = [...rooms].sort((a, b) => b.members.length - a.members.length);
  const specs = sorted.map(room => {
    const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, room.members.length))));
    const rows = Math.max(1, Math.ceil(room.members.length / cols));
    const w = cols * DESK_SPACING + ROOM_GAP;
    const d = rows * DESK_SPACING + ROOM_GAP;
    return { room, w, d, arc: Math.max(w, d) + ISLAND_GAP };
  });
  const totalArc = specs.reduce((s, x) => s + x.arc, 0) || 1;
  const radius = Math.max(6, totalArc / (2 * Math.PI));
  const placed: Placed[] = [];
  let angle = -Math.PI / 2; // start at the top, sweep clockwise — cosmetic only
  for (const spec of specs) {
    const span = (spec.arc / totalArc) * 2 * Math.PI;
    const mid = angle + span / 2;
    const cx = Math.cos(mid) * radius, cz = Math.sin(mid) * radius;
    placed.push({ room: spec.room, x: cx - spec.w / 2, z: cz - spec.d / 2, w: spec.w, d: spec.d, cx, cz });
    angle += span;
  }
  return placed;
}

// Where a ray from the origin toward (dirX,dirZ) first enters the axis-aligned
// box [xmin,xmax]x[zmin,zmax], as a fraction of the full (0,0)→(dirX,dirZ)
// segment. Standard 2D slab test. Falls back to 1 (don't clip) if the box
// doesn't actually lie on the segment, so a malformed room never deletes its
// own connector.
function segmentBoxEntryT(dirX: number, dirZ: number, xmin: number, xmax: number, zmin: number, zmax: number): number {
  let tMin = 0, tMax = 1;
  if (Math.abs(dirX) < 1e-6) {
    if (xmin > 0 || xmax < 0) return 1;
  } else {
    let t1 = (xmin - 0) / dirX, t2 = (xmax - 0) / dirX;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2);
  }
  if (Math.abs(dirZ) < 1e-6) {
    if (zmin > 0 || zmax < 0) return 1;
  } else {
    let t1 = (zmin - 0) / dirZ, t2 = (zmax - 0) / dirZ;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1); tMax = Math.min(tMax, t2);
  }
  if (tMin > tMax) return 1;
  return Math.max(0, Math.min(1, tMin));
}

type WanderBounds = { minX: number; maxX: number; minZ: number; maxZ: number };

function pickWanderTarget(bounds: WanderBounds, deskPositions: Vector3[]): Vector3 {
  for (let i = 0; i < 5; i++) {
    const x = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
    const z = bounds.minZ + Math.random() * (bounds.maxZ - bounds.minZ);
    const p = new Vector3(x, 0, z);
    if (!deskPositions.some(d => d.distanceTo(p) < WANDER_AVOID_RADIUS)) return p;
  }
  return new Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
}

type AvatarJoints = { headJoint: Object3D; armL: Object3D; armR: Object3D; legL: Object3D; legR: Object3D };

// A relaxed standing pose (used while "pausing" mid-wander) — legs straight,
// arms at rest with a faint idle sway, head level with a slow, small nod.
// `phase` (per-avatar) offsets every sine so a room full of pausing avatars
// doesn't breathe/nod in unison.
function restJoints(j: AvatarJoints, now: number, phase: number): void {
  const t = now + phase;
  j.legL.rotation.x = j.legR.rotation.x = 0;
  j.armL.rotation.x = -0.15 + Math.sin(t / 500) * 0.05;
  j.armR.rotation.x = -0.15 - Math.sin(t / 500) * 0.05;
  j.headJoint.rotation.x = Math.sin(t / 900) * 0.04;
  j.headJoint.rotation.y = Math.sin(t / 1300) * 0.1;
}

// Simple ease helper (quadratic) for one-shot transition curves (squash
// pulse, anticipation crouch) — k in 0..1, returns an eased 0..1.
function easeOutQuad(k: number): number { return 1 - (1 - k) * (1 - k); }

type AvatarState = {
  obj: Object3D;
  joints: AvatarJoints | null;
  mode: "seated" | "walking" | "pausing";
  target: Vector3;
  seat: Vector3;
  pauseUntil: number;
  bounds: WanderBounds;
  deskPositions: Vector3[];
  // Animation-polish state (12-principles pass):
  phase: number;        // per-avatar random offset folded into every idle sine so a room full of avatars doesn't move in lockstep (secondary action / appeal)
  speedMul: number;     // 0..1, eased toward 1 mid-walk and back down on approach (slow-in/slow-out) instead of a constant robotic speed
  anticipateUntil: number; // while now < this, a just-started walk holds a brief wind-up pose before actually translating (anticipation)
  squashStart: number;  // timestamp of the last sit/stand transition, drives a brief squash-and-stretch pulse
  yaw: number;           // last frame's facing angle, so the head can lag behind a turn and settle (follow-through)
};

export function OfficeScene({ rooms, frontDeskMember, busyPersonaIds, stuckPersonaIds, pendingApprovalCounts, onSelectPersona, onSelectMeetingTable, onSelectDepartment, highlightPersonaId, height = 560 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Sorted-by-id room/member signature — stable so packing order doesn't
  // shuffle between loads just because object key order differs.
  const layoutKey = rooms.map(r => `${r.id}:${r.members.map(m => m.personaId).sort().join(",")}`).sort().join("|") + `|front:${frontDeskMember?.personaId ?? ""}`;

  const liveRef = useRef<{
    renderer: WebGLRenderer; scene: Scene; camera: OrthographicCamera;
    indicators: Map<string, Object3D>; warnMarkers: Map<string, Object3D>; deskByPersona: Map<string, Object3D>;
    screens: Map<string, { plate: Mesh; idleTex: any; busyTex: any }>; hub: HubCoreHandle | null; render: () => void;
    badges: Map<string, Badge>;
  } | null>(null);
  // Bridges the busy/stuck-status poll (a separate, lightweight effect below)
  // into the long-lived animation loop below without rebuilding the whole
  // scene on every 5s poll tick.
  const busyRef = useRef(busyPersonaIds);
  useEffect(() => { busyRef.current = busyPersonaIds; }, [busyPersonaIds]);

  // 7C — hub-core target color: whichever department currently has the most
  // busy personas. Recomputed on the same busy-status poll cadence, read by
  // the tick loop every frame via this ref (same bridging pattern as busyRef).
  const hubColorRef = useRef(new Color("#7d57f6"));
  useEffect(() => {
    let best: { room: OfficeRoom; count: number } | null = null;
    for (const room of rooms) {
      const count = room.members.filter(m => busyPersonaIds.has(m.personaId)).length;
      if (count > 0 && (!best || count > best.count)) best = { room, count };
    }
    hubColorRef.current = best ? departmentColor(best.room.color) : new Color("#7d57f6");
  }, [rooms, busyPersonaIds]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 560;

    const scene = new Scene();
    // The void around the floor is a fixed dark "atomic" grey (Atom One
    // Dark's canvas tone), independent of the app's own theme — a dim room
    // around a lit floor, not tied to the light-floor override below.
    scene.background = new Color("#1a1d22");

    const disposables: { dispose(): void }[] = [];
    const clickable: { obj: Object3D; personaId?: string; meetingTable?: boolean }[] = [];
    const indicators = new Map<string, Object3D>();
    const warnMarkers = new Map<string, Object3D>();
    const deskByPersona = new Map<string, Object3D>();
    const screens = new Map<string, { plate: Mesh; idleTex: any; busyTex: any }>();
    const avatarStates = new Map<string, AvatarState>();
    // "General" room floor/halo materials whose color the tick loop cycles
    // through the same gradient stops as the Send button's nw-noise-fill.
    const generalGlowMats: { color: Color }[] = [];
    const badges = new Map<string, Badge>();
    const projVec = new Vector3();

    // Shared shadow-flag setter — Object3D.traverse walks every mesh inside
    // a builder's group (legs, top, joints, etc.) so callers don't have to
    // know a scene object's internal structure to opt it into the shadow map.
    function enableShadow(obj: Object3D, cast: boolean, receive: boolean): void {
      obj.traverse(child => {
        const mesh = child as Mesh;
        if ((mesh as any).isMesh) { mesh.castShadow = cast; mesh.receiveShadow = receive; }
      });
    }

    // Same 3 hues as the Send button's nw-noise-fill gradient (index.css),
    // panned on the same ~6s period, for the "General" room's glow.
    const GLOW_STOPS = [new Color(0x663af3), new Color(0x3fb3a0), new Color(0xff7657)];
    function glowColorAt(now: number): Color {
      const period = 6000;
      const t = ((now % period) / period) * GLOW_STOPS.length;
      const i = Math.floor(t) % GLOW_STOPS.length;
      const j = (i + 1) % GLOW_STOPS.length;
      return GLOW_STOPS[i].clone().lerp(GLOW_STOPS[j], t - Math.floor(t));
    }

    const placedRooms = layoutRooms(rooms);
    const floorGroup = new Group();
    scene.add(floorGroup);

    // E1 — bounding box across every placed room + the front desk + meeting
    // table, so the camera fits whatever the roster actually produces instead
    // of a hardcoded guess that clips a large office or wastes most of the
    // frame on a small one. Boardroom position is included so an isolated
    // table far from pods still stays in frame.
    let minX = Math.min(-3, BOARDROOM_POS.x - 1.5), maxX = Math.max(3, BOARDROOM_POS.x + 1.5);
    let minZ = Math.min(-3, BOARDROOM_POS.z - 1.5), maxZ = Math.max(3, BOARDROOM_POS.z + 1.5);
    for (const { x, z, w: rw, d: rd } of placedRooms) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x + rw);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z + rd);
    }
    const extentX = maxX - minX, extentZ = maxZ - minZ;
    const viewSize = Math.max(6, (extentX + extentZ) * 0.5 + 2);
    const floorCenterX = (minX + maxX) / 2, floorCenterZ = (minZ + maxZ) / 2;

    // Zoom — scales the orthographic frustum only; 1 = the auto-fit computed
    // above, clamped so you can't zoom past "whole floor fits" or into "one
    // desk fills the screen." Rotate — drag orbits the camera azimuth around
    // the floor's center at a fixed elevation (the isometric look-down angle
    // itself never changes, only which side you're looking from).
    // Zoom eases toward a target instead of snapping on every wheel tick
    // (slow-in/slow-out) — `zoom` is the current rendered value, `zoomTarget`
    // is where the wheel input is steering it; the tick loop below closes
    // the gap a bit more each frame.
    let zoom = 1;
    let zoomTarget = 1;
    const ZOOM_MIN = 0.35, ZOOM_MAX = 6;
    let azimuth = Math.PI / 4; // matches the old fixed isoDir=(1,1) direction
    const aspect = w / h;
    const camera = new OrthographicCamera(-viewSize * aspect, viewSize * aspect, viewSize, -viewSize, 0.1, 200);
    const camDist = viewSize * 1.4;
    function applyCameraPosition() {
      camera.position.set(floorCenterX + Math.cos(azimuth) * camDist, camDist, floorCenterZ + Math.sin(azimuth) * camDist);
      camera.lookAt(floorCenterX, 0, floorCenterZ);
    }
    applyCameraPosition();
    function applyFrustum() {
      const nw = container!.clientWidth || w, nh = container!.clientHeight || h;
      const a = nw / nh;
      const v = viewSize / zoom;
      camera.left = -v * a; camera.right = v * a;
      camera.top = v; camera.bottom = -v;
      camera.updateProjectionMatrix();
      renderer.setSize(nw, nh);
    }

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setError("WebGL unavailable");
      return;
    }
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    const canvas = renderer.domElement;
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.cursor = "pointer";
    container.appendChild(canvas);

    // E2 — two-sided lighting so desks/avatars don't read as flat dark
    // silhouettes. A flat, bright wash — an airy room under daylight has weak
    // shadows — plus a soft directional sun so the shadow pass below still reads.
    scene.add(new AmbientLight(0xffffff, 1.15));
    const sun = new DirectionalLight(0xffffff, 0.4);
    sun.position.set(floorCenterX + 7, 11, floorCenterZ + 5);
    sun.target.position.set(floorCenterX, 0, floorCenterZ);
    scene.add(sun.target);
    // Shadow camera is an orthographic box sized to the actual floor extent
    // (not three.js's small default frustum) so shadows stay sharp across a
    // roster that ranges from 3 desks to 30+.
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const shadowPad = Math.max(extentX, extentZ) * 0.6 + 4;
    sun.shadow.camera.left = -shadowPad; sun.shadow.camera.right = shadowPad;
    sun.shadow.camera.top = shadowPad; sun.shadow.camera.bottom = -shadowPad;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 40;
    sun.shadow.bias = -0.0015;
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun);
    const fill = new DirectionalLight(0xffffff, 0.35);
    fill.position.set(-6, 8, -4);
    scene.add(fill);

    // F — a neutral ground plane under the whole floor so gaps between rooms
    // read as hallway, not empty void.
    const groundPad = 4;
    // Floor is always light regardless of the app's own dark/light theme —
    // a deliberate override, not theme-linked like the department tiles
    // below: the office is meant to read as a bright room under any app skin.
    const ground = new Mesh(
      new PlaneGeometry(extentX + groundPad * 2, extentZ + groundPad * 2),
      new MeshLambertMaterial({ color: "#e7ebf2" }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(floorCenterX, -0.02, floorCenterZ);
    ground.receiveShadow = true;
    scene.add(ground);
    disposables.push(ground.geometry, ground.material as MeshLambertMaterial);

    for (const { room, x, z, w: rw, d: rd, cx, cz } of placedRooms) {
      const color = departmentColor(room.color);

      // Department status badge — an always-legible HTML pill floating above
      // the pod, reprojected to screen space every tick (see tick() below).
      // Shows the room name + member count; glows the room's own color while
      // someone there is busy, and pulses amber when a job is parked
      // awaiting-approval for that room (see the pendingApprovalCounts effect
      // below liveRef assignment).
      const badgeEl = document.createElement("div");
      badgeEl.className = "absolute left-0 top-0 pointer-events-auto cursor-pointer flex flex-col items-center gap-0.5 rounded-2xl border border-ink-700/60 bg-ink-900/85 backdrop-blur px-3 py-1.5 shadow-lg shadow-black/20 transition-shadow duration-300 hover:border-cream-300/40";
      badgeEl.title = `${room.name} — click for details`;
      badgeEl.addEventListener("click", ev => {
        ev.stopPropagation();
        onSelectDepartment?.(room.id);
      });
      const nameEl = document.createElement("div");
      nameEl.className = "text-[9px] font-medium tracking-[.14em] uppercase text-cream-300/70 whitespace-nowrap";
      nameEl.textContent = room.name;
      const countEl = document.createElement("span");
      countEl.className = "font-display text-lg leading-none text-cream-50";
      countEl.textContent = String(room.members.length);
      const pendingEl = document.createElement("span");
      pendingEl.className = "text-[9px] font-semibold tracking-[.08em] text-coral-500 whitespace-nowrap";
      pendingEl.textContent = "";
      badgeEl.append(nameEl, countEl, pendingEl);
      container.appendChild(badgeEl);
      badges.set(room.id, { el: badgeEl, countEl, pendingEl, cx, cz, glowColor: color, lastPending: 0 });

      // Lighten/desaturate the department accent into a pastel floor tint —
      // a dark tint on this fixed-light ground would read as a stain, not a room.
      const floorTint = color.clone().offsetHSL(0, -0.1, 0.3);
      // A darker, wider plinth recessed below the floor tile (y<0, never
      // touching where desks/avatars/walls sit at y=0) gives the block a
      // beveled "raised platform" edge and its own cast shadow, instead of a
      // flat painted-on patch — a real 3D step, not just a color change.
      const plinthMat = new MeshLambertMaterial({ color: floorTint.clone().offsetHSL(0, 0, -0.15) });
      const plinth = new Mesh(new BoxGeometry(rw - 0.1, 0.14, rd - 0.1), plinthMat);
      plinth.position.set(x + rw / 2, -0.08, z + rd / 2);
      plinth.castShadow = true;
      plinth.receiveShadow = true;
      floorGroup.add(plinth);
      disposables.push(plinth.geometry, plinthMat);

      const floorMat = new MeshLambertMaterial({ color: floorTint, transparent: true, opacity: 0.95 });
      const floor = new Mesh(new BoxGeometry(rw - 0.2, 0.06, rd - 0.2), floorMat);
      floor.position.set(x + rw / 2, 0, z + rd / 2);
      floor.castShadow = true;
      floor.receiveShadow = true;
      floorGroup.add(floor);
      disposables.push(floor.geometry, floorMat);

      // "General" (no real department) gets the Send button's animated
      // glow instead of a flat tint: the floor material itself cycles hue,
      // plus a larger, additive halo bleeding onto the surrounding ground.
      if (room.id === "general") {
        generalGlowMats.push(floorMat);
        const haloMat = new MeshBasicMaterial({ color: floorTint.clone(), transparent: true, opacity: 0.4, blending: AdditiveBlending, depthWrite: false });
        const halo = new Mesh(new BoxGeometry(rw + 0.35, 0.02, rd + 0.35), haloMat);
        // Above the floor tile (not below, where the new plinth now sits) so
        // the additive glow renders over everything instead of being hidden
        // inside opaque plinth geometry.
        halo.position.set(x + rw / 2, 0.04, z + rd / 2);
        floorGroup.add(halo);
        generalGlowMats.push(haloMat);
        disposables.push(halo.geometry, haloMat);
      }

      // F — low border wall around the room footprint.
      const wall = buildSceneObject("room-wall", { width: rw - 0.2, depth: rd - 0.2, color });
      wall.position.set(x + rw / 2, 0, z + rd / 2);
      enableShadow(wall, true, false);
      floorGroup.add(wall);

      const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, room.members.length))));
      const rows = Math.max(1, Math.ceil(room.members.length / cols));

      // Desk-grid bounds — also the room's wander bounds (G) for its avatars,
      // so mascots roam exactly the area their desks occupy.
      const gridMinX = x + ROOM_GAP / 2, gridMaxX = gridMinX + cols * DESK_SPACING;
      const gridMinZ = z + ROOM_GAP / 2, gridMaxZ = gridMinZ + rows * DESK_SPACING;
      const bounds: WanderBounds = { minX: gridMinX + 0.2, maxX: gridMaxX - 0.2, minZ: gridMinZ + 0.2, maxZ: gridMaxZ - 0.2 };
      const deskPositions: Vector3[] = room.members.map((_, i) => new Vector3(
        gridMinX + (i % cols) * DESK_SPACING + DESK_SPACING / 2, 0,
        gridMinZ + Math.floor(i / cols) * DESK_SPACING + DESK_SPACING / 2,
      ));

      room.members.forEach((member, i) => {
        const seatPos = deskPositions[i];
        const avatarColor = colorFromName(member.name);
        const initials = initialsFromName(member.name);

        const desk = buildSceneObject("desk", { color, initials, avatarColor });
        desk.position.set(seatPos.x, 0, seatPos.z);
        desk.userData.personaId = member.personaId;
        enableShadow(desk, true, true);
        floorGroup.add(desk);
        clickable.push({ obj: desk, personaId: member.personaId });
        deskByPersona.set(member.personaId, desk);
        if (desk.userData.screen) {
          const s = desk.userData.screen as { plate: Mesh; idleTex: any; busyTex: any };
          screens.set(member.personaId, s);
          disposables.push(s.idleTex, s.busyTex);
          if (busyPersonaIds.has(member.personaId)) { const m = s.plate.material as any; m.map = s.busyTex; m.needsUpdate = true; }
        }

        const indicator = new Mesh(
          new SphereGeometry(0.12, 10, 10),
          new MeshLambertMaterial({ color: "#f5a524" }),
        );
        indicator.position.set(seatPos.x, 1.2, seatPos.z);
        indicator.visible = busyPersonaIds.has(member.personaId);
        floorGroup.add(indicator);
        indicators.set(member.personaId, indicator);

        // 4B/7D — stuck-job warning, a distinct sprite from the plain busy
        // indicator above, hidden unless this persona's current job has run
        // past the stuck threshold (Office.tsx computes stuckPersonaIds).
        const warn = buildSceneObject("warn-marker");
        warn.position.set(seatPos.x, 1.55, seatPos.z);
        warn.visible = !!stuckPersonaIds?.has(member.personaId);
        floorGroup.add(warn);
        warnMarkers.set(member.personaId, warn);
        disposables.push(indicator.geometry, indicator.material as MeshLambertMaterial);

        // G/7B — the mascot itself, starting seated at its own desk. Joints
        // (head/arms/legs) come back from the builder for the tick loop to
        // drive a walk cycle and simple work poses.
        const avatarObj = buildSceneObject("avatar", { avatarColor, badgeColor: color, label: member.name });
        avatarObj.position.set(seatPos.x, 0, seatPos.z + 0.4);
        avatarObj.userData.baseScale = avatarObj.scale.x; // 1.75x built-in (sceneObjects.ts) — the squash/stretch pulse scales relative to this
        enableShadow(avatarObj, true, false);
        floorGroup.add(avatarObj);
        avatarStates.set(member.personaId, {
          obj: avatarObj, joints: (avatarObj.userData.joints as AvatarJoints) ?? null,
          mode: "seated", target: seatPos.clone(), seat: new Vector3(seatPos.x, 0, seatPos.z + 0.4),
          pauseUntil: 0, bounds, deskPositions,
          phase: Math.random() * 10000, speedMul: 1, anticipateUntil: 0, squashStart: -1000, yaw: 0,
        });
        // Name tag is a 3D Sprite baked into buildSceneObject("avatar")
        // itself (sceneObjects.ts), not an HTML overlay — it moves with the
        // avatar for free and, being part of the WebGL scene, never fights
        // the isometric camera projection the way a DOM label tracking
        // screen-space coordinates would at 30+ desks across a dozen rooms.
      });

      // A plant in the room's far corner — decoration only, no interaction.
      const p = buildSceneObject("plant", {});
      p.position.set(x + rw - ROOM_GAP / 2, 0, z + ROOM_GAP / 2);
      enableShadow(p, true, false);
      floorGroup.add(p);

      // Dotted connector back to the hub — echoes a hub-and-spoke floor plan
      // so each island reads as "belonging to" the entrance. Built from real
      // disc geometry rather than a THREE.Line: WebGL caps line width at 1px
      // on effectively every browser regardless of `linewidth`, so a GL line
      // can never actually read as "bold" — small studs can.
      // Clipped to stop just outside the room's own wall (segmentBoxEntryT
      // below) instead of running all the way to the room's center, where it
      // used to cut straight across desks and avatars.
      const entryT = segmentBoxEntryT(cx, cz, x, x + rw, z, z + rd);
      const clipT = Math.max(0, entryT - 0.06);
      const connectorLen = Math.hypot(cx, cz) * clipT;
      const studCount = Math.max(2, Math.round(connectorLen / 0.32));
      // 2x radius, fully opaque (was 0.8) — still dotted/spaced, just bold
      // and solid instead of faint.
      const studMat = new MeshBasicMaterial({ color: color.clone().offsetHSL(0, 0, 0.1) });
      const studGeo = new CylinderGeometry(0.09, 0.09, 0.05, 12);
      disposables.push(studGeo, studMat);
      for (let i = 1; i <= studCount; i++) {
        const t = (i / (studCount + 1)) * clipT;
        const sx = cx * t, sz = cz * t;
        // Skip any dot that would land inside the boardroom's footprint —
        // near-coplanar geometry there was z-fighting with the boardroom
        // floor, so the line looked like it cut across the table instead of
        // the table sitting on top of it. A gap reads as "the table owns
        // this patch," not a rendering glitch.
        if (Math.hypot(sx - BOARDROOM_POS.x, sz - BOARDROOM_POS.z) < BOARDROOM_CLEAR_R) continue;
        const stud = new Mesh(studGeo, studMat);
        stud.position.set(sx, 0.02, sz);
        scene.add(stud);
      }
    }

    // Hub — Naxie's front desk + the meeting-table shortcut sit near the
    // center of the ring, at the "entrance" the department islands radiate
    // out from.
    if (frontDeskMember) {
      const fd = buildSceneObject("front-desk", { color: "#7d57f6" });
      // Off to the side on a diagonal, clear of the (now 1.8x bigger) hub
      // core it was overlapping at (-1.05,0,0) — an open gap in the ring,
      // not stacked under the center piece.
      fd.position.set(1.6, 0, -1.6);
      fd.userData.personaId = frontDeskMember.personaId;
      enableShadow(fd, true, true);
      scene.add(fd);
      clickable.push({ obj: fd, personaId: frontDeskMember.personaId });
      deskByPersona.set(frontDeskMember.personaId, fd);
    }

    // Meeting-table shortcut — a pure UI link to Board Meeting, at the hub,
    // no backend coupling. Placed on the vertical (Z) axis rather than beside
    // the front desk, and pulled further out from the hub center than the
    // front desk so the boardroom's own wall ring has clear breathing room.
    const table = buildSceneObject("meeting-table", { color: "#7d57f6", theme: "light" });
    table.position.set(BOARDROOM_POS.x, 0, BOARDROOM_POS.z);
    enableShadow(table, true, true);
    scene.add(table);
    clickable.push({ obj: table, meetingTable: true });

    // 7C — hub-core: a small swirling particle cluster at the entrance,
    // replacing "static meeting table is the whole hub" with something that
    // visibly reacts to activity (colors toward whichever department has the
    // most busy personas right now — hubColorRef, updated on the busy poll).
    const hubCoreObj = buildSceneObject("hub-core", { color: "#7d57f6" });
    hubCoreObj.position.set(0, 0.9, 0);
    hubCoreObj.scale.setScalar(1.8);
    scene.add(hubCoreObj);
    const hub = (hubCoreObj.userData.hub as HubCoreHandle) ?? null;

    const raycaster = new Raycaster();
    const pointer = new Vector2();
    // Drag-to-rotate tracks total pointer movement so a real drag suppresses
    // the click-to-select that would otherwise fire on pointerup.
    let dragging = false;
    let dragMoved = false;
    let dragLastX = 0;
    function onClick(ev: MouseEvent) {
      if (dragMoved) { dragMoved = false; return; }
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      for (const { obj, personaId, meetingTable } of clickable) {
        const hits = raycaster.intersectObject(obj, true);
        if (hits.length > 0) {
          if (meetingTable) onSelectMeetingTable();
          else if (personaId) onSelectPersona(personaId);
          return;
        }
      }
    }
    canvas.addEventListener("click", onClick);

    const render = () => renderer.render(scene, camera);

    // Zoom — mouse wheel / trackpad pinch scales the frustum only, elevation
    // stays fixed. preventDefault so scrolling the page doesn't fight it
    // while the pointer is over the canvas.
    function onWheel(ev: WheelEvent) {
      ev.preventDefault();
      zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomTarget * (1 - ev.deltaY * 0.0015)));
      if (reducedMotion) { zoom = zoomTarget; applyFrustum(); render(); } // no tick loop running to ease it in
    }
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // Rotate — drag orbits azimuth around the floor center; elevation and
    // zoom are untouched, so this is purely "which side am I looking from."
    function onPointerDown(ev: PointerEvent) {
      dragging = true; dragMoved = false; dragLastX = ev.clientX;
      canvas.setPointerCapture(ev.pointerId);
      canvas.style.cursor = "grabbing";
    }
    function onPointerMove(ev: PointerEvent) {
      if (!dragging) return;
      const dx = ev.clientX - dragLastX;
      if (Math.abs(dx) > 2) dragMoved = true;
      dragLastX = ev.clientX;
      azimuth -= dx * 0.006;
      applyCameraPosition();
      render();
    }
    function onPointerUp(ev: PointerEvent) {
      dragging = false;
      try { canvas.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      canvas.style.cursor = "pointer";
    }
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);

    applyFrustum();
    render();

    let raf = 0;
    let lastT = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;

      // Ease the rendered zoom toward wherever the wheel last steered it.
      if (Math.abs(zoomTarget - zoom) > 0.0008) {
        zoom += (zoomTarget - zoom) * Math.min(1, 8 * dt);
        applyFrustum();
      }

      for (const ind of indicators.values()) {
        if (ind.visible) ind.position.y = 1.2 + Math.sin(now / 500) * 0.06;
      }
      for (const warn of warnMarkers.values()) {
        if (warn.visible) { const s = 1 + Math.sin(now / 250) * 0.18; warn.scale.set(s, s, 1); }
      }
      hub?.tick(now, hubColorRef.current);
      if (generalGlowMats.length > 0) {
        const glow = glowColorAt(now);
        for (const m of generalGlowMats) m.color.copy(glow);
      }

      // G — per-avatar wander/return-to-desk state machine, plus a pass of
      // the classic animation principles: anticipation (a brief wind-up
      // before a new walk actually starts moving), slow-in/slow-out (eased
      // speed instead of an instant constant), squash-and-stretch on push-off
      // and landing, arcs (a slight lateral drift instead of a ruler-straight
      // path), and follow-through (the head lags a turn, then settles).
      for (const [personaId, av] of avatarStates) {
        const busy = busyRef.current.has(personaId);
        const prevMode = av.mode;
        if (busy && av.mode !== "seated") { av.mode = "walking"; av.target.copy(av.seat); }
        else if (!busy && av.mode === "seated") { av.mode = "walking"; av.target.copy(pickWanderTarget(av.bounds, av.deskPositions)); }
        if (av.mode === "walking" && prevMode !== "walking") {
          // A fresh walk just started (not a mid-walk retarget) — hold a
          // brief wind-up pose before actually moving, and ease speed in
          // from a near-stop rather than snapping to full stride.
          av.anticipateUntil = now + 130;
          av.speedMul = 0.08;
          av.squashStart = now;
        }

        const anticipating = av.mode === "walking" && now < av.anticipateUntil;

        if (av.mode === "walking" && !anticipating) {
          const pos = av.obj.position;
          const dx = av.target.x - pos.x, dz = av.target.z - pos.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 0.05) {
            pos.set(av.target.x, 0, av.target.z);
            av.mode = busy ? "seated" : "pausing";
            av.pauseUntil = now + 1000 + Math.random() * 2000;
            av.squashStart = now; // landing squash
          } else {
            // Slow-in/slow-out: ease the speed multiplier toward 1 mid-walk
            // and back down as it nears the target, instead of a constant pace.
            const targetMul = dist < 0.4 ? 0.35 : 1;
            av.speedMul += (targetMul - av.speedMul) * Math.min(1, 6 * dt);
            const nx = dx / dist, nz = dz / dist;
            const step = WALK_SPEED * av.speedMul * dt;
            pos.x += nx * step;
            pos.z += nz * step;
            // Arcs — a small perpendicular drift so the path isn't a ruler-
            // straight line, phase-offset per avatar so they don't all wiggle together.
            const lateral = Math.sin((now + av.phase) / 260) * 0.02;
            pos.x += -nz * lateral;
            pos.z += nx * lateral;
            const newYaw = Math.atan2(nx, nz);
            // Follow-through: the head overshoots opposite a sharp turn, then
            // settles back to forward as the turn rate drops toward zero.
            if (av.joints) {
              const yawDelta = Math.atan2(Math.sin(newYaw - av.yaw), Math.cos(newYaw - av.yaw));
              av.joints.headJoint.rotation.y = Math.max(-0.3, Math.min(0.3, -yawDelta * 5));
            }
            av.yaw = newYaw;
            av.obj.rotation.y = newYaw;
            av.obj.rotation.x = 0.07; // slight forward lean while actually moving — weight/momentum
            pos.y = Math.abs(Math.sin((now + av.phase) / 150)) * 0.05;
            // 7B — walk cycle: legs swing opposite phase, arms counter-swing,
            // amplitude scaled by speedMul so a just-eased-in stride starts small.
            if (av.joints) {
              const swing = Math.sin((now + av.phase) / 110) * 0.55 * av.speedMul;
              av.joints.legL.rotation.x = swing; av.joints.legR.rotation.x = -swing;
              av.joints.armL.rotation.x = -swing * 0.8; av.joints.armR.rotation.x = swing * 0.8;
              av.joints.headJoint.rotation.x = 0;
            }
          }
        } else if (anticipating) {
          // Anticipation — a tiny backward-lean wind-up, feet still planted,
          // before the push-off. Reads as "about to move," not idle.
          const k = 1 - Math.max(0, (av.anticipateUntil - now) / 130);
          av.obj.rotation.x = -0.09 * Math.sin(k * Math.PI * 0.5);
          if (av.joints) {
            av.joints.legL.rotation.x = av.joints.legR.rotation.x = 0.12 * Math.sin(k * Math.PI * 0.5);
            av.joints.armL.rotation.x = av.joints.armR.rotation.x = -0.1;
          }
        } else if (av.mode === "pausing") {
          av.obj.position.y = 0;
          av.obj.rotation.x = 0;
          if (av.joints) restJoints(av.joints, now, av.phase);
          if (busy) { av.mode = "walking"; av.target.copy(av.seat); }
          else if (now > av.pauseUntil) { av.mode = "walking"; av.target.copy(pickWanderTarget(av.bounds, av.deskPositions)); }
        } else {
          // seated — a small "alive" breathing bob plus a typing-style work
          // pose (subtle alternating forearm motion + a slow head tilt),
          // not a walk cycle.
          const t = now + av.phase;
          av.obj.rotation.x = 0;
          av.obj.position.set(av.seat.x, Math.sin(t / 400) * 0.015, av.seat.z);
          av.obj.rotation.y = 0;
          if (av.joints) {
            av.joints.legL.rotation.x = av.joints.legR.rotation.x = 0;
            av.joints.armL.rotation.x = -1.1 + Math.sin(t / 170) * 0.12;
            av.joints.armR.rotation.x = -1.1 + Math.sin(t / 140 + 1.3) * 0.14;
            av.joints.headJoint.rotation.x = 0.08 + Math.sin(t / 380) * 0.05;
            av.joints.headJoint.rotation.y = 0;
          }
        }

        // Squash-and-stretch — a brief, decaying pulse on push-off and on
        // landing (both set av.squashStart above), scaled off each avatar's
        // own built scale (1.75x, sceneObjects.ts) rather than a hardcoded value.
        const sst = now - av.squashStart;
        const base = av.obj.userData.baseScale as number;
        if (sst >= 0 && sst < 220) {
          const amt = 0.16 * (1 - easeOutQuad(sst / 220));
          av.obj.scale.set(base * (1 + amt * 0.5), base * (1 - amt), base * (1 + amt * 0.5));
        } else {
          av.obj.scale.setScalar(base);
        }
      }

      // Collision resolution — a lightweight position-based nudge run after
      // movement so walking/pausing avatars never visually overlap a desk in
      // their own room or another avatar, without needing real pathfinding.
      // Seated avatars are treated as fixed obstacles, not pushed themselves.
      const moving = [...avatarStates.values()];
      for (let i = 0; i < moving.length; i++) {
        const a = moving[i];
        if (a.mode === "seated") continue;
        for (const d of a.deskPositions) {
          const dx = a.obj.position.x - d.x, dz = a.obj.position.z - d.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 0.0001 && dist < DESK_COLLIDE_R) {
            const push = DESK_COLLIDE_R - dist;
            a.obj.position.x += (dx / dist) * push;
            a.obj.position.z += (dz / dist) * push;
          }
        }
        for (let j = i + 1; j < moving.length; j++) {
          const b = moving[j];
          const dx = a.obj.position.x - b.obj.position.x, dz = a.obj.position.z - b.obj.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 0.0001 && dist < AVATAR_COLLIDE_R) {
            const nx = dx / dist, nz = dz / dist;
            const push = (AVATAR_COLLIDE_R - dist) * (b.mode === "seated" ? 1 : 0.5);
            a.obj.position.x += nx * push; a.obj.position.z += nz * push;
            if (b.mode !== "seated") { b.obj.position.x -= nx * push; b.obj.position.z -= nz * push; }
          }
        }
      }

      // Reproject each department badge to screen space so it tracks the
      // orbiting/zooming camera and stays legible at any distance, unlike the
      // baked-in 3D name-tag sprites which shrink away zoomed out.
      const nw = container!.clientWidth || w, nh = container!.clientHeight || h;
      for (const b of badges.values()) {
        projVec.set(b.cx, 1.7, b.cz);
        projVec.project(camera);
        const sx = (projVec.x * 0.5 + 0.5) * nw;
        const sy = (-projVec.y * 0.5 + 0.5) * nh;
        b.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -100%)`;
      }

      render();
      raf = requestAnimationFrame(tick);
    };
    if (!reducedMotion) raf = requestAnimationFrame(tick);
    else render(); // static: avatars stay put at whatever pose they built at (seated)

    const ro = new ResizeObserver(() => {
      applyFrustum();
      render();
    });
    ro.observe(container);

    liveRef.current = { renderer, scene, camera, indicators, warnMarkers, deskByPersona, screens, hub, render, badges };

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      ro.disconnect();
      for (const d of disposables) { try { d.dispose(); } catch { /* tolerate */ } }
      renderer.dispose();
      try { container.removeChild(canvas); } catch { /* already gone */ }
      for (const b of badges.values()) { try { b.el.remove(); } catch { /* already gone */ } }
      badges.clear();
      liveRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Busy-status updates reuse the live scene instead of rebuilding the whole
  // WebGL context on every poll tick.
  useEffect(() => {
    const live = liveRef.current;
    if (!live) return;
    for (const [personaId, indicator] of live.indicators) {
      indicator.visible = busyPersonaIds.has(personaId);
    }
    for (const [personaId, warn] of live.warnMarkers) {
      warn.visible = !!stuckPersonaIds?.has(personaId);
    }
    for (const [personaId, screen] of live.screens) {
      const m = screen.plate.material as any;
      m.map = busyPersonaIds.has(personaId) ? screen.busyTex : screen.idleTex;
      m.needsUpdate = true;
    }
    // Real-state badge glow — the room's own accent color while any member
    // is busy, replacing agents-office's decorative time-based sweep with an
    // actual "something is happening here" signal.
    for (const room of rooms) {
      const badge = live.badges.get(room.id);
      if (!badge) continue;
      const busy = room.members.some(m => busyPersonaIds.has(m.personaId));
      badge.el.style.boxShadow = busy
        ? `0 0 0 1.5px rgba(${Math.round(badge.glowColor.r * 255)},${Math.round(badge.glowColor.g * 255)},${Math.round(badge.glowColor.b * 255)},.55), 0 10px 26px -6px rgba(${Math.round(badge.glowColor.r * 255)},${Math.round(badge.glowColor.g * 255)},${Math.round(badge.glowColor.b * 255)},.5)`
        : "";
    }
    live.render();
  }, [busyPersonaIds, stuckPersonaIds, rooms]);

  // Approval-pending badge indicator — a real "this department needs your
  // sign-off" signal (feeds off org.approvals_pending-style job data via
  // Office.tsx), amber-pulsing until cleared. Separate effect from the busy
  // glow above since it changes on a different cadence and owns its own
  // count-flash-on-change animation.
  useEffect(() => {
    const live = liveRef.current;
    if (!live) return;
    for (const room of rooms) {
      const badge = live.badges.get(room.id);
      if (!badge) continue;
      const count = pendingApprovalCounts?.get(room.id) ?? 0;
      badge.pendingEl.textContent = count > 0 ? `⏳ ${count} pending` : "";
      if (count > 0) badge.el.classList.add("animate-badge-pulse");
      else badge.el.classList.remove("animate-badge-pulse");
      if (count !== badge.lastPending) {
        badge.countEl.classList.remove("animate-count-flash");
        // Force reflow so re-adding the class restarts the animation.
        void badge.countEl.offsetWidth;
        badge.countEl.classList.add("animate-count-flash");
        badge.lastPending = count;
      }
    }
  }, [pendingApprovalCounts, rooms]);

  // H — "jump to desk" from the sidebar directory/search: a brief highlight
  // pulse on the matched desk. The camera is fixed/isometric with no
  // pan/zoom-to-target, so this is what "jump to" means here.
  useEffect(() => {
    const live = liveRef.current;
    if (!live || !highlightPersonaId) return;
    const desk = live.deskByPersona.get(highlightPersonaId);
    if (!desk) return;
    const start = performance.now();
    const baseScale = desk.scale.x;
    let raf = 0;
    const pulse = () => {
      const t = (performance.now() - start) / 900;
      if (t >= 1) { desk.scale.setScalar(baseScale); live.render(); return; }
      desk.scale.setScalar(baseScale + Math.sin(t * Math.PI) * 0.35);
      live.render();
      raf = requestAnimationFrame(pulse);
    };
    raf = requestAnimationFrame(pulse);
    return () => { cancelAnimationFrame(raf); desk.scale.setScalar(baseScale); };
  }, [highlightPersonaId]);

  if (error) {
    return <div style={{ height }} className="grid place-items-center text-xs text-cream-300/40">office view unavailable — {error}</div>;
  }
  return <div ref={containerRef} style={{ position: "relative", height }} className="rounded-lg overflow-hidden border border-ink-800" />;
}

function getCssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

// Department color tokens: violet/coral/leaf(green) are this app's own
// theme-aware CSS vars (tailwind.config.js), read live so office room tints
// track the app's actual palette (including any future light/dark toggle).
// The other department-templates.ts color words (blue/amber/purple/teal/
// slate) have no custom token in this app — those fall back to Tailwind's
// standard static hex for that name. Anything unrecognized (a custom
// department's arbitrary color string) gets a neutral gray.
const STATIC_FALLBACK: Record<string, string> = {
  blue: "#3b82f6", amber: "#f59e0b", purple: "#a855f7", teal: "#14b8a6", slate: "#64748b",
  red: "#ef4444", navy: "#1e3a8a",
};
function departmentColor(token: string): Color {
  const t = (token || "").toLowerCase().trim();
  if (t === "violet") return new Color(getCssVar("--c-violet-500", "#7d57f6"));
  if (t === "coral") return new Color(getCssVar("--c-coral-500", "#f26b5e"));
  if (t === "green" || t === "leaf") return new Color(getCssVar("--c-leaf-500", "#4caf6d"));
  if (STATIC_FALLBACK[t]) return new Color(STATIC_FALLBACK[t]);
  return new Color("#6b7280");
}
