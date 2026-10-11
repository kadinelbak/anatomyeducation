#!/usr/bin/env python3
"""Turn a CT NIfTI plus a TotalSegmentator multilabel NIfTI into the app's
static study package (see docs/volume-format.md).

    python3 tools/pack_study.py --ct ct.nii.gz --seg seg.nii.gz \
        --classmap class_map_total.json --id ts-example-sm \
        --source "..." --license "CC BY 4.0" --attribution "..." \
        --out assets/volumes/ts-example-sm [--crop] [--max-dim 256]

Needs nibabel and numpy (scipy optional, for resampling with --max-dim).
"""
import argparse, gzip, json, os, re, sys
import numpy as np
import nibabel as nib

GROUPS = [
    (r"^(lung_|trachea)", "lung"),
    (r"^(aorta|.*artery|.*vein|.*vena_cava|portal_vein|brachiocephalic|subclavian|iliac_artery|iliac_vena|pulmonary_vein)", "vessel"),
    (r"^(vertebrae_|rib_|sacrum|hip|femur|humerus|scapula|clavicula|sternum|costal_cartilages|skull)", "bone"),
    (r"^(gluteus|iliopsoas|autochthon)", "muscle"),
    (r"^(heart|atrial_appendage)", "heart"),
    (r"^(esophagus|stomach|duodenum|small_bowel|colon|urinary_bladder)", "hollow"),
    (r"^(brain|spinal_cord)", "nervous"),
]

OVERRIDES = {
    "autochthon_left": "Left erector spinae (autochthonous back muscles)",
    "autochthon_right": "Right erector spinae (autochthonous back muscles)",
    "portal_vein_and_splenic_vein": "Portal and splenic veins",
    "costal_cartilages": "Costal cartilages",
    "urinary_bladder": "Urinary bladder",
}

def display_name(key):
    if key in OVERRIDES: return OVERRIDES[key]
    m = re.match(r"^vertebrae_([CTLS]\d+|S1)$", key)
    if m: return f"{m.group(1)} vertebra"
    m = re.match(r"^rib_(left|right)_(\d+)$", key)
    if m: return f"{m.group(1).capitalize()} rib {m.group(2)}"
    side = None
    base = key
    for s in ("_left", "_right"):
        if key.endswith(s):
            side, base = s[1:], key[: -len(s)]
    words = base.replace("_", " ")
    words = words.replace("vena cava", "vena cava").replace("iliac vena", "iliac vein")
    name = words[0].upper() + words[1:]
    return f"{side.capitalize()} {name[0].lower() + name[1:]}" if side else name

def group_of(key):
    for pat, g in GROUPS:
        if re.match(pat, key): return g
    return "organ"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ct", required=True); ap.add_argument("--seg", required=True)
    ap.add_argument("--classmap", required=True, help="JSON {value: key}")
    ap.add_argument("--id", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--source", default=""); ap.add_argument("--license", default="")
    ap.add_argument("--attribution", default="")
    ap.add_argument("--crop", action="store_true", help="crop to the labelled bounding box plus a margin")
    ap.add_argument("--margin", type=int, default=8)
    ap.add_argument("--max-dim", type=int, default=0, help="downsample so no axis exceeds this many voxels")
    a = ap.parse_args()

    ct_img = nib.as_closest_canonical(nib.load(a.ct))     # RAS
    seg_img = nib.as_closest_canonical(nib.load(a.seg))
    ct = np.asanyarray(ct_img.dataobj).astype(np.float32)
    if ct_img.dataobj.slope not in (None, 1.0) or ct_img.dataobj.inter not in (None, 0.0):
        pass  # nibabel applies slope/intercept in get_fdata; dataobj.astype applied them too
    seg = np.asanyarray(seg_img.dataobj)
    if ct.shape != seg.shape:
        sys.exit(f"shape mismatch: ct {ct.shape} vs seg {seg.shape}")
    spacing = [float(z) for z in ct_img.header.get_zooms()[:3]]

    if a.crop:
        nz = np.argwhere(seg > 0)
        lo = np.maximum(nz.min(0) - a.margin, 0); hi = np.minimum(nz.max(0) + a.margin + 1, seg.shape)
        sl = tuple(slice(l, h) for l, h in zip(lo, hi))
        ct, seg = ct[sl], seg[sl]

    if a.max_dim and max(ct.shape) > a.max_dim:
        from scipy.ndimage import zoom
        f = a.max_dim / max(ct.shape)
        ct = zoom(ct, f, order=1); seg = zoom(seg, f, order=0)
        spacing = [s / f for s in spacing]

    classmap = {int(k): v for k, v in json.load(open(a.classmap)).items()}
    present = sorted(int(v) for v in np.unique(seg) if v != 0)
    structures = {}
    for v in present:
        key = classmap.get(v, f"label_{v}")
        structures[str(v)] = {"key": key, "name": display_name(key), "group": group_of(key)}

    # Named views: an axial slice through each structure's centroid, by key.
    views = {}
    for v in present:
        idx = np.argwhere(seg == v)
        c = idx.mean(0)
        key = structures[str(v)]["key"]
        views[key] = {"plane": "axial", "frac": round(float(c[2] / (seg.shape[2] - 1)), 3), "window": "soft"}

    os.makedirs(a.out, exist_ok=True)
    ct16 = np.clip(np.rint(ct), -32768, 32767).astype("<i2")
    lab = seg.astype(np.uint8 if seg.max() < 256 else "<u2")
    # Fortran order so x varies fastest (index = i + nx*(j + ny*k)).
    with gzip.open(os.path.join(a.out, "ct.i16.gz"), "wb", 9) as f: f.write(ct16.tobytes(order="F"))
    labfile = "labels.u8.gz" if lab.dtype == np.uint8 else "labels.u16.gz"
    with gzip.open(os.path.join(a.out, labfile), "wb", 9) as f: f.write(lab.tobytes(order="F"))
    manifest = {
        "id": a.id, "source": a.source, "license": a.license, "attribution": a.attribution,
        "dims": list(map(int, ct.shape)), "spacing": [round(s, 4) for s in spacing], "orientation": "RAS",
        "ct": {"file": "ct.i16.gz", "dtype": "int16"},
        "labels": {"file": labfile, "dtype": "uint8" if lab.dtype == np.uint8 else "uint16"},
        "windows": {"soft": {"width": 400, "level": 40}, "lung": {"width": 1500, "level": -600},
                    "bone": {"width": 1800, "level": 400}},
        "structures": structures, "views": views,
    }
    json.dump(manifest, open(os.path.join(a.out, "study.json"), "w"), indent=1)
    sizes = {f: os.path.getsize(os.path.join(a.out, f)) for f in os.listdir(a.out)}
    print(json.dumps({"dims": manifest["dims"], "spacing": manifest["spacing"], "structures": len(structures), "files": sizes}, indent=1))

if __name__ == "__main__":
    main()
