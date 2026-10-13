# Real histology slides for "Tissues and cells"

Four of the five stylised placeholder slides are replaced by real H&E micrographs. The bone slide stays stylised, because no openly licensed compact-bone slide with osteons was reachable from this environment.

| Slide id | Now shows | Source sample | Field | µm/px | Structures |
|---|---|---|---|---|---|
| muscle-ls | Gastrocnemius, longitudinal | GTEX-ZVT4-0325 | 4096 px, native 20x | 0.494 | 520 |
| muscle-ts | Gastrocnemius, transverse | GTEX-13112-2625 | 6144 px scaled to 4096 | 0.741 | 2,540 |
| nerve-ts | Tibial nerve, transverse | GTEX-RWSA-0425 | 4096 px, native 20x | 0.494 | 3,884 |
| artery-ts | Tibial artery, transverse | GTEX-1QCLY-0625 | 6144 px scaled to 4096 | 0.741 | 2,549 |
| bone-ts | unchanged, stylised | — | — | — | — |

## Licence and credit

All four are Genotype-Tissue Expression (GTEx) project slides, published as DICOM whole-slide images by NCI Imaging Data Commons (IDC), collection `gtex`, licence **CC BY 4.0**, doi:10.5281/zenodo.11099099. Each `study.json` carries `attribution`, `license`, `source` and a `sourceUrl` to the IDC slide viewer, and `synthetic: false`. The existing histology footer line (`#attr-hist`, filled in `src/app.js`) shows them, so no code change is needed. In the click test the footer read "Histology: GTEx Consortium, sample GTEX-ZVT4-0325, via NCI Imaging Data Commons, CC BY 4.0". `sources.json` lists the IDC study and series UIDs.

Optional copy edit for whoever owns `index.html`: the footer sentence "Slides marked stylised are drawn illustrations" is still true, because bone is still stylised. Add a GTEx line to the README credits section if that list is kept by hand.

## Install into anatomy-app

```
cp -r slides/{muscle-ls,muscle-ts,nerve-ts,artery-ts} <app>/assets/slides/      # replace the four folders
cp questions/histology-limb.json <app>/assets/questions/histology-limb.json
python3 tools/check_cells.py                       # run in <app>
ALL=1 node tools/smoke_test_cells.mjs              # run in <app>
node tools/zoom_test_cells.mjs                     # run in <app>
```

Slide ids, view names and structure key prefixes are unchanged, so cell-study `slides` links, zoom chips and question `zoom` fields keep working.

## What changed in the question bank

- `accept` lists now hold every structure of the asked type on the real slide. For example, every myelin ring in the labelled fascicle is accepted, not 196 drawn ones. `target` is the accepted structure nearest the question's view centre.
- The bank title is now "Histology of the limbs (real slides; bone still stylised)".
- `hist-muscle-sarcomere-mag` now opens with the `outline` layer, so its hint ("the outlined span") is true. The hint text is updated to match.
- `hist-muscle-satellite-clin` has one added sentence. It says H&E cannot prove a satellite cell (that needs Pax7 or laminin) and that the accepted cell is the flattened nucleus pressed onto the fibre surface. That label is a best guess.
- Bone questions are untouched.

## Test results (copy of the app with this folder installed)

- `check_cells.py` reported 21 studies, 65 questions and 0 errors.
- `ALL=1 smoke_test_cells.mjs` passed 42 of 42 at 1280x800 and 390x844, with 0 page errors.
- `zoom_test_cells.mjs` reported 0 failing.
- Screenshots are in `shots/`.

## How the labels were made, and their limits

Labels are semi-automatic: colour deconvolution, ridge filters and blob detection, with hand-traced outlines for the large structures. Each was checked visually against overlays. They are good enough for click questions, not for pixel-accurate segmentation.

- **Artery.** The lumen, the internal-elastic-lamina band (lumen plus intima out to the IEL folds) and the adventitia outline are automatic. The media and external-elastic-lamina boundary is hand-traced. Nuclei are split by layer: endothelial (within about 16 µm of the lumen), smooth muscle (media and deeper intima) and fibroblast (adventitia). There are no vasa vasorum or companion-vein labels.
- **Nerve.** The nine fascicle outlines (`perineurium-N`, including the pale subperineurial cleft) and the two epineurial arteries (`vessel-N`) are hand-traced. Adipocytes are automatic. To keep `study.json` under 1 MB, myelinated fibres (`myelin-N` ring, `axon-N` centre) and Schwann nuclei are labelled only in the central fascicle, which the question views open on. A click inside another fascicle answers "Perineurium (fascicle outline)".
- **Muscle, longitudinal.** The 11 fibres in the central 1700 px square are hand-traced strips. Endomysium comes from automatic pale-cleft detection. Nuclei are automatic and labelled within that square. `capillary-1` is a cross-cut capillary holding a red cell. `sarcomere-1` is one 2.5 µm period, which is very small even at 40x.
- **Muscle, transverse.** Fibres are automatic, from a ridge-filter watershed. A few fibres are split in two and a few pairs are merged, which is fine because every fibre is accepted. There are three perimysium septa: one hand-traced with its neurovascular bundle, and two automatic. Nuclei are labelled in the upper-centre region that the views open on. There are no `fascicle`, `epimysium`, `artery` or `vein` labels.

## Bone

The coordinator's brief named University of Michigan virtual slides as the intended source. Those and Wikimedia Commons are blocked by this cloud environment's network policy. IDC was searched for bone, covering pediatric bone tumours, rhabdomyosarcoma, myeloma and lymphoma marrow trephines, and PDX models. No slide shows normal cortical bone with osteons, periosteum or osteoclasts. The closest is a lamellar trabecula in a myeloma trephine (cmb_mml, MSB-02929), which is not usable for the osteon, canal and osteoclast questions. A real bone slide needs an image fetched from a machine that can reach Wikimedia Commons or the Michigan site, then `build_slide.py` with new outlines.

## Rebuilding

`tools/` holds the scripts as run, with hard-coded paths under `/home/claude/hist`. `region.py` cuts a field from an IDC slide. `make_meta.py` writes the meta and calls `build_slide.py --b64 --quality 76`, and `make_q.py` rewrites the question accept lists. The fields in level-0 pixels of each IDC slide are:

- **artery:** x 2688, y 3072, 6144 x 6144, then scaled by 1/1.5.
- **nerve:** x 5508, y 9588, 4096 x 4096.
- **muscle-ls:** x 13312, y 24192, 4096 x 4096.
- **muscle-ts:** x 24768, y 9728, 6144 x 6144, then scaled by 1/1.5.

Tile sizes at JPEG quality 76 are 2.7 to 5.5 MB per slide, under the 6 MB budget. With the `.b64.txt` twins, each folder is 7 to 14 MB.
