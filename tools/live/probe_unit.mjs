// Node unit test for src/live/probe.js: node tools/live/probe_unit.mjs
import fs from "node:fs";
import { createProbe, sliceFor } from "../../src/live/probe.js";

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };
const studiesPath = new URL("../../assets/live/studies.json", import.meta.url);
const data = JSON.parse(fs.readFileSync(studiesPath, "utf8"));
const volumes = new Set(fs.readdirSync(new URL("../../assets/volumes/", import.meta.url)));

const calls = [];
const fake = {
  active: null, study: null,
  async activate(kind, id) { calls.push(["activate", kind, id]); this.active = kind; this.study = id; },
  async show(arg) { calls.push(["show", arg]); },
};
const frames = [];
const raf = (fn) => frames.push(fn);
const probe = await createProbe({ fetchJson: async () => data, renderers: fake, raf });

// data integrity: every study exists on disk, every CT/MRI volume is covered, spans sane
for (const [key, e] of Object.entries(data.studies)) {
  const id = e.studyId || key;
  if (!volumes.has(id)) check(false, `${key}: study folder missing`);
  if (!(e.slices[0] <= e.slices[1] && e.slices[1] < e.dims && e.frac[0] < e.frac[1])) check(false, `${key}: bad span`);
}
const missing = [...volumes].filter((v) => v !== "index.json" && !Object.entries(data.studies).some(([k, e]) => (e.studyId || k) === v));
check(missing.length === 0, `every study has a body-frame entry${missing.length ? " (missing: " + missing.join(", ") + ")" : ""}`);
check(data.ultrasound && typeof data.ultrasound === "object", "ultrasound key present");

const trunk = { segment: "trunk", side: null, frac: 0.2, facing: "front", aspect: "front", region: { label: "Chest" } };
const transverse = { tip: { x: 0.5, y: 0.5 }, dir: { x: 1, y: 0 } };
const longit = { tip: { x: 0.5, y: 0.5 }, dir: { x: 0.1, y: -1 } };

const mods = probe.modalitiesFor(trunk);
check(["ct", "mri", "xray"].every((id) => mods.some((m) => m.id === id)), `trunk offers ct, mri, xray: ${mods.map((m) => m.id + "=" + m.study)}`);
const ct = probe.request(trunk, transverse, "ct");
const entry = data.studies[ct.study];
check(ct.kind === "volume" && volumes.has(ct.study) && entry.modality === "CT" && entry.segment === "trunk", `CT request: ${ct.kind} ${ct.study}`);
check(ct.view.plane === "axial", "transverse finger gives axial");
const sl = Math.round(ct.view.frac * (entry.dims - 1));
check(sl >= entry.slices[0] && sl <= entry.slices[1], `slice ${sl} inside ${JSON.stringify(entry.slices)}`);
check(ct.view.window === "lung", `chest level uses lung window (${ct.view.window})`);
check(/transverse/.test(ct.caption), `caption: ${ct.caption}`);

const lon = probe.request(trunk, longit, "ct");
check(lon.view.plane === "coronal", `longitudinal + front aspect gives coronal (${lon.view.plane})`);
check(probe.request({ ...trunk, aspect: null }, longit, "ct").view.plane === "sagittal", "longitudinal without front/back aspect gives sagittal");
check(probe.request(trunk, { dir: { x: Math.sin(0.7), y: Math.cos(0.7) } }, "ct").view.plane === "axial", "finger 40 deg off the axis is transverse (axial)");
check(probe.request(trunk, { dir: { x: Math.sin(0.5), y: Math.cos(0.5) } }, "ct").view.plane === "coronal", "finger 29 deg off the axis is longitudinal");
const xr = probe.request(trunk, transverse, "xray");
check(xr.kind === "xray" && xr.view.axis === "ap" && xr.view.zoom === 1 && xr.simulated, `xray request ap: ${JSON.stringify(xr.view)}`);
check(probe.request({ ...trunk, aspect: "inner" }, transverse, "xray").view.axis === "lateral", "xray without front/back aspect is lateral");

// anchors: monotone, and abdomen CTs honour the 0.8 breakpoint
const abd = data.studies["ts-s0513"];
check(Math.abs(sliceFor(abd, 0.8) - 69) < 0.01 && Math.abs(sliceFor(abd, 0.45) - 143) < 0.01, "ts-s0513 anchors at 0.45 and 0.8");

// head
const head = { segment: "head", side: null, frac: 0.5, aspect: "front" };
const hm = probe.modalitiesFor(head);
check(hm.some((m) => m.id === "mri") && hm.some((m) => m.id === "ct" && m.study === "vh-head-neck"), `head offers MRI and the Visible Human CT: ${hm.map((m) => m.id)}`);
check(probe.request(head, transverse, "mri").view.plane === "axial", "head MRI axial");

// limbs: the right forearm has the Visible Human CT (and its radiograph)
const forearm = { segment: "forearm", side: "right", frac: 0.4, aspect: "front" };
check(probe.modalitiesFor(forearm).map((m) => m.id).join() === "ct,xray", "forearm point yields CT and X-ray");
const fr = probe.request(forearm, transverse, "ct");
check(fr && fr.study === "vh-forearm" && fr.view.plane === "axial" && fr.view.window === "bone", "forearm CT request is vh-forearm axial, bone window");
check(probe.modalitiesFor(null).length === 0, "null point yields none");
// the knee study is data-driven: left thigh matches, right does not
check(probe.modalitiesFor({ segment: "thigh", side: "left", frac: 0.9 }).some((m) => m.id === "mri"), "left thigh offers the knee MRI");
check(probe.modalitiesFor({ segment: "thigh", side: "right", frac: 0.3 }).some((m) => m.id === "ct" && m.study === "vh-thigh"), "right thigh offers the Visible Human CT");
check(probe.modalitiesFor({ segment: "thigh", side: "right", frac: 0.3 }).some((m) => m.id === "mri" && m.mirrored), "right thigh borrows the left knee MRI, mirrored");
check(probe.modalitiesFor({ segment: "forearm", side: "left", frac: 0.4 }).some((m) => m.id === "ct" && m.study === "vh-forearm" && m.mirrored), "left forearm borrows the right forearm CT, mirrored");
{ const r = probe.request({ segment: "forearm", side: "left", frac: 0.4, aspect: "front" }, null, "ct");
  check(r && r.study === "vh-forearm" && r.mirrored && /from the right side scan/.test(r.caption), `left forearm CT request is mirrored: ${r?.caption}`); }
check(probe.modalitiesFor({ segment: "thigh", side: "right", frac: 0.3 }).find((m) => m.id === "ct")?.mirrored === false, "same-side CT is preferred and not mirrored");

// apply: throttle to one show per frame, skip sub-half-slice changes
const tick = () => { const f = frames.splice(0); f.forEach((fn) => fn()); };
const p1 = probe.apply(ct); probe.apply({ ...ct, view: { ...ct.view, frac: ct.view.frac + 0.0001 } });
check(frames.length === 1, "two applies in one frame schedule one frame callback");
tick(); await p1;
check(calls.filter((c) => c[0] === "activate").length === 1 && calls.filter((c) => c[0] === "show").length === 1, `first apply: activate then one show (${calls.length} calls)`);
check(calls[0][1] === "volume" && calls[0][2] === ct.study && calls[1][1].study === ct.study && calls[1][1].layers[0] === "labels", "apply activates volume + study, then shows with labels layer");
const n0 = calls.length;
const p2 = probe.apply({ ...ct, view: { ...ct.view, frac: ct.view.frac + 0.2 / (ct.sliceCount - 1) } }); tick(); await p2;
check(calls.length === n0, "0.2 slice change is skipped");
const p3 = probe.apply({ ...ct, view: { ...ct.view, frac: ct.view.frac + 3 / (ct.sliceCount - 1) } }); tick(); await p3;
check(calls.length === n0 + 1 && calls[n0][0] === "show", "3 slice change is one show, no re-activate");

// A study already on screen stays while it covers the point (a moving probe steps slices, not volumes).
{
  const a = probe.request({ ...trunk, frac: 0.2 }, transverse, "mri");
  const b = probe.request({ ...trunk, frac: 0.6 }, transverse, "mri");
  const sticky = probe.request({ ...trunk, frac: 0.6 }, transverse, { id: "mri", study: a.study });
  check(a && b && sticky && sticky.study === a.study, `sticky MRI study ${a?.study} kept at frac 0.6 (first choice there was ${b?.study})`);
  const far = probe.request({ ...trunk, frac: 0.98 }, transverse, { id: "mri", study: "msd-heart-03" });
  check(far && far.study !== "msd-heart-03", "a study that no longer covers the point is dropped");
}
console.log(fails ? `${fails} FAILED` : "all passed");
process.exit(fails ? 1 : 0);
