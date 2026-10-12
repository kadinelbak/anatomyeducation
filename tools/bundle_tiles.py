#!/usr/bin/env python3
"""Bundle a slide's tiles into one JSON file per pyramid level, for hosts that cap the number of files.

    python3 tools/bundle_tiles.py assets/slides [--out <dir>]

For every <slide>/tiles/<level>/<col>_<row>.jpg writes <out>/<slide>/tiles/<level>.b64.json holding
{"<col>_<row>": "<base64 jpeg>"}. The slide renderer reads these when CONFIG.tileBundles is true.
"""
import argparse, base64, json, os, sys

ap = argparse.ArgumentParser()
ap.add_argument("slides")
ap.add_argument("--out", default=None, help="output root (default: in place, next to the tile folders)")
a = ap.parse_args()
out_root = a.out or a.slides
n = 0
for sid in sorted(os.listdir(a.slides)):
    tiles = os.path.join(a.slides, sid, "tiles")
    if not os.path.isdir(tiles): continue
    for level in sorted(os.listdir(tiles)):
        d = os.path.join(tiles, level)
        if not os.path.isdir(d): continue
        bundle = {}
        for f in sorted(os.listdir(d)):
            if f.endswith(".b64.txt") or not os.path.isfile(os.path.join(d, f)): continue
            with open(os.path.join(d, f), "rb") as fh: bundle[f.rsplit(".", 1)[0]] = base64.b64encode(fh.read()).decode()
        od = os.path.join(out_root, sid, "tiles"); os.makedirs(od, exist_ok=True)
        with open(os.path.join(od, f"{level}.b64.json"), "w") as fh: json.dump(bundle, fh)
        n += 1
print(f"wrote {n} level bundles under {out_root}", file=sys.stderr)
