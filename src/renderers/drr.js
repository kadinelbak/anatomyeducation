// Digitally reconstructed radiograph (DRR) from a CT volume. Pure compute, no DOM.
//
// Physics: a film records how much of an X-ray beam survives a path through the body. In the CT, HU maps to
// a linear attenuation coefficient relative to water: mu = max(0, (HU + 1000) / 1000), so air = 0, water = 1,
// cortical bone about 2 to 3. Along each parallel ray the line integral is L = sum(mu) * step (mm) and the
// transmitted fraction is T = exp(-k L) (Beer-Lambert). k is chosen adaptively so the median body pixel
// (the soft-tissue mediastinum) transmits 40% and reads mid-grey, while the 98th percentile stays near white. The film shows 1 - T (bone white, air black),
// with a gentle gamma of 0.8 so the lungs are not pure black.
//
// Labels are projected along the same rays: P_label(pixel) is the path length (mm) the ray spends inside a
// structure. The pick map assigns each pixel the label with the largest group-weighted P (bone and vessels
// count more than lung, so a rib is pickable in front of lung), and a silhouette is simply P_label > 0.

const WEIGHT = { bone: 1.0, heart: 0.7, organ: 0.6, lung: 0.35, hollow: 0.5, vessel: 0.9, muscle: 0.4, nervous: 0.8 };
// Per-key weights override the group weight: the tracheal air column is a landmark on every chest film.
const KEY_WEIGHT = { trachea: 1.5, esophagus: 0.2 };
const MIN_PICK_MM = 3;

export function projectDRR(volume, { axis = "ap" } = {}) {
  const [nx, ny, nz] = volume.dims;
  const [sx, sy] = volume.spacing;
  const ct = volume.ct, labels = volume.labels;
  const lateral = axis === "lateral";
  // AP: along j, image x = nx-1-i (viewer's left = patient's right = +i). Lateral: along i, x = ny-1-j (left = anterior).
  const width = lateral ? ny : nx, height = nz, step = lateral ? sx : sy;
  const n = width * height;
  const L = new Float32Array(n);
  const P = []; // label value -> Float32Array(n), allocated on first use
  let idx = 0;
  for (let k = 0; k < nz; k++) {
    const row = (nz - 1 - k) * width;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) {
        const pix = row + (lateral ? ny - 1 - j : nx - 1 - i);
        const hu = ct[idx];
        if (hu > -1000) L[pix] += (hu + 1000) / 1000 * step;
        const v = labels[idx];
        if (v) (P[v] || (P[v] = new Float32Array(n)))[pix] += step;
      }
    }
  }
  // Adaptive exposure: the 98th percentile of L transmits 2%.
  const pos = [];
  for (let p = 0; p < n; p++) if (L[p] > 0) pos.push(L[p]);
  pos.sort((a, b) => a - b);
  const l98 = pos.length ? pos[Math.min(pos.length - 1, Math.floor(pos.length * 0.98))] : 1;
  // k from the 98th percentile alone (T = 0.02 there) leaves most of the body near white, so the exposure is
  // anchored on the typical body pixel instead: the median L over pixels above 15% of L98 transmits 40%
  // (mid-grey after gamma), and the thick spine and heart then approach white.
  const body = pos.filter((l) => l > 0.15 * l98);
  const lMed = body.length ? body[body.length >> 1] : l98;
  const kAtt = -Math.log(0.4) / Math.max(lMed, 1e-6);
  const image = new Float32Array(n);
  for (let p = 0; p < n; p++) image[p] = Math.pow(1 - Math.exp(-kAtt * L[p]), 0.8);

  const groupOf = (v) => volume.meta?.structures?.[String(v)]?.group;
  const pick = new Uint16Array(n);
  const best = new Float32Array(n);
  const silhouettes = new Map(), centroids = new Map();
  for (let v = 1; v < P.length; v++) {
    const arr = P[v];
    if (!arr) continue;
    const w = KEY_WEIGHT[volume.meta?.structures?.[String(v)]?.key] ?? WEIGHT[groupOf(v)] ?? 0.5;
    const mask = new Uint8Array(n);
    let sw = 0, cx = 0, cy = 0;
    for (let p = 0; p < n; p++) {
      const a = arr[p];
      if (a <= 0) continue;
      mask[p] = 1;
      const x = p % width, y = (p / width) | 0;
      sw += a; cx += a * (x + 0.5); cy += a * (y + 0.5);
      const s = a * w;
      if (s > best[p]) { best[p] = s; pick[p] = v; }
    }
    silhouettes.set(v, mask);
    centroids.set(v, [cx / sw, cy / sw]);
  }
  for (let p = 0; p < n; p++) if (best[p] < MIN_PICK_MM) pick[p] = 0;
  return { width, height, pxMm: lateral ? sx : sx, axis: lateral ? "lateral" : "ap", image, pick, silhouettes, centroids };
}
