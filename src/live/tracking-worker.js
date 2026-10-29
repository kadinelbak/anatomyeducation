// Live mode tracking worker: runs the MediaPipe model inference of tracking.js off the main thread, so the
// camera video and the scan renderer keep their frame rate. Module worker:
//   new Worker(new URL("./tracking-worker.js", import.meta.url), { type: "module" })
//
// Protocol (all post-processing, filters, cadence and statuses stay in tracking.js, so frames are identical):
//   in  { type: "init", numHands }                        -> { type: "ready", backend, face } | { type: "init-error", message }
//   in  { type: "cpu" }                                   -> same replies as init (GPU failed on the first frames)
//   in  { type: "numHands", n }
//   in  { type: "frame", ts, bitmap, runPose, runFace, wantMask }   (bitmap: ImageBitmap, transferred; closed here)
//   out { type: "result", pose?, hands, face?, faceOff?, poseMs?, handMs, faceMs?, error? }
//       pose  = { landmarks, worldLandmarks, mask: null | { width, height, data: Uint8Array 0/255 } } (only when runPose;
//               landmarks empty with no person; mask buffer transferred, only when wantMask)
//       hands = { landmarks, worldLandmarks, handedness } in MediaPipe's own shape (labels NOT swapped here)
//       face  = null | { eyeBlinkLeft, eyeBlinkRight } raw model scores (only when runFace; not swapped here)
// In a worker MediaPipe draws through an OffscreenCanvas (GPU delegate) or plain wasm (CPU delegate).

const ROOT = new URL("../../", import.meta.url);
const FILESET = {
  wasmLoaderPath: new URL("vendor/mediapipe/wasm/vision_wasm_internal.js", ROOT).href,
  wasmBinaryPath: new URL("vendor/mediapipe/wasm/vision_wasm_internal.wasm", ROOT).href,
};
const BUNDLE = new URL("vendor/mediapipe/vision_bundle.mjs", ROOT).href;
const POSE_MODEL = new URL("assets/ml/pose_landmarker_lite.task", ROOT).href;
const HAND_MODEL = new URL("assets/ml/hand_landmarker.task", ROOT).href;
const FACE_MODEL = new URL("assets/ml/face_landmarker.task", ROOT).href;

// ---- telemetry guard (same rule as tracking.js; the worker has its own fetch / XHR) -----------
const BLOCKED_HOST = /(^|\.)(googleapis|google)\.com$/i;
function blocked(url) {
  try { return BLOCKED_HOST.test(new URL(String(url && url.url || url), self.location.href).hostname); } catch (e) { return false; }
}
const realFetch = self.fetch;
self.fetch = function (input, init) { return blocked(input) ? Promise.resolve(new Response("", { status: 200 })) : realFetch.call(this, input, init); };
if (self.XMLHttpRequest) {
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url, ...rest) { this.__liveBlocked = blocked(url); return open.call(this, m, this.__liveBlocked ? "data:text/plain," : url, ...rest); };
  XMLHttpRequest.prototype.send = function (b) { return send.call(this, this.__liveBlocked ? null : b); };
}

// The wasm loader is a classic script that declares a global `ModuleFactory`. In a module worker
// importScripts() is unavailable, so MediaPipe falls back to self.import(url) when it exists (a plain
// import() would keep the `var` module-local). Evaluate it as global code instead.
self.import = async (url) => {
  const res = await realFetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  (0, eval)(await res.text() + "\n//# sourceURL=" + url);
};

let vision = null, pose = null, hand = null, face = null, backend = null, numHands = 2, faceErrors = 0;

async function make(delegate) {
  pose = await vision.PoseLandmarker.createFromOptions(FILESET, {
    baseOptions: { modelAssetPath: POSE_MODEL, delegate },
    runningMode: "VIDEO", numPoses: 1, outputSegmentationMasks: true,
  });
  hand = await vision.HandLandmarker.createFromOptions(FILESET, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate },
    runningMode: "VIDEO", numHands,
  });
  face = await makeFace(delegate);
  faceErrors = 0;
}

// The face model is optional: any failure here only costs the blink signal.
async function makeFace(delegate) {
  try {
    return await vision.FaceLandmarker.createFromOptions(FILESET, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate },
      runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
    });
  } catch (e) {
    console.warn("Face model unavailable, blink detection off:", e && e.message);
    return null;
  }
}

function closeAll() {
  try { if (pose) pose.close(); if (hand) hand.close(); if (face) face.close(); } catch (e) { /* ignore */ }
  pose = hand = face = null;
}

async function init() {
  if (typeof OffscreenCanvas === "undefined") throw new Error("OffscreenCanvas unavailable in worker");
  vision = await import(BUNDLE);
  try {
    await make("GPU");
    backend = "mediapipe-gpu";
  } catch (e) {
    console.warn("MediaPipe GPU delegate failed in worker, using wasm CPU:", e && e.message);
    closeAll();
    await make("CPU");
    backend = "mediapipe-wasm";
  }
}

async function toCpu() {
  closeAll();
  await make("CPU");
  backend = "mediapipe-wasm";
}

const plain = (arr) => (arr || []).map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility, presence: l.presence }));
function closeMasks(r) { (r.segmentationMasks || []).forEach((m) => { try { m.close(); } catch (e) { /* ignore */ } }); }

function detect({ ts, bitmap, runPose, runFace, wantMask }) {
  const out = { type: "result", hands: null }, transfer = [];
  if (runPose) {
    const t0 = performance.now();
    const r = pose.detectForVideo(bitmap, ts);
    out.poseMs = performance.now() - t0;
    const found = r.landmarks && r.landmarks.length;
    // Keep MediaPipe's shape (a list of poses, each a list of landmarks): takePose reads [0] of each.
    out.pose = { landmarks: found ? [plain(r.landmarks[0])] : [], worldLandmarks: found ? [plain(r.worldLandmarks[0])] : [], mask: null };
    const m = found && wantMask && r.segmentationMasks && r.segmentationMasks[0];
    if (m) {
      try {
        const f = m.getAsFloat32Array();
        const data = new Uint8Array(f.length);
        for (let i = 0; i < f.length; i++) data[i] = f[i] > 0.5 ? 255 : 0;
        out.pose.mask = { width: m.width, height: m.height, data };
        transfer.push(data.buffer);
      } catch (e) { out.pose.mask = null; }
    }
    closeMasks(r);
  }
  if (runFace && face) {
    // Never throws: a failing face model must not stop pose/hands.
    try {
      const t0 = performance.now();
      const r = face.detectForVideo(bitmap, ts);
      out.faceMs = performance.now() - t0;
      const cats = r.faceBlendshapes && r.faceBlendshapes[0] && r.faceBlendshapes[0].categories;
      const get = (n) => { const c = cats.find((k) => k.categoryName === n); return c ? c.score : 0; };
      out.face = cats ? { eyeBlinkLeft: get("eyeBlinkLeft"), eyeBlinkRight: get("eyeBlinkRight") } : null;
      faceErrors = 0;
    } catch (e) {
      out.face = null;
      if (++faceErrors >= 5) {
        console.warn("Face model failing, blink detection off:", e && e.message);
        try { face.close(); } catch (e2) { /* ignore */ }
        face = null; out.faceOff = true;
      }
    }
  }
  const t0 = performance.now();
  const r = hand.detectForVideo(bitmap, ts);
  out.handMs = performance.now() - t0;
  out.hands = { landmarks: (r.landmarks || []).map(plain), worldLandmarks: (r.worldLandmarks || []).map(plain),
    handedness: (r.handedness || []).map((cs) => cs.map((c) => ({ categoryName: c.categoryName, score: c.score }))) };
  return { out, transfer };
}

self.onmessage = async ({ data }) => {
  if (data.type === "frame") {
    try {
      const { out, transfer } = detect(data);
      self.postMessage(out, transfer);
    } catch (e) {
      self.postMessage({ type: "result", error: String(e && e.message || e) });
    } finally {
      try { data.bitmap.close(); } catch (e) { /* ignore */ }
    }
  } else if (data.type === "init" || data.type === "cpu") {
    try {
      if (data.type === "init") { numHands = data.numHands === 1 ? 1 : 2; await init(); } else await toCpu();
      self.postMessage({ type: "ready", backend, face: !!face });
    } catch (e) {
      closeAll();
      self.postMessage({ type: "init-error", message: String(e && e.message || e) });
    }
  } else if (data.type === "numHands") {
    numHands = data.n === 1 ? 1 : 2;
    try { if (hand) hand.setOptions({ numHands }); } catch (e) { console.warn(e); }
  }
};
