// Node unit test for src/live/gestures.js (no browser, no camera).
//   node tools/live/gestures_unit.mjs
import { createGestures, readHand } from "../../src/live/gestures.js";

let failures = 0;
const check = (name, ok, extra = "") => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + extra}`); };

const W = 1000, H = 1000;
// A synthetic hand built from the finger rule: wrist at (wx, wy) image space, fingers up (-y).
// fingers: which of index..pinky are extended; thumb: extended or curled. Pixel offsets from the wrist.
const MCP = { 5: [-30, -80], 9: [-10, -85], 13: [10, -82], 17: [30, -75] };
const CHAIN = { index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
function hand(side, { fingers = [], thumb = false, wx = 0.5, wy = 0.6 } = {}) {
  const px = Array.from({ length: 21 }, () => [0, 0]);
  for (const [name, [m, p, d, tip]] of Object.entries(CHAIN)) {
    const [mx, my] = MCP[m];
    const ext = fingers.includes(name);
    px[m] = [mx, my];
    px[p] = [1.4 * mx, 1.4 * my];
    px[d] = ext ? [1.7 * mx, 1.7 * my] : [1.3 * mx, 1.3 * my];
    px[tip] = ext ? [2.0 * mx, 2.0 * my] : [1.1 * mx, 1.1 * my];
  }
  px[1] = [-25, -20]; px[2] = [-45, -35];
  px[3] = thumb ? [-80, -35] : [-30, -50];
  px[4] = thumb ? [-110, -30] : [-10, -60];
  const lm = px.map(([x, y]) => ({ x: wx + x / W, y: wy + y / H, z: 0, v: 1 }));
  return { side, landmarks: lm, world: lm, score: 0.9 };
}
const ALL = ["index", "middle", "ring", "pinky"];
// Shoulders at y 0.3 (user's left, 11, on the image right).
function poseLms() {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, v: 1 }));
  lm[11] = { x: 0.6, y: 0.3, z: 0, v: 1 }; lm[12] = { x: 0.4, y: 0.3, z: 0, v: 1 };
  return lm;
}
const frame = (t, hands = [], { pose = true, blink = null } = {}) => ({
  t, width: W, height: H,
  pose: pose ? { landmarks: poseLms(), world: [] } : null,
  hands, face: blink ? { blink: { left: blink[0], right: blink[1] } } : null,
});
const fr = (h) => ({ width: W, height: H, pose: { landmarks: poseLms() }, hands: [h] });

// 1. finger counts 0..4, thumb curled and extended
for (let n = 0; n <= 4; n++) {
  for (const thumb of [false, true]) {
    const r = readHand(hand("right", { fingers: ALL.slice(0, n), thumb }), fr());
    check(`count ${n} thumb ${thumb ? "out" : "in"}: fingers ${n + (thumb ? 1 : 0)}`, r?.fingers === n + (thumb ? 1 : 0) && r.extended.thumb === thumb, JSON.stringify(r));
    const shape = n === 0 ? "fist" : n === 1 ? "point" : n === 4 && thumb ? "open" : "count";   // 4 with the thumb tucked is a count
    check(`count ${n} thumb ${thumb ? "out" : "in"}: shape ${shape}`, r?.shape === shape, r?.shape);
  }
}
// 2. point vs count-of-1 with the middle finger
{
  const p = readHand(hand("left", { fingers: ["index"] }), fr());
  const m = readHand(hand("left", { fingers: ["middle"] }), fr());
  check("index only = point", p?.shape === "point" && p.extended.index && !p.extended.middle, JSON.stringify(p));
  check("middle only = count", m?.shape === "count" && m.extended.middle && !m.extended.index, JSON.stringify(m));
  const g = createGestures();
  let c = null;
  for (let t = 0; t <= 700; t += 33) c = g.update(frame(t, [hand("left", { fingers: ["middle"] })]), { pointerHand: "right" }).count ?? c;
  check("middle only counts as 1", c === 1, String(c));
}
// 3. raised hand needs the pose shoulder
{
  const up = hand("right", { fingers: ALL, thumb: true, wy: 0.2 }), down = hand("right", { fingers: ALL, thumb: true, wy: 0.6 });
  const fist = hand("right", { fingers: [], wy: 0.2 });
  check("open above shoulder: raised", readHand(up, fr())?.raised === true);
  check("open below shoulder: not raised", readHand(down, fr())?.raised === false);
  check("fist above shoulder: not raised", readHand(fist, fr())?.raised === false);
  check("no pose: not raised", readHand(up, { width: W, height: H, pose: null })?.raised === false);
  const g = createGestures();
  const rs = [];
  for (let t = 0; t <= 700; t += 33) rs.push([t, g.update(frame(t, [up]), { pointerHand: null }).raised]);
  check("raised level only after holdMs", rs.filter(([t]) => t < 600).every(([, r]) => r === null) && rs.at(-1)[1] === "right", JSON.stringify(rs));
  const g2 = createGestures();
  let r2 = null;
  for (let t = 0; t <= 900; t += 33) r2 = g2.update(frame(t, [up], { pose: false }), {}).raised;
  check("raised needs the pose", r2 === null, String(r2));
}
// 4. count edge fires once after holdMs, again after the count changes
{
  const g = createGestures();
  const fired = [];
  let t = 0;
  for (; t <= 1500; t += 33) { const c = g.update(frame(t, [hand("left", { fingers: ["index", "middle"] })]), { pointerHand: "right" }).count; if (c !== null) fired.push([t, c]); }
  check("count 2 fires once after 600 ms", fired.length === 1 && fired[0][1] === 2 && fired[0][0] >= 600 && fired[0][0] < 640, JSON.stringify(fired));
  const t0 = t;
  for (; t <= t0 + 1000; t += 33) { const c = g.update(frame(t, [hand("left", { fingers: ["index", "middle", "ring"] })]), { pointerHand: "right" }).count; if (c !== null) fired.push([t - t0, c]); }
  check("count 3 fires after the change", fired.length === 2 && fired[1][1] === 3 && fired[1][0] >= 600, JSON.stringify(fired));
  const g2 = createGestures();
  let any = false;
  for (let t2 = 0; t2 <= 1000; t2 += 33) any ||= g2.update(frame(t2, [hand("left", { fingers: ["index", "middle"] })]), { pointerHand: null }).count !== null;
  check("no count without a pointer hand", !any);
  const g3 = createGestures();
  let pc = null;
  for (let t2 = 0; t2 <= 1000; t2 += 33) pc ??= g3.update(frame(t2, [hand("right", { fingers: ["index", "middle"] })]), { pointerHand: "right" }).count;
  check("the pointer hand never counts", pc === null, String(pc));
}
// 5. fist level after 300 ms; open level after openMs
{
  const g = createGestures();
  const fs = [];
  for (let t = 0; t <= 500; t += 33) fs.push([t, g.update(frame(t, [hand("left", { fingers: [], thumb: true })]), { pointerHand: "right" }).fist]);
  check("fist false before 300 ms", fs.filter(([t]) => t < 300).every(([, f]) => !f), JSON.stringify(fs));
  check("fist true after 300 ms", fs.filter(([t]) => t >= 300).every(([, f]) => f), JSON.stringify(fs));
  const r = g.update(frame(600, [hand("left", { fingers: ALL, thumb: true })]), { pointerHand: "right" });
  check("fist drops on another shape", r.fist === false && r.control?.side === "left" && r.control.shape === "open", JSON.stringify(r.control));
  const g2 = createGestures();
  const os = [];
  for (let t = 0; t <= 1200; t += 33) os.push([t, g2.update(frame(t, [hand("left", { fingers: ALL, thumb: true })]), { pointerHand: "right" }).open]);
  check("open false before 1000 ms", os.filter(([t]) => t < 1000).every(([, o]) => !o), JSON.stringify(os.filter(([, o]) => o)));
  check("open true after 1000 ms", os.at(-1)[1] === true);
}
// 6. blink: a 150 ms closure fires once on reopening; a 30 ms flicker and a 600 ms closure do not
function blinkRun(closedMs, step = 10) {
  const g = createGestures();
  const hits = [];
  for (let t = 0; t <= 2000; t += step) {
    const closed = t >= 500 && t < 500 + closedMs;
    if (g.update(frame(t, [], { blink: closed ? [0.9, 0.85] : [0.05, 0.1] }), {}).blink) hits.push(t);
  }
  return hits;
}
{
  const h150 = blinkRun(150);
  check("blink 150 ms fires once on reopening", h150.length === 1 && h150[0] === 650, JSON.stringify(h150));
  check("blink 30 ms flicker ignored", blinkRun(30).length === 0, JSON.stringify(blinkRun(30)));
  check("blink 900 ms closure ignored", blinkRun(900).length === 0, JSON.stringify(blinkRun(900)));
  const g = createGestures();
  let b = false;
  for (let t = 0; t <= 300; t += 10) b ||= g.update(frame(t, [], { blink: t < 150 ? [0.9, 0.9] : [0.0, 0.0] }), {}).blink;
  check("no blink without being open first", !b);
  const g2 = createGestures();
  let w = false;
  for (let t = 0; t <= 1000; t += 10) w ||= g2.update(frame(t, [], { blink: t >= 500 && t < 650 ? [0.9, 0.1] : [0.05, 0.1] }), {}).blink;
  check("one eye (wink) is not a blink", !w);
}
// 7. missing-frame tolerance: 2 missing frames keep the timer, 3 reset it
{
  const run = (gap) => {
    const g = createGestures();
    let first = null;
    for (let i = 0, t = 0; i < 40; i++, t += 33) {
      const missing = i >= 5 && i < 5 + gap;
      const c = g.update(frame(t, missing ? [] : [hand("left", { fingers: ["index", "middle"] })]), { pointerHand: "right" }).count;
      if (c !== null && first === null) first = t;
    }
    return first;
  };
  check("2 missing frames: count still at 600 ms", run(2) !== null && run(2) < 640, String(run(2)));
  check("3 missing frames: timer restarts", run(3) !== null && run(3) >= 8 * 33 + 600, String(run(3)));
  const g = createGestures();
  let f = false;
  for (let i = 0, t = 0; i < 20; i++, t += 33) f = g.update(frame(t, i === 10 || i === 11 ? [] : [hand("left", { fingers: [] })]), { pointerHand: "right" }).fist;
  check("fist survives 2 dropped frames", f === true);
}
// 8. hands map, control, reset
{
  const g = createGestures();
  const r = g.update(frame(0, [hand("left", { fingers: ["index"] }), hand("right", { fingers: ALL, thumb: true })]), { pointerHand: "left" });
  check("hands map both sides", r.hands.left?.shape === "point" && r.hands.right?.shape === "open");
  check("control is the other hand", r.control?.side === "right" && r.control.shape === "open");
  check("control null without pointerHand", g.update(frame(33, [hand("right", { fingers: ALL, thumb: true })]), {}).control === null);
  check("control null when absent", g.update(frame(66, [hand("left", { fingers: ["index"] })]), { pointerHand: "left" }).control === null);
  for (let t = 0; t <= 400; t += 33) g.update(frame(t, [hand("left", { fingers: [] })]), { pointerHand: "right" });
  g.reset();
  check("reset clears level signals", g.update(frame(433, [hand("left", { fingers: [] })]), { pointerHand: "right" }).fist === false);
}
// 9. raising is forgiving: thumb tucked still counts, and a 5-frame flicker of a curled finger does not reset
{
  const g = createGestures();
  let r = null;
  for (let t = 0; t <= 700; t += 33) {
    const flicker = t >= 300 && t < 300 + 5 * 33;
    r = g.update(frame(t, [hand("right", { fingers: flicker ? ALL.slice(0, 3) : ALL, thumb: false, wy: 0.2 })]), {});
  }
  check("raised with the thumb tucked and through a short flicker", r?.raised === "right", JSON.stringify(r?.raised));
}
// 10. twoFists: both hands fists for 600 ms, whichever hand points; one fist, or none chosen, is not enough
{
  const g = createGestures();
  let r = null, first = null;
  for (let t = 0; t <= 700; t += 33) {
    r = g.update(frame(t, [hand("left", { fingers: [] }), hand("right", { fingers: [] })]), { pointerHand: "left" });
    if (r.twoFists && first === null) first = t;
  }
  check("two fists held 600 ms -> twoFists", r?.twoFists === true && first !== null && first >= 600 && first < 640, String(first));
  check("twoFists also fires with no pointer hand chosen", (() => { const h = createGestures(); let x = null; for (let t = 0; t <= 700; t += 33) x = h.update(frame(t, [hand("left", { fingers: [] }), hand("right", { fingers: [] })]), {}); return x?.twoFists === true; })());
  const one = createGestures();
  let o = null;
  for (let t = 0; t <= 1000; t += 33) o = one.update(frame(t, [hand("left", { fingers: ["index"] }), hand("right", { fingers: [] })]), { pointerHand: "left" });
  check("pointing hand + control fist: fist true, twoFists false", o?.fist === true && o.twoFists === false, JSON.stringify([o?.fist, o?.twoFists]));
  let m = null;
  for (let t = 1033; t <= 2000; t += 33) m = one.update(frame(t, [hand("right", { fingers: [] })]), { pointerHand: "left" });
  check("one hand missing: twoFists false", m?.twoFists === false);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
