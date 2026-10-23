// Live mode, workstream C: which body segment is the user pointing at?
// Pure functions of a tracker frame (see src/live/CONTRACTS.md, section 3). No DOM.
import { CONFIG } from "../config.js";

const MIN_VIS = 0.3;            // landmarks less visible than this are ignored
const LIMB_RADIUS = 0.35;       // contact radius, in shoulder widths
const EXTENDED = 1.1;           // fingertip-to-palm distance / hand size for an extended finger
const STABLE_MS = 400;
const VOTE_FRAMES = 8;
const NULL_RESET_MS = 200;      // this long without a hit forgets the history
const CENTRE_FRAC = 0.4;        // |offset| below this many radii counts as "on the front/back surface"
const MODEL_ALIAS = { arm: "upper-limb" };   // segments.json says "arm", CONFIG.models says "upper-limb"
const OWN_ARM = ["upper_arm", "forearm", "hand"]; // never the target of the hand that is pointing

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// loadJson / config are injectable so the Node unit test can run without a browser.
export async function createPointer({ segmentsUrl = "assets/live/segments.json", loadJson = fetchJson, config = CONFIG } = {}) {
  const data = await loadJson(segmentsUrl);
  const segments = data.segments;
  const models = {};
  for (const name of new Set(Object.values(segments).map((s) => s.model))) {
    const cfg = config.models[MODEL_ALIAS[name] || name];
    if (!cfg) throw new Error(`pointing: unknown model "${name}"`);
    const j = await loadJson(cfg.structuresUrl);
    const layers = new Map();
    for (const n of j.nodes || []) if (!layers.has(n.structure)) layers.set(n.structure, n.layer);
    models[name] = { structures: j.structures || {}, regions: j.regions || {}, regionLabels: j.regionLabels || {}, layers };
  }

  // --- smoothing state ---
  let history = [];             // last VOTE_FRAMES entries: { key, res } or null
  let lastKey = null, keyStart = 0, nullSince = null;
  let last = null;              // last result, used by outline() to pick a side

  // ---- geometry (pixel space, so a non-square frame does not skew distances) ----
  function scaleOf(frame) { return { W: frame.width || 1, H: frame.height || 1 }; }
  function pxPoint(lm, sc) { return { x: lm.x * sc.W, y: lm.y * sc.H }; }
  function point(spec, lms, sc) {      // landmark index, or the mean of a list of indices
    const idx = Array.isArray(spec) ? spec : [spec];
    let x = 0, y = 0;
    for (const i of idx) {
      const l = lms[i];
      if (!l || (l.v ?? 1) < MIN_VIS) return null;
      x += l.x * sc.W; y += l.y * sc.H;
    }
    return { x: x / idx.length, y: y / idx.length };
  }
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  function headEllipse(seg, lms, sc) {
    const e1 = point(7, lms, sc), e2 = point(8, lms, sc);
    const eyes = point([1, 2, 3, 4, 5, 6], lms, sc), mouth = point([9, 10], lms, sc);
    if (!e1 || !e2 || !eyes || !mouth) return null;
    const D = dist(e1, e2);
    const top = eyes.y - seg.shape.top * D, bottom = mouth.y + seg.shape.chin * D;
    const cx = (e1.x + e2.x) / 2, cy = (top + bottom) / 2, rx = 0.6 * D, ry = (bottom - top) / 2;
    const pts = [];
    for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2; pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }); }
    return { poly: pts, top, bottom };
  }

  // The geometry of one segment on one side, or null when its landmarks are not visible.
  function instance(id, seg, side, lms, sc) {
    const i = side === "left" ? 0 : 1;
    if (seg.shape?.kind === "head") {
      const h = headEllipse(seg, lms, sc);
      return h && { id, seg, side: null, kind: "poly", poly: h.poly, top: h.top, bottom: h.bottom };
    }
    if (seg.poly) {
      const poly = seg.poly.map((k) => point(k, lms, sc));
      if (poly.some((p) => !p)) return null;
      return { id, seg, side: null, kind: "poly", poly, axis: [mid(poly[0], poly[1]), mid(poly[2], poly[3])] };
    }
    const a = point(seg.line ? seg.line[0] : seg.from[i], lms, sc);
    const b = point(seg.line ? seg.line[1] : seg.to[i], lms, sc);
    if (!a || !b || dist(a, b) < 1e-6) return null;
    return { id, seg, side: seg.midline ? null : side, kind: "capsule", a, b };
  }
  const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });

  function instances(frame) {
    const lms = frame.pose?.landmarks;
    if (!lms || lms.length < 33) return null;
    const sc = scaleOf(frame);
    const ls = point(11, lms, sc), rs = point(12, lms, sc);
    if (!ls || !rs) return null;
    const sw = dist(ls, rs);
    if (sw < 1e-6) return null;
    const out = [];
    for (const [id, seg] of Object.entries(segments)) {
      for (const side of seg.midline ? [null] : ["left", "right"]) {
        const inst = instance(id, seg, side, lms, sc);
        if (inst) { inst.radius = (seg.radius ?? LIMB_RADIUS) * sw; out.push(inst); }
      }
    }
    // Un-mirrored image: a person facing the camera shows their LEFT shoulder (11) on the image
    // RIGHT (larger x), because their left is the camera's right. So x11 > x12 means we see the front;
    // x11 < x12 means the person turned their back to the camera.
    const facing = lms[11].x >= lms[12].x ? "front" : "back";
    return { list: out, sc, sw, facing, midX: (ls.x + rs.x) / 2 };
  }

  // ---- finger test ----
  function pointingTip(hand, sc) {
    const l = hand.landmarks;
    if (!l || l.length < 21) return null;
    const P = (i) => pxPoint(l[i], sc);
    const centre = { x: 0, y: 0 };
    for (const i of [0, 5, 9, 13, 17]) { centre.x += P(i).x / 5; centre.y += P(i).y / 5; }
    const size = dist(P(0), P(9));
    if (size < 1e-6) return null;
    const ext = (tip) => dist(P(tip), centre) / size;
    if (ext(8) < EXTENDED) return null;
    const others = [12, 16, 20].filter((t) => ext(t) >= EXTENDED).length;
    if (others > 1) return null;           // an open hand is not pointing
    return { x: l[8].x, y: l[8].y, px: P(8) };
  }

  function maskHit(frame, tip) {
    const m = frame.pose?.mask;
    if (!m || !m.data) return true;
    const x = Math.min(m.width - 1, Math.max(0, Math.floor(tip.x * m.width)));
    const y = Math.min(m.height - 1, Math.max(0, Math.floor(tip.y * m.height)));
    return m.data[y * m.width + x] > 127;
  }

  // The best contact of one tip against every segment: { inst, score, frac, aspect, band... } or null.
  function contact(ctx, tip, ownSide) {
    let best = null;
    for (const inst of ctx.list) {
      if (ownSide && inst.side === ownSide && OWN_ARM.includes(inst.id)) continue;
      let score, frac, off = 0, closest = null;
      if (inst.kind === "poly") {
        if (!pointInPoly(tip.px, inst.poly)) continue;
        score = 0.5;                       // a limb whose axis is within half a radius beats the trunk behind it
        if (inst.axis) {
          const [p, q] = inst.axis, dx = q.x - p.x, dy = q.y - p.y;
          frac = ((tip.px.x - p.x) * dx + (tip.px.y - p.y) * dy) / (dx * dx + dy * dy);
        } else frac = (tip.px.y - inst.top) / (inst.bottom - inst.top);
      } else {
        const dx = inst.b.x - inst.a.x, dy = inst.b.y - inst.a.y, len2 = dx * dx + dy * dy;
        const t = Math.min(1, Math.max(0, ((tip.px.x - inst.a.x) * dx + (tip.px.y - inst.a.y) * dy) / len2));
        closest = { x: inst.a.x + t * dx, y: inst.a.y + t * dy };
        const d = dist(tip.px, closest);
        if (d > inst.radius) continue;
        score = d / inst.radius;
        frac = t;
        off = ((tip.px.x - inst.a.x) * dy - (tip.px.y - inst.a.y) * dx) / Math.sqrt(len2);   // signed, pixels
      }
      frac = Math.min(1, Math.max(0, frac));
      if (!best || score < best.score) best = { inst, score, frac, off, closest, tip: tip.px };
    }
    return best;
  }

  // front/back when the tip is near the limb's axis (we look at one surface); otherwise the
  // flank: "inner" toward the body midline, "outer" away from it.
  function aspectOf(ctx, c) {
    const { inst } = c;
    if (inst.kind === "poly") return ctx.facing;
    if (Math.abs(c.off) <= CENTRE_FRAC * inst.radius) return ctx.facing;
    if (inst.seg.midline) return "outer";
    return Math.abs(c.tip.x - ctx.midX) < Math.abs(c.closest.x - ctx.midX) ? "inner" : "outer";
  }

  function bandOf(seg, frac) {
    return seg.bands.find((b) => frac >= b.frac[0] && frac <= b.frac[1]) || seg.bands[seg.bands.length - 1];
  }
  const pick = (v, aspect, facing) => (v && typeof v === "object" && !Array.isArray(v) ? (v[aspect] ?? v[facing] ?? v.default ?? Object.values(v)[0]) : v);

  function build(frame, ctx, c, tip, hand) {
    const { inst } = c;
    const seg = inst.seg, model = models[seg.model];
    const aspect = aspectOf(ctx, c);
    const band = bandOf(seg, c.frac);
    const back = ctx.facing === "back" && band.backRegion;
    const regionKey = back ? band.backRegion : pick(band.region, aspect, ctx.facing);
    let label = back ? (band.backLabel || band.label) : pick(band.label, aspect, ctx.facing);
    label = label || model.regionLabels[regionKey] || seg.label;
    if (inst.side) label = `${cap(inst.side)} ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
    const keys = [];
    const seen = new Set();
    const add = (k) => { if (model.structures[k] !== undefined && !seen.has(k)) { seen.add(k); keys.push(k); } };
    const head = band.headline || seg.headline || {};
    (head[aspect] || head[ctx.facing] || Object.values(head)[0] || []).forEach(add);
    (model.regions[regionKey] || []).forEach(add);
    return {
      key: `${inst.id}|${inst.side}|${regionKey}`,
      res: {
        hand,
        tip: { x: tip.x, y: tip.y },
        segment: inst.id,
        side: inst.side,
        frac: c.frac,
        facing: ctx.facing,
        aspect,
        region: { model: seg.model, key: regionKey, label },
        structures: keys.map((k) => ({ key: k, name: model.structures[k], layer: model.layers.get(k) || "other" })),
        stable: false,
      },
    };
  }

  function candidate(frame) {
    const ctx = instances(frame);
    if (!ctx) return null;
    let best = null;
    for (const hand of frame.hands || []) {
      const tip = pointingTip(hand, ctx.sc);
      if (!tip || tip.x < 0 || tip.x > 1 || tip.y < 0 || tip.y > 1 || !maskHit(frame, tip)) continue;
      const c = contact(ctx, tip, hand.side);
      if (c) {
        if (!best || c.score < best.c.score) best = { c, tip, hand: hand.side };
      }
    }
    if (!best) return null;
    return build(frame, ctx, best.c, best.tip, best.hand);
  }

  function update(frame) {
    const t = frame.t ?? 0;
    const cur = candidate(frame);
    history.push(cur);
    if (history.length > VOTE_FRAMES) history.shift();
    if (!cur) {
      if (nullSince === null) nullSince = t;
      if (t - nullSince > NULL_RESET_MS) { history = []; lastKey = null; }
      return null;
    }
    nullSince = null;
    // Plurality vote over the recent frames; the current frame wins ties.
    const counts = new Map();
    for (const h of history) if (h) counts.set(h.key, (counts.get(h.key) || 0) + 1);
    let winner = cur.key;
    for (const [k, n] of counts) if (n > counts.get(winner)) winner = k;
    const entry = [...history].reverse().find((h) => h && h.key === winner);
    if (winner !== lastKey) { lastKey = winner; keyStart = t; }
    last = { ...entry.res, tip: cur.res.tip, stable: t - keyStart >= STABLE_MS };
    return last;
  }

  // The polygon for the overlay. segmentId may be "forearm", "forearm:left" or take a third argument.
  function outline(frame, segmentId, sideArg) {
    let [id, side] = String(segmentId).split(":");
    side = sideArg || side || (last && last.segment === id && last.side) || "right";
    const seg = segments[id];
    const lms = frame.pose?.landmarks;
    if (!seg || !lms) return [];
    const sc = scaleOf(frame);
    const inst = instance(id, seg, side, lms, sc);
    if (!inst) return [];
    const toImg = (p) => ({ x: p.x / sc.W, y: p.y / sc.H });
    if (inst.kind === "poly") return inst.poly.map(toImg);
    const ctx = instances(frame);
    const r = (seg.radius ?? LIMB_RADIUS) * (ctx ? ctx.sw : 0);
    const ang = Math.atan2(inst.b.y - inst.a.y, inst.b.x - inst.a.x);
    const pts = [];
    for (let i = 0; i < 6; i++) { const a = ang - Math.PI / 2 + (i * Math.PI) / 5; pts.push({ x: inst.b.x + r * Math.cos(a), y: inst.b.y + r * Math.sin(a) }); }
    for (let i = 0; i < 6; i++) { const a = ang + Math.PI / 2 + (i * Math.PI) / 5; pts.push({ x: inst.a.x + r * Math.cos(a), y: inst.a.y + r * Math.sin(a) }); }
    return pts.map(toImg);
  }

  return { update, outline, reset() { history = []; lastKey = null; nullSince = null; last = null; } };
}
