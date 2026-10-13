// Writes tools/fixtures/glb-cell/model.glb (+ .b64.txt): three named boxes, membrane (10 x 6 x 6), nucleus, structure.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "glb-cell");
function box(hx, hy, hz, cx, cy, cz) { // 24 verts with flat normals, 36 indices
  const P = [], N = [], I = [];
  for (const [n, u, v] of [[[1,0,0],[0,1,0],[0,0,1]],[[-1,0,0],[0,0,1],[0,1,0]],[[0,1,0],[0,0,1],[1,0,0]],[[0,-1,0],[1,0,0],[0,0,1]],[[0,0,1],[1,0,0],[0,1,0]],[[0,0,-1],[0,1,0],[1,0,0]]]) {
    const b = P.length / 3;
    for (const [a, c] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
      P.push(cx + hx * (n[0] + a * u[0] + c * v[0]), cy + hy * (n[1] + a * u[1] + c * v[1]), cz + hz * (n[2] + a * u[2] + c * v[2]));
      N.push(...n);
    }
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { P, N, I };
}
const shapes = [["membrane", box(5, 3, 3, 0, 0, 0)], ["nucleus", box(1.2, 1.2, 1.2, -1.5, 0, 0)], ["structure", box(0.8, 0.5, 0.5, 2.5, 0.5, 0.5)]];
const chunks = [], views = [], accessors = [], meshes = [], nodes = [];
let off = 0;
const push = (arr, Type, target) => { const b = Buffer.from(new Type(arr).buffer); views.push({ buffer: 0, byteOffset: off, byteLength: b.length, target }); chunks.push(b); off += b.length; return views.length - 1; };
shapes.forEach(([name, g], i) => {
  const xs = [0, 1, 2].map((k) => g.P.filter((_, j) => j % 3 === k));
  accessors.push({ bufferView: push(g.P, Float32Array, 34962), componentType: 5126, count: g.P.length / 3, type: "VEC3", min: xs.map((a) => Math.min(...a)), max: xs.map((a) => Math.max(...a)) });
  accessors.push({ bufferView: push(g.N, Float32Array, 34962), componentType: 5126, count: g.N.length / 3, type: "VEC3" });
  accessors.push({ bufferView: push(g.I, Uint16Array, 34963), componentType: 5123, count: g.I.length, type: "SCALAR" });
  meshes.push({ name: name + "-mesh", primitives: [{ attributes: { POSITION: i * 3, NORMAL: i * 3 + 1 }, indices: i * 3 + 2 }] });
  nodes.push({ name, mesh: i });
});
const bin = Buffer.concat(chunks);
const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }] };
const pad = (b, c) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, c)]);
const j = pad(Buffer.from(JSON.stringify(json)), 0x20), bn = pad(bin, 0);
const hdr = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
const glb = Buffer.concat([Buffer.from([0x67, 0x6c, 0x54, 0x46]), Buffer.from(new Uint32Array([2, 12 + 8 + j.length + 8 + bn.length]).buffer), hdr(j.length, 0x4e4f534a), j, hdr(bn.length, 0x004e4942), bn]);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "model.glb"), glb);
fs.writeFileSync(path.join(out, "model.glb.b64.txt"), glb.toString("base64"));
console.log("wrote", glb.length, "bytes");
