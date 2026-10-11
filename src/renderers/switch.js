// Renderer switch: one object with the renderer interface the engine uses, delegating to the
// mesh renderer or to a volume renderer (one per CT study). Renderers are built lazily, once.
import { createMeshRenderer } from "./mesh.js";
import { createVolumeRenderer } from "./volume.js";

export function createRendererSwitch({ viewer, onPick, modelUrl, structuresUrl, onChange }) {
  const meshBox = document.createElement("div");
  const volBox = document.createElement("div");
  meshBox.className = "viewer-mesh";
  volBox.className = "viewer-volume";
  volBox.hidden = true;
  viewer.append(meshBox, volBox);

  let mesh = null;
  const volumes = new Map(); // study id -> renderer
  const building = new Map(); // study id -> promise
  let current = null;
  let active = null; // "mesh" | "volume"
  let activeStudy = null;

  function show(kind, study) {
    const next = kind === "mesh" ? mesh : volumes.get(study);
    if (current && current !== next) {
      current.setPickEnabled(false);
      current.clearHighlight();
    }
    current = next;
    active = kind;
    activeStudy = kind === "volume" ? study : null;
    meshBox.hidden = kind !== "mesh";
    volBox.hidden = kind !== "volume";
    for (const [id, r] of volumes) r.debug.root.hidden = !(kind === "volume" && id === study);
    document.body.classList.toggle("mode-volume", kind === "volume");
    onChange?.(kind, study);
  }

  const sw = {
    // Builds the renderer on first use (mesh once, volume once per study), then shows it.
    async activate(kind, studyId) {
      if (kind === "mesh") {
        mesh ||= await createMeshRenderer({ container: meshBox, modelUrl, structuresUrl, onPick });
        show("mesh");
      } else if (kind === "volume") {
        if (!volumes.has(studyId)) {
          // The container must be visible and sized before the volume renderer is built.
          meshBox.hidden = true;
          volBox.hidden = false;
          let p = building.get(studyId);
          if (!p) {
            p = createVolumeRenderer({ container: volBox, studyUrl: `assets/volumes/${studyId}/study.json`, onPick });
            building.set(studyId, p);
          }
          try {
            const r = await p;
            volumes.set(studyId, r);
          } finally {
            building.delete(studyId);
          }
        }
        show("volume", studyId);
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
    get mesh() { return mesh; },
    get volume() { return current && active === "volume" ? current : null; },
  };
  return sw;
}
