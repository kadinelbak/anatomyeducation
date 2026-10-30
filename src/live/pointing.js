// Live mode, workstream C: which body segment is the user pointing at?
// A function of tracker frames plus internal smoothing / lock state (see src/live/CONTRACTS.md,
// section 3). No DOM.
//
// Coarse then fine: the selection is a segment instance (segment id + side). It is chosen with
// a generous contact radius, hysteresis and a plurality vote, and then locked after LOCK_MS.
// Bands, frac, aspect and structures are refinement computed from the fingertip every frame and
// never change which segment is selected.
import { CONFIG } from "../config.js";

const MIN_VIS = 0.3;            // landmarks less visible than this are ignored
const LIMB_RADIUS = 0.35;       // default limb radius (half-width), in shoulder widths
const SEEK = 1.4;               // contact radius while seeking, in segment radii
const HOLD = 1.3;               // the leader keeps the lead out to HOLD * SEEK radii
const SWITCH = 0.6;             // a challenger must score below SWITCH * the leader's distance...
const SWITCH_MARGIN = 0.15;     // ...and at least this much lower (near-zero distances are noise)
const RESTING = 0.5;            // ranking penalty for a hanging arm's finger on its own thigh / leg
const HANGING = 0.87;           // an arm hangs when both its bones are within 30 degrees of straight down
const POLY_INSIDE = 0.5;        // normalised distance for a tip inside the trunk / head polygon
const EXTENDED = 1.1;           // fingertip-to-palm distance / hand size for an extended finger
const VOTE_FRAMES = 8;
const LOCK_MS = 900;            // the same coarse key leading this long locks it
const UNLOCK_MS = 1500;         // this long without any pointing candidate releases a lock
const HIP_DROP = 1.25;          // hips out of view (seated at a desk): hip joints sit this many shoulder widths below the shoulders
const HIP_HALF = 0.3;           // ...and this many shoulder widths either side of the trunk's midline
const RETARGET_MS = 1500;       // locked, but a different segment leads this long: release so it can lock
const NULL_RESET_MS = 200;      // (unlocked) this long without a hit forgets the history
const DEPTH_TOL = 0.6;          // pose index tip this far (shoulder widths) nearer than the limb = in front
const INDEX_NEAR = 1.0;         // pose index tip must be within this many shoulder widths of the hand tip
const CENTRE_FRAC = 0.4;        // |offset| below this many radii counts as "on the front/back surface"
const CAL_SEGMENTS = ["upper_arm", "forearm", "thigh", "leg"];
const CAL_MIN_SAMPLES = 10;
const STANCE_OUT = 1.1;         // calibration: |wrist x - shoulder x| above this many shoulder widths
const STANCE_LEVEL = 0.5;       // calibration: |wrist y - shoulder y| below this many shoulder widths
const MODEL_ALIAS = { arm: "upper-limb" };   // segments.json says "arm", CONFIG.models says "upper-limb"
const OWN_ARM = ["upper_arm", "forearm", "hand"]; // never the target of the hand that is pointing

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const keyOf = (id, side) => `${id}|${side}`;
function median(xs) {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

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

  // --- smoothing / lock state ---
  let history = [];             // last VOTE_FRAMES entries: { key, res } or null
  let leaderKey = null, leadStart = 0, nullSince = null;
  let locked = false, lockedKey = null, lastCandT = 0, lastT = 0;
  let lockGeom = null;   // hard lock: { ctx, inst } from the last frame the locked segment was seen, so the finger
                         // still scrubs it on frames where the pose model loses the body (very close, or off frame)
  let awaySince = null;        // locked, and the finger has led a different segment since this time
  let hardLock = false;        // when set, a lock only ends with unlock(): no grace-period or retarget release
  let last = null;              // last result
  let calibration = null;
  let pointerHand = null;       // "left" | "right" | null: when set, only that hand may point

  const defaultRadius = (id) => segments[id]?.radius ?? LIMB_RADIUS;
  const radiusOf = (id) => calibration?.radii?.[id] ?? defaultRadius(id);
  function coarseLabel(id, side) {
    const l = segments[id]?.label || id;
    return side ? `${cap(side)} ${l.charAt(0).toLowerCase()}${l.slice(1)}` : l;
  }

  // ---- geometry (pixel space, so a non-square frame does not skew distances) ----
  function scaleOf(frame) { return { W: frame.width || 1, H: frame.height || 1 }; }
  function pxPoint(lm, sc) { return { x: lm.x * sc.W, y: lm.y * sc.H }; }
  function point(spec, lms, sc) {      // landmark index, or the mean of a list of indices; z stays normalised
    const idx = Array.isArray(spec) ? spec : [spec];
    let x = 0, y = 0, z = 0;
    for (const i of idx) {
      const l = lms[i];
      if (!l || (l.v ?? 1) < MIN_VIS) return null;
      x += l.x * sc.W; y += l.y * sc.H; z += Number.isFinite(l.z) ? l.z : NaN;
    }
    return { x: x / idx.length, y: y / idx.length, z: z / idx.length };
  }
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  function segDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function polyEdgeDist(p, poly) {
    let d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, segDist(p, poly[j], poly[i]));
    return d;
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
  function meanZ(indices, lms) {
    let z = 0;
    for (const i of indices.flat()) z += Number.isFinite(lms[i]?.z) ? lms[i].z : NaN;
    return z / indices.flat().length;
  }

  // The geometry of one segment on one side, or null when its landmarks are not visible.
  function instance(id, seg, side, lms, sc) {
    const i = side === "left" ? 0 : 1;
    if (seg.shape?.kind === "head") {
      const h = headEllipse(seg, lms, sc);
      return h && { id, seg, side: null, kind: "poly", poly: h.poly, top: h.top, bottom: h.bottom, z: meanZ(seg.poly || [0], lms) };
    }
    if (seg.poly) {
      const poly = seg.poly.map((k) => point(k, lms, sc));
      if (poly.some((p) => !p)) return null;
      return { id, seg, side: null, kind: "poly", poly, axis: [mid(poly[0], poly[1]), mid(poly[2], poly[3])], z: meanZ(seg.poly, lms) };
    }
    const a = point(seg.line ? seg.line[0] : seg.from[i], lms, sc);
    const b = point(seg.line ? seg.line[1] : seg.to[i], lms, sc);
    if (!a || !b || dist(a, b) < 1e-6) return null;
    return { id, seg, side: seg.midline ? null : side, kind: "capsule", a, b };
  }

  function instances(frame) {
    const lms = frame.pose?.landmarks;
    if (!lms || lms.length < 33) return null;
    const sc = scaleOf(frame);
    const ls = point(11, lms, sc), rs = point(12, lms, sc);
    if (!ls || !rs) return null;
    const sw = dist(ls, rs);
    if (sw < 1e-6) return null;
    // Seated at a desk, the camera sees the shoulders but not the hips, and the trunk zone would vanish with
    // them. Estimate the hip joints from the shoulder line instead (pixel space, so the frame's aspect ratio
    // does not skew the drop), and use them for the trunk only; the legs still need real hips.
    let lmsTrunk = lms, hipsEstimated = false;
    if (!point(23, lms, sc) || !point(24, lms, sc)) {
      const ux = (ls.x - rs.x) / sw, uy = (ls.y - rs.y) / sw;          // unit vector along the shoulders, 12 -> 11
      let px = -uy, py = ux; if (py < 0) { px = -px; py = -py; }       // its perpendicular, pointing down the image
      const mx = (ls.x + rs.x) / 2 + px * HIP_DROP * sw, my = (ls.y + rs.y) / 2 + py * HIP_DROP * sw;
      const hip = (k) => ({ x: (mx + k * ux * HIP_HALF * sw) / sc.W, y: (my + k * uy * HIP_HALF * sw) / sc.H, z: ls.z, v: 1 });
      lmsTrunk = lms.slice(); lmsTrunk[23] = hip(1); lmsTrunk[24] = hip(-1);
      hipsEstimated = true;
    }
    const out = [];
    for (const [id, seg] of Object.entries(segments)) {
      for (const side of seg.midline ? [null] : ["left", "right"]) {
        if (pointerHand && side === pointerHand && OWN_ARM.includes(id)) continue;   // the pointing arm is never a zone
        const inst = instance(id, seg, side, id === "trunk" ? lmsTrunk : lms, sc);
        if (inst) { inst.radius = radiusOf(id) * sw; inst.key = keyOf(inst.id, inst.side); out.push(inst); }
      }
    }
    // Un-mirrored image: a person facing the camera shows their LEFT shoulder (11) on the image
    // RIGHT (larger x), because their left is the camera's right. So x11 > x12 means we see the front;
    // x11 < x12 means the person turned their back to the camera.
    const facing = lms[11].x >= lms[12].x ? "front" : "back";
    // Depth is usable only when the model filled it in (synthetic fixtures have z = 0 everywhere).
    const hasZ = lms.some((l) => Number.isFinite(l?.z) && l.z !== 0);
    const swN = Math.hypot(lms[11].x - lms[12].x, lms[11].y - lms[12].y);   // shoulder width, normalised units
    // A hand at the end of a hanging arm, with its index lying on the thigh, is resting, not pointing.
    const down = (p, q) => p && q && q.y > p.y && (q.y - p.y) / Math.max(dist(p, q), 1e-6) > HANGING;
    const hanging = {};
    for (const [side, [s, e, w]] of [["left", [11, 13, 15]], ["right", [12, 14, 16]]]) {
      const S = point(s, lms, sc), E = point(e, lms, sc), Wr = point(w, lms, sc);
      hanging[side] = !!(down(S, E) && down(E, Wr));
    }
    return { list: out, sc, sw, swN, hasZ, lms, facing, hanging, hipsEstimated, midX: (ls.x + rs.x) / 2 };
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

  // The contact of one tip with one segment instance, at any distance:
  // { inst, key, norm (distance / radius), rank (norm, plus RESTING for a hanging hand on its own
  //   leg), frac, off, closest, z (limb depth), tip, hand }.
  function contactWith(ctx, inst, tip, hand) {
    let norm, frac, off = 0, closest = null, z = inst.z;
    if (inst.kind === "poly") {
      norm = pointInPoly(tip.px, inst.poly) ? POLY_INSIDE : 1 + polyEdgeDist(tip.px, inst.poly) / (LIMB_RADIUS * ctx.sw);
      if (inst.axis) {
        const [p, q] = inst.axis, dx = q.x - p.x, dy = q.y - p.y;
        frac = ((tip.px.x - p.x) * dx + (tip.px.y - p.y) * dy) / (dx * dx + dy * dy);
      } else frac = (tip.px.y - inst.top) / (inst.bottom - inst.top);
    } else {
      const dx = inst.b.x - inst.a.x, dy = inst.b.y - inst.a.y, len2 = dx * dx + dy * dy;
      const t = clamp(((tip.px.x - inst.a.x) * dx + (tip.px.y - inst.a.y) * dy) / len2, 0, 1);
      closest = { x: inst.a.x + t * dx, y: inst.a.y + t * dy };
      norm = dist(tip.px, closest) / inst.radius;
      frac = t;
      off = ((tip.px.x - inst.a.x) * dy - (tip.px.y - inst.a.y) * dx) / Math.sqrt(len2);   // signed, pixels
      z = inst.a.z + t * (inst.b.z - inst.a.z);
    }
    const rank = norm + (ctx.hanging[hand] && inst.side === hand && (inst.id === "thigh" || inst.id === "leg") ? RESTING : 0);
    return { inst, key: inst.key, norm, rank, frac: clamp(frac, 0, 1), off, closest, z, tip, hand };
  }

  // Depth hint: the pose model's own index fingertip (19 left, 20 right) carries z in the body's
  // frame. A fingertip clearly nearer the camera than the limb at the contact point is in front of it.
  function depthOk(ctx, c) {
    if (!ctx.hasZ || !c.hand || !Number.isFinite(c.z)) return true;
    const p = ctx.lms[c.hand === "left" ? 19 : 20];
    if (!p || !Number.isFinite(p.z) || (p.v ?? 1) < MIN_VIS) return true;
    if (dist(pxPoint(p, ctx.sc), c.tip.px) > INDEX_NEAR * ctx.sw) return true;   // not the same finger
    return !(c.z - p.z > DEPTH_TOL * ctx.swN);
  }

  // Every usable contact of every pointing tip in the frame (no distance limit yet).
  function contacts(frame, ctx) {
    const all = [];
    let tips = 0;
    for (const hand of frame.hands || []) {
      if (pointerHand && hand.side !== pointerHand) continue;   // the control hand never points
      const tip = pointingTip(hand, ctx.sc);
      if (!tip || tip.x < 0 || tip.x > 1 || tip.y < 0 || tip.y > 1 || !maskHit(frame, tip)) continue;
      tips++;
      for (const inst of ctx.list) {
        if (hand.side && inst.side === hand.side && OWN_ARM.includes(inst.id)) continue;
        const c = contactWith(ctx, inst, tip, hand.side);
        if (c.norm <= SEEK * HOLD && depthOk(ctx, c)) all.push(c);
      }
    }
    return { all, tips };
  }
  const bestOf = (list) => list.reduce((b, c) => (!b || c.rank < b.rank ? c : b), null);

  // Hard lock: the pointing hand's index tip against the locked segment only, with none of the
  // seek-time filters, so moving the finger keeps stepping through the scan.
  // Hard lock: the pointing hand's index tip scrubs the locked segment from wherever it is, whatever
  // its shape, the person mask or the depth hint say, and however far from the segment it has wandered.
  // `ctx` may be null (no pose this frame): the segment's last seen geometry is used instead.
  function follow(frame, ctx) {
    const out = [];
    let hands = (frame.hands || []).filter((h) => !pointerHand || h.side === pointerHand);
    // The hand detector can mislabel a hand that crosses the body. With the pointing hand's label missing,
    // take the hand whose index tip is nearest the last pointed spot.
    if (!hands.length && last?.tip && frame.hands?.length) {
      const d = (h) => { const p = h.landmarks?.[8]; return p ? Math.hypot(p.x - last.tip.x, p.y - last.tip.y) : Infinity; };
      const near = frame.hands.reduce((b, h) => (d(h) < d(b) ? h : b));
      if (d(near) < 0.15) hands = [near];
    }
    let insts = ctx ? ctx.list.filter((inst) => inst.key === lockedKey) : [];
    let useCtx = ctx;
    if (!insts.length && lockGeom) { insts = [lockGeom.inst]; useCtx = lockGeom.ctx; }
    if (!useCtx) return null;
    for (const hand of hands) {
      const l8 = hand.landmarks?.[8];
      if (!l8 || l8.x < 0 || l8.x > 1 || l8.y < 0 || l8.y > 1) continue;
      const tip = { x: l8.x, y: l8.y, px: pxPoint(l8, useCtx.sc) };
      for (const inst of insts) out.push(contactWith(useCtx, inst, tip, hand.side));
    }
    const best = bestOf(out);
    return best ? { c: best, ctx: useCtx } : null;
  }

  // Coarse selection with hysteresis against the current leader: the leader keeps the lead while
  // it is within HOLD * SEEK radii, unless a challenger is clearly better.
  function select(all, leader) {
    const best = bestOf(all.filter((c) => c.norm <= SEEK));
    const lead = leader && bestOf(all.filter((c) => c.key === leader));   // already within SEEK * HOLD
    if (!lead || !best || best.key === leader) return lead || best;
    const clearly = best.rank < SWITCH * lead.rank && lead.rank - best.rank > SWITCH_MARGIN;
    return clearly ? best : lead;
  }

  // front/back when the tip is near the limb's axis (we look at one surface); otherwise the
  // flank: "inner" toward the body midline, "outer" away from it.
  function aspectOf(ctx, c) {
    const { inst } = c;
    if (inst.kind === "poly") return ctx.facing;
    if (Math.abs(c.off) <= CENTRE_FRAC * inst.radius) return ctx.facing;
    if (inst.seg.midline) return "outer";
    return Math.abs(c.tip.px.x - ctx.midX) < Math.abs(c.closest.x - ctx.midX) ? "inner" : "outer";
  }

  function bandOf(seg, frac) {
    return seg.bands.find((b) => frac >= b.frac[0] && frac <= b.frac[1]) || seg.bands[seg.bands.length - 1];
  }
  const pick = (v, aspect, facing) => (v && typeof v === "object" && !Array.isArray(v) ? (v[aspect] ?? v[facing] ?? v.default ?? Object.values(v)[0]) : v);

  // The fine result for a contact.
  function build(ctx, c) {
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
      hand: c.hand,
      tip: { x: c.tip.x, y: c.tip.y },
      segment: inst.id,
      side: inst.side,
      coarse: { segment: inst.id, side: inst.side, label: coarseLabel(inst.id, inst.side) },
      frac: c.frac,
      facing: ctx.facing,
      aspect,
      region: { model: seg.model, key: regionKey, label },
      structures: keys.map((k) => ({ key: k, name: model.structures[k], layer: model.layers.get(k) || "other" })),
      progress: 0,
      locked: false,
      stable: false,
      onSegment: true,                      // this frame's tip refined frac (false on locked frames that reuse the last result)
      bodySeen: true,                       // the pose gave a body to measure against (false on locked frames without one)
      hipsEstimated: !!ctx.hipsEstimated,   // the trunk zone used hips estimated from the shoulders
    };
  }
  const finish = (res, progress) => ({ ...res, progress, locked, stable: locked });

  function forget() { history = []; leaderKey = null; nullSince = null; }
  function doUnlock() {
    locked = false; lockedKey = null; awaySince = null; lockGeom = null;
    forget();
    if (last) last = { ...last, progress: 0, locked: false, stable: false };
  }
  function doLock(key) {
    locked = true; lockedKey = key; lastCandT = lastT;
    if (last) last = { ...last, progress: 1, locked: true, stable: true };
  }

  function update(frame) {
    const t = frame.t ?? 0;
    lastT = t;
    const ctx = instances(frame);
    const { all } = ctx ? contacts(frame, ctx) : { all: [] };
    const sel = select(all, locked ? lockedKey : leaderKey);
    if (sel) lastCandT = t;
    if (!sel || !locked || sel.key === lockedKey) awaySince = null;
    else if (awaySince === null) awaySince = t;

    if (locked) {
      const away = !hardLock && awaySince !== null && t - awaySince > RETARGET_MS;
      if (!away && (hardLock || sel || t - lastCandT <= UNLOCK_MS)) {
        // Segment and side are frozen; refine frac / band / aspect when the tip is on the locked segment.
        let on = ctx ? bestOf(all.filter((c) => c.key === lockedKey)) : null, onCtx = ctx;
        if (on) lockGeom = { ctx, inst: on.inst };
        else if (hardLock) { const f = follow(frame, ctx); if (f) { on = f.c; onCtx = f.ctx; if (ctx && ctx.list.includes(on.inst)) lockGeom = { ctx, inst: on.inst }; } }
        last = on ? { ...finish(build(onCtx, on), 1), bodySeen: !!ctx } : { ...last, tip: sel ? { x: sel.tip.x, y: sel.tip.y } : last.tip, onSegment: false, bodySeen: !!ctx };
        return last;
      }
      doUnlock();
    }

    history.push(sel ? { key: sel.key, res: build(ctx, sel) } : null);
    if (history.length > VOTE_FRAMES) history.shift();
    if (!sel) {
      if (nullSince === null) nullSince = t;
      if (t - nullSince > NULL_RESET_MS) forget();
      return null;
    }
    nullSince = null;
    // Plurality vote over the recent frames on the coarse key; the current frame wins ties.
    const counts = new Map();
    for (const h of history) if (h) counts.set(h.key, (counts.get(h.key) || 0) + 1);
    let winner = sel.key;
    for (const [k, n] of counts) if (n > counts.get(winner)) winner = k;
    if (winner !== leaderKey) { leaderKey = winner; leadStart = t; }
    const progress = clamp((t - leadStart) / LOCK_MS, 0, 1);
    if (progress >= 1) { locked = true; lockedKey = winner; }
    // Refine from this frame's tip when it is on the winner; otherwise reuse the winner's last result.
    const on = winner === sel.key ? sel : bestOf(all.filter((c) => c.key === winner));
    const res = on ? build(ctx, on) : { ...[...history].reverse().find((h) => h && h.key === winner).res, tip: { x: sel.tip.x, y: sel.tip.y } };
    last = finish(res, progress);
    return last;
  }

  // ---- overlay geometry ----
  function polyOf(inst, sw, sc) {
    const toImg = (p) => ({ x: p.x / sc.W, y: p.y / sc.H });
    if (inst.kind === "poly") return inst.poly.map(toImg);
    const r = radiusOf(inst.id) * sw;
    const ang = Math.atan2(inst.b.y - inst.a.y, inst.b.x - inst.a.x);
    const pts = [];
    for (let i = 0; i < 6; i++) { const a = ang - Math.PI / 2 + (i * Math.PI) / 5; pts.push({ x: inst.b.x + r * Math.cos(a), y: inst.b.y + r * Math.sin(a) }); }
    for (let i = 0; i < 6; i++) { const a = ang + Math.PI / 2 + (i * Math.PI) / 5; pts.push({ x: inst.a.x + r * Math.cos(a), y: inst.a.y + r * Math.sin(a) }); }
    return pts.map(toImg);
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
    const ctx = instances(frame);
    return polyOf(inst, ctx ? ctx.sw : 0, sc);
  }

  // Every visible segment instance, for drawing the whole body map.
  function outlines(frame) {
    const ctx = instances(frame);
    if (!ctx) return [];
    return ctx.list.map((inst) => ({ id: inst.id, side: inst.side, label: coarseLabel(inst.id, inst.side), poly: polyOf(inst, ctx.sw, ctx.sc) }));
  }

  // ---- calibration ----
  // Full width of a capsule at its midpoint from the person mask, in pixels, or null.
  function maskWidth(mask, inst, sc, sw) {
    const m = mid(inst.a, inst.b);
    const len = dist(inst.a, inst.b);
    const n = { x: -(inst.b.y - inst.a.y) / len, y: (inst.b.x - inst.a.x) / len };
    const inside = (p) => {
      const x = Math.floor((p.x / sc.W) * mask.width), y = Math.floor((p.y / sc.H) * mask.height);
      return x >= 0 && y >= 0 && x < mask.width && y < mask.height && mask.data[y * mask.width + x] > 127;
    };
    if (!inside(m)) return null;
    const step = 0.5 * Math.min(sc.W / mask.width, sc.H / mask.height);
    const walk = (s) => {
      for (let d = step; d <= 2 * sw; d += step) if (!inside({ x: m.x + s * n.x * d, y: m.y + s * n.y * d })) return d - step / 2;
      return null;
    };
    const d1 = walk(1), d2 = walk(-1);
    if (d1 === null || d2 === null) return null;
    // One side running on much further usually means the limb touches the body or the other limb.
    const lo = Math.min(d1, d2), hi = Math.max(d1, d2);
    return hi > 2 * lo ? 2 * lo : d1 + d2;
  }

  function measure(frame) {
    const lms = frame.pose?.landmarks;
    if (!lms || lms.length < 33) return { sample: null, hint: "Step into view" };
    const sc = scaleOf(frame);
    const ls = point(11, lms, sc), rs = point(12, lms, sc);
    if (!ls || !rs || dist(ls, rs) < 1e-6) return { sample: null, hint: "Face the camera so I can see your shoulders" };
    if (!point(23, lms, sc) || !point(24, lms, sc)) return { sample: null, hint: "Step back so I can see your hips" };
    const sw = dist(ls, rs);
    const lw = point(15, lms, sc), rw = point(16, lms, sc);
    const out = (w, s) => w && Math.abs(w.x - s.x) > STANCE_OUT * sw && Math.abs(w.y - s.y) < STANCE_LEVEL * sw;
    if (!out(lw, ls) || !out(rw, rs)) return { sample: null, hint: "Hold your arms out to the sides" };
    const mask = frame.pose.mask?.data ? frame.pose.mask : null;
    const sample = { t: frame.t ?? 0, lengths: {}, widths: {} };
    for (const id of CAL_SEGMENTS) {
      const seg = segments[id];
      if (!seg) continue;
      for (const side of ["left", "right"]) {
        const inst = instance(id, seg, side, lms, sc);
        if (!inst || inst.kind !== "capsule") continue;
        (sample.lengths[id] ||= {})[side] = dist(inst.a, inst.b) / sw;
        const w = mask && maskWidth(mask, inst, sc, sw);
        if (w) (sample.widths[id] ||= {})[side] = w / sw;
      }
    }
    return { sample, hint: null };
  }

  function calibrate(samples) {
    const ok = (samples || []).filter(Boolean);
    if (ok.length < CAL_MIN_SAMPLES) return null;
    const radii = {}, lengths = {};
    for (const id of CAL_SEGMENTS) {
      const w = ok.flatMap((s) => Object.values(s.widths?.[id] || {})).filter(Number.isFinite);
      const l = ok.flatMap((s) => Object.values(s.lengths?.[id] || {})).filter(Number.isFinite);
      const def = defaultRadius(id);
      if (w.length >= CAL_MIN_SAMPLES) radii[id] = clamp(median(w) / 2, 0.5 * def, 2 * def);
      if (l.length >= CAL_MIN_SAMPLES) lengths[id] = median(l);
    }
    return { version: 1, at: new Date().toISOString(), samples: ok.length, radii, lengths };
  }

  function setCalibration(cal) {
    if (!cal || cal.version !== 1 || typeof cal.radii !== "object") { calibration = null; return null; }
    const radii = {};
    for (const [id, r] of Object.entries(cal.radii)) {
      if (segments[id] && Number.isFinite(r)) radii[id] = clamp(r, 0.5 * defaultRadius(id), 2 * defaultRadius(id));
    }
    calibration = { ...cal, radii };
    return calibration;
  }

  return {
    update,
    outline,
    outlines,
    measure,
    calibrate,
    setCalibration,
    getCalibration: () => calibration,
    lock() {                     // force-lock the current leader (the view calls this on a tap)
      if (locked) return true;
      if (!leaderKey) return false;
      doLock(leaderKey);
      return true;
    },
    unlock() { doUnlock(); },
    get locked() { return locked; },
    setPointerHand(side) { pointerHand = side === "left" || side === "right" ? side : null; },
    setHardLock(on) { hardLock = !!on; },
    get hardLock() { return hardLock; },
    get pointerHand() { return pointerHand; },
    reset() { forget(); locked = false; lockedKey = null; lockGeom = null; last = null; },
  };
}
