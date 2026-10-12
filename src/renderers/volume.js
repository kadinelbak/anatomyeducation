// Volume renderer on Cornerstone3D (vendored core bundle). Same return shape as the mesh renderer.
// One ORTHOGRAPHIC viewport at a time fills `container`; the page must have `container` in the DOM
// and sized (non-zero width/height) before createVolumeRenderer() is called.
//
// Orientation: our voxel arrays are RAS (+i patient right, +j anterior, +k superior); Cornerstone world
// is LPS. The local volumes are created with direction [-1,0,0, 0,-1,0, 0,0,1] and origin 0, so voxel
// index == imageData index and world = (-i, -j, k) * spacing. With that, Cornerstone's stock AXIAL /
// CORONAL / SAGITTAL cameras already give radiological display (see FLIP_H below for sagittal).
import {
  init, RenderingEngine, Enums, volumeLoader, cache, setVolumesForViewports,
  addVolumesToViewports, utilities,
} from "../../vendor/cornerstone/cornerstone-core.bundle.js";
import { loadStudy, resolveView, defaultWindow, modalityLabel, PLANES, PLANE_AXES } from "../volume.js";

const GOOD = [0x2e / 255, 0xe6 / 255, 0x8a / 255];
const BAD = [1, 0x3b / 255, 0x3b / 255];
const ORIENT = {
  axial: Enums.OrientationAxis.AXIAL,
  coronal: Enums.OrientationAxis.CORONAL,
  sagittal: Enums.OrientationAxis.SAGITTAL,
};
const EDGES = {
  axial: { left: "R", right: "L", top: "A", bottom: "P" },
  coronal: { left: "R", right: "L", top: "S", bottom: "I" },
  sagittal: { left: "A", right: "P", top: "S", bottom: "I" },
};
// Set per plane if the screenshots show a mirrored view (see report comments in git history / test).
const FLIP_H = { axial: false, coronal: false, sagittal: false };
const FLIP_V = { axial: false, coronal: false, sagittal: false };

let uid = 0;
let csReady = null;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export async function createVolumeRenderer({ container, studyUrl, onPick, controls } = {}) {
  const volume = await loadStudy(studyUrl);
  const { meta, dims, spacing } = volume;
  const id = ++uid;
  const ctId = `vol-ct-${id}`, segId = `vol-seg-${id}`, reId = `vol-re-${id}`, vpId = `vol-vp-${id}`;
  let cmapCounter = 0;

  // ---------- DOM ----------
  const root = el("div", "vol-root");
  const vpEl = el("div", "vol-viewport");
  vpEl.style.width = "100%"; vpEl.style.height = "100%";
  const edge = {};
  root.append(vpEl);
  for (const side of ["left", "right", "top", "bottom"]) { edge[side] = el("span", `vol-edge vol-edge-${side}`); root.append(edge[side]); }
  const label = el("div", "vol-label"); label.hidden = true;
  const ring = el("div", "vol-ring"); ring.hidden = true;
  const toolbar = el("div", "vol-toolbar");
  const planeBtns = {}, winBtns = {};
  const row1 = el("div", "vol-row"), row2 = el("div", "vol-row");
  for (const p of PLANES) {
    const b = el("button", "vol-btn", p[0].toUpperCase() + p.slice(1)); b.type = "button"; b.dataset.plane = p;
    b.addEventListener("click", () => setPlane(p)); planeBtns[p] = b; row1.append(b);
  }
  for (const [w, preset] of Object.entries(meta.windows || {})) {
    // A preset may carry its own button text (MR presets: Default, Tissue, Bright, Dark); CT presets use the key.
    const b = el("button", "vol-btn", preset.label || w[0].toUpperCase() + w.slice(1)); b.type = "button"; b.dataset.window = w;
    b.addEventListener("click", () => setWindow(w)); winBtns[w] = b; row1.append(b);
  }
  const zin = el("button", "vol-btn vol-zoom", "+"), zout = el("button", "vol-btn vol-zoom", "−");
  zin.type = zout.type = "button"; zin.dataset.zoom = "in"; zout.dataset.zoom = "out";
  zin.setAttribute("aria-label", "Zoom in"); zout.setAttribute("aria-label", "Zoom out");
  zin.addEventListener("click", () => zoomBy(1.25)); zout.addEventListener("click", () => zoomBy(0.8));
  const slider = el("input", "vol-slider"); slider.type = "range"; slider.min = 0; slider.step = 1; slider.value = 0;
  slider.setAttribute("aria-label", "Slice");
  slider.addEventListener("input", () => setDepth(Number(slider.value)));
  // Modality and sequence badge ("MRI · T1", with the full sequence name as a tooltip), so the student
  // always knows which weighting they are reading. CT studies show "CT".
  const badge = el("span", "vol-badge", modalityLabel(meta));
  if (meta.sequenceLabel) badge.title = meta.sequenceLabel;
  row2.append(slider, zout, zin);
  toolbar.append(row1, row2);
  root.append(badge, label, ring, toolbar);
  container.append(root);

  // ---------- Cornerstone ----------
  csReady = csReady || Promise.resolve(init());
  await csReady;
  const mkMeta = (bits, signed, modality) => ({
    BitsAllocated: bits, BitsStored: bits, SamplesPerPixel: 1, HighBit: bits - 1, PixelRepresentation: signed,
    PhotometricInterpretation: "MONOCHROME2", Modality: modality, FrameOfReferenceUID: `1.2.826.0.1.${id}`,
    ImageOrientationPatient: [-1, 0, 0, 0, -1, 0], PixelSpacing: [spacing[1], spacing[0]],
  });
  const base = { dimensions: dims.slice(), spacing: spacing.slice(), origin: [0, 0, 0], direction: [-1, 0, 0, 0, -1, 0, 0, 0, 1] };
  await volumeLoader.createLocalVolume(ctId, { ...base, scalarData: volume.ct.slice(), metadata: mkMeta(16, 1, meta.modality || "CT") });
  const lab16 = volume.labels instanceof Uint16Array;
  await volumeLoader.createLocalVolume(segId, { ...base, scalarData: volume.labels.slice(), metadata: mkMeta(lab16 ? 16 : 8, 0, "SEG") });
  const ctVol = cache.getVolume(ctId);
  const imageData = ctVol.imageData;
  const maxLabel = Math.max(1, ...Object.keys(meta.structures).map(Number));

  const re = new RenderingEngine(reId);
  const WIN0 = defaultWindow(meta);
  const state = { plane: "axial", depth: 0, window: WIN0, width: meta.windows?.[WIN0]?.width ?? 400, level: meta.windows?.[WIN0]?.level ?? 40, outline: false, highlights: new Map(), pickEnabled: false, zoom: 1 };
  let vp = null;

  function makeViewport(plane) {
    re.setViewports([{ viewportId: vpId, type: Enums.ViewportType.ORTHOGRAPHIC, element: vpEl,
      defaultOptions: { orientation: ORIENT[plane], background: [0, 0, 0] } }]);
    vp = re.getViewport(vpId);
  }
  makeViewport("axial");
  await setVolumesForViewports(re, [{ volumeId: ctId }], [vpId]);
  await addVolumesToViewports(re, [{ volumeId: segId, visibility: true }], [vpId]);

  const worldToIdx = (w) => Array.from(imageData.worldToIndex(w));
  const idxToWorld = (ijk) => Array.from(imageData.indexToWorld(ijk));
  const depthAxis = () => PLANE_AXES[state.plane].depth;

  function centreVoxel() {
    const r = vpEl.getBoundingClientRect();
    return worldToIdx(vp.canvasToWorld([r.width / 2, r.height / 2])).map((v, n) => clamp(Math.round(v), 0, dims[n] - 1));
  }

  function applyFlips() {
    const fh = FLIP_H[state.plane], fv = FLIP_V[state.plane];
    if (fh || fv) { vp.setCamera({ flipHorizontal: fh, flipVertical: fv }); }
  }

  // ---------- Overlay (dynamic colormap on the labelmap) ----------
  function hsv(h) { // faint distinct hue per label
    const f = (n) => { const k = (n + h * 6) % 6; return 1 - 0.75 * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5), f(3), f(1)];
  }
  function applyOverlay() {
    const name = `vol-cmap-${id}-${++cmapCounter}`;
    const rgb = [], op = [];
    for (let v = 0; v <= maxLabel; v++) {
      let c = [0, 0, 0], a = 0;
      if (v > 0 && state.outline && meta.structures[String(v)]) { c = hsv(((v * 0.381966) % 1)); a = 0.18; }
      const h = state.highlights.get(v);
      if (v > 0 && h) { c = h === "good" ? GOOD : BAD; a = 0.45; }
      rgb.push(v, c[0], c[1], c[2]);
      op.push({ value: v, opacity: a });
    }
    utilities.colormap.registerColormap({ ColorSpace: "RGB", Name: name, RGBPoints: rgb });
    vp.setProperties({ colormap: { name, opacity: op }, voiRange: { lower: 0, upper: maxLabel } }, segId);
    vp.render();
  }

  // ---------- State changes ----------
  function syncUI() {
    for (const p of PLANES) planeBtns[p].classList.toggle("vol-active", p === state.plane);
    for (const w of Object.keys(winBtns)) winBtns[w].classList.toggle("vol-active", w === state.window);
    const e = EDGES[state.plane];
    for (const s of ["left", "right", "top", "bottom"]) edge[s].textContent = e[s];
    slider.max = dims[depthAxis()] - 1;
    slider.value = state.depth;
  }
  function applyWindow() {
    state.width = Math.max(1, state.width);
    vp.setProperties({ voiRange: utilities.windowLevel.toLowHighRange(state.width, state.level) }, ctId);
    vp.render();
  }
  function setWindow(w) {
    if (typeof w === "string") {
      const p = meta.windows[w]; if (!p) return;
      state.window = w; state.width = p.width; state.level = p.level;
    } else { state.window = null; state.width = w.width; state.level = w.level; }
    applyWindow(); syncUI();
  }
  // Move the camera along the plane normal so the slice passes through voxel index d on the depth axis.
  function setDepth(d) {
    const a = depthAxis();
    d = clamp(Math.round(d), 0, dims[a] - 1);
    const cam = vp.getCamera();
    const cur = worldToIdx(cam.focalPoint); cur[a] = d;
    const target = idxToWorld(cur);
    const n = cam.viewPlaneNormal;
    const delta = (target[0] - cam.focalPoint[0]) * n[0] + (target[1] - cam.focalPoint[1]) * n[1] + (target[2] - cam.focalPoint[2]) * n[2];
    const add = (p) => [p[0] + delta * n[0], p[1] + delta * n[1], p[2] + delta * n[2]];
    vp.setCamera({ focalPoint: add(cam.focalPoint), position: add(cam.position) });
    state.depth = d;
    vp.render();
    syncUI();
  }
  function currentDepth() {
    return clamp(Math.round(worldToIdx(vp.getCamera().focalPoint)[depthAxis()]), 0, dims[depthAxis()] - 1);
  }
  // The labelmap is volume-rendered: its alpha is 1-(1-a)^(slab/unitDistance) with unit distance 1 mm and a
  // default slab of 0.05 mm (overlay invisible). A ~0.8 mm slab makes the colormap opacities come out near-nominal.
  function setSlab() { vp.setSlabThickness(0.8); }
  function resetView() { vp.resetCamera(); applyFlips(); state.zoom = 1; }
  function setPlane(plane, depth) {
    if (!PLANES.includes(plane)) return;
    const ijk = plane === state.plane && depth === undefined ? null : centreVoxel();
    if (plane !== state.plane) {
      state.plane = plane;
      if (typeof vp.setOrientation === "function") vp.setOrientation(ORIENT[plane], true);
      else { makeViewport(plane); }
      resetView(); setSlab();
    }
    const a = PLANE_AXES[plane].depth;
    setDepth(depth !== undefined ? depth : ijk ? ijk[a] : state.depth);
    syncUI();
  }
  function zoomBy(f) {
    state.zoom = clamp(state.zoom * f, 1, 12);
    vp.setZoom(state.zoom); if (state.zoom === 1) vp.setPan([0, 0]);
    vp.render();
  }
  function panBy(dx, dy) { const p = vp.getPan(); vp.setPan([p[0] + dx, p[1] + dy]); vp.render(); }
  function sliceHas(value) {
    const sh = volume.sliceShape(state.plane);
    const buf = new volume.labels.constructor(sh.w * sh.h);
    volume.extractSlice(volume.labels, state.plane, state.depth, buf);
    return buf.includes(value);
  }

  // ---------- Pick ----------
  function pickAt(x, y) { // x, y in CSS px relative to the viewport element
    const ijk = worldToIdx(vp.canvasToWorld([x, y])).map(Math.round);
    const v = volume.labelAt(ijk[0], ijk[1], ijk[2]);
    return v ? volume.keyOf(v) : null;
  }
  function canvasOf(ijk) { return Array.from(vp.worldToCanvas(idxToWorld(ijk))); }
  function showLabel(text, x, y) {
    if (!text) { label.hidden = true; return; }
    label.textContent = text; label.style.left = x + "px"; label.style.top = y + "px"; label.hidden = false;
  }
  function flashRing(x, y) {
    ring.hidden = true; void ring.offsetWidth;
    ring.style.left = x + "px"; ring.style.top = y + "px"; ring.title = "nothing labelled here"; ring.hidden = false;
    clearTimeout(flashRing.t); flashRing.t = setTimeout(() => { ring.hidden = true; }, 600);
  }
  function onTap(e) {
    const r = vpEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const key = pickAt(x, y);
    api.debug.lastTap = { x, y, key };
    if (state.pickEnabled) {
      label.hidden = true;
      if (key) onPick && onPick(key); else flashRing(x, y);
    } else showLabel(key && volume.name(key), x, y);
  }

  // ---------- Pointer interaction ----------
  const ptrs = new Map();
  let gesture = null;
  const dist = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const mid = () => { const [a, b] = [...ptrs.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  function wlDrag(dx, dy) {
    state.window = null; Object.values(winBtns).forEach((b) => b.classList.remove("vol-active"));
    state.width = Math.max(1, state.width * (1 + dx / 200));
    state.level += -dy * Math.max(1, state.width / 250); // width-relative, so it suits HU and rescaled MR alike
    applyWindow();
  }
  vpEl.addEventListener("contextmenu", (e) => e.preventDefault());
  vpEl.addEventListener("pointerdown", (e) => {
    vpEl.setPointerCapture?.(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) {
      const mode = e.pointerType === "mouse" ? (e.button === 2 ? "wl" : e.shiftKey || e.button === 1 ? "pan" : "scroll") : "scroll";
      gesture = { mode, sx: e.clientX, sy: e.clientY, moved: false, multi: false, acc: 0, d0: state.depth };
    } else { gesture = { ...(gesture || {}), mode: "two", multi: true, d: dist(), m: mid() }; }
    label.hidden = true;
    e.preventDefault();
  });
  vpEl.addEventListener("pointermove", (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === "mouse" && !state.pickEnabled && !e.buttons) {
        const r = vpEl.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
        const k = pickAt(x, y); showLabel(k && volume.name(k), x, y);
      }
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (!gesture) return;
    if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 6) gesture.moved = true;
    if (gesture.mode === "two" && ptrs.size >= 2) {
      const d = dist(), m = mid();
      const dd = d - gesture.d, mv = Math.hypot(m.x - gesture.m.x, m.y - gesture.m.y);
      if (Math.abs(dd) > mv) { if (gesture.d > 0) zoomBy(d / gesture.d); }
      else wlDrag(m.x - gesture.m.x, m.y - gesture.m.y);
      gesture.d = d; gesture.m = m;
    } else if (gesture.mode === "scroll" && gesture.moved) {
      const pxPer = Math.max(4, vpEl.clientHeight / dims[depthAxis()]);
      gesture.acc += dy;
      const steps = Math.trunc(gesture.acc / pxPer);
      if (steps) { gesture.acc -= steps * pxPer; setDepth(state.depth + steps); }
    } else if (gesture.mode === "pan" && gesture.moved) panBy(dx, dy);
    else if (gesture.mode === "wl" && gesture.moved) wlDrag(dx, dy);
    e.preventDefault();
  });
  function end(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    const g = gesture;
    if (ptrs.size === 0) {
      gesture = null;
      if (e.type === "pointerup" && g && !g.moved && !g.multi && g.mode !== "wl") onTap(e);
    } else if (g) { g.moved = true; }
  }
  vpEl.addEventListener("pointerup", end);
  vpEl.addEventListener("pointercancel", end);
  vpEl.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !state.pickEnabled) label.hidden = true; });
  vpEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey) zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    else setDepth(state.depth + (e.deltaY > 0 ? 1 : -1));
  }, { passive: false });
  for (const t of ["touchstart", "touchmove"]) vpEl.addEventListener(t, (e) => e.preventDefault(), { passive: false });

  // ---------- Resize ----------
  const onResize = () => { re.resize(true, true); };
  window.addEventListener("resize", onResize);
  if (typeof ResizeObserver === "function") new ResizeObserver(onResize).observe(root);

  // ---------- Initial render (Cornerstone needs a frame or two before the first draw sticks) ----------
  state.window = WIN0;
  applyWindow(); applyOverlay();
  re.renderViewports([vpId]);
  await nextFrame(); await nextFrame();
  re.render();
  vp.setInterpolationType(Enums.InterpolationType.LINEAR, ctId); // explicit; Cornerstone default (FAST_LINEAR) made the nearest overlay vanish
  vp.setInterpolationType(Enums.InterpolationType.NEAREST, segId); // NOT via setProperties(): it ignores volumeId and changes the CT too
  applyOverlay();
  setSlab();
  setPlane("axial", Math.round((dims[2] - 1) / 2));
  syncUI();

  const api = {
    show({ view, layers } = {}) {
      const v = resolveView(meta, view);
      state.highlights.clear();
      state.outline = !!(layers && layers.includes("outline"));
      if (v.plane !== state.plane) setPlane(v.plane, 0);
      resetView();
      const a = PLANE_AXES[v.plane].depth;
      setDepth(Math.round(v.frac * (dims[a] - 1)));
      setWindow(meta.windows[v.window] ? v.window : WIN0);
      applyOverlay();
      label.hidden = true; ring.hidden = true;
    },
    highlight(key, kind) {
      const val = volume.valueOf(key);
      if (val === undefined) return;
      state.highlights.set(val, kind === "good" ? "good" : "bad");
      if (!sliceHas(val)) {
        const b = volume.boundsOf(key);
        if (b) setDepth(b.centroid[depthAxis()]);
      }
      applyOverlay();
    },
    clearHighlight() { state.highlights.clear(); applyOverlay(); },
    name: (key) => volume.name(key),
    setDefaultLayers() { state.outline = false; setWindow(WIN0); applyOverlay(); },
    setPickEnabled(on) { state.pickEnabled = !!on; if (on) label.hidden = true; },
    debug: {
      volume, state, setPlane, setSlice: setDepth, setWindow, pickAt, canvasOf, currentDepth, centreVoxel,
      get viewport() { return vp; }, renderingEngine: re, vpEl, root, panBy, zoomBy, onTap, imageData,
    },
  };
  return api;
}
