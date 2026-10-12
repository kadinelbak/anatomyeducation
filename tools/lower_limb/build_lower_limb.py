"""Build assets/model/lower-limb.glb and structures.json (v2) from BodyParts3D STLs.

Usage: python3 tools/build_lower_limb.py [source dir]   (default: lower-limb/source/bodyparts3d)
Simplifies each part, adds marrow cores and (if tools/lower_nerves.py imports)
schematic nerves/vessels, exports metres / Y up / anterior +Z, then quantizes
the GLB with gltf-transform (tools/quantize.mjs) and runs consistency checks.
"""
import json
import os
import subprocess
import sys

import fast_simplification
import numpy as np
import trimesh

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lower_parts import PARTS, STRUCTURES, REGIONS  # noqa: E402

ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "assets", "model")
GLB = os.path.join(OUT, "lower-limb.glb")
LAYERS = ["muscle", "tendon", "ligament", "nerve", "vessel", "bone"]
BASE = {"bone": 3000, "muscle": 3000, "tendon": 1500, "ligament": 1500, "vessel": 1500}
BIG = {"femur": 6000, "tibia": 6000, "hip_bone": 6000,
       "gluteus_maximus": 4500, "adductor_magnus": 4500, "vastus_lateralis": 4500}
UNIFORM = {"talus", "calcaneus", "navicular", "medial_cuneiform", "intermediate_cuneiform",
           "lateral_cuneiform", "cuboid"}
NO_MARROW = {"sacrum", "hip_bone"}


def simplify(mesh, faces):
    if len(mesh.faces) <= faces:
        return mesh
    ratio = 1.0 - faces / len(mesh.faces)
    v, f = fast_simplification.simplify(mesh.vertices.astype(np.float32), mesh.faces.astype(np.int32), ratio)
    return trimesh.Trimesh(v, f, process=True)


def to_output_frame(center):
    m = np.eye(4)
    m[:3, :3] = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float) / 1000.0
    m[:3, 3] = -m[:3, :3] @ center
    return m


def marrow(m, structure):
    c = m.vertices.mean(0)
    rel = m.vertices - c
    if structure in UNIFORM:
        v = c + rel * 0.55
    else:
        _, _, vt = np.linalg.svd(rel, full_matrices=False)
        along = np.outer(rel @ vt[0], vt[0])
        v = c + along * 0.92 + (rel - along) * 0.5
    return trimesh.Trimesh(v, m.faces.copy(), process=False)


def main(src):
    meshes = []  # (node, structure, layer, mesh, source)
    seen = {}
    for pid, structure, layer in PARTS:
        m = trimesh.load(os.path.join(src, pid + ".stl"), force="mesh", process=True)
        budget = BIG.get(structure, BASE[layer])
        m = simplify(m, budget)
        seen[pid] = seen.get(pid, 0) + 1
        name = pid if seen[pid] == 1 else f"{pid}_{seen[pid]}"
        meshes.append((name, structure, layer, m, pid))

    for name, structure, layer, m, pid in list(meshes):
        if layer == "bone" and structure not in NO_MARROW:
            mm = simplify(marrow(m, structure), max(50, int(len(m.faces) * 0.4)))
            meshes.append((name + "_marrow", structure, "marrow", mm, pid))

    by_structure = {}
    for _, s, _, m, _ in meshes:
        by_structure.setdefault(s, []).append(m)
    by_structure = {s: trimesh.util.concatenate(ms) for s, ms in by_structure.items()}

    sch_keys = set()
    try:
        from lower_nerves import build_schematic
        for name, structure, layer, m in build_schematic(by_structure):
            meshes.append((name, structure, layer, m, "schematic"))
            sch_keys.add(structure)
            print(f"{name:14s} {structure:28s} {layer:7s} faces={len(m.faces)} (schematic)")
    except Exception as e:  # noqa: BLE001
        print(f"WARNING: schematic nerves/vessels skipped ({type(e).__name__}: {e})")

    bone_pts = np.vstack([m.vertices for _, _, l, m, _ in meshes if l == "bone"])
    center = (bone_pts.min(0) + bone_pts.max(0)) / 2
    xf = to_output_frame(center)

    scene = trimesh.Scene()
    nodes = []
    tris = {}
    for name, structure, layer, m, source in meshes:
        m = m.copy()
        m.apply_transform(xf)
        m.visual = trimesh.visual.ColorVisuals(m)
        scene.add_geometry(m, node_name=name, geom_name=name)
        nodes.append({"node": name, "structure": structure, "layer": layer, "source": source})
        tris[layer] = tris.get(layer, 0) + len(m.faces)

    def zsel(s, top):
        v = by_structure[s].vertices
        k = max(1, int(len(v) * 0.08))
        o = np.argsort(v[:, 2])
        return v[o[-k:] if top else o[:k]].mean(0)
    pts = np.array([zsel("femur", True), zsel("femur", False),
                    by_structure["talus"].vertices.mean(0), by_structure["phalanges_hallux"].vertices.mean(0)])
    pts = trimesh.transform_points(pts, xf).round(4)
    axis = {k: p.tolist() for k, p in zip(["hip", "knee", "ankle", "toe"], pts)}

    have = {n["structure"] for n in nodes}
    meta = {
        "version": 2,
        "source": "BodyParts3D 3.0 (DBCLS), CC BY 4.0, via github.com/Kevin-Mattheus-Moerman/BodyParts3D; "
                  "nerves and arteries below the pelvis are schematic (tools/lower_nerves.py)",
        "units": "m",
        "layers": LAYERS,
        "nodes": nodes,
        "structures": {k: v for k, v in STRUCTURES.items() if k in have},
        "regions": REGIONS,
        "axis": axis,
        "schematic": sorted(sch_keys),
    }
    os.makedirs(OUT, exist_ok=True)
    tmp = GLB + ".tmp.glb"
    scene.export(tmp)
    r = subprocess.run(["node", os.path.join(HERE, "quantize.mjs"), tmp, GLB], cwd=HERE)
    os.remove(tmp)
    if r.returncode:
        sys.exit("quantize failed")
    with open(os.path.join(OUT, "structures.json"), "w") as f:
        json.dump(meta, f, indent=1)
        f.write("\n")

    # ---- checks ----
    problems = []
    chk = subprocess.run(["node", "--input-type=module", "-e", """
import { NodeIO } from "@gltf-transform/core"; import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
const d = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(process.argv[1]);
let t=0; for (const m of d.getRoot().listMeshes()) for (const p of m.listPrimitives()) t+=p.getIndices().getCount()/3;
console.log(JSON.stringify({nodes:d.getRoot().listNodes().map(n=>n.getName()),ext:d.getRoot().listExtensionsUsed().map(e=>e.extensionName),tris:t}));
""", GLB], cwd=HERE, capture_output=True, text=True)
    info = json.loads(chk.stdout.strip().splitlines()[-1])
    gn, jn = set(info["nodes"]), {n["node"] for n in nodes}
    problems += [f"in json not GLB: {n}" for n in jn - gn] + [f"in GLB not json: {n}" for n in gn - jn]
    problems += [f"no display name: {n['structure']}" for n in nodes if n["structure"] not in STRUCTURES]
    if "KHR_mesh_quantization" not in info["ext"] or any("draco" in e.lower() for e in info["ext"]):
        problems.append(f"unexpected extensions {info['ext']}")
    total = sum(tris.values())
    for l in LAYERS + ["marrow"]:
        print(f"{l:9s} {tris.get(l, 0):8d} tris")
    print(f"total {total} tris (GLB reports {info['tris']:.0f}); extensions {info['ext']}")
    if total > 400000:
        print("WARNING: over 400k triangles")
    print(f"GLB {os.path.getsize(GLB) / 1e6:.2f} MB; nodes {len(nodes)}; structures {len(meta['structures'])}")
    print("axis", json.dumps(axis))
    qf = os.path.join(ROOT, "assets", "questions", "lower-limb.json")
    if os.path.exists(qf):
        q = json.load(open(qf))
        qs = q["questions"] if isinstance(q, dict) else q
        miss = sorted({f"{x.get('id', '?')}:{k}" for x in qs for k in
                       ([x["target"]] if isinstance(x.get("target"), str) else x.get("target", []) or []) +
                       ([x["accept"]] if isinstance(x.get("accept"), str) else x.get("accept", []) or [])
                       if k not in meta["structures"]})
        print("question keys missing from structures:", ", ".join(miss) if miss else "none")
    if problems:
        print("\n".join(problems))
        sys.exit(3)
    print("OK")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "source", "bodyparts3d"))
