// The home screen's figure: assets/model/hero.glb (metres, Y up, faces +Z, feet at y=0, nodes bone / muscle / organ)
// turning slowly on a dark backdrop. Drag turns it by hand. No picking, hover or details.
// While the file loads, the traced body-map figure stands in its place; if WebGL is missing it stays.
// start() makes the canvas and the render loop, stop() removes both (the loaded model is kept for the next start()).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { probeWebGL } from "./webgl-probe.js";
import { buildFigure, upgradeFigure } from "./bodymap.js";

const SECONDS_PER_TURN = 20;
const RESUME_MS = 3000; // auto-rotation comes back this long after the pointer is released
const DRAG_RADIANS_PER_PX = 0.01;

export function createHero({ container, url = "assets/model/hero.glb" }) {
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const placeholder = buildFigure([]);
  placeholder.classList.add("hero-placeholder");
  upgradeFigure(placeholder, []);
  container.replaceChildren(placeholder);

  let running = false, failed = false;
  let model = null; // { pivot, radius, height, centre } once loaded
  let loading = null;
  let gl = null; // { renderer, scene, camera, ro }
  let raf = 0, last = 0, angle = 0, dirty = true;
  let dragging = false, dragX = 0, resumeAt = 0;

  function load() {
    loading ||= new GLTFLoader().loadAsync(url).then((gltf) => {
      const root = gltf.scene;
      const box = new THREE.Box3().setFromObject(root);
      const centre = box.getCenter(new THREE.Vector3());
      root.position.set(-centre.x, 0, -centre.z); // turn about the vertical axis through the middle of the body
      const pivot = new THREE.Group();
      pivot.add(root);
      const size = box.getSize(new THREE.Vector3());
      model = { pivot, height: size.y, top: box.max.y, bottom: box.min.y, radius: Math.hypot(size.x, size.z) / 2 };
    }).catch((err) => { failed = true; console.warn("Home figure not loaded", err); });
    return loading;
  }

  function lights(scene) {
    scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x1a222c, 0.9)); // soft fill
    const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(1.5, 2.2, 3);
    const rim = new THREE.DirectionalLight(0x7fc4ff, 1.1); rim.position.set(-2.5, 1.6, -2.5);
    const fill = new THREE.DirectionalLight(0xffe8d6, 0.5); fill.position.set(-2, 0.4, 2.5);
    scene.add(key, rim, fill);
  }

  function frame() {
    if (!gl || !model) return;
    const { renderer, camera } = gl;
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const fitH = (model.height * 1.1) / 2 / t;
    const fitW = (model.radius * 2 * 1.08) / 2 / (t * camera.aspect);
    const dist = Math.max(fitH, fitW) + model.radius;
    const mid = (model.top + model.bottom) / 2;
    camera.position.set(0, mid, dist);
    camera.lookAt(0, mid, 0);
    camera.updateProjectionMatrix();
    dirty = true;
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000 || 0);
    last = now;
    if (!dragging && !reduced?.matches && now >= resumeAt) { angle += (dt * Math.PI * 2) / SECONDS_PER_TURN; dirty = true; }
    if (!dirty || !gl) return;
    dirty = false;
    model.pivot.rotation.y = angle;
    gl.renderer.render(gl.scene, gl.camera);
  }

  function attach() {
    let probe;
    try { probe = probeWebGL({ antialias: true, alpha: true }); } catch (err) { failed = true; console.warn("Home figure needs WebGL", err); return; }
    const renderer = new THREE.WebGLRenderer({ canvas: probe.canvas, context: probe.context, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    lights(scene);
    scene.add(model.pivot);
    const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
    const canvas = renderer.domElement;
    canvas.className = "hero-canvas";
    canvas.setAttribute("aria-hidden", "true");
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    container.append(canvas);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(frame) : null;
    ro?.observe(container);
    gl = { renderer, scene, camera, ro };
    frame();
    container.classList.add("hero-ready"); // the 3D figure takes the placeholder's place
  }

  function detach() {
    if (!gl) return;
    cancelAnimationFrame(raf);
    gl.ro?.disconnect();
    gl.scene.remove(model.pivot);
    gl.renderer.domElement.remove();
    gl.renderer.dispose();
    gl.renderer.forceContextLoss();
    gl = null;
    dragging = false;
    container.classList.remove("hero-ready");
  }

  function onDown(e) { dragging = true; dragX = e.clientX; e.target.setPointerCapture?.(e.pointerId); }
  function onMove(e) {
    if (!dragging) return;
    angle += (e.clientX - dragX) * DRAG_RADIANS_PER_PX;
    dragX = e.clientX;
    dirty = true;
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    resumeAt = performance.now() + RESUME_MS;
  }

  return {
    async start() {
      running = true;
      if (gl || failed) return;
      await load();
      if (!running || gl || failed || !model) return;
      try { attach(); } catch (err) { failed = true; console.warn("Home figure failed", err); }
      if (!gl) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      detach();
    },
    dispose() {
      running = false;
      detach();
      model = null; loading = null;
      container.replaceChildren();
    },
    get ready() { return !!gl; },
  };
}
