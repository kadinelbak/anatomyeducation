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
function pose({ back = false } = {}) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, v: 1 }));
  const set = (i, x, y) => { lm[i] = { x, y, z: 0, v: 1 }; };
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
const frame = (t, h, opts = {}) => ({ t, width: 1000, height: 1000, pose: { landmarks: pose(opts), world: [], mask: opts.mask || null }, hands: h ? [h] : [] });

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
// 6. stability: false at first, true after 400 ms in the same segment + band, false again on a change
{
  const p = await fresh();
  const flags = [];
  for (let t = 0; t <= 500; t += 33) flags.push([t, p.update(frame(t, hand("left", 0.5, 0.38)))?.stable]);
  check("stable false at t=0", flags[0][1] === false);
  check("stable false at 363 ms", flags.find(([t]) => t === 363)[1] === false);
  check("stable true after 400 ms", flags.find(([t]) => t === 429)[1] === true, JSON.stringify(flags));
  // a sustained move to the abdomen: votes flip within 8 frames, stability restarts
  let r;
  for (let t = 600; t <= 800; t += 33) r = p.update(frame(t, hand("left", 0.5, 0.48)));
  check("moved band: new region, not stable yet", r?.region.key === "abdomen" && r.stable === false, JSON.stringify([r?.region.key, r?.stable]));
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
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
