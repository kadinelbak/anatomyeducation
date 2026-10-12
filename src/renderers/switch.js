// Renderer switch: one object with the renderer interface the engine uses, delegating to a
// mesh renderer (one per 3D model) or to the volume, X-ray or ultrasound renderer (one each, which swap scan studies on
// demand). Renderers are built lazily, once. `models` is CONFIG.models: { id: { modelUrl, structuresUrl } }.
import { createMeshRenderer } from "./mesh.js";
// The volume renderer pulls in the 3 MB Cornerstone bundle, so it is imported
// only when a scan set is first chosen; limb sets never pay for it.
const loadVolumeRenderer = () => import("./volume.js").then((m) => m.createVolumeRenderer);
// The X-ray (DRR) and ultrasound renderers are computed in the browser from the same CT studies.
const loadXrayRenderer = () => import("./xray.js").then((m) => m.createXrayRenderer);
const loadUltrasoundRenderer = () => import("./ultrasound.js").then((m) => m.createUltrasoundRenderer);

export function createRendererSwitch({ viewer, onPick, models, onChange }) {
  const defaultModel = Object.keys(models)[0];
  const meshBox = document.createElement("div");
  const volBox = document.createElement("div");
  meshBox.className = "viewer-mesh";
  volBox.className = "viewer-volume";
  volBox.hidden = true;
  const xrayBox = document.createElement("div");
  const usBox = document.createElement("div");
  xrayBox.className = "viewer-xray";
  usBox.className = "viewer-ultrasound";
  xrayBox.hidden = usBox.hidden = true;
  viewer.append(meshBox, volBox, xrayBox, usBox);

  const meshes = new Map(); // model id -> renderer
  let volume = null; // the one volume renderer; it caches studies itself
  let xray = null; // likewise the one X-ray renderer
  let ultrasound = null; // and the one ultrasound renderer
  const building = new Map(); // "mesh:<model>" | "volume" -> promise
  let current = null;
  let active = null; // "mesh" | "volume" | "xray" | "ultrasound"
  let activeStudy = null;
  let activeModel = null;
  let lastModel = defaultModel; // the model to come back to after a scan

  const scanRenderers = () => ({ volume, xray, ultrasound });
  const scanKinds = ["volume", "xray", "ultrasound"];
  const boxes = { mesh: meshBox, volume: volBox, xray: xrayBox, ultrasound: usBox };

  function show(kind, id) {
    const next = kind === "mesh" ? meshes.get(id) : scanRenderers()[kind];
    if (current && current !== next) {
      current.setPickEnabled(false);
      current.clearHighlight();
      current.setActive?.(false);
    }
    current = next;
    active = kind;
    activeStudy = scanKinds.includes(kind) ? id : null;
    activeModel = kind === "mesh" ? id : null;
    if (kind === "mesh") lastModel = id;
    for (const [k, box] of Object.entries(boxes)) box.hidden = k !== kind;
    if (volume) volume.debug.root.hidden = kind !== "volume";
    for (const k of ["mesh", ...scanKinds]) document.body.classList.toggle(`mode-${k}`, k === kind);
    if (kind === "mesh") next.setActive(true);
    else if (kind !== "volume") next.setActive?.(true);
    onChange?.(kind, id, next?.meta ?? next?.debug?.volume?.meta);
  }

  // Build once per key, sharing an in-flight build.
  async function build(key, make) {
    let p = building.get(key);
    if (!p) { p = make(); building.set(key, p); }
    try { return await p; } finally { building.delete(key); }
  }

  const sw = {
    // Builds the renderer on first use (mesh once, volume once per study), then shows it.
    async activate(kind, id) {
      if (kind === "mesh") {
        const modelId = id && models[id] ? id : lastModel;
        if (!meshes.has(modelId)) {
          const { modelUrl, structuresUrl } = models[modelId];
          meshes.set(modelId, await build(`mesh:${modelId}`, () => createMeshRenderer({ container: meshBox, modelUrl, structuresUrl, onPick })));
        }
        show("mesh", modelId);
      } else if (kind === "volume") {
        if (!volume) {
          // The container must be visible and sized before the volume renderer is built.
          meshBox.hidden = true;
          volBox.hidden = false;
          volume = await build("volume", async () => (await loadVolumeRenderer())({ container: volBox, studiesBase: "assets/volumes/", initialStudy: id, onPick }));
        } else if (id && id !== volume.studyId) {
          await volume.loadStudy(id); // fetch while the page says "Loading the scan…"
          await volume.show({ study: id }); // and swap now, so the attribution and badge are right behind the chooser
        }
        show("volume", id || volume.studyId);
      } else if (kind === "xray" || kind === "ultrasound") {
        const isXray = kind === "xray";
        const box = isXray ? xrayBox : usBox;
        let r = isXray ? xray : ultrasound;
        if (!r) {
          // Same as the volume renderer: the container must be visible and sized before the build.
          meshBox.hidden = volBox.hidden = true;
          xrayBox.hidden = usBox.hidden = true;
          box.hidden = false;
          r = await build(kind, async () => (await (isXray ? loadXrayRenderer : loadUltrasoundRenderer)())({ container: box, studiesBase: "assets/volumes/", initialStudy: id, onPick }));
          if (isXray) xray = r; else ultrasound = r;
        } else if (id && id !== r.studyId) {
          await r.loadStudy(id);
          await r.show({ study: id });
        }
        show(kind, id || r.studyId);
      } else throw new Error(`unknown renderer ${kind}`);
      return sw;
    },
    show: (...a) => current.show(...a),
    highlight: (...a) => current.highlight(...a),
    clearHighlight: () => current?.clearHighlight(),
    name: (k) => current.name(k),
    setDefaultLayers: () => current?.setDefaultLayers(),
    setPickEnabled: (on) => current?.setPickEnabled(on),
    get debug() { return current?.debug; },
    get active() { return active; },
    get study() { return scanKinds.includes(active) ? scanRenderers()[active]?.studyId ?? activeStudy : null; }, // follows per-question swaps
    get model() { return activeModel; },
    get mesh() { return active === "mesh" ? current : meshes.get(lastModel) || null; },
    get volume() { return current && active === "volume" ? current : null; },
    get xray() { return current && active === "xray" ? current : null; },
    get ultrasound() { return current && active === "ultrasound" ? current : null; },
  };
  return sw;
}
