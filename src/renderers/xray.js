// X-ray renderer: a digitally reconstructed radiograph (see drr.js) computed in the browser from the CT studies
// the app already ships. Same return shape as the mesh and volume renderers. One canvas fills `container`; the
// toolbar sits across the top (from 44px down) so the question panel never covers it.
import { loadStudy } from "../volume.js";
import { projectDRR } from "./drr.js";

// The stylesheet is attached here as well as via index.html, so the module works on any page.
try {
  if (typeof document !== "undefined" && !document.querySelector('link[href*="xray.css"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = new URL("./xray.css", import.meta.url).href;
    document.head.append(l);
  }
} catch { /* styling is cosmetic */ }

const TINT = { good: "#3fb950", bad: "#f85149", select: "#4fb3ff" };
const GROUP_COLOR = { bone: "#ffd24a", heart: "#ff6b6b", organ: "#4ecdc4", lung: "#7cc4ff", hollow: "#ffa657",
  vessel: "#ff7eb6", muscle: "#c9a0ff", nervous: "#a5f36b" };
const GROUPS = { all: null, bones: ["bone"], lungs: ["lung"], heart: ["heart", "vessel"], organs: ["organ", "hollow", "muscle"] };
const GROUP_LABEL = { all: "All", bones: "Bones", lungs: "Lungs", heart: "Heart+vessels", organs: "Organs" };
const EDGES = { ap: { left: "R", right: "L" }, lateral: { left: "A", right: "P" } };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// "ap", "lateral", "ap:zoom=2,cx=0.4,cy=0.3", optional ",invert". A study may name views in meta.xrayViews.
export function parseView(meta, view) {
  const out = { axis: "ap", zoom: 1, cx: 0.5, cy: 0.5, invert: false };
  let spec = view;
  const named = typeof view === "string" ? meta?.xrayViews?.[view] : null;
  if (named) spec = named;
  if (spec && typeof spec === "object") {
    if (spec.axis === "ap" || spec.axis === "lateral") out.axis = spec.axis;
    for (const k of ["zoom", "cx", "cy"]) if (Number.isFinite(Number(spec[k])) && spec[k] !== undefined) out[k] = Number(spec[k]);
    out.invert = !!spec.invert;
  } else if (typeof spec === "string") {
    const [head, ...rest] = spec.split(/[:,]/).map((s) => s.trim()).filter(Boolean);
    if (head === "ap" || head === "lateral") out.axis = head;
    for (const t of rest) {
      if (t === "invert") out.invert = true;
      const m = /^(zoom|cx|cy)=(-?[\d.]+)$/.exec(t);
      if (m && Number.isFinite(Number(m[2]))) out[m[1]] = Number(m[2]);
    }
  }
  out.zoom = clamp(out.zoom, 1, 12); out.cx = clamp(out.cx, 0, 1); out.cy = clamp(out.cy, 0, 1);
  return out;
}

export async function createXrayRenderer({ container, studiesBase = "assets/volumes/", initialStudy, onPick } = {}) {
  const base0 = document.baseURI;
  const studyUrlFor = (sid) => new URL(`${studiesBase.endsWith("/") ? studiesBase : studiesBase + "/"}${sid}/study.json`, base0).href;
  const volCache = new Map(); // url -> Promise<volume>
  const getVol = (sid) => {
    const url = studyUrlFor(sid);
    let p = volCache.get(url);
    if (!p) { p = loadStudy(url); volCache.set(url, p); p.catch(() => volCache.delete(url)); }
    return p;
  };
  const drrCache = new Map(); // volume -> { ap, lateral }

  let volume = null, meta = { structures: {} }, studyId = null, drr = null;
  let loading = 0, active = true, dirty = true, baseDirty = true, hlDirty = true;
  const state = { pickEnabled: false, view: "ap", axis: "ap", zoom: 1, cx: 0.5, cy: 0.5, invert: false, outline: false, group: "all", focus: null,
    level: 0.5, width: 1, highlights: {} };
  const highlights = new Map(); // label value -> "good" | "bad"

  // ---------- DOM ----------
  const root = el("div", "xr-root");
  const vpEl = el("div", "xr-viewport");
  const canvas = el("canvas");
  vpEl.append(canvas);
  const edgeL = el("span", "xr-edge xr-edge-left"), edgeR = el("span", "xr-edge xr-edge-right");
  const label = el("div", "xr-label"); label.hidden = true;
  const loadingEl = el("div", "xr-loading", "Loading the scan…"); loadingEl.hidden = true;
  const toolbar = el("div", "xr-toolbar");
  const badge = el("span", "xr-badge", "X-ray");
  const btn = (text, cls, onClick, aria) => {
    const b = el("button", "xr-btn " + (cls || ""), text); b.type = "button";
    if (aria) b.setAttribute("aria-label", aria);
    b.addEventListener("click", onClick); return b;
  };
  const apBtn = btn("AP", "", () => setAxis("ap")), latBtn = btn("Lateral", "", () => setAxis("lateral"));
  apBtn.dataset.axis = "ap"; latBtn.dataset.axis = "lateral";
  const invBtn = btn("Invert", "", () => { state.invert = !state.invert; baseDirty = true; syncUI(); });
  const lblBtn = btn("Labels", "", () => { state.outline = !state.outline; syncUI(); mark(); });
  const groupBtns = {};
  const groupRow = el("span", "xr-group");
  for (const g of Object.keys(GROUPS)) {
    const b = btn(GROUP_LABEL[g], "xr-gbtn", () => setGroup(g)); b.dataset.group = g; groupBtns[g] = b; groupRow.append(b);
  }
  const zout = btn("−", "xr-zoom", () => zoomBy(0.8), "Zoom out"), zin = btn("+", "xr-zoom", () => zoomBy(1.25), "Zoom in");
  const zrst = btn("Reset", "", () => { state.zoom = 1; state.cx = state.cy = 0.5; syncUI(); mark(); });
  zin.dataset.zoom = "in"; zout.dataset.zoom = "out"; zrst.dataset.zoom = "reset";
  const slider = (name, min, max, onInput) => {
    const wrap = el("label", "xr-slider-wrap", name);
    const s = el("input", "xr-slider"); s.type = "range"; s.min = min; s.max = max; s.step = 0.01; s.setAttribute("aria-label", name);
    s.addEventListener("input", () => onInput(Number(s.value)));
    wrap.append(s); return [wrap, s];
  };
  // Brightness raises the picture (lowers the window level); contrast narrows the window (width = 1 / contrast).
  const [briWrap, briS] = slider("Brightness", 0, 1, (v) => setWindow(1 - v, state.width));
  const [conWrap, conS] = slider("Contrast", 0.5, 4, (v) => setWindow(state.level, 1 / v));
  briS.dataset.control = "brightness"; conS.dataset.control = "contrast";
  toolbar.append(badge, apBtn, latBtn, invBtn, lblBtn, groupRow, zout, zin, zrst, briWrap, conWrap);
  root.append(vpEl, edgeL, edgeR, toolbar, label, loadingEl);
  container.append(root);

  const ctx = canvas.getContext("2d");
  const off = document.createElement("canvas"), offCtx = off.getContext("2d");
  const hlCanvas = document.createElement("canvas"), hlCtx = hlCanvas.getContext("2d");
  let cssW = 0, cssH = 0, dpr = 1;

  function mark() { dirty = true; }
  function syncUI() {
    apBtn.classList.toggle("xr-active", state.axis === "ap");
    latBtn.classList.toggle("xr-active", state.axis === "lateral");
    invBtn.classList.toggle("xr-active", state.invert);
    lblBtn.classList.toggle("xr-active", state.outline);
    for (const g of Object.keys(groupBtns)) groupBtns[g].classList.toggle("xr-active", g === state.group);
    briS.value = 1 - state.level; conS.value = clamp(1 / state.width, 0.5, 4);
    const e = EDGES[state.axis];
    edgeL.textContent = e.left; edgeR.textContent = e.right;
    badge.textContent = `X-ray · ${studyId || ""} · ${state.axis === "ap" ? "AP" : "Lateral"}`;
    state.highlights = Object.fromEntries([...highlights].map(([v, k]) => [volume ? volume.keyOf(v) : v, k]));
    placeEdges();
  }

  // ---------- Geometry ----------
  // The image is fitted below the toolbar so controls never cover it; edge letters sit at mid-height of that area.
  function fitRect() {
    const top = Math.min(cssH * 0.5, toolbar.offsetTop + toolbar.offsetHeight + 2);
    // On phones the app's bottom panels (#question, #explore-bar) cover the film; fit above the highest one.
    let bottom = cssH;
    if (window.innerWidth < 600) {
      const rr = root.getBoundingClientRect();
      for (const id of ["question", "explore-bar"]) {
        const e = document.getElementById(id);
        if (!e || e.hidden) continue;
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const y = r.top - rr.top;
        if (y > top + 80 && y < bottom) bottom = y;
      }
    }
    return { x: 0, y: top, w: cssW, h: Math.max(1, bottom - top) };
  }
  function xform() {
    const f = fitRect();
    const s = drr ? Math.min(f.w / drr.width, f.h / drr.height) * state.zoom : 1;
    const w = drr ? drr.width : 1, h = drr ? drr.height : 1;
    return { s, ox: f.x + f.w / 2 - state.cx * w * s, oy: f.y + f.h / 2 - state.cy * h * s, f };
  }
  const toImage = (x, y) => { const t = xform(); return [(x - t.ox) / t.s, (y - t.oy) / t.s]; };
  const toCanvas = (ix, iy) => { const t = xform(); return [t.ox + ix * t.s, t.oy + iy * t.s]; };
  function placeEdges() {
    const f = fitRect();
    edgeL.style.top = edgeR.style.top = f.y + f.h / 2 + "px";
  }
  function resize() {
    const r = root.getBoundingClientRect();
    cssW = Math.max(1, r.width); cssH = Math.max(1, r.height); dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    placeEdges(); mark();
  }

  // ---------- Projection ----------
  function projection(axis) {
    let e = drrCache.get(volume);
    if (!e) { e = {}; drrCache.set(volume, e); }
    return e[axis] || (e[axis] = projectDRR(volume, { axis }));
  }
  function setAxis(a) {
    if (a !== "ap" && a !== "lateral") return;
    if (!volume) { state.axis = a; return; }
    if (a !== state.axis || !drr) {
      state.axis = a; drr = projection(a); sizeOffscreen();
      state.zoom = 1; state.cx = state.cy = 0.5;
    }
    state.view = a; baseDirty = hlDirty = true; label.hidden = true; syncUI(); mark();
  }
  function sizeOffscreen() {
    off.width = hlCanvas.width = drr.width; off.height = hlCanvas.height = drr.height;
  }
  function setWindow(level, width) {
    state.level = clamp(Number(level), 0, 1); state.width = clamp(Number(width), 0.2, 2);
    baseDirty = true; syncUI(); mark();
  }
  function zoomBy(f, px, py) {
    if (!drr) return;
    const cxp = px ?? cssW / 2, cyp = py ?? fitRect().y + fitRect().h / 2;
    const [ix, iy] = toImage(cxp, cyp);
    state.zoom = clamp(state.zoom * f, 1, 12);
    const t = xform(); // keep the image point under the pointer fixed
    state.cx = clamp((ix - (cxp - t.f.x - t.f.w / 2) / t.s) / drr.width, 0, 1);
    state.cy = clamp((iy - (cyp - t.f.y - t.f.h / 2) / t.s) / drr.height, 0, 1);
    if (state.zoom === 1) state.cx = state.cy = 0.5;
    syncUI(); mark();
  }

  // ---------- Drawing ----------
  let outlinePaths = null; // group -> Path2D in image pixel coordinates, built per projection
  let outlineFor = null;
  function buildOutlines() {
    outlineFor = drr; outlinePaths = new Map();
    const { width: w, height: h, silhouettes } = drr;
    for (const [v, m] of silhouettes) {
      const g = meta.structures[String(v)]?.group || "organ";
      let path = outlinePaths.get(g);
      if (!path) { path = new Path2D(); outlinePaths.set(g, path); }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        if (y === 0 || !m[(y - 1) * w + x]) { path.moveTo(x, y); path.lineTo(x + 1, y); }
        if (y === h - 1 || !m[(y + 1) * w + x]) { path.moveTo(x, y + 1); path.lineTo(x + 1, y + 1); }
        if (x === 0 || !m[y * w + x - 1]) { path.moveTo(x, y); path.lineTo(x, y + 1); }
        if (x === w - 1 || !m[y * w + x + 1]) { path.moveTo(x + 1, y); path.lineTo(x + 1, y + 1); }
      }
    }
  }
  const labelPaths = new Map(); // drr -> Map(value -> Path2D)
  function labelPath(v) {
    let m = labelPaths.get(drr);
    if (!m) { m = new Map(); labelPaths.set(drr, m); }
    let path = m.get(v);
    if (!path) {
      path = new Path2D(); m.set(v, path);
      const { width: w, height: h } = drr, mk = drr.silhouettes.get(v);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!mk[y * w + x]) continue;
        if (y === 0 || !mk[(y - 1) * w + x]) { path.moveTo(x, y); path.lineTo(x + 1, y); }
        if (y === h - 1 || !mk[(y + 1) * w + x]) { path.moveTo(x, y + 1); path.lineTo(x + 1, y + 1); }
        if (x === 0 || !mk[y * w + x - 1]) { path.moveTo(x, y); path.lineTo(x, y + 1); }
        if (x === w - 1 || !mk[y * w + x + 1]) { path.moveTo(x + 1, y); path.lineTo(x + 1, y + 1); }
      }
    }
    return path;
  }
  function paintBase() {
    const { width: w, height: h, image } = drr;
    const id = offCtx.createImageData(w, h), d = id.data;
    const lo = state.level - state.width / 2, inv = 1 / state.width;
    for (let p = 0; p < w * h; p++) {
      let v = clamp((image[p] - lo) * inv, 0, 1);
      if (state.invert) v = 1 - v;
      const g = Math.round(v * 255);
      d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = g; d[p * 4 + 3] = 255;
    }
    offCtx.putImageData(id, 0, 0);
    baseDirty = false;
  }
  function paintHighlights() {
    const { width: w, height: h, silhouettes } = drr;
    hlCtx.clearRect(0, 0, w, h);
    const id = hlCtx.createImageData(w, h), d = id.data;
    for (const [v, kind] of highlights) {
      const m = silhouettes.get(v); if (!m) continue;
      const c = TINT[kind]; const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
      for (let p = 0; p < w * h; p++) if (m[p]) { d[p * 4] = r; d[p * 4 + 1] = g; d[p * 4 + 2] = b; d[p * 4 + 3] = 255; }
    }
    hlCtx.putImageData(id, 0, 0);
    hlDirty = false;
  }
  function render() {
    dirty = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!drr) return;
    if (baseDirty) paintBase();
    if (hlDirty) paintHighlights();
    const t = xform();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, t.ox, t.oy, drr.width * t.s, drr.height * t.s);
    if (highlights.size) {
      ctx.globalAlpha = 0.45;
      ctx.drawImage(hlCanvas, t.ox, t.oy, drr.width * t.s, drr.height * t.s);
      ctx.globalAlpha = 1;
    }
    if (state.outline) {
      if (outlineFor !== drr) buildOutlines();
      ctx.setTransform(dpr * t.s, 0, 0, dpr * t.s, dpr * t.ox, dpr * t.oy);
      const want = GROUPS[state.group];
      ctx.globalAlpha = 0.2; ctx.lineWidth = 1 / t.s; ctx.lineJoin = "round";
      for (const [g, path] of outlinePaths) {
        if (want && !want.includes(g)) continue;
        ctx.strokeStyle = GROUP_COLOR[g] || "#fff"; ctx.stroke(path);
      }
      const fm = state.focus && drr.silhouettes.get(state.focus);
      if (fm) {
        const g = meta.structures[String(state.focus)]?.group;
        if (!want || want.includes(g)) {
          ctx.globalAlpha = 1; ctx.lineWidth = 2 / t.s; ctx.strokeStyle = GROUP_COLOR[g] || "#fff";
          ctx.stroke(labelPath(state.focus));
        }
      }
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  let raf = 0;
  function loop() {
    raf = 0;
    if (!active) return;
    if (dirty) render();
    raf = requestAnimationFrame(loop);
  }
  function startLoop() { if (!raf && active) raf = requestAnimationFrame(loop); }

  // ---------- Pick ----------
  // With a group chosen, pick resolves only among that group's structures (smallest silhouette wins where
  // several overlap); with All, it is the drr pick map, unchanged.
  const groupPicks = new Map(); // drr -> { groupName: Uint16Array }
  function pickMap() {
    if (!drr || state.group === "all") return drr ? drr.pick : null;
    let e = groupPicks.get(drr);
    if (!e) { e = {}; groupPicks.set(drr, e); }
    if (e[state.group]) return e[state.group];
    const want = GROUPS[state.group], n = drr.width * drr.height, out = new Uint16Array(n), area = new Float32Array(n).fill(Infinity);
    for (const [v, m] of drr.silhouettes) {
      if (!want.includes(meta.structures[String(v)]?.group)) continue;
      let a = 0; for (let p = 0; p < n; p++) a += m[p];
      for (let p = 0; p < n; p++) if (m[p] && a < area[p]) { area[p] = a; out[p] = v; }
    }
    return (e[state.group] = out);
  }
  function setGroup(g) {
    if (!GROUPS.hasOwnProperty(g)) return;
    state.group = g; state.focus = null; label.hidden = true; syncUI(); mark();
  }
  function setFocus(v) { v = v || null; if (v !== state.focus) { state.focus = v; mark(); } }
  function labelAtImage(ix, iy) {
    if (!drr) return 0;
    const x = Math.floor(ix), y = Math.floor(iy);
    if (x < 0 || y < 0 || x >= drr.width || y >= drr.height) return 0;
    return pickMap()[y * drr.width + x];
  }
  function pickAt(x, y) {
    if (loading || !volume) return null;
    const [ix, iy] = toImage(x, y);
    const v = labelAtImage(ix, iy);
    return v ? volume.keyOf(v) : null;
  }
  // A pixel the structure owns in the pick map, nearest its projected centroid (so pickAt(canvasOf(k)) === k).
  function canvasOf(key) {
    if (!volume || !drr) return null;
    const v = volume.valueOf(key), c = drr.centroids.get(v);
    if (!c) return null;
    const { width: w, height: h } = drr, pick = pickMap();
    let best = -1, bd = Infinity;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (pick[y * w + x] !== v) continue;
      const d = (x + 0.5 - c[0]) ** 2 + (y + 0.5 - c[1]) ** 2;
      if (d < bd) { bd = d; best = y * w + x; }
    }
    if (best < 0) return null;
    return toCanvas((best % w) + 0.5, Math.floor(best / w) + 0.5);
  }
  let labelTimer = 0;
  function showLabel(text, x, y, ms) {
    clearTimeout(labelTimer);
    if (!text) { label.hidden = true; return; }
    label.textContent = text; label.style.left = x + "px"; label.style.top = y + "px"; label.hidden = false;
    if (ms) labelTimer = setTimeout(() => { label.hidden = true; }, ms);
  }
  function onTap(e) {
    if (loading || !volume) return;
    const r = vpEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const key = pickAt(x, y);
    api.debug.lastTap = { x, y, key };
    setFocus(key && volume.valueOf(key));
    if (state.pickEnabled) { label.hidden = true; if (key && onPick) onPick(key); }
    else showLabel(key && volume.name(key), x, y, e.pointerType === "mouse" ? 0 : 1500);
  }

  // ---------- Pointer ----------
  const ptrs = new Map();
  let gesture = null;
  const pts = () => [...ptrs.values()];
  vpEl.addEventListener("contextmenu", (e) => e.preventDefault());
  vpEl.addEventListener("pointerdown", (e) => {
    if (!active) return;
    vpEl.setPointerCapture?.(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) gesture = { sx: e.clientX, sy: e.clientY, moved: false, multi: false };
    else { const [a, b] = pts(); gesture = { ...(gesture || {}), multi: true, moved: true, d: Math.hypot(a.x - b.x, a.y - b.y) }; }
    label.hidden = true; e.preventDefault();
  });
  vpEl.addEventListener("pointermove", (e) => {
    if (!active) return;
    const p = ptrs.get(e.pointerId);
    const r = vpEl.getBoundingClientRect();
    if (!p) {
      if (e.pointerType === "mouse" && !e.buttons) {
        const x = e.clientX - r.left, y = e.clientY - r.top, k = pickAt(x, y);
        showLabel(k && volume.name(k), x, y);
        setFocus(k && volume.valueOf(k));
      }
      return;
    }
    if (loading) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (!gesture) return;
    if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 6) gesture.moved = true;
    if (ptrs.size >= 2) {
      const [a, b] = pts(), d = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.d > 0 && d > 0) zoomBy(d / gesture.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      gesture.d = d;
    } else if (gesture.moved && state.zoom > 1 && drr) {
      const t = xform();
      state.cx = clamp(state.cx - dx / (t.s * drr.width), 0, 1);
      state.cy = clamp(state.cy - dy / (t.s * drr.height), 0, 1);
      mark();
    }
    e.preventDefault();
  });
  function end(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    const g = gesture;
    if (ptrs.size === 0) {
      gesture = null;
      if (e.type === "pointerup" && g && !g.moved && !g.multi) onTap(e);
    } else if (g) g.moved = true;
  }
  vpEl.addEventListener("pointerup", end);
  vpEl.addEventListener("pointercancel", end);
  vpEl.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { label.hidden = true; setFocus(0); } });
  vpEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = vpEl.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  for (const t of ["touchstart", "touchmove"]) vpEl.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(root);
  window.addEventListener("resize", resize);
  // Refit when a bottom panel appears, hides or changes height.
  const refit = () => { placeEdges(); mark(); };
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(refit), seen = new Set();
    const watch = () => { for (const id of ["question", "explore-bar"]) { const e = document.getElementById(id); if (e && !seen.has(e)) { seen.add(e); ro.observe(e); } } };
    watch();
    if (typeof MutationObserver === "function") new MutationObserver(() => { watch(); refit(); })
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
  }

  // ---------- Study / show ----------
  async function swapStudy(sid) {
    const vol = await getVol(sid);
    await nextFrame(); // let the loading text paint before the projection blocks the thread
    volume = vol; meta = vol.meta; studyId = sid;
    highlights.clear(); drr = null; outlineFor = null;
    setAxis(state.axis);
  }
  function applyShow({ view, layers } = {}) {
    if (!volume) return;
    const v = parseView(meta, view);
    highlights.clear(); hlDirty = true; state.focus = null;
    state.outline = !!(layers && (layers.includes("labels") || layers.includes("outline")));
    state.invert = v.invert;
    state.level = 0.5; state.width = 1;
    if (v.axis !== state.axis || !drr) setAxis(v.axis);
    state.zoom = v.zoom; state.cx = v.zoom > 1 ? v.cx : 0.5; state.cy = v.zoom > 1 ? v.cy : 0.5;
    state.view = typeof view === "string" && view ? view : v.axis;
    baseDirty = true; label.hidden = true; syncUI(); mark();
  }
  let latest = 0, queue = Promise.resolve();
  const api = {
    show({ view, layers, study } = {}) {
      const ticket = ++latest;
      if (!loading && (!study || study === studyId)) { applyShow({ view, layers }); return Promise.resolve(); }
      loading++; loadingEl.hidden = false;
      const run = queue.then(async () => {
        if (ticket !== latest) return;
        if (study && study !== studyId) await swapStudy(study);
        if (ticket !== latest) return;
        applyShow({ view, layers });
      });
      queue = run.catch(() => {});
      return run.finally(() => { loading--; if (!loading) loadingEl.hidden = true; });
    },
    async loadStudy(sid) { await getVol(sid); return sid; },
    get studyId() { return studyId; },
    highlight(key, kind) {
      if (loading || !volume) return;
      const v = volume.valueOf(key);
      if (v === undefined) return;
      highlights.set(v, TINT[kind] ? kind : "bad");
      hlDirty = true; syncUI(); mark();
    },
    clearHighlight() { highlights.clear(); hlDirty = true; if (volume) syncUI(); mark(); },
    name: (key) => (volume ? volume.name(key) : key),
    setDefaultLayers() { state.outline = false; syncUI(); mark(); },
    setPickEnabled(on) { state.pickEnabled = !!on; if (on) label.hidden = true; },
    setActive(on) {
      active = !!on;
      vpEl.style.pointerEvents = active ? "" : "none";
      if (active) { resize(); mark(); startLoop(); } else { cancelAnimationFrame(raf); raf = 0; label.hidden = true; ptrs.clear(); gesture = null; }
    },
    get meta() { return meta; },
    debug: {
      get volume() { return volume; }, state, get loading() { return loading; }, vpEl, rootEl: root, canvasOf, pickAt,
      get drr() { return drr; }, get axis() { return state.axis; }, setAxis, setGroup, setWindow, render, zoomBy, onTap,
    },
  };

  resize();
  startLoop();
  if (initialStudy) {
    loading++; loadingEl.hidden = false;
    try { await swapStudy(initialStudy); } finally { loading--; if (!loading) loadingEl.hidden = true; }
  } else syncUI();
  return api;
}
