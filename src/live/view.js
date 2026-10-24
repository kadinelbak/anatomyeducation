// Live mode view shell: camera feed, overlay, status pill, structures panel, modality toolbar and scan window.
// Wires tracker -> pointer -> probe each frame (see src/live/CONTRACTS.md). The sibling modules are imported
// dynamically; if one is missing or fails to start, a small inline stub keeps the view working.
import { createRendererSwitch } from "../renderers/switch.js";

const HIDDEN_EXIT_MS = 30000;
const PEEK = 120;
const HAND_BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const HAND_COLOR = "#ff9f1c";
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12]];
const MODALITIES = [{ id: "ct", label: "CT" }, { id: "mri", label: "MRI" }, { id: "xray", label: "X-ray" }, { id: "ultrasound", label: "Ultrasound" }];

// segments.json names the upper limb model "arm"; CONFIG.models (and so openExplore) call it "upper-limb".
const EXPLORE_MODEL = { arm: "upper-limb" };
const ACCENT = "#4fb3ff";
const CAL_KEY = "live.calibration.v1", CAL_SKIP = "live.calibration.skipped";
const CAL_SAMPLES = 30, CAL_MS = 3000, REC_MS = 10000, REC_MAX = 600;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const NO_SCANS = "No scans for this region yet";
const HAND_KEY = "live.pointerHand";
const LEGEND = "1-4 fingers: scan \u00b7 fist + blink: next structure \u00b7 two fists: release";
const SCAN_TIMEOUT_MS = 20000;
const ZOOM_PAD = 0.35, ZOOM_MIN = 0.3, ZOOM_MAX = 3, ZOOM_EASE = 0.1;
// ?live-fixture=<path> replays recorded tracker frames instead of opening a camera (tests, demos).
const debugMode = () => { try { return new URLSearchParams(location.search).get("live-debug") === "1"; } catch { return false; } };
const fixtureUrl = () => { try { return new URLSearchParams(location.search).get("live-fixture") || null; } catch { return null; } };

// ---------- The view ----------
export function createLiveView({ root, onExit, openExplore, config }) {
  let active = false;
  let built = false;
  let stream = null;
  let tracker = null, pointer = null, probe = null, usProbe = null, renderers = null, gestures = null;
  let flow = "seek"; // "hand" (choose the pointing hand) -> "seek" -> "locked"
  let pointerHand = null;
  let flash = { text: "", until: 0 };
  let structs = [], structIdx = -1;
  let zoom = { k: 1, tx: 0, ty: 0 };
  let avail = {};
  let modality = null;
  let lastKey = null, lastReqKey = null, applying = false;
  let hiddenTimer = null;
  let statusText = "Point at your body", statusState = "loading";
  let locked = false;
  let cal = null; // calibration run in progress: { samples, t0, last }
  let rec = null; // recording in progress: { frames, t0 }
  let calTimer = null;
  let session = 0; // bumps on every open/close so late async work can tell it is stale
  let el = {};
  const h = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  function build() {
    if (built) return;
    built = true;
    el.stage = h("div", "live-stage");
    el.video = h("video", "live-video");
    el.video.muted = true; el.video.playsInline = true; el.video.setAttribute("playsinline", ""); el.video.autoplay = true;
    el.canvas = h("canvas", "live-overlay");
    el.pill = h("div", "live-pill");
    el.pill.dataset.state = "loading";
    el.pill.append(h("span", "dot"));
    el.pillText = h("span", "text", "Starting");
    el.pillText.setAttribute("role", "status");
    el.x = h("button", "live-x", "✕");
    el.x.type = "button"; el.x.setAttribute("aria-label", "Close Live"); el.x.title = "Close Live";
    el.x.addEventListener("click", () => exit());
    el.unlock = h("button", "live-unlock", "Unlock");
    el.unlock.type = "button"; el.unlock.hidden = true; el.unlock.title = "Release the locked region";
    el.unlock.addEventListener("click", unlockNow);
    el.recBtn = null;
    el.pill.append(el.pillText);
    if (debugMode()) {
      el.recBtn = h("button", "live-record", "Record 10 s");
      el.recBtn.type = "button";
      el.recBtn.addEventListener("click", startRecording);
      el.pill.append(el.recBtn);
    }
    el.pill.append(el.unlock, el.x);
    el.stage.addEventListener("click", onStageClick);
    el.zoom = h("div", "live-zoom");
    el.zoom.append(el.video, el.canvas);
    el.stage.append(el.zoom);

    el.panel = h("aside", "live-panel");
    el.panel.hidden = true;
    el.grab = h("button", "live-grab");
    el.grab.type = "button"; el.grab.setAttribute("aria-label", "Drag to resize the structures panel");
    el.title = h("h2", "", "Point at your body");
    el.hint = h("p", "live-hint", "Point a finger at your arm, hand or trunk and hold still.");
    el.legend = h("p", "live-legend", LEGEND);
    el.legend.hidden = true;
    el.list = h("ul", "live-structs");
    el.scan = h("div", "live-scan");
    el.scan.hidden = true;
    el.scanView = h("div", "live-scan-view");
    el.scan.append(el.scanView);
    el.caption = h("p", "live-caption");
    el.scanpane = h("div", "live-scanpane"); // right-hand pane in split layout (hidden otherwise)
    el.scanpane.append(el.scan, el.caption);
    el.calBtn = h("button", "live-calibrate", "Calibrate");
    el.calBtn.type = "button"; el.calBtn.title = "Measure your arm proportions for better pointing";
    el.calBtn.addEventListener("click", () => showCalibrateCard());
    el.head = h("div", "live-head");
    el.handBtn = h("button", "live-hand", "Change hand");
    el.handBtn.type = "button"; el.handBtn.title = "Choose which hand points";
    el.handBtn.addEventListener("click", changeHand);
    el.head.append(el.title, el.handBtn, el.calBtn);
    el.panel.append(el.grab, el.head, el.hint, el.legend, el.list);

    el.toolbar = h("div", "toolbar live-toolbar");
    el.toolbar.setAttribute("role", "toolbar"); el.toolbar.setAttribute("aria-label", "Scan type");
    el.toolbar.hidden = true;

    el.debug = h("pre", "live-debug");
    el.debug.hidden = !debugMode();
    el.card = h("div", "card live-card");
    root.replaceChildren(el.stage, el.scanpane, el.pill, el.panel, el.toolbar, el.card, el.debug);
    wireSheet();
  }

  function showCard(title, body, buttons, keepPanel) {
    el.card.replaceChildren(h("h1", "", title), h("p", "", body));
    const row = h("div", "row");
    for (const b of buttons) {
      const btn = h("button", b.primary ? "primary" : "", b.label);
      btn.type = "button";
      btn.addEventListener("click", b.onClick);
      row.append(btn);
    }
    el.card.append(row);
    el.card.hidden = false;
    if (!keepPanel) {
      el.panel.hidden = true; el.toolbar.hidden = true;
      setPill("loading", "Live needs a camera");
    }
    row.querySelector("button")?.focus();
  }
  const unsupported = (why) => showCard("Live needs a camera", `${why} You can still explore every model with the mouse or touch.`, [{ label: "Open Explore", primary: true, onClick: () => exit() }]);

  function setPill(state, text) {
    el.pill.dataset.state = state;
    el.pillText.textContent = text;
  }

  function hasWebGL2() {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2");
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      return !!gl;
    } catch { return false; }
  }

  // ---------- Open / close ----------
  function open() {
    if (active) return;
    build();
    active = true;
    session++;
    root.hidden = false;
    document.body.classList.add("live");
    try { history.pushState({ live: 1 }, "", "#live"); } catch {}
    window.addEventListener("popstate", onPop);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", sizeCanvas);
    setPill("loading", "Camera permission");
    if (!navigator.mediaDevices?.getUserMedia) return unsupported("This browser cannot open a camera.");
    if (!hasWebGL2()) return unsupported("Live also needs WebGL 2, which this browser does not offer.");
    showCard("Use your camera", "Live watches where you point on your own body and shows what lies beneath. The video stays on this device and is never recorded or sent anywhere.", [
      { label: "Turn on camera", primary: true, onClick: startCamera },
      { label: "Not now", onClick: () => exit() },
    ]);
  }

  async function startCamera() {
    const mine = session;
    el.card.hidden = true;
    const fixture = fixtureUrl();
    setPill("loading", fixture ? "Loading tracking" : "Starting camera");
    if (fixture) { el.panel.hidden = false; sizeCanvas(); } // replay needs no camera
    else try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      if (!active || mine !== session) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
    } catch (e) {
      if (mine === session) unsupported(e?.name === "NotAllowedError" ? "Camera access was not allowed." : "No camera could be opened.");
      return;
    }
    if (stream) {
      el.video.srcObject = stream;
      try { await el.video.play(); } catch {}
      if (mine !== session) return;
      sizeCanvas();
      el.panel.hidden = false;
      setPill("loading", "Loading tracking");
    }
    renderers ||= createRendererSwitch({ viewer: el.scanView, models: config.models, onPick() {}, onSelect() {}, onChange() {} });
    const onStatus = (status, message) => {
      if (mine !== session) return;
      const text = message || { loading: "Loading tracking", tracking: "Point at your body", "no-person": "Step back so I can see you", slow: "Running slowly", error: "Tracking problem" }[status] || status;
      statusState = status; statusText = text;
      if (!cal && !rec && !(locked && status === "tracking")) setPill(status, text);
    };
    let t, p, pr, us, gs = null;
    try {
      // tracking.js loads the MediaPipe runtime only on the real-camera path, never for a fixture.
      const [trk, pnt, prb, prbUs, gmod] = await Promise.all([import("./tracking.js"), import("./pointing.js"), import("./probe.js"), import("./probe-us.js"),
        import("./gestures.js").catch((e) => { console.warn("live: gestures unavailable", e); return null; })]);
      gs = gmod?.createGestures?.() || null;
      us = prbUs.createUltrasoundProbe();
      [t, p, pr] = await Promise.all([
        trk.createTracker({ video: el.video, onFrame: (f) => onFrame(f, mine), onStatus, fixture: fixture || undefined }),
        pnt.createPointer({}),
        prb.createProbe({ renderers }),
        us.ready,
      ]);
    } catch (e) {
      console.warn("live: tracking could not start", e);
      if (mine === session) unsupported("Tracking could not start on this device.");
      return;
    }
    if (mine !== session || !active) { t.dispose?.(); return; }
    tracker = t; pointer = p; probe = pr; usProbe = us; gestures = gs;
    const saved0 = store.get(HAND_KEY);
    pointerHand = saved0 === "left" || saved0 === "right" ? saved0 : null;
    flow = pointerHand || !gestures ? "seek" : "hand";
    try { pointer.setPointerHand?.(pointerHand); } catch (e) { console.warn("live: setPointerHand failed", e); }
    try { pointer.setHardLock?.(true); } catch (e) { console.warn("live: setHardLock failed", e); }   // a lock stays until two fists, Unlock or Escape
    try {
      const saved = store.get(CAL_KEY);
      if (saved) pointer.setCalibration?.(JSON.parse(saved));
    } catch (e) { console.warn("live: stored calibration ignored", e); }
    tracker.start();
    if (!store.get(CAL_KEY) && !store.get(CAL_SKIP)) showCalibrateCard();
  }

  function stopAll() {
    session++;
    try { tracker?.stop(); tracker?.dispose?.(); } catch {}
    tracker = null; pointer = null; probe = null; usProbe = null; gestures = null;
    pointerHand = null; flow = "seek"; flash.until = 0; structs = []; structIdx = -1;
    cal = null; rec = null; locked = false; clearTimeout(calTimer);
    document.removeEventListener("keydown", onKey);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (el.video) { el.video.pause(); el.video.srcObject = null; }
    clearTimeout(hiddenTimer); hiddenTimer = null;
    window.removeEventListener("popstate", onPop);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", sizeCanvas);
  }

  function close() {
    if (!active) return;
    active = false;
    stopAll();
    root.hidden = true;
    document.body.classList.remove("live");
    modality = null; lastKey = null; lastReqKey = null; applying = false; pendingReq = null;
    if (el.unlock) el.unlock.hidden = true;
    setZoom({ k: 1, tx: 0, ty: 0 });
    if (el.legend) el.legend.hidden = true;
    if (el.list) { el.list.replaceChildren(); el.toolbar.replaceChildren(); el.toolbar.hidden = true; setScan(false); el.caption.textContent = ""; }
    if (location.hash === "#live") { try { history.back(); } catch {} }
  }
  function exit() { close(); onExit?.(); }

  function onPop() {
    if (active) { active = false; closeNoHistory(); onExit?.(); }
  }
  function closeNoHistory() {
    stopAll();
    root.hidden = true;
    document.body.classList.remove("live");
    modality = null; lastKey = null; lastReqKey = null;
    if (el.scan) setScan(false);
  }
  function onVisibility() {
    if (document.hidden) {
      tracker?.stop();
      clearTimeout(hiddenTimer);
      hiddenTimer = setTimeout(() => { if (active && document.hidden) exit(); }, HIDDEN_EXIT_MS);
    } else {
      clearTimeout(hiddenTimer); hiddenTimer = null;
      if (active) tracker?.start();
    }
  }

  // ---------- Bottom sheet (phones) ----------
  function wireSheet() {
    let startY = 0, startH = 0, dragging = false, moved = false;
    const phone = () => window.matchMedia("(max-width: 600px)").matches || (root.classList.contains("live-split") && window.matchMedia("(max-width: 800px)").matches);
    const half = () => Math.round(root.clientHeight * 0.5);
    const setH = (v) => root.style.setProperty("--sheet-h", `${Math.max(PEEK, Math.min(half(), v))}px`);
    el.grab.addEventListener("pointerdown", (e) => { if (!phone()) return; dragging = true; moved = false; startY = e.clientY; startH = el.panel.offsetHeight; el.grab.setPointerCapture(e.pointerId); });
    el.grab.addEventListener("pointermove", (e) => { if (dragging) { moved = moved || Math.abs(startY - e.clientY) > 4; setH(startH + (startY - e.clientY)); } });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      if (!moved) return;
      setH(el.panel.offsetHeight > (PEEK + half()) / 2 ? half() : PEEK);
    };
    el.grab.addEventListener("pointerup", end);
    el.grab.addEventListener("pointercancel", end);
    el.grab.addEventListener("click", () => { if (phone() && !moved) setH(el.panel.offsetHeight > PEEK + 10 ? PEEK : half()); });
  }

  // ---------- Split layout (camera left / scan right; stacked on narrow screens) ----------
  function setScan(show) { el.scan.hidden = !show; syncSplit(); }
  function syncSplit() {
    const on = !el.scan.hidden && !!modality;
    if (root.classList.contains("live-split") === on) return;
    root.classList.toggle("live-split", on);
    relayout();
  }
  // The stage changed size: resize the overlay, keep the zoom framing proportional, then let the scan renderers re-fit.
  // (src/renderers/switch.js has no resize API; each renderer listens to window "resize" / a ResizeObserver.)
  function relayout() {
    const ow = cw, oh = ch;
    sizeCanvas();
    if (ow > 1 && oh > 1 && (zoom.tx || zoom.ty)) setZoom({ k: zoom.k, tx: zoom.tx * cw / ow, ty: zoom.ty * ch / oh });
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  // ---------- Per-frame work ----------
  let vw = 640, vh = 480, cw = 1, ch = 1, dpr = 1;
  function sizeCanvas() {
    if (!el.canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = el.stage.clientWidth; ch = el.stage.clientHeight;
    el.canvas.width = Math.round(cw * dpr); el.canvas.height = Math.round(ch * dpr);
  }
  // Image space (un-mirrored, 0..1) -> canvas pixels, matching object-fit: cover and the mirrored video.
  function toPx(p) {
    const s = Math.max(cw / vw, ch / vh);
    const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
    return { x: cw - (ox + p.x * vw * s), y: oy + p.y * vh * s };
  }

  function onFrame(frame, mine) {
    if (!active || mine !== session) return;
    vw = frame.width || el.video.videoWidth || vw; vh = frame.height || el.video.videoHeight || vh;
    if (el.stage.clientWidth !== cw || el.stage.clientHeight !== ch) sizeCanvas();
    const ctx = el.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (rec) recordFrame(frame);
    if (cal) { tracker?.setNeeds?.({ mask: true, face: false }); drawPose(ctx, frame); drawHands(ctx, frame); calibrateStep(frame); return; }
    drawPose(ctx, frame);
    drawHands(ctx, frame);
    const now = performance.now();
    let gs = null;
    if (gestures && pointer) try { gs = gestures.update(frame, { pointerHand }) || null; } catch (e) { console.warn("live: gestures failed", e); }
    if (!el.debug.hidden) debugReadout(frame, gs);
    // Only pay for the person mask while seeking, and for the face model while a blink can matter
    // (locked with the control hand in a fist), while recording, or with the debug readout open.
    // Uses last frame's lock state; one frame late is fine.
    try { tracker?.setNeeds?.({ mask: !locked, face: (locked && gs?.control?.shape === "fist") || !!rec || !el.debug.hidden }); } catch {}
    if (flow === "hand") {
      locked = false; lastResultSeen = false; el.unlock.hidden = true;
      if (lastKey) { lastKey = null; clearPanel(); }
      setZoom(zoomTarget(null));
      if (!el.card.hidden) return;
      if (gs?.raised) choosePointerHand(gs.raised, now);
      else if (!rec) setPill("tracking", `Raise the hand you want to point with${seenHands(gs, frame)}`);
      if (flow === "hand") { if (rec) pillRecording(); return; }
    }
    let result = null;
    try { result = pointer?.update(frame) || null; } catch (e) { console.warn("live: pointing failed", e); }
    lastResultSeen = !!result;
    locked = !!(result ? (result.locked ?? result.stable) : pointer?.locked);
    flow = locked ? "locked" : "seek";
    try { drawZones(ctx, frame, result); } catch (e) { console.warn("live: zones failed", e); }
    if (result) drawPointing(ctx, result);
    el.unlock.hidden = !locked;
    if (locked && result) {
      const key = `${result.region.model}:${result.region.key}`;
      if (key !== lastKey) { lastKey = key; fillPanel(result); }
      if (!rec) flowPill("tracking", `${result.region.label} \u00b7 locked`, now);
      const ph = frame.hands.find((hd) => hd.side === (pointerHand || result.hand));
      if (ph) probeStep(ctx, frame, result, ph);
      try { setZoom(zoomTarget(frame, result)); } catch (e) { console.warn("live: zoom failed", e); }
      if (gs) { drawGlyph(ctx, frame, gs); lockedGestures(gs, now); }
    } else if (!locked) {
      if (lastKey) { lastKey = null; clearPanel(); }
      setZoom(zoomTarget(null));
      if (!rec) {
        if (result) flowPill("tracking", `Hold on: ${result.coarse?.label || result.region?.label || "..."}`, now);
        else flowPill(statusState, statusText, now);
      }
    }
    if (rec) pillRecording();
  }

  function flowPill(state, text, now) {
    if (now < flash.until) setPill("tracking", flash.text); else setPill(state, text);
  }
  function say(text, ms) { flash = { text, until: performance.now() + ms }; setPill("tracking", text); }

  function choosePointerHand(side, now) {
    pointerHand = side;
    store.set(HAND_KEY, side);
    try { pointer.setPointerHand?.(side); } catch {}
    flow = "seek";
    flash = { text: `Pointing with your ${side} hand`, until: now + 2000 };
    setPill("tracking", flash.text);
  }
  function changeHand() {
    store.del(HAND_KEY);
    pointerHand = null;
    try { pointer?.setPointerHand?.(null); } catch {}
    try { gestures?.reset?.(); } catch {}
    flash.until = 0;
    if (locked) unlockNow();
    if (gestures) flow = "hand";
  }

  // ---------- Zoom on lock ----------
  function setZoom(z) {
    zoom = z;
    el.zoom.style.transform = z.k === 1 && !z.tx && !z.ty ? "" : `translate(${z.tx.toFixed(1)}px, ${z.ty.toFixed(1)}px) scale(${z.k.toFixed(4)})`;
  }
  // The next zoom step toward the locked segment's box (or toward identity when there is none).
  function zoomTarget(frame, result) {
    let goal = { k: 1, tx: 0, ty: 0 };
    const o = frame && result ? (pointer?.outlines?.(frame) || []).find((q) => q.id === result.segment && (result.side == null || q.side == null || q.side === result.side)) : null;
    if (o?.poly?.length >= 3) {
      const pts = o.poly.map(toPx);
      let x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
      let y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
      const px = (x1 - x0) * ZOOM_PAD, py = (y1 - y0) * ZOOM_PAD;
      x0 -= px; x1 += px; y0 -= py; y1 += py;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const bw = Math.min(cw, Math.max(x1 - x0, cw * ZOOM_MIN)), bh = Math.min(ch, Math.max(y1 - y0, ch * ZOOM_MIN));
      const k = Math.max(1, Math.min(cw / bw, ch / bh, ZOOM_MAX));
      goal = { k, tx: Math.min(0, Math.max(cw - k * cw, cw / 2 - k * cx)), ty: Math.min(0, Math.max(ch - k * ch, ch / 2 - k * cy)) };
    } else if (frame && result) return zoom; // locked but no outline this frame: hold
    const e = (a, b) => (Math.abs(b - a) < 0.002 ? b : a + (b - a) * ZOOM_EASE);
    if (goal.k === 1 && zoom.k === 1 && !zoom.tx && !zoom.ty) return zoom;
    return { k: e(zoom.k, goal.k), tx: e(zoom.tx, goal.tx), ty: e(zoom.ty, goal.ty) };
  }

  // ---------- Control-hand gestures while locked ----------
  function chooseModality(id, toggle) {
    const prev = modality;
    modality = toggle && modality === id ? null : id;
    lastReqKey = null;
    if (modality !== prev) { applying = false; pendingReq = null; }
    el.toolbar.querySelectorAll(".tool").forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.id === modality)));
    if (!modality || !avail[modality]) { setScan(false); el.caption.textContent = ""; }
    if (modality) el.hint.hidden = true;
    el.syncNote?.();
  }
  function lockedGestures(gs, now) {
    if (gs.count >= 1 && gs.count <= MODALITIES.length) {
      const m = MODALITIES[gs.count - 1];
      if (modality !== m.id) chooseModality(m.id, false);
      if (!avail[m.id]) say(`No ${m.label} here`, 1500);
    }
    if (gs.fist && gs.blink && structs.length) {
      structIdx = (structIdx + 1) % structs.length;
      markCurrent();
      say(structs[structIdx].name, 1500);
    }
    if (gs.twoFists) unlockNow();   // the only gesture that releases a lock
  }
  function markCurrent() {
    [...el.list.children].forEach((li, i) => li.classList.toggle("current", i === structIdx));
    el.list.children[structIdx]?.scrollIntoView?.({ block: "nearest" });
  }
  function drawGlyph(ctx, frame, gs) {
    const c = gs.control;
    if (!c) return;
    const hd = frame.hands.find((q) => q.side === c.side);
    const w = hd?.landmarks?.[0];
    if (!w) return;
    const p = toPx(w), n = ["index", "middle", "ring", "pinky"].filter((k) => c.extended?.[k]).length; // counts ignore the thumb, like gestures.js
    const text = c.shape === "fist" ? "Fist" : c.shape === "open" ? "Open palm" : c.shape === "point" ? "1" : c.shape === "count" ? String(n) : "?";
    ctx.save();
    const lbl = c.shape === "fist" ? "\u270a " + text : text;
    drawLabel(ctx, lbl, p.x, p.y + 34);
    ctx.restore();
  }

  // What the camera makes of each hand while choosing the pointer hand, so a user can adjust.
  function seenHands(gs, frame) {
    if (!gs) return "";
    const parts = [];
    for (const side of ["left", "right"]) {
      const r = gs.hands?.[side];
      if (!r) continue;
      const n = ["index", "middle", "ring", "pinky"].filter((k) => r.extended?.[k]).length;
      const s = frame.pose?.landmarks?.[side === "left" ? 11 : 12];
      const w = frame.hands?.find((q) => q.side === side)?.landmarks?.[0];
      const where = s && w ? (w.y < s.y ? "above" : "below") + " the shoulder" : "shoulder not seen";
      parts.push(`${side}: ${n} finger${n === 1 ? "" : "s"}, ${where}`);
    }
    return parts.length ? ` \u00b7 ${parts.join(" \u00b7 ")}` : " \u00b7 no hand seen";
  }

  // Press D (or open with ?live-debug=1): what the tracker and the gesture reader see right now.
  function debugReadout(frame, gs) {
    const st = tracker?.stats || {};
    const f = (v) => (typeof v === "number" ? v.toFixed(v < 10 ? 1 : 0) : String(v));
    const lines = [`${f(st.fps)} fps · pose ${f(st.poseMs)} ms /${st.poseEvery ?? "?"} · hands ${f(st.handMs)} ms · face ${f(st.faceMs)} ms · ${st.backend || ""}`,
      `flow ${flow} · pointer hand ${pointerHand || "none"} · locked ${locked}`];
    for (const hd of frame.hands || []) {
      const r = gs?.hands?.[hd.side];
      const n = r ? ["index", "middle", "ring", "pinky"].filter((k) => r.extended?.[k]).length : "?";
      lines.push(`hand ${hd.side}: ${r?.shape || "?"} · ${n} fingers · thumb ${r?.extended?.thumb ? "out" : "in"} · raised ${!!r?.raised} · score ${f(hd.score)}`);
    }
    if (!(frame.hands || []).length) lines.push("no hands");
    const b = frame.face?.blink;
    lines.push(b ? `blink L ${b.left.toFixed(2)} R ${b.right.toFixed(2)}` : "no face");
    if (gs) lines.push(`gestures: count ${gs.count ?? "-"} · fist ${gs.fist} · twoFists ${gs.twoFists} · blink ${gs.blink} · raised ${gs.raised || "-"} · control ${gs.control?.side || "-"}`);
    el.debug.textContent = lines.join("\n");
  }

  function unlockNow() {
    try { pointer?.unlock?.(); } catch {}
    locked = false; lastKey = null;
    if (flow === "locked") flow = "seek";
    setZoom({ k: 1, tx: 0, ty: 0 });
    if (el.unlock) el.unlock.hidden = true;
    clearPanel();
  }
  let lastResultSeen = false;
  function onStageClick() {
    if (!active || cal) return;
    if (locked) return unlockNow();
    if (lastResultSeen) try { pointer?.lock?.(); } catch {}
  }
  function onKey(e) {
    if (!active || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape" && locked) { e.preventDefault(); unlockNow(); }
    else if (e.key === "Enter" && locked && structIdx >= 0 && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); el.list.children[structIdx]?.querySelector("button")?.click(); }
    else if ((e.key === "r" || e.key === "R") && tracker && !cal && !rec && el.card.hidden) startRecording();
    else if (e.key === "d" || e.key === "D") el.debug.hidden = !el.debug.hidden;
  }

  function drawPose(ctx, frame) {
    const lm = frame.pose?.landmarks;
    if (!lm) return;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.28)"; ctx.lineWidth = 2; ctx.lineCap = "round";
    for (const [a, b] of BONES) {
      if (!lm[a] || !lm[b] || lm[a].v < 0.4 || lm[b].v < 0.4) continue;
      const p = toPx(lm[a]), q = toPx(lm[b]);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    ctx.restore();
  }

  // Every tracked hand in orange so the user sees what the computer reads: the pointer hand opaque ("point"), the other 0.75 ("menu").
  function drawHands(ctx, frame) {
    for (const hd of frame.hands || []) {
      const lm = hd.landmarks;
      if (!lm || lm.length < 21) continue;
      const isPointer = pointerHand ? hd.side === pointerHand : false;
      const pts = lm.map(toPx);
      ctx.save();
      ctx.globalAlpha = isPointer ? 1 : 0.75;
      ctx.strokeStyle = HAND_COLOR; ctx.fillStyle = HAND_COLOR; ctx.lineWidth = 2; ctx.lineCap = "round";
      for (const [a, b] of HAND_BONES) { ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke(); }
      for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
      if (pointerHand) drawLabel(ctx, isPointer ? "point" : "menu", pts[0].x, pts[0].y + 22);
      ctx.restore();
    }
  }

  function polyPath(ctx, poly) {
    const pts = poly.map(toPx);
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
    return pts;
  }
  // Every visible zone as a faint dashed outline; the one being led is brighter, the locked one solid accent with its label.
  function drawZones(ctx, frame, r) {
    const outlines = pointer?.outlines?.(frame) || [];
    const lead = r?.coarse;
    ctx.save();
    ctx.lineJoin = "round";
    let focus = null;
    for (const o of outlines) {
      if (!o.poly || o.poly.length < 3) continue;
      const isLead = lead && o.id === lead.segment && (lead.side == null || o.side == null || o.side === lead.side);
      if (isLead) { focus = o; continue; }
      polyPath(ctx, o.poly);
      ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.stroke();
    }
    if (focus) {
      const pts = polyPath(ctx, focus.poly);
      if (locked) {
        ctx.setLineDash([]); ctx.fillStyle = "rgba(79,179,255,0.18)"; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = ACCENT; ctx.stroke();
        const top = pts.reduce((a, p) => (p.y < a.y ? p : a), pts[0]);
        drawLabel(ctx, focus.label || lead.label || "", top.x, top.y - 10);
      } else {
        ctx.setLineDash([6, 6]); ctx.fillStyle = "rgba(255,255,255,0.10)"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawPointing(ctx, r) {
    ctx.save();
    const t = toPx(r.tip);
    ctx.beginPath(); ctx.arc(t.x, t.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
    if (!locked && r.progress > 0) {
      ctx.beginPath(); ctx.arc(t.x, t.y, 15, -Math.PI / 2, -Math.PI / 2 + Math.min(1, r.progress) * Math.PI * 2);
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.stroke();
    }
    ctx.restore();
  }
  function drawLabel(ctx, text, x, y) {
    ctx.font = "600 14px system-ui, sans-serif";
    const w = ctx.measureText(text).width + 14;
    const lx = Math.max(4, Math.min(cw - w - 4, x - w / 2)), ly = Math.max(20, y);
    ctx.fillStyle = "rgba(15,20,25,0.8)";
    ctx.beginPath(); ctx.roundRect(lx, ly - 16, w, 22, 11); ctx.fill();
    ctx.fillStyle = "#e8edf2"; ctx.fillText(text, lx + 7, ly);
  }
  function drawProbe(ctx, tip, dir) {
    const p = toPx(tip);
    const ang = Math.atan2(dir.y, -dir.x); // mirrored x
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(ang + Math.PI / 2);
    ctx.fillStyle = "rgba(255,200,87,0.9)"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(-18, -5, 36, 10, 5); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // Image x of the trunk edges (shoulders and hips), for the ultrasound angle sweep.
  function trunkEdges(frame) {
    const xs = [11, 12, 23, 24].map((i) => frame.pose?.landmarks?.[i]).filter((l) => l && (l.v ?? 1) >= 0.3).map((l) => l.x);
    return xs.length >= 2 ? { left: Math.min(...xs), right: Math.max(...xs) } : null;
  }

  function probeStep(ctx, frame, result, hand) {
    const l5 = hand.landmarks[5], l8 = hand.landmarks[8];
    if (!l5 || !l8) return;
    let dx = l8.x - l5.x, dy = l8.y - l5.y;
    const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
    const probeTip = { tip: { x: l8.x, y: l8.y }, dir: { x: dx, y: dy } };
    drawProbe(ctx, probeTip.tip, probeTip.dir);
    if (!modality || !avail[modality]) return;
    const trunkX = trunkEdges(frame);
    const point = trunkX ? { ...result, trunkX } : result;
    let req = null;
    try {
      if (modality === "ultrasound") {
        const entry = usProbe?.entriesFor(point)[0];
        req = entry ? usProbe.request(point, probeTip, entry) : null;
      } else {
        // CT, MRI and X-ray always step through the region with the finger's height. The finger's angle
        // used to pick a lengthwise (coronal/sagittal) plane, but that plane does not move with height, so a
        // finger tilting while it slid down the belly froze the scan on one of two images.
        req = probe?.request(point, { tip: probeTip.tip, dir: null }, { id: modality, study: el.scanView.dataset.study || null }) || null;
      }
    } catch (e) { console.warn("live: probe failed", e); }
    if (!req) return;
    el.caption.textContent = req.caption || "";
    const key = JSON.stringify([req.kind, req.study, req.view]);
    if (key === lastReqKey) return;
    if (applying) { pendingReq = { req, key }; return; }   // the newest request waits for the current load
    applyReq(req, key);
  }
  let pendingReq = null;
  function applyReq(req, key) {
    lastReqKey = key; applying = true;
    setScan(true);
    // probe.apply activates the renderer kind for the study (volume, xray, ultrasound) and shows the view.
    let timer = 0;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("scan-timeout")), SCAN_TIMEOUT_MS); });
    Promise.race([Promise.resolve(probe.apply(req)), timeout]).then(() => { el.scanView.dataset.kind = req.kind; el.scanView.dataset.study = req.study; el.scanView.dataset.slice = String(req.slice ?? req.view?.frac ?? ""); el.scanView.dataset.plane = req.view?.plane || req.view?.axis || ""; }).catch((e) => {
      if (e?.message === "scan-timeout") { console.warn("live: scan load timed out", req.study); say("Scan is slow to load", 2000); }
      else console.warn("live: scan failed", e);
    }).finally(() => {
      clearTimeout(timer);
      applying = false;
      const next = pendingReq; pendingReq = null;
      if (next && next.key !== lastReqKey && modality && !el.scan.hidden) applyReq(next.req, next.key);
    });
  }

  // ---------- Calibration ----------
  function showCalibrateCard() {
    if (!pointer || cal) return;
    showCard("Calibrate pointing", "Stand back and hold both arms straight out to the sides for 3 seconds. This tunes the zones to your body.", [
      { label: "Calibrate (3 s)", primary: true, onClick: startCalibration },
      { label: "Skip", onClick: () => { store.set(CAL_SKIP, "1"); el.card.hidden = true; setPill(statusState, statusText); } },
    ], true);
  }
  function startCalibration() {
    el.card.hidden = true;
    cal = { samples: [], t0: 0 };
    if (locked) unlockNow();
    setPill("loading", "Hold your arms out to the sides");
  }
  function endCalibration(text) {
    cal = null;
    setPill("tracking", text);
    clearTimeout(calTimer);
    calTimer = setTimeout(() => { if (!cal && !rec) setPill(statusState, statusText); }, 2000);
  }
  function calibrateStep(frame) {
    let m = null;
    try { m = pointer?.measure?.(frame) || null; } catch (e) { console.warn("live: measure failed", e); }
    if (!pointer?.measure) return endCalibration("Calibration unavailable");
    const now = performance.now();
    if (!m?.sample) {
      if (!cal.t0) setPill("loading", m?.hint || "Hold your arms out to the sides");
      else { cal.samples = []; cal.t0 = 0; setPill("loading", m?.hint || "Hold your arms out to the sides"); }
      return;
    }
    if (!cal.t0) { cal.t0 = now; cal.last = -1e9; }
    if (now - cal.last >= CAL_MS / CAL_SAMPLES) { cal.samples.push(m.sample); cal.last = now; }
    const left = Math.max(0, CAL_MS - (now - cal.t0));
    setPill("loading", `Hold still ${Math.ceil(left / 1000)}`);
    if (left > 0 && cal.samples.length < CAL_SAMPLES * 2) return;
    try {
      const c = pointer.calibrate(cal.samples);
      pointer.setCalibration(c);
      store.set(CAL_KEY, JSON.stringify(c));
      endCalibration("Calibrated");
    } catch (e) {
      console.warn("live: calibration failed", e);
      endCalibration("Calibration failed, try again");
    }
  }

  // ---------- Landmark recorder (offline tuning) ----------
  const plain = (l) => ({ x: +l.x, y: +l.y, z: +(l.z || 0), v: +(l.v ?? 1) });
  const plainList = (a) => (a || []).map(plain);
  function startRecording() {
    if (rec || cal || !tracker) return;
    rec = { frames: [], t0: performance.now(), w: vw, h: vh };
    el.pill.classList.add("recording");
    if (el.recBtn) el.recBtn.disabled = true;
    pillRecording();
  }
  function pillRecording() { el.pillText.textContent = "Recording 10 s"; el.pill.dataset.state = "recording"; }
  function recordFrame(frame) {
    const t = performance.now() - rec.t0;
    if (t < REC_MS && rec.frames.length < REC_MAX) {
      rec.frames.push({
        pose: frame.pose ? { landmarks: plainList(frame.pose.landmarks), world: plainList(frame.pose.world), mask: null } : null,
        hands: (frame.hands || []).map((hd) => ({ side: hd.side, score: hd.score, landmarks: plainList(hd.landmarks), world: plainList(hd.world) })),
      });
    }
    if (t >= REC_MS || rec.frames.length >= REC_MAX) finishRecording(t);
  }
  function finishRecording(ms) {
    const r = rec; rec = null;
    el.pill.classList.remove("recording");
    if (el.recBtn) el.recBtn.disabled = false;
    setPill(statusState, statusText);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const data = { name: `live-recording-${stamp}`, fps: Math.max(1, Math.round(r.frames.length / Math.max(0.1, ms / 1000))), width: r.w, height: r.h, frames: r.frames };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `live-recording-${stamp}.json`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------- Panel and toolbar ----------
  function clearPanel() {
    el.title.textContent = "Point at your body";
    el.hint.hidden = false;
    el.legend.hidden = true;
    structs = []; structIdx = -1;
    el.list.replaceChildren();
    el.toolbar.hidden = true;
    modality = null; lastReqKey = null;
    setScan(false);
    el.caption.textContent = "";
  }

  function fillPanel(r) {
    el.title.textContent = r.region.label;
    el.hint.hidden = true;
    el.legend.hidden = !gestures;
    structs = r.structures; structIdx = -1;
    el.list.replaceChildren(...r.structures.map((s) => {
      const li = h("li");
      const b = h("button");
      b.type = "button";
      b.append(h("span", "", s.name), h("span", "layer", s.layer || ""));
      b.addEventListener("click", () => { close(); openExplore?.(EXPLORE_MODEL[r.region.model] || r.region.model, s.key); });
      li.append(b);
      return li;
    }));
    avail = {};
    try { for (const m of probe?.modalitiesFor(r) || []) avail[m.id] = m; } catch (e) { console.warn("live: modalities failed", e); }
    try { if (usProbe?.entriesFor(r).length) avail.ultrasound = { id: "ultrasound", label: "Ultrasound", simulated: true }; } catch {}
    if (modality && !avail[modality]) { setScan(false); el.caption.textContent = ""; }
    el.note = h("p", "live-toolnote");
    el.note.setAttribute("role", "status");
    const syncNote = el.syncNote = () => { el.note.textContent = (!modality && !Object.keys(avail).length) || (modality && !avail[modality]) ? NO_SCANS : ""; };
    el.toolbar.replaceChildren(...MODALITIES.map((m) => {
      const b = h("button", "tool", `${MODALITIES.indexOf(m) + 1} \u00b7 ${m.label}`);
      b.type = "button"; b.dataset.id = m.id;
      b.setAttribute("aria-pressed", String(m.id === modality));
      if (!avail[m.id]) b.classList.add("unavailable");
      else if (avail[m.id].simulated) b.title = "Simulated from a reference scan";
      b.addEventListener("click", () => chooseModality(m.id, true));
      return b;
    }), el.note);
    syncNote();
    el.toolbar.hidden = false;
  }

  return { open, close, get active() { return active; } };
}
