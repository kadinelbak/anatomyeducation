#!/usr/bin/env python3
"""Turn a CT or MRI NIfTI plus a multilabel segmentation NIfTI into the app's
static study package (see docs/volume-format.md and mri/docs/mri-format.md).

Superset of imaging/tools/pack_study.py: with --modality CT (the default) the
output is byte-identical to the old script. With --modality MR the intensities
are rescaled to a fixed 0..4095 int16 range and the window presets are derived
from the image histogram instead of Hounsfield constants.

    python3 tools/pack_study.py --image t1.nii.gz --seg labels.nii.gz \
        --classmap class_map_total_mr.json --id ts-mr-0001 \
        --modality MR --sequence T1 --sequence-label "T1-weighted (VIBE, in-phase)" \
        --source "..." --license "CC BY 4.0" --attribution "..." \
        --out assets/volumes/ts-mr-0001 [--crop] [--max-dim 256] [--b64]

--ct is accepted as an alias of --image. Needs nibabel and numpy (scipy
optional, for --max-dim resampling).
"""
import argparse, base64, gzip, json, os, re, sys
import numpy as np
import nibabel as nib

GROUPS = [
    (r"^(lung_|trachea)", "lung"),
    (r"^(aorta|.*artery|.*vein|.*vena_cava|portal_vein|brachiocephalic|subclavian|iliac_artery|iliac_vena|pulmonary_vein)", "vessel"),
    (r"^(vertebrae|rib_|sacrum|hip|femur|humerus|scapula|clavicula|sternum|costal_cartilages|skull|intervertebral_discs|tibia|fibula)", "bone"),
    (r"^(gluteus|iliopsoas|autochthon|quadriceps|thigh_|sartorius)", "muscle"),
    (r"^(heart|atrial_appendage|left_atrium)", "heart"),
    (r"^(esophagus|stomach|duodenum|small_bowel|colon|urinary_bladder)", "hollow"),
    (r"^(.*ventricle|csf|choroid_plexus)", "csf"),
    (r"^(brain|spinal_cord|hippocampus|cerebral|cerebellum|thalamus|caudate|putamen|pallidum|amygdala|accumbens|ventral_diencephalon|optic_chiasm|corpus_callosum)", "nervous"),
]

OVERRIDES = {
    "autochthon_left": "Left erector spinae (autochthonous back muscles)",
    "autochthon_right": "Right erector spinae (autochthonous back muscles)",
    "portal_vein_and_splenic_vein": "Portal and splenic veins",
    "costal_cartilages": "Costal cartilages",
    "urinary_bladder": "Urinary bladder",
    "intervertebral_discs": "Intervertebral discs",
    "vertebrae": "Vertebrae",
    "quadriceps_femoris_left": "Left quadriceps femoris",
    "quadriceps_femoris_right": "Right quadriceps femoris",
    "thigh_medial_compartment_left": "Left medial thigh compartment (adductors)",
    "thigh_medial_compartment_right": "Right medial thigh compartment (adductors)",
    "thigh_posterior_compartment_left": "Left posterior thigh compartment (hamstrings)",
    "thigh_posterior_compartment_right": "Right posterior thigh compartment (hamstrings)",
    "prostate": "Prostate",
    "peripheral_zone": "Peripheral zone of the prostate",
    "transition_zone": "Transition zone of the prostate",
    "left_atrium": "Left atrium",
    "hippocampus_head": "Hippocampal head (anterior hippocampus)",
    "hippocampus_body": "Hippocampal body and tail (posterior hippocampus)",
    # MNI152 / FreeSurfer aseg brain structures
    "cerebral_white_matter_left": "Left cerebral white matter",
    "cerebral_cortex_left": "Left cerebral cortex",
    "lateral_ventricle_left": "Left lateral ventricle",
    "inferior_lateral_ventricle_left": "Left temporal horn of the lateral ventricle",
    "cerebellum_white_matter_left": "Left cerebellar white matter",
    "cerebellum_cortex_left": "Left cerebellar cortex",
    "thalamus_left": "Left thalamus",
    "caudate_left": "Left caudate nucleus",
    "putamen_left": "Left putamen",
    "pallidum_left": "Left globus pallidus",
    "third_ventricle": "Third ventricle",
    "fourth_ventricle": "Fourth ventricle",
    "brainstem": "Brainstem",
    "hippocampus_left": "Left hippocampus",
    "amygdala_left": "Left amygdala",
    "csf": "Cerebrospinal fluid outside the ventricles",
    "accumbens_left": "Left nucleus accumbens",
    "ventral_diencephalon_left": "Left ventral diencephalon (hypothalamus and subthalamic region)",
    "choroid_plexus_left": "Left choroid plexus",
    "cerebral_white_matter_right": "Right cerebral white matter",
    "cerebral_cortex_right": "Right cerebral cortex",
    "lateral_ventricle_right": "Right lateral ventricle",
    "inferior_lateral_ventricle_right": "Right temporal horn of the lateral ventricle",
    "cerebellum_white_matter_right": "Right cerebellar white matter",
    "cerebellum_cortex_right": "Right cerebellar cortex",
    "thalamus_right": "Right thalamus",
    "caudate_right": "Right caudate nucleus",
    "putamen_right": "Right putamen",
    "pallidum_right": "Right globus pallidus",
    "hippocampus_right": "Right hippocampus",
    "amygdala_right": "Right amygdala",
    "accumbens_right": "Right nucleus accumbens",
    "ventral_diencephalon_right": "Right ventral diencephalon (hypothalamus and subthalamic region)",
    "choroid_plexus_right": "Right choroid plexus",
    "optic_chiasm": "Optic chiasm",
    "corpus_callosum": "Corpus callosum",
}

# Hounsfield presets, unchanged from the CT packer.
CT_WINDOWS = {"soft": {"width": 400, "level": 40}, "lung": {"width": 1500, "level": -600},
              "bone": {"width": 1800, "level": 400}}
MR_RANGE = 4095  # stored intensity range after rescaling (0 = air/background)


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
    words = words.replace("iliac vena", "iliac vein")
    name = words[0].upper() + words[1:]
    return f"{side.capitalize()} {name[0].lower() + name[1:]}" if side else name


def group_of(key):
    for pat, g in GROUPS:
        if re.match(pat, key): return g
    return "organ"


def reorient(img, seg, spacing, codes):
    """Reorder stored axes labelled by `codes` (one of R/L, A/P, S/I per axis) into RAS.
    Some public NIfTIs (the Decathlon heart set) carry an identity affine, so the
    header cannot tell the renderer which way is up; this says it explicitly."""
    if sorted(c in "RL" for c in codes) != [False, False, True] or len(codes) != 3 or \
       sum(c in "AP" for c in codes) != 1 or sum(c in "SI" for c in codes) != 1:
        sys.exit(f"--axes must name one of R/L, A/P, S/I per axis, got {codes}")
    order, flips = [], []
    for want, opposite in (("R", "L"), ("A", "P"), ("S", "I")):
        ax = next(i for i, c in enumerate(codes) if c in (want, opposite))
        order.append(ax); flips.append(codes[ax] == opposite)
    img = np.transpose(img, order); seg = np.transpose(seg, order)
    spacing = [spacing[i] for i in order]
    for ax, f in enumerate(flips):
        if f: img = np.flip(img, ax); seg = np.flip(seg, ax)
    return np.ascontiguousarray(img), np.ascontiguousarray(seg), spacing


def mr_rescale(img):
    """Map arbitrary MR intensities onto 0..MR_RANGE. The 0.5th percentile of the
    non-background voxels becomes 0 and the 99.8th becomes MR_RANGE, so the
    presets below mean the same thing on every scanner and sequence."""
    fg = img[img > 0]
    if fg.size == 0: fg = img.ravel()
    lo, hi = np.percentile(fg, [0.5, 99.8])
    if hi <= lo: lo, hi = float(img.min()), float(img.max() or 1.0)
    out = (img - lo) / (hi - lo) * MR_RANGE
    return np.clip(out, 0, MR_RANGE), float(lo), float(hi)


def mr_windows(img, seg):
    """Presets from the histogram of the rescaled image. Levels and widths are
    in stored units, so a study.json reader needs no knowledge of the scanner."""
    fg = img[img > 0]
    p = lambda q: float(np.percentile(fg, q))
    p1, p50, p99 = p(1), p(50), p(99)
    full_w = max(100.0, p99 - p1)
    soft = {"width": round(full_w), "level": round((p1 + p99) / 2), "label": "Default"}
    # Narrower around the organ median: separates liver/muscle/spleen on T1 and T2.
    tissue = {"width": round(max(100.0, (p(90) - p(10)))), "level": round(p50), "label": "Tissue"}
    # Upper part of the range: fluid on T2, fat on T1, enhancing vessels on post-contrast.
    bright = {"width": round(max(100.0, MR_RANGE - p(70))), "level": round((MR_RANGE + p(70)) / 2), "label": "Bright"}
    # Lower part: cortical bone, air, flow voids, and dark structures on either weighting.
    dark = {"width": round(max(100.0, p(60))), "level": round(p(60) / 2), "label": "Dark"}
    return {"soft": soft, "tissue": tissue, "bright": bright, "dark": dark}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", "--ct", dest="image", required=True, help="CT or MR NIfTI")
    ap.add_argument("--seg", required=True)
    ap.add_argument("--classmap", required=True, help="JSON {value: key}")
    ap.add_argument("--id", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--modality", choices=["CT", "MR"], default="CT")
    ap.add_argument("--sequence", default="", help="MR only: short code, e.g. T1, T2, FLAIR, T1-contrast")
    ap.add_argument("--sequence-label", default="", help="MR only: text shown in the viewer badge, e.g. 'T1-weighted (VIBE)'")
    ap.add_argument("--source", default=""); ap.add_argument("--license", default="")
    ap.add_argument("--attribution", default="")
    ap.add_argument("--source-url", default="", help="link shown in the attribution footer")
    ap.add_argument("--crop", action="store_true", help="crop to the labelled bounding box plus a margin")
    ap.add_argument("--margin", type=int, default=8)
    ap.add_argument("--max-dim", type=int, default=0, help="downsample so no axis exceeds this many voxels")
    ap.add_argument("--b64", action="store_true", help="also write <file>.b64.txt copies for text-only hosts")
    ap.add_argument("--axes", default="", help="anatomical direction of the stored axes when the NIfTI header is wrong, "
                    "e.g. ASL (axis 0 runs to Anterior, 1 to Superior, 2 to patient Left); the arrays are reordered to RAS")
    a = ap.parse_args()
    if a.modality == "MR" and not a.sequence:
        sys.exit("--sequence is required for MR studies (T1, T2, ...)")

    img_img = nib.as_closest_canonical(nib.load(a.image))     # RAS
    seg_img = nib.as_closest_canonical(nib.load(a.seg))
    img = np.asanyarray(img_img.dataobj).astype(np.float32)
    if img.ndim == 4: img = img[..., 0]                        # first channel of a multi-channel MR
    seg = np.asanyarray(seg_img.dataobj)
    if seg.ndim == 4: seg = seg[..., 0]
    if img.shape != seg.shape:
        sys.exit(f"shape mismatch: image {img.shape} vs seg {seg.shape}")
    spacing = [float(z) for z in img_img.header.get_zooms()[:3]]
    if a.axes:
        img, seg, spacing = reorient(img, seg, spacing, a.axes.upper())

    if a.crop:
        nz = np.argwhere(seg > 0)
        lo = np.maximum(nz.min(0) - a.margin, 0); hi = np.minimum(nz.max(0) + a.margin + 1, seg.shape)
        sl = tuple(slice(l, h) for l, h in zip(lo, hi))
        img, seg = img[sl], seg[sl]

    if a.max_dim and max(img.shape) > a.max_dim:
        from scipy.ndimage import zoom
        f = a.max_dim / max(img.shape)
        img = zoom(img, f, order=1); seg = zoom(seg, f, order=0)
        spacing = [s / f for s in spacing]

    intensity = None
    if a.modality == "MR":
        img, raw_lo, raw_hi = mr_rescale(img)
        windows = mr_windows(img, seg)
        intensity = {"units": "arbitrary", "stored_range": [0, MR_RANGE],
                     "rescaled_from": [round(raw_lo, 2), round(raw_hi, 2)],
                     "note": "0.5th..99.8th percentile of the source image mapped to 0..4095"}
    else:
        windows = json.loads(json.dumps(CT_WINDOWS))

    classmap = {int(k): v for k, v in json.load(open(a.classmap)).items()}
    present = sorted(int(v) for v in np.unique(seg) if v != 0)
    structures = {}
    for v in present:
        key = classmap.get(v, f"label_{v}")
        structures[str(v)] = {"key": key, "name": display_name(key), "group": group_of(key)}

    # Named views: the slice through each structure's centroid. Axial unless the centroid slice holds
    # none of the structure (a thin or curved structure such as intervertebral discs), then coronal,
    # then sagittal, so the structure is clickable from the question's starting view.
    views = {}
    axis_of = {"axial": 2, "coronal": 1, "sagittal": 0}
    for v in present:
        idx = np.argwhere(seg == v)
        c = idx.mean(0)
        key = structures[str(v)]["key"]
        for plane in ("axial", "coronal", "sagittal"):
            ax = axis_of[plane]
            d = int(round(c[ax]))
            if (np.take(seg, d, axis=ax) == v).any():
                break
        views[key] = {"plane": plane, "frac": round(float(d / (seg.shape[ax] - 1)), 3), "window": "soft"}

    os.makedirs(a.out, exist_ok=True)
    vox = np.clip(np.rint(img), -32768, 32767).astype("<i2")
    lab = seg.astype(np.uint8 if seg.max() < 256 else "<u2")
    imgfile = "ct.i16.gz" if a.modality == "CT" else "image.i16.gz"
    with gzip.open(os.path.join(a.out, imgfile), "wb", 9) as f: f.write(vox.tobytes(order="F"))
    labfile = "labels.u8.gz" if lab.dtype == np.uint8 else "labels.u16.gz"
    with gzip.open(os.path.join(a.out, labfile), "wb", 9) as f: f.write(lab.tobytes(order="F"))
    manifest = {
        "id": a.id, "source": a.source, "license": a.license, "attribution": a.attribution,
        "dims": list(map(int, img.shape)), "spacing": [round(s, 4) for s in spacing], "orientation": "RAS",
        "modality": a.modality,
    }
    if a.source_url: manifest["sourceUrl"] = a.source_url
    if a.modality == "MR":
        manifest["sequence"] = a.sequence
        manifest["sequenceLabel"] = a.sequence_label or a.sequence
        manifest["intensity"] = intensity
        manifest["image"] = {"file": imgfile, "dtype": "int16"}
    # "ct" is kept as the image entry's name for the existing loader (src/volume.js reads meta.ct.file).
    manifest["ct"] = {"file": imgfile, "dtype": "int16"}
    manifest["labels"] = {"file": labfile, "dtype": "uint8" if lab.dtype == np.uint8 else "uint16"}
    manifest["defaultWindow"] = "soft"
    manifest["windows"] = windows
    manifest["structures"] = structures
    manifest["views"] = views
    json.dump(manifest, open(os.path.join(a.out, "study.json"), "w"), indent=1)
    if a.b64:
        for fn in (imgfile, labfile):
            with open(os.path.join(a.out, fn), "rb") as f, open(os.path.join(a.out, fn + ".b64.txt"), "w") as o:
                o.write(base64.b64encode(f.read()).decode())
    sizes = {f: os.path.getsize(os.path.join(a.out, f)) for f in os.listdir(a.out)}
    print(json.dumps({"dims": manifest["dims"], "spacing": manifest["spacing"], "modality": a.modality,
                      "structures": len(structures), "windows": windows, "files": sizes}, indent=1))


if __name__ == "__main__":
    main()
