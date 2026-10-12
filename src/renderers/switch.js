// Renderer switch: one object with the renderer interface the engine uses, delegating to a
// mesh renderer (one per 3D model) or to a volume renderer (one per scan study). Renderers are
// built lazily, once. `models` is CONFIG.models: { id: { modelUrl, structuresUrl } }.
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
  const volumes = new Map(); // study id -> renderer
  const building = new Map(); // "mesh:<model>" | "volume:<study>" -> promise
  let current = null;
  let active = null; // "mesh" | "volume"
  let activeStudy = null;
  let activeModel = null;
  let lastModel = defaultModel; // the model to come back to after a scan

  function show(kind, id) {
    const next = kind === "mesh" ? meshes.get(id) : volumes.get(id);
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
    for (const [sid, r] of volumes) r.debug.root.hidden = !(kind === "volume" && sid === id);
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
        if (!volumes.has(id)) {
          // The container must be visible and sized before the volume renderer is built.
          meshBox.hidden = true;
          volBox.hidden = false;
          volumes.set(id, await build(`volume:${id}`, () => createVolumeRenderer({ container: volBox, studyUrl: `assets/volumes/${id}/study.json`, onPick })));
        }
        show("volume", id);
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
    get study() { return activeStudy; },
    get model() { return activeModel; },
    get mesh() { return active === "mesh" ? current : meshes.get(lastModel) || null; },
    get volume() { return current && active === "volume" ? current : null; },
  };
  return sw;
}
