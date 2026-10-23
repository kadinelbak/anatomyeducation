#!/usr/bin/env python3
"""Download slabs of the NLM Visible Human Male CT and pack them as app studies.

Source: NCI Imaging Data Commons collection `nlm_visible_human_project` (public bucket
s3://idc-open-data, anonymous HTTPS), same data as
https://data.lhncbc.nlm.nih.gov/public/Visible-Human/. Public domain; credit
"Courtesy of the U.S. National Library of Medicine".

    python3 tools/live/import_visible_human.py --raw /path/scratch/vh_raw \
        --work /path/scratch/vh_work [--regions forearm,thigh,leg,head-neck] \
        [--labels threshold|totalseg] [--out-root assets/volumes] [--keep-raw]

    python3 tools/live/import_visible_human.py --selftest      # synthetic data, no network

Steps per region: fetch the DICOM series (cached in --raw), build an HU volume,
isolate the limb (see REGIONS: bounding box plus per-slice component rule, because the
cadaver's arms lie beside the trunk), downsample to about 2 mm voxels, label, and call
tools/pack_study.py to write assets/volumes/vh-<region>/.

Labels: `threshold` writes coarse labels (1 bone HU>250 with the marrow filled in limbs,
2 soft tissue, 3 fat, 4 internal gas). `totalseg` (used for the shipped studies) runs
TotalSegmentator (pip install TotalSegmentator; Apache-2.0 weights; --fast total task,
about 15 s per slab on 4 CPU cores once the weights are cached; set TOTALSEG_BIN and
TOTALSEG_HOME_DIR if needed) on the cropped CT, lets its labels win and keeps the threshold
labels (ids 201-204) elsewhere. Single limbs are relabelled right-sided (the net guesses sides).
Requires numpy, scipy, nibabel, pydicom, requests.
"""
import argparse, gzip, json, os, re, subprocess, sys, tempfile
import numpy as np

BUCKET = "https://idc-open-data.s3.amazonaws.com/"
# DICOM series (IDC SeriesInstanceUID prefix -> bucket folder). z is the table position in mm
# (ImagePositionPatient[2]); within each series slices are 1 mm apart, index 0 is the lowest z.
SERIES = {
    # VHP-M CT, 1 mm, head to pelvis, 844 slices, z -863..-20 (index 0 = pelvis, 843 = vertex)
    "head-pelvis": {"folder": "f3a311eb-3abb-4b22-a28d-36ede7ddf127", "n": 844, "z0": -863,
                    "uid": "1.3.6.1.4.1.5962.1.3.32.4.1672334394.26545"},
    # VHP-M CT, 1 mm, pelvis to shins, 809 slices, z -978..-170 (index 0 = lower leg, 808 = pelvis)
    "pelvis-legs": {"folder": "aa81356d-32f2-4b71-ad81-c1defa3175ca", "n": 809, "z0": -978,
                    "uid": "1.3.6.1.4.1.5962.1.3.34.3.1672334394.26545"},
}
# slab: z index range [i0, i1) in the series; bbox in source pixels (x0, x1, y0, y1) with x towards the
# patient's left and y posterior (DICOM LPS), so the subject's right side is the low-x half;
# rule: how to drop everything that is not the target.
REGIONS = {
    "forearm": dict(series="head-pelvis", idx=(0, 210), bbox=(0, 290, 20, 350), rule="free-components",
                    fill_bone=True, region="forearm", title="Right forearm and hand (Visible Human male CT)"),
    "thigh": dict(series="pelvis-legs", idx=(500, 700), bbox=(0, 262, 100, 420), rule="largest",
                  fill_bone=True, region="thigh", title="Right thigh (Visible Human male CT)"),
    "leg": dict(series="pelvis-legs", idx=(0, 380), bbox=(0, 262, 100, 440), rule="largest",
                fill_bone=True, region="leg", title="Right lower leg (Visible Human male CT)"),
    "head-neck": dict(series="head-pelvis", idx=(590, 844), bbox=(60, 460, 30, 470), rule="largest",
                      fill_bone=False, region="head", title="Head and neck (Visible Human male CT)"),
}
TARGET_MM = 2.0
CREDIT = "Courtesy of the U.S. National Library of Medicine"
LABELS = {1: "bone", 2: "soft_tissue", 3: "fat", 4: "internal_gas"}
NAMES = {"bone": "Bone (HU above 250)", "soft_tissue": "Soft tissue (muscle, skin, organs)",
         "fat": "Fat", "internal_gas": "Gas inside the body"}


def list_keys(folder):
    import requests
    out, tok = [], None
    while True:
        p = {"list-type": "2", "prefix": folder + "/"}
        if tok: p["continuation-token"] = tok
        t = requests.get(BUCKET, params=p, timeout=60).text
        out += re.findall(r"<Key>(.*?)</Key>", t)
        m = re.search(r"<NextContinuationToken>(.*?)</NextContinuationToken>", t)
        if not m: return out
        tok = m.group(1)


def fetch_series(name, raw):
    import requests
    from concurrent.futures import ThreadPoolExecutor
    folder = SERIES[name]["folder"]
    d = os.path.join(raw, folder); os.makedirs(d, exist_ok=True)
    keys = list_keys(folder)
    def get(k):
        f = os.path.join(raw, k)
        if os.path.exists(f) and os.path.getsize(f) > 0: return
        r = requests.get(BUCKET + k, timeout=120); r.raise_for_status()
        with open(f + ".part", "wb") as o: o.write(r.content)
        os.replace(f + ".part", f)
    with ThreadPoolExecutor(8) as ex: list(ex.map(get, keys))
    return d


def load_series(d, i0, i1, z0):
    """HU volume [z, y, x] for slices z0+i0 .. z0+i1-1, plus in-plane spacing in mm."""
    import pydicom
    want = {z0 + i for i in range(i0, i1)}
    items, sp = [], None
    for f in os.listdir(d):
        if not f.endswith(".dcm"): continue
        ds = pydicom.dcmread(os.path.join(d, f), stop_before_pixels=True)
        z = int(round(float(ds.ImagePositionPatient[2])))
        if z not in want: continue
        ds = pydicom.dcmread(os.path.join(d, f))
        a = ds.pixel_array.astype(np.float32) + float(ds.RescaleIntercept) * float(ds.get("RescaleSlope", 1))
        items.append((z, a)); sp = float(ds.PixelSpacing[0])
    items.sort(key=lambda t: t[0])
    if len(items) != len(want): sys.exit(f"expected {len(want)} slices, found {len(items)} in {d}")
    return np.stack([a for _, a in items]), sp


def isolate(vol, bbox, rule):
    """Crop to bbox (x0,x1,y0,y1) and blank everything that is not the target. Returns (vol, keep)."""
    from scipy import ndimage as ndi
    x0, x1, y0, y1 = bbox
    v = vol[:, y0:y1, x0:x1].copy()
    keep = np.zeros(v.shape, bool)
    st = ndi.generate_binary_structure(2, 1)
    # free-components needs a stricter body mask (-150 HU, opened 3x) to cut thin bridges to the trunk/bed
    thr, it = (-150, 3) if rule == "free-components" else (-300, 1)
    for k in range(v.shape[0]):
        body = ndi.binary_opening(v[k] > thr, st, iterations=it)
        lab, n = ndi.label(body, st)
        if n == 0: continue
        areas = ndi.sum(body, lab, range(1, n + 1))
        if rule == "largest":
            ids = [int(np.argmax(areas)) + 1]
        else:  # free-components: drop components that reach the box's medial (right) edge, the trunk crosses it
            border = set(np.unique(lab[:, -1])) - {0}
            ids = [i + 1 for i in range(n) if (i + 1) not in border and areas[i] >= 25]
        m = np.isin(lab, ids)
        keep[k] = ndi.binary_dilation(ndi.binary_fill_holes(m), st, iterations=2)
    v[~keep] = -1024
    return v, keep


def threshold_labels(ct, keep, fill_bone):
    from scipy import ndimage as ndi
    lab = np.zeros(ct.shape, np.uint8)
    body = keep
    lab[body & (ct >= -190) & (ct <= 250)] = 2
    lab[body & (ct < -30) & (ct >= -190)] = 3
    lab[body & (ct < -190)] = 3
    lab[body & (ct < -400)] = 4
    bone = body & (ct > 250)
    bone = ndi.binary_opening(bone, iterations=1) | (bone & ndi.binary_dilation(ndi.binary_opening(bone, iterations=1), iterations=1))
    if fill_bone:
        for k in range(bone.shape[0]):
            bone[k] = ndi.binary_fill_holes(ndi.binary_closing(bone[k], iterations=1))
    lab[bone] = 1
    # gas outside the largest air region of the body mask is external, drop stray slivers
    return lab


def downsample(ct, lab, sp):
    """Block-average to about TARGET_MM voxels in plane and along z (source z spacing 1 mm)."""
    f = max(1, int(round(TARGET_MM / sp)))
    fz = max(1, int(round(TARGET_MM / 1.0)))
    nz, ny, nx = (s // g * g for s, g in zip(ct.shape, (fz, f, f)))
    c = ct[:nz, :ny, :nx].reshape(nz // fz, fz, ny // f, f, nx // f, f).mean((1, 3, 5))
    l = lab[:nz, :ny, :nx].reshape(nz // fz, fz, ny // f, f, nx // f, f)
    # label of a block: bone if any voxel is bone, else the most frequent non-zero, else 0
    flat = l.transpose(0, 2, 4, 1, 3, 5).reshape(nz // fz, ny // f, nx // f, -1)
    cnt = np.stack([(flat == k).sum(-1) for k in range(5)], -1)
    out = cnt[..., 1:].argmax(-1).astype(np.uint8) + 1
    out[cnt[..., 1:].sum(-1) * 2 < flat.shape[-1]] = 0
    out[cnt[..., 1] * 4 >= flat.shape[-1]] = 1
    return c, out, (f * sp, f * sp, fz * 1.0)


def write_nifti(arr_zyx, spacing, path, dtype):
    import nibabel as nib
    a = np.transpose(arr_zyx, (2, 1, 0)).astype(dtype)   # [x, y, z]; x to patient left, y posterior
    aff = np.diag([-spacing[0], -spacing[1], spacing[2], 1.0])  # LPS array -> RAS world
    nib.save(nib.Nifti1Image(a, aff), path)


def pack(name, spec, ct, lab, spacing, work, out_root, labels_note, classmap=None):
    here = os.path.dirname(os.path.abspath(__file__))
    pack_py = os.path.join(here, "..", "pack_study.py")
    os.makedirs(work, exist_ok=True)
    ctp, lp, cm = (os.path.join(work, f"{name}-{s}") for s in ("ct.nii.gz", "labels.nii.gz", "classmap.json"))
    write_nifti(ct, spacing, ctp, np.float32); write_nifti(lab, spacing, lp, np.uint8)
    json.dump({str(k): v for k, v in (classmap or LABELS).items()}, open(cm, "w"))
    out = os.path.join(out_root, "vh-" + name)
    cmd = [sys.executable, pack_py, "--image", ctp, "--seg", lp, "--classmap", cm, "--id", "vh-" + name,
           "--out", out, "--source", "NLM Visible Human Project, male CT (NCI Imaging Data Commons, nlm_visible_human_project)",
           "--license", "Public domain (NLM Terms and Conditions, 2019)", "--attribution", CREDIT,
           "--source-url", "https://www.nlm.nih.gov/research/visible/visible_human.html"]
    subprocess.run(cmd, check=True)
    mp = os.path.join(out, "study.json")
    m = json.load(open(mp))
    m["note"] = ("Cadaver CT, 1 mm source resampled to about 2 mm. " + labels_note +
                 " Copy may not reflect NLM's current data.")
    m["labelsMethod"] = labels_note
    for s in m["structures"].values():
        s["name"] = NAMES.get(s["key"], s["name"])
        if s["key"] == "bone": s["group"] = "bone"
    json.dump(m, open(mp, "w"), indent=1)
    size = sum(os.path.getsize(os.path.join(out, f)) for f in os.listdir(out))
    print(f"vh-{name}: dims {m['dims']} spacing {m['spacing']} bytes {size}")
    return out


def run_totalseg(ct_nii, work, name):
    """Run TotalSegmentator (total task, --fast, CPU) and return (label array [z,y,x], class map)."""
    import nibabel as nib
    outd = os.path.join(work, name + "-seg")
    subprocess.run([os.environ.get("TOTALSEG_BIN", "TotalSegmentator"), "-i", ct_nii, "-o", outd, "--ml", "--fast",
                    "--device", os.environ.get("TOTALSEG_DEVICE", "cpu")], check=True)
    seg = np.asanyarray(nib.load(outd + ".nii" if os.path.exists(outd + ".nii") else outd).dataobj).astype(np.uint8)
    from totalsegmentator.map_to_binary import class_map
    return np.transpose(seg, (2, 1, 0)), {int(k): v for k, v in class_map["total"].items()}


# threshold labels sit above TotalSegmentator's 1..117 when both are merged
MERGED = {201: "bone", 202: "soft_tissue", 203: "fat", 204: "internal_gas"}


def merge_totalseg(thr, seg, cmap, single_right_limb):
    """TotalSegmentator labels win; every other body voxel keeps its threshold label (ids 201..204).
    A single limb cropped from the right side is relabelled right when the network guessed left."""
    if single_right_limb:
        by_name = {v: k for k, v in cmap.items()}
        remap = np.arange(256, dtype=np.uint8)
        for k, v in cmap.items():
            if v.endswith("_left") and v[:-5] + "_right" in by_name: remap[k] = by_name[v[:-5] + "_right"]
        seg = remap[seg]
    out = np.zeros(thr.shape, np.uint8)
    for k, base in ((1, 201), (2, 202), (3, 203), (4, 204)): out[thr == k] = base
    out[seg > 0] = seg[seg > 0]
    cm = dict(cmap); cm.update(MERGED)
    used = set(int(v) for v in np.unique(out) if v)
    return out, {k: v for k, v in cm.items() if k in used}


def process(name, ct_full, sp, work, out_root, labels):
    spec = REGIONS[name]
    v, keep = isolate(ct_full, spec["bbox"], spec["rule"])
    nz = np.argwhere(keep.any(0))                      # auto-crop to the target
    if len(nz) == 0: sys.exit(f"{name}: nothing kept, check the bbox")
    (ya, xa), (yb, xb) = nz.min(0), nz.max(0)
    m = 6
    ya, xa = max(ya - m, 0), max(xa - m, 0)
    v, keep = v[:, ya:yb + m + 1, xa:xb + m + 1], keep[:, ya:yb + m + 1, xa:xb + m + 1]
    lab = threshold_labels(v, keep, spec["fill_bone"])
    ct, l, spacing = downsample(v, lab, sp)
    ct = np.where(l == 0, np.minimum(ct, -1000), ct)   # outside the target stays air
    if labels == "totalseg":
        os.makedirs(work, exist_ok=True)
        tmp = os.path.join(work, f"{name}-ct.nii.gz"); write_nifti(ct, spacing, tmp, np.float32)
        seg, cmap = run_totalseg(tmp, work, name)
        l, cm = merge_totalseg(l, seg, cmap, name != "head-neck")
        note = ("Labels: TotalSegmentator v2 total task (--fast, 3 mm model, Apache-2.0 weights) where it finds a structure, "
                "coarse HU thresholds (bone above 250 HU, soft tissue, fat, gas) everywhere else.")
        return pack(name, spec, ct, l, spacing, work, out_root, note, cm)
    note = ("Labels are coarse HU thresholds (bone above 250 HU, soft tissue, fat, gas), not an organ "
            "segmentation. Produce real labels with TotalSegmentator, see docs/live/data-sources.md.")
    return pack(name, spec, ct, l, spacing, work, out_root, note)


def selftest():
    """Synthetic limb: a cylinder with a bone core, plus a 'trunk' slab touching the box edge."""
    z, y, x = np.mgrid[0:60, 0:200, 0:200]
    vol = np.full((60, 200, 200), -1024, np.float32)
    r = np.hypot(y - 100, x - 60)
    vol[r < 40] = 50; vol[(r < 40) & (r > 32)] = -90; vol[r < 12] = 600; vol[r < 6] = 100
    vol[:, :, 150:] = 40                                   # trunk crossing the right border
    REGIONS["_t"] = dict(series="", idx=(0, 60), bbox=(0, 160, 20, 180), rule="free-components", fill_bone=True)
    tmp = tempfile.mkdtemp()
    out = process("_t", vol, 0.9375, tmp, tmp, "threshold")
    m = json.load(open(os.path.join(out, "study.json")))
    assert m["modality"] == "CT" and set(s["key"] for s in m["structures"].values()) >= {"bone", "soft_tissue", "fat"}
    assert max(m["dims"]) <= 128, m["dims"]
    g = np.frombuffer(gzip.open(os.path.join(out, "labels.u8.gz")).read(), np.uint8)
    assert (g == 1).sum() > 100 and g.size == int(np.prod(m["dims"]))
    print("selftest OK", m["dims"], m["spacing"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="vh_raw"); ap.add_argument("--work", default="vh_work")
    ap.add_argument("--out-root", default="assets/volumes")
    ap.add_argument("--regions", default="forearm,thigh,leg,head-neck")
    ap.add_argument("--labels", choices=["threshold", "totalseg"], default="threshold")
    ap.add_argument("--keep-raw", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest: return selftest()
    names = a.regions.split(",")
    for sname in sorted({REGIONS[n]["series"] for n in names}):
        fetch_series(sname, a.raw)
        for n in names:
            spec = REGIONS[n]
            if spec["series"] != sname: continue
            s = SERIES[sname]
            ct, sp = load_series(os.path.join(a.raw, s["folder"]), spec["idx"][0], spec["idx"][1], s["z0"])
            process(n, ct, sp, a.work, a.out_root, a.labels)
    if not a.keep_raw:
        import shutil; shutil.rmtree(a.raw, ignore_errors=True)


if __name__ == "__main__":
    main()
