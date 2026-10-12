// Convert the Open3DModel upper-limb GLB into assets/model/arm.glb + structures.json (v2).
// Usage: node tools/build_o3d.mjs <in.glb> [--out assets/model/arm.glb] [--list]
//   --list  print the selected node names (JSON) and exit (used to generate o3d_parts.json)
// Geometry is CC BY-SA; the source textures/materials are non-commercial and are dropped.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMeshQuantization } from "@gltf-transform/extensions";
import { weld, simplify, quantize, prune } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import draco3d from "draco3dgltf";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const inFile = args.find((a, i) => !a.startsWith("--") && !["--out", "--scale", "--error"].includes(args[i - 1]));
const outIdx = args.indexOf("--out");
const outFile = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(root, "assets/model/arm.glb"));
const structFile = path.join(path.dirname(outFile), "structures.json");
if (!inFile) { console.error("usage: node tools/build_o3d.mjs <in.glb> [--out assets/model/arm.glb] [--list]"); process.exit(1); }

// --scale multiplies every per-layer simplify ratio (tune the triangle budget in one go).
const scaleIdx = args.indexOf("--scale");
const SCALE = scaleIdx >= 0 ? Number(args[scaleIdx + 1]) : 1;
// --error: meshopt simplify error bound (fraction of mesh extent); the default 0.001 stops well before small ratios bite.
const errIdx = args.indexOf("--error");
const ERROR = errIdx >= 0 ? Number(args[errIdx + 1]) : 0.001;
const RATIO = Object.fromEntries(Object.entries({ bone: 0.45, muscle: 0.4, tendon: 0.4, ligament: 0.35, nerve: 0.3, vessel: 0.3 }).map(([k, v]) => [k, v * SCALE]));
const LAYERS = ["muscle", "tendon", "ligament", "nerve", "vessel", "bone"];
const MARROW_KEYS = new Set(["humerus", "radius", "ulna", "metacarpal_1", "metacarpal_2", "metacarpal_3", "metacarpal_4", "metacarpal_5",
  "phalanges_thumb", "phalanges_index", "phalanges_middle", "phalanges_ring", "phalanges_little"]);
const CARPALS = new Set(["scaphoid", "lunate", "triquetrum", "pisiform", "trapezium", "trapezoid", "capitate", "hamate"]);

// Source names contain zero-width spaces and odd whitespace; keys in o3d_parts.json use this cleaned form.
const clean = (s) => s.replace(/[​‌‍﻿]/g, "").replace(/\s+/g, " ").trim();

// ---------- selection ----------
const INCLUDE_GROUP = /^(Arm|Forearm|Hand and wrist|Pectoral girdle) - |^Thorax - (nerves|bones|cartilages)$/;
const EXCLUDE_GROUP = /^(Back|Head and neck) - | - veins$| - synovia, bursae$/;
const EXCLUDE_NAME_CONTAINS = ["bursa", "tendon sheath", "synovial sheaths", "nucleus pulposus"];
const EXCLUDE_NAME_START = ["brachial fascia", "antebrachial fascia", "costocervical trunk", "thyrocervical trunk",
  "vertebral artery", "brachiocephalic artery", "subclavian artery", "t1 root"];
function selected(group, name) {
  if (!INCLUDE_GROUP.test(group) || EXCLUDE_GROUP.test(group)) return false;
  const n = clean(name).toLowerCase();
  if (EXCLUDE_NAME_CONTAINS.some((s) => n.includes(s))) return false;
  if (EXCLUDE_NAME_START.some((s) => n.startsWith(s))) return false;
  return true;
}

// ---------- read ----------
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
const src = await io.read(inFile);

function det3(m) { return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]); }
function normalMatrix(m) { // inverse transpose of upper 3x3 (column-major 4x4 input) -> row-major 3x3 acting on column vectors
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const D = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) || 1;
  const inv = [(e * i - f * h), -(b * i - c * h), (b * f - c * e), -(d * i - f * g), (a * i - c * g), -(a * f - c * d), (d * h - e * g), -(a * h - b * g), (a * e - b * d)].map((v) => v / D);
  return [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
}

const items = []; // {src, group, pos, nrm, idx}
const scene = src.getRoot().listScenes()[0];
function walk(node, group) {
  const name = node.getName();
  const mesh = node.getMesh();
  if (mesh) {
    if (selected(group, name)) items.push(extract(node, group));
  }
  const g = node.listChildren().length && !mesh ? name : group;
  for (const c of node.listChildren()) walk(c, g);
}
function extract(node, group) {
  const M = node.getWorldMatrix(), flip = det3(M) < 0, N = normalMatrix(M);
  const P = [], NR = [], IDX = []; let base = 0, haveN = true;
  for (const prim of node.getMesh().listPrimitives()) {
    const pa = prim.getAttribute("POSITION"); if (!pa) continue;
    const na = prim.getAttribute("NORMAL"); if (!na) haveN = false;
    const cnt = pa.getCount(), v = [0, 0, 0];
    for (let i = 0; i < cnt; i++) {
      pa.getElement(i, v);
      P.push(M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12], M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13], M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14]);
      if (na) {
        na.getElement(i, v);
        let x = N[0] * v[0] + N[1] * v[1] + N[2] * v[2], y = N[3] * v[0] + N[4] * v[1] + N[5] * v[2], z = N[6] * v[0] + N[7] * v[1] + N[8] * v[2];
        const l = Math.hypot(x, y, z) || 1; NR.push(x / l, y / l, z / l);
      } else NR.push(0, 0, 0);
    }
    const ia = prim.getIndices();
    const n = ia ? ia.getCount() : cnt;
    for (let t = 0; t + 2 < n; t += 3) {
      const a = ia ? ia.getScalar(t) : t, b = ia ? ia.getScalar(t + 1) : t + 1, c = ia ? ia.getScalar(t + 2) : t + 2;
      if (flip) IDX.push(base + a, base + c, base + b); else IDX.push(base + a, base + b, base + c);
    }
    base += cnt;
  }
  const pos = Float32Array.from(P), idx = Uint32Array.from(IDX);
  const nrm = haveN ? Float32Array.from(NR) : computeNormals(pos, idx);
  return { src: clean(node.getName()), group, pos, nrm, idx };
}
function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { n[o] += nx; n[o + 1] += ny; n[o + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  return n;
}
for (const c of scene.listChildren()) walk(c, "");

if (args.includes("--list")) {
  console.log(JSON.stringify(items.map((it) => ({ name: it.src, group: it.group })), null, 1));
  process.exit(0);
}

// ---------- mapping ----------
const partsFile = path.join(here, "o3d_parts.json");
const parts = JSON.parse(fs.readFileSync(partsFile, "utf8"));
const partsClean = {};
for (const [k, v] of Object.entries(parts)) partsClean[clean(k)] = v;
const missing = [...new Set(items.filter((it) => !partsClean[it.src]).map((it) => it.src))];
if (missing.length) { console.error(`o3d_parts.json is missing ${missing.length} node(s):\n  ` + missing.join("\n  ")); process.exit(2); }
for (const it of items) {
  const p = partsClean[it.src];
  if (!LAYERS.includes(p.layer)) throw new Error(`bad layer for ${it.src}: ${p.layer}`);
  it.structure = p.structure; it.layer = p.layer; it.display = p.name;
}
const trisOf = (arr) => arr.reduce((s, it) => s + it.idx.length / 3, 0);
const before = {}; for (const l of LAYERS) before[l] = trisOf(items.filter((it) => it.layer === l));

// ---------- weld + simplify per layer ----------
await MeshoptSimplifier.ready;
async function simplifyGroup(group, ratio) {
  const keep = [];
  const doc = new Document(); const buf = doc.createBuffer(); const sc = doc.createScene();
  group.forEach((it, i) => {
    const prim = doc.createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(it.pos).setBuffer(buf))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(it.nrm).setBuffer(buf))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(it.idx).setBuffer(buf));
    const mesh = doc.createMesh(String(i)).addPrimitive(prim);
    sc.addChild(doc.createNode(String(i)).setMesh(mesh));
  });
  await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: ERROR, lockBorder: false }));
  doc.getRoot().listNodes().forEach((n) => {
    const it = group[Number(n.getName())]; const prim = n.getMesh().listPrimitives()[0];
    const ia = prim.getIndices();
    if (!ia || ia.getCount() < 3) { console.warn("dropped empty after simplify:", it.src); return; }
    it.pos = Float32Array.from(prim.getAttribute("POSITION").getArray());
    it.nrm = Float32Array.from(prim.getAttribute("NORMAL").getArray());
    it.idx = Uint32Array.from(ia.getArray());
    keep.push(it);
  });
  return keep;
}
const after = {};
const kept = [];
for (const layer of LAYERS) {
  const group = items.filter((it) => it.layer === layer);
  const k = group.length ? await simplifyGroup(group, RATIO[layer]) : [];
  kept.push(...k); after[layer] = trisOf(k);
}
// restore original traversal order and assign stable ids
const order = new Map(items.map((it, i) => [it, i]));
kept.sort((a, b) => order.get(a) - order.get(b));
kept.forEach((it, i) => { it.id = "o3d_" + String(i + 1).padStart(4, "0"); });

// ---------- marrow cores ----------
function jacobi3(C) { // symmetric 3x3 eigen-decomposition; returns {vals, vecs (columns)}
  const A = C.map((r) => r.slice()); const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1, mx = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > mx) { p = 0; q = 2; mx = Math.abs(A[0][2]); }
    if (Math.abs(A[1][2]) > mx) { p = 1; q = 2; mx = Math.abs(A[1][2]); }
    if (mx < 1e-18) break;
    const th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]), c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
    for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
    for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
  }
  return { vals: [A[0][0], A[1][1], A[2][2]], vecs: [0, 1, 2].map((j) => [V[0][j], V[1][j], V[2][j]]) };
}
function marrow(it) {
  const n = it.pos.length / 3, mu = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) mu[k] += it.pos[i * 3 + k] / n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const d = [it.pos[i * 3] - mu[0], it.pos[i * 3 + 1] - mu[1], it.pos[i * 3 + 2] - mu[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b] / n;
  }
  const { vals, vecs } = jacobi3(C);
  const major = vals.indexOf(Math.max(...vals));
  const sc = vals.map((_, j) => (CARPALS.has(it.structure) ? 0.55 : j === major ? 0.97 : 0.55));
  const pos = new Float32Array(it.pos.length);
  for (let i = 0; i < n; i++) {
    const d = [it.pos[i * 3] - mu[0], it.pos[i * 3 + 1] - mu[1], it.pos[i * 3 + 2] - mu[2]];
    const o = [mu[0], mu[1], mu[2]];
    for (let j = 0; j < 3; j++) {
      const proj = d[0] * vecs[j][0] + d[1] * vecs[j][1] + d[2] * vecs[j][2];
      for (let k = 0; k < 3; k++) o[k] += vecs[j][k] * proj * sc[j];
    }
    pos.set(o, i * 3);
  }
  return { src: it.src, structure: it.structure, layer: "marrow", id: it.id + "__marrow", pos, nrm: it.nrm, idx: it.idx };
}
const marrows0 = kept.filter((it) => it.layer === "bone" && !/^art(icular)? carts?\b/i.test(it.src) && (MARROW_KEYS.has(it.structure) || CARPALS.has(it.structure))).map(marrow);
// The cores are hidden inside the bones, so they get an extra decimation pass to stay within the triangle budget.
const marrows = await simplifyGroup(marrows0, 0.25);

// ---------- axis ----------
function endCentroid(it, top) {
  const n = it.pos.length / 3, ord = Array.from({ length: n }, (_, i) => i).sort((a, b) => it.pos[a * 3 + 1] - it.pos[b * 3 + 1]);
  const k = Math.max(1, Math.round(n * 0.1)), sel = top ? ord.slice(n - k) : ord.slice(0, k), c = [0, 0, 0];
  for (const i of sel) for (let d = 0; d < 3; d++) c[d] += it.pos[i * 3 + d] / k;
  return c.map((v) => +v.toFixed(4));
}
const centroid = (it) => { const n = it.pos.length / 3, c = [0, 0, 0]; for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) c[d] += it.pos[i * 3 + d] / n; return c.map((v) => +v.toFixed(4)); };
const findSrc = (re) => { const it = kept.find((x) => x.layer === "bone" && re.test(x.src)); if (!it) throw new Error("axis source not found: " + re); return it; };
const axis = {
  shoulder: endCentroid(findSrc(/^Humerus\.r$/), true),
  elbow: endCentroid(findSrc(/^Humerus\.r$/), false),
  wrist: endCentroid(findSrc(/^Radius\.r$/), false),
  fingertip: centroid(findSrc(/^Distal phalanx of 3(d|rd) finger/)),
};

// ---------- write GLB ----------
const out = new Document(); const obuf = out.createBuffer(); const oscene = out.createScene("arm");
for (const it of [...kept, ...marrows]) {
  const prim = out.createPrimitive()
    .setAttribute("POSITION", out.createAccessor().setType("VEC3").setArray(it.pos).setBuffer(obuf))
    .setAttribute("NORMAL", out.createAccessor().setType("VEC3").setArray(it.nrm).setBuffer(obuf))
    .setIndices(out.createAccessor().setType("SCALAR").setArray(it.pos.length / 3 < 65536 ? Uint16Array.from(it.idx) : it.idx).setBuffer(obuf));
  oscene.addChild(out.createNode(it.id).setMesh(out.createMesh(it.id).addPrimitive(prim)));
}
await out.transform(quantize({ quantizePosition: 14, quantizeNormal: 10 }), prune());
fs.mkdirSync(path.dirname(outFile), { recursive: true });
await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(outFile, out);

// ---------- structures.json ----------
const structures = {};
for (const it of kept) if (!structures[it.structure]) structures[it.structure] = it.display;
// Display name per key = name given by the mapping for the key's first node; prefer an entry whose name matches the key's own table
for (const it of kept) { const p = partsClean[it.src]; if (p.keyName) structures[it.structure] = p.keyName; }
const handBones = [...CARPALS, "metacarpal_1", "metacarpal_2", "metacarpal_3", "metacarpal_4", "metacarpal_5",
  "phalanges_thumb", "phalanges_index", "phalanges_middle", "phalanges_ring", "phalanges_little", "sesamoid_bones"].filter((k) => structures[k]);
const meta = {
  version: 2,
  source: "Open3DModel upper limb GLB (2025-07-24), CC BY-SA 4.0; converted by tools/build_o3d.mjs",
  units: "m",
  layers: LAYERS,
  nodes: [...kept, ...marrows].map((it) => ({ node: it.id, structure: it.structure, layer: it.layer, source: it.src })),
  structures,
  regions: { hand: handBones, forearm: ["radius", "ulna"], arm: ["humerus"], shoulder: ["scapula", "clavicle"],
    all: ["humerus", "radius", "ulna", "scapula", "clavicle", ...handBones] },
  axis,
  schematic: [],
};
fs.writeFileSync(structFile, JSON.stringify(meta, null, 1) + "\n");

// ---------- check ----------
const chk = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(outFile);
const glbNodes = new Set(chk.getRoot().listNodes().map((n) => n.getName()));
const jsonNodes = new Set(meta.nodes.map((n) => n.node));
const problems = [];
for (const n of jsonNodes) if (!glbNodes.has(n)) problems.push("in structures.json but not in GLB: " + n);
for (const n of glbNodes) if (!jsonNodes.has(n)) problems.push("in GLB but not in structures.json: " + n);
for (const n of meta.nodes) if (!structures[n.structure]) problems.push("node structure without name: " + n.structure);
const qf = path.join(root, "assets/questions/upper-limb.json");
const missingQ = [];
if (fs.existsSync(qf)) {
  const q = JSON.parse(fs.readFileSync(qf, "utf8"));
  for (const qu of q.questions) for (const id of [].concat(qu.target ?? [], qu.accept ?? []))
    if (id !== "skin" && !structures[id]) missingQ.push(`${qu.id ?? "?"}:${id}`);
}
let tri = 0;
for (const m of chk.getRoot().listMeshes()) for (const p of m.listPrimitives()) tri += p.getIndices().getCount() / 3;
const size = fs.statSync(outFile).size;
console.log("layer       before ->  after");
for (const l of LAYERS) console.log(`${l.padEnd(10)} ${String(Math.round(before[l])).padStart(8)} -> ${String(Math.round(after[l])).padStart(7)}`);
console.log(`marrow tris: ${marrows.reduce((s, m) => s + m.idx.length / 3, 0)}  | total triangles in GLB: ${tri}`);
console.log(`nodes: ${meta.nodes.length} (${marrows.length} marrow), structure keys: ${Object.keys(structures).length}, GLB: ${(size / 1048576).toFixed(2)} MB`);
console.log("axis", JSON.stringify(axis));
console.log("question ids missing from structures:", missingQ.length ? missingQ.join(", ") : "none");
if (tri > 400000) console.warn("WARNING: over 400k triangles");
if (problems.length) { console.error(problems.join("\n")); process.exit(3); }
console.log("OK ->", outFile, "and", structFile);
