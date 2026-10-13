#!/usr/bin/env python3
"""Validate the labelled cell diagrams (docs/cell-diagrams.md). Run from anatomy-app/:
    python3 tools/check_diagrams.py              every study with a "diagram"
    python3 tools/check_diagrams.py cl-0000057   one study (also prints its expected part keys)

Checks per study: the SVG parses; its viewBox is set; every data-part is a key the 3D model would make
(bare key for a single part, <key>-<i> for i <= count of a stamped part); every part in study.json has at
least one region (its bare key, or <key>-1); the label group names only real base parts and labels every
part; question targets in the banks exist as regions; no <script>, no external hrefs, no <image>.
Exit 1 on any error.
"""
import json, glob, os, re, sys
import xml.etree.ElementTree as ET

SVG = "{http://www.w3.org/2000/svg}"
def expected_keys(study):
    keys, bases = {}, {}
    for p in study.get("parts", []):
        n = max(1, int(p.get("count", 1) or 1))
        bases[p["key"]] = p
        if n > 1:
            for i in range(1, n + 1): keys[f'{p["key"]}-{i}'] = p["key"]
        else: keys[p["key"]] = p["key"]
    return keys, bases

def check(sid, verbose):
    errs = []
    sp = f"assets/cells/{sid}/study.json"
    study = json.load(open(sp))
    d = study.get("diagram")
    if not d: return [f"{sid}: no diagram field"]
    f = f"assets/cells/{sid}/{d['file']}"
    keys, bases = expected_keys(study)
    if verbose:
        print(f"{sid} expected regions (base -> keys you may use):")
        for b, p in bases.items():
            n = max(1, int(p.get("count", 1) or 1))
            print(f"  {b:22s} {p.get('name','')!r:42s} " + (f"{b}-1 .. {b}-{n}" if n > 1 else b))
    if not os.path.exists(f): return errs + [f"{sid}: {f} missing"]
    txt = open(f, encoding="utf8").read()
    if re.search(r"<script|<image|<foreignObject|\bon\w+\s*=", txt, re.I): errs.append(f"{sid}: script, image, foreignObject or event attribute in the SVG")
    if re.search(r'href\s*=\s*"(?!#)', txt): errs.append(f"{sid}: external href in the SVG")
    try: root = ET.fromstring(txt)
    except ET.ParseError as e: return errs + [f"{sid}: SVG does not parse: {e}"]
    if not root.get("viewBox"): errs.append(f"{sid}: no viewBox on <svg>")
    seen = set()
    for e in root.iter():
        k = e.get("data-part")
        if k is None: continue
        if k not in keys: errs.append(f"{sid}: data-part {k!r} is not a key of study.json (see the list above)")
        if k in seen: errs.append(f"{sid}: data-part {k!r} used twice")
        seen.add(k)
        for sub in e.iter():
            if sub is not e and sub.get("data-part"): errs.append(f"{sid}: data-part {sub.get('data-part')!r} nested inside {k!r}")
    covered = {keys[k] for k in seen if k in keys}
    for b in bases:
        if b not in covered: errs.append(f"{sid}: part {b!r} has no region")
    labelled = set()
    for e in root.iter():
        lk = e.get("data-label")
        if lk is None: continue
        if lk not in bases: errs.append(f"{sid}: data-label {lk!r} is not a base part key")
        labelled.add(lk)
    named = {bases[b].get("name", b) for b in labelled if b in bases}
    for b, pt in bases.items():
        if b not in labelled and pt.get("name", b) not in named: errs.append(f"{sid}: part {b!r} has no label (data-label)")
    for bank in glob.glob("assets/questions/cells-*.json"):
        for q in json.load(open(bank))["questions"]:
            if q.get("study") != sid: continue
            if q["target"] not in seen: errs.append(f"{sid}: question {q['id']} target {q['target']!r} has no region")
            if not any(a in seen for a in q.get("accept", [])): errs.append(f"{sid}: question {q['id']} has no accepted region")
    return errs

def main():
    ids = sys.argv[1:]
    verbose = bool(ids)
    if not ids:
        ids = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob("assets/cells/*/study.json")
                     if json.load(open(p)).get("diagram"))
    errs = []
    for sid in ids: errs += check(sid, verbose)
    for e in errs: print("ERROR", e)
    print(f"{len(ids)} diagram(s) checked, {len(errs)} error(s)")
    sys.exit(1 if errs else 0)
main()
