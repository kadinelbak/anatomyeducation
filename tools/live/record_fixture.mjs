// Writes synthetic Live-mode tracking fixtures (no camera needed).
//
//   node tools/live/record_fixture.mjs                 writes the two built-in fixtures to tools/live/fixtures/
//   node tools/live/record_fixture.mjs desc.json [out] writes one fixture from a landmark description
//
// FIXTURE SCHEMA (what src/live/tracking.js replays with createTracker({ fixture })):
//   { "name": str, "fps": 30, "width": 640, "height": 480, "frames": [ Frame, ... ] }
//   Frame = { "pose": null | { "landmarks": L[33], "world": L[33], "mask": null },
//             "face"?: { "blink": { "left": 0..1, "right": 0..1 } },   (1 = eye closed; absent = null)
//             "hands": [ { "side": "left"|"right", "score": 0..1, "landmarks": L[21], "world": L[21] } ] }
//   L = { x, y, z, v }: image space 0..1 over the un-mirrored frame (x to the image right), world in
//   metres. Sides are the USER's sides (a standing person facing the camera has their left hand on the
//   image right). BlazePose indices (11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips, 25/26
//   knees, 27/28 ankles); hand indices 0 wrist, 5 index MCP, 8 index fingertip. Frames loop on replay.
//
// LANDMARK DESCRIPTION (input of this script):
//   { name, frames, fps, jitter,
//     elbows:   { left:[x,y], right:[x,y] },
//     restWrist:{ left:[x,y], right:[x,y] },       // used by a hand that has no target
//     hands: { left:  { dir:[dx,dy], target?: { arm:"right"|"left", frac: n | [from,to] } },
//              right: { ... } } }
//   Optional "blinks": [[startMs, endMs], ...] adds face: { blink: { left, right } } to every frame: 0.9 on
//   frames whose time (index * 1000 / fps) is inside a range [start, end), 0.05 elsewhere. Without
//   "blinks" the frames have no face field.
//   A hand with a target gets its wrist placed so that its index fingertip rests on the named forearm
//   at frac (0 elbow .. 1 wrist; a pair is swept linearly over the frames). dir is the finger direction.
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const L = 0.09;           // hand length in image units (about 18 cm)
const WORLD = 2.06;       // metres per image unit (1.75 m person spans about 85% of frame height)

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2; }

// Hand points in local (u along the fingers, v across) units of L. Index finger extended, others curled.
const HAND_LOCAL = [
  [0, 0], [0.12, -0.12], [0.25, -0.22], [0.37, -0.30], [0.48, -0.36],
  [0.38, -0.10], [0.62, -0.10], [0.77, -0.10], [0.90, -0.10],
  [0.40, 0], [0.55, 0], [0.50, 0.02], [0.40, 0.03],
  [0.38, 0.09], [0.52, 0.09], [0.47, 0.09], [0.38, 0.09],
  [0.34, 0.17], [0.46, 0.17], [0.42, 0.17], [0.34, 0.17],
];
const unit = (d) => { const n = Math.hypot(d[0], d[1]); return [d[0] / n, d[1] / n]; };
// Offset from wrist to the index fingertip for direction d.
function tipOffset(d) { const [u, v] = HAND_LOCAL[8]; return [(d[0] * u - d[1] * v) * L, (d[1] * u + d[0] * v) * L]; }
function handPoints(w, d) {
  return HAND_LOCAL.map(([u, v]) => [w[0] + (d[0] * u - d[1] * v) * L, w[1] + (d[1] * u + d[0] * v) * L]);
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// Solve both wrists so that targeted fingertips rest on the other forearm.
function solveWrists(desc, k) {
  const E = { left: desc.elbows.left, right: desc.elbows.right };
  const W = { left: desc.restWrist.left, right: desc.restWrist.right };
  const dir = {}, frac = {}, off = {};
  for (const s of ["left", "right"]) {
    const h = desc.hands[s];
    dir[s] = unit(h.dir); off[s] = tipOffset(dir[s]);
    if (h.target) { const f = h.target.frac; frac[s] = Array.isArray(f) ? f[0] + (f[1] - f[0]) * k : f; }
  }
  const other = { left: "right", right: "left" };
  for (let it = 0; it < 30; it++) {
    for (const s of ["left", "right"]) {
      if (frac[s] === undefined) continue;
      const o = other[s], f = frac[s];
      const onForearm = [E[o][0] + f * (W[o][0] - E[o][0]), E[o][1] + f * (W[o][1] - E[o][1])];
      W[s] = [onForearm[0] - off[s][0], onForearm[1] - off[s][1]];
    }
  }
  return { E, W, dir };
}

export function buildFixture(desc) {
  const n = desc.frames, rand = rng(7), jit = desc.jitter ?? 0.0015;
  const j = () => rand() * jit;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? i / (n - 1) : 0;
    const { E, W, dir } = solveWrists(desc, k);
    const P = new Array(33).fill(0).map(() => [0.5, 0.5]);
    const set = (idx, x, y) => { P[idx] = [x, y]; };
    set(0, 0.5, 0.17); set(1, 0.515, 0.155); set(2, 0.525, 0.155); set(3, 0.535, 0.155);
    set(4, 0.485, 0.155); set(5, 0.475, 0.155); set(6, 0.465, 0.155); set(7, 0.55, 0.17); set(8, 0.45, 0.17);
    set(9, 0.515, 0.20); set(10, 0.485, 0.20);
    set(11, 0.58, 0.30); set(12, 0.42, 0.30);
    set(13, ...E.left); set(14, ...E.right); set(15, ...W.left); set(16, ...W.right);
    set(23, 0.56, 0.55); set(24, 0.44, 0.55); set(25, 0.57, 0.74); set(26, 0.43, 0.74);
    set(27, 0.575, 0.93); set(28, 0.425, 0.93); set(29, 0.58, 0.95); set(30, 0.42, 0.95); set(31, 0.60, 0.97); set(32, 0.40, 0.97);
    const hands = [];
    for (const side of ["left", "right"]) {
      const pts = handPoints(W[side], dir[side]);
      const hx = pts.reduce((a, p) => a + p[0], 0) / 21, hy = pts.reduce((a, p) => a + p[1], 0) / 21;
      const lm = pts.map(([x, y]) => ({ x: x + j(), y: y + j(), z: 0, v: 1 }));
      const world = pts.map(([x, y]) => ({ x: (x - hx) * WORLD, y: (y - hy) * WORLD, z: 0, v: 1 }));
      hands.push({ side, score: 0.95, landmarks: lm, world });
      const base = side === "left" ? 0 : 1; // pose hand points: 17/18 pinky, 19/20 index, 21/22 thumb
      set(17 + base, ...pts[17]); set(19 + base, ...pts[5]); set(21 + base, ...pts[4]);
    }
    const landmarks = P.map(([x, y], idx) => ({ x: x + (idx === 15 || idx === 16 ? 0 : j()), y: y + (idx === 15 || idx === 16 ? 0 : j()), z: 0, v: 0.99 }));
    // Pose wrists follow the (jittered) hand wrists so the two stay consistent.
    landmarks[15].x = hands[0].landmarks[0].x; landmarks[15].y = hands[0].landmarks[0].y;
    landmarks[16].x = hands[1].landmarks[0].x; landmarks[16].y = hands[1].landmarks[0].y;
    const world = landmarks.map((l) => ({ x: (l.x - 0.5) * WORLD, y: (l.y - 0.55) * WORLD, z: 0, v: l.v }));
    const r5 = (v) => Math.round(v * 1e5) / 1e5;
    const round = (a) => a.map((l) => ({ x: r5(l.x), y: r5(l.y), z: r5(l.z), v: l.v }));
    const frame = { pose: { landmarks: round(landmarks), world: round(world), mask: null },
      hands: hands.map((h) => ({ ...h, landmarks: round(h.landmarks), world: round(h.world) })) };
    if (desc.blinks) {
      const ms = i * 1000 / (desc.fps ?? 30);
      const v = desc.blinks.some(([a, b]) => ms >= a && ms < b) ? 0.9 : 0.05;
      frame.face = { blink: { left: v, right: v } };
    }
    frames.push(frame);
  }
  return { name: desc.name, fps: desc.fps ?? 30, width: 640, height: 480, frames };
}

const ARMS = { elbows: { left: [0.60, 0.44], right: [0.38, 0.44] }, restWrist: { left: [0.62, 0.58], right: [0.42, 0.58] } };
export const BUILTIN = [
  { name: "forearm-point", frames: 60, fps: 30, ...ARMS,
    hands: { left: { dir: [-1, 0.25], target: { arm: "right", frac: 0.4 } }, right: { dir: [0.1, 1] } } },
  { name: "two-hands-probe", frames: 90, fps: 30,
    elbows: { left: [0.62, 0.50], right: [0.45, 0.66] }, restWrist: { left: [0.50, 0.54], right: [0.55, 0.56] },
    hands: { left: { dir: [-1, 0.3], target: { arm: "right", frac: 0.4 } },
             right: { dir: [0.3, -1], target: { arm: "left", frac: [0, 1] } } } },
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [descFile, outDir] = process.argv.slice(2);
  const descs = descFile ? [JSON.parse(readFileSync(descFile, "utf8"))] : BUILTIN;
  const dir = outDir || OUT;
  mkdirSync(dir, { recursive: true });
  for (const d of descs) {
    const fx = buildFixture(d);
    const p = join(dir, d.name + ".json");
    writeFileSync(p, JSON.stringify(fx));
    const fl = (s, e, w) => Math.hypot(fx.frames[0].pose.landmarks[w].x - fx.frames[0].pose.landmarks[e].x, fx.frames[0].pose.landmarks[w].y - fx.frames[0].pose.landmarks[e].y);
    console.log(`wrote ${p} (${fx.frames.length} frames @ ${fx.fps} fps), forearm lengths L ${fl(0, 13, 15).toFixed(3)} R ${fl(0, 14, 16).toFixed(3)}`);
  }
}
