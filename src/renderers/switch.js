// Renderer switch: one object with the renderer interface the engine uses, delegating to a
// mesh renderer (one per 3D model) or to the volume renderer (one, which swaps scan studies on
// demand). Renderers are built lazily, once. `models` is CONFIG.models: { id: { modelUrl, structuresUrl } }.
import { createMeshRenderer } from "./mesh.js";
import { createVolumeRenderer } from "./volume.js";

export function createRendererSwitch({ viewer, onPick, models, onChange }) {
  const defaultModel = Object.keys(models)[0];
  const meshBox = document.createElement("div");
  const volBox = document.createElement("div");
  meshBox.className = "viewer-mesh";
  volBox.className = "viewer-volume";
  volBox.hidden = true;
  viewer.append(meshBox, volBox);

  const meshes = new Map(); // model id -> renderer
  let volume = null; // the one volume renderer; it caches studies itself
  const building = new Map(); // "mesh:<model>" | "volume" -> promise
  let current = null;
  let active = null; // "mesh" | "volume"
  let activeStudy = null;
  let activeModel = null;
  let lastModel = defaultModel; // the model to come back to after a scan

  function show(kind, id) {
    const next = kind === "mesh" ? meshes.get(id) : volume;
    if (current && current !== next) {
      current.setPickEnabled(false);
      current.clearHighlight();
      current.setActive?.(false);
    }
    current = next;
    active = kind;
    activeStudy = kind === "volume" ? id : null;
    activeModel = kind === "mesh" ? id : null;
    if (kind === "mesh") lastModel = id;
    meshBox.hidden = kind !== "mesh";
    volBox.hidden = kind !== "volume";
    if (volume) volume.debug.root.hidden = kind !== "volume";
    document.body.classList.toggle("mode-volume", kind === "volume");
    if (kind === "mesh") next.setActive(true);
    onChange?.(kind, id, kind === "volume" ? next?.debug.volume.meta : next?.meta);
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
          volume = await build("volume", () => createVolumeRenderer({ container: volBox, studiesBase: "assets/volumes/", initialStudy: id, onPick }));
        } else if (id && id !== volume.studyId) {
          await volume.loadStudy(id); // fetch while the page says "Loading the scan…"
          await volume.show({ study: id }); // and swap now, so the attribution and badge are right behind the chooser
        }
        show("volume", id || volume.studyId);
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
    get study() { return active === "volume" ? volume?.studyId ?? activeStudy : null; }, // follows per-question swaps
    get model() { return activeModel; },
    get mesh() { return active === "mesh" ? current : meshes.get(lastModel) || null; },
    get volume() { return current && active === "volume" ? current : null; },
  };
  return sw;
}
