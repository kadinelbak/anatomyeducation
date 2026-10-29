#!/usr/bin/env python3
"""Build assets/xrays/: one normal reference radiograph per region, downscaled to about 512 px.

    python3 tools/live/import_xray_refs.py --fracatlas /path/FracAtlas.zip --chest /path/00000001_000.png
    python3 tools/live/import_xray_refs.py --download /path/scratch/xr     # best effort, needs figshare access
    python3 tools/live/import_xray_refs.py --selftest

FracAtlas (CC BY 4.0, figshare 22363012, Abedeen et al., Scientific Data 2023): picks the first
non-fracture, hardware-free, single-scan image per region (hand, leg, hip, shoulder) from
dataset.csv. NIH ChestX-ray14 (no restrictions, attribution; Wang et al., CVPR 2017): one
"No Finding" frontal image, which the caller chooses and passes with --chest (the NIH Box
download is a 40 GB tar set, so this script does not fetch it).
Writes <region>.jpg (longest side 512, greyscale) and index.json [{region,file,source,licence,credit}].
"""
import argparse, csv, io, json, os, sys, tempfile, zipfile
from PIL import Image

FRAC = dict(source="FracAtlas, figshare 22363012 (Hospital data, Bangladesh)", licence="CC BY 4.0",
            credit="Abedeen I, Rahman MA, Prottyasha FZ, Ahmed T, Chowdhury TM, Shatabda S. FracAtlas: A Dataset for Fracture Classification, Localization and Segmentation of Musculoskeletal Radiographs. Scientific Data 10, 521 (2023)")
NIH = dict(source="NIH ChestX-ray14 (NIH Clinical Center)", licence="No restrictions on use; attribution requested",
           credit="Wang X, Peng Y, Lu L, Lu Z, Bagheri M, Summers RM. ChestX-ray8. IEEE CVPR 2017; images provided by the NIH Clinical Center")
REGIONS = ["hand", "leg", "hip", "shoulder"]


def save(im, path, size=512):
    im = im.convert("L"); s = size / max(im.size)
    if s < 1: im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    im.save(path, quality=85, optimize=True)


def download(dest):
    import requests
    os.makedirs(dest, exist_ok=True)
    meta = requests.get("https://api.figshare.com/v2/articles/22363012", timeout=60); meta.raise_for_status()
    f = next(x for x in meta.json()["files"] if x["name"].lower().endswith(".zip"))
    p = os.path.join(dest, f["name"])
    with requests.get(f["download_url"], stream=True, timeout=900) as r:
        r.raise_for_status()
        with open(p, "wb") as o:
            for ch in r.iter_content(1 << 20): o.write(ch)
    return p


def pick_fracatlas(zpath):
    z = zipfile.ZipFile(zpath); names = z.namelist()
    csvname = next(n for n in names if n.lower().endswith("dataset.csv"))
    rows = list(csv.DictReader(io.TextIOWrapper(z.open(csvname), "utf-8-sig")))
    by_base = {os.path.basename(n): n for n in names if n.lower().endswith((".jpg", ".jpeg", ".png"))}
    flag = lambda r, k: str(r.get(k, "0")).strip() in ("1", "1.0", "True", "true")
    out = {}
    for reg in REGIONS:
        for r in rows:
            if flag(r, reg) and not flag(r, "fractured") and not flag(r, "hardware") and not flag(r, "multiscan") \
               and not any(flag(r, o) for o in REGIONS if o != reg) and r["image_id"] in by_base:
                out[reg] = (z, by_base[r["image_id"]], r["image_id"]); break
    return out


def build(fracatlas, chest, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    index = []
    if fracatlas:
        for reg, (z, name, iid) in pick_fracatlas(fracatlas).items():
            save(Image.open(io.BytesIO(z.read(name))), os.path.join(out_dir, reg + ".jpg"))
            index.append(dict(region=reg, file=reg + ".jpg", original=iid, **FRAC))
    if chest:
        save(Image.open(chest), os.path.join(out_dir, "chest.jpg"))
        index.append(dict(region="chest", file="chest.jpg", original=os.path.basename(chest), **NIH))
    json.dump(index, open(os.path.join(out_dir, "index.json"), "w"), indent=1)
    for e in index: print(e["region"], os.path.getsize(os.path.join(out_dir, e["file"])), "bytes")
    return index


def selftest():
    tmp = tempfile.mkdtemp(); zp = os.path.join(tmp, "fa.zip")
    with zipfile.ZipFile(zp, "w") as z:
        z.writestr("FracAtlas/dataset.csv", "image_id,hand,leg,hip,shoulder,mixed,hardware,multiscan,fractured\n" +
                   "".join(f"IMG{i}.jpg,{int(i%4==0)},{int(i%4==1)},{int(i%4==2)},{int(i%4==3)},0,0,0,{int(i<4)}\n" for i in range(1, 17)))
        for i in range(1, 17):
            b = io.BytesIO(); Image.new("L", (1200, 900), 80 + i).save(b, "JPEG"); z.writestr(f"FracAtlas/images/IMG{i}.jpg", b.getvalue())
    ch = os.path.join(tmp, "c.png"); Image.new("L", (1024, 1024), 120).save(ch)
    idx = build(zp, ch, os.path.join(tmp, "xr"))
    assert [e["region"] for e in idx] == REGIONS + ["chest"]
    assert all(max(Image.open(os.path.join(tmp, "xr", e["file"])).size) == 512 for e in idx)
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fracatlas"); ap.add_argument("--chest"); ap.add_argument("--download", metavar="DIR")
    ap.add_argument("--out", default="assets/xrays"); ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest: return selftest()
    fa = download(a.download) if a.download else a.fracatlas
    if not fa and not a.chest: ap.error("give --fracatlas, --download or --chest")
    build(fa, a.chest, a.out)


if __name__ == "__main__":
    main()
