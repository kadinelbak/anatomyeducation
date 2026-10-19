// Slide renderer: a stained histology section shown as a tile pyramid (assets/slides/<id>/tiles/<level>/<col>_<row>.<fmt>)
// on one 2D canvas, with pan, zoom and clickable label polygons (study.json, see docs/cell-formats.md). Same return shape
// as the xray, mesh and volume renderers; the toolbar sits across the top (from 44px down) so the question panel never
// covers it. Polygons are in level-0 pixel coordinates; picking is point-in-polygon, smallest containing polygon wins.
// Zoom is relative to fit (1 = the whole slide fits below the toolbar); the badge shows a nominal magnification 4 * zoom.

// The stylesheet is attached here as well as via index.html, so the module works on any page.
try {
  if (typeof document !== "undefined" && !document.querySelector('link[href*="slide.css"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = new URL("./slide.css", import.meta.url).href;
    document.head.append(l);
  }
} catch { /* styling is cosmetic */ }

const TINT = { good: "#3fb950", bad: "#f85149", select: "#4fb3ff" };
const GROUP_COLOR = { cell: "#2f6feb", organelle: "#ffd24a", connective: "#3fb9a8", vessel: "#ff7a00", nerve: "#a5f36b", bone: "#8b949e" };
const GROUP_LABEL = { all: "All", cell: "Cells", organelle: "Organelles", connective: "Connective", vessel: "Vessels" };
const MAX_ZOOM = 40, CACHE_MAX = 500;
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

// "overview", {cx,cy,zoom} or "cx=0.4,cy=0.3,zoom=3"; missing or unknown = the study's defaultView.
export function parseView(meta, view) {
  const out = { cx: 0.5, cy: 0.5, zoom: 1 };
  let spec = view;
  if (typeof view === "string" && meta?.views?.[view]) spec = meta.views[view];
  else if (!view || (typeof view === "string" && !view.includes("="))) spec = meta?.views?.[meta?.defaultView];
  if (spec && typeof spec === "object") {
    for (const k of ["zoom", "cx", "cy"]) if (spec[k] !== undefined && spec[k] !== null && Number.isFinite(Number(spec[k]))) out[k] = Number(spec[k]);
  } else if (typeof spec === "string") {
    for (const t of spec.split(/[:,]/).map((s) => s.trim())) {
      const m = /^(zoom|cx|cy)=(-?[\d.]+)$/.exec(t);
      if (m && Number.isFinite(Number(m[2]))) out[m[1]] = Number(m[2]);
    }
  }
  out.zoom = clamp(out.zoom, 1, MAX_ZOOM); out.cx = clamp(out.cx, 0, 1); out.cy = clamp(out.cy, 0, 1);
  return out;
}

function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Precompute per-structure area, bbox, centroid and Path2D (level-0 coordinates); sorted smallest area first for picking.
function prepare(study) {
  const list = [];
  for (const [key, s] of Object.entries(study.structures || {})) {
    const poly = s.polygon || [];
    if (poly.length < 3) continue;
    let a2 = 0, cx = 0, cy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const path = new Path2D();
    poly.forEach(([x, y], i) => {
      const [xn, yn] = poly[(i + 1) % poly.length], f = x * yn - xn * y;
      a2 += f; cx += (x + xn) * f; cy += (y + yn) * f;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      if (i) path.lineTo(x, y); else path.moveTo(x, y);
    });
    path.closePath();
    const area = Math.abs(a2) / 2;
    const c = a2 ? [cx / (3 * a2), cy / (3 * a2)] : [(x0 + x1) / 2, (y0 + y1) / 2];
    list.push({ key, name: s.name || key, group: s.group || "cell", poly, area, bbox: [x0, y0, x1, y1], centroid: c, path });
  }
  list.sort((p, q) => p.area - q.area);
  const levels = [...(study.levels || [study.width])].sort((a, b) => b - a);
  return { study, list, byKey: new Map(list.map((s) => [s.key, s])), levels, groups: new Set(list.map((s) => s.group)), anchors: new Map() };
}

export async function createSlideRenderer({ container, studiesBase = "assets/slides/", initialStudy, onPick, textAssets } = {}) {
  const base0 = document.baseURI;
  const base = studiesBase.endsWith("/") ? studiesBase : studiesBase + "/";
  const useText = () => (textAssets !== undefined ? !!textAssets : window.__CONFIG_TEXT_ASSETS === true);
  // Hosts that cap the number of files get one bundle per pyramid level (tiles/<level>.b64.json, made by
  // tools/bundle_tiles.py: { "<col>_<row>": "<base64 jpeg>" }) instead of one .b64.txt per tile.
  const useBundles = () => window.__CONFIG_TILE_BUNDLES === true;
  const bundleCache = new Map(); // "<sid>/<level>" -> Promise<object>
  const getBundle = (sid, level) => {
    const key = `${sid}/${level}`;
    let p = bundleCache.get(key);
    if (!p) {
      const url = new URL(`${base}${sid}/tiles/${level}.b64.json`, base0).href;
      p = fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
      bundleCache.set(key, p);
    }
    return p;
  };
  const b64Blob = (text, type) => {
    const bin = atob(text.trim()), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type });
  };
  const studyCache = new Map(); // id -> Promise<prepared study>
  const getStudy = (sid) => {
    let p = studyCache.get(sid);
    if (!p) {
      const url = new URL(`${base}${sid}/study.json`, base0).href;
      p = fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }).then(prepare);
      studyCache.set(sid, p); p.catch(() => studyCache.delete(sid));
    }
    return p;
  };
  const tileCaches = new Map(); // study id -> Map("level/col/row" -> {img, w, h})
  const pendingTiles = new Map(); // "sid|level/col/row" -> Promise
  const failedTiles = new Set();

  let cur = null, studyId = null, active = true, dirty = true, loadingStudy = 0, levelInUse = 0, focusTimer = 0;
  const state = { view: "", zoom: 1, cx: 0.5, cy: 0.5, layers: ["none"], pickEnabled: false, group: "all", focus: null };
  const highlights = new Map(); // key -> "good" | "bad"

  // ---------- DOM ----------
  const root = el("div", "sl-root");
  const vpEl = el("div", "sl-viewport"); vpEl.tabIndex = 0;
  const canvas = el("canvas");
  vpEl.append(canvas);
  const label = el("div", "sl-label"); label.hidden = true;
  const loadingEl = el("div", "sl-loading", "Loading the slide…"); loadingEl.hidden = true;
  const toolbar = el("div", "sl-toolbar");
  const badge = el("span", "sl-badge", "Histology");
  const btn = (text, cls, onClick, aria) => {
    const b = el("button", "sl-btn " + (cls || ""), text); b.type = "button";
    if (aria) b.setAttribute("aria-label", aria);
    b.addEventListener("click", onClick); return b;
  };
  const zout = btn("−", "sl-zoom", () => zoomBy(0.8), "Zoom out"), zin = btn("+", "sl-zoom", () => zoomBy(1.25), "Zoom in");
  const zrst = btn("Reset zoom", "", () => { state.zoom = 1; state.cx = state.cy = 0.5; syncUI(); mark(); });
  zin.dataset.zoom = "in"; zout.dataset.zoom = "out"; zrst.dataset.zoom = "reset";
  const lblBtn = btn("Labels", "", () => { setLayers(mode() === "labels" ? ["none"] : ["labels"]); });
  const groupRow = el("span", "sl-group");
  const groupBtns = {};
  toolbar.append(badge, zout, zin, zrst, lblBtn, groupRow);
  root.append(vpEl, toolbar, label, loadingEl);
  container.append(root);

  const ctx = canvas.getContext("2d");
  let cssW = 0, cssH = 0, dpr = 1;

  const mark = () => { dirty = true; };
  const mode = () => (state.layers.includes("labels") ? "labels" : state.layers.includes("outline") ? "outline" : "none");
  const nominal = () => Math.max(4, Math.round(4 * state.zoom));
  function setLayers(layers) { state.layers = [...layers]; syncUI(); mark(); }
  function buildGroupRow() {
    groupRow.textContent = ""; for (const k of Object.keys(groupBtns)) delete groupBtns[k];
    if (!cur) return;
    for (const g of Object.keys(GROUP_LABEL)) {
      if (g !== "all" && !cur.groups.has(g)) continue;
      const b = btn(GROUP_LABEL[g], "sl-gbtn", () => setGroup(g)); b.dataset.group = g; groupBtns[g] = b; groupRow.append(b);
    }
  }
  function syncUI() {
    lblBtn.classList.toggle("sl-active", mode() === "labels");
    for (const g of Object.keys(groupBtns)) groupBtns[g].classList.toggle("sl-active", g === state.group);
    badge.textContent = `Histology · ${cur?.study.title || studyId || ""} · ${nominal()}x`;
    state.view = state.view || "";
  }
  function setGroup(g) {
    if (g !== "all" && !(cur && cur.groups.has(g))) return;
    state.group = g; state.focus = null; label.hidden = true; syncUI(); mark();
  }
  const visible = (s) => state.group === "all" || s.group === state.group;

  // ---------- Geometry ----------
  // The slide is fitted below the toolbar; on phones it also stays above the app's bottom panels.
  function fitRect() {
    const top = Math.min(cssH * 0.5, toolbar.offsetTop + toolbar.offsetHeight + 2);
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
  const SW = () => cur?.study.width || 1, SH = () => cur?.study.height || 1;
  function xform() {
    const f = fitRect(), w = SW(), h = SH();
    const s = cur ? Math.min(f.w / w, f.h / h) * state.zoom : 1;
    return { s, ox: f.x + f.w / 2 - state.cx * w * s, oy: f.y + f.h / 2 - state.cy * h * s, f };
  }
  const toSlide = (x, y) => { const t = xform(); return [(x - t.ox) / t.s, (y - t.oy) / t.s]; };
  const toCanvas = (sx, sy) => { const t = xform(); return [t.ox + sx * t.s, t.oy + sy * t.s]; };
  function resize() {
    const r = root.getBoundingClientRect();
    cssW = Math.max(1, r.width); cssH = Math.max(1, r.height); dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    mark(); // the view centre (cx, cy) is stored as fractions, so it stays fixed
  }
  function clampView() {
    if (state.zoom <= 1.0001) { state.zoom = Math.max(1, state.zoom); state.cx = state.cy = 0.5; return; }
    state.zoom = Math.min(state.zoom, MAX_ZOOM); state.cx = clamp(state.cx, 0, 1); state.cy = clamp(state.cy, 0, 1);
  }
  function zoomBy(f, px, py) {
    if (!cur) return;
    const fr = fitRect(), cxp = px ?? cssW / 2, cyp = py ?? fr.y + fr.h / 2;
    const [ix, iy] = toSlide(cxp, cyp);
    state.zoom = clamp(state.zoom * f, 1, MAX_ZOOM);
    const t = xform(); // keep the slide point under the pointer fixed
    state.cx = (ix - (cxp - t.f.x - t.f.w / 2) / t.s) / SW();
    state.cy = (iy - (cyp - t.f.y - t.f.h / 2) / t.s) / SH();
    clampView(); syncUI(); mark();
  }
  function panBy(dx, dy) { // dx, dy in CSS pixels
    const t = xform();
    state.cx -= dx / (t.s * SW()); state.cy -= dy / (t.s * SH());
    clampView(); mark();
  }

  // ---------- Tiles ----------
  function chooseLevel() { // smallest level that still gives >= 1 image pixel per device pixel, capped at level 0
    const need = SW() * xform().s * dpr, lv = cur.levels;
    for (let i = lv.length - 1; i >= 0; i--) if (lv[i] >= need) return lv[i];
    return lv[0];
  }
  // Tiles of `level` that intersect the canvas, as {key, c, r}; `margin` adds that many tiles around.
  function tilesFor(level, margin = 0) {
    const st = cur.study, k = level / st.width, ts = st.tileSize || 256, tl = ts / k;
    const nc = Math.ceil(level / ts), nr = Math.ceil(Math.round(st.height * k) / ts);
    const [ax, ay] = toSlide(0, 0), [bx, by] = toSlide(cssW, cssH);
    const c0 = clamp(Math.floor(ax / tl) - margin, 0, nc - 1), c1 = clamp(Math.floor(bx / tl) + margin, 0, nc - 1);
    const r0 = clamp(Math.floor(ay / tl) - margin, 0, nr - 1), r1 = clamp(Math.floor(by / tl) + margin, 0, nr - 1);
    const out = [];
    if (bx < 0 || by < 0 || ax > st.width || ay > st.height) return out;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push({ key: `${level}/${c}/${r}`, level, c, r });
    return out;
  }
  const neededTiles = () => {
    if (!cur) return [];
    const lv = cur.levels, out = tilesFor(lv[lv.length - 1]);
    const L = chooseLevel(); if (L !== lv[lv.length - 1]) out.push(...tilesFor(L));
    return out;
  };
  async function fetchTile(sid, st, t) {
    const ext = st.format || "jpg", url = new URL(`${base}${sid}/tiles/${t.level}/${t.c}_${t.r}.${ext}`, base0).href;
    let blob;
    if (useBundles()) {
      const b = await getBundle(sid, t.level), text = b[`${t.c}_${t.r}`];
      if (!text) throw new Error(`no tile ${t.c}_${t.r} in bundle ${t.level}`);
      blob = b64Blob(text, MIME[ext] || "image/jpeg");
    } else if (useText()) {
      const r = await fetch(url + ".b64.txt"); if (!r.ok) throw new Error(r.status);
      blob = b64Blob(await r.text(), MIME[ext] || "image/jpeg");
    } else {
      const r = await fetch(url); if (!r.ok) throw new Error(r.status);
      blob = await r.blob();
    }
    if (typeof createImageBitmap === "function") return createImageBitmap(blob);
    const u = URL.createObjectURL(blob), im = new Image();
    im.src = u; await im.decode(); URL.revokeObjectURL(u); return im;
  }
  function requestTile(t) {
    const sid = studyId, st = cur.study, pk = `${sid}|${t.key}`;
    let tc = tileCaches.get(sid); if (!tc) tileCaches.set(sid, (tc = new Map()));
    if (tc.has(t.key) || pendingTiles.has(pk) || failedTiles.has(pk)) return;
    const p = fetchTile(sid, st, t).then((img) => {
      tc.set(t.key, { img, w: img.width, h: img.height });
      if (tc.size > CACHE_MAX) { // drop oldest tiles of the finer levels; the coarsest level stays
        const keep = `${cur?.levels[cur.levels.length - 1]}/`;
        for (const k of tc.keys()) { if (tc.size <= CACHE_MAX - 50) break; if (!k.startsWith(keep)) tc.delete(k); }
      }
    }).catch(() => failedTiles.add(pk)).finally(() => { pendingTiles.delete(pk); mark(); });
    pendingTiles.set(pk, p);
  }
  const tileLoaded = (t) => tileCaches.get(studyId)?.has(t.key) || failedTiles.has(`${studyId}|${t.key}`);
  const isLoading = () => loadingStudy > 0 || (!!cur && neededTiles().some((t) => !tileLoaded(t)));
  function ensureTiles() {
    if (!cur) return;
    for (const t of neededTiles()) requestTile(t);
    for (const t of tilesFor(levelInUse, 1)) requestTile(t); // prefetch one tile around the view
  }

  // ---------- Drawing ----------
  function drawTiles() {
    const tc = tileCaches.get(studyId); if (!tc) return;
    const t = xform(), k0 = cur.study.width, lv = cur.levels;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    // coarse to fine, so a missing fine tile shows the stretched coarser one instead of black
    for (let i = lv.length - 1; i >= 0; i--) {
      if (lv[i] > levelInUse) break;
      const k = lv[i] / k0, ts = cur.study.tileSize || 256;
      for (const tl of tilesFor(lv[i])) {
        const e = tc.get(tl.key); if (!e) continue;
        const x0 = Math.floor((t.ox + (tl.c * ts / k) * t.s) * dpr), y0 = Math.floor((t.oy + (tl.r * ts / k) * t.s) * dpr);
        const x1 = Math.ceil((t.ox + ((tl.c * ts + e.w) / k) * t.s) * dpr), y1 = Math.ceil((t.oy + ((tl.r * ts + e.h) / k) * t.s) * dpr);
        ctx.drawImage(e.img, x0, y0, x1 - x0, y1 - y0);
      }
    }
  }
  function render() {
    dirty = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!cur) return;
    levelInUse = chooseLevel();
    ensureTiles();
    drawTiles();
    const t = xform(), m = mode(), [vx0, vy0] = toSlide(0, 0), [vx1, vy1] = toSlide(cssW, cssH);
    const onScreen = (s) => s.bbox[2] >= vx0 && s.bbox[0] <= vx1 && s.bbox[3] >= vy0 && s.bbox[1] <= vy1;
    ctx.setTransform(dpr * t.s, 0, 0, dpr * t.s, dpr * t.ox, dpr * t.oy);
    ctx.lineJoin = "round";
    for (const [key, kind] of highlights) {
      const s = cur.byKey.get(key); if (!s) continue;
      ctx.fillStyle = rgba(TINT[kind], 0.35); ctx.fill(s.path);
      ctx.lineWidth = 2 / t.s; ctx.strokeStyle = TINT[kind]; ctx.stroke(s.path);
    }
    if (m !== "none") {
      ctx.lineWidth = 1 / t.s;
      for (const s of cur.list) {
        if (!visible(s) || !onScreen(s)) continue;
        ctx.strokeStyle = rgba(GROUP_COLOR[s.group] || "#ffffff", 0.45); ctx.stroke(s.path);
      }
    }
    const fs = state.focus && cur.byKey.get(state.focus);
    if (fs) { ctx.lineWidth = 2 / t.s; ctx.strokeStyle = GROUP_COLOR[fs.group] || "#fff"; ctx.stroke(fs.path); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (m === "labels") {
      ctx.font = "600 12px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineWidth = 3; ctx.lineJoin = "round";
      for (const s of cur.list) {
        if (!visible(s) || !onScreen(s) || (s.bbox[2] - s.bbox[0]) * t.s < 40) continue;
        const [x, y] = toCanvas(s.centroid[0], s.centroid[1]);
        ctx.strokeStyle = "rgba(13,17,23,.85)"; ctx.strokeText(s.name, x, y);
        ctx.fillStyle = "#fff"; ctx.fillText(s.name, x, y);
      }
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
  function pickL0(x, y, any) {
    if (!cur) return null;
    for (const s of cur.list) {
      if (!any && !visible(s)) continue;
      const b = s.bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      if (inPoly(s.poly, x, y)) return s.key;
    }
    return null;
  }
  function pickAt(x, y) {
    if (!cur || loadingStudy) return null;
    const [sx, sy] = toSlide(x, y);
    return sx < 0 || sy < 0 || sx > SW() || sy > SH() ? null : pickL0(sx, sy, false);
  }
  // A level-0 point the structure owns (its centroid if it picks itself, else the nearest grid point that does).
  function anchorOf(key) {
    const s = cur?.byKey.get(key); if (!s) return null;
    let a = cur.anchors.get(key);
    if (a) return a;
    a = s.centroid;
    if (pickL0(a[0], a[1], true) !== key) {
      let bd = Infinity; const [x0, y0, x1, y1] = s.bbox;
      for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) {
        const x = x0 + ((x1 - x0) * i) / 24, y = y0 + ((y1 - y0) * j) / 24, d = (x - s.centroid[0]) ** 2 + (y - s.centroid[1]) ** 2;
        if (d < bd && pickL0(x, y, true) === key) { bd = d; a = [x, y]; }
      }
    }
    cur.anchors.set(key, a); return a;
  }
  const canvasOf = (key) => { const a = anchorOf(key); return a ? toCanvas(a[0], a[1]) : null; };
  let labelTimer = 0;
  function showLabel(text, x, y, ms) {
    clearTimeout(labelTimer);
    if (!text) { label.hidden = true; return; }
    label.textContent = text; label.style.left = x + "px"; label.style.top = y + "px"; label.hidden = false;
    if (ms) labelTimer = setTimeout(() => { label.hidden = true; }, ms);
  }
  function setFocus(key, ms) {
    clearTimeout(focusTimer); key = key || null;
    if (key !== state.focus) { state.focus = key; mark(); }
    if (key && ms) focusTimer = setTimeout(() => { state.focus = null; mark(); }, ms);
  }
  function onTap(e) {
    if (!cur || loadingStudy) return;
    const r = vpEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const key = pickAt(x, y);
    api.debug.lastTap = { x, y, key };
    if (state.pickEnabled) { label.hidden = true; if (key && onPick) onPick(key); return; }
    showLabel(key && api.name(key), x, y, e.pointerType === "mouse" ? 0 : 1500);
    setFocus(key, 1500);
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
    const p = ptrs.get(e.pointerId), r = vpEl.getBoundingClientRect();
    if (!p) {
      if (e.pointerType === "mouse" && !e.buttons && !state.pickEnabled) {
        const x = e.clientX - r.left, y = e.clientY - r.top, k = pickAt(x, y);
        showLabel(k && api.name(k), x, y);
      }
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (!gesture) return;
    if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 6) gesture.moved = true;
    if (ptrs.size >= 2) {
      const [a, b] = pts(), d = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.d > 0 && d > 0) zoomBy(d / gesture.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      gesture.d = d;
    } else if (gesture.moved) panBy(dx, dy);
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
  vpEl.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !ptrs.size) label.hidden = true; });
  vpEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = vpEl.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  vpEl.addEventListener("keydown", (e) => {
    const step = 60, d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (d) { panBy(d[0], d[1]); e.preventDefault(); }
    else if (e.key === "+" || e.key === "=") zoomBy(1.25); else if (e.key === "-") zoomBy(0.8);
  });
  for (const t of ["touchstart", "touchmove"]) vpEl.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(container);
  window.addEventListener("resize", resize);
  // Refit when a bottom panel appears, hides or changes height.
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(mark), seen = new Set();
    const watch = () => { for (const id of ["question", "explore-bar"]) { const e = document.getElementById(id); if (e && !seen.has(e)) { seen.add(e); ro.observe(e); } } };
    watch();
    if (typeof MutationObserver === "function") new MutationObserver(() => { watch(); mark(); })
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
  }

  // ---------- Study / show ----------
  async function swapStudy(sid) {
    const p = await getStudy(sid);
    cur = p; studyId = sid; highlights.clear(); state.focus = null; state.group = "all"; label.hidden = true;
    buildGroupRow(); state.layers = [...(p.study.defaultLayers || ["none"])];
    syncUI(); mark();
  }
  function applyShow({ view, layers } = {}) {
    if (!cur) return;
    const v = parseView(cur.study, view);
    highlights.clear(); state.focus = null; label.hidden = true;
    state.layers = [...(Array.isArray(layers) && layers.length ? layers : cur.study.defaultLayers || ["none"])];
    state.zoom = v.zoom; state.cx = v.cx; state.cy = v.cy; clampView();
    state.view = typeof view === "string" && view ? view : typeof view === "object" && view ? "custom" : cur.study.defaultView || "";
    syncUI(); render();
  }
  let latest = 0, queue = Promise.resolve();
  const api = {
    show({ view, layers, study } = {}) {
      const ticket = ++latest;
      if (!loadingStudy && (!study || study === studyId)) { applyShow({ view, layers }); return Promise.resolve(); }
      loadingStudy++; loadingEl.hidden = false;
      const run = queue.then(async () => {
        if (ticket !== latest) return;
        if (study && study !== studyId) await swapStudy(study);
        if (ticket !== latest) return;
        applyShow({ view, layers });
      });
      queue = run.catch(() => {});
      return run.finally(() => { loadingStudy--; if (!loadingStudy) loadingEl.hidden = true; });
    },
    async loadStudy(sid) { await getStudy(sid); return sid; },
    get studyId() { return studyId; },
    highlight(key, kind) {
      if (!cur || !cur.byKey.has(key)) return;
      highlights.set(key, TINT[kind] ? kind : "bad"); mark();
    },
    clearHighlight() { highlights.clear(); mark(); },
    name: (key) => cur?.byKey.get(key)?.name || cur?.study.structures?.[key]?.name || key,
    setDefaultLayers() { setLayers(cur?.study.defaultLayers || ["none"]); },
    setPickEnabled(on) { state.pickEnabled = !!on; if (on) { label.hidden = true; setFocus(null); } },
    setActive(on) {
      active = !!on;
      vpEl.style.pointerEvents = active ? "" : "none";
      if (active) { resize(); mark(); startLoop(); } else { cancelAnimationFrame(raf); raf = 0; label.hidden = true; ptrs.clear(); gesture = null; }
    },
    get meta() {
      const s = cur?.study || {}, out = {};
      for (const k of ["id", "title", "kind", "license", "attribution", "source", "sourceUrl", "stain", "magnification", "tissue", "cells", "sections", "synthetic"]) out[k] = s[k];
      return out;
    },
    debug: {
      root, vpEl, state, render, pickAt, canvasOf, onTap, zoomBy, setGroup,
      get levelInUse() { return levelInUse; },
      get tilesLoaded() { return tileCaches.get(studyId)?.size || 0; },
      get loading() { return isLoading(); },
    },
  };
  Object.defineProperty(state, "loading", { get: isLoading, enumerable: true });

  resize();
  startLoop();
  if (initialStudy) {
    loadingStudy++; loadingEl.hidden = false;
    try { await swapStudy(initialStudy); applyShow({}); } finally { loadingStudy--; if (!loadingStudy) loadingEl.hidden = true; }
  } else syncUI();
  return api;
}
