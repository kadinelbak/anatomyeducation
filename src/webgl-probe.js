// Checks that this browser can give us a WebGL2 context before Three.js asks
// for one, and if not, says why in words the browser itself supplies.
// Three r163+ is WebGL2 only, so a browser with WebGL1 but no WebGL2 fails too.

export class WebGLUnavailableError extends Error {
  constructor({ kind, reason }) {
    super(kind === "webgl1-only" ? "This browser has WebGL 1 but not WebGL 2." : "WebGL is turned off or unavailable in this browser.");
    this.name = "WebGLUnavailableError";
    this.kind = kind; // "webgl1-only" | "none"
    this.reason = reason; // the browser's own status message, often empty
  }
}

// Returns { canvas, context, attributesHonoured } or throws WebGLUnavailableError.
// Pass canvas and context into THREE.WebGLRenderer so no extra context is made.
export function probeWebGL(attributes = { antialias: true, stencil: true }) {
  const canvas = document.createElement("canvas");
  let reason = "";
  canvas.addEventListener("webglcontextcreationerror", (e) => { reason = e.statusMessage || reason; });
  let context = canvas.getContext("webgl2", attributes);
  let attributesHonoured = true;
  if (!context) {
    context = canvas.getContext("webgl2"); // e.g. antialias refused on a weak GPU
    attributesHonoured = false;
  }
  if (context) return { canvas, context, attributesHonoured };
  const gl1 = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
  throw new WebGLUnavailableError({ kind: gl1 ? "webgl1-only" : "none", reason: reason.trim() });
}

// What to tell a person whose browser failed the probe. Plain text lines.
export function webglHelp(err) {
  const lines = [];
  if (err.kind === "webgl1-only") {
    lines.push("Your browser supports WebGL 1 only; this page needs WebGL 2 (Chrome, Edge, Firefox, or Safari 15 and newer).");
  } else {
    lines.push("Your browser could not start WebGL, which this page needs to draw the model.");
    lines.push("Usually this means graphics acceleration is turned off in the browser settings, or the browser disabled WebGL after a graphics crash.");
    lines.push("Try: turn on \"Use graphics acceleration\" (Chrome: Settings, System) and relaunch; or open this page in another browser.");
  }
  if (err.reason) lines.push(`Browser says: ${err.reason}`);
  return lines;
}
