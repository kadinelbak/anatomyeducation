// Writes tools/live/fixtures/gesture-flow.json from two-hands-probe.json (left hand points at the right forearm, right hand free).
// Loops every 8.5 s: 0-1.2 left hand raised open (choose the pointing hand), 1.2-3.5 original frames (right hand a fist),
// 3.5-4.6 right hand one finger (CT), 4.6-7.0 right fist with 5-frame (167 ms) blinks at 5.0 s and 6.0 s (next structure), 7.0-8.5 both hands fists (release).
// Finger geometry follows src/live/gestures.js (distances in pixel space).
//   node tools/live/make_gesture_fixture.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const src = JSON.parse(readFileSync(join(dir, "two-hands-probe.json"), "utf8"));
const { fps, width: W, height: H } = src;
const round = (v) => Math.round(v * 1e5) / 1e5;
const FINGERS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]; // mcp, pip, dip, tip
const CURL = [1.1, 1.0, 0.9], EXTEND = [1.5, 1.9, 2.3];

// Work in pixel space, write back normalized.
const toPx = (l) => ({ x: l.x * W, y: l.y * H });
function setPx(l, p) { l.x = round(p.x / W); l.y = round(p.y / H); }

function setFinger(lm, idx, extended) {
  const [mcp, pip, dip, tip] = FINGERS[idx];
  const w = toPx(lm[0]), m = toPx(lm[mcp]);
  const dx = m.x - w.x, dy = m.y - w.y;
  const k = extended ? EXTEND : CURL;
  [pip, dip, tip].forEach((i, j) => setPx(lm[i], { x: w.x + dx * k[j], y: w.y + dy * k[j] }));
}
function setThumb(lm, extended) {
  const w = toPx(lm[0]), m = toPx(lm[5]);
  const d = Math.hypot(m.x - w.x, m.y - w.y) || 1;
  if (extended) {
    // Perpendicular to wrist->index MCP, away from the palm centre (pinky side is opposite).
    const px = -(m.y - w.y) / d, py = (m.x - w.x) / d;
    const pk = toPx(lm[17]);
    const sgn = ((pk.x - m.x) * px + (pk.y - m.y) * py) > 0 ? -1 : 1;
    [[2, 0.35], [3, 0.7], [4, 1.1]].forEach(([i, f]) => setPx(lm[i], { x: m.x + sgn * px * d * f, y: m.y + sgn * py * d * f }));
  } else {
    [[2, 0.05], [3, 0.1], [4, 0.15]].forEach(([i, f]) => setPx(lm[i], { x: m.x + (w.x - m.x) * f, y: m.y + (w.y - m.y) * f }));
  }
}
// fingers: array of 4 booleans (index..pinky), thumb: boolean
function shape(hand, fingers, thumb) {
  fingers.forEach((e, i) => setFinger(hand.landmarks, i, e));
  setThumb(hand.landmarks, thumb);
}
const FIST = [[false, false, false, false], false], OPEN = [[true, true, true, true], true], ONE = [[true, false, false, false], false];
const clone = (o) => JSON.parse(JSON.stringify(o));

const total = Math.round(8.5 * fps);
const frames = [];
for (let n = 0; n < total; n++) {
  const t = n / fps;
  const f = clone(src.frames[n % src.frames.length]);
  const left = f.hands.find((h) => h.side === "left"), right = f.hands.find((h) => h.side === "right");
  let rightShape = FIST;
  if (t < 1.2) {
    const sh = f.pose.landmarks[11], w = toPx(left.landmarks[0]);
    const dx = sh.x - left.landmarks[0].x, dy = sh.y - 0.15 - left.landmarks[0].y;
    for (const l of left.landmarks) { l.x = round(l.x + dx); l.y = round(l.y + dy); }
    shape(left, ...OPEN);
  } else if (t < 3.5) rightShape = FIST;
  else if (t < 4.6) rightShape = ONE;
  else if (t < 7.0) rightShape = FIST;
  else { rightShape = FIST; shape(left, ...FIST); }   // 7.0 s on: two fists release the lock
  shape(right, ...rightShape);
  let blink = 0.05;
  for (const bt of [5.0, 6.0]) { const b = Math.round(bt * fps); if (n >= b && n < b + 5) blink = 0.9; }
  f.face = { blink: { left: blink, right: blink } };
  frames.push(f);
}
const out = join(dir, "gesture-flow.json");
writeFileSync(out, JSON.stringify({ name: "gesture-flow", fps, width: W, height: H, frames }));
console.log("wrote", out, frames.length, "frames");
