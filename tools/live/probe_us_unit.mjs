// node tools/live/probe_us_unit.mjs  (no DOM)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createUltrasoundProbe } from "../../src/live/probe-us.js";
const data = JSON.parse(readFileSync(new URL("../../assets/ultrasound/live-views.json", import.meta.url)));
const p = createUltrasoundProbe({ data });
const chest = ["ts-s1042", "ts-s1164", "ts-s1337"], abd = ["ts-s0513", "ts-s1383", "ts-s1390"];
const pt = (o) => ({ segment: "trunk", frac: 0.2, facing: "front", tip: { x: 0.5, y: 0.4 }, ...o });
const tr = { tip: { x: 0.5, y: 0.4 }, dir: { x: 1, y: 0 } }, lo = { tip: { x: 0.5, y: 0.4 }, dir: { x: 0.1, y: -1 } };
let r = p.request(pt({}), tr);
assert(chest.includes(r.study) && r.kind === "ultrasound" && r.simulated);
assert.equal(r.view.rot, 0); assert(r.view.frac >= 0 && r.view.frac <= 1); assert.equal(r.view.angle, 0);
{ const e = data.studies[r.study], [a, b] = e.studyFrac; assert(Math.abs(r.view.frac - (a + (b - a) * (0.2 / 0.45))) < 1e-3, "chest frac follows the study's anchored span"); }
// Pelvis band: a second entry of an abdomen study, loaded under the study's own id and mapped onto its lower part.
r = p.request(pt({ frac: 0.9 }), tr); assert(abd.includes(r.study), "pelvis uses a trunk CT study id, not the @pelvis key"); assert(/^Pelvis/.test(r.caption)); assert(r.view.frac > 0.1 && r.view.frac < 0.4, `pelvis frac in the lower volume (${r.view.frac})`);
r = p.request(pt({}), lo); assert.equal(r.view.rot, 90);
r = p.request(pt({ facing: "back" }), tr); assert.equal(r.view.angle, 180);
r = p.request(pt({}), { tip: { x: 0.7, y: 0.4 }, dir: { x: 1, y: 0 } }); assert.equal(r.view.angle, 60);
r = p.request(pt({}), { tip: { x: 0.3, y: 0.4 }, dir: { x: 1, y: 0 } }); assert.equal(r.view.angle, 300);
r = p.request(pt({ frac: 0.6 }), tr); assert(abd.includes(r.study)); assert(r.view.frac >= 0 && r.view.frac <= 1);
assert.equal(p.entriesFor(pt({ segment: "forearm", side: "right", frac: 0.4 }))[0].study, "vh-forearm");
r = p.request(pt({ segment: "forearm", side: "right", frac: 0.4 }), tr); assert(r.study === "vh-forearm" && r.view.depth === 6 && r.view.frac > 0 && r.view.frac < 1);
assert.equal(p.entriesFor(pt({ segment: "hand" })).length, 0); assert.equal(p.request(pt({ segment: "hand" }), tr), null);
console.log("probe_us_unit ok:", r.caption);
