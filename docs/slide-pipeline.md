# Slide pipeline

Two scripts in `tools/` (Python 3, Pillow, numpy; no network):

- `make_slides.py` draws the five stylised placeholder slides, records the label polygons while drawing, packs them via `build_slide.py`, then self-checks.
- `build_slide.py` turns any full-resolution image plus a `meta.json` into `assets/slides/<id>/` (`study.json`, `tiles/`, `preview.jpg`). Format: `docs/cell-formats.md`, section "Slide study".

## Regenerate the placeholders

```
cd /mnt/project-files/cells
python3 tools/make_slides.py --size 4096 --b64      # also: --out DIR, --only muscle-ls,bone-ts, --quality 82, --no-check
```

Deterministic (seeded). Each slide carries the caption "Stylised illustration, not a micrograph" in the bottom-right corner; keep that corner free of structures. The self-check asserts: every polygon is inside the image, clockwise, 4 to 24 vertices; nested structures sit inside their parents (nucleus in fibre, axon in its myelin, lacuna in osteon, smc in media, ...); no two `cell` polygons overlap by more than 5% of the smaller; tiles are under 6 MB per slide. It prints counts by group and the size of `tiles/` with and without b64.

## Replace a placeholder with a real slide

1. Export the slide (for example from the Michigan Histology viewer) as one PNG at the resolution you want to keep, e.g. `raw.png`. Level 0 is never resized, so a 4096 x 4096 crop is a good target; the tile pyramid halves the width until it is <= 512.
2. Write `meta.json` by hand (or with the label tool). Fields: `title, stain, source, sourceUrl, license, attribution, tissue, tissueName, sections, cells, micronsPerPixel, views, structures, synthetic, defaultView, defaultLayers`. For a real slide set `"synthetic": false`, `"stain"` to the real stain, and fill `source`, `sourceUrl`, `license`, `attribution` honestly. `width, height, tileSize, levels, format` are computed; do not write them.
3. Build:
   ```
   python3 tools/build_slide.py --image raw.png --out assets/slides/muscle-ls --id muscle-ls --meta meta.json --b64
   ```
   Options: `--tile 512`, `--quality 82`. It exits non-zero with a message if a polygon has fewer than 3 vertices or leaves the image. Keep the same structure keys when replacing a placeholder so existing question records (`target`, `accept`) keep working.

Output layout: `tiles/<levelWidth>/<col>_<row>.jpg` (JPEG q82, baseline), `preview.jpg` (512 wide), `study.json`. With `--b64`, every JPEG also gets `<name>.jpg.b64.txt` (base64 of the raw JPEG bytes) for text-only hosts.

## Polygon conventions

- Level-0 pixel coordinates, integers, `[x, y]`, y down; clockwise on screen (shoelace sum positive); simple (non self-intersecting); 4 to 24 vertices.
- Picking = point-in-polygon, smallest containing polygon wins. So a parent (fibre, osteon, myelin, media) is a plain outline and children are separate, smaller polygons fully inside it.
- Rings cannot be one simple polygon, so a layered wall is a set of nested outlines (artery: `adventitia-1` contains `eel-1` contains `media-1` contains `iel-1` contains `lumen-1`; the visible ring band is whatever is left of the larger outline). `iel-1` therefore covers lumen plus intima out to the internal elastic lamina.
- `cx`, `cy` of a view are fractions (polygon centroid / size); `zoom` 1 is the whole slide; `minZoom` only matters for Magnification questions.
- Groups: `cell`, `organelle`, `connective`, `vessel`, `nerve`, `bone`.
- A structure may omit `id` when no ontology term is known (the placeholders do this for perineurium, lumen, laminae, adventitia, vasa, Volkmann canal, interstitial lamellae).

## Size per slide (4096 x 4096, quality 82)

| slide | structures | tiles/ (jpg) | b64 text | total with b64 |
|---|---|---|---|---|
| muscle-ls | 48 | 2.91 MB | 3.22 MB | 6.13 MB |
| muscle-ts | 317 | 1.75 MB | 1.86 MB | 3.61 MB |
| bone-ts | 142 | 1.40 MB | 1.87 MB | 3.26 MB |
| nerve-ts | 409 | 1.38 MB | 1.85 MB | 3.23 MB |
| artery-ts | 106 | 1.39 MB | 1.86 MB | 3.25 MB |

Real slides will be larger (texture compresses worse); if a slide exceeds the budget, lower `--quality` or export at 3072.
