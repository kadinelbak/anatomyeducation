#!/usr/bin/env python3
"""Validate the cell module's banks, studies and ontology ids. Run from cells/ (or anatomy-app/ after
integration): python3 tools/check_cells.py [--banks assets/questions/histology-limb.json ...]

Checks: every question's renderer is slide or cell; its study exists; view, layers, target and accept
keys exist in the study; every structure/part id (CL, GO, UBERON) exists in the ontology file (cl.json
if present, else the seed); zoom links point at studies or models that exist; polygon sanity for slides.
Exit 1 on any error. Warnings (ids only in the seed) do not fail.
"""
import json, os, sys, glob

ROOT = os.getcwd()
def load(p): return json.load(open(p))
def main():
    args = sys.argv[1:]
    banks = []
    if "--banks" in args:
        banks = args[args.index("--banks") + 1:]
    if not banks:
        banks = sorted(glob.glob("assets/questions/histology-*.json") + glob.glob("assets/questions/cells-*.json"))
    onto_path = "assets/ontology/cl.json" if os.path.exists("assets/ontology/cl.json") else "assets/ontology/cl-seed.json"
    onto = load(onto_path)
    known = set(onto["terms"]) | set(onto.get("go", {})) | set(onto.get("uberon", {}))
    unconfirmed = set(onto.get("unconfirmed", {}))
    errors, warns = [], []
    if onto.get("seed"): warns.append(f"ontology is the hand-written seed ({onto_path}); ids are unconfirmed until tools/import_cl.py runs on the real release")
    # Model structure keys (slugs like "biceps_brachii"), from the app's structure maps when they are reachable.
    model_keys = set()
    for base in (".", "../anatomy-app", "/mnt/project-files/anatomy-app"):
        for f in glob.glob(f"{base}/assets/model/*structures.json"):
            d = load(f); model_keys |= set(d.get("structures", d))
    if not model_keys: warns.append("no limb model structure map found; slide sections not validated")
    studies = {}
    for kind, base in (("slide", "assets/slides"), ("cell", "assets/cells")):
        for sj in sorted(glob.glob(f"{base}/*/study.json")):
            s = load(sj); sid = s["id"]
            if s.get("kind") != kind: errors.append(f"{sj}: kind should be {kind}")
            if os.path.basename(os.path.dirname(sj)) != sid: errors.append(f"{sj}: folder name != id {sid}")
            for f in ("title", "license", "attribution", "source", "views", "defaultView"):
                if f not in s: errors.append(f"{sj}: missing {f}")
            if s.get("defaultView") not in s.get("views", {}): errors.append(f"{sj}: defaultView not in views")
            ids = []
            if kind == "slide":
                keys = s.get("structures", {})
                W, H = s.get("width", 0), s.get("height", 0)
                for k, st in keys.items():
                    poly = st.get("polygon", [])
                    if len(poly) < 3: errors.append(f"{sid}/{k}: polygon has {len(poly)} points")
                    for x, y in poly:
                        if not (0 <= x <= W and 0 <= y <= H): errors.append(f"{sid}/{k}: polygon point outside image"); break
                    if st.get("id"): ids.append((k, st["id"]))
                for lvl in s.get("levels", []):
                    if not os.path.isdir(os.path.join(os.path.dirname(sj), "tiles", str(lvl))): errors.append(f"{sid}: no tiles/{lvl}")
                for t in s.get("sections", []):
                    if model_keys and t not in model_keys: errors.append(f"{sid}: sections entry {t} is not a structure key of any limb model")
                for c in s.get("cells", []): ids.append(("cells", c))
                if s.get("tissue"): ids.append(("tissue", s["tissue"]))
            else:
                keys = {}
                for p in s.get("parts", []):
                    keys[p["key"]] = p
                    if p.get("id"): ids.append((p["key"], p["id"]))
                if s.get("cell", {}).get("id"): ids.append(("cell", s["cell"]["id"]))
                keys[s.get("cell", {}).get("key", "cell")] = s.get("cell", {})
                for t in s.get("tissues", []): ids.append(("tissues", t))
            for k, i in ids:
                if i in unconfirmed: warns.append(f"{sid}/{k}: id {i} is marked unconfirmed in the seed")
                elif i not in known: errors.append(f"{sid}/{k}: unknown ontology id {i}")
            studies[(kind, sid)] = {"keys": keys, "views": s.get("views", {}), "slides": s.get("slides", []), "sections": s.get("sections", [])}
    for sid_kind in list(studies):
        if sid_kind[0] == "cell":
            for sl in studies[sid_kind]["slides"]:
                if ("slide", sl) not in studies: errors.append(f"cell {sid_kind[1]}: slides entry {sl} has no study")
    nq = 0; seen = set()
    for b in banks:
        data = load(b)
        for q in data["questions"]:
            nq += 1
            qid = q.get("id", "?")
            if qid in seen: errors.append(f"{b}: duplicate id {qid}")
            seen.add(qid)
            r = q.get("renderer")
            if r not in ("slide", "cell"): errors.append(f"{qid}: renderer {r}"); continue
            st = studies.get((r, q.get("study")))
            if not st: errors.append(f"{qid}: study {q.get('study')} not found"); continue
            for f in ("kind", "prompt", "explain", "target", "accept", "view", "layers", "tags", "review"):
                if f not in q: errors.append(f"{qid}: missing {f}")
            if q.get("view") and q["view"] not in st["views"] and not str(q["view"]).startswith(("cx=", "zoom=")): errors.append(f"{qid}: view {q['view']} not in study")
            stamped = lambda k: k in st["keys"] or any(k.startswith(p + "-") and st["keys"][p].get("count") for p in st["keys"])
            if not stamped(q.get("target", "")): errors.append(f"{qid}: target {q.get('target')} not in study")
            for a in q.get("accept", []):
                if not stamped(a): errors.append(f"{qid}: accept {a} not in study")
            if q.get("target") not in q.get("accept", []): errors.append(f"{qid}: target not in accept")
            z = q.get("zoom", {})
            for d in ("in", "out"):
                ref = z.get(d)
                if not ref: continue
                kind, _, rest = ref.partition(":")
                sid = rest.split("#")[0]
                if kind in ("slide", "cell") and (kind, sid) not in studies: errors.append(f"{qid}: zoom.{d} {ref} not found")
                elif kind == "model" and sid not in ("upper-limb", "lower-limb"): errors.append(f"{qid}: zoom.{d} model {sid} unknown")
                elif kind not in ("slide", "cell", "model"): errors.append(f"{qid}: zoom.{d} kind {kind}")
            if q.get("tags", {}).get("modality") not in ("Histology", "Cell"): errors.append(f"{qid}: tags.modality must be Histology or Cell")
    for w in warns: print("warning:", w)
    for e in errors: print("error:", e)
    print(f"{len(studies)} studies, {nq} questions in {len(banks)} banks, {len(errors)} errors")
    sys.exit(1 if errors else 0)

if __name__ == "__main__":
    main()
