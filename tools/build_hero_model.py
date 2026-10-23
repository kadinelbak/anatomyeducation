"""Build assets/model/hero.glb and assets/model/hero.json for the home-screen hero figure.

Source: BodyParts3D 3.0 (DBCLS), licence CC BY 4.0, (c) DBCLS.
Use a (blobless) clone of the GitHub mirror; the script fetches only the STL
files it needs, skipping any that are already checked out:

    git clone --filter=blob:none <BodyParts3D 3.0 mirror> bp3d
    python3 tools/build_hero_model.py --bp3d bp3d

Contents: the full skeleton (composites FMA71221 and FMA71222, plus the costal
cartilages BP24 and BP28), the skeletal muscles of the patient's LEFT half only
(composite FMA72954, parts whose bounding-box min x > -5 mm, heart/gut wall
muscle dropped) and nine organs.

Output contract (hero.glb):
  * metres, Y up, the figure faces +Z; the patient's left is +X (the viewer's
    right when seen from the front); centred on x and z, feet at y = 0.
    BodyParts3D (x left, y posterior, z up; mm) -> (x, z, -y) / 1000.
  * exactly three top-level nodes: bone, muscle, organ.
      bone   -> one merged mesh, geometry name "bone"
      muscle -> one merged mesh, geometry name "muscle"
      organ  -> heart, lung_right, lung_left, liver, stomach, small_intestine,
                large_intestine, kidney_right, kidney_left
  * one PBR material per mesh (metallic 0, roughness 0.75), no compression.
  * about 300k triangles, file size at most 4 MB.
hero.json records source, part counts, triangle total and height in metres.
"""
import argparse
import json
import os
import subprocess

import fast_simplification
import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "model")
DATA = os.path.join("assets", "BodyParts3D_data")
STL = DATA + "/stl"

# Triangle budgets per group; lowered automatically if the GLB exceeds MAX_BYTES.
BUDGET = {"bone": 140000, "muscle": 110000, "organ": 50000}
FACE_FLOOR = 200
MAX_BYTES = 4_000_000
MUSCLE_MIN_X = -5.0  # mm; keep parts with bounding-box min x above this (patient left)
SKIP_NAMES = ("layer of", "papillary")

# organ node name -> (composite ids to expand, single primitive ids), colour
ORGANS = {
    "heart": (["FMA7088"], [], 0xB83A3A),
    "lung_right": (["FMA7309"], [], 0xD9A0A0),
    "lung_left": (["FMA7310"], [], 0xD9A0A0),
    "liver": ([], ["FMA7197"], 0x8C3B2E),
    "stomach": ([], ["FMA7148"], 0xD8A284),
    "small_intestine": (["FMA7200"], [], 0xC98A7A),
    "large_intestine": (["FMA7201"], [], 0xC98A7A),
    "kidney_right": ([], ["FMA7204"], 0x8A3E4A),
    "kidney_left": ([], ["FMA7205"], 0x8A3E4A),
}
BONE_COMPOSITES = ["FMA71221", "FMA71222"]
BONE_EXTRA = ["BP24", "BP28"]  # costal cartilages
MUSCLE_COMPOSITE = "FMA72954"
BONE_COLOR, MUSCLE_COLOR = 0xEADFC8, 0xB0473F


def read_composites(bp3d):
    table = {}
    with open(os.path.join(bp3d, DATA, "composite_parts.txt"), encoding="utf-8") as f:
        next(f)
        for line in f:
            row = line.rstrip("\n").split("\t")
            if len(row) >= 4:
                table.setdefault(row[0], {}).setdefault(row[2], row[3])
    return table


def fetch(bp3d, ids):
    """Check out the STL files that are missing; return the ids that exist."""
    tree = subprocess.run(["git", "-C", bp3d, "ls-tree", "-r", "--name-only", "HEAD", STL + "/"],
                          check=True, capture_output=True, text=True).stdout.split("\n")
    in_repo = {os.path.basename(p)[:-4] for p in tree if p.endswith(".stl")}
    have = [i for i in ids if i in in_repo]
    todo = [i for i in have if not os.path.exists(os.path.join(bp3d, STL, i + ".stl"))]
    for k in range(0, len(todo), 100):
        batch = [f"{STL}/{i}.stl" for i in todo[k:k + 100]]
        subprocess.run(["git", "-C", bp3d, "checkout", "HEAD", "--"] + batch, check=True)
    missing = [i for i in ids if i not in in_repo]
    if missing:
        print("no STL for:", " ".join(missing))
    return have


def load(bp3d, part_id):
    return trimesh.load(os.path.join(bp3d, STL, part_id + ".stl"), force="mesh", process=True)


def simplify(mesh, faces):
    if len(mesh.faces) <= faces:
        return mesh
    ratio = 1.0 - faces / len(mesh.faces)
    v, f = fast_simplification.simplify(mesh.vertices.astype(np.float32), mesh.faces.astype(np.int32), ratio)
    return trimesh.Trimesh(v, f, process=True)


def simplify_group(meshes, budget):
    """Per-part target proportional to its face count, with a floor."""
    total = sum(len(m.faces) for m in meshes)
    out = []
    for m in meshes:
        target = max(FACE_FLOOR, int(budget * len(m.faces) / total))
        out.append(simplify(m, target))
    return out


def merge(meshes):
    return trimesh.util.concatenate(meshes)


def material(name, hex_color):
    rgba = [((hex_color >> s) & 255) / 255.0 for s in (16, 8, 0)] + [1.0]
    # Colours are sRGB; glTF baseColorFactor is linear.
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgba[:3]] + [1.0]
    return PBRMaterial(name=name, baseColorFactor=lin, metallicFactor=0.0, roughnessFactor=0.75)


def collect(bp3d):
    comp = read_composites(bp3d)
    names = {}
    for c in comp.values():
        names.update(c)

    def expand(cids, pids):
        ids = []
        for c in cids:
            ids += list(comp.get(c, {}))
        return ids + pids

    bone_ids = list(dict.fromkeys(expand(BONE_COMPOSITES, BONE_EXTRA)))
    muscle_ids = [i for i in comp[MUSCLE_COMPOSITE]
                  if not any(s in comp[MUSCLE_COMPOSITE][i].lower() for s in SKIP_NAMES)]
    organ_ids = {k: list(dict.fromkeys(expand(c, p))) for k, (c, p, _) in ORGANS.items()}
    every = set(bone_ids) | set(muscle_ids) | {i for v in organ_ids.values() for i in v}
    have = set(fetch(bp3d, sorted(every)))
    keep = lambda ids: [i for i in ids if i in have]  # noqa: E731
    bone_ids, muscle_ids = keep(bone_ids), keep(muscle_ids)
    organ_ids = {k: keep(v) for k, v in organ_ids.items()}

    bones = [load(bp3d, i) for i in bone_ids]
    muscles = []
    for i in muscle_ids:
        m = load(bp3d, i)
        if len(m.faces) and m.bounds[0][0] > MUSCLE_MIN_X:
            muscles.append(m)
    organs = {k: [load(bp3d, i) for i in v] for k, v in organ_ids.items()}
    print(f"bones {len(bones)}, muscles kept {len(muscles)} of {len(muscle_ids)}, "
          f"organ parts {sum(len(v) for v in organs.values())}")
    return bones, muscles, organs


def build(bones, muscles, organs, scale):
    """Simplify, merge, transform and export. Returns (glb bytes, stats)."""
    bone = merge(simplify_group(bones, BUDGET["bone"] * scale))
    muscle = merge(simplify_group(muscles, BUDGET["muscle"] * scale))
    flat = [(k, m) for k, ms in organs.items() for m in ms]
    organ_total = sum(len(m.faces) for _, m in flat)
    organ_meshes = {}
    for k, m in flat:
        t = max(FACE_FLOOR, int(BUDGET["organ"] * scale * len(m.faces) / organ_total))
        organ_meshes.setdefault(k, []).append(simplify(m, t))
    organ_meshes = {k: merge(v) for k, v in organ_meshes.items()}

    # BodyParts3D (x left, y posterior, z up; mm) -> metres, Y up, anterior +Z.
    rot = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float) / 1000.0
    pts = bone.vertices @ rot.T
    lo, hi = pts.min(0), pts.max(0)
    feet = min([lo[1]] + [(m.vertices @ rot.T)[:, 1].min() for m in [muscle, *organ_meshes.values()]])
    shift = np.array([-(lo[0] + hi[0]) / 2, -feet, -(lo[2] + hi[2]) / 2])
    xf = np.eye(4)
    xf[:3, :3] = rot
    xf[:3, 3] = shift

    scene = trimesh.Scene()
    ident = np.eye(4)
    for group in ("bone", "muscle", "organ"):
        scene.graph.update(frame_to=group, frame_from=scene.graph.base_frame, matrix=ident)

    def add(mesh, name, node, parent, color):
        mesh = trimesh.Trimesh(mesh.vertices, mesh.faces, process=False)
        mesh.apply_transform(xf)
        mesh.visual = trimesh.visual.TextureVisuals(material=material(name, color))
        mesh.vertex_normals  # noqa: B018  (computed so the GLB carries normals)
        scene.add_geometry(mesh, node_name=node, geom_name=name, parent_node_name=parent)

    add(bone, "bone", "bone_mesh", "bone", BONE_COLOR)
    add(muscle, "muscle", "muscle_mesh", "muscle", MUSCLE_COLOR)
    for k, m in organ_meshes.items():
        add(m, k, k, "organ", ORGANS[k][2])
    glb = scene.export(file_type="glb")
    height = float(scene.bounds[1][1] - scene.bounds[0][1])
    tris = {"bone": len(bone.faces), "muscle": len(muscle.faces),
            "organ": sum(len(m.faces) for m in organ_meshes.values())}
    return glb, tris, height


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bp3d", required=True, help="BodyParts3D 3.0 clone directory")
    args = ap.parse_args()
    bones, muscles, organs = collect(args.bp3d)

    # GLB cost is about 24 bytes per triangle (uint32 indices plus positions and normals).
    scale = min(1.0, 0.93 * MAX_BYTES / (24 * sum(BUDGET.values())))
    for _ in range(8):
        glb, tris, height = build(bones, muscles, organs, scale)
        print(f"scale {scale:.2f}: {sum(tris.values())} triangles, {len(glb) / 1e6:.2f} MB")
        if len(glb) <= MAX_BYTES:
            break
        scale *= 0.93 * MAX_BYTES / len(glb)
    else:
        raise SystemExit("could not fit the size budget")

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "hero.glb"), "wb") as f:
        f.write(glb)
    meta = {
        "source": "BodyParts3D 3.0 (DBCLS), CC BY 4.0",
        "parts": {"bone": len(bones), "muscle": len(muscles),
                  "organ": sum(len(v) for v in organs.values())},
        "triangles": sum(tris.values()),
        "heightM": round(height, 3),
    }
    with open(os.path.join(OUT, "hero.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print("triangles", tris, "height", meta["heightM"], "m")


if __name__ == "__main__":
    main()
