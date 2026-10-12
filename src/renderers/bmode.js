// Simulated B-mode ultrasound from a CT volume. Pure compute: no DOM, runs in Node for tests.
//
// Physics in one paragraph. A curvilinear probe sends a fan of beams into the body. Along each beam the
// echo at depth s is (tissue reflectivity + an interface term proportional to the CT step between
// neighbouring samples) x (amplitude left after attenuation so far) x (time-gain compensation) x speckle.
// Fluid (blood, bladder, bile, heart chambers) reflects almost nothing and barely attenuates, so it is
// black and the tissue behind it looks bright (posterior enhancement). Bone reflects everything at its
// surface and absorbs the rest, giving a bright line with an acoustic shadow behind it. Gas also reflects
// everything and kills the beam; a dirty shadow of reverberation bands follows the gas interface.
// Speckle is multiplicative Rayleigh-like noise looked up from a hash of the tissue position (so it is
// stable while the probe is still and slides with the tissue when the probe moves), then smoothed 3x3 to
// the grainy look of real scanners. Output is log-compressed to 0..1.

const contourCache = new WeakMap(); // volume -> Map(k -> contour)
const kindCache = new WeakMap();    // volume -> label tables

export const DEFAULT_RAYS = 192;
export const DEFAULT_SAMPLES = 256;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- Skin contour ----------
// Body centroid of axial slice k: mean position of voxels that are not empty air.
function sliceCentroid(volume, k) {
  const [nx, ny] = volume.dims;
  const base = k * nx * ny;
  let si = 0, sj = 0, n = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = base + j * nx + i;
      if (volume.ct[idx] > -500 || volume.labels[idx] !== 0) { si += i; sj += j; n++; }
    }
  }
  return n ? [si / n, sj / n] : [(nx - 1) / 2, (ny - 1) / 2];
}

// Outer body contour of axial slice k: 360 points, one per degree around the centroid. A step is
// "outside" when HU < -500 and unlabelled (lung and bowel gas carry labels, so they do not end the march)
// for 3 consecutive voxels; the last tissue voxel before that is the skin. angleDeg: 0 = anterior,
// 90 = patient's left (-i), 180 posterior, 270 patient's right.
export function skinContour(volume, k) {
  const [nx, ny, nz] = volume.dims;
  k = clamp(Math.round(k), 0, nz - 1);
  let perVol = contourCache.get(volume);
  if (!perVol) { perVol = new Map(); contourCache.set(volume, perVol); }
  const hit = perVol.get(k);
  if (hit) return hit;
  const [ci, cj] = sliceCentroid(volume, k);
  const base = k * nx * ny;
  const pts = new Array(360);
  const maxT = Math.hypot(nx, ny);
  for (let a = 0; a < 360; a++) {
    const rad = (a * Math.PI) / 180, di = -Math.sin(rad), dj = Math.cos(rad);
    let lastI = ci, lastJ = cj, run = 0;
    for (let t = 0; t < maxT; t += 1) {
      const i = ci + di * t, j = cj + dj * t;
      const ii = Math.round(i), jj = Math.round(j);
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) break;
      const idx = base + jj * nx + ii;
      if (volume.ct[idx] < -500 && volume.labels[idx] === 0) {
        if (++run >= 3) break;
      } else { run = 0; lastI = i; lastJ = j; }
    }
    pts[a] = { i: lastI, j: lastJ, angleDeg: a };
  }
  pts.centroid = [ci, cj];
  perVol.set(k, pts);
  return pts;
}

// ---------- Probe pose ----------
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Contour point at a fractional angle (linear interpolation between degrees).
export function contourPoint(contour, angleDeg) {
  const a = ((angleDeg % 360) + 360) % 360, a0 = Math.floor(a), a1 = (a0 + 1) % 360, f = a - a0;
  const p = contour[a0], q = contour[a1];
  return { i: p.i + (q.i - p.i) * f, j: p.j + (q.j - p.j) * f, angleDeg: a };
}

// Probe on the skin at (frac, angleDeg), pointing at the body centroid. rotDeg turns the scan plane about
// the beam (0 transverse, 90 longitudinal with cranial on the image left); tiltDeg rocks the beam about the
// fan's lateral axis (cranial in transverse, a left-right sweep in longitudinal). Vectors are in mm space
// (x = i*sx, y = j*sy, z = k*sz; +x right, +y anterior, +z superior).
export function probePose(volume, { frac = 0.5, angleDeg = 0, tiltDeg = 0, rotDeg = 0, depthMm = 160, sectorDeg = 70 } = {}) {
  const [, , nz] = volume.dims;
  const [sx, sy, sz] = volume.spacing;
  const k = clamp(Math.round(clamp(frac, 0, 1) * (nz - 1)), 0, nz - 1);
  const contour = skinContour(volume, k);
  const pt = contourPoint(contour, angleDeg);
  const [ci, cj] = contour.centroid;
  const origin = [pt.i * sx, pt.j * sy, k * sz];
  const beam0 = norm3([ci * sx - origin[0], cj * sy - origin[1], 0]);
  const z = [0, 0, 1];
  const lat0 = norm3(cross(beam0, z)); // transverse image-right (patient's left when the probe is anterior)
  const r = (rotDeg * Math.PI) / 180, t = (tiltDeg * Math.PI) / 180;
  const lat = [lat0[0] * Math.cos(r) - z[0] * Math.sin(r), lat0[1] * Math.cos(r) - z[1] * Math.sin(r), lat0[2] * Math.cos(r) - z[2] * Math.sin(r)];
  const w = cross(lat, beam0);
  const beam = norm3([beam0[0] * Math.cos(t) + w[0] * Math.sin(t), beam0[1] * Math.cos(t) + w[1] * Math.sin(t), beam0[2] * Math.cos(t) + w[2] * Math.sin(t)]);
  return { origin, beam, lateral: lat, k, angleDeg: pt.angleDeg, contour: { i: pt.i, j: pt.j }, rotDeg, tiltDeg, depthMm, sectorDeg };
}

// ---------- Label tables ----------
const FLUID_RE = /^(urinary_bladder|gallbladder|aorta|inferior_vena_cava|portal_vein_and_splenic_vein|superior_vena_cava|brachiocephalic_vein_.*|pulmonary_vein|iliac_vena_.*|iliac_artery_.*|heart|common_carotid_artery_.*|subclavian_artery_.*)$/;
const K_NONE = 0, K_LUNG = 1, K_BONE = 2, K_FLUID = 3, K_MUSCLE = 4, K_KIDNEY = 5;
// Per-organ brightness multiplier on soft tissue reflectivity (liver and spleen medium, kidney cortex dark, pancreas bright).
const ORGAN_GAIN = { liver: 1.05, spleen: 1.15, pancreas: 1.35, kidney_left: 0.7, kidney_right: 0.7, stomach: 0.9, prostate: 0.9 };

function kindsFor(volume) {
  let t = kindCache.get(volume);
  if (t) return t;
  let maxV = 0;
  for (const v of volume.valueToKey.keys()) if (v > maxV) maxV = v;
  const kind = new Uint8Array(maxV + 1), fac = new Float32Array(maxV + 1).fill(1);
  for (const [v, key] of volume.valueToKey) {
    const g = volume.group(key);
    kind[v] = FLUID_RE.test(key) ? K_FLUID : g === "lung" ? K_LUNG : g === "bone" ? K_BONE : g === "muscle" ? K_MUSCLE : /^kidney_/.test(key) ? K_KIDNEY : K_NONE;
    fac[v] = (ORGAN_GAIN[key] || 1) * (0.92 + 0.16 * (((v * 2654435761) >>> 8) % 100) / 100);
  }
  t = { kind, fac };
  kindCache.set(volume, t);
  return t;
}

// ---------- Speckle ----------
const SPK = new Float32Array(4096);
(function buildSpeckle() {
  let s = 0x9e3779b9;
  const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let sum = 0;
  for (let n = 0; n < 4096; n++) { SPK[n] = 0.45 * Math.sqrt(-2 * Math.log(1 - rnd() * 0.999)); sum += SPK[n]; }
  const mean = sum / 4096;
  for (let n = 0; n < 4096; n++) SPK[n] /= mean; // mean 1
})();

let scratch = { n: 0, echo: null, rev: null, spk: null, tmp: null };
function getScratch(n) {
  if (scratch.n !== n) scratch = { n, echo: new Float32Array(n), rev: new Float32Array(n), spk: new Float32Array(n), tmp: new Float32Array(n) };
  return scratch;
}

const C_VOID = 0, C_GAS = 1, C_BONE = 2, C_FLUID = 3, C_FAT = 4, C_SOFT = 5;
const ATT = [0, 0.6, 0.5, 0.001, 0.009, 0.007];
const SPECKLE_CELL = 1 / 0.8;
const LN10 = Math.log(10);

// ---------- B-mode ----------
// out: { fan: Float32Array(rays*samples), labels: Uint16Array(rays*samples), probeOnSlice, rays, samples }.
export function renderBMode(volume, pose, out = {}, opts = {}) {
  const rays = opts.rays || out.rays || DEFAULT_RAYS, samples = opts.samples || out.samples || DEFAULT_SAMPLES;
  const sectorDeg = opts.sectorDeg || pose.sectorDeg || 70, depthMm = opts.depthMm || pose.depthMm || 160;
  const gain = opts.gain ?? 1;
  const n = rays * samples;
  if (!out.fan || out.fan.length !== n) out.fan = new Float32Array(n);
  if (!out.labels || out.labels.length !== n) out.labels = new Uint16Array(n);
  out.rays = rays; out.samples = samples; out.sectorDeg = sectorDeg; out.depthMm = depthMm;
  const { echo, rev, spk, tmp } = getScratch(n);
  echo.fill(0); rev.fill(0); out.labels.fill(0);

  const [nx, ny, nz] = volume.dims, [sx, sy, sz] = volume.spacing;
  const ct = volume.ct, lab = volume.labels;
  const { kind, fac } = kindsFor(volume);
  const nxy = nx * ny;
  const ds = depthMm / samples, R = depthMm * 0.03, half = (sectorDeg * Math.PI) / 360;
  const [ox, oy, oz] = pose.origin, [bx, by, bz] = pose.beam, [lx, ly, lz] = pose.lateral;
  const ax = ox - bx * R, ay = oy - by * R, az = oz - bz * R; // virtual apex behind the probe face
  const attStep = ATT.map((a) => Math.exp(-a * ds));
  const revSamples = Math.round(15 / ds);

  for (let r = 0; r < rays; r++) {
    const th = rays > 1 ? -half + (2 * half * r) / (rays - 1) : 0;
    const c = Math.cos(th), s = Math.sin(th);
    const dx = bx * c + lx * s, dy = by * c + ly * s, dz = bz * c + lz * s;
    let A = 1, prevHu = 0, prevCls = C_VOID, havePrev = false, voidRun = 0;
    let gasAt = -1, gasA = 0, boneHold = 0;
    const row = r * samples;
    for (let q = 0; q < samples; q++) {
      const d = R + (q + 0.5) * ds;
      const px = ax + dx * d, py = ay + dy * d, pz = az + dz * d;
      const fi = px / sx, fj = py / sy, fk = clamp(pz / sz, 0, nz - 1); // beyond the first/last slice the edge slice is repeated
      const idx = row + q;
      if (fi < 0 || fj < 0 || fi > nx - 1 || fj > ny - 1) {
        if (++voidRun >= 6) break;
        continue;
      }
      // Nearest label, trilinear HU.
      const i0 = fi | 0, j0 = fj | 0, k0 = fk | 0;
      const i1 = i0 + 1 < nx ? i0 + 1 : i0, j1 = j0 + 1 < ny ? j0 + 1 : j0, k1 = k0 + 1 < nz ? k0 + 1 : k0;
      const u = fi - i0, v = fj - j0, w = fk - k0;
      const b00 = k0 * nxy + j0 * nx, b10 = k0 * nxy + j1 * nx, b01 = k1 * nxy + j0 * nx, b11 = k1 * nxy + j1 * nx;
      const h00 = ct[b00 + i0] * (1 - u) + ct[b00 + i1] * u, h10 = ct[b10 + i0] * (1 - u) + ct[b10 + i1] * u;
      const h01 = ct[b01 + i0] * (1 - u) + ct[b01 + i1] * u, h11 = ct[b11 + i0] * (1 - u) + ct[b11 + i1] * u;
      const hu = (h00 * (1 - v) + h10 * v) * (1 - w) + (h01 * (1 - v) + h11 * v) * w;
      const L2 = lab[(w > 0.5 ? k1 : k0) * nxy + (v > 0.5 ? j1 : j0) * nx + (u > 0.5 ? i1 : i0)];
      out.labels[idx] = L2;
      const kd = L2 ? kind[L2] : K_NONE;
      // Speckle from the tissue position (0.8 mm cells).
      const hsh = Math.imul(Math.floor(px * SPECKLE_CELL), 73856093) ^ Math.imul(Math.floor(py * SPECKLE_CELL), 19349663) ^ Math.imul(Math.floor(pz * SPECKLE_CELL), 83492791);
      spk[idx] = SPK[(hsh ^ (hsh >>> 13)) & 4095];

      if (hu < -500 && L2 === 0) { if (++voidRun >= 6) break; continue; } // air outside the body
      voidRun = 0;

      let cls;
      if (hu < -300 || kd === K_LUNG) cls = C_GAS;
      else if (hu > 250 || kd === K_BONE) cls = C_BONE;
      else if (kd === K_FLUID || (kd === K_KIDNEY && hu >= 0 && hu <= 25)) cls = C_FLUID;
      else if (hu > -150 && hu < -30) cls = C_FAT;
      else cls = C_SOFT;

      let refl;
      const step = havePrev ? Math.abs(hu - prevHu) : 0;
      const iface = Math.min(step / 250, 1) * 0.9;
      if (cls === C_GAS) {
        if (prevCls !== C_GAS) { refl = 1; gasAt = q; gasA = A; } else refl = 0;
      } else if (cls === C_BONE) {
        if (prevCls !== C_BONE) boneHold = 3;
        refl = boneHold > 0 ? (boneHold-- === 1 ? 0.6 : 1) : 0.1;
      } else if (cls === C_FLUID) {
        refl = 0.02 + iface * 0.5 + (prevCls !== C_FLUID && havePrev ? 0.25 : 0);
      } else if (cls === C_FAT) {
        refl = 0.55 + iface;
      } else {
        const base = (kd === K_MUSCLE ? 0.3 : 0.35) * fac[L2 || 0] * (1 + clamp((hu - 40) / 150, -0.4, 0.6));
        refl = base + iface + (prevCls === C_FLUID ? 0.25 : 0);
      }
      // Specular surfaces (bone, gas) are not speckled: they go to the unspeckled additive channel.
      const e = refl * A * (1 + (q / samples) * 1.6);
      if ((cls === C_BONE && refl >= 0.6) || (cls === C_GAS && refl > 0)) rev[idx] = e; else echo[idx] = e;
      if (gasAt >= 0 && q - gasAt <= revSamples) {
        const dd = (q - gasAt) * ds, band = 0.5 + 0.5 * Math.cos((2 * Math.PI * dd) / 3);
        rev[idx] += 0.7 * gasA * (1 - dd / 15) * band * band * band;
      }
      A *= attStep[cls];
      prevHu = hu; prevCls = cls; havePrev = true;
    }
  }

  // Smooth the speckle 3-tap along the ray, then 3-tap across rays, and restore its contrast.
  for (let r = 0; r < rays; r++) {
    const row = r * samples;
    for (let q = 0; q < samples; q++) {
      const a = spk[row + (q > 0 ? q - 1 : q)], b = spk[row + q], c2 = spk[row + (q < samples - 1 ? q + 1 : q)];
      tmp[row + q] = (a + b + c2) / 3;
    }
  }
  for (let r = 0; r < rays; r++) {
    const rm = (r > 0 ? r - 1 : r) * samples, rp = (r < rays - 1 ? r + 1 : r) * samples, row = r * samples;
    for (let q = 0; q < samples; q++) {
      const sm = (tmp[rm + q] + tmp[row + q] + tmp[rp + q]) / 3;
      spk[row + q] = Math.max(0.05, 1 + (sm - 1) * 1.7);
    }
  }
  const fan = out.fan;
  for (let n2 = 0; n2 < n; n2++) {
    let val = (echo[n2] * spk[n2] + rev[n2] * (0.6 + 0.4 * spk[n2])) * gain + 0.012 * spk[n2]; // + electronic noise floor
    if (val > 1) val = 1;
    fan[n2] = Math.log(1 + 9 * val) / LN10;
  }
  out.probeOnSlice = { k: pose.k, i: pose.contour ? pose.contour.i : ox / sx, j: pose.contour ? pose.contour.j : oy / sy, angleDeg: pose.angleDeg ?? 0 };
  return out;
}

// ---------- Scan conversion ----------
const lutCache = new Map();
const APEX_R0 = 12; // px

// Lookup table for a target size: per in-sector pixel the four fan indices, bilinear weights and the
// nearest fan sample (for labels). Built once per (size, rays, samples, sector).
export function getLut(width, height, rays, samples, sectorDeg) {
  const key = `${width}x${height}:${rays}:${samples}:${sectorDeg}`;
  let lut = lutCache.get(key);
  if (lut) return lut;
  const half = (sectorDeg * Math.PI) / 360;
  const cx = width / 2, ay = 4;
  const rmax = Math.min(height - 4 - ay, (width / 2 - 6) / Math.sin(half));
  const near = new Int32Array(width * height).fill(-1);
  const pix = [], a00 = [], dR = [], dS = [], fxs = [], fys = [];
  const span = rmax - APEX_R0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - ay;
      const rad = Math.hypot(dx, dy);
      if (rad < APEX_R0 || rad > rmax) continue;
      const th = Math.atan2(dx, dy);
      if (th < -half || th > half) continue;
      const rf = ((th + half) / (2 * half)) * (rays - 1), sf = ((rad - APEX_R0) / span) * (samples - 1);
      const r0 = Math.min(rays - 1, Math.floor(rf)), s0 = Math.min(samples - 1, Math.floor(sf));
      pix.push(y * width + x); a00.push(r0 * samples + s0);
      dR.push(r0 + 1 < rays ? 1 : 0); dS.push(s0 + 1 < samples ? 1 : 0);
      fxs.push(rf - r0); fys.push(sf - s0);
      near[y * width + x] = Math.min(rays - 1, Math.round(rf)) * samples + Math.min(samples - 1, Math.round(sf));
    }
  }
  lut = {
    width, height, rays, samples, sectorDeg, cx, apexY: ay, r0: APEX_R0, rmax, span, half,
    n: pix.length, pix: Uint32Array.from(pix), a00: Int32Array.from(a00), dR: Uint8Array.from(dR), dS: Uint8Array.from(dS),
    fx: Float32Array.from(fxs), fy: Float32Array.from(fys), near,
  };
  lutCache.set(key, lut);
  return lut;
}

// Pixel position of depth d (mm) on the sector edge (side = +1 right edge, 0 centre line).
export function depthToPixel(lut, d, depthMm, side = 0) {
  const rad = lut.r0 + (d / depthMm) * lut.span;
  const th = side * lut.half;
  return [lut.cx + rad * Math.sin(th), lut.apexY + rad * Math.cos(th)];
}

// Draw the fan into target ({width,height,data}); pixels outside the sector are black. Returns the LUT.
export function scanConvert(fan, rays, samples, sectorDeg, depthMm, target) {
  const lut = getLut(target.width, target.height, rays, samples, sectorDeg);
  void depthMm;
  const px = new Uint32Array(target.data.buffer, target.data.byteOffset, target.width * target.height);
  px.fill(0xff000000);
  const { pix, a00, dR, dS, fx, fy, n } = lut;
  for (let p = 0; p < n; p++) {
    const a = a00[p], b = a + dR[p] * samples, sa = dS[p];
    const x = fx[p], y = fy[p];
    const top = fan[a] + (fan[b] - fan[a]) * x, bot = fan[a + sa] + (fan[b + sa] - fan[a + sa]) * x;
    let g = ((top + (bot - top) * y) * 255 + 0.5) | 0;
    if (g > 255) g = 255;
    px[pix[p]] = 0xff000000 | (g << 16) | (g << 8) | g;
  }
  return lut;
}

// Label value under canvas pixel (x, y) (0 outside the sector).
export function labelAtPixel(lut, labels, x, y) {
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= lut.width || y >= lut.height) return 0;
  const i = lut.near[y * lut.width + x];
  return i < 0 ? 0 : labels[i];
}
