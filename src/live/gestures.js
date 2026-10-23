// Live mode: fixed hand roles and control gestures (see src/live/CONTRACTS.md, section 7).
// A function of tracker frames plus internal hold timers keyed on frame.t. No DOM.
//
// One hand points (pointerHand, set by the view); the other is the control hand. Readings of the
// control hand become level signals (fist, open) and an edge signal (count); a hand held open above
// its own shoulder is the "raised" signal (used to choose the pointer hand); a short deliberate
// blink of both eyes is the blink edge.

const MIN_VIS = 0.3;            // pose shoulders less visible than this are ignored
const EXT_TIP = 1.6;            // finger extended: dist(tip, wrist) > EXT_TIP * dist(mcp, wrist)...
const EXT_THUMB = 0.8;          // thumb extended: dist(tip 4, mcp 5) > EXT_THUMB * dist(wrist, mcp 5)
const FIST_MS = 300;            // control-hand fist held this long
const MAX_MISSES = 2;           // consecutive missing / "other" frames tolerated before a timer resets
const BLINK_CLOSED = 0.5;       // both eyes' blink score at or above this = closed
const BLINK_OPEN = 0.3;         // both below this = open
const FINGERS = [               // [name, tip, pip, mcp]
  ["index", 8, 6, 5],
  ["middle", 12, 10, 9],
  ["ring", 16, 14, 13],
  ["pinky", 20, 18, 17],
];
const SHOULDER = { left: 11, right: 12 };

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// One hand's reading, or null when its landmarks are unusable. Pure.
export function readHand(hand, frame) {
  const l = hand?.landmarks;
  if (!l || l.length < 21 || l.some((p) => !p)) return null;
  const W = frame.width || 1, H = frame.height || 1;
  const P = (i) => ({ x: l[i].x * W, y: l[i].y * H });
  const wrist = P(0);
  const extended = {};
  let degenerate = false;
  for (const [name, tip, pip, mcp] of FINGERS) {
    const dt = dist(P(tip), wrist), dm = dist(P(mcp), wrist);
    if (dm < 1e-6) degenerate = true;
    extended[name] = dt > EXT_TIP * dm && dt > dist(P(pip), wrist);
  }
  const palm = dist(wrist, P(5));
  if (palm < 1e-6) degenerate = true;
  extended.thumb = dist(P(4), P(5)) > EXT_THUMB * palm;
  const four = FINGERS.filter(([n]) => extended[n]).length;
  const fingers = four + (extended.thumb ? 1 : 0);
  let shape;
  if (degenerate) shape = "other";
  else if (four === 0) shape = "fist";
  else if (four === 4 && extended.thumb) shape = "open";   // thumb out: open palm; thumb tucked: a count of 4
  else if (four === 1 && extended.index) shape = "point";
  else shape = "count";
  // Raised: open and the wrist above the user's own shoulder (image y grows downward).
  const s = frame.pose?.landmarks?.[SHOULDER[hand.side]];
  const raised = shape === "open" && !!s && (s.v ?? 1) >= MIN_VIS && l[0].y < s.y;
  return { fingers, extended, shape, raised };
}

// The same reading on every update, tolerating up to MAX_MISSES consecutive missing frames.
// feed(r, t): r === null is a missing / "other" frame; r === false means "definitely not" (resets).
function steady() {
  let value = null, since = 0, misses = 0;
  return {
    feed(r, t) {
      if (r === null) {
        if (value !== null && misses < MAX_MISSES) misses++;
        else { value = null; misses = 0; }
      } else if (r === false) { value = null; misses = 0; }
      else if (r === value) misses = 0;
      else { value = r; since = t; misses = 0; this.fired = false; }
    },
    held(t, ms) { return value !== null && t - since >= ms; },
    get value() { return value; },
    get since() { return since; },
    fired: false,
    reset() { value = null; since = 0; misses = 0; this.fired = false; },
  };
}

export function createGestures({ holdMs = 600, openMs = 1000, blinkMinMs = 60, blinkMaxMs = 700 } = {}) {
  const raisedT = { left: steady(), right: steady() };
  const countT = steady(), fistT = steady(), openT = steady();
  let controlSide = null;
  // blink: "unknown" until both eyes are seen open, then "open" <-> "closed"
  let eyes = "unknown", closedSince = 0, faceMisses = 0;

  function resetControl() { countT.reset(); fistT.reset(); openT.reset(); }

  function blinkStep(frame, t) {
    const b = frame.face?.blink;
    if (!b || !Number.isFinite(b.left) || !Number.isFinite(b.right)) {
      if (++faceMisses > MAX_MISSES) eyes = "unknown";
      return false;
    }
    faceMisses = 0;
    const closed = b.left >= BLINK_CLOSED && b.right >= BLINK_CLOSED;
    const open = b.left < BLINK_OPEN && b.right < BLINK_OPEN;
    if (eyes === "closed" && open) {
      const d = t - closedSince;
      eyes = "open";
      return d >= blinkMinMs && d <= blinkMaxMs;
    }
    if (eyes !== "closed" && open) eyes = "open";
    else if (eyes === "open" && closed) { eyes = "closed"; closedSince = t; }
    return false;
  }

  function update(frame, { pointerHand = null } = {}) {
    const t = frame?.t ?? 0;
    const hands = { left: null, right: null };
    const best = { left: -Infinity, right: -Infinity };
    for (const h of frame?.hands || []) {
      if (h?.side !== "left" && h?.side !== "right") continue;
      const score = h.score ?? 1;
      if (score <= best[h.side]) continue;
      const r = readHand(h, frame);
      if (r) { hands[h.side] = r; best[h.side] = score; }
    }

    // raised: per side, level
    let raised = null;
    for (const side of ["left", "right"]) {
      const r = hands[side];
      raisedT[side].feed(!r || r.shape === "other" ? null : r.raised ? true : false, t);
      if (raisedT[side].held(t, holdMs) && (!raised || raisedT[side].since < raisedT[raised].since)) raised = side;
    }

    // control hand
    const side = pointerHand === "left" ? "right" : pointerHand === "right" ? "left" : null;
    if (side !== controlSide) { controlSide = side; resetControl(); }
    const c = side ? hands[side] : null;
    const control = c ? { ...c, side } : null;
    const miss = !c || c.shape === "other";
    const n = c ? ["index", "middle", "ring", "pinky"].filter((k) => c.extended[k]).length : 0;
    countT.feed(miss ? null : n > 0 && c.shape !== "open" ? n : false, t);   // an open palm is "release", never a count
    fistT.feed(miss ? null : c.shape === "fist" ? true : false, t);
    openT.feed(miss ? null : c.shape === "open" ? true : false, t);
    let count = null;
    if (side && countT.held(t, holdMs) && !countT.fired) { countT.fired = true; count = countT.value; }

    return {
      hands,
      control,
      raised,
      count,
      fist: !!side && fistT.held(t, FIST_MS),
      open: !!side && openT.held(t, openMs),
      blink: blinkStep(frame || {}, t),
    };
  }

  function reset() {
    raisedT.left.reset(); raisedT.right.reset(); resetControl();
    controlSide = null; eyes = "unknown"; closedSince = 0; faceMisses = 0;
  }

  return { update, reset };
}
