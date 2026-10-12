// Cell renderer: a stylised 3D cell built from procedural primitives listed in assets/cells/<id>/study.json
// (see docs/cell-formats.md). Same return shape as the mesh, xray and slide renderers. One canvas fills
// `container` (not the window); the toolbar sits across the top (from 44px down) so the question panel never
// covers it. Parts are pickable by raycast, highlight is an emissive tint, the cutaway is a clip plane at x = 0
// on the membrane materials plus a 15% opaque membrane. The animation loop runs only while the renderer is active
// and draws only when something changed (controls, tween, layers, highlight).
//
// Spec extensions beyond the doc (all optional): a stamped part may carry `step: [dx,dy,dz]` (offset per copy),
// `jitter` (number or [jx,jy,jz], deterministic random offset), `ring: [radius, axis, startDeg, perTurn]` (copies
// spread around an axis), `spin: true` + `spinStart`/`spinArc` degrees (copies fanned about z, for tubes) and
// `rotJitter`. Without these a stamped part's copies would all sit on top of each other.
import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import { probeWebGL } from "../webgl-probe.js";

// The stylesheet is attached here as well as via index.html, so the module works on any page.
try {
  if (typeof document !== "undefined" && !document.querySelector('link[href*="cell.css"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = new URL("./cell.css", import.meta.url).href;
    document.head.append(l);
  }
} catch { /* styling is cosmetic */ }

const HIGHLIGHT_GOOD = new THREE.Color(0x2ee68a);
const HIGHLIGHT_BAD = new THREE.Color(0xff3b3b);
const CUT_OPACITY = 0.15;
const TWEEN_MS = 400;
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function hashStr(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const vec3 = (a, d = 0) => new THREE.Vector3(...(Array.isArray(a) ? [a[0] ?? d, a[1] ?? d, a[2] ?? d] : [d, d, d]));

export async function createCellRenderer({ container, studiesBase = "assets/cells/", initialStudy, onPick } = {}) {
  const base0 = document.baseURI;
  const studyUrlFor = (sid) => new URL(`${studiesBase.endsWith("/") ? studiesBase : studiesBase + "/"}${sid}/study.json`, base0).href;

  // ---------- WebGL, scene, camera, controls ----------
  const probe = probeWebGL({ antialias: true, stencil: false });
  let renderer;
  if (probe.attributesHonoured) renderer = new THREE.WebGLRenderer({ canvas: probe.canvas, context: probe.context, antialias: true });
  else {
    probe.context.getExtension("WEBGL_lose_context")?.loseContext();
    renderer = new THREE.WebGLRenderer({ antialias: false });
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.localClippingEnabled = true;
  const releaseGL = () => { try { renderer.forceContextLoss(); renderer.dispose(); } catch { /* already gone */ } };
  window.addEventListener("pagehide", releaseGL);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1419);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
  camera.position.set(0, 2, 8);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.7);
  keyLight.position.set(0.5, 0.8, 0.6);
  camera.add(keyLight);
  scene.add(camera);
  const root3 = new THREE.Group(); // parts and label sprites of the current study
  scene.add(root3);
  const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e6); // keeps x <= constant

  // ---------- DOM ----------
  const root = el("div", "cl-root");
  const vp = el("div", "cl-viewport");
  vp.append(renderer.domElement);
  const toolbar = el("div", "cl-toolbar");
  const badge = el("span", "cl-badge", "Cell");
  const mkBtn = (text, cls, title, fn) => {
    const b = el("button", "cl-btn" + (cls ? " " + cls : ""), text);
    b.type = "button"; if (title) { b.title = title; b.setAttribute("aria-label", title); }
    b.addEventListener("click", fn);
    return b;
  };
  const bOverview = mkBtn("Overview", "", "Default view", () => applyView(study?.defaultView, true));
  const bCut = mkBtn("Cutaway", "", "Toggle the cutaway", () => toggleLayer("cutaway"));
  const bLabels = mkBtn("Labels", "", "Toggle the part names", () => toggleLayer("labels"));
  const bReset = mkBtn("Reset", "", "Default layers and view", () => { setDefaultLayers(); applyView(study?.defaultView, true); });
  const bOut = mkBtn("−", "cl-zoom", "Zoom out", () => zoomBy(1.25));
  const bIn = mkBtn("+", "cl-zoom", "Zoom in", () => zoomBy(0.8));
  toolbar.append(badge, bOverview, bCut, bLabels, bReset, bOut, bIn);
  const label = el("div", "cl-label"); label.hidden = true;
  const loadingEl = el("div", "cl-loading", "Loading the cell…"); loadingEl.hidden = true;
  root.append(vp, toolbar, label, loadingEl);
  container.append(root);

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 3; controls.zoomSpeed = 1; controls.panSpeed = 0.6; controls.dynamicDampingFactor = 0.15;
  controls.minDistance = 1.5; controls.maxDistance = 30;
  renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---------- State ----------
  let active = true, dirty = true, raf = 0, loading = 0;
  let study = null, studyId = null;
  const cache = new Map(); // id -> Promise<study json>
  const state = { view: null, layers: [], pickEnabled: false };
  let layerSet = new Set();
  let meshes = [], sprites = []; // current study's part meshes and label sprites
  const byKey = new Map(), byBase = new Map(), partOf = new Map(); // key -> mesh, base key -> [mesh], key -> part
  let highlighted = [];
  const tween = { active: false };
  const mark = () => { dirty = true; };
  controls.addEventListener("change", mark);

  // ---------- Building parts ----------
  const unit = {
    sphere: new THREE.SphereGeometry(1, 24, 16),
    cylinder: new THREE.CylinderGeometry(1, 1, 1, 24, 1),
    box: new THREE.BoxGeometry(2, 2, 2),
  };
  const own = []; // per-study geometries and materials to dispose
  function geometryFor(p) {
    const s = p.size || [0.3];
    switch (p.shape) {
      case "torus": { const g = new THREE.TorusGeometry(s[0] ?? 0.5, s[1] ?? 0.1, 12, 24); own.push(g); return [g, [1, 1, 1]]; }
      case "tube": {
        const pts = (p.path || [[0, 0, 0], [1, 0, 0]]).map((q) => vec3(q));
        const curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
        const g = new THREE.TubeGeometry(curve, Math.min(24, pts.length * 6), s[0] ?? 0.05, 6, false);
        own.push(g); return [g, [1, 1, 1]];
      }
      case "box": return [unit.box, [s[0] ?? 0.3, s[1] ?? s[0] ?? 0.3, s[2] ?? s[0] ?? 0.3]];
      case "cylinder": case "band": return [unit.cylinder, [s[0] ?? 0.2, s[2] ?? 1, s[1] ?? s[0] ?? 0.2]];
      case "disc": return [unit.cylinder, [s[0] ?? 0.5, s[1] ?? 0.05, s[0] ?? 0.5]];
      case "ellipsoid": return [unit.sphere, [s[0] ?? 0.3, s[1] ?? s[0] ?? 0.3, s[2] ?? s[0] ?? 0.3]];
      default: return [unit.sphere, [s[0] ?? 0.3, s[0] ?? 0.3, s[0] ?? 0.3]]; // sphere
    }
  }
  function makeMaterial(p) {
    const opacity = p.opacity ?? 1;
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(p.color || "#cccccc"), roughness: 0.6, metalness: 0.05,
      opacity, transparent: opacity < 1, depthWrite: opacity >= 1,
      side: p.layer === "membrane" || p.shape === "tube" || p.shape === "torus" ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (p.layer === "membrane") m.clippingPlanes = [clipPlane];
    own.push(m);
    return m;
  }
  function textSprite(text, at) {
    const c = document.createElement("canvas");
    c.width = 320; c.height = 64;
    const g = c.getContext("2d");
    g.font = "600 26px system-ui, sans-serif";
    const w = Math.min(312, g.measureText(text).width + 24);
    g.fillStyle = "rgba(15,20,25,.82)"; g.strokeStyle = "#3a4654"; g.lineWidth = 2;
    g.beginPath(); g.roundRect((320 - w) / 2, 8, w, 48, 10); g.fill(); g.stroke();
    g.fillStyle = "#e6edf3"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 160, 33, 300);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(1.0, 0.2, 1); sp.position.copy(at); sp.renderOrder = 999;
    sp.raycast = () => {}; // never pickable
    sp.userData.label = true;
    own.push(tex, mat);
    return sp;
  }
  function clearStudy() {
    for (const o of [...root3.children]) root3.remove(o);
    for (const d of own) d.dispose?.();
    own.length = 0; meshes = []; sprites = []; highlighted = [];
    byKey.clear(); byBase.clear(); partOf.clear();
  }
  function buildStudy(s) {
    clearStudy();
    for (const p of s.parts || []) {
      const [geo, scl] = geometryFor(p);
      const n = Math.max(1, p.count | 0 || 1);
      const jit = Array.isArray(p.jitter) ? p.jitter : [p.jitter || 0, p.jitter || 0, p.jitter || 0];
      const step = vec3(p.step);
      const rnd = rng(hashStr(p.key));
      const mat = makeMaterial(p);
      const list = [];
      for (let i = 0; i < n; i++) {
        const key = n > 1 ? `${p.key}-${i + 1}` : p.key;
        const mesh = new THREE.Mesh(geo, i ? mat.clone() : mat);
        if (i) own.push(mesh.material);
        mesh.scale.set(...scl);
        mesh.position.copy(vec3(p.pos)).addScaledVector(step, i);
        if (p.ring) { // copies evenly around an axis: ring = [radius, axis 0|1|2, start degrees, copies per turn]
          const [R, ax = 0, st = 0, per] = p.ring, a = ((st + 360 * i / (per || n)) * Math.PI) / 180, c = R * Math.cos(a), sn = R * Math.sin(a);
          mesh.position.add(ax === 0 ? new THREE.Vector3(0, c, sn) : ax === 1 ? new THREE.Vector3(c, 0, sn) : new THREE.Vector3(c, sn, 0));
        }
        if (n > 1) mesh.position.add(new THREE.Vector3((rnd() - 0.5) * 2 * jit[0], (rnd() - 0.5) * 2 * jit[1], (rnd() - 0.5) * 2 * jit[2]));
        const r = vec3(p.rot);
        mesh.rotation.set(r.x, r.y, r.z);
        if (p.spin) { // copies fanned about z: spinStart degrees, spinArc degrees in total (360 = full turn)
          const arc = p.spinArc ?? 360;
          mesh.rotation.z += (((p.spinStart ?? 0) + (arc >= 360 ? (arc * i) / n : n > 1 ? (arc * i) / (n - 1) : 0)) * Math.PI) / 180;
        }
        if (n > 1 && p.rotJitter) mesh.rotation.x += (rnd() - 0.5) * p.rotJitter, mesh.rotation.z += (rnd() - 0.5) * p.rotJitter;
        mesh.userData = { key, base: p.key, layer: p.layer || "organelles", name: p.name || p.key, baseOpacity: p.opacity ?? 1 };
        mesh.userData.baseEmissive = mesh.material.emissive.clone();
        root3.add(mesh); meshes.push(mesh); byKey.set(key, mesh); partOf.set(key, p); list.push(mesh);
      }
      byBase.set(p.key, list);
      partOf.set(p.key, p);
      if (!p.nolabel && p.layer !== "cutaway") {
        const sp = textSprite((p.name || p.key).replace(/\s*\(.*\)\s*/, ""), list[0].position);
        sp.userData.layer = "labels"; root3.add(sp); sprites.push(sp);
      }
    }
    root3.updateMatrixWorld(true);
  }

  // ---------- Layers ----------
  function applyLayers() {
    const cut = layerSet.has("cutaway");
    clipPlane.constant = cut ? 0 : 1e6;
    for (const m of meshes) {
      const l = m.userData.layer;
      let vis;
      if (l === "membrane") vis = layerSet.has("membrane") || cut;
      else if (l === "cutaway") vis = cut;
      else if (l === "labels") vis = layerSet.has("labels");
      else vis = layerSet.has("organelles");
      m.visible = vis;
      if (l === "membrane") {
        const o = cut ? Math.min(CUT_OPACITY, m.userData.baseOpacity) : m.userData.baseOpacity;
        const tr = o < 1;
        if (m.material.opacity !== o || m.material.transparent !== tr) { m.material.opacity = o; m.material.transparent = tr; m.material.depthWrite = !tr; m.material.needsUpdate = true; }
      }
    }
    for (const sp of sprites) sp.visible = layerSet.has("labels");
    state.layers = [...layerSet];
    bCut.classList.toggle("cl-active", cut); bCut.setAttribute("aria-pressed", String(cut));
    const lb = layerSet.has("labels");
    bLabels.classList.toggle("cl-active", lb); bLabels.setAttribute("aria-pressed", String(lb));
    mark();
  }
  function setLayers(list) { layerSet = new Set(list || []); applyLayers(); }
  function toggleLayer(name) {
    if (layerSet.has(name)) layerSet.delete(name); else layerSet.add(name);
    label.hidden = true; applyLayers();
  }
  function setDefaultLayers() { setLayers(study?.defaultLayers || ["membrane", "organelles"]); }

  // ---------- Views ----------
  const narrowK = () => { const a = camera.aspect || 1; return a < 1 ? 1 / Math.max(0.3, Math.min(1, a * 0.85)) : 1; };
  function applyView(name, animate = true) {
    if (!study) return;
    const views = study.views || {};
    if (!views[name]) name = study.defaultView && views[study.defaultView] ? study.defaultView : Object.keys(views)[0];
    const v = views[name] || { eye: [0, 1.5, 7], target: [0, 0, 0] };
    state.view = name;
    const target = vec3(v.target);
    const eye = target.clone().add(vec3(v.eye).sub(target).multiplyScalar(narrowK()));
    label.hidden = true;
    camera.up.set(0, 1, 0);
    if (!animate) {
      tween.active = false;
      camera.position.copy(eye); controls.target.copy(target); camera.lookAt(target);
      controls.update(); mark(); return;
    }
    Object.assign(tween, { active: true, start: performance.now(), fromPos: camera.position.clone(), toPos: eye, fromTarget: controls.target.clone(), toTarget: target });
    mark();
  }
  function stepTween(now) {
    if (!tween.active) return;
    const t = Math.min(1, (now - tween.start) / TWEEN_MS), k = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
    if (t >= 1) tween.active = false;
    mark();
  }
  function finishTween() { // snap to the end pose so tests and picks see the final camera
    if (!tween.active) return;
    stepTween(tween.start + TWEEN_MS + 1);
    controls.update();
  }
  function zoomBy(f) {
    finishTween();
    const d = camera.position.clone().sub(controls.target);
    const len = THREE.MathUtils.clamp(d.length() * f, controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).addScaledVector(d.normalize(), len);
    controls.update(); mark();
  }

  // ---------- Picking ----------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const size = () => ({ w: Math.max(1, container.clientWidth), h: Math.max(1, container.clientHeight) });
  function pickCss(x, y, onlyKey = null) {
    const { w, h } = size();
    ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const cut = layerSet.has("cutaway");
    const hits = raycaster.intersectObjects(meshes.filter((m) => m.visible), false);
    let faint = null;
    for (const hit of hits) {
      const o = hit.object.material.opacity;
      if (o >= 0.5) return hit.object.userData.key; // nearest solid part wins
      if (!cut && !faint) faint = hit.object.userData.key; // a faint membrane only counts when nothing solid is under the pointer
    }
    return faint;
  }
  function canvasOf(key) {
    finishTween();
    const mesh = byKey.get(key) || byBase.get(key)?.[0];
    if (!mesh) return null;
    const { w, h } = size();
    camera.updateMatrixWorld(true); root3.updateMatrixWorld(true);
    const proj = (v) => { const p = v.clone().project(camera); return [(p.x + 1) / 2 * w, (1 - p.y) / 2 * h, p.z]; };
    const c = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    const home = proj(c);
    if (pickCss(home[0], home[1]) === mesh.userData.key) return [home[0], home[1]];
    // The centre may be a hole (torus, bent tube) or hidden: use the sampled surface point nearest the centre that does pick the part.
    const pos = mesh.geometry.attributes.position, v = new THREE.Vector3();
    let best = null, bd = Infinity;
    const stride = Math.max(1, Math.floor(pos.count / 250));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const q = proj(v);
      if (q[0] < 0 || q[1] < 0 || q[0] > w || q[1] > h) continue;
      const d = Math.hypot(q[0] - home[0], q[1] - home[1]);
      if (d < bd && pickCss(q[0], q[1]) === mesh.userData.key) { bd = d; best = q; }
    }
    return best ? [best[0], best[1]] : [home[0], home[1]];
  }
  const nameOf = (key) => {
    if (study?.cell && key === study.cell.key) return study.cell.name || key;
    return byKey.get(key)?.userData.name || byBase.get(key)?.[0]?.userData.name || key;
  };
  function showLabel(text, x, y) {
    if (!text) { label.hidden = true; return; }
    const r = root.getBoundingClientRect();
    label.textContent = text; label.style.left = x - r.left + "px"; label.style.top = y - r.top + "px"; label.hidden = false;
  }
  function onTap(e) {
    if (loading || !study) return;
    const r = container.getBoundingClientRect();
    const key = pickCss(e.clientX - r.left, e.clientY - r.top);
    if (state.pickEnabled) { label.hidden = true; if (key && onPick) onPick(key); }
    else showLabel(key ? nameOf(key) : "", e.clientX, e.clientY);
  }
  let down = null;
  const cv = renderer.domElement;
  cv.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; label.hidden = true; });
  cv.addEventListener("pointerup", (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved <= 6) onTap(e); // a drag is a rotate or pan, not a pick
  });
  cv.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || e.buttons || !study || loading) return;
    if (state.pickEnabled) { label.hidden = true; return; } // hover names would give the answer away
    const r = container.getBoundingClientRect();
    const key = pickCss(e.clientX - r.left, e.clientY - r.top);
    showLabel(key ? nameOf(key) : "", e.clientX, e.clientY);
  });
  cv.addEventListener("pointerleave", () => { label.hidden = true; });

  // ---------- Highlight ----------
  function clearHighlight() {
    for (const m of highlighted) m.material.emissive.copy(m.userData.baseEmissive);
    highlighted = []; mark();
  }
  function highlight(key, kind) {
    const tint = kind === "good" ? HIGHLIGHT_GOOD : HIGHLIGHT_BAD;
    const list = byKey.has(key) ? [byKey.get(key)] : byBase.get(key) || []; // a base key tints every stamped copy
    for (const m of list) {
      m.material.emissive.copy(tint).multiplyScalar(0.7);
      highlighted.push(m);
      const l = m.userData.layer;
      if (!m.visible && !layerSet.has(l)) { layerSet.add(l); applyLayers(); }
    }
    mark();
  }

  // ---------- Studies ----------
  function fetchStudy(id) {
    let p = cache.get(id);
    if (!p) {
      p = fetch(studyUrlFor(id)).then((r) => { if (!r.ok) throw new Error(`${id}: HTTP ${r.status}`); return r.json(); });
      p.catch(() => cache.delete(id));
      cache.set(id, p);
    }
    return p;
  }
  async function loadStudy(id) {
    loading++; loadingEl.hidden = false;
    try { return await fetchStudy(id); } finally { loading--; if (!loading) loadingEl.hidden = true; }
  }
  async function switchTo(id) {
    const s = await loadStudy(id);
    study = s; studyId = id;
    buildStudy(s);
    badge.textContent = `Cell · ${s.title || id}`;
    badge.title = s.scale || "";
    return s;
  }

  function resize() {
    const { w, h } = size();
    if (!container.clientWidth || !container.clientHeight) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    controls.handleResize(); mark();
  }
  function render() {
    finishTween();
    controls.update();
    renderer.render(scene, camera);
    dirty = false;
  }
  function tick(now) {
    raf = 0;
    if (!active) return;
    stepTween(now);
    controls.update(); // also fires "change" when damping still moves the camera
    if (dirty) { renderer.render(scene, camera); dirty = false; }
    raf = requestAnimationFrame(tick);
  }
  function startLoop() { if (!raf && active) raf = requestAnimationFrame(tick); }

  new ResizeObserver(resize).observe(container);
  window.addEventListener("resize", resize);

  async function show({ study: id, view, layers } = {}) {
    const changed = !!id && id !== studyId;
    if (changed) await switchTo(id);
    if (!study) return;
    const views = study.views || {};
    const v = views[view] ? view : study.defaultView;
    setLayers(Array.isArray(layers) ? layers : views[v]?.layers || study.defaultLayers || ["membrane", "organelles"]);
    clearHighlight();
    resize();
    applyView(v, !changed);
    startLoop();
    render();
    await Promise.race([nextFrame(), sleep(120)]);
  }

  resize();
  startLoop();
  if (initialStudy) await show({ study: initialStudy });

  const debug = {
    root, scene, camera, controls, state, render, canvasOf,
    pickAt(x, y) { finishTween(); camera.updateMatrixWorld(true); return pickCss(x, y); },
    onTap,
    get loading() { return loading > 0; },
    get meshes() { return meshes; },
  };

  return {
    show,
    highlight,
    clearHighlight,
    name: nameOf,
    setDefaultLayers() { setDefaultLayers(); },
    setPickEnabled(on) { state.pickEnabled = !!on; if (on) label.hidden = true; },
    setActive(on) {
      active = !!on;
      if (active) { resize(); mark(); startLoop(); }
      else { cancelAnimationFrame(raf); raf = 0; label.hidden = true; down = null; }
    },
    loadStudy,
    get studyId() { return studyId; },
    get meta() { return study; },
    debug,
  };
}
