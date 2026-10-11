// Three.js mesh renderer: scene, layers, slice, views, picking, highlight.
// The quiz engine only talks to the object returned by createMeshRenderer.
import * as THREE from "three";
import { TrackballControls } from "three/addons/controls/TrackballControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const $ = (id) => document.getElementById(id);

const LAYERS = ["skin", "muscle", "tendon", "nerve", "vessel", "bone"];
const LAYER_COLORS = {
  skin: 0xe2b08f,
  muscle: 0xb0473f,
  tendon: 0xe9e3d3,
  nerve: 0xffe066,
  vessel: 0xe0403f,
  bone: 0xeadfc8,
};
const DEFAULT_LAYERS = { skin: true, muscle: true, tendon: true, nerve: false, vessel: false, bone: true };
const HIGHLIGHT_GOOD = new THREE.Color(0x2ee68a);
const HIGHLIGHT_BAD = new THREE.Color(0xff3b3b);

export async function createMeshRenderer({ container, modelUrl, structuresUrl, onPick }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1419);
  const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.005, 10);
  // Trackball: free rotation in every direction (no pole lock). Left-drag
  // rotates, right-drag or two fingers pan, wheel or pinch zooms.
  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 2.5;
  controls.zoomSpeed = 1.0;
  controls.panSpeed = 0.5;
  controls.dynamicDampingFactor = 0.15;
  controls.minDistance = 0.06;
  controls.maxDistance = 1.5;
  renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

  scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  camera.add(key);
  key.position.set(0.3, 0.5, 0.2);
  scene.add(camera);

  const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 10);
  let sliceActive = false;
  const model = new THREE.Group();
  scene.add(model);

  let meta = null;
  const meshesByStructure = new Map(); // structure -> [mesh]
  const meshesByLayer = new Map(); // layer -> [mesh]
  const layerOn = { ...DEFAULT_LAYERS };
  let axis = null; // { origin, dir, min, max } for the cross-section
  const marrowMeshes = [];
  const stencilByLayer = new Map(); // layer -> [stencil meshes]
  const caps = []; // { layer, mesh, offset }
  const CAP_COLORS = { skin: 0xe8c99a, muscle: 0xb5433b, tendon: 0xe3dccb, nerve: 0xe6c94a, vessel: 0xb01f24, bone: 0xd8ccb0, marrow: 0xb4553f };
  const CAP_ORDER = ["skin", "muscle", "tendon", "nerve", "vessel", "bone", "marrow"];

  // Back faces of cut meshes render as a flat darker cap so the slice reads as solid.
  function capShader(material) {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <dithering_fragment>",
        "#include <dithering_fragment>\n if (!gl_FrontFacing) { gl_FragColor.rgb = diffuseColor.rgb * 0.62; }"
      );
    };
  }

  function hashJitter(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
    return ((h >>> 0) % 1000) / 1000 - 0.5;
  }

  function makeMaterial(layer, structure) {
    const color = new THREE.Color(LAYER_COLORS[layer]);
    if (layer === "muscle") color.offsetHSL(hashJitter(structure) * 0.04, 0, hashJitter(structure + "l") * 0.12);
    if (layer === "skin") {
      return new THREE.MeshStandardMaterial({
        color, roughness: 0.7, transparent: true, opacity: 0.3, depthWrite: false,
        clippingPlanes: [clipPlane],
      });
    }
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: layer === "bone" ? 0.75 : layer === "tendon" ? 0.4 : 0.55,
      metalness: 0,
      side: THREE.DoubleSide,
      clippingPlanes: [clipPlane],
      emissive: layer === "nerve" ? 0x6b5600 : layer === "vessel" ? 0x3a0000 : 0x000000,
    });
    capShader(m);
    return m;
  }

  // Hosts that only serve text files get the GLB as base64 in a .txt file.
  async function loadGltf(url) {
    const loader = new GLTFLoader();
    if (!url.endsWith(".txt")) return loader.loadAsync(url);
    const b64 = await fetch(url).then((r) => r.text());
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return loader.parseAsync(bin.buffer, "");
  }

  // Solid cut faces: for each layer, back faces of the clipped meshes bump a
  // stencil count and front faces drop it, so pixels where the cut opens into a
  // mesh end up non-zero; a plane on the cut is then drawn only there.
  function stencilMaterial(side, op) {
    return new THREE.MeshBasicMaterial({
      side, clippingPlanes: [clipPlane], depthWrite: false, depthTest: true, colorWrite: false,
      stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
    });
  }

  function addStencilPair(mesh, layer) {
    const order = CAP_ORDER.indexOf(layer) * 2 + 20;
    const back = new THREE.Mesh(mesh.geometry, stencilMaterial(THREE.BackSide, THREE.IncrementWrapStencilOp));
    const front = new THREE.Mesh(mesh.geometry, stencilMaterial(THREE.FrontSide, THREE.DecrementWrapStencilOp));
    for (const m of [back, front]) {
      m.renderOrder = order;
      m.visible = false;
      m.raycast = () => {};
      mesh.add(m);
    }
    if (!stencilByLayer.has(layer)) stencilByLayer.set(layer, []);
    stencilByLayer.get(layer).push(back, front);
  }

  function addCap(layer) {
    const i = CAP_ORDER.indexOf(layer);
    const mat = new THREE.MeshStandardMaterial({
      color: CAP_COLORS[layer], roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.renderOrder = i * 2 + 21;
    mesh.visible = false;
    mesh.raycast = () => {}; // never pickable
    scene.add(mesh);
    caps.push({ layer, mesh, offset: i * 0.00012 });
  }

  function updateCaps() {
    for (const { layer, mesh, offset } of caps) {
      const on = sliceActive && (layer === "marrow" ? layerOn.bone : layerOn[layer]);
      mesh.visible = on;
      if (!on) continue;
      // Sit on the cut, nudged toward the viewer side so later layers draw over earlier ones.
      clipPlane.coplanarPoint(mesh.position);
      mesh.position.addScaledVector(clipPlane.normal, -offset);
      mesh.lookAt(mesh.position.clone().add(clipPlane.normal));
    }
    for (const [layer, list] of stencilByLayer) {
      const on = sliceActive && (layer === "marrow" ? layerOn.bone : layerOn[layer]);
      for (const m of list) m.visible = on;
    }
  }

  async function loadModel() {
    const [gltf, structures] = await Promise.all([
      loadGltf(modelUrl),
      fetch(structuresUrl).then((r) => r.json()),
    ]);
    meta = structures;
    const nodeInfo = new Map(meta.nodes.map((n) => [n.node, n]));
    gltf.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const info = nodeInfo.get(obj.name) || nodeInfo.get(obj.parent?.name);
      if (!info) return;
      obj.userData = { ...info };
      if (!obj.geometry.attributes.normal) obj.geometry.computeVertexNormals();
      obj.geometry.deleteAttribute("color");
      addStencilPair(obj, info.layer);
      if (info.layer === "marrow") {
        obj.material = new THREE.MeshBasicMaterial({ visible: false }); // only its cut face is ever seen
        marrowMeshes.push(obj);
        return;
      }
      obj.material = makeMaterial(info.layer, info.structure);
      obj.userData.baseColor = obj.material.color.clone();
      obj.userData.baseEmissive = obj.material.emissive.clone();
      if (info.layer === "skin") obj.renderOrder = 10;
      if (!meshesByStructure.has(info.structure)) meshesByStructure.set(info.structure, []);
      meshesByStructure.get(info.structure).push(obj);
      if (!meshesByLayer.has(info.layer)) meshesByLayer.set(info.layer, []);
      meshesByLayer.get(info.layer).push(obj);
    });
    for (const layer of CAP_ORDER) addCap(layer);
    model.add(gltf.scene);

    // Cross-section axis: elbow -> wrist, extended to cover the whole model.
    const elbow = new THREE.Vector3(...meta.axis.elbow);
    const wrist = new THREE.Vector3(...meta.axis.wrist);
    const dir = wrist.clone().sub(elbow).normalize();
    let min = Infinity, max = -Infinity;
    const v = new THREE.Vector3();
    gltf.scene.updateMatrixWorld(true);
    for (const [layer, meshes] of meshesByLayer) {
      if (layer === "skin") continue;
      for (const mesh of meshes) {
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i += 7) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          const d = v.dot(dir);
          if (d < min) min = d;
          if (d > max) max = d;
        }
      }
    }
    axis = { dir, min, max };
    applySlice();
    applyLayers();
    setView("palmar", false);
  }

  // ---------- Layers, slice, views ----------

  function applyLayers() {
    for (const layer of LAYERS) {
      for (const mesh of meshesByLayer.get(layer) || []) mesh.visible = layerOn[layer];
      const box = document.querySelector(`input[data-layer="${layer}"]`);
      if (box) box.checked = layerOn[layer];
    }
    updateCaps();
  }

  function setLayers(spec) {
    for (const layer of LAYERS) layerOn[layer] = !!spec[layer];
    applyLayers();
  }

  document.querySelectorAll("input[data-layer]").forEach((box) => {
    box.addEventListener("change", () => {
      layerOn[box.dataset.layer] = box.checked;
      applyLayers();
    });
  });

  const slider = $("slice");
  function applySlice() {
    if (!axis) return;
    const t = Number(slider.value) / 1000;
    sliceActive = t > 0;
    if (!sliceActive) {
      clipPlane.set(axis.dir, 10); // keeps everything
    } else {
      const d = axis.min + t * (axis.max - axis.min);
      clipPlane.set(axis.dir, -d); // keep points distal to the cut
    }
    updateCaps();
  }
  slider.addEventListener("input", applySlice);

  const VIEWS = {
    palmar: new THREE.Vector3(0, 0, 1),
    dorsal: new THREE.Vector3(0, 0, -1),
    lateral: new THREE.Vector3(-1, 0, 0.25),
  };
  const viewTween = { active: false };
  function setView(name, animate = true) {
    const box = new THREE.Box3();
    for (const layer of ["bone"]) for (const m of meshesByLayer.get(layer) || []) box.expandByObject(m);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const aspect = window.innerWidth / window.innerHeight;
    const dist = (size * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, aspect * 1.4);
    const target = center.clone();
    // On phones the question card covers the lower half, so aim below the
    // model's centre to push it into the top half of the screen.
    if (aspect < 0.8) target.y -= size * 0.3;
    const pos = center.clone().add(VIEWS[name].clone().normalize().multiplyScalar(dist));
    if (!animate) {
      controls.target.copy(target);
      camera.position.copy(pos);
      camera.up.set(0, 1, 0);
      controls.update();
      return;
    }
    camera.up.set(0, 1, 0);
    Object.assign(viewTween, {
      active: true, start: performance.now(),
      fromPos: camera.position.clone(), toPos: pos,
      fromTarget: controls.target.clone(), toTarget: target,
    });
  }
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

  // Shift + left-drag pans (right-drag and two-finger drag pan as well).
  function setShiftPan(on) {
    controls.mouseButtons.LEFT = on ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  }
  window.addEventListener("keydown", (e) => { if (e.key === "Shift") setShiftPan(true); });
  window.addEventListener("keyup", (e) => { if (e.key === "Shift") setShiftPan(false); });
  window.addEventListener("blur", () => setShiftPan(false));

  $("controls-toggle").addEventListener("click", () => {
    const open = $("controls").classList.toggle("open");
    $("controls-toggle").setAttribute("aria-expanded", open);
  });

  // ---------- Picking ----------

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const THIN_LAYERS = new Set(["nerve", "vessel"]);
  const GRAB_PX = 6; // nerves and vessels are a few pixels wide, so give them a grab margin

  function pickAt(clientX, clientY, targets) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObjects(targets, false)) {
      if (clipPlane.distanceToPoint(hit.point) < 0) continue; // sliced away
      return hit.object.userData;
    }
    return null;
  }

  function pick(clientX, clientY) {
    const targets = [];
    for (const [layer, meshes] of meshesByLayer) if (layer !== "skin" && layerOn[layer]) targets.push(...meshes);
    const direct = pickAt(clientX, clientY, targets);
    if (direct && THIN_LAYERS.has(direct.layer)) return direct.structure;
    const thin = targets.filter((m) => THIN_LAYERS.has(m.userData.layer));
    if (thin.length) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const near = pickAt(clientX + Math.cos(a) * GRAB_PX, clientY + Math.sin(a) * GRAB_PX, thin);
        if (near) {
          // Only grab it if nothing in front hides it at that spot.
          const front = pickAt(clientX + Math.cos(a) * GRAB_PX, clientY + Math.sin(a) * GRAB_PX, targets);
          if (front && front.structure === near.structure) return near.structure;
        }
      }
    }
    return direct ? direct.structure : null;
  }

  function structureName(s) {
    return meta?.structures[s] || s;
  }
  function labelName(s) {
    return structureName(s) + (meta?.schematic.includes(s) ? " (schematic)" : "");
  }
  let pickEnabled = false;

  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 6) return; // that was a drag
    const s = pick(e.clientX, e.clientY);
    if (pickEnabled) {
      if (s) onPick(s);
    } else {
      showLabel(s, e.clientX, e.clientY);
    }
  });

  // Hover labels only outside of an open question, so they never give answers away.
  const label = $("hover-label");
  function showLabel(s, x, y) {
    if (!s) { label.hidden = true; return; }
    label.textContent = labelName(s);
    label.style.left = x + "px";
    label.style.top = y + "px";
    label.hidden = false;
  }
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || e.buttons) return;
    if (pickEnabled || !meta) { label.hidden = true; return; }
    showLabel(pick(e.clientX, e.clientY), e.clientX, e.clientY);
  });

  // ---------- Highlighting ----------

  let highlighted = [];
  function clearHighlight() {
    for (const m of highlighted) {
      m.material.color.copy(m.userData.baseColor);
      m.material.emissive.copy(m.userData.baseEmissive);
    }
    highlighted = [];
  }
  function highlight(structure, color) {
    for (const m of meshesByStructure.get(structure) || []) {
      m.material.color.copy(color);
      m.material.emissive.copy(color).multiplyScalar(0.35);
      highlighted.push(m);
      if (!layerOn[m.userData.layer]) {
        layerOn[m.userData.layer] = true;
        applyLayers();
      }
    }
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    controls.handleResize();
  });

  function tick() {
    if (viewTween.active) {
      const t = Math.min(1, (performance.now() - viewTween.start) / 600);
      const k = 1 - Math.pow(1 - t, 3);
      camera.position.lerpVectors(viewTween.fromPos, viewTween.toPos, k);
      controls.target.lerpVectors(viewTween.fromTarget, viewTween.toTarget, k);
      if (t >= 1) viewTween.active = false;
    }
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  await loadModel();
  tick();

  return {
    show({ view, layers }) {
      slider.value = 0;
      applySlice();
      setLayers(Object.fromEntries(layers.map((l) => [l, true])));
      setView(view);
      label.hidden = true;
    },
    highlight(id, kind) { highlight(id, kind === "good" ? HIGHLIGHT_GOOD : HIGHLIGHT_BAD); },
    clearHighlight,
    name: labelName,
    setDefaultLayers() { setLayers(DEFAULT_LAYERS); },
    setPickEnabled(on) {
      pickEnabled = !!on;
      if (pickEnabled) label.hidden = true;
    },
    debug: { viewTween, controls, camera, meshesByStructure, pick, setView, setLayers },
  };
}
