#!/usr/bin/env python3
"""Build assets/ontology/cl.json from a Cell Ontology OBOGraph JSON release.

Usage: python3 tools/import_cl.py raw/cl/cl-basic.json [--out assets/ontology/cl.json] [--uberon uberon-basic.json] [--go go-edit.obo]

Input: cl-basic.json from https://purl.obolibrary.org/obo/cl/cl-basic.json (CC BY 4.0),
about 15 MB. The build environment cannot reach that host, so Friend downloads it and drops it
in raw/cl/. Output: { source, release, terms: { "CL:0000000": { name, def, parents, synonyms } } }
for every non-obsolete CL class, with is_a parents only (the browse tree), plus the GO and Uberon
tables copied from the seed so the check script keeps working. The seed's hand-written CL terms
are dropped: every id must now exist in the real ontology, and the check script reports any that
do not.
"""
import glob, json, re, sys, os

def main():
    args = sys.argv[1:]
    out = "assets/ontology/cl.json"
    uberon_path = go_path = None
    if "--uberon" in args:
        i = args.index("--uberon"); uberon_path = args[i + 1]; del args[i:i + 2]
    if "--go" in args:
        i = args.index("--go"); go_path = args[i + 1]; del args[i:i + 2]
    if "--out" in args:
        i = args.index("--out"); out = args[i + 1]; del args[i:i + 2]
    if not args:
        print(__doc__); sys.exit(2)
    graph = json.load(open(args[0]))["graphs"][0]
    iri = lambda s: s.rsplit("/", 1)[-1].replace("_", ":")
    terms = {}
    for n in graph.get("nodes", []):
        if n.get("type") != "CLASS": continue
        cid = iri(n["id"])
        if not cid.startswith("CL:"): continue
        meta = n.get("meta", {})
        if meta.get("deprecated"): continue
        terms[cid] = {
            "name": n.get("lbl", ""),
            "def": (meta.get("definition") or {}).get("val", ""),
            "parents": [],
            "synonyms": sorted({s["val"] for s in meta.get("synonyms", []) if s.get("pred") == "hasExactSynonym"}),
        }
    for e in graph.get("edges", []):
        if e.get("pred") != "is_a": continue
        s, o = iri(e["sub"]), iri(e["obj"])
        if s in terms and o in terms: terms[s]["parents"].append(o)
    seed = json.load(open(os.path.join(os.path.dirname(out), "cl-seed.json")))
    go_tbl, uberon_tbl = dict(seed["go"]), dict(seed["uberon"])
    # --uberon uberon-basic.json (github.com/obophenotype/uberon releases) and --go go-edit.obo
    # (github.com/geneontology/go-ontology, src/ontology) replace the seed's hand-written name tables with
    # the real labels for every GO and Uberon id the studies use.
    used = set()
    for f in glob.glob("assets/slides/*/study.json") + glob.glob("assets/cells/*/study.json"):
        used |= set(re.findall(r'"((?:GO|UBERON):\d+)"', open(f).read()))
    if uberon_path:
        g2 = json.load(open(uberon_path))["graphs"][0]
        real = {}
        for n in g2.get("nodes", []):
            i = iri(n["id"])
            if i.startswith("UBERON:") and not n.get("meta", {}).get("deprecated"): real[i] = n.get("lbl", "")
        uberon_tbl = {i: real[i] for i in sorted(used) if i in real}
        missing = [i for i in used if i.startswith("UBERON:") and i not in real]
        if missing: sys.exit(f"Uberon ids not in {uberon_path}: {missing}")
    if go_path:
        real, cur = {}, None
        for line in open(go_path, encoding="utf-8"):
            line = line.rstrip("\n")
            if line == "[Term]": cur = {}; continue
            if cur is None: continue
            if line == "":
                if "id" in cur and not cur.get("obsolete"): real[cur["id"]] = cur.get("name", "")
                cur = None; continue
            if line.startswith("id: "): cur["id"] = line[4:]
            elif line.startswith("name: "): cur["name"] = line[6:]
            elif line.startswith("is_obsolete: true"): cur["obsolete"] = True
        go_tbl = {i: real[i] for i in sorted(used) if i in real}
        missing = [i for i in used if i.startswith("GO:") and i not in real]
        if missing: sys.exit(f"GO ids not in {go_path}: {missing}")
    release = next((m.get("version") for m in [graph.get("meta", {})] if m.get("version")), "")
    json.dump({"source": f"Cell Ontology {release or 'release unknown'}, CC BY 4.0, https://purl.obolibrary.org/obo/cl/cl-basic.json",
               "release": release, "seed": False, "terms": terms, "go": go_tbl, "uberon": uberon_tbl, "tree": seed["tree"],
               "sources": {"uberon": uberon_path and "Uberon (CC BY 3.0), uberon-basic.json", "go": go_path and "Gene Ontology (CC BY 4.0), go-edit.obo"}},
              open(out, "w"))
    print(f"{len(terms)} CL classes -> {out} ({os.path.getsize(out) // 1024} KB)")

if __name__ == "__main__":
    main()
