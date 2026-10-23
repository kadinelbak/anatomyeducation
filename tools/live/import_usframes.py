#!/usr/bin/env python3
"""Pack real ultrasound stills (CC BY 4.0) as reference frame stacks, format in docs/live/frame-format.md.

    python3 tools/live/import_usframes.py --dataset carotid --src /path/to/unzipped/carotid [--max 12]
    python3 tools/live/import_usframes.py --dataset marzola --src /path/to/unzipped/marzola --pattern biceps
    python3 tools/live/import_usframes.py --dataset carotid --download /path/scratch/dl   # best effort
    python3 tools/live/import_usframes.py --selftest

Picks at most --max frames spread evenly through the sorted image list, converts to greyscale,
downscales to --width px wide, writes assets/usframes/<id>/{stack.json,frames/NNN.jpg}.
Needs Pillow; --download also needs requests and a network path to data.mendeley.com.
Sources (both CC BY 4.0, Mendeley Data):
  carotid  https://data.mendeley.com/datasets/486dmdpzd7   common carotid artery, neck
  marzola  https://data.mendeley.com/datasets/3jykz7wz8d/1 biceps brachii / tibialis anterior, transverse
"""
import argparse, io, json, os, sys, tempfile
from PIL import Image

DATASETS = {
    "carotid": dict(id="carotid-ref", title="Real carotid ultrasound (reference stills)", segment="neck", side="right",
                    frac=[0.3, 0.6], mendeley="486dmdpzd7", version=None,
                    source="Mendeley Data 486dmdpzd7, common carotid artery ultrasound images",
                    credit="Authors as listed on https://data.mendeley.com/datasets/486dmdpzd7 (author names not machine-verified, see docs/live/data-sources.md)"),
    "marzola": dict(id="marzola-ref", title="Real biceps ultrasound, transverse (reference stills)", segment="upper_arm", side="right",
                    frac=[0.35, 0.65], mendeley="3jykz7wz8d", version=1,
                    source="Mendeley Data 3jykz7wz8d v1, Marzola et al., transverse musculoskeletal ultrasound (biceps brachii, tibialis anterior)",
                    credit="Marzola F, van Alfen N, Doorduin J, Meiburger KM. Deep learning segmentation of transverse musculoskeletal ultrasound images for neuromuscular disease assessment. Comput Biol Med 2021; dataset on Mendeley Data (CC BY 4.0)"),
}
EXT = (".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff")


def find_images(src, pattern=""):
    out = []
    for r, _, fs in os.walk(src):
        for f in fs:
            p = os.path.join(r, f)
            if f.lower().endswith(EXT) and pattern.lower() in p.lower() and "mask" not in p.lower() and "label" not in p.lower():
                out.append(p)
    return sorted(out)


def pick(items, n):
    if len(items) <= n: return items
    return [items[round(i * (len(items) - 1) / (n - 1))] for i in range(n)]


def download(key, version, dest):
    """Best effort: Mendeley public API file list, then each file (zip files are extracted)."""
    import requests, zipfile
    os.makedirs(dest, exist_ok=True)
    base = f"https://data.mendeley.com/public-api/datasets/{key}"
    meta = requests.get(base + (f"/versions/{version}" if version else ""), timeout=60)
    meta.raise_for_status(); files = meta.json().get("files", [])
    for f in files:
        url = f["content_details"]["download_url"]; p = os.path.join(dest, f["filename"])
        with requests.get(url, timeout=600, stream=True) as r:
            r.raise_for_status()
            with open(p, "wb") as o:
                for ch in r.iter_content(1 << 20): o.write(ch)
        if p.lower().endswith(".zip"): zipfile.ZipFile(p).extractall(os.path.join(dest, f["filename"] + ".x"))
    return dest


def pack(key, src, out_root, n, width, pattern="", segment=None, frac=None, id_=None):
    d = DATASETS[key]
    imgs = pick(find_images(src, pattern), n)
    if not imgs: sys.exit(f"no images under {src} (pattern {pattern!r})")
    id_ = id_ or d["id"]
    out = os.path.join(out_root, id_); os.makedirs(os.path.join(out, "frames"), exist_ok=True)
    for f in os.listdir(os.path.join(out, "frames")): os.remove(os.path.join(out, "frames", f))
    w = h = 0
    for i, p in enumerate(imgs):
        im = Image.open(p).convert("L")
        s = width / im.width
        im = im.resize((width, max(1, round(im.height * s))), Image.LANCZOS)
        w, h = im.size
        im.save(os.path.join(out, "frames", f"{i:03d}.jpg"), quality=82, optimize=True)
    stack = {"version": 1, "id": id_, "title": d["title"], "modality": "ultrasound", "ext": "jpg",
             "source": d["source"], "license": "CC BY 4.0", "credit": d["credit"],
             "segment": segment or d["segment"], "side": d["side"], "frac": frac or d["frac"],
             "frames": len(imgs), "width": w, "height": h,
             "originalFiles": [os.path.relpath(p, src) for p in imgs]}
    json.dump(stack, open(os.path.join(out, "stack.json"), "w"), indent=1)
    size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(out) for f in fs)
    print(f"{id_}: {len(imgs)} frames {w}x{h}, {size} bytes")
    return out


def selftest():
    import random
    tmp = tempfile.mkdtemp(); src = os.path.join(tmp, "src"); os.makedirs(src)
    for i in range(30):
        Image.effect_noise((640, 480), 40 + i).save(os.path.join(src, f"img{i:03d}.png"))
    Image.new("L", (640, 480), 255).save(os.path.join(src, "img001_mask.png"))
    out = pack("carotid", src, tmp, 12, 320)
    s = json.load(open(os.path.join(out, "stack.json")))
    assert s["frames"] == 12 and s["width"] == 320 and s["height"] == 240
    assert len(os.listdir(os.path.join(out, "frames"))) == 12 and not any("mask" in x for x in s["originalFiles"])
    print("selftest OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", choices=list(DATASETS)); ap.add_argument("--src")
    ap.add_argument("--download", metavar="DIR"); ap.add_argument("--out-root", default="assets/usframes")
    ap.add_argument("--max", type=int, default=12); ap.add_argument("--width", type=int, default=320)
    ap.add_argument("--pattern", default="", help="substring the image path must contain")
    ap.add_argument("--segment"); ap.add_argument("--id"); ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest: return selftest()
    if not a.dataset: ap.error("--dataset required")
    src = a.src
    if a.download:
        d = DATASETS[a.dataset]; src = download(d["mendeley"], d["version"], a.download)
    if not src: ap.error("--src or --download required")
    pack(a.dataset, src, a.out_root, a.max, a.width, a.pattern, a.segment, None, a.id)


if __name__ == "__main__":
    main()
