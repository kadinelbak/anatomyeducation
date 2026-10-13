#!/usr/bin/env python3
"""Build assets/imaging-crosswalk.json: which scan labels show each 3D model structure.

The 3D models (assets/model/*structures.json) and the scan studies (assets/volumes/*/study.json)
name structures independently, so the Imaging button in the details panel needs a table from
model keys (e.g. "right_kidney", "t5_vertebra", "humerus") to scan label keys ("kidney_right",
"vertebrae_T5", "humerus_left" + "humerus_right"). Matching, in order:
  1. the same key, or the same key with _left/_right appended;
  2. a small table of naming rules (vertebrae, ribs, sides written first, clavicle spelt clavicula);
  3. the same display name once "left"/"right" and punctuation are dropped.
Only keys that occur in a shipped study are kept. Output:
  { "map": { modelKey: [scanKey, ...] },
    "studies": { studyId: { modality: "CT"|"MRI", title, keys: [scanKey, ...] } } }

Usage: python3 tools/build_crosswalk.py   (run from the app root)
"""
import glob
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)


def norm(s):
    s = s.lower()
    s = re.sub(r"\b(left|right)\b", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


# Scan labels per study.
studies, scan_names = {}, {}
for f in sorted(glob.glob("assets/volumes/*/study.json")):
    sid = os.path.basename(os.path.dirname(f))
    if sid in ("ts-example-sm",):  # 3 mm test sample, not offered to students
        continue
    m = json.load(open(f))
    keys = sorted({v["key"] for v in m["structures"].values()})
    for v in m["structures"].values():
        scan_names.setdefault(v["key"], v["name"])
    mod = "MRI" if m.get("modality") == "MR" else "CT"
    title = m.get("title") or m.get("sequenceLabel") or sid
    studies[sid] = {"modality": mod, "title": title, "keys": keys}
scan_keys = set(scan_names)
by_norm = {}
for k, n in scan_names.items():
    by_norm.setdefault(norm(n), set()).add(k)


def rules(key):
    """Scan keys a model key may go by, before checking they exist."""
    out = [key, f"{key}_left", f"{key}_right"]
    m = re.fullmatch(r"([ctls])(\d+)_vertebra", key)
    if m:
        out.append(f"vertebrae_{m.group(1).upper()}{m.group(2)}")
    if key == "sacrum":
        out.append("vertebrae_S1")
    m = re.fullmatch(r"rib_(\d+)", key)
    if m:
        out += [f"rib_left_{m.group(1)}", f"rib_right_{m.group(1)}"]
    if key == "ribs":
        out += [f"rib_{s}_{i}" for s in ("left", "right") for i in range(1, 13)]
    m = re.fullmatch(r"(left|right)_(.+)", key)
    if m:
        out.append(f"{m.group(2)}_{m.group(1)}")
    m = re.fullmatch(r"(.+)_(left|right)", key)
    if m:
        out.append(f"{m.group(1)}_{m.group(2)}")
    extra = {
        "clavicle": ["clavicula_left", "clavicula_right"],
        "hip_bone": ["hip_left", "hip_right"],
        "ascending_aorta": ["aorta"], "descending_aorta": ["aorta"], "aortic_arch": ["aorta"],
        "abdominal_aorta": ["aorta"], "thoracic_aorta": ["aorta"],
        "lung": ["lung_left", "lung_right"],
        "right_lung": ["lung_right"], "left_lung": ["lung_left"],
        "spinal_cord": ["spinal_cord"],
        "gluteus_maximus": ["gluteus_maximus_left", "gluteus_maximus_right"],
        "iliopsoas": ["iliopsoas_left", "iliopsoas_right"],
        "psoas_major": ["iliopsoas_left", "iliopsoas_right"],
        "rectus_femoris": ["quadriceps_femoris_left", "quadriceps_femoris_right"],
        "vastus_lateralis": ["quadriceps_femoris_left", "quadriceps_femoris_right"],
        "vastus_medialis": ["quadriceps_femoris_left", "quadriceps_femoris_right"],
        "vastus_intermedius": ["quadriceps_femoris_left", "quadriceps_femoris_right"],
        "bladder": ["urinary_bladder"],
        "small_intestine": ["small_bowel"],
        "large_intestine": ["colon"],
        "oesophagus": ["esophagus"],
        "skull": ["skull"],
        "cerebrum": ["brain"],
    }
    return out + extra.get(key, [])


models = {}
for f in sorted(glob.glob("assets/model/*structures.json")):
    m = json.load(open(f))
    for k, n in m["structures"].items():
        models.setdefault(k, n)

xmap = {}
for k, name in sorted(models.items()):
    hits = [s for s in rules(k) if s in scan_keys]
    if not hits:  # same name; a side named on one must not contradict the other
        side = lambda t: {w for w in ("left", "right") if re.search(rf"\b{w}\b", t.lower().replace("_", " "))}
        hits = sorted(s for s in by_norm.get(norm(name), ()) if not (side(name) and side(scan_names[s]) and side(name) != side(scan_names[s])))
    if hits:
        xmap[k] = sorted(dict.fromkeys(hits))

out = {"map": xmap, "studies": studies}
with open("assets/imaging-crosswalk.json", "w") as fh:
    json.dump(out, fh, separators=(",", ":"))
print(f"{len(xmap)} of {len(models)} model structures appear in {len(studies)} scan studies")
