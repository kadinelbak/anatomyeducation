// Node unit test for src/renderers/drr.js. Run from the app root: node tools/xray_unit_test.mjs
globalThis.window = globalThis.window || globalThis;
globalThis.location = globalThis.location || { href: "http://local/" };
const { createVolume } = await import("../src/volume.js");
const { projectDRR } = await import("../src/renderers/drr.js");

const nx = 40, ny = 30, nz = 50;
const ct = new Int16Array(nx * ny * nz).fill(-1000);
const labels = new Uint8Array(nx * ny * nz);
for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
  const idx = i + nx * (j + ny * k);
  if (Math.hypot(i - 10, j - 15) <= 6) { ct[idx] = 800; labels[idx] = 1; }        // bone cylinder along k
  else if (i >= 22 && i < 34 && j >= 8 && j < 22 && k >= 10 && k < 40) { ct[idx] = 40; labels[idx] = 2; } // soft block
}
const meta = { dims: [nx, ny, nz], spacing: [2, 2, 2],
  structures: { 1: { key: "bone_rod", name: "Bone rod", group: "bone" }, 2: { key: "block", name: "Block", group: "organ" } } };
const vol = createVolume(meta, ct, labels);

let fails = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fails++; };
for (const axis of ["ap", "lateral"]) {
  const d = projectDRR(vol, { axis });
  ok(d.width === (axis === "ap" ? nx : ny) && d.height === nz, `${axis}: dimensions ${d.width}x${d.height}`);
  ok(d.image.length === d.width * d.height && d.pick.length === d.image.length, `${axis}: array sizes`);
  const c1 = d.centroids.get(1), c2 = d.centroids.get(2);
  const at = (c) => Math.floor(c[1]) * d.width + Math.floor(c[0]);
  const bone = d.image[at(c1)], soft = d.image[at(c2)], air = d.image[0];
  ok(bone > soft && soft > air, `${axis}: bone ${bone.toFixed(3)} > soft ${soft.toFixed(3)} > air ${air.toFixed(3)}`);
  ok(d.pick[at(c1)] === 1, `${axis}: pick at bone centroid = ${d.pick[at(c1)]}`);
  // In the lateral view the bone rod overlaps the block, and bone outweighs it, so only AP checks the block pick.
  if (axis === "ap") ok(d.pick[at(c2)] === 2, `ap: pick at soft centroid = ${d.pick[at(c2)]}`);
  ok(d.pick[0] === 0, `${axis}: pick in air = 0`);
  ok(d.silhouettes.has(1) && d.silhouettes.has(2), `${axis}: silhouettes for both labels`);
  ok(d.silhouettes.get(1)[at(c1)] === 1 && d.silhouettes.get(2)[at(c2)] === 1, `${axis}: centroids inside silhouettes`);
  ok(d.image.every((v) => v >= 0 && v <= 1), `${axis}: image in 0..1`);
}
// Orientation: in AP the bone (high i = patient right) must appear on the viewer's left only if i small -> right; i=10 is low, so right half.
const ap = projectDRR(vol, { axis: "ap" });
ok(ap.centroids.get(1)[0] > nx / 2 && ap.centroids.get(2)[0] < nx / 2, "ap: low-i structure on viewer's right (patient's left), high-i on viewer's left");
const lat = projectDRR(vol, { axis: "lateral" });
ok(Math.abs(lat.centroids.get(1)[0] - (ny - 1 - 15 + 0.5)) < 1, "lateral: bone at j=15 lands at x = ny-1-j");
console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
