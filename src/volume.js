// Study loader and voxel helpers. No DOM, no rendering library.
// A study is study.json plus two gzip'd typed arrays (docs/volume-format.md).

// Hosts that only serve text files get the same bytes base64-encoded in a
// sibling "<file>.b64.txt"; it is tried when the binary file is unavailable.
async function fetchGzip(url, ctor) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot decompress gzip streams (DecompressionStream missing).");
  }
  let res = await fetch(url).catch(() => null);
  let body;
  if (res && res.ok) {
    body = res.body;
  } else {
    const alt = await fetch(String(url) + ".b64.txt").catch(() => null);
    if (!alt || !alt.ok) throw new Error(`${url}: HTTP ${res ? res.status : "unreachable"}`);
    const bin = Uint8Array.from(atob((await alt.text()).replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    body = new Blob([bin]).stream();
  }
  const buf = await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return new ctor(buf);
}

export const PLANES = ["axial", "coronal", "sagittal"];
// Which volume axis a plane steps along, and which two axes it shows (u = screen x, v = screen y).
// RAS voxel axes: 0 = x (left->right), 1 = y (posterior->anterior), 2 = z (inferior->superior).
export const PLANE_AXES = {
  axial: { depth: 2, u: 0, v: 1, flipU: true, flipV: true },     // viewer's left = patient's right; anterior at top
  coronal: { depth: 1, u: 0, v: 2, flipU: true, flipV: true },   // superior at top
  sagittal: { depth: 0, u: 1, v: 2, flipU: false, flipV: true }, // anterior on the viewer's left
};

export async function loadStudy(studyUrl) {
  const base = new URL(studyUrl, globalThis.location?.href || "http://local/");
  const res = await fetch(base);
  if (!res.ok) throw new Error(`${studyUrl}: HTTP ${res.status}`);
  const meta = await res.json();
  const [nx, ny, nz] = meta.dims;
  const n = nx * ny * nz;
  const labelCtor = meta.labels.dtype === "uint16" ? Uint16Array : Uint8Array;
  const [ct, labels] = await Promise.all([
    fetchGzip(new URL(meta.ct.file, base), Int16Array),
    fetchGzip(new URL(meta.labels.file, base), labelCtor),
  ]);
  if (ct.length !== n || labels.length !== n) {
    throw new Error(`voxel count mismatch: dims ${meta.dims} expect ${n}, got ct ${ct.length}, labels ${labels.length}`);
  }
  return createVolume(meta, ct, labels);
}

export function createVolume(meta, ct, labels) {
  const [nx, ny, nz] = meta.dims;
  const dims = [nx, ny, nz];
  const spacing = meta.spacing;
  const strides = [1, nx, nx * ny];
  const keyToValue = new Map();
  const valueToKey = new Map();
  for (const [v, s] of Object.entries(meta.structures)) {
    keyToValue.set(s.key, Number(v));
    valueToKey.set(Number(v), s.key);
  }

  // Bounding boxes and centroids per label value, computed once.
  const bounds = new Map();
  for (let k = 0, idx = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, idx++) {
        const v = labels[idx];
        if (!v) continue;
        let b = bounds.get(v);
        if (!b) { b = { min: [i, j, k], max: [i, j, k], sum: [0, 0, 0], n: 0 }; bounds.set(v, b); }
        if (i < b.min[0]) b.min[0] = i; if (i > b.max[0]) b.max[0] = i;
        if (j < b.min[1]) b.min[1] = j; if (j > b.max[1]) b.max[1] = j;
        if (k < b.min[2]) b.min[2] = k; if (k > b.max[2]) b.max[2] = k;
        b.sum[0] += i; b.sum[1] += j; b.sum[2] += k; b.n++;
      }
    }
  }
  for (const b of bounds.values()) b.centroid = b.sum.map((s) => s / b.n);

  const index = (i, j, k) => i + strides[1] * j + strides[2] * k;

  return {
    meta, dims, spacing, ct, labels, keyToValue, valueToKey,
    index,
    valueOf(key) { return keyToValue.get(key); },
    keyOf(value) { return valueToKey.get(value) || null; },
    name(key) {
      const v = keyToValue.get(key);
      return v === undefined ? key : meta.structures[String(v)].name;
    },
    group(key) {
      const v = keyToValue.get(key);
      return v === undefined ? null : meta.structures[String(v)].group;
    },
    boundsOf(key) { return bounds.get(keyToValue.get(key)) || null; },
    labelAt(i, j, k) {
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
      return labels[index(i, j, k)];
    },
    // Size of a plane's slice in voxels and mm: { w, h, sw, sh, depth (voxel count along the plane) }.
    sliceShape(plane) {
      const a = PLANE_AXES[plane];
      return { w: dims[a.u], h: dims[a.v], sw: spacing[a.u], sh: spacing[a.v], depth: dims[a.depth] };
    },
    // Copy a slice of `src` (ct or labels) into `out` (length w*h), row-major, screen orientation applied.
    extractSlice(src, plane, slice, out) {
      const a = PLANE_AXES[plane];
      const w = dims[a.u], h = dims[a.v];
      const d = Math.max(0, Math.min(dims[a.depth] - 1, slice | 0));
      const su = strides[a.u], sv = strides[a.v], sd = strides[a.depth];
      let o = 0;
      for (let y = 0; y < h; y++) {
        const vv = a.flipV ? h - 1 - y : y;
        const rowBase = sd * d + sv * vv;
        if (a.flipU) {
          for (let x = 0; x < w; x++) out[o++] = src[rowBase + su * (w - 1 - x)];
        } else {
          for (let x = 0; x < w; x++) out[o++] = src[rowBase + su * x];
        }
      }
      return out;
    },
    // Screen pixel (sx, sy) within a slice image back to voxel indices [i, j, k].
    voxelAt(plane, slice, sx, sy) {
      const a = PLANE_AXES[plane];
      const w = dims[a.u], h = dims[a.v];
      const u = a.flipU ? w - 1 - sx : sx;
      const v = a.flipV ? h - 1 - sy : sy;
      const ijk = [0, 0, 0];
      ijk[a.u] = u; ijk[a.v] = v; ijk[a.depth] = slice;
      return ijk;
    },
    // Voxel indices to the slice index along a plane and the screen pixel within that slice.
    screenOf(plane, ijk) {
      const a = PLANE_AXES[plane];
      const w = dims[a.u], h = dims[a.v];
      const sx = a.flipU ? w - 1 - ijk[a.u] : ijk[a.u];
      const sy = a.flipV ? h - 1 - ijk[a.v] : ijk[a.v];
      return { slice: ijk[a.depth], sx, sy };
    },
  };
}

// Parse a question's `view`: a named view from the study, or "plane:frac[:window]".
export function resolveView(meta, view, fallback = { plane: "axial", frac: 0.5, window: "soft" }) {
  if (!view) return { ...fallback };
  if (meta.views && meta.views[view]) return { ...fallback, ...meta.views[view] };
  const [plane, frac, window] = String(view).split(":");
  if (!PLANES.includes(plane)) return { ...fallback };
  const f = Number(frac);
  return { plane, frac: Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : fallback.frac, window: window || fallback.window };
}
