// Office — pluggable 3D object registry. Not a full plugin system: just
// enough indirection that a new desk/decoration/room-furniture kind is an
// additive registerSceneObject() call, not a change to OfficeScene.tsx's
// render loop. All builders use simple primitive geometry (boxes/cylinders/
// spheres) — no GLTF/asset loading for v1, matching WorkforceGlobe.tsx's own
// no-external-assets approach. The avatar() builder is an original, abstract
// "peg-doll" shape (sphere head + capsule body + a badge) — not a depiction
// of any existing character.
import {
  BoxGeometry, CylinderGeometry, IcosahedronGeometry, SphereGeometry, CapsuleGeometry,
  MeshLambertMaterial, MeshBasicMaterial, Mesh, Group, Color, Object3D,
  CanvasTexture, PlaneGeometry, DoubleSide, Sprite, SpriteMaterial,
  InstancedMesh, Matrix4, TorusGeometry, OctahedronGeometry, AdditiveBlending,
  Line, LineBasicMaterial, BufferGeometry, Vector3,
} from "three";

export type SceneObjectKind = "desk" | "plant" | "meeting-table" | "front-desk" | "room-wall" | "avatar" | string;

export type SceneObjectOpts = {
  color?: string | number | Color;
  label?: string;
  [key: string]: unknown;
};

type Builder = (opts: SceneObjectOpts) => Object3D;

const registry = new Map<SceneObjectKind, Builder>();

export function registerSceneObject(kind: SceneObjectKind, builder: Builder): void {
  registry.set(kind, builder);
}

export function buildSceneObject(kind: SceneObjectKind, opts: SceneObjectOpts = {}): Object3D {
  const builder = registry.get(kind) ?? registry.get("desk")!;
  return builder(opts);
}

// Deterministic "who is this" color from a name — same idea as a Slack/Gmail
// avatar. Shared by desk nameplates (E3) and avatars (G) so a persona's desk
// and their wandering mascot always match.
export function colorFromName(name: string): Color {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return new Color(`hsl(${hue}, 62%, 55%)`);
}

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function nameplateTexture(initials: string, bgColor: Color): CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `#${bgColor.getHexString()}`;
  ctx.beginPath();
  ctx.roundRect(4, 4, size - 8, size - 8, 20);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 52px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, size / 2, size / 2 + 4);
  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// Overhead name tag — a small pill with the persona's full name, always
// billboarded above their avatar's head (Sprite always faces the camera).
// Width is derived from the measured text so short and long names both get a
// tight, centered pill instead of a fixed box that clips or floats oddly.
function nameTagTexture(name: string): CanvasTexture {
  const paddingX = 22, height = 64, font = "bold 34px Arial, sans-serif";
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const width = Math.ceil(measure.measureText(name).width + paddingX * 2);
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(10, 12, 18, 0.75)";
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, height / 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(name, width / 2, height / 2 + 2);
  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// Live desk screen — idle shows the same initials plate as before; busy shows
// a small "working" status instead, so a desk reads as active without
// needing to spot the floating indicator sphere above it.
function workingScreenTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#12161c";
  ctx.beginPath();
  ctx.roundRect(4, 4, size - 8, size - 8, 20);
  ctx.fill();
  ctx.fillStyle = "#3ddc84";
  ctx.beginPath();
  ctx.arc(size / 2, size * 0.34, size * 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8ecf1";
  ctx.font = "bold 17px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("working", size / 2, size * 0.66);
  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function desk(opts: SceneObjectOpts): Object3D {
  const group = new Group();
  const top = new Mesh(
    new BoxGeometry(1.1, 0.08, 0.6),
    new MeshLambertMaterial({ color: new Color(opts.color ?? "#8a8f9c") }),
  );
  top.position.y = 0.5;
  group.add(top);
  const legMat = new MeshLambertMaterial({ color: "#3a3f4a" });
  const legGeo = new CylinderGeometry(0.03, 0.03, 0.5, 6);
  for (const [dx, dz] of [[-0.48, -0.24], [0.48, -0.24], [-0.48, 0.24], [0.48, 0.24]] as const) {
    const leg = new Mesh(legGeo, legMat);
    leg.position.set(dx, 0.25, dz);
    group.add(leg);
  }
  // Nameplate/screen — a small upright "monitor" showing the persona's
  // initials on their name-hashed color when idle, and a live "working"
  // status when busy. OfficeScene swaps `plate.material.map` between the two
  // pre-built textures on busy-status changes (group.userData.screen) rather
  // than rebuilding the desk.
  if (typeof opts.initials === "string") {
    const bg = opts.avatarColor instanceof Color ? opts.avatarColor : colorFromName(opts.initials);
    const idleTex = nameplateTexture(opts.initials, bg);
    const busyTex = workingScreenTexture();
    const plate = new Mesh(
      new PlaneGeometry(0.28, 0.28),
      new MeshBasicMaterial({ map: idleTex, side: DoubleSide, transparent: true }),
    );
    plate.position.set(0, 0.72, -0.02);
    plate.rotation.x = -0.25; // tilt slightly toward the viewer, isometric-camera-friendly
    group.add(plate);
    group.userData.screen = { plate, idleTex, busyTex };
  }
  group.userData.kind = "desk";
  return group;
}

// Hub-core visualization (7C) — a small swirling instanced-particle cluster
// at the office's center, replacing a static-only meeting table. Colored
// toward whichever department currently has the most busy personas
// (OfficeScene computes and pushes the target color; this builder just owns
// the geometry + a tick() that reads that color each frame). Original
// design — a compact particle swirl, not the specific nebula/knowledge-web
// technique referenced from agents-office's own "Brain" visualization.
export type HubCoreHandle = { tick: (now: number, targetColor: Color) => void };
// "More AI and techy" pass: the original particle swirl stays (now orbiting
// a glowing wireframe core instead of empty space), plus two thin torus
// rings tumbling on independent axes — a generic "AI orb" read (data core +
// orbiting rings), not a depiction of any specific product's mark.
function hubCore(opts: SceneObjectOpts): Object3D {
  const group = new Group();
  const baseColor = opts.color instanceof Color ? opts.color.clone() : new Color(opts.color ?? "#7d57f6");
  const N = 60;
  const R = 0.55;
  const parts = Array.from({ length: N }, () => {
    const rad = R * Math.pow(Math.random(), 0.6);
    return {
      rad, az: Math.random() * Math.PI * 2,
      y: (Math.random() - 0.5) * 0.18 * (1 - rad / R),
      speed: 0.0006 + 0.0009 * (1 - rad / R),
      scale: 0.5 + Math.random() * 0.6,
    };
  });
  const inst = new InstancedMesh(new SphereGeometry(0.035, 6, 6), new MeshBasicMaterial({ color: 0xffffff }), N);
  const dummy = new Object3D();
  const tmpColor = new Color();
  const place = (color: Color) => {
    parts.forEach((p, i) => {
      dummy.position.set(p.rad * Math.cos(p.az), p.y, p.rad * Math.sin(p.az));
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      inst.setColorAt(i, color);
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  };
  place(baseColor);
  group.add(inst);

  // Glowing wireframe core — an octahedron (reads as a crystal/data-node,
  // not a plain sphere) with an additive-blended fill behind it for a soft
  // inner glow.
  const coreMat = new MeshBasicMaterial({ color: baseColor.clone(), wireframe: true, transparent: true, opacity: 0.9 });
  const core = new Mesh(new OctahedronGeometry(0.16, 1), coreMat);
  group.add(core);
  const coreGlowMat = new MeshBasicMaterial({ color: baseColor.clone(), transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false });
  const coreGlow = new Mesh(new SphereGeometry(0.13, 12, 12), coreGlowMat);
  group.add(coreGlow);
  // A second, larger, softer halo behind the tight inner glow — reads as
  // light bleeding outward rather than a single hard-edged sphere.
  const outerGlowMat = new MeshBasicMaterial({ color: baseColor.clone(), transparent: true, opacity: 0.14, blending: AdditiveBlending, depthWrite: false });
  const outerGlow = new Mesh(new SphereGeometry(0.3, 12, 12), outerGlowMat);
  group.add(outerGlow);

  // Two orbit rings on skewed, independent axes.
  const ringMat1 = new MeshBasicMaterial({ color: baseColor.clone(), transparent: true, opacity: 0.55 });
  const ring1 = new Mesh(new TorusGeometry(0.34, 0.006, 8, 48), ringMat1);
  ring1.rotation.x = Math.PI / 2.4;
  group.add(ring1);
  const ringMat2 = new MeshBasicMaterial({ color: baseColor.clone(), transparent: true, opacity: 0.4 });
  const ring2 = new Mesh(new TorusGeometry(0.42, 0.005, 8, 48), ringMat2);
  ring2.rotation.x = Math.PI / 1.7;
  ring2.rotation.y = Math.PI / 5;
  group.add(ring2);

  // Lightning — a small pool of jagged bolts that flash from the core out
  // toward the ring radius, one at a time, on a randomized stagger. Each
  // owns its own material (for an independent flicker) but geometry is
  // rebuilt in place on every flash rather than allocating a new Line.
  const BOLT_COUNT = 4;
  const bolts = Array.from({ length: BOLT_COUNT }, () => {
    const mat = new LineBasicMaterial({ color: baseColor.clone(), transparent: true, opacity: 0 });
    const line = new Line(new BufferGeometry(), mat);
    group.add(line);
    return { line, mat, flashStart: -1000, nextAt: Math.random() * 1200 };
  });
  const boltOrigin = new Vector3(0, 0, 0);
  function jaggedBoltPoints(): Vector3[] {
    const segs = 5;
    const az = Math.random() * Math.PI * 2;
    const r = 0.3 + Math.random() * 0.18;
    const end = new Vector3(Math.cos(az) * r, (Math.random() - 0.5) * 0.16, Math.sin(az) * r);
    const pts: Vector3[] = [boltOrigin.clone()];
    for (let i = 1; i < segs; i++) {
      const p = new Vector3().lerpVectors(boltOrigin, end, i / segs);
      p.x += (Math.random() - 0.5) * 0.07;
      p.y += (Math.random() - 0.5) * 0.07;
      p.z += (Math.random() - 0.5) * 0.07;
      pts.push(p);
    }
    pts.push(end);
    return pts;
  }
  const FLASH_MS = 130;

  const m4 = new Matrix4();
  group.userData.kind = "hub-core";
  group.userData.hub = {
    tick(now: number, targetColor: Color) {
      tmpColor.copy(baseColor).lerp(targetColor, 0.7);
      parts.forEach((p, i) => {
        const az = p.az + now * p.speed;
        m4.makeScale(p.scale, p.scale, p.scale);
        m4.setPosition(p.rad * Math.cos(az), p.y, p.rad * Math.sin(az));
        inst.setMatrixAt(i, m4);
        inst.setColorAt(i, tmpColor);
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;

      coreMat.color.copy(tmpColor);
      coreGlowMat.color.copy(tmpColor);
      outerGlowMat.color.copy(tmpColor);
      ringMat1.color.copy(tmpColor);
      ringMat2.color.copy(tmpColor);
      core.rotation.y = now * 0.0007;
      core.rotation.x = now * 0.0004;
      const pulse = 1 + Math.sin(now / 500) * 0.08;
      coreGlow.scale.setScalar(pulse);
      outerGlow.scale.setScalar(1 + Math.sin(now / 700 + 1.4) * 0.12);
      ring1.rotation.z = now * 0.0009;
      ring2.rotation.z = -now * 0.0006;

      for (const bolt of bolts) {
        if (now >= bolt.nextAt && now >= bolt.flashStart + FLASH_MS) {
          bolt.line.geometry.dispose();
          bolt.line.geometry = new BufferGeometry().setFromPoints(jaggedBoltPoints());
          bolt.flashStart = now;
          bolt.nextAt = now + FLASH_MS + 350 + Math.random() * 1400;
        }
        const since = now - bolt.flashStart;
        bolt.mat.opacity = since >= 0 && since < FLASH_MS ? (1 - since / FLASH_MS) * 0.9 : 0;
        bolt.mat.color.copy(tmpColor);
      }
    },
  };
  return group;
}

function plant(opts: SceneObjectOpts): Object3D {
  const group = new Group();
  const pot = new Mesh(
    new CylinderGeometry(0.14, 0.11, 0.22, 8),
    new MeshLambertMaterial({ color: "#6b4a34" }),
  );
  pot.position.y = 0.11;
  group.add(pot);
  // A small cluster of overlapping foliage clumps reads as a plant far better
  // than a single cone (which just looks like a sharp spike at this scale).
  const leafMat = new MeshLambertMaterial({ color: new Color(opts.color ?? "#3f7a45") });
  const clumps: [number, number, number, number][] = [
    [0, 0.34, 0, 0.16], [0.09, 0.42, 0.04, 0.12], [-0.08, 0.4, -0.05, 0.12], [0.02, 0.5, -0.02, 0.1],
  ];
  for (const [dx, dy, dz, r] of clumps) {
    const clump = new Mesh(new IcosahedronGeometry(r, 0), leafMat);
    clump.position.set(dx, dy, dz);
    group.add(clump);
  }
  group.userData.kind = "plant";
  return group;
}

// Boardroom (hub shortcut to Board Meeting) — an oval table, a ring of
// chairs, and a low circular wall + floor patch so this reads as its own
// room rather than a bare disc floating at the hub. Table/chair proportions
// are hand-picked, not derived from any real furniture spec.
const BOARDROOM_RADIUS_X = 0.95, BOARDROOM_RADIUS_Z = 0.55;
const BOARDROOM_WALL_RADIUS = 1.3;
function meetingTable(opts: SceneObjectOpts): Object3D {
  const group = new Group();
  const accent = new Color(opts.color ?? "#7d57f6");
  const isLight = opts.theme === "light";

  // Floor patch — a neutral disc distinct from the hallway ground, so the
  // boardroom reads as its own space at a glance. Warm dark wood at night,
  // a light warm wood tone under daylight so it doesn't look like a hole.
  const floor = new Mesh(
    new CylinderGeometry(BOARDROOM_WALL_RADIUS - 0.05, BOARDROOM_WALL_RADIUS - 0.05, 0.04, 32),
    new MeshLambertMaterial({ color: isLight ? "#e5d9c3" : "#2a2620" }),
  );
  floor.position.y = 0.02;
  group.add(floor);

  // Low circular wall — a ring of short tangential segments, same height as
  // a department room-wall so the isometric camera still looks over it.
  const wallH = 0.18, wallSegs = 20;
  const wallMat = new MeshLambertMaterial({ color: isLight ? "#aeb6c4" : "#3a3f4a" });
  const chord = 2 * BOARDROOM_WALL_RADIUS * Math.sin(Math.PI / wallSegs) * 1.05;
  for (let i = 0; i < wallSegs; i++) {
    const mid = ((i + 0.5) / wallSegs) * Math.PI * 2;
    const seg = new Mesh(new BoxGeometry(chord, wallH, 0.06), wallMat);
    seg.position.set(Math.cos(mid) * BOARDROOM_WALL_RADIUS, wallH / 2, Math.sin(mid) * BOARDROOM_WALL_RADIUS);
    seg.rotation.y = -mid + Math.PI / 2;
    group.add(seg);
  }

  // Oval table top — a circular slab stretched on X so it reads as a
  // boardroom table rather than a round cafe table.
  const top = new Mesh(new CylinderGeometry(1, 1, 0.08, 28), new MeshLambertMaterial({ color: "#6b4a34" }));
  top.scale.set(BOARDROOM_RADIUS_X, 1, BOARDROOM_RADIUS_Z);
  top.position.y = 0.5;
  group.add(top);
  // Accent trim ring under the top, in the hub/brand color.
  const trim = new Mesh(new CylinderGeometry(1, 1, 0.03, 28), new MeshLambertMaterial({ color: accent }));
  trim.scale.set(BOARDROOM_RADIUS_X * 1.02, 1, BOARDROOM_RADIUS_Z * 1.02);
  trim.position.y = 0.455;
  group.add(trim);
  const base = new Mesh(new CylinderGeometry(0.1, 0.16, 0.45, 12), new MeshLambertMaterial({ color: "#3a3f4a" }));
  base.position.y = 0.22;
  group.add(base);

  // Chairs — small seat + back pairs around the table's ellipse, each
  // facing the center.
  const chairCount = 6;
  const chairMat = new MeshLambertMaterial({ color: "#4a4f5c" });
  for (let i = 0; i < chairCount; i++) {
    const a = (i / chairCount) * Math.PI * 2;
    const cx = Math.cos(a) * (BOARDROOM_RADIUS_X + 0.28), cz = Math.sin(a) * (BOARDROOM_RADIUS_Z + 0.28);
    const chair = new Group();
    const seat = new Mesh(new BoxGeometry(0.16, 0.05, 0.16), chairMat);
    seat.position.y = 0.24;
    chair.add(seat);
    const back = new Mesh(new BoxGeometry(0.16, 0.2, 0.03), chairMat);
    back.position.set(0, 0.36, -0.07);
    chair.add(back);
    const legGeo = new CylinderGeometry(0.012, 0.012, 0.24, 6);
    for (const [dx, dz] of [[-0.06, -0.06], [0.06, -0.06], [-0.06, 0.06], [0.06, 0.06]] as const) {
      const leg = new Mesh(legGeo, chairMat);
      leg.position.set(dx, 0.12, dz);
      chair.add(leg);
    }
    chair.position.set(cx, 0, cz);
    chair.lookAt(0, 0, 0);
    group.add(chair);
  }

  group.userData.kind = "meeting-table";
  group.userData.clickable = "board-meeting";
  return group;
}

// Naxie's front desk — a real desk (top + legs), not a floating slab, with a
// "COO" nameplate screen matching the department desks' own nameplate style.
function frontDesk(opts: SceneObjectOpts): Object3D {
  const group = new Group();
  const color = new Color(opts.color ?? "#7d57f6");
  const top = new Mesh(new BoxGeometry(1.6, 0.08, 0.6), new MeshLambertMaterial({ color }));
  top.position.y = 0.5;
  group.add(top);
  const legMat = new MeshLambertMaterial({ color: "#3a3f4a" });
  const legGeo = new CylinderGeometry(0.035, 0.035, 0.5, 6);
  for (const [dx, dz] of [[-0.7, -0.24], [0.7, -0.24], [-0.7, 0.24], [0.7, 0.24]] as const) {
    const leg = new Mesh(legGeo, legMat);
    leg.position.set(dx, 0.25, dz);
    group.add(leg);
  }
  const idleTex = nameplateTexture("COO", color);
  const plate = new Mesh(
    new PlaneGeometry(0.45, 0.45), // 1.5x the department desks' own 0.3x0.3 nameplate
    new MeshBasicMaterial({ map: idleTex, side: DoubleSide, transparent: true }),
  );
  plate.position.set(0, 0.79, -0.02);
  plate.rotation.x = -0.25;
  group.add(plate);
  group.userData.kind = "front-desk";
  return group;
}

// Low border wall around a room's footprint (F) — four thin strips forming a
// ring, short enough that the ~35deg isometric camera still sees over it into
// the room. opts.width/opts.depth are the room's floor footprint.
function roomWall(opts: SceneObjectOpts): Object3D {
  const w = Number(opts.width ?? 4);
  const d = Number(opts.depth ?? 4);
  const h = 0.18, t = 0.08;
  const mat = new MeshLambertMaterial({ color: new Color(opts.color ?? "#8a8f9c").offsetHSL(0, 0, -0.2) });
  const group = new Group();
  const north = new Mesh(new BoxGeometry(w, h, t), mat);
  north.position.set(0, h / 2, -d / 2);
  const south = north.clone(); south.position.z = d / 2;
  const east = new Mesh(new BoxGeometry(t, h, d), mat);
  east.position.set(w / 2, h / 2, 0);
  const west = east.clone(); west.position.x = -w / 2;
  group.add(north, south, east, west);
  group.userData.kind = "room-wall";
  return group;
}

// Stuck-job warning marker (4B/7D) — a canvas-drawn amber triangle with an
// exclamation mark, shown above a desk whose job has run unusually long.
// Deliberately a different shape/color from the plain busy-status sphere so
// the two states are never confused at a glance.
let warnTexCache: CanvasTexture | null = null;
function warnMarkerTexture(): CanvasTexture {
  if (warnTexCache) return warnTexCache;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.moveTo(size / 2, 10);
  ctx.lineTo(size - 12, size - 14);
  ctx.lineTo(12, size - 14);
  ctx.closePath();
  ctx.fillStyle = "#f2b84b";
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#151414";
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.fillStyle = "#151414";
  ctx.font = "900 58px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", size / 2, size * 0.66);
  warnTexCache = new CanvasTexture(canvas);
  warnTexCache.needsUpdate = true;
  return warnTexCache;
}
function warnMarker(): Object3D {
  const sprite = new Sprite(new SpriteMaterial({ map: warnMarkerTexture(), depthTest: false, transparent: true }));
  sprite.scale.set(0.32, 0.32, 1);
  sprite.userData.kind = "warn-marker";
  return sprite;
}

// An original, abstract "peg-doll" mascot (G/7B) — sphere head on a
// neck-pivot group, a capsule torso, two shoulder-pivoted arm groups, two
// hip-pivoted leg groups, and a badge sphere in the department's accent
// color. No face, clothing, or other detail that could read as an existing
// character; purely geometric primitives. The joint groups are exposed on
// `userData.joints` so OfficeScene's tick loop can drive a walk cycle and
// simple work poses (typing/idle bob) by rotating them directly, rather
// than only translating the whole avatar as v1 did.
function avatar(opts: SceneObjectOpts): Object3D {
  const bodyColor = opts.avatarColor instanceof Color ? opts.avatarColor : colorFromName(String(opts.label ?? "?"));
  const skinColor = bodyColor.clone().offsetHSL(0, 0, 0.12);
  const group = new Group();

  const torso = new Mesh(new CapsuleGeometry(0.085, 0.14, 4, 8), new MeshLambertMaterial({ color: bodyColor }));
  torso.position.y = 0.28;
  group.add(torso);

  // Head pivots at a neck joint (its own Group) so it can tilt/nod
  // independently of the torso.
  const headJoint = new Group();
  headJoint.position.y = 0.4;
  const head = new Mesh(new SphereGeometry(0.085, 12, 12), new MeshLambertMaterial({ color: skinColor }));
  head.position.y = 0.09;
  headJoint.add(head);
  group.add(headJoint);

  if (opts.badgeColor) {
    const badge = new Mesh(new SphereGeometry(0.032, 8, 8), new MeshLambertMaterial({ color: new Color(opts.badgeColor as any) }));
    badge.position.set(0, 0.31, 0.09);
    group.add(badge);
  }

  // Arms — each a shoulder-pivot Group containing an offset capsule, so
  // rotating the joint swings the whole limb from the shoulder.
  const armGeo = new CapsuleGeometry(0.028, 0.14, 3, 6);
  const armMat = new MeshLambertMaterial({ color: bodyColor.clone().offsetHSL(0, 0, -0.05) });
  function makeArm(side: 1 | -1): Group {
    const shoulder = new Group();
    shoulder.position.set(side * 0.1, 0.36, 0);
    const arm = new Mesh(armGeo, armMat);
    arm.position.y = -0.08;
    shoulder.add(arm);
    return shoulder;
  }
  const armL = makeArm(-1), armR = makeArm(1);
  group.add(armL, armR);

  // Legs — hip-pivot Groups, same pattern as the arms.
  const legGeo = new CapsuleGeometry(0.032, 0.16, 3, 6);
  const legMat = new MeshLambertMaterial({ color: "#3a3f4a" });
  function makeLeg(side: 1 | -1): Group {
    const hip = new Group();
    hip.position.set(side * 0.045, 0.2, 0);
    const leg = new Mesh(legGeo, legMat);
    leg.position.y = -0.09;
    hip.add(leg);
    return hip;
  }
  const legL = makeLeg(-1), legR = makeLeg(1);
  group.add(legL, legR);

  // Overhead name tag — billboarded above the head, drawn with depthTest off
  // (like warn-marker) so it never gets clipped behind a desk or wall when
  // the avatar walks past one.
  if (opts.label) {
    const tagTex = nameTagTexture(String(opts.label));
    const tagAspect = tagTex.image.width / tagTex.image.height;
    const tagHeight = 0.13;
    const tag = new Sprite(new SpriteMaterial({ map: tagTex, depthTest: false, transparent: true }));
    tag.scale.set(tagHeight * tagAspect, tagHeight, 1);
    tag.position.set(0, 0.58, 0);
    tag.renderOrder = 999;
    group.add(tag);
  }

  // Scaled up 1.75x on request — everything above (including the name tag,
  // whose Sprite size follows the parent's world scale) grows together, feet
  // stay planted at y=0 since every part was built at or above the origin.
  group.scale.setScalar(1.75);

  group.userData.kind = "avatar";
  group.userData.joints = { headJoint, armL, armR, legL, legR };
  return group;
}

registerSceneObject("desk", desk);
registerSceneObject("warn-marker", warnMarker);
registerSceneObject("plant", plant);
registerSceneObject("meeting-table", meetingTable);
registerSceneObject("front-desk", frontDesk);
registerSceneObject("room-wall", roomWall);
registerSceneObject("avatar", avatar);
registerSceneObject("hub-core", hubCore);
