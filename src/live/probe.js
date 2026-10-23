// Live mode probe: maps a pointed body location and the probe hand's finger to a scan view.
// Pure logic plus calls on the injected renderer switch; nothing DOM-specific is imported,
// so Node can load it (pass `studies` or `fetchJson` there instead of relying on `fetch`).
//
//   const probe = await createProbe({ studiesUrl, renderers });
//   probe.modalitiesFor(point)                  -> [{ id, label, study, simulated }]
//   probe.request(point, probeTip, modality)    -> ProbeRequest | null
//   probe.apply(req)                            -> Promise<void>
//
// Body frame data lives in assets/live/studies.json (see its "_notes" for how it was measured).

const LONGITUDINAL_DEG = 35; // finger within this angle of the segment axis = longitudinal
const SEGMENT_ALIASES = { lower_leg: "leg", shank: "leg", calf: "leg", upper_arm: "arm", torso: "trunk", chest: "trunk", abdomen: "trunk", pelvis: "trunk" };
const FROM_WORD = { trunk: "top", head: "top", neck: "top", thigh: "hip", leg: "knee", arm: "shoulder", forearm: "elbow", hand: "wrist", foot: "ankle" };
const SEGMENT_LABEL = { trunk: "Trunk", head: "Head", neck: "Neck", thigh: "Thigh", leg: "Leg", arm: "Arm", forearm: "Forearm", hand: "Hand", foot: "Foot" };
const MODALITY_LABEL = { ct: "CT", mri: "MRI", xray: "X-ray", ultrasound: "Ultrasound" };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const canon = (s) => SEGMENT_ALIASES[s] || s;

// Slice index (float) for a body fraction, using the study's piecewise anchors when present.
// Clamped to the covered span; never extrapolates past it.
export function sliceFor(entry, frac) {
  const [f0, f1] = entry.frac;
  const f = clamp(frac, f0, f1);
  const a = entry.anchors;
  if (a && a.length >= 2) {
    // anchors: [[frac, slice], ...] ascending frac
    for (let i = 0; i < a.length - 1; i++) {
      const [fa, sa] = a[i], [fb, sb] = a[i + 1];
      if (f <= fb || i === a.length - 2) {
        const t = fb === fa ? 0 : clamp((f - fa) / (fb - fa), 0, 1);
        return sa + (sb - sa) * t;
      }
    }
  }
  const [lo, hi] = entry.slices;
  const t = f1 === f0 ? 0 : (f - f0) / (f1 - f0);
  return entry.proximalIsHigh ? hi - t * (hi - lo) : lo + t * (hi - lo);
}

// How far `frac` is inside the study's span: positive = margin from the nearest edge, negative = distance outside.
function coverMargin(entry, frac) {
  const [a, b] = entry.frac;
  return frac < a ? frac - a : frac > b ? b - frac : Math.min(frac - a, b - frac);
}

function bodyAxis(point) {
  const a = point?.axis;
  if (a && Number.isFinite(a.x) && Number.isFinite(a.y) && (a.x || a.y)) {
    const n = Math.hypot(a.x, a.y);
    return { x: a.x / n, y: a.y / n };
  }
  return { x: 0, y: 1 }; // trunk and head run up the image; limbs supply point.axis
}

// True when the probe finger lies within 35 degrees of the segment axis (either way along it).
export function isLongitudinal(point, probeTip) {
  const d = probeTip?.dir;
  if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.y)) return false;
  const n = Math.hypot(d.x, d.y);
  if (!n) return false;
  const ax = bodyAxis(point);
  const cos = Math.abs((d.x * ax.x + d.y * ax.y) / n);
  return Math.acos(clamp(cos, 0, 1)) * 180 / Math.PI <= LONGITUDINAL_DEG;
}

function windowFor(entry, frac) {
  for (const w of entry.windowAt || []) if (frac >= w.frac[0] && frac <= w.frac[1]) return w.window;
  return entry.window || "soft";
}

export async function createProbe({ studiesUrl = "assets/live/studies.json", renderers, studies, fetchJson, raf } = {}) {
  let data = studies;
  if (!data) {
    const get = fetchJson || (async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); });
    data = await get(studiesUrl);
  }
  const entries = Object.entries(data.studies || {}).map(([key, e]) => ({ key, studyId: e.studyId || key, ...e }));
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const schedule = raf || (typeof requestAnimationFrame === "function" ? (fn) => requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16));

  // Scan studies that cover this point's segment (limbs also match the side), best first for this frac.
  function covering(point, kind = "volume") {
    if (!point) return [];
    const seg = canon(point.segment);
    const limb = !["trunk", "head", "neck"].includes(seg);
    const frac = clamp(Number(point.frac) || 0, 0, 1);
    return entries
      .filter((e) => e.kind === kind && canon(e.segment) === seg && (!limb || !e.side || !point.side || e.side === point.side))
      .map((e) => ({ e, m: coverMargin(e, frac), len: e.frac[1] - e.frac[0] }))
      .sort((a, b) => b.m - a.m || b.len - a.len)
      .map((x) => x.e);
  }

  function modalitiesFor(point) {
    const vols = covering(point);
    const out = [];
    const ct = vols.find((e) => e.modality === "CT");
    const mri = vols.find((e) => e.modality === "MRI");
    if (ct) out.push({ id: "ct", label: MODALITY_LABEL.ct, study: ct.studyId, simulated: false });
    if (mri) out.push({ id: "mri", label: MODALITY_LABEL.mri, study: mri.studyId, simulated: false });
    // Radiographs are computed in the browser from the CT, so they exist wherever a CT does.
    if (ct) out.push({ id: "xray", label: MODALITY_LABEL.xray, study: ct.studyId, simulated: true });
    return out;
  }

  function request(point, probeTip, modality) {
    if (!point) return null;
    const mid = typeof modality === "string" ? modality : modality?.id;
    const options = modalitiesFor(point);
    const pick = options.find((o) => o.id === mid && (typeof modality === "string" || !modality.study || o.study === modality.study)) || options.find((o) => o.id === mid);
    if (!pick) return null;
    // The entry for the chosen study (the same study id can appear once per segment).
    const entry = covering(point).find((e) => e.studyId === pick.study && (pick.id === "xray" ? e.modality === "CT" : true));
    if (!entry) return null;
    const frac = clamp(Number(point.frac) || 0, 0, 1);
    const front = point.aspect === "front" || point.aspect === "back";
    const longitudinal = isLongitudinal(point, probeTip);
    const slice = sliceFor(entry, frac);
    const n = entry.dims || (entry.slices[1] + 1);
    const along = clamp(slice / Math.max(1, n - 1), 0, 1); // 0 = inferior end of the volume, 1 = superior
    const region = point.region?.label || `${point.side ? point.side[0].toUpperCase() + point.side.slice(1) + " " : ""}${(SEGMENT_LABEL[canon(point.segment)] || point.segment).toLowerCase()}`.replace(/^./, (c) => c.toUpperCase());
    const pct = Math.round(frac * 100);
    const from = FROM_WORD[canon(point.segment)] || "proximal end";
    let view, kind, plane = null;
    if (pick.id === "xray") {
      kind = "xray";
      view = { axis: point.aspect === "front" || point.aspect === "back" ? "ap" : "lateral", zoom: 1, cx: 0.5, cy: round(1 - along) };
    } else {
      kind = "volume";
      plane = longitudinal ? (front ? "coronal" : "sagittal") : "axial";
      // Axial steps along the long axis; coronal/sagittal show the whole length, so pick the depth: anterior/posterior half by aspect, midline for sagittal.
      const f = plane === "axial" ? along : plane === "coronal" ? (point.aspect === "back" ? 0.38 : 0.62) : 0.5;
      view = { plane, frac: round(f), window: windowFor(entry, frac) };
    }
    const kindWord = pick.id === "xray" ? (view.axis === "ap" ? "AP view" : "lateral view") : longitudinal ? "longitudinal" : "transverse";
    return {
      kind,
      study: entry.studyId,
      view,
      caption: `${region}, ${kindWord}, ${pct}% from the ${from}`,
      simulated: pick.simulated,
      modality: pick.id,
      slice: round(slice, 2),
      sliceCount: n,
    };
  }

  // ---- apply: one renderer call per animation frame, skipped when nothing visible changes ----
  let pending = null, waiters = [], scheduled = false, last = null, chain = Promise.resolve();

  function sameView(a, b) {
    if (!a || !b || a.kind !== b.kind || a.study !== b.study) return false;
    const va = a.view, vb = b.view;
    if (a.kind === "xray") {
      return va.axis === vb.axis && Math.abs(va.cy - vb.cy) * (a.sliceCount - 1) < 0.5;
    }
    return va.plane === vb.plane && va.window === vb.window && Math.abs(va.frac - vb.frac) * (a.sliceCount - 1) < 0.5;
  }

  async function run(req) {
    const need = !renderers.active || renderers.active !== req.kind || (renderers.study ?? null) !== req.study;
    if (!need && sameView(last, req)) return;
    if (need) {
      if (typeof renderers.activate === "function") await renderers.activate(req.kind, req.study);
      else await renderers.show(req.kind, req.study);
    }
    await renderers.show({ study: req.study, view: req.view, layers: ["labels"] });
    last = req;
  }

  function apply(req) {
    if (!req) return Promise.resolve();
    pending = req;
    const done = new Promise((res) => waiters.push(res));
    if (!scheduled) {
      scheduled = true;
      schedule(() => {
        scheduled = false;
        const r = pending, ws = waiters;
        pending = null; waiters = [];
        chain = chain.then(() => run(r)).catch((err) => { last = null; console.warn("probe.apply failed", err); }).then(() => ws.forEach((w) => w()));
      });
    }
    return done;
  }

  return {
    modalitiesFor,
    request,
    apply,
    studyEntry: (key) => byKey.get(key) || null,
    get studies() { return data; },
  };
}

function round(v, d = 3) { const k = 10 ** d; return Math.round(v * k) / k; }
