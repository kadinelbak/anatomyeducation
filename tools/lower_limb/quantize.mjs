// usage: node quantize.mjs in.glb out.glb
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { quantize, prune } from "@gltf-transform/functions";
const [inp, out] = process.argv.slice(2);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inp);
await doc.transform(quantize({ quantizePosition: 14, quantizeNormal: 10 }), prune());
await io.write(out ?? inp, doc);
