// Ultrasound renderer: a virtual curvilinear probe on a CT study, simulated B-mode sector (see bmode.js
// for the physics). Same renderer contract as the mesh and volume renderers. 2D canvas only.
import { loadStudy } from "../volume.js";
import { skinContour, probePose, renderBMode, scanConvert, labelAtPixel, depthToPixel, DEFAULT_RAYS, DEFAULT_SAMPLES } from "./bmode.js";

const W = 512, H = 512, SECTOR = 70, MINI = 150;
const GROUP_RGB = { bone: [230, 237, 243], heart: [255, 107, 107], hollow: [240, 160, 48], lung: [126, 200, 255], muscle: [199, 125, 74], nervous: [255, 225, 74], organ: [95, 224, 138], vessel: [255, 79, 163] };
const GOOD = [63, 185, 80], BAD = [248, 81, 73], SELECT = [79, 179, 255];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap360 = (a) => ((a % 360) + 360) % 360;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(text, title, onClick) {
  const b = el("button", "us-btn", text); b.type = "button"; if (title) b.title = title; b.addEventListener("click", onClick); return b;
}
// The stylesheet is attached by the module itself, so a page need not link it.
function ensureCss() {
  if (typeof document === "undefined" || document.querySelector("link[data-us-css]")) return;
  const href = new URL("./ultrasound.css", import.meta.url).href;
  if ([...document.querySelectorAll("link[rel=stylesheet]")].some((l) => /renderers\/ultrasound\.css/.test(l.href))) return;
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; l.dataset.usCss = "1"; document.head.append(l);
}

export async function createUltrasoundRenderer({ container, studiesBase = "assets/volumes/", initialStudy, onPick } = {}) {
  ensureCss();
  const base0 = document.baseURI;
  const baseDir = studiesBase.endsWith("/") ? studiesBase : studiesBase + "/";
  const studyUrlFor = (sid) => new URL(`${baseDir}${sid}/study.json`, base0).href;
  const cacheByUrl = new Map();
  const loadCached = (url) => {
    let p = cacheByUrl.get(url);
    if (!p) { p = loadStudy(url); cacheByUrl.set(url, p); p.catch(() => cacheByUrl.delete(url)); }
    return p;
  };
  let viewsAll = null;
  const loadViews = async () => {
    if (!viewsAll) {
      try { const r = await fetch(new URL("../ultrasound/views.json", new URL(baseDir, base0))); viewsAll = r.ok ? await r.json() : {}; } catch { viewsAll = {}; }
    }
    return viewsAll;
  };

  // ---------- State ----------
  let volume = null, studyId = null, loading = 0, active = true;
  const pose = { frac: 0.5, angleDeg: 0, tiltDeg: 0, rotDeg: 0, depthMm: 160 };
  const state = { pickEnabled: false, view: null, zoom: 1, outline: false, frozen: false, gainStep: 0, mini: true, pose, highlights: new Map() };
  let views = {};
  const frame = { fan: null, labels: null, rays: DEFAULT_RAYS, samples: DEFAULT_SAMPLES, valid: false, probeOnSlice: null, pose: null };
  let lut = null, labelPix = new Uint16Array(W * H), frameMs = 0, frameCount = 0;
  let groupRgb = [];

  // ---------- DOM ----------
  const root = el("div", "us-root"); root.tabIndex = 0;
  const vpEl = el("div", "us-viewport");
  const canvas = el("canvas", "us-canvas"); canvas.width = W; canvas.height = H;
  vpEl.append(canvas);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const label = el("div", "us-label"); label.hidden = true;
  const loadingEl = el("div", "us-loading", "Loading the scan…"); loadingEl.hidden = true;

  const toolbar = el("div", "us-toolbar");
  const badge = el("span", "us-badge", "Ultrasound · simulated from CT");
  const bTrans = button("Transverse", "Scan plane across the body (R)", () => setPose({ rotDeg: 0 }));
  const bLong = button("Longitudinal", "Scan plane along the body (R)", () => setPose({ rotDeg: 90 }));
  const gPlane = el("div", "us-group"); gPlane.append(bTrans, bLong);
  const bLabels = button("Labels", "Outline every structure", () => { state.outline = !state.outline; syncUI(); draw(); });
  const bFreeze = button("Freeze", "Hold the current image", () => { state.frozen = !state.frozen; syncUI(); if (!state.frozen) schedule(); });
  const bGainM = button("Gain −", "Darker", () => setGain(state.gainStep - 1)), bGainP = button("Gain +", "Brighter", () => setGain(state.gainStep + 1));
  const gGain = el("div", "us-group"); gGain.append(bGainM, bGainP);
  const depthBtns = {};
  const gDepth = el("div", "us-group");
  for (const cm of [10, 16, 22]) { const b = button(`${cm} cm`, `Depth ${cm} cm`, () => setPose({ depthMm: cm * 10 })); depthBtns[cm] = b; gDepth.append(b); }
  const bProbe = button("Probe", "Show or hide the probe map", () => { state.mini = !state.mini; syncUI(); layout(); });
  toolbar.append(badge, gPlane, bLabels, bFreeze, gGain, gDepth, bProbe);

  const mini = el("div", "us-mini");
  const miniRow = el("div", "us-mini-row");
  const miniCv = el("canvas", "us-mini-map"); miniCv.width = MINI; miniCv.height = MINI;
  const mctx = miniCv.getContext("2d");
  const level = el("input", "us-level"); level.type = "range"; level.min = 0; level.max = 100; level.step = 1;
  level.setAttribute("orient", "vertical"); level.setAttribute("aria-label", "Probe level (inferior to superior)");
  miniRow.append(miniCv, level);
  const tiltRow = el("div", "us-tilt-row");
  const tiltTxt = el("span", "", "Tilt 0°");
  const tilt = el("input", "us-tilt"); tilt.type = "range"; tilt.min = -30; tilt.max = 30; tilt.step = 1; tilt.value = 0;
  tilt.setAttribute("aria-label", "Probe tilt (cranial or caudal)");
  tiltRow.append(tiltTxt, tilt);
  mini.append(miniRow, tiltRow);
  root.append(vpEl, toolbar, mini, label, loadingEl);
  container.append(root);

  let box = { left: 0, top: 0, size: 1 }; // the canvas rectangle inside root, CSS px
  function layout() {
    const rr = root.getBoundingClientRect();
    if (!rr.width || !rr.height) return;
    const tb = toolbar.getBoundingClientRect();
    const top = Math.max(44, tb.bottom - rr.top) + 4;
    const size = Math.max(60, Math.floor(Math.min(rr.width, rr.height - top)));
    box = { left: Math.round((rr.width - size) / 2), top, size };
    Object.assign(canvas.style, { left: box.left + "px", top: box.top + "px", width: size + "px", height: size + "px" });
    mini.style.top = top + "px";
    mini.hidden = !state.mini;
  }

  // ---------- Pose and views ----------
  const nz = () => (volume ? volume.dims[2] : 2);
  function normalise(p) { // accepts both {angle, tilt, rot, depth (cm)} and {angleDeg, tiltDeg, rotDeg, depthMm}
    const o = {};
    if (p.frac !== undefined) o.frac = clamp(Number(p.frac), 0, 1);
    const a = p.angleDeg ?? p.angle; if (a !== undefined) o.angleDeg = wrap360(Number(a));
    const t = p.tiltDeg ?? p.tilt; if (t !== undefined) o.tiltDeg = clamp(Number(t), -30, 30);
    const r = p.rotDeg ?? p.rot; if (r !== undefined) o.rotDeg = Number(r);
    if (p.depthMm !== undefined) o.depthMm = Number(p.depthMm);
    else if (p.depth !== undefined) o.depthMm = Number(p.depth) <= 40 ? Number(p.depth) * 10 : Number(p.depth);
    for (const k of Object.keys(o)) if (!Number.isFinite(o[k])) delete o[k];
    if (o.depthMm !== undefined) o.depthMm = clamp(o.depthMm, 60, 300);
    return o;
  }
  function resolveView(v) {
    let s = typeof v === "string" ? v.trim() : "";
    if (s.startsWith("us:")) s = s.slice(3);
    if (s.includes("=")) {
      const o = {};
      for (const part of s.split(",")) { const [k, val] = part.split("="); if (k && val !== undefined) o[k.trim()] = Number(val); }
      return normalise({ frac: 0.5, angle: 0, tilt: 0, rot: 0, depth: 16, ...o });
    }
    if (s && views[s]) return normalise({ tilt: 0, rot: 0, depth: 16, ...views[s] });
    const first = Object.values(views)[0];
    return normalise(first ? { tilt: 0, rot: 0, depth: 16, ...first } : { frac: 0.5, angle: 0, tilt: 0, rot: 0, depth: 16 });
  }
  function setPose(partial, { immediate = true } = {}) {
    Object.assign(pose, normalise(partial));
    syncUI();
    if (immediate) render(); else schedule();
  }

  // ---------- Compute and draw ----------
  function setGain(n) { state.gainStep = clamp(n, -5, 5); syncUI(); if (frame.pose) { compute(frame.pose); draw(); } }
  function compute(p) {
    const t0 = performance.now();
    frame.pose = p;
    renderBMode(volume, p, frame, { rays: frame.rays, samples: frame.samples, sectorDeg: SECTOR, depthMm: p.depthMm, gain: 0.55 * Math.pow(1.2, state.gainStep) });
    frame.valid = true;
    frameMs = performance.now() - t0;
  }
  function draw() {
    if (!frame.valid || !volume) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); return; }
    lut = scanConvert(frame.fan, frame.rays, frame.samples, SECTOR, frame.pose.depthMm, img);
    // Per-pixel structure labels, used for picking, highlights and outlines.
    labelPix.fill(0);
    const { pix, near, n } = lut, labs = frame.labels, d = img.data;
    for (let p = 0; p < n; p++) labelPix[pix[p]] = labs[near[pix[p]]];
    if (state.highlights.size) {
      for (let p = 0; p < n; p++) {
        const q = pix[p], h = state.highlights.get(labelPix[q]);
        if (!h) continue;
        const c = h === "good" ? GOOD : h === "select" ? SELECT : BAD, o = q * 4;
        d[o] = d[o] * 0.55 + c[0] * 0.45; d[o + 1] = d[o + 1] * 0.55 + c[1] * 0.45; d[o + 2] = d[o + 2] * 0.55 + c[2] * 0.45;
      }
    }
    if (state.outline) {
      for (let p = 0; p < n; p++) {
        const q = pix[p], a = labelPix[q];
        let b = 0;
        if (near[q + 1] >= 0 && labelPix[q + 1] !== a) b = labelPix[q + 1];
        else if (q + W < W * H && near[q + W] >= 0 && labelPix[q + W] !== a) b = labelPix[q + W];
        else continue;
        const c = groupRgb[a || b] || [255, 255, 255], o = q * 4;
        d[o] = d[o] * 0.4 + c[0] * 0.6; d[o + 1] = d[o + 1] * 0.4 + c[1] * 0.6; d[o + 2] = d[o + 2] * 0.4 + c[2] * 0.6;
      }
    }
    ctx.putImageData(img, 0, 0);
    drawOverlay();
    drawMini();
  }
  function drawOverlay() {
    const depth = frame.pose.depthMm;
    ctx.save();
    // Faint sector outline so the fan shape reads even where the image is dark.
    ctx.strokeStyle = "rgba(120,140,160,.45)"; ctx.lineWidth = 1; ctx.beginPath();
    ctx.arc(lut.cx, lut.apexY, lut.r0, Math.PI / 2 - lut.half, Math.PI / 2 + lut.half); ctx.moveTo(lut.cx - lut.r0 * Math.sin(lut.half), lut.apexY + lut.r0 * Math.cos(lut.half));
    ctx.lineTo(lut.cx - lut.rmax * Math.sin(lut.half), lut.apexY + lut.rmax * Math.cos(lut.half));
    ctx.arc(lut.cx, lut.apexY, lut.rmax, Math.PI / 2 + lut.half, Math.PI / 2 - lut.half, true);
    ctx.lineTo(lut.cx + lut.r0 * Math.sin(lut.half), lut.apexY + lut.r0 * Math.cos(lut.half)); ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1;
    ctx.font = "12px system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "right";
    for (let mm = 10; mm <= depth; mm += 10) {
      const [x, y] = depthToPixel(lut, mm, depth, 1), major = mm % 20 === 0;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (major ? 7 : 4), y); ctx.stroke();
      if (major) ctx.fillText(String(mm / 10), x - 4, y);
    }
    // Orientation marker: a dot at the top-left of the sector (patient's right in transverse, cranial in longitudinal).
    const rad = lut.r0 + 22, mx = lut.cx - rad * Math.sin(lut.half) + 9, my = lut.apexY + rad * Math.cos(lut.half) + 2;
    ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI * 2); ctx.fillStyle = "#ffd24a"; ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.8)"; ctx.textAlign = "left";
    ctx.fillText(`${(depth / 10).toFixed(0)} cm · ${pose.rotDeg >= 45 ? "long" : "trans"} · tilt ${pose.tiltDeg.toFixed(0)}°${state.frozen ? " · FROZEN" : ""}`, 8, H - 12);
    ctx.restore();
  }

  // ---------- Mini-map ----------
  let sliceCache = { key: "", cv: null };
  const sliceCanvas = () => {
    const k = frame.pose ? frame.pose.k : Math.round(pose.frac * (nz() - 1));
    const key = `${studyId}:${k}`;
    if (sliceCache.key === key) return sliceCache.cv;
    const [nx, ny] = volume.dims;
    const buf = new Int16Array(nx * ny);
    volume.extractSlice(volume.ct, "axial", k, buf); // viewer's left = patient's right, anterior at top
    const cv = document.createElement("canvas"); cv.width = nx; cv.height = ny;
    const c2 = cv.getContext("2d"), id = c2.createImageData(nx, ny);
    const lo = -160, span = 400; // soft window
    for (let n = 0; n < buf.length; n++) { const g = clamp(((buf[n] - lo) / span) * 255, 0, 255); id.data[n * 4] = id.data[n * 4 + 1] = id.data[n * 4 + 2] = g; id.data[n * 4 + 3] = 255; }
    c2.putImageData(id, 0, 0);
    sliceCache = { key, cv };
    return cv;
  };
  const miniGeom = () => {
    const [nx, ny] = volume.dims, sc = MINI / Math.max(nx, ny);
    return { nx, ny, sc, ox: (MINI - nx * sc) / 2, oy: (MINI - ny * sc) / 2 };
  };
  const toMini = (g, i, j) => [g.ox + (g.nx - 1 - i + 0.5) * g.sc, g.oy + (g.ny - 1 - j + 0.5) * g.sc];
  function drawMini() {
    if (!volume || !state.mini || !frame.pose) return;
    const g = miniGeom(), p = frame.pose;
    mctx.fillStyle = "#000"; mctx.fillRect(0, 0, MINI, MINI);
    mctx.imageSmoothingEnabled = true;
    mctx.drawImage(sliceCanvas(), g.ox, g.oy, g.nx * g.sc, g.ny * g.sc);
    const contour = skinContour(volume, p.k);
    mctx.strokeStyle = "rgba(80,200,255,.8)"; mctx.lineWidth = 1; mctx.beginPath();
    contour.forEach((c, n) => { const [x, y] = toMini(g, c.i, c.j); if (n) mctx.lineTo(x, y); else mctx.moveTo(x, y); });
    mctx.closePath(); mctx.stroke();
    const [px, py] = toMini(g, p.contour.i, p.contour.j);
    const [sx] = volume.spacing, pxPerMm = g.sc / sx;
    const bd = [-p.beam[0], -p.beam[1]], bl = Math.hypot(bd[0], bd[1]) || 1, ux = bd[0] / bl, uy = bd[1] / bl; // beam on screen
    // Scan-plane footprint on the slice: a wedge (transverse) or a line (longitudinal).
    const reach = Math.min(p.depthMm * pxPerMm, MINI);
    mctx.fillStyle = "rgba(255,140,26,.22)"; mctx.strokeStyle = "rgba(255,140,26,.8)";
    const lat = [-p.lateral[0], -p.lateral[1]], inPlane = Math.hypot(lat[0], lat[1]);
    if (inPlane > 0.3) {
      const half = (SECTOR * Math.PI) / 360;
      mctx.beginPath(); mctx.moveTo(px, py);
      for (let s = -1; s <= 1; s += 0.25) { const th = s * half; mctx.lineTo(px + (ux * Math.cos(th) + lat[0] / inPlane * Math.sin(th)) * reach, py + (uy * Math.cos(th) + lat[1] / inPlane * Math.sin(th)) * reach); }
      mctx.closePath(); mctx.fill();
    } else { mctx.beginPath(); mctx.moveTo(px, py); mctx.lineTo(px + ux * reach, py + uy * reach); mctx.stroke(); }
    // Probe: orange bar across the skin with an arrow along the beam.
    mctx.strokeStyle = "#ff8c1a"; mctx.fillStyle = "#ff8c1a"; mctx.lineWidth = 4; mctx.lineCap = "round";
    mctx.beginPath(); mctx.moveTo(px - uy * 8, py + ux * 8); mctx.lineTo(px + uy * 8, py - ux * 8); mctx.stroke();
    mctx.lineWidth = 2; mctx.beginPath(); mctx.moveTo(px, py); mctx.lineTo(px + ux * 20, py + uy * 20); mctx.stroke();
    mctx.beginPath(); mctx.moveTo(px + ux * 26, py + uy * 26); mctx.lineTo(px + ux * 17 - uy * 5, py + uy * 17 + ux * 5); mctx.lineTo(px + ux * 17 + uy * 5, py + uy * 17 - ux * 5); mctx.closePath(); mctx.fill();
  }
  function miniAngleFrom(e) {
    const r = miniCv.getBoundingClientRect(), g = miniGeom();
    const x = ((e.clientX - r.left) / r.width) * MINI, y = ((e.clientY - r.top) / r.height) * MINI;
    const c = skinContour(volume, frame.pose ? frame.pose.k : Math.round(pose.frac * (nz() - 1))).centroid;
    const [cx, cy] = toMini(g, c[0], c[1]);
    return wrap360((Math.atan2(x - cx, -(y - cy)) * 180) / Math.PI); // 0 = up (anterior), 90 = screen right (patient's left)
  }
  let miniDrag = false;
  miniCv.addEventListener("pointerdown", (e) => { if (!volume) return; miniDrag = true; miniCv.setPointerCapture?.(e.pointerId); setPose({ angleDeg: miniAngleFrom(e) }, { immediate: false }); e.preventDefault(); });
  miniCv.addEventListener("pointermove", (e) => { if (miniDrag) setPose({ angleDeg: miniAngleFrom(e) }, { immediate: false }); });
  const miniEnd = () => { miniDrag = false; };
  miniCv.addEventListener("pointerup", miniEnd); miniCv.addEventListener("pointercancel", miniEnd);
  level.addEventListener("input", () => setPose({ frac: Number(level.value) / Math.max(1, nz() - 1) }, { immediate: false }));
  tilt.addEventListener("input", () => setPose({ tiltDeg: Number(tilt.value) }, { immediate: false }));

  function syncUI() {
    bTrans.classList.toggle("us-active", pose.rotDeg < 45);
    bLong.classList.toggle("us-active", pose.rotDeg >= 45);
    bLabels.classList.toggle("us-active", state.outline);
    bFreeze.classList.toggle("us-active", state.frozen);
    bProbe.classList.toggle("us-active", state.mini);
    for (const cm of Object.keys(depthBtns)) depthBtns[cm].classList.toggle("us-active", Math.round(pose.depthMm / 10) === Number(cm));
    level.max = Math.max(1, nz() - 1);
    level.value = Math.round(pose.frac * (nz() - 1));
    tilt.value = Math.round(pose.tiltDeg);
    tiltTxt.textContent = `Tilt ${Math.round(pose.tiltDeg)}°`;
  }

  // ---------- Frame scheduling ----------
  let raf = 0;
  function render() { // synchronous: compute (unless frozen) and draw
    if (!volume) return;
    if (!state.frozen || !frame.valid) compute(probePose(volume, pose));
    frameCount++;
    draw();
  }
  function schedule() {
    if (raf || !active) return;
    raf = requestAnimationFrame(() => { raf = 0; if (active && !loading) render(); });
  }

  // ---------- Pick and labels ----------
  const toPixel = (x, y) => [((x - box.left) / box.size) * W, ((y - box.top) / box.size) * H]; // x, y relative to vpEl
  function pickAt(x, y) {
    if (loading || !volume || !lut || !frame.valid) return null;
    const [px, py] = toPixel(x, y);
    const v = labelAtPixel(lut, frame.labels, px, py);
    return v ? volume.keyOf(v) : null;
  }
  function canvasOf(key) {
    if (!volume || !lut || !frame.valid) return null;
    const val = volume.valueOf(key);
    if (val === undefined) return null;
    let sx = 0, sy = 0, n = 0;
    for (let p = 0; p < lut.n; p++) { const q = lut.pix[p]; if (labelPix[q] === val) { sx += q % W; sy += (q / W) | 0; n++; } }
    if (!n) return null;
    sx /= n; sy /= n;
    let best = -1, bd = Infinity;
    for (let p = 0; p < lut.n; p++) { const q = lut.pix[p]; if (labelPix[q] === val) { const dd = (q % W + 0.5 - sx) ** 2 + (((q / W) | 0) + 0.5 - sy) ** 2; if (dd < bd) { bd = dd; best = q; } } }
    return [box.left + (((best % W) + 0.5) / W) * box.size, box.top + ((((best / W) | 0) + 0.5) / H) * box.size];
  }
  let labelTimer = 0;
  function showLabel(text, x, y, ms = 0) {
    clearTimeout(labelTimer);
    if (!text) { label.hidden = true; return; }
    label.textContent = text; label.style.left = x + "px"; label.style.top = y + "px"; label.hidden = false;
    if (ms) labelTimer = setTimeout(() => { label.hidden = true; }, ms);
  }

  // ---------- Pointer interaction on the main canvas ----------
  let g = null;
  const rel = (e) => { const r = vpEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  vpEl.addEventListener("contextmenu", (e) => e.preventDefault());
  vpEl.addEventListener("pointerdown", (e) => {
    if (!active) return;
    vpEl.setPointerCapture?.(e.pointerId);
    g = { id: e.pointerId, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, acc: 0, type: e.pointerType };
    label.hidden = true; root.focus({ preventScroll: true }); e.preventDefault();
  });
  vpEl.addEventListener("pointermove", (e) => {
    if (!active) return;
    if (!g || g.id !== e.pointerId) {
      if (e.pointerType === "mouse" && !state.pickEnabled && !e.buttons) { const [x, y] = rel(e); const k = pickAt(x, y); showLabel(k && volume.name(k), x, y); }
      return;
    }
    if (loading) return;
    if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 6) g.moved = true;
    if (g.moved) {
      const dx = e.clientX - g.lx, dy = e.clientY - g.ly;
      g.acc += dy;
      const step = Math.max(6, box.size / (nz() * 0.6)); // px per slice
      const slices = Math.trunc(g.acc / step);
      const p2 = {};
      if (dx) p2.angleDeg = pose.angleDeg + dx * 0.4; // drag right: probe moves toward the patient's left
      if (slices) { g.acc -= slices * step; p2.frac = pose.frac - slices / Math.max(1, nz() - 1); } // drag up: probe moves up the body
      if (dx || slices) setPose(p2, { immediate: false });
    }
    g.lx = e.clientX; g.ly = e.clientY;
    e.preventDefault();
  });
  function end(e) {
    if (!g || g.id !== e.pointerId) return;
    const was = g; g = null;
    if (e.type === "pointerup" && !was.moved && !loading && volume) {
      const [x, y] = rel(e), key = pickAt(x, y);
      api.debug.lastTap = { x, y, key };
      if (state.pickEnabled) { label.hidden = true; if (key && onPick) onPick(key); }
      else showLabel(key && volume.name(key), x, y, was.type === "mouse" ? 0 : 1500);
    }
  }
  vpEl.addEventListener("pointerup", end);
  vpEl.addEventListener("pointercancel", end);
  vpEl.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !state.pickEnabled) label.hidden = true; });
  vpEl.addEventListener("wheel", (e) => {
    if (!active || !volume) return;
    e.preventDefault();
    setPose({ frac: pose.frac + (e.deltaY > 0 ? -1 : 1) / Math.max(1, nz() - 1) }, { immediate: false });
  }, { passive: false });
  const onKey = (e) => {
    if (!active || !volume || root.offsetParent === null) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key, N = Math.max(1, nz() - 1);
    if (k === "ArrowLeft") setPose({ angleDeg: pose.angleDeg - 3 }, { immediate: false });
    else if (k === "ArrowRight") setPose({ angleDeg: pose.angleDeg + 3 }, { immediate: false });
    else if (k === "ArrowUp") setPose({ frac: pose.frac + 1 / N }, { immediate: false });
    else if (k === "ArrowDown") setPose({ frac: pose.frac - 1 / N }, { immediate: false });
    else if (k === "q" || k === "Q") setPose({ tiltDeg: pose.tiltDeg - 5 }, { immediate: false });
    else if (k === "e" || k === "E") setPose({ tiltDeg: pose.tiltDeg + 5 }, { immediate: false });
    else if (k === "r" || k === "R") setPose({ rotDeg: pose.rotDeg >= 45 ? 0 : 90 }, { immediate: false });
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  const onResize = () => { layout(); if (volume && frame.valid) draw(); };
  window.addEventListener("resize", onResize);
  if (typeof ResizeObserver === "function") new ResizeObserver(onResize).observe(root);

  // ---------- Study swap and show() queue ----------
  function swapStudy(vol) {
    volume = vol; studyId = vol.meta.id || studyId;
    groupRgb = [];
    for (const [v, key] of vol.valueToKey) groupRgb[v] = GROUP_RGB[vol.group(key)] || [255, 255, 255];
    views = (viewsAll && viewsAll[studyId]) || {};
    frame.valid = false; sliceCache = { key: "", cv: null };
    state.highlights.clear(); state.outline = false; state.frozen = false;
    badge.textContent = `Ultrasound · simulated from CT · ${studyId}`;
    api.debug.views = views;
  }
  let busy = null, pendingArgs = null;
  async function applyShow({ view, layers, study } = {}) {
    loading++; loadingEl.hidden = false;
    try {
      await loadViews();
      if (study && study !== studyId) { const vol = await loadCached(studyUrlFor(study)); studyId = study; swapStudy(vol); }
      else if (!volume && studyId) { swapStudy(await loadCached(studyUrlFor(studyId))); }
      if (!volume) return;
      views = (viewsAll && viewsAll[studyId]) || {}; api.debug.views = views;
      state.view = typeof view === "string" ? view : null;
      state.outline = !!(layers && (layers.includes("labels") || layers.includes("outline")));
      state.highlights.clear(); state.frozen = false;
      Object.assign(pose, resolveView(view));
      layout(); syncUI();
    } catch (err) { console.error(err); } finally { loading--; loadingEl.hidden = loading === 0; }
    if (volume && active) render();
  }
  function show(args = {}) {
    pendingArgs = args;
    if (!busy) busy = (async () => { while (pendingArgs) { const a = pendingArgs; pendingArgs = null; await applyShow(a); } busy = null; })();
    return busy;
  }

  const api = {
    show,
    async loadStudy(sid) { await loadViews(); await loadCached(studyUrlFor(sid)); return sid; },
    get studyId() { return studyId; },
    get meta() { return volume ? volume.meta : null; },
    highlight(key, kind) {
      if (loading || !volume) return;
      const v = volume.valueOf(key);
      if (v === undefined) return;
      state.highlights.set(v, kind === "good" || kind === "select" ? kind : "bad");
      if (frame.valid) draw();
    },
    clearHighlight() { state.highlights.clear(); if (frame.valid && !loading) draw(); },
    name: (key) => (volume ? volume.name(key) : key),
    setDefaultLayers() { state.outline = false; syncUI(); if (frame.valid) draw(); },
    setPickEnabled(on) { state.pickEnabled = !!on; if (on) label.hidden = true; },
    setActive(on) {
      active = !!on;
      if (!active) { cancelAnimationFrame(raf); raf = 0; label.hidden = true; g = null; return; }
      layout(); if (volume) render();
    },
    debug: {
      get volume() { return volume; }, state, get loading() { return loading; }, vpEl, rootEl: root, root,
      get pose() { return pose; }, setPose: (p) => setPose(p), get frame() { return frame; }, views, render, get frameMs() { return frameMs; },
      get frameCount() { return frameCount; }, canvasOf, pickAt, canvas, mini, resolveView, layout,
    },
  };

  // ---------- Initial study ----------
  studyId = initialStudy || null;
  if (initialStudy) { loading++; loadingEl.hidden = false; try { await loadViews(); swapStudy(await loadCached(studyUrlFor(initialStudy))); } finally { loading--; loadingEl.hidden = loading === 0; } }
  state.mini = (root.getBoundingClientRect().width || window.innerWidth) >= 600; // the probe map would cover the sector on a phone
  layout(); syncUI();
  Object.assign(pose, resolveView(null));
  syncUI();
  if (volume) render();
  return api;
}
