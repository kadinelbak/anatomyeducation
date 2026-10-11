"""Build assets/model/arm.glb and assets/model/structures.json from BodyParts3D 3.0.

Usage:
    python3 tools/build_model.py <dir with BodyParts3D .stl or .obj files>
    python3 tools/build_model.py --cached   # reuse the cropped meshes, rebuild nerves and GLB

Steps: crop every part to the forearm and hand, split long tendons off the
extrinsic muscles, simplify meshes for phones, add schematic nerves and
arteries (BodyParts3D has no forearm nerves), and export one GLB in metres,
Y up, palm facing +Z (anatomical position).
"""
import json
import os
import pickle
import sys

import fast_simplification
import numpy as np
import trimesh

sys.path.insert(0, os.path.dirname(__file__))
from parts import PARTS, STRUCTURES, TENDON_SPLIT  # noqa: E402
from nerves import build_schematic  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "model")

# Model crop along BodyParts3D z (mm, up): fingertips to just above the elbow.
Z_MIN, Z_MAX = 655.0, 1110.0
# Skin crop: the right arm sits at x < -185 mm in BodyParts3D space.
SKIN_X_MAX = -185.0
# Faces whose inward thickness is below this (mm) and that lie distal to
# TENDON_Z_MAX count as tendon.
TENDON_THICKNESS = 6.0
TENDON_Z_MAX = 890.0

FACE_BUDGET = {"bone": 2000, "muscle": 3500, "tendon": 2000, "skin": 20000}


def load(src, part_id):
    for ext in (".stl", ".obj"):
        p = os.path.join(src, part_id + ext)
        if os.path.exists(p):
            return trimesh.load(p, force="mesh", process=True)
    raise FileNotFoundError(part_id)


def crop(mesh, cap=True):
    planes = []
    if mesh.bounds[0][2] < Z_MIN:
        planes.append(((0, 0, Z_MIN), (0, 0, 1)))
    if mesh.bounds[1][2] > Z_MAX:
        planes.append(((0, 0, Z_MAX), (0, 0, -1)))
    for origin, normal in planes:
        try:
            mesh = mesh.slice_plane(origin, normal, cap=cap)
        except Exception:
            mesh = mesh.slice_plane(origin, normal, cap=False)
    return mesh


def crop_skin(mesh):
    mesh = mesh.slice_plane((0, 0, Z_MIN), (0, 0, 1))
    mesh = mesh.slice_plane((0, 0, Z_MAX), (0, 0, -1))
    mesh = mesh.slice_plane((SKIN_X_MAX, 0, 0), (-1, 0, 0))
    parts = mesh.split(only_watertight=False)
    # Keep the component closest to the forearm axis.
    target = np.array([-255.0, -100.0, 900.0])
    best = min(parts, key=lambda m: np.linalg.norm(m.vertices.mean(0) - target) - 0.001 * len(m.faces))
    return best


def simplify(mesh, faces):
    if len(mesh.faces) <= faces:
        return mesh
    ratio = 1.0 - faces / len(mesh.faces)
    v, f = fast_simplification.simplify(mesh.vertices.astype(np.float32), mesh.faces.astype(np.int32), ratio)
    return trimesh.Trimesh(v, f, process=True)


def face_thickness(mesh):
    """Distance from each face along its inward normal to the opposite wall."""
    origins = mesh.triangles_center - mesh.face_normals * 0.05
    dirs = -mesh.face_normals
    locs, ray_idx, _ = mesh.ray.intersects_location(origins, dirs, multiple_hits=False)
    thick = np.full(len(mesh.faces), 1e3)
    d = np.linalg.norm(locs - origins[ray_idx], axis=1)
    thick[ray_idx] = d
    return thick


def split_tendon(mesh):
    thick = face_thickness(mesh)
    z = mesh.triangles_center[:, 2]
    is_tendon = (thick < TENDON_THICKNESS) & (z < TENDON_Z_MAX)
    # Smooth the label over face neighbours so the split is not speckled.
    adj = mesh.face_adjacency
    for _ in range(3):
        votes = np.zeros(len(mesh.faces))
        counts = np.zeros(len(mesh.faces))
        np.add.at(votes, adj[:, 0], is_tendon[adj[:, 1]])
        np.add.at(votes, adj[:, 1], is_tendon[adj[:, 0]])
        np.add.at(counts, adj[:, 0], 1)
        np.add.at(counts, adj[:, 1], 1)
        is_tendon = (votes + is_tendon) / (counts + 1) > 0.5
    if is_tendon.sum() < 20:
        return mesh, None
    belly = mesh.submesh([np.where(~is_tendon)[0]], append=True)
    tendon = mesh.submesh([np.where(is_tendon)[0]], append=True)
    return belly, tendon


# BodyParts3D: x = patient left, y = posterior, z = up (mm).
# Output: metres, Y up, anterior (palm) toward +Z.
def to_output_frame(center):
    m = np.eye(4)
    m[:3, :3] = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float) / 1000.0
    m[:3, 3] = -m[:3, :3] @ center
    return m


def load_parts(src):
    meshes = []  # (node name, structure, layer, mesh)
    for part_id, structure, layer in PARTS:
        m = load(src, part_id)
        if layer == "skin":
            m = crop_skin(m)
        else:
            m = crop(m)
        if len(m.faces) == 0:
            continue
        if structure in TENDON_SPLIT:
            m = simplify(m, 12000)
            belly, tendon = split_tendon(m)
            meshes.append((part_id, structure, "muscle", simplify(belly, FACE_BUDGET["muscle"])))
            if tendon is not None:
                meshes.append((part_id + "_tendon", structure, "tendon", simplify(tendon, FACE_BUDGET["tendon"])))
        else:
            meshes.append((part_id, structure, layer, simplify(m, FACE_BUDGET[layer])))
        print(f"{part_id:10s} {structure:32s} {layer:7s} faces={len(meshes[-1][3].faces)}", flush=True)
    return meshes


def main(src):
    cache = os.path.join(os.path.dirname(__file__), ".cache.pkl")
    if src == "--cached":
        with open(cache, "rb") as f:
            meshes = pickle.load(f)
    else:
        meshes = load_parts(src)
        with open(cache, "wb") as f:
            pickle.dump(meshes, f)

    # Marrow: a copy of each bone shrunk about its long axis, so the
    # cross-section shows a cortex ring around a medullary core.
    for name, structure, layer, m in list(meshes):
        if layer != "bone":
            continue
        c = m.vertices.mean(0)
        _, _, vt = np.linalg.svd(m.vertices - c, full_matrices=False)
        long_axis = vt[0]
        rel = m.vertices - c
        along = np.outer(rel @ long_axis, long_axis)
        v = c + along * 0.92 + (rel - along) * 0.5
        meshes.append((name + "_marrow", structure, "marrow", trimesh.Trimesh(v, m.faces.copy(), process=False)))

    by_structure = {}
    for _, s, _, m in meshes:
        by_structure.setdefault(s, []).append(m)
    by_structure = {s: trimesh.util.concatenate(ms) for s, ms in by_structure.items()}
    for name, structure, layer, m in build_schematic(by_structure):
        meshes.append((name, structure, layer, m))
        print(f"{name:10s} {structure:32s} {layer:7s} faces={len(m.faces)} (schematic)")

    bone_pts = np.vstack([m.vertices for _, _, layer, m in meshes if layer == "bone"])
    center = (bone_pts.min(0) + bone_pts.max(0)) / 2
    xf = to_output_frame(center)

    scene = trimesh.Scene()
    nodes = []
    for name, structure, layer, m in meshes:
        m = m.copy()
        m.apply_transform(xf)
        m.visual = trimesh.visual.ColorVisuals(m)
        scene.add_geometry(m, node_name=name, geom_name=name)
        nodes.append({"node": name, "structure": structure, "layer": layer})

    # Forearm long axis (elbow centre to wrist centre) for the cross-section slider.
    hv = by_structure["humerus"].vertices
    elbow = hv[np.abs(hv[:, 2] - 1062) < 8].mean(0)
    wrist = by_structure["capitate"].vertices.mean(0)
    axis = trimesh.transform_points(np.array([elbow, wrist]), xf)

    os.makedirs(OUT, exist_ok=True)
    scene.export(os.path.join(OUT, "arm.glb"))
    meta = {
        "source": "BodyParts3D 3.0 (DBCLS), CC BY-SA 2.1 JP; nerves and arteries are schematic",
        "nodes": nodes,
        "structures": STRUCTURES,
        "axis": {"elbow": axis[0].round(4).tolist(), "wrist": axis[1].round(4).tolist()},
        "schematic": sorted({s for _, s, layer, _ in meshes if layer in ("nerve", "vessel")}),
    }
    with open(os.path.join(OUT, "structures.json"), "w") as f:
        json.dump(meta, f, indent=1)
    total = sum(len(m.faces) for *_, m in meshes)
    print(f"wrote arm.glb: {len(meshes)} meshes, {total} faces, "
          f"{os.path.getsize(os.path.join(OUT, 'arm.glb')) / 1e6:.1f} MB")


if __name__ == "__main__":
    main(sys.argv[1])
