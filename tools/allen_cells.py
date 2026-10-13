#!/usr/bin/env python3
"""Build real 3D cell studies from the Allen Institute for Cell Science
hiPSC Single-Cell Image Dataset (CC BY 4.0, Viana et al., Nature 2023).

Steps (see docs/allen-cells.md):
  1. SELECT   read small HTTP Range windows of the 1.7 GB metadata.csv (never the
              whole file) and pick one interphase cell (M0, not edge, not outlier)
              per structure.
  2. DOWNLOAD that cell's crop_seg OME-TIFF (a few hundred KB) into --cache.
  3. MESH     marching cubes on the membrane / DNA / structure masks (micrometres),
              light smoothing, decimation by marching-cubes step size, normalise
              (membrane bbox centre = origin, longest axis = 10 units), Z -> Y up.
  4. EXPORT   assets/cells/allen-<key>/{study.json, model.glb, model.glb.b64.txt}.

Usage:  python3 tools/allen_cells.py --out assets/cells --cells 4 [--cache DIR]
Needs numpy, scipy, scikit-image, tifffile, trimesh (no other installs).
"""
import argparse, ast, base64, csv, io, json, os, subprocess, sys, urllib.request
import numpy as np
import tifffile, trimesh
from scipy import ndimage as ndi
from skimage import measure

BASE = "https://allencell.s3.amazonaws.com/aics/hipsc_single_cell_image_dataset/"
# metadata.csv is grouped by structure; these byte offsets (MB) land inside each
# structure's block. We read a WINDOW_MB window from each.
STRUCTS = [
    # key, structure_name, offset_MB, label, GO id, colour
    ("mitochondria", "TOMM20", 0, "Mitochondria (TOMM20-tagged)", "GO:0005739", "#f0a04b"),
    ("er", "SEC61B", 400, "Endoplasmic reticulum (SEC61B-tagged)", "GO:0005783", "#4fa3b8"),
    ("golgi", "ST6GAL1", 500, "Golgi apparatus (ST6GAL1-tagged)", "GO:0005794", "#f2b84b"),
    ("nucleolus", "FBL", 1100, "Nucleolus (FBL-tagged)", "GO:0005730", "#e0607e"),
    ("microtubules", "TUBA1B", 0, "Microtubules (TUBA1B-tagged)", "GO:0005874", "#5fbf7a"),
]
WINDOW_MB = 6
TARGET = {"membrane": 20000, "nucleus": 10000, "structure": 30000}
SIZE = 10.0  # scene units for the membrane's longest axis


def http_range(url, a, b):
    req = urllib.request.Request(url, headers={"Range": f"bytes={a}-{b}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def read_header():
    return http_range(BASE + "metadata.csv", 0, 20000).decode("utf8", "replace").split("\n")[0]


def candidates(header, structure, off_mb):
    """Rows of one structure from a Range window; interphase, interior, not outlier."""
    a = off_mb * 1_000_000
    txt = http_range(BASE + "metadata.csv", a, a + WINDOW_MB * 1_000_000).decode("utf8", "replace")
    lines = txt.split("\n")
    lines = lines[1:-1] if off_mb else lines[1:-1]  # drop header/partial first and partial last
    rows = []
    for row in csv.DictReader(io.StringIO(header + "\n" + "\n".join(lines))):
        try:
            if (row["structure_name"] == structure and row["cell_stage"] == "M0"
                    and row["edge_flag"] in ("0", "False", "false")
                    and row["outlier"] in ("No", "", "False", "0") and row["crop_seg"]):
                rows.append(row)
        except (KeyError, TypeError):
            pass
    return rows


def pick(rows):
    # Deterministic: the median-membrane-volume cell, so it is neither tiny nor odd.
    def vol(r):
        try: return float(r["MEM_shape_volume"])
        except Exception: return 0.0
    rows = sorted([r for r in rows if vol(r) > 0], key=vol)
    return rows[len(rows) // 2]


def fetch_seg(row, cache):
    os.makedirs(cache, exist_ok=True)
    dst = os.path.join(cache, os.path.basename(row["crop_seg"]))
    if not os.path.exists(dst):
        with open(dst, "wb") as f:
            f.write(urllib.request.urlopen(BASE + row["crop_seg"], timeout=120).read())
    return dst


def load_masks(path, row):
    names = ast.literal_eval(row["name_dict"])["crop_seg"]  # never eval()
    arr = tifffile.imread(path)
    with tifffile.TiffFile(path) as t:
        axes = t.series[0].axes
    # reorder to C,Z,Y,X
    if "C" not in axes:
        arr = arr[None]; axes = "C" + axes
    arr = np.moveaxis(arr, [axes.index(a) for a in "CZYX"], [0, 1, 2, 3])
    ch = {n: arr[i] > 0 for i, n in enumerate(names)}
    return ch["membrane_segmentation"], ch["dna_segmentation"], ch["struct_segmentation"]


def to_mesh(mask, spacing, target, keep_min=30, largest=False):
    """Marching cubes in micrometres, coarsening step_size until under `target` tris.
    largest=True keeps only the biggest connected blob (cell, nucleus); otherwise
    blobs under keep_min voxels are dropped as specks (organelles)."""
    lab, n = ndi.label(mask)
    if n:
        sizes = np.asarray(ndi.sum(mask, lab, range(1, n + 1)))
        ids = [1 + int(sizes.argmax())] if largest else 1 + np.flatnonzero(sizes >= keep_min)
        keep = np.isin(lab, ids)
        mask = keep if keep.any() else mask
    f = ndi.gaussian_filter(np.pad(mask, 2).astype(np.float32), 0.8)
    best = None
    for step in (1, 2, 3, 4, 5, 6):
        v, fc, _, _ = measure.marching_cubes(f, 0.5, spacing=tuple(spacing), step_size=step)
        v -= np.array(spacing) * 2  # undo padding
        best = (v, fc)
        if len(fc) <= target:
            break
    m = trimesh.Trimesh(best[0], best[1], process=True)
    trimesh.smoothing.filter_taubin(m, lamb=0.5, nu=0.53, iterations=8)  # non-shrinking
    return m  # vertices in (z, y, x) micrometres


def to_three(m, centre, scale):
    """(z,y,x) um -> Three.js (X=x, Y=z up, Z=-y), centred and scaled."""
    z, y, x = m.vertices[:, 0], m.vertices[:, 1], m.vertices[:, 2]
    v = np.stack([x, z, -y], 1)
    v = (v - centre) * scale
    out = trimesh.Trimesh(v, m.faces[:, ::1], process=False)  # proper rotation: winding kept
    out.fix_normals()
    _ = out.vertex_normals
    return out


def build_cell(row, seg_path, outdir, spec):
    key, sname, _, label, go, colour = spec
    mem, dna, st = load_masks(seg_path, row)
    sp = ast.literal_eval(row["scale_micron"])  # [z,y,x] um per voxel
    # crops are boxes around the cell, so DNA / structure masks also contain
    # neighbouring cells: keep the biggest membrane blob and clip the rest to it.
    lab, n = ndi.label(mem)
    if n > 1:
        mem = lab == 1 + int(np.asarray(ndi.sum(mem, lab, range(1, n + 1))).argmax())
    inside = ndi.binary_dilation(mem, iterations=2)
    dna, st = dna & inside, st & inside
    meshes = {"membrane": to_mesh(mem, sp, TARGET["membrane"], largest=True),
              "nucleus": to_mesh(dna, sp, TARGET["nucleus"], largest=True),
              "structure": to_mesh(st, sp, TARGET["structure"])}
    # Axis-converted membrane bbox -> normalisation
    mv = meshes["membrane"].vertices
    p = np.stack([mv[:, 2], mv[:, 0], -mv[:, 1]], 1)
    lo, hi = p.min(0), p.max(0)
    centre = (lo + hi) / 2
    longest = float((hi - lo).max())
    scale = SIZE / longest
    scene = trimesh.Scene()
    stats = {}
    for name, m in meshes.items():
        t = to_three(m, centre, scale)
        scene.add_geometry(t, node_name=name, geom_name=name)
        stats[name] = {"triangles": int(len(t.faces)), "vertices": int(len(t.vertices))}
    glb = scene.export(file_type="glb")
    os.makedirs(outdir, exist_ok=True)
    open(os.path.join(outdir, "model.glb"), "wb").write(glb)
    open(os.path.join(outdir, "model.glb.b64.txt"), "w").write(base64.b64encode(glb).decode())
    study = manifest(row, spec, 1.0 / scale)
    json.dump(study, open(os.path.join(outdir, "study.json"), "w"), indent=2)
    return len(glb), stats, 1.0 / scale


def manifest(row, spec, mpu):
    key, sname, _, label, go, colour = spec
    mpu = round(mpu, 4)
    return {
        "id": f"allen-{key}", "kind": "cell",
        "title": f"Real cell: hiPSC with {label.split(' (')[0].lower()} (Allen Cell)",
        "cell": {"key": "cell", "id": "CL:0002248", "name": "Human induced pluripotent stem cell"},
        "synthetic": False,
        "source": f"Allen Institute for Cell Science, hiPSC Single-Cell Image Dataset (WTC-11 line), CellId {row['CellId']}, structure {row['structure_name']}",
        "sourceUrl": "https://open.quiltdata.com/b/allencell/packages/aics/hipsc_single_cell_image_dataset",
        "license": "CC BY 4.0 (Allen Institute Terms of Use; cite Viana et al., Nature 2023)",
        "attribution": "Allen Institute for Cell Science",
        "tissue": "UBERON:0000479", "tissues": [], "slides": [], "cells": ["CL:0002248"], "sections": [],
        "scale": f"A hiPSC is about 15-20 um across; this segmented cell is scaled so its longest axis is 10 scene units, so one unit is {mpu} micrometres",
        "model": "model.glb", "micronsPerUnit": mpu,
        "defaultView": "overview", "defaultLayers": ["membrane", "organelles"],
        "views": {"overview": {"eye": [0, 8, 17], "target": [0, 0, 0]},
                  "cutaway": {"eye": [11, 8, 11], "target": [0, 0, 0], "layers": ["organelles", "cutaway"]}},
        "parts": [
            {"key": "membrane", "name": "Cell membrane", "id": "GO:0005886", "layer": "membrane", "mesh": "membrane", "color": "#d9c9b3", "opacity": 0.35},
            {"key": "nucleus", "name": "Nucleus", "id": "GO:0005634", "layer": "organelles", "mesh": "nucleus", "color": "#6b5bd6", "opacity": 0.9},
            {"key": key, "name": label, "id": go, "layer": "organelles", "mesh": "structure", "color": colour},
        ],
        "provenance": {"CellId": row["CellId"], "FOVId": row["FOVId"], "structure_name": row["structure_name"],
                       "scale_micron": ast.literal_eval(row["scale_micron"]), "crop_seg": row["crop_seg"],
                       "cell_stage": row["cell_stage"]},
    }


def verify(outdir):
    s = trimesh.load(os.path.join(outdir, "model.glb"))
    names = sorted(s.graph.nodes_geometry)
    assert names == ["membrane", "nucleus", "structure"], names
    for g in s.geometry.values():
        assert len(g.vertex_normals) == len(g.vertices)
    return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="assets/cells")
    ap.add_argument("--cells", type=int, default=4, help="how many structures from STRUCTS (in order)")
    ap.add_argument("--cache", default="/tmp/allen_cache", help="download dir for crop_seg files")
    a = ap.parse_args()
    header = read_header()
    for spec in STRUCTS[:a.cells]:
        rows = candidates(header, spec[1], spec[2])
        if not rows:
            print("no candidate for", spec[1]); continue
        row = pick(rows)
        seg = fetch_seg(row, a.cache)
        outdir = os.path.join(a.out, f"allen-{spec[0]}")
        size, stats, mpu = build_cell(row, seg, outdir, spec)
        print(spec[0], "CellId", row["CellId"], "glb bytes", size, "um/unit %.4f" % mpu, stats, verify(outdir))


if __name__ == "__main__":
    main()
