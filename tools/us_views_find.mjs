// Search probe poses that show named structures and write assets/ultrasound/views.json.
// Run: node tools/us_views_find.mjs [studyId ...]   (prints candidates, writes views.json for all studies when run bare)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createVolume } from "../src/volume.js";
import { probePose, renderBMode } from "../src/renderers/bmode.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STUDIES = ["ts-s1042", "ts-s1337", "ts-s1164", "ts-s0513", "ts-s1390", "ts-s1383"];

export function loadNode(id) {
  const dir = join(ROOT, "assets/volumes", id);
  const meta = JSON.parse(readFileSync(join(dir, "study.json"), "utf8"));
  const raw = (f) => { const b = gunzipSync(readFileSync(join(dir, f))); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const ct = new Int16Array(raw(meta.ct.file));
  const labels = new (meta.labels.dtype === "uint16" ? Uint16Array : Uint8Array)(raw(meta.labels.file));
  return createVolume(meta, ct, labels);
}

// angle: probe positions on the skin (deg); tilt: + is cranial; rot 0 transverse, 90 longitudinal.
const T = [
  { name: "subxiphoid", label: "Subxiphoid: heart and liver", req: ["heart", "liver"], opt: [], zkey: "heart", dz: [-0.12, 0.0], angle: [-20, 20, 5], rot: [0], tilt: [0, 10, 20, 30] },
  { name: "ruq", label: "RUQ: liver and right kidney (Morison's pouch lies between them)", req: ["liver", "kidney_right"], opt: [], zkey: "kidney_right", dz: [-0.05, 0.08], angle: [235, 305, 10], rot: [0, 90], tilt: [-10, 0, 10] },
  { name: "luq", label: "LUQ: spleen and left kidney", req: ["spleen", "kidney_left"], opt: [], zkey: "kidney_left", dz: [-0.03, 0.1], angle: [60, 150, 10], rot: [0, 90], tilt: [-10, 0, 10] },
  { name: "epigastric", depths: [12, 16], label: "Epigastric transverse: aorta, IVC, liver and pancreas", req: ["aorta", "inferior_vena_cava", "liver"], opt: ["pancreas"], zkey: "pancreas", dz: [-0.08, 0.1], angle: [-20, 20, 4], rot: [0], tilt: [-10, 0, 10, 20, 30] },
  { name: "aorta_long", depths: [12, 16], label: "Aorta longitudinal", req: ["aorta"], opt: ["liver", "inferior_vena_cava"], zkey: "aorta", zfrom: "liver", dz: [-0.25, 0.05], angle: [-10, 10, 5], rot: [90], tilt: [-10, 0, 10, 20] },
  { name: "suprapubic", depths: [12, 16], label: "Suprapubic: bladder", req: ["urinary_bladder"], opt: ["prostate"], zkey: "urinary_bladder", dz: [-0.03, 0.1], angle: [-8, 8, 4], rot: [0, 90], tilt: [-30, -20, -10, 0] },
  { name: "right_kidney_long", label: "Right flank longitudinal: right kidney and liver", req: ["kidney_right"], opt: ["liver"], zkey: "kidney_right", dz: [-0.03, 0.05], angle: [240, 300, 10], rot: [90], tilt: [-10, 0, 10] },
  { name: "left_kidney_long", label: "Left flank longitudinal: left kidney", req: ["kidney_left"], opt: ["spleen"], zkey: "kidney_left", dz: [-0.03, 0.05], angle: [70, 140, 10], rot: [90], tilt: [-10, 0, 10] },
  { name: "parasternal", label: "Parasternal: heart", req: ["heart"], opt: [], zkey: "heart", dz: [-0.08, 0.08], angle: [10, 60, 5], rot: [0, 45, 90], tilt: [-10, 0, 10] },
  { name: "gallbladder", depths: [12, 16], label: "Subcostal: gallbladder and liver", req: ["gallbladder", "liver"], opt: [], zkey: "gallbladder", dz: [-0.03, 0.05], angle: [290, 350, 10], rot: [0, 90], tilt: [-10, 0, 10, 20] },
  { name: "liver_intercostal", label: "Right intercostal: liver and hepatic vessels", req: ["liver"], opt: ["inferior_vena_cava", "portal_vein_and_splenic_vein"], zkey: "liver", dz: [-0.1, 0.1], angle: [250, 310, 10], rot: [0, 90], tilt: [-10, 0, 10] },
  { name: "epigastric_stomach", depths: [14, 16], label: "Epigastric: stomach and liver", req: ["stomach", "liver"], opt: ["aorta"], zkey: "stomach", dz: [-0.1, 0.1], angle: [-15, 20, 5], rot: [0, 90], tilt: [-10, 0, 10] },
  { name: "splenic", label: "Left posterior axillary: spleen", req: ["spleen"], opt: [], zkey: "spleen", dz: [-0.05, 0.05], angle: [90, 150, 10], rot: [90], tilt: [-10, 0, 10] },
];
const FLUID = /^(urinary_bladder|gallbladder|aorta|inferior_vena_cava|portal_vein_and_splenic_vein|heart)$/;
const range = (a, b, s) => { const r = []; for (let x = a; x <= b + 1e-9; x += s) r.push(x); return r; };

export function fractions(vol, out, keys) {
  const n = out.labels.length, cnt = {};
  for (const k of keys) cnt[k] = 0;
  const vals = Object.fromEntries(keys.map((k) => [vol.valueOf(k), k]));
  for (let i = 0; i < n; i++) { const k = vals[out.labels[i]]; if (k) cnt[k]++; }
  for (const k of keys) cnt[k] /= n;
  return cnt;
}

export function search(vol, t, rays = 96, samples = 128) {
  const has = (k) => vol.valueOf(k) !== undefined && vol.boundsOf(k);
  if (!t.req.every(has)) return null;
  const nz = vol.dims[2], zc = vol.boundsOf(t.zkey).centroid[2] / (nz - 1);
  const out = {};
  let best = null;
  const keys = [...t.req, ...t.opt.filter(has)];
  const lungVals = new Set([...vol.valueToKey].filter(([, k]) => /^(lung_|trachea)/.test(k)).map(([v]) => v));
  // Level range: where all required structures overlap in z (widened a little), else around zkey.
  let lo = Math.max(...t.req.map((k) => vol.boundsOf(k).min[2])) / (nz - 1), hi = Math.min(...t.req.map((k) => vol.boundsOf(k).max[2])) / (nz - 1);
  if (t.zfrom) { lo = vol.boundsOf(t.zfrom).min[2] / (nz - 1); hi = vol.boundsOf(t.zfrom).max[2] / (nz - 1); } else if (hi - lo < 0.02) { lo = zc + t.dz[0]; hi = zc + t.dz[1]; } else { lo -= 0.03; hi += 0.03; }
  const fstep = Math.max(1.5 / (nz - 1), (hi - lo) / 30);
  for (const frac of range(Math.max(0, lo), Math.min(1, hi), fstep))
    for (const angle of range(t.angle[0], t.angle[1], t.angle[2]))
      for (const rot of t.rot) for (const tilt of t.tilt) for (const dcm of t.depths || [16]) {
        const f = Math.max(0, Math.min(1, frac)), a = ((angle % 360) + 360) % 360;
        const pose = probePose(vol, { frac: f, angleDeg: a, tiltDeg: tilt, rotDeg: rot, depthMm: dcm * 10 });
        renderBMode(vol, pose, out, { rays, samples });
        const fr = fractions(vol, out, keys);
        if (!t.req.every((k) => fr[k] >= 0.02)) continue;
        let gas = 0, mean = 0; const lit = {};
        for (const k of keys) lit[k] = 0;
        for (let i = 0; i < out.labels.length; i++) {
          const l = out.labels[i]; mean += out.fan[i];
          if (lungVals.has(l)) gas++;
          const key = vol.keyOf(l); if (key in lit && out.fan[i] > 0.2) lit[key]++;
        }
        const n = out.labels.length; mean /= n;
        // Non-fluid structures must be visibly echogenic (not lost in a shadow); fluid ones are dark by nature.
        const echoKeys = t.req.filter((k) => !FLUID.test(k));
        if (!echoKeys.every((k) => lit[k] / n >= 0.02)) continue;
        let score = -0.6 * gas / n + 0.5 * echoKeys.reduce((a, k) => a + Math.min(lit[k] / n, 0.1), 0) + 0.3 * Math.min(mean, 0.3) + t.req.reduce((s, k) => s + Math.min(fr[k], 0.12), 0) + t.opt.reduce((s, k) => s + (fr[k] ? Math.min(fr[k], 0.06) * 0.5 : 0), 0);
        if (best === null || score > best.score) best = { score, depth: dcm, frac: +f.toFixed(3), angle: a, tilt, rot, fr };
      }
  return best;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ids = process.argv.length > 2 ? process.argv.slice(2) : STUDIES;
  const outFile = join(ROOT, "assets/ultrasound/views.json");
  const all = existsSync(outFile) && process.argv.length > 2 ? JSON.parse(readFileSync(outFile, "utf8")) : {};
  for (const id of ids) {
    const vol = loadNode(id);
    const views = {};
    for (const t of T) {
      const b = search(vol, t);
      if (!b) { console.log(id, t.name, "no pose shows it (or structure missing)"); continue; }
      if (!b) continue;
      console.log(id, t.name, JSON.stringify({ frac: b.frac, angle: b.angle, tilt: b.tilt, rot: b.rot }), Object.entries(b.fr).map(([k, v]) => `${k}=${(v * 100).toFixed(1)}%`).join(" "));
      if (Object.keys(views).length >= 8) continue;
      views[t.name] = { frac: b.frac, angle: b.angle, tilt: b.tilt, rot: b.rot, depth: b.depth, label: t.label, expect: Object.keys(b.fr).filter((k) => t.req.includes(k)) };
    }
    all[id] = views;
  }
  writeFileSync(outFile, JSON.stringify(all, null, 1) + "\n");
}
