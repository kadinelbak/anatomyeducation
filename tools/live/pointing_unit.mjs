// Node unit test for src/live/pointing.js (no browser, no camera).
//   node tools/live/pointing_unit.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPointer } from "../../src/live/pointing.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const loadJson = async (u) => JSON.parse(readFileSync(join(root, u), "utf8"));
let failures = 0;
const check = (name, ok, extra = "") => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + extra}`); };

// A person standing, facing the camera, un-mirrored image: their LEFT side is on the image RIGHT.
// z: depth given to every landmark (0 = synthetic, depth check skipped); armsOut: calibration stance.
function pose({ back = false, z = 0, armsOut = false } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z, v: 1 }));
  const set = (i, x, y) => { lm[i] = { x, y, z, v: 1 }; };
  const L = back ? -1 : 1;               // facing away flips left/right in the image
  const X = (d) => 0.5 + L * d;
  set(0, 0.5, 0.15);
  for (const i of [1, 2, 3]) set(i, X(0.02), 0.13);
  for (const i of [4, 5, 6]) set(i, X(-0.02), 0.13);
  set(7, X(0.05), 0.14); set(8, X(-0.05), 0.14);
  set(9, X(0.01), 0.18); set(10, X(-0.01), 0.18);
  set(11, X(0.1), 0.3); set(12, X(-0.1), 0.3);
  set(13, X(0.15), 0.45); set(14, X(-0.15), 0.45);
  set(15, X(0.18), 0.6); set(16, X(-0.18), 0.6);
  for (const i of [17, 19, 21]) set(i, X(0.19), 0.64);
  for (const i of [18, 20, 22]) set(i, X(-0.19), 0.64);
  set(23, X(0.06), 0.55); set(24, X(-0.06), 0.55);
  set(25, X(0.07), 0.75); set(26, X(-0.07), 0.75);
  set(27, X(0.07), 0.92); set(28, X(-0.07), 0.92);
  set(29, X(0.07), 0.95); set(30, X(-0.07), 0.95);
  set(31, X(0.1), 0.96); set(32, X(-0.1), 0.96);
  if (armsOut) {
    set(13, X(0.25), 0.3); set(14, X(-0.25), 0.3);
    set(15, X(0.4), 0.3); set(16, X(-0.4), 0.3);
    for (const i of [17, 19, 21]) set(i, X(0.44), 0.3);
    for (const i of [18, 20, 22]) set(i, X(-0.44), 0.3);
  }
  return lm;
}
// A hand whose index tip is at (tx, ty), pointing along +x; extended=false curls the index too.
function hand(side, tx, ty, extended = true) {
  const w = { x: tx - 0.1, y: ty };
  const lm = Array.from({ length: 21 }, () => ({ x: w.x, y: w.y, z: 0, v: 1 }));
  const set = (i, dx, dy) => { lm[i] = { x: w.x + dx, y: w.y + dy, z: 0, v: 1 }; };
  set(5, 0.04, -0.012); set(9, 0.04, -0.004); set(13, 0.04, 0.004); set(17, 0.04, 0.012);
  set(8, extended ? 0.1 : 0.045, 0);
  set(12, 0.045, -0.004); set(16, 0.045, 0.004); set(20, 0.045, 0.012);
  return { side, landmarks: lm, world: lm, score: 1 };
}
const frame = (t, h, opts = {}) => {
  const lm = pose(opts);
  if (opts.lm) for (const [i, v] of Object.entries(opts.lm)) lm[i] = { ...lm[i], ...v };
  return { t, width: 1000, height: 1000, pose: { landmarks: lm, world: [], mask: opts.mask || null }, hands: h ? [h] : [] };
};
// 40% along the right forearm (elbow 14 at (0.35, 0.45), wrist 16 at (0.32, 0.6)).
const FORE = { x: 0.35 + 0.4 * (0.32 - 0.35), y: 0.45 + 0.4 * 0.15 };

const ptr = await createPointer({ segmentsUrl: "assets/live/segments.json", loadJson });
const fresh = () => createPointer({ segmentsUrl: "assets/live/segments.json", loadJson });

// 1. 40% along the right forearm. The right elbow (14) is at x 0.35, the wrist (16) at x 0.32, y 0.45 -> 0.6.
{
  const p = await fresh();
  const tip = { x: 0.35 + 0.4 * (0.32 - 0.35), y: 0.45 + 0.4 * 0.15 };
  const r = p.update(frame(0, hand("left", tip.x, tip.y)));
  check("forearm: found", !!r, JSON.stringify(r));
  check("forearm: segment", r?.segment === "forearm", r?.segment);
  check("forearm: side right", r?.side === "right", r?.side);
  check("forearm: frac 0.35-0.45", r && r.frac > 0.35 && r.frac < 0.45, r?.frac);
  check("forearm: facing front", r?.facing === "front", r?.facing);
  check("forearm: label", r?.region.label === "Right forearm", r?.region.label);
  check("forearm: headline first", r?.structures[0].key === "radius" && r.structures.some((s) => s.key === "median_nerve" && s.layer === "nerve"), JSON.stringify(r?.structures.map((s) => s.key)));
  check("forearm: no duplicate keys", r && new Set(r.structures.map((s) => s.key)).size === r.structures.length);
  check("forearm: outline 12 points", p.outline(frame(0, null), "forearm", "right").length === 12);
  // off to the lateral side of the same forearm is a flank, not the front
  const side = p.update(frame(100, hand("left", tip.x - 0.05, tip.y)));
  check("forearm: flank aspect outer", side?.segment === "forearm" && side.aspect === "outer", side?.aspect);
}
// 2. left forearm with the right hand (parity)
{
  const p = await fresh();
  const r = p.update(frame(0, hand("right", 0.65 + 0.4 * 0.03, 0.51)));
  check("left forearm: side left", r?.segment === "forearm" && r.side === "left", JSON.stringify([r?.segment, r?.side]));
}
// 3. chest -> trunk thorax
{
  const p = await fresh();
  const r = p.update(frame(0, hand("left", 0.5, 0.38)));
  check("chest: trunk", r?.segment === "trunk" && r.side === null, r?.segment);
  check("chest: thorax band", r?.region.key === "thorax" && r.region.model === "trunk", JSON.stringify(r?.region));
  const ab = (await fresh()).update(frame(0, hand("left", 0.5, 0.48)));
  check("abdomen band", ab?.region.key === "abdomen", JSON.stringify(ab?.region));
  const bk = (await fresh()).update(frame(0, hand("left", 0.5, 0.38), { back: true }));
  check("back: facing back -> back region", bk?.facing === "back" && bk.region.key === "back" && bk.aspect === "back", JSON.stringify([bk?.facing, bk?.region]));
}
// 4. head and neck
{
  const h = (await fresh()).update(frame(0, hand("left", 0.5, 0.07)));
  check("head: skull", h?.segment === "head" && h.region.key === "skull", JSON.stringify([h?.segment, h?.region]));
  const n = (await fresh()).update(frame(0, hand("left", 0.5, 0.27)));
  check("neck", n?.segment === "neck", n?.segment);
}
// 5. far away, not extended, outside the mask, outside the frame, no pose
{
  const p = await fresh();
  check("far from body -> null", p.update(frame(0, hand("left", 0.9, 0.05))) === null);
  check("curled index -> null", (await fresh()).update(frame(0, hand("left", 0.5, 0.38, false))) === null);
  const mask = { width: 10, height: 10, data: new Uint8Array(100) };   // empty person mask
  check("outside mask -> null", (await fresh()).update(frame(0, hand("left", 0.5, 0.38), { mask })) === null);
  mask.data.fill(255);
  check("inside mask -> hit", (await fresh()).update(frame(0, hand("left", 0.5, 0.38), { mask }))?.segment === "trunk");
  check("no pose -> null", (await fresh()).update({ t: 0, width: 1000, height: 1000, pose: null, hands: [hand("left", 0.5, 0.38)] }) === null);
  check("no hands -> null", (await fresh()).update(frame(0, null)) === null);
}
// 6. lock: progress climbs, locked (and its alias stable) after 900 ms on the same segment; a move
//    to another band of the locked segment refines the region without unlocking
{
  const p = await fresh();
  const rs = [];
  for (let t = 0; t <= 990; t += 33) rs.push([t, p.update(frame(t, hand("left", 0.5, 0.38)))]);
  const at = (t) => rs.find(([x]) => x === t)[1];
  check("stable/locked false at t=0", at(0).stable === false && at(0).locked === false && at(0).progress === 0);
  check("progress about 0.48 at 429 ms", Math.abs(at(429).progress - 429 / 900) < 1e-9, at(429).progress);
  check("not locked at 858 ms", at(858).locked === false && at(858).stable === false);
  check("locked after 900 ms", at(924).locked === true && at(924).stable === true && at(924).progress === 1 && p.locked === true, JSON.stringify(rs.map(([t, r]) => [t, r.locked])));
  check("coarse trunk", at(924).coarse?.segment === "trunk" && at(924).coarse.side === null && at(924).coarse.label === "Trunk", JSON.stringify(at(924).coarse));
  let r;
  for (let t = 1000; t <= 1200; t += 33) r = p.update(frame(t, hand("left", 0.5, 0.48)));
  check("moved band: new region, still locked", r?.region.key === "abdomen" && r.segment === "trunk" && r.locked === true, JSON.stringify([r?.region.key, r?.locked]));
}
// 7. every structure key in every headline exists in its model file
{
  const seg = JSON.parse(readFileSync(join(root, "assets/live/segments.json"), "utf8")).segments;
  const cfg = (await import("../../src/config.js")).CONFIG.models;
  let missing = [];
  for (const [id, s] of Object.entries(seg)) {
    const m = JSON.parse(readFileSync(join(root, cfg[s.model === "arm" ? "upper-limb" : s.model].structuresUrl), "utf8"));
    for (const b of s.bands) {
      for (const k of Object.values(b.headline).flat()) if (!(k in m.structures)) missing.push(`${id}:${k}`);
      for (const r of [b.region, b.backRegion].flat().flatMap((x) => (x && typeof x === "object" ? Object.values(x) : [x])).filter(Boolean)) if (!m.regions[r]) missing.push(`${id}:region ${r}`);
    }
  }
  check("all headline and region keys exist", missing.length === 0, missing.join(", "));
}
// 8. hysteresis: the leader holds beyond the seek radius, and boundary jitter does not flip it
{
  // lateral of the right forearm axis at 40%, in radii (radius 0.35 * 200 px = 70 px)
  const n = { x: -150 / Math.hypot(30, 150), y: -30 / Math.hypot(30, 150) };
  const far = (k) => ({ x: FORE.x + (n.x * k * 70) / 1000, y: FORE.y + (n.y * k * 70) / 1000 });
  check("1.6 r from a fresh start -> null", (await fresh()).update(frame(0, hand("left", far(1.6).x, far(1.6).y))) === null);
  const p = await fresh();
  p.update(frame(0, hand("left", FORE.x, FORE.y)));
  const held = p.update(frame(33, hand("left", far(1.6).x, far(1.6).y)));
  check("...but the leader holds it at 1.6 r", held?.segment === "forearm" && held.side === "right", JSON.stringify([held?.segment, held?.side]));
  check("beyond HOLD * SEEK (2 r) -> released", p.update(frame(66, hand("left", far(2.0).x, far(2.0).y))) === null);
  // near the elbow: A is nearer the upper arm, B nearer the forearm, but not clearly (ratio > 0.6)
  const q = await fresh();
  const segs = [];
  for (let k = 0; k < 16; k++) {
    const [x, y] = k % 2 ? [0.325, 0.465] : [0.33, 0.43];
    segs.push(q.update(frame(k * 33, hand("left", x, y)))?.segment);
  }
  check("jitter at the elbow keeps the upper arm", segs.every((s) => s === "upper_arm"), segs.join(","));
  // a clearly better segment takes over: from the forearm to the middle of the chest
  const w = await fresh();
  w.update(frame(0, hand("left", FORE.x, FORE.y)));
  let r;
  for (let t = 33; t <= 330; t += 33) r = w.update(frame(t, hand("left", 0.5, 0.38)));
  check("clearly better segment wins", r?.segment === "trunk", r?.segment);
  // the fine fields refine while the coarse key stays
  const f = await fresh();
  f.update(frame(0, hand("left", FORE.x, FORE.y)));
  const r2 = f.update(frame(33, hand("left", 0.35 + 0.8 * (0.32 - 0.35), 0.45 + 0.8 * 0.15)));
  check("frac refines from the tip", r2?.segment === "forearm" && r2.frac > 0.75 && r2.frac < 0.85, r2?.frac);
}
// 9. lock is frozen, then released after 1500 ms without a candidate; lock() / unlock()
{
  const p = await fresh();
  let r;
  for (let t = 0; t <= 990; t += 33) r = p.update(frame(t, hand("left", FORE.x, FORE.y)));
  check("forearm locked", r?.locked && r.segment === "forearm" && r.coarse.label === "Right forearm", JSON.stringify(r?.coarse));
  for (let t = 1023; t <= 1320; t += 33) r = p.update(frame(t, hand("left", 0.5, 0.38)));
  check("locked: pointing at the chest keeps the forearm", r?.segment === "forearm" && r.side === "right" && r.locked, r?.segment);
  r = p.update(frame(1353, hand("left", 0.35 + 0.8 * (0.32 - 0.35), 0.45 + 0.8 * 0.15)));
  check("locked: frac still refines", r?.segment === "forearm" && r.frac > 0.75 && r.frac < 0.85, r?.frac);
  for (let t = 1386; t <= 2800; t += 33) r = p.update(frame(t, null));
  check("locked: hand away < 1500 ms keeps the lock", r?.locked === true && p.locked === true, JSON.stringify(r?.locked));
  for (let t = 2833; t <= 2950; t += 33) r = p.update(frame(t, null));
  check("unlocked after 1500 ms without a candidate", r === null && p.locked === false);
  const after = p.update(frame(3000, hand("left", 0.5, 0.38)));
  check("after unlock a new segment can lead", after?.segment === "trunk" && after.locked === false && after.progress === 0, JSON.stringify([after?.segment, after?.progress]));
  // a tap locks the current leader at once; unlock() releases it
  const q = await fresh();
  check("lock() with no leader -> false", q.lock() === false);
  q.update(frame(0, hand("left", FORE.x, FORE.y)));
  check("lock() forces the lock", q.lock() === true && q.locked === true);
  r = q.update(frame(33, hand("left", 0.5, 0.38)));
  check("forced lock holds the forearm", r?.segment === "forearm" && r.locked && r.stable && r.progress === 1, JSON.stringify([r?.segment, r?.locked]));
  q.unlock();
  r = q.update(frame(66, hand("left", 0.5, 0.38)));
  check("unlock() releases", q.locked === false && r?.segment === "trunk" && r.locked === false, JSON.stringify([r?.segment, r?.locked]));
}
// 10. depth: the pose model's left index (19) at limb depth is accepted, 1.5 shoulder widths in front is rejected
{
  const body = 0.05, sw = 0.2;            // shoulder width in normalised units: |x11 - x12| = 0.2
  const opts = (dz, v = 1) => ({ z: body, lm: { 19: { x: FORE.x, y: FORE.y, z: body + dz, v } } });
  const ok = (await fresh()).update(frame(0, hand("left", FORE.x, FORE.y), opts(0)));
  check("depth: tip at limb level accepted", ok?.segment === "forearm", ok?.segment);
  const front = (await fresh()).update(frame(0, hand("left", FORE.x, FORE.y), opts(-1.5 * sw)));
  check("depth: tip 1.5 shoulder widths in front rejected", front === null, JSON.stringify(front?.segment));
  const low = (await fresh()).update(frame(0, hand("left", FORE.x, FORE.y), opts(-1.5 * sw, 0.1)));
  check("depth: low-visibility pose index skips the check", low?.segment === "forearm", low?.segment);
  const flat = (await fresh()).update(frame(0, hand("left", FORE.x, FORE.y), { lm: { 19: { x: FORE.x, y: FORE.y } } }));
  check("depth: all-zero z skips the check", flat?.segment === "forearm", flat?.segment);
}
// 11. calibration: measure() with a synthetic person mask, calibrate(), setCalibration()
{
  const p = await fresh();
  const down = p.measure(frame(0, null));
  check("measure: arms down -> hint", down.sample === null && /arms out/.test(down.hint), JSON.stringify(down));
  const noHips = p.measure(frame(0, null, { armsOut: true, lm: { 23: { v: 0 }, 24: { v: 0 } } }));
  check("measure: no hips -> step back", noHips.sample === null && /Step back/.test(noHips.hint), JSON.stringify(noHips));
  // a 500x500 mask (half the frame resolution) painted with capsules of known half-width, in shoulder widths
  const half = { upper_arm: 0.25, forearm: 0.2, thigh: 0.4, leg: 0.3 };
  const ends = { upper_arm: [[11, 13], [12, 14]], forearm: [[13, 15], [14, 16]], thigh: [[23, 25], [24, 26]], leg: [[25, 27], [26, 28]] };
  const lm = pose({ armsOut: true });
  const SW = 200, M = 500, data = new Uint8Array(M * M);
  const segD = (px, py, a, b) => {
    const ax = a.x * 1000, ay = a.y * 1000, dx = b.x * 1000 - ax, dy = b.y * 1000 - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const px = x * 2 + 1, py = y * 2 + 1;
    for (const [id, pairs] of Object.entries(ends)) for (const [i, j] of pairs) if (segD(px, py, lm[i], lm[j]) <= half[id] * SW) data[y * M + x] = 255;
  }
  const mask = { width: M, height: M, data };
  const m = p.measure(frame(0, null, { armsOut: true, mask }));
  check("measure: stance -> sample", m.sample && m.hint === null, JSON.stringify(m.hint));
  const wf = m.sample?.widths.forearm;
  check("measure: forearm width from mask", wf && Math.abs(wf.left - 0.4) < 0.03 && Math.abs(wf.right - 0.4) < 0.03, JSON.stringify(wf));
  check("measure: thigh width ignores the touching other thigh", Math.abs((m.sample?.widths.thigh?.left ?? 0) - 0.8) < 0.04, JSON.stringify(m.sample?.widths.thigh));
  check("measure: forearm length", Math.abs((m.sample?.lengths.forearm?.right ?? 0) - 0.75) < 1e-6, JSON.stringify(m.sample?.lengths.forearm));
  const noMask = p.measure(frame(0, null, { armsOut: true }));
  check("measure: no mask -> lengths only", noMask.sample && Object.keys(noMask.sample.widths).length === 0 && noMask.sample.lengths.upper_arm, JSON.stringify(noMask.sample));
  check("calibrate: fewer than 10 samples -> null", p.calibrate(Array(9).fill(m.sample)) === null);
  const cal = p.calibrate(Array(12).fill(m.sample));
  const near = (a, b, tol) => Math.abs(a - b) < tol;
  check("calibrate: radii from the median", cal && cal.version === 1 && typeof cal.at === "string" && near(cal.radii.forearm, 0.2, 0.015) && near(cal.radii.upper_arm, 0.25, 0.015) && near(cal.radii.thigh, 0.4, 0.02) && near(cal.radii.leg, 0.3, 0.015), JSON.stringify(cal));
  check("calibrate: lengths", cal && near(cal.lengths.forearm, 0.75, 1e-6), JSON.stringify(cal?.lengths));
  const thin = p.calibrate(Array(10).fill({ lengths: {}, widths: { forearm: { left: 0.05, right: 0.05 } } }));
  check("calibrate: clamps to 0.5x the default", near(thin?.radii.forearm, 0.175, 1e-9), thin?.radii.forearm);
  // setCalibration overrides the radius: the forearm outline narrows
  const width = () => { const o = p.outline(frame(0, null), "forearm", "right"); return Math.max(...o.map((q) => q.x)) - Math.min(...o.map((q) => q.x)); };
  const w0 = width();
  p.setCalibration(cal);
  check("getCalibration", p.getCalibration()?.radii.forearm === cal.radii.forearm);
  check("setCalibration narrows the outline", width() < w0, `${width()} vs ${w0}`);
  p.setCalibration(null);
  check("setCalibration(null) restores", p.getCalibration() === null && Math.abs(width() - w0) < 1e-9);
}
// 12. outlines(): every visible instance, labelled
{
  const p = await fresh();
  const all = p.outlines(frame(0, null));
  const ids = all.map((o) => `${o.id}|${o.side}`);
  check("outlines: all instances", all.length === 15 && ids.includes("forearm|right") && ids.includes("trunk|null") && ids.includes("head|null"), ids.join(","));
  check("outlines: labels and polygons", all.find((o) => o.id === "upper_arm" && o.side === "left")?.label === "Left upper arm" && all.every((o) => o.poly.length >= 4), JSON.stringify(all.map((o) => o.label)));
}
// 13. a hanging arm's index on its own thigh is resting: the other hand's point wins, but alone it still counts
{
  const two = { ...frame(0, hand("right", 0.435, 0.65)) };
  two.hands.push(hand("left", FORE.x, FORE.y));
  const r = (await fresh()).update(two);
  check("resting hand on the thigh loses to a real point", r?.segment === "forearm" && r.hand === "left", JSON.stringify([r?.segment, r?.hand]));
  const alone = (await fresh()).update(frame(0, hand("right", 0.435, 0.65)));
  check("resting hand alone still finds the thigh", alone?.segment === "thigh" && alone.side === "right", JSON.stringify([alone?.segment, alone?.side]));
}
// 14. retarget: locked on the forearm, the finger then holds on the trunk; the lock moves there after
//     RETARGET_MS (1500) plus a fresh LOCK_MS (900), without an explicit unlock.
{
  const p = await fresh();
  let t = 0, r = null;
  for (; t <= 1000; t += 33) r = p.update(frame(t, hand("left", FORE.x, FORE.y)));
  check("retarget: locked on the forearm first", r?.locked && r.segment === "forearm", JSON.stringify([r?.locked, r?.segment]));
  const trunk = { x: 0.5, y: 0.42 };
  let firstTrunk = null, lockedTrunk = null;
  for (; t <= 4000; t += 33) {
    r = p.update(frame(t, hand("left", trunk.x, trunk.y)));
    if (r?.segment === "trunk" && firstTrunk === null) firstTrunk = t;
    if (r?.segment === "trunk" && r.locked && lockedTrunk === null) lockedTrunk = t;
  }
  check("retarget: the trunk leads after about 1.5 s away", firstTrunk !== null && firstTrunk >= 1500 && firstTrunk < 2700, String(firstTrunk));
  check("retarget: the trunk locks about 0.9 s later", lockedTrunk !== null && lockedTrunk - firstTrunk >= 880 && lockedTrunk - firstTrunk < 1000, JSON.stringify([firstTrunk, lockedTrunk]));
}
// 14b. setHardLock(true): neither the no-candidate grace period nor a retarget ends the lock; unlock() does
{
  const p = await fresh();
  p.setHardLock(true);
  check("hardLock getter", p.hardLock === true);
  let t = 0, r = null;
  for (; t <= 1000; t += 33) r = p.update(frame(t, hand("left", FORE.x, FORE.y)));
  check("hard lock: locked on the forearm", r?.locked && r.segment === "forearm", JSON.stringify([r?.locked, r?.segment]));
  for (; t <= 5000; t += 33) r = p.update(frame(t, null));
  check("hard lock: 4 s without a candidate keeps the lock", r?.locked === true && r.segment === "forearm" && p.locked === true, JSON.stringify([r?.locked, r?.segment]));
  for (; t <= 10000; t += 33) r = p.update(frame(t, hand("left", 0.5, 0.42)));
  check("hard lock: 5 s on the trunk never retargets", r?.locked === true && r.segment === "forearm" && p.locked === true, JSON.stringify([r?.locked, r?.segment]));
  // the finger still scrubs the locked forearm on frames the seek filters reject (here: off the person mask)
  const off = { width: 4, height: 4, data: new Uint8Array(16) };
  r = p.update(frame(t += 33, hand("left", 0.35 + 0.8 * (0.32 - 0.35), 0.45 + 0.8 * 0.15), { mask: off }));
  check("hard lock: frac follows the finger past the seek filters", r?.locked && r.segment === "forearm" && r.frac > 0.75 && r.frac < 0.85, JSON.stringify([r?.segment, r?.frac]));
  r = p.update(frame(t += 33, hand("left", 0.35 + 0.2 * (0.32 - 0.35), 0.45 + 0.2 * 0.15), { mask: off }));
  check("hard lock: and back up the forearm", r?.locked && r.frac > 0.15 && r.frac < 0.25, JSON.stringify(r?.frac));
  // the finger far from the forearm still scrubs it (its projection onto the axis), and a frame without a
  // pose at all uses the segment's last seen geometry
  r = p.update(frame(t += 33, hand("left", 0.5, 0.45 + 0.7 * 0.15), { mask: off }));
  check("hard lock: a finger far off the forearm still scrubs it", r?.locked && r.segment === "forearm" && r.frac > 0.4 && r.frac < 0.6, JSON.stringify([r?.segment, r?.frac]));
  const noPose = { ...frame(t += 33, hand("left", 0.35 + 0.9 * (0.32 - 0.35), 0.45 + 0.9 * 0.15)), pose: null };
  r = p.update(noPose);
  check("hard lock: no pose this frame, frac still follows the finger", r?.locked && r.segment === "forearm" && r.frac > 0.85 && r.frac < 0.95, JSON.stringify([r?.segment, r?.frac]));
  p.unlock();
  r = p.update(frame(t, hand("left", 0.5, 0.42)));
  check("hard lock: unlock() releases, trunk can lead", p.locked === false && r?.segment === "trunk" && r.locked === false, JSON.stringify([r?.segment, r?.locked]));
}
// 14c. Hips out of view (seated at a desk): the trunk zone is estimated from the shoulders and still scrubs.
{
  const p = await fresh();
  p.setHardLock(true);
  const noHips = { lm: { 23: { v: 0.05 }, 24: { v: 0.05 } } };
  // Shoulders at y 0.3, half-width 0.1 (shoulder width 0.2): estimated hips land at y 0.55, like the real pose's.
  let t = 0, r = null;
  for (; t <= 1000; t += 33) r = p.update(frame(t, hand("left", 0.5, 0.4), noHips));
  check("no hips: trunk locks from the shoulders alone", r?.locked && r.segment === "trunk" && r.hipsEstimated === true, JSON.stringify([r?.locked, r?.segment, r?.hipsEstimated]));
  check("no hips: frac 0.4 at y 0.40", r && r.frac > 0.37 && r.frac < 0.43 && r.onSegment === true && r.bodySeen === true, JSON.stringify([r?.frac, r?.onSegment]));
  r = p.update(frame(t += 33, hand("left", 0.5, 0.5), noHips));
  check("no hips: frac follows the finger down to 0.8", r && r.frac > 0.77 && r.frac < 0.83, JSON.stringify(r?.frac));
  const withHips = (await fresh()).update(frame(0, hand("left", 0.5, 0.5)));
  check("no hips: matches the real hips' frac", withHips && Math.abs(withHips.frac - r.frac) < 0.03, JSON.stringify([withHips?.frac, r?.frac]));
  // A finger above the shoulders projects onto the top of the trunk (hard lock scrubs from anywhere).
  r = p.update(frame(t += 33, hand("left", 0.95, 0.05), noHips));
  check("above the shoulders: frac 0, still on segment", r?.locked && r.onSegment === true && r.bodySeen === true && r.frac === 0, JSON.stringify([r?.onSegment, r?.bodySeen, r?.frac]));
  // No pose at all (only a hand in front of the camera): the last seen trunk geometry still scrubs, bodySeen says the body was lost.
  const f = frame(t += 33, hand("left", 0.5, 0.5)); f.pose = null;
  r = p.update(f);
  check("no pose: frac follows the finger on the last trunk, bodySeen false", r?.locked && r.onSegment === true && r.bodySeen === false && r.frac > 0.77 && r.frac < 0.83, JSON.stringify([r?.locked, r?.onSegment, r?.bodySeen, r?.frac]));
  // No hand at all: nothing to refine from; the result is reused and says so.
  r = p.update(frame(t += 33, null, noHips));
  check("no hand: onSegment false, frac kept", r?.locked && r.onSegment === false && r.bodySeen === true && r.frac > 0.77 && r.frac < 0.83, JSON.stringify([r?.onSegment, r?.bodySeen, r?.frac]));
  p.unlock();
}
// 15. setPointerHand("left"): a pointing right hand is the control hand and is ignored
{
  const p = await fresh();
  p.setPointerHand("left");
  check("pointerHand getter", p.pointerHand === "left", String(p.pointerHand));
  const rightOnly = p.update(frame(0, hand("right", 0.5, 0.38)));
  check("pointerHand left: right hand alone ignored", rightOnly === null, JSON.stringify(rightOnly?.segment));
  const two = frame(33, hand("right", 0.5, 0.38));
  two.hands.push(hand("left", FORE.x, FORE.y));
  const r = p.update(two);
  check("pointerHand left: the left hand selects", r?.hand === "left" && r.segment === "forearm" && r.side === "right", JSON.stringify([r?.hand, r?.segment, r?.side]));
  let t = 66, last = r;
  for (; t <= 1200; t += 33) {
    const f = frame(t, hand("right", 0.5, 0.38));
    f.hands.push(hand("left", FORE.x, FORE.y));
    last = p.update(f);
  }
  check("pointerHand left: locks on the left hand's target", last?.locked && last.segment === "forearm", JSON.stringify([last?.locked, last?.segment]));
  for (; t <= 4500; t += 33) last = p.update(frame(t, hand("right", 0.5, 0.38)));
  check("pointerHand left: right hand never retargets", last === null || last.segment === "forearm", JSON.stringify(last?.segment));
  p.setPointerHand(null);
  check("pointerHand null: right hand points again", (await fresh()).update(frame(0, hand("right", 0.5, 0.38)))?.segment === "trunk" && p.pointerHand === null);
}
// 16. with a pointer hand set, that side's arm segments are not zones at all (no outline, no selection)
{
  const p = await fresh();
  p.setPointerHand("left");
  const f = frame(0, hand("right", 0.35 + 0.4 * (0.18 - 0.35), 0.45 + 0.4 * 0.15));   // right hand on the LEFT forearm
  const ids = p.outlines(f).map((o) => `${o.id}:${o.side}`);
  check("pointer arm not in outlines", !ids.includes("forearm:left") && !ids.includes("upper_arm:left") && !ids.includes("hand:left") && ids.includes("forearm:right"), ids.join(","));
  check("control hand cannot select at all", p.update(f) === null);
  p.setPointerHand(null);
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
