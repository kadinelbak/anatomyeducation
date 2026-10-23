// Live mode body tracking: MediaPipe Tasks Vision PoseLandmarker + HandLandmarker, run in the
// browser from files in this repo (vendor/mediapipe, assets/ml). Contract: CONTRACTS.md section 2.
//
// Design notes
// - Input is the raw (un-mirrored) camera video; output coordinates are image space, never mirrored.
// - Pose runs every 2nd processed frame; on the other frames the last pose is extrapolated by half of
//   its last inter-run motion ("interpolation"). Hands run every frame. All landmarks go through a
//   one-euro filter (Casiez et al. 2012), one filter per coordinate.
// - Handedness: MediaPipe's HandLandmarker documents that its "Left"/"Right" label assumes a MIRRORED
//   (selfie-flipped) input image. We feed the un-mirrored frame, so the label is the opposite of the
//   user's real hand: label "Left" = the user's RIGHT hand. We therefore swap once, here.
//   (Pose needs no swap: BlazePose index 11 is the subject's own left shoulder.)
// - GPU delegate first, automatic fallback to the wasm (CPU) delegate; stats.backend says which.
// - TODO(fallback): a tfjs MoveNet path would plug in at `loadModels()` (backend "tfjs"); not built yet.

const ROOT = new URL("../../", import.meta.url);
// Explicit simd files: no directory probing for other variants (only these two are vendored).
const FILESET = {
  wasmLoaderPath: new URL("vendor/mediapipe/wasm/vision_wasm_internal.js", ROOT).href,
  wasmBinaryPath: new URL("vendor/mediapipe/wasm/vision_wasm_internal.wasm", ROOT).href,
};
const BUNDLE = new URL("vendor/mediapipe/vision_bundle.mjs", ROOT).href;
const POSE_MODEL = new URL("assets/ml/pose_landmarker_lite.task", ROOT).href;
const HAND_MODEL = new URL("assets/ml/hand_landmarker.task", ROOT).href;

const POSE_EVERY = 2;
const SLOW_FPS = 12, SLOW_MS = 5000;

// ---- one-euro filter -------------------------------------------------------------------------
class OneEuro {
  constructor(minCutoff = 1.2, beta = 6, dCutoff = 1) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = 0;
  }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, tSec) {
    if (this.x === null) { this.x = v; this.t = tSec; return v; }
    const dt = Math.max(1e-3, tSec - this.t);
    this.t = tSec;
    const d = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (d - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

class LandmarkFilter {
  constructor(n, keys) { this.keys = keys; this.f = Array.from({ length: n }, () => keys.map(() => new OneEuro())); }
  apply(lms, tSec) {
    return lms.map((l, i) => {
      const o = { ...l };
      this.keys.forEach((k, j) => { o[k] = this.f[i][j].filter(l[k], tSec); });
      return o;
    });
  }
}

const mapLms = (arr, withV) => arr.map((l) => ({ x: l.x, y: l.y, z: l.z || 0, v: withV ? (l.visibility ?? l.presence ?? 1) : 1 }));

// ---- fixture mode ----------------------------------------------------------------------------
function resolveUrl(p) { return /^(https?:|\/|blob:|data:)/.test(p) ? p : new URL(p, ROOT).href; }

async function createFixtureTracker({ fixture, onFrame, onStatus }) {
  const status = (s, message) => { try { onStatus && onStatus(s, message); } catch (e) { console.error(e); } };
  status("loading");
  const res = await fetch(resolveUrl(fixture));
  if (!res.ok) { status("error", `fixture ${fixture}: HTTP ${res.status}`); throw new Error("fixture HTTP " + res.status); }
  const data = await res.json();
  const frames = data.frames || [];
  const fps = data.fps || 30;
  let timer = null, i = 0, last = null;
  const stats = { fps, poseMs: 0, handMs: 0, backend: "fixture" };
  function tick() {
    const f = frames[i % frames.length]; i++;
    const frame = { t: performance.now(), width: f.width || data.width || 640, height: f.height || data.height || 480,
      pose: f.pose || null, hands: f.hands || [] };
    const st = frame.pose || frame.hands.length ? "tracking" : "no-person";
    if (st !== last) { last = st; status(st); }
    try { onFrame && onFrame(frame); } catch (e) { console.error(e); }
  }
  return {
    start() { if (!timer) timer = setInterval(tick, 1000 / fps); },
    stop() { clearInterval(timer); timer = null; },
    dispose() { this.stop(); },
    setNumHands() {},
    get stats() { return stats; },
    get frameCount() { return frames.length; },
  };
}

// ---- telemetry guard -------------------------------------------------------------------------
// MediaPipe's runtime posts usage logs to odml.pa.googleapis.com and exposes no switch to turn that
// off, so while a tracker exists we swallow requests to *.googleapis.com / *.google.com (only those).
const BLOCKED_HOST = /(^|\.)(googleapis|google)\.com$/i;
function blocked(url) {
  try { return BLOCKED_HOST.test(new URL(String(url && url.url || url), location.href).hostname); } catch (e) { return false; }
}
let guardUsers = 0, guardRestore = null;
function installGuard() {
  if (guardUsers++) return;
  const f = window.fetch, open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send, beacon = navigator.sendBeacon;
  window.fetch = function (input, init) { return blocked(input) ? Promise.resolve(new Response("", { status: 200 })) : f.call(this, input, init); };
  XMLHttpRequest.prototype.open = function (m, url, ...rest) { this.__liveBlocked = blocked(url); return open.call(this, m, this.__liveBlocked ? "data:text/plain," : url, ...rest); };
  XMLHttpRequest.prototype.send = function (b) { return send.call(this, this.__liveBlocked ? null : b); };
  if (beacon) navigator.sendBeacon = function (url, data) { return blocked(url) ? true : beacon.call(this, url, data); };
  guardRestore = () => {
    window.fetch = f; XMLHttpRequest.prototype.open = open; XMLHttpRequest.prototype.send = send;
    if (beacon) navigator.sendBeacon = beacon;
  };
}
function removeGuard() { if (guardUsers && !--guardUsers) { guardRestore(); guardRestore = null; } }

// ---- real tracker ----------------------------------------------------------------------------
async function loadModels(numHands, status) {
  // TODO(fallback): if MediaPipe cannot start at all, try a tfjs MoveNet path here (backend "tfjs").
  const vision = await import(BUNDLE);
  const fileset = FILESET;
  const make = async (delegate) => ({
    pose: await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate },
      runningMode: "VIDEO", numPoses: 1, outputSegmentationMasks: true,
    }),
    hand: await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate },
      runningMode: "VIDEO", numHands,
    }),
  });
  try {
    const m = await make("GPU");
    return { ...m, backend: "mediapipe-gpu", make };
  } catch (e) {
    console.warn("MediaPipe GPU delegate failed, using wasm CPU:", e && e.message);
    const m = await make("CPU");
    return { ...m, backend: "mediapipe-wasm", make };
  }
}

export async function createTracker({ video, onFrame, onStatus, budgetMs = 33, fixture } = {}) {
  if (fixture) return createFixtureTracker({ fixture, onFrame, onStatus });
  let lastStatus = null;
  const status = (s, message) => {
    if (s === lastStatus && s !== "slow") return;
    lastStatus = s;
    try { onStatus && onStatus(s, message); } catch (e) { console.error(e); }
  };
  status("loading");
  installGuard();
  let guarded = true;
  const unguard = () => { if (guarded) { guarded = false; removeGuard(); } };
  let models;
  try { models = await loadModels(2, status); } catch (e) {
    unguard();
    status("error", "Could not start body tracking: " + (e && e.message || e));
    throw e;
  }
  let { pose: poseLm, hand: handLm, backend } = models;
  let numHands = 2, running = false, handle = 0, usingRvfc = false, disposed = false;
  let frameNo = 0, lastVideoTime = -1, lastTs = 0, lastDraw = 0, slowSince = 0, slowDone = false;
  let lastPose = null, prevPose = null, lastMask = null, poseWarm = false;
  const stats = { fps: 0, poseMs: 0, handMs: 0, backend };
  const poseF = new LandmarkFilter(33, ["x", "y", "z"]);
  const poseWF = new LandmarkFilter(33, ["x", "y", "z"]);
  const handF = { left: new LandmarkFilter(21, ["x", "y", "z"]), right: new LandmarkFilter(21, ["x", "y", "z"]) };
  const handWF = { left: new LandmarkFilter(21, ["x", "y", "z"]), right: new LandmarkFilter(21, ["x", "y", "z"]) };

  async function fallbackToCpu() {
    if (stats.backend === "mediapipe-wasm") return false;
    try { poseLm.close(); handLm.close(); } catch (e) { /* ignore */ }
    const m = await models.make("CPU");
    poseLm = m.pose; handLm = m.hand; stats.backend = "mediapipe-wasm"; lastTs = 0;
    return true;
  }

  function runPose(ts) {
    const t0 = performance.now();
    const r = poseLm.detectForVideo(video, ts);
    stats.poseMs = performance.now() - t0;
    poseWarm = true;
    if (!r.landmarks || !r.landmarks.length) { lastPose = prevPose = null; lastMask = null; closeMasks(r); return; }
    const cur = { lm: mapLms(r.landmarks[0], true), world: mapLms(r.worldLandmarks[0], true) };
    prevPose = lastPose;
    lastPose = cur;
    lastMask = null;
    const m = r.segmentationMasks && r.segmentationMasks[0];
    if (m) {
      try {
        const f = m.getAsFloat32Array();
        const data = new Uint8Array(f.length);
        for (let i = 0; i < f.length; i++) data[i] = f[i] > 0.5 ? 255 : 0;
        lastMask = { width: m.width, height: m.height, data };
      } catch (e) { lastMask = null; }
    }
    closeMasks(r);
  }
  function closeMasks(r) { (r.segmentationMasks || []).forEach((m) => { try { m.close(); } catch (e) { /* ignore */ } }); }

  // Pose for a frame where the model did not run: last result moved on by half its last step.
  function interpolated() {
    if (!lastPose) return null;
    if (!prevPose) return lastPose;
    const ex = (a, b) => a.map((l, i) => ({ x: l.x + 0.5 * (l.x - b[i].x), y: l.y + 0.5 * (l.y - b[i].y), z: l.z + 0.5 * (l.z - b[i].z), v: l.v }));
    return { lm: ex(lastPose.lm, prevPose.lm), world: ex(lastPose.world, prevPose.world) };
  }

  function runHands(ts) {
    const t0 = performance.now();
    const r = handLm.detectForVideo(video, ts);
    stats.handMs = performance.now() - t0;
    const found = [];
    (r.landmarks || []).forEach((lms, i) => {
      const cat = r.handedness[i][0];
      // Swap: MediaPipe labels assume a mirrored image; ours is not mirrored (see header).
      found.push({ side: cat.categoryName === "Left" ? "right" : "left", score: cat.score,
        lm: mapLms(lms, false), world: mapLms(r.worldLandmarks[i], false) });
    });
    // Two hands given the same side: keep the better one on that side, the other takes the opposite.
    if (found.length === 2 && found[0].side === found[1].side) {
      const w = found[0].score >= found[1].score ? 1 : 0;
      found[w].side = found[w].side === "left" ? "right" : "left";
    }
    return found;
  }

  function process() {
    if (disposed || !running) return;
    const now = performance.now();
    if (video.readyState >= 2 && video.videoWidth && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const ts = Math.max(lastTs + 1, now);
      lastTs = ts;
      const tSec = ts / 1000;
      try {
        if (frameNo % POSE_EVERY === 0) runPose(ts);
        const hands = runHands(ts);
        const p = frameNo % POSE_EVERY === 0 ? lastPose : interpolated();
        frameNo++;
        const frame = { t: now, width: video.videoWidth, height: video.videoHeight, pose: null, hands: [] };
        if (p) frame.pose = { landmarks: poseF.apply(p.lm, tSec), world: poseWF.apply(p.world, tSec), mask: lastMask };
        hands.sort((a, b) => (a.side === "left" ? -1 : 1) - (b.side === "left" ? -1 : 1));
        frame.hands = hands.map((h) => ({ side: h.side, score: h.score,
          landmarks: handF[h.side].apply(h.lm, tSec), world: handWF[h.side].apply(h.world, tSec) }));
        // fps (smoothed over processed frames) and the slow rule
        if (lastDraw) {
          const inst = 1000 / Math.max(1, now - lastDraw);
          stats.fps = stats.fps ? stats.fps * 0.9 + inst * 0.1 : inst;
        }
        lastDraw = now;
        if (stats.fps && stats.fps < SLOW_FPS) {
          slowSince = slowSince || now;
          if (!slowDone && now - slowSince > SLOW_MS) {
            slowDone = true; api.setNumHands(1);
            status("slow", `Tracking is slow (${stats.fps.toFixed(0)} fps); following one hand.`);
          }
        } else slowSince = 0;
        if (lastStatus !== "slow" || frame.pose || frame.hands.length) {
          if (!(lastStatus === "slow" && slowSince)) status(frame.pose || frame.hands.length ? "tracking" : "no-person");
        }
        onFrame && onFrame(frame);
      } catch (e) {
        if (!poseWarm && stats.backend === "mediapipe-gpu") {
          running = false;
          fallbackToCpu().then(() => { running = true; schedule(); }).catch((e2) => status("error", String(e2 && e2.message || e2)));
          return;
        }
        console.error(e); status("error", String(e && e.message || e));
      }
    }
    schedule();
  }
  function schedule() {
    if (!running || disposed) return;
    if (video.requestVideoFrameCallback) { usingRvfc = true; handle = video.requestVideoFrameCallback(process); }
    else { usingRvfc = false; handle = requestAnimationFrame(process); }
  }

  const api = {
    start() { if (running || disposed) return; running = true; lastDraw = 0; slowSince = 0; schedule(); },
    stop() {
      running = false;
      if (usingRvfc && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle);
    },
    dispose() {
      this.stop(); disposed = true;
      try { poseLm.close(); handLm.close(); } catch (e) { /* ignore */ }
      // close() and the runtime's timers may still try to flush a log; keep the guard up a little longer.
      setTimeout(unguard, 10000);
    },
    setNumHands(n) {
      numHands = n === 1 ? 1 : 2;
      try { handLm.setOptions({ numHands }); } catch (e) { console.warn(e); }
    },
    get numHands() { return numHands; },
    get stats() { return stats; },
  };
  return api;
}
