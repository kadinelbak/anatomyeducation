#!/usr/bin/env python3
"""Merge TotalSegmentator per-structure masks (one 0/1 NIfTI per structure)
into one multilabel NIfTI, using a class map {value: key}.

    python3 tools/merge_masks.py --dir sXXXX/segmentations --classmap class_map_total_mr.json --out sXXXX/labels.nii.gz

Mask files are matched by name: <key>.nii.gz. Files whose name is not in the
class map are listed and skipped. Where masks overlap, the higher value wins.
Works for both the CT (total) and MRI (total_mr) datasets.
"""
import argparse, glob, json, os, sys
import numpy as np
import nibabel as nib

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True); ap.add_argument("--classmap", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    classmap = {int(k): v for k, v in json.load(open(a.classmap)).items()}
    key_to_val = {v: k for k, v in classmap.items()}
    files = sorted(glob.glob(os.path.join(a.dir, "*.nii.gz")) + glob.glob(os.path.join(a.dir, "*.nii")))
    if not files: sys.exit(f"no masks in {a.dir}")
    ref = nib.load(files[0])
    out = np.zeros(ref.shape[:3], dtype=np.uint16 if max(classmap) > 255 else np.uint8)
    used, skipped, empty = [], [], []
    for fn in files:
        key = os.path.basename(fn).replace(".nii.gz", "").replace(".nii", "")
        val = key_to_val.get(key)
        if val is None: skipped.append(key); continue
        m = np.asanyarray(nib.load(fn).dataobj)
        if m.shape[:3] != out.shape: sys.exit(f"{fn}: shape {m.shape} differs from {out.shape}")
        if m.ndim == 4: m = m[..., 0]
        sel = m > 0
        if not sel.any(): empty.append(key); continue
        out[sel] = val
        used.append(key)
    nib.save(nib.Nifti1Image(out, ref.affine, ref.header), a.out)
    print(json.dumps({"out": a.out, "shape": list(out.shape), "labels": len(used), "empty": empty, "skipped": skipped}, indent=1))

if __name__ == "__main__":
    main()
