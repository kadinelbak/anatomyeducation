// Live mode: simulated ultrasound from CT, driven by the fingertip. Pure logic, no DOM.
// createUltrasoundProbe returns synchronously; `ready` resolves once live-views.json is loaded.
// Pass `data` (the parsed JSON) to skip the fetch (Node tests).
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap360 = (a) => ((a % 360) + 360) % 360;

export function createUltrasoundProbe({ liveViewsUrl = "assets/ultrasound/live-views.json", data = null } = {}) {
  let views = data;
  const ready = views ? Promise.resolve(views)
    : fetch(liveViewsUrl).then((r) => r.json()).then((j) => (views = j));

  const studies = () => Object.entries(views?.studies || {}).map(([study, e]) => ({ study, ...e }));
  // Entries whose segment and fracSpan cover the pointed trunk fraction (all of them, in file order).
  function entriesFor(point) {
    if (!point) return [];
    return studies().filter((e) => e.segment === point.segment && point.frac >= e.fracSpan[0] - 1e-9 && point.frac <= e.fracSpan[1] + 1e-9);
  }

  // Angle between the finger direction and the vertical trunk axis, folded to 0..90 degrees.
  function axisAngle(dir) {
    if (!dir || (!dir.x && !dir.y)) return 90;
    const a = Math.abs(Math.atan2(dir.x, -dir.y) * 180 / Math.PI); // 0 = up
    return a > 90 ? 180 - a : a;
  }

  // point: PointResult. probeTip: { tip, dir } of the probe hand (falls back to point.tip).
  // entry: one item of entriesFor(point) (or a studies entry with `study`); default is the first match.
  function request(point, probeTip, entry) {
    if (!views || !point) return null;
    const e = entry || entriesFor(point)[0];
    if (!e) return null;
    const [a, b] = e.fracSpan;
    const t = clamp((point.frac - a) / (b - a), 0, 1);
    const frac = +(1 - t).toFixed(4); // study frac 0 is inferior, pointer frac 0 is the shoulders
    const back = point.facing === "back";
    const tip = probeTip?.tip || point.tip || { x: 0.5, y: 0.5 };
    // Horizontal position between the trunk edges (point.trunkX = { left, right } image x, optional).
    const xl = point.trunkX?.left ?? 0.3, xr = point.trunkX?.right ?? 0.7;
    const u = clamp((tip.x - xl) / Math.max(1e-6, xr - xl), 0, 1);
    // Image left is the user's right when facing the camera (angle 270 side), so u=0 sweeps negative.
    // From behind it is the user's left, so the sweep flips about 180.
    const sweep = (views.sweepDeg ?? 60) * (2 * u - 1);
    const base = back ? e.angleBack ?? 180 : e.angleFront ?? 0;
    const angle = Math.round(wrap360(base + sweep));
    const longitudinal = axisAngle(probeTip?.dir) <= (views.longitudinalWithinDeg ?? 35);
    const rot = longitudinal ? 90 : 0;
    const pct = Math.round(point.frac * 100);
    const caption = `${e.region}${back ? " (back)" : ""}, ${longitudinal ? "longitudinal" : "transverse"}, ${pct}% from the ${e.anchor || "shoulders"} · simulated from CT`;
    return { kind: "ultrasound", study: e.study, view: { frac, angle, tilt: 0, rot, depth: e.depth ?? 16 }, caption, simulated: true };
  }

  return { ready, entriesFor, request, get data() { return views; } };
}
