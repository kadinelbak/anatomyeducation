# Allen Cell studies (real 3D hiPSC cells)

Four cell studies, `assets/cells/allen-{mitochondria,er,golgi,nucleolus}/`, are built from the
Allen Institute for Cell Science **hiPSC Single-Cell Image Dataset** (WTC-11 line; Viana et al.,
Nature 2023). Each has `study.json`, `model.glb` and `model.glb.b64.txt` (base64 of the GLB, one line).

## What is fetched
- `metadata.csv` (1.7 GB) is **never** downloaded whole: `tools/allen_cells.py` reads the header and
  one 6 MB HTTP Range window per structure (the file is grouped by structure).
- One `crop_seg/<hash>_segmentation.ome.tif` per cell (about 300-600 KB, 8-bit, channels from
  `name_dict`: `dna_segmentation`, `membrane_segmentation`, `struct_segmentation`, plus roofs).
- Source: `https://allencell.s3.amazonaws.com/aics/hipsc_single_cell_image_dataset/` (no auth).
- Selection: stage M0, `edge_flag` false, `outlier` No; the median-`MEM_shape_volume` candidate in the window.

| study | structure | CellId |
|---|---|---|
| allen-mitochondria | TOMM20 | 231229 |
| allen-er | SEC61B | 391099 |
| allen-golgi | ST6GAL1 | 435525 |
| allen-nucleolus | FBL | 702659 |

## Rerun
```
python3 tools/allen_cells.py --out assets/cells --cells 4 [--cache /tmp/allen_cache]
```
`--cells N` takes the first N entries of `STRUCTS` (TOMM20, SEC61B, ST6GAL1, FBL, TUBA1B).
Needs numpy, scipy, scikit-image, tifffile, trimesh. Re-running overwrites the output folders.

## Processing
Marching cubes (scikit-image, spacing = `scale_micron`, micrometres) on lightly Gaussian-blurred masks;
largest membrane blob only, DNA and structure clipped to the dilated membrane (crops include neighbours);
Taubin smoothing; decimation by coarsening the marching-cubes `step_size` until under the target
(about 20k triangles membrane, 10k nucleus, 30k structure; trimesh quadric decimation needs
`fast_simplification`, not installed). Then normalised: membrane bbox centre at the origin, uniform
scale so the membrane's longest axis is 10 scene units (`micronsPerUnit` in `study.json`).

## GLB contract
- One GLB per cell, three meshes, node and mesh names exactly `membrane`, `nucleus`, `structure`.
- Units: scene units (10 = membrane's longest axis); multiply by `micronsPerUnit` for micrometres.
- Axes: Three.js Y up = the coverslip normal (image Z); X = image X; Z = minus image Y.
- No textures or materials; per-vertex normals included. Each GLB is under 1.1 MB.
- `study.json`: top-level `model` (relative path) and `micronsPerUnit`; each part has `mesh`
  (a node name) instead of `shape`/`pos`/`size`; plus a `provenance` object.

## Licence
CC BY 4.0 under the Allen Institute Terms of Use. Cite Viana et al., "Integrated intracellular
organization and its variations in human iPS cells", Nature 2023. Attribution: Allen Institute for Cell Science.
