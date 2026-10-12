// Unit test for src/renderers/bmode.js on a synthetic body. Run: node tools/us_unit_test.mjs
import { createVolume } from "../src/volume.js";
import { skinContour, probePose, renderBMode, getLut, scanConvert, labelAtPixel } from "../src/renderers/bmode.js";

let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`); if (!ok) fails++; };

const [nx, ny, nz] = [60, 60, 40], SP = 3, RAD = 22;
const meta = {
  id: "fake", dims: [nx, ny, nz], spacing: [SP, SP, SP],
  structures: { 1: { key: "rib_test", name: "Test rod", group: "bone" }, 2: { key: "urinary_bladder", name: "Bladder", group: "organ" } },
};
const ct = new Int16Array(nx * ny * nz).fill(-1000), labels = new Uint8Array(nx * ny * nz);
const cx = 29.5, cy = 29.5;
for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  const idx = i + nx * (j + ny * k);
  if (Math.hypot(i - cx, j - cy) <= RAD) ct[idx] = 40;
  if (Math.hypot(i - cx, j - 40) <= 3) { ct[idx] = 900; labels[idx] = 1; }              // bone rod, anterior (+j)
  if (Math.hypot(i - 38, j - cy, k - 20) <= 6) { ct[idx] = 10; labels[idx] = 2; } // fluid sphere, patient's right (+i)
}
const vol = createVolume(meta, ct, labels);

const c = skinContour(vol, 20);
let maxErr = 0;
for (const p of c) maxErr = Math.max(maxErr, Math.abs(Math.hypot(p.i - cx, p.j - cy) - RAD));
check("skinContour has 360 points", c.length === 360);
check("skinContour on cylinder surface", maxErr <= 1.5, `max radius error ${maxErr.toFixed(2)} voxels`);
check("skinContour cached", skinContour(vol, 20) === c);

const out = {};
const opts = { rays: 192, samples: 256, sectorDeg: 70, depthMm: 100 };
// Anterior probe: central beam runs down +j to -j through the rod at j=40.
const poseA = probePose(vol, { frac: 0.5, angleDeg: 0, depthMm: 100 });
renderBMode(vol, poseA, out, opts);
let ms = Infinity;
for (let n = 0; n < 5; n++) { const t = performance.now(); renderBMode(vol, poseA, out, opts); ms = Math.min(ms, performance.now() - t); }
check("renderBMode under 60 ms", ms < 60, `${ms.toFixed(1)} ms`);
const S = opts.samples, mid = 96;
const labs = new Set(out.labels);
// Shadow: along the central ray, samples after the rod vs before it.
const rodIdx = []; for (let q = 0; q < S; q++) if (out.labels[mid * S + q] === 1) rodIdx.push(q);
check("bone rod on central ray", rodIdx.length > 0, `${rodIdx.length} samples`);
const q0 = rodIdx[0], q1 = rodIdx[rodIdx.length - 1];
const mean = (a, b) => { let s = 0; for (let q = a; q < b; q++) for (let r = mid - 3; r <= mid + 3; r++) s += out.fan[r * S + q]; return s / ((b - a) * 7); };
const before = mean(Math.max(0, q0 - 40), q0 - 2), after = mean(q1 + 15, Math.min(S, q1 + 55));
let surface = 0; for (let q = q0 - 3; q < q0 + 8; q++) surface = Math.max(surface, out.fan[mid * S + q]);
check("bone surface is bright", surface > 0.8, `surface ${surface.toFixed(2)}`);
check("shadow behind bone darker than before", after < before * 0.5, `before ${before.toFixed(3)} after ${after.toFixed(3)}`);

// Fluid: probe on the patient's right (270) hits the sphere at i=38.
const poseB = probePose(vol, { frac: 0.5, angleDeg: 270, depthMm: 100 });
const outB = {};
renderBMode(vol, poseB, outB, opts);
let fs = 0, fn = 0, ss = 0, sn = 0;
for (let q = 0; q < S; q++) {
  const l = outB.labels[mid * S + q], v = outB.fan[mid * S + q];
  if (l === 2) { fs += v; fn++; } else if (l === 0 && fn === 0 && q > 10 && v > 0) { ss += v; sn++; }
}
check("fluid sphere on central ray", fn > 0, `${fn} samples`);
check("fluid darker than soft tissue", fn > 0 && sn > 0 && fs / fn < 0.5 * (ss / sn), `fluid ${(fs / Math.max(fn, 1)).toFixed(3)} soft ${(ss / Math.max(sn, 1)).toFixed(3)}`);
const labsB = new Set(outB.labels);
check("labels fan contains 1 and 2 (across the two poses)", (labs.has(1) || labsB.has(1)) && (labs.has(2) || labsB.has(2)), `A:${[...labs]} B:${[...labsB]}`);
check("probeOnSlice reported", outB.probeOnSlice.k === 20 && Math.abs(outB.probeOnSlice.angleDeg - 270) < 1e-6);

// Same pose twice gives the identical frame (speckle stable); a shifted probe differs.
const again = renderBMode(vol, poseA, {}, opts);
let same = true; for (let n = 0; n < again.fan.length; n++) if (again.fan[n] !== out.fan[n]) { same = false; break; }
check("speckle stable for a still probe", same);

// Scan conversion and label lookup.
const target = { width: 512, height: 512, data: new Uint8ClampedArray(512 * 512 * 4) };
const lut = scanConvert(out.fan, 192, 256, 70, 100, target);
check("scanConvert LUT cached", getLut(512, 512, 192, 256, 70) === lut);
check("outside sector is black", target.data[0] === 0 && target.data[3] === 255 && labelAtPixel(lut, out.labels, 1, 500) === 0);
let found = 0; for (let y = 0; y < 512; y += 4) for (let x = 0; x < 512; x += 4) if (labelAtPixel(lut, out.labels, x, y) === 1) found++;
check("labelAtPixel finds the rod", found > 0, `${found} samples`);
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
