# Open Body 3D

Open Body 3D is the 3D anatomy practice app (milestone 2 of the Anatomy and Imaging Practice
Suite PRD): one static page with a whole upper limb model (shoulder to fingertips) and a bank of 50
"click the structure" questions served as sets of 10 (daily, random, by topic,
clinical cases). No accounts, no build step.

## Run it

```
python3 tools/serve.py            # http://127.0.0.1:8000
```

`serve.py` serves the page and also keeps a local JSON copy of the analytics
events in `data/events.jsonl` (and of signups in `data/signups.jsonl` when the
built-in signup dialog is used). Read the milestone metrics with:

```
python3 tools/report.py
```

Any static host can serve the page too (everything is plain files).

## Hosted services

Two third-party scripts are loaded from `index.html`; the page works without
them (ad blockers, offline), it just counts and collects nothing.

- **Kit** (kit.com) hosts the email signup. The "Get 50 more questions" button
  opens Kit's modal form `0580fa41c5` (`kitFormUid` in `src/config.js`); Kit
  stores the emails, and the dashboard at kit.com lists subscribers. Set
  `kitFormUid` to `""` to use the built-in dialog that posts to `signupUrl`
  instead. The form's display timing is set on kit.com (Grow › Forms › Settings
  › Display): leave it to open only on click, or Kit pops it up on its own.
- **GoatCounter** (kadin.goatcounter.com) counts page views and the events
  below. It stores nothing in the visitor's browser and keeps no IP addresses.
  Views from localhost are not counted, so local testing does not show up
  there; the local `data/events.jsonl` copy does record them.

## Layout

```
index.html, styles.css      the page: body map home (Explore, Quiz, Histology, Imaging, Live), quiz and explore UI
src/app.js                  wiring: boot, DOM callbacks, modes, set chooser, share, signup
src/engine.js               quiz engine: state, score, timer, feedback, share URL (no DOM, no three)
src/sets.js, bank.js        question sets (daily, random, per topic, clinical) and the bank loader
src/bodymap.js              the home body map and Explore entry
src/volume.js               shared volume/study loading for CT, MRI and X-ray
src/webgl-probe.js          WebGL2 capability check (also used by Live)
src/analytics.js, config.js anonymous events; endpoints, model list, draft-question gate
src/renderers/              mesh (Three.js 3D models), volume (Cornerstone3D CT/MRI), xray + drr, ultrasound + bmode,
                            slide (histology), cell, switch (renderer switcher)
src/live/                   Live mode: CONTRACTS.md, view.js, live.css, tracking, pointing, probe modules
assets/model/               GLB meshes and structures.json per model (upper limb, lower limb, ...)
assets/questions/           question banks (JSON, one per model/topic)
assets/volumes/, usframes/, ultrasound/   CT/MRI studies, simulated ultrasound frames and view definitions
assets/slides/, cells/      histology tile pyramids; cell models and diagrams
assets/bodymap/, ontology/  body map figure; structure ontology and imaging crosswalk
assets/live/, assets/ml/    Live data (segments, studies) and the MediaPipe model files
assets/source/              untouched upstream downloads used by the build scripts
vendor/                     three, cornerstone, mediapipe (all served locally, no CDN)
tools/                      serve.py, report.py, build/import scripts, Playwright tests (*_test.mjs, smoke_test*.mjs)
tools/live/                 Live import scripts and tests
docs/                       reviewer sheets, format notes, docs/live/ for Live mode
```

## Questions and sets

Each record in `assets/questions/upper-limb.json` is renderer-independent:
`target` and `accept` are structure keys (from `assets/model/structures.json`),
`view` and `layers` set the starting camera and visible layers, `focus` (hand, forearm, arm, shoulder or all; defaulted from `tags.region` if missing) says which part of the limb the camera frames, `tags` give
topic, region and difficulty, and `review` records the clinician sign-off
(`{"status":"approved","by":"...","date":"YYYY-MM-DD"}`). Every record is
currently `draft`. `CONFIG.includeDraftQuestions` in `src/config.js` is `true`
so drafts show; set it to `false` before a public launch so only approved
questions are served.

Sets are chosen on the intro card or by URL: `?set=daily` (same 10 for
everyone each UTC day), `?set=random`, `?set=kind:Clinical`,
`?set=topic:nerves` (also muscles, bones, vessels, ligaments). A share link
carries the exact questions played (`?q=id1,id2,...&s=score&t=seconds`), so a
friend plays the same set.

The engine talks to a renderer through five calls (`show`, `highlight`,
`clearHighlight`, `name`, `setPickEnabled`), so a volume renderer for CT
questions (milestone 3) plugs in beside `renderers/mesh.js`.

**CT questions.** A record with `"renderer": "volume"` and a `"study"` field (records without `renderer` are mesh) is drawn by the Cornerstone3D volume viewer instead of the 3D model; `view` and `layers` are described in `docs/imaging/renderer-spec.md`. There is one volume renderer; it loads each question's study on demand and caches it, so a set may span several studies. Scan sets are one per modality and body region (`?set=ct:abdomen`, `ct:chest`, `mri:abdomen`, `mri:pelvis`), grouped under "Scans" in the chooser; daily, random, clinical and topic sets stay mesh-only. Six real TotalSegmentator studies ship in `assets/volumes/` (cases s0513, s1383, s1390 abdomen and s1042, s1164, s1337 chest from the v2.0.1 small subset, Zenodo record 10047263, CC BY 4.0, packed with `tools/pack_study.py --crop --max-dim 160` to 2.3 to 3.2 mm voxels and under 4.5 MB each; `assets/volumes/index.json` lists them) with 40 draft questions in `assets/questions/ct-trunk.json` and `ct-chest.json`; `tools/check_questions.py` validates banks against the manifests, and the review sheet is `docs/ct-question-review.md`. The 3 mm sample `ts-example-sm` stays for tests. The full 1,228-case dataset is Zenodo record 10047292.

**Home.** The root URL opens on a home screen (`src/hero.js`): a whole-body figure from `assets/model/hero.glb` (BodyParts3D skeleton, muscles and organs; metres, Y up, faces +Z, feet at y=0, top-level nodes `bone`, `muscle`, `organ`) turning once every 20 s in its own canvas, with Explore, Quiz and Credits buttons under it. Dragging turns the figure and pauses the spin for about 3 s; with `prefers-reduced-motion` it does not spin. The traced body-map figure stands in while the file loads, or if WebGL is missing. The canvas is released when the student leaves home. The brand button "Open Body 3D" in the top bar returns home from anywhere; Explore and Quiz push a history entry so the browser Back button does too. A `?set=` or shared-score link skips home and opens on the quiz chooser.

**Explore mode.** Explore opens a body map (`src/bodymap.js`; the figure is `assets/bodymap/figure.svg`, drawn from the 3D models by `tools/build_bodymap_figure.*`, with the old hand-drawn outline as a fallback) whose regions (head, upper limb, chest, abdomen, pelvis, lower limb, plus tissues and cells) are also listed as chips. Clicking a region opens it on its first option with a clean screen: a top bar (home, a breadcrumb *region › structure › deeper view*, quiz stats while a set runs) and, on 3D models, one floating toolbar at the bottom (Views, zoom out, zoom in, Fit, Layers, Slice). The region crumb opens a menu with what to look at there (the 3D model and every CT, MRI, X-ray or ultrasound study a bank asks about in that region, grouped by `tags.region` and `tags.modality`), a study picker, the model's zoom regions (Hand, Forearm, ...) and the other regions. Clicking a structure on a model opens the details panel: its name and layer, **Histology** (slides whose `sections` list it, else a representative slide of the same layer; inside a slide, "Zoom to a cell" chips) and **Imaging** (every scan whose labels include it, through `assets/imaging-crosswalk.json`, built by `tools/build_crosswalk.py`; the scan opens with the structure filled), plus Isolate, Hide and "Quiz me on this". The breadcrumb, Back or Esc return to the same camera and selection. Keys: F fits, L opens layers, + and − zoom, Esc closes. Licence lines sit in the Credits drawer, opened from the home screen. `tools/explore_test.mjs` covers it and `tools/phone_shot.mjs` takes the phone screenshots.

**Quiz mode.** The Quiz switch shows the set chooser with a search box: a structure, topic or scan name lists the matching sets and, per model or modality, the questions that mention it, each startable as its own set. A Quiz button in every explore view starts the set for what is on screen (the model's Random 10, or the set asked on that scan); a shared link or `?set=` opens on Quiz.

**Five 3D models.** `CONFIG.models` lists the meshes (upper limb, lower limb), each with a GLB and a structures.json; a bank file's top-level `model` says which one its questions are asked on, and sets are grouped by model in the chooser (the first model keeps the original set ids, the others are prefixed, e.g. `?set=lower-limb:daily`). The switch builds one mesh renderer per model on first use; the active one owns the layer checkboxes, the cross-section slider, the view and zoom buttons (rebuilt from the model's `regions`, labelled by `regionLabels`/`viewLabels` when present) and the attribution line (chosen from `meta.source`). Both models are built at about 3 MB (`--scale 0.5 --error 0.003` on the build tools, roughly 200k triangles each; the default settings give 6 MB and 400k), and the page downloads only the active model plus three.js (about 4 MB) at startup; the CT viewer library is imported on the first scan set (`tools/startup_bytes.mjs` reports a cold load). The lower limb ships as `assets/model/lower-limb.glb`, converted from the Open3DModel lower limb GLB (CC BY-SA 4.0, source kept in `assets/source/open3dmodel/lower-limb.glb`) by `tools/lower_limb/build_o3d_lower.mjs`: real lumbar and sacral plexus nerves, arteries, named veins, knee and ankle ligaments and menisci, 168 structures, with 66 draft questions in `assets/questions/lower-limb.json` and the review sheet in `docs/lower-limb-question-review.md`. An earlier BodyParts3D build with schematic nerves (`tools/lower_limb/build_lower_limb.py`, STL files in `/mnt/project-files/lower-limb/source/`) is kept as a fallback in `/mnt/project-files/lower-limb/assets/model-bodyparts3d/`. A region frames its listed structures on any layer, so the lower-limb knee region can list menisci and ligaments beside the patella. `tools/switch_test.mjs` checks switching between models. A third model, the trunk (`assets/model/trunk.glb`, built from BodyParts3D 3.0, CC BY 4.0), has 169 structures including schematic nerves and vessels and a new `organ` layer that is off by default, with 60 questions in `assets/questions/trunk.json`. The chest, abdomen and pelvis regions of the body map open it, and its attribution line comes from the manifest's `source`. Two more models come from Z-Anatomy (CC BY-SA 4.0, itself derived from BodyParts3D): the neck (`assets/model/neck.glb`, 121 structures from the skull base to T1) and the head (`assets/model/head.glb`, 123 structures: the 22 skull bones, facial and masticatory muscles, cranial nerves, and schematic nerves, cranial sutures and 17 foramen rings); the head region of the body map opens the head model, with the neck as a second 3D entry. The head manifest labels an `inferior` view, so a "Base" button (the skull seen from below) appears only for it, and the footer shows the Z-Anatomy line; the 100 questions (40 neck, 60 head) are in `assets/questions/neck.json` and `head.json`, with review sheets in `docs/neck-question-review.md` and `docs/head-question-review.md`.

**X-ray and ultrasound.** Both are computed in the browser from the CT studies already shipped, so they add no assets: `src/renderers/xray.js` (with `drr.js`) renders digitally reconstructed radiographs (AP and lateral) with the labelmap projected along the same rays, so every pixel picks a structure, plus outlines by group, brightness, contrast, invert and zoom; `src/renderers/ultrasound.js` (with `bmode.js`) simulates a B-mode sector from a virtual probe that the student drags on the image or a mini-map (level, tilt, transverse or longitudinal, depth, gain, freeze), with 47 named probe views in `assets/ultrasound/views.json`. Question records use `"renderer": "xray"` or `"ultrasound"` with a `study`; banks are `xray-chest.json` (20), `xray-abdomen.json` (15) and `us-trunk.json` (24), review sheets in `docs/question-review-xray.md` and `docs/question-review-ultrasound.md`. Sets are grouped "X-ray" and "Ultrasound" (`?set=xray:chest`, `us:abdomen`). Tests: `tools/xray_unit_test.mjs`, `tools/us_unit_test.mjs`, `KIND=xray|ultrasound ALL=1 tools/smoke_test_xray_us.mjs`, `tools/layout_test_xray_us.mjs`. The films and scans are teaching simulations at CT resolution, not patient images, and the footer says so.

**MRI questions.** The same volume renderer draws MR studies. A study's `study.json` declares `"modality": "MR"`, a `sequence` (T1, T2), its window presets with labels and a `defaultWindow`, and its own `attribution`, `license` and `sourceUrl`, which the footer shows while that study is active; `docs/mri-format.md` describes the fields. MR signal is rescaled to 0..4095 by `tools/pack_study.py --modality MR` (CT output is unchanged), and `tools/merge_masks.py` turns a TotalSegmentator per-structure mask folder into the single labelmap it needs. Sets are titled by modality ("CT scan", "MRI: Abdomen", "MRI: Pelvis"). Two sample MR studies ship: `ts-mr-example-sm` (T1 abdomen, 3 mm, the TotalSegmentator MRI example, CC BY-NC-SA 4.0; the sequence is inferred and awaits clinician confirmation) and `msd-prostate-04` (T2 prostate, Medical Segmentation Decathlon, CC BY-SA 4.0), plus two Decathlon regions, `msd-heart-03` (3D cardiac MR, left atrium, CC BY-SA 4.0; packed with `--axes ASL` because its NIfTI has an identity affine) and `msd-hippocampus-01` (T1, CC BY-SA 4.0), and the brain in three weightings, `mni-brain-t1`, `mni-brain-t2` and `mni-brain-pd` (MNI152 2009c template via TemplateFlow, MNI licence, free use with attribution; one shared 36-structure aseg labelmap, questions carry `layers: []` so no outline paints over the image), with 18, 4, 4, 4, 10, 6 and 4 questions in `assets/questions/mri-*.json` and the review sheet in `docs/mri-question-review.md`. `tools/smoke_test_mri.mjs` plays every MRI set. More studies come from Zenodo record 11367005 (TotalSegmentator MRI), packed the same way. Nine further TotalSegmentator MRI series (abdomen, pelvis, heart and thorax, head and neck, knee and whole body, `ts-mr-s0056` to `ts-mr-s0283`) are CC BY-NC-SA 4.0, with attribution in each `study.json`; their weightings (T1, T2, proton density) are inferred from echo time, because the dataset records only the sequence code.

**Histology slides and 3D cells.** Two more renderer kinds, `slide` (a canvas tile-pyramid viewer, `src/renderers/slide.js`) and `cell` (a Three.js cell built from primitives, `src/renderers/cell.js`), with five slides under `assets/slides/<id>/` (skeletal muscle longitudinal and transverse, compact bone, peripheral nerve, muscular artery, each a 4096 px pyramid with labelled polygons and 10x/40x views) and twelve cells under `assets/cells/<id>/study.json` named by Cell Ontology id. All five slides are real micrographs: skeletal muscle in both planes, peripheral nerve and muscular artery are GTEx H&E fields from NCI Imaging Data Commons (CC BY 4.0), and compact bone is a ground section from the Berkshire Community College Bioscience Image Library (Flickr 39978305360, CC0 public domain dedication; 3264 x 1840 px, so its pyramid tops out at 3264). Further real Michigan Histology sections can be tiled in with `build_slide.py` as `docs/slide-pipeline.md` describes. Banks `histology-limb.json` (21) and `cells-limb.json` (32) form the Histology and Cells set groups (`hist:<tissue>`, `cell:<tissue>`) and the "Tissues and cells" body-map entry. A zoom chain links the levels: a slide's `sections` name the limb-model structures it cuts through and its `cells` the cell types on it, a cell's `slides` point back, and each question's `zoom` field gives "Zoom in" / "Zoom out" buttons on the explore bar and under an answer's explanation (those leave the quiz). `tools/check_cells.py` validates the studies and banks; `tools/smoke_test_cells.mjs` (KIND=slide|cell) and `tools/zoom_test_cells.mjs` exercise them in the browser; formats are in `docs/cell-formats.md`.

**Labelled cell diagrams.** The twelve stylised cells (`assets/cells/cl-*`, `generic-cell`) open as interactive labelled 2D diagrams: original SVG drawn for the app (CC BY-NC-SA 4.0, see `LICENSE-CONTENT.md`), one `<g data-part>` region per part using the same keys as the 3D model, so the `cells-limb.json` questions accept diagram clicks unchanged. Labels show with leader lines while exploring and hide during questions; hover names a part; drag pans and wheel or pinch zooms. The toolbar's Diagram / 3D buttons switch to the old hand-placed 3D model and back (remembered per browser). The footer credits whichever is on screen. Servier Medical Art was considered but could not be reached to confirm its licence. Format and palette: `docs/cell-diagrams.md`; `tools/check_diagrams.py` validates the SVGs against the studies and banks, `tools/diagram_shot.mjs` renders one for review, `tools/diagram_ui_test.mjs` checks labels, hover, the view switch and a clicked answer in the app.

**Real cells from the Allen Cell Explorer.** Four of the cells are reconstructions, not drawings: `assets/cells/allen-{mitochondria,er,golgi,nucleolus}/` come from the Allen Institute for Cell Science hiPSC Single-Cell Image Dataset (WTC-11 line, Viana et al., Nature 2023, CC BY 4.0 under the Allen Institute terms of use). `tools/allen_cells.py` reads a window of the dataset's metadata by HTTP range request, downloads one segmented single-cell crop per tagged structure, runs marching cubes on the membrane, nucleus and structure masks, smooths and coarsens them, normalises the cell to 10 scene units and writes one `model.glb` (plus its `.b64.txt` twin) per cell; `docs/allen-cells.md` has the details. A cell study with a `model` field and parts that name a `mesh` is drawn from that GLB by `src/renderers/cell.js` (loaded on demand, cached per study); everything else (layers, cutaway, labels, picking) is the same as for primitive cells. `tools/cell_glb_test.mjs` covers the loader on a fixture; `tools/allen_shot.mjs` screenshots the four cells in the app; `assets/questions/cells-real.json` asks about them.

## Licence

- **Code** (`index.html`, `styles.css`, `src/`, `tools/`): [PolyForm Noncommercial License 1.0.0](LICENSE). Free to use, change and share for any non-commercial purpose; commercial use needs a separate licence. PolyForm Noncommercial is a source-available licence, not an OSI-approved open source licence, because every OSI licence allows commercial use.
- **Project content** (question and explanation text, labels, structure maps, body map, stylised cells and diagrams): [CC BY-NC-SA 4.0](LICENSE-CONTENT.md), the same terms as the TotalSegmentator MRI scans.
- **Third-party models, scans, images and libraries** keep their own licences, listed in [`NOTICE.md`](NOTICE.md) and in the app under Credits.

The public copy is served by GitHub Pages at <https://kadinelbak.github.io/anatomyeducation/> from the root of `master` (`.nojekyll` keeps Pages from running Jekyll over the assets). On that host the local-only endpoints `api/event` and `api/signup` do not exist, so the JSON event copy and the built-in signup dialog are inactive there; GoatCounter and Kit still work.

## The model

Source: [Open3DModel](https://anatomytool.org/node/63858) upper limb (Leiden,
Utrecht, Maastricht and KU Leuven KULAK; anatomist-reviewed remesh of
Z-Anatomy), licensed **CC BY-SA 4.0** for the geometry. Its textures are
CC BY-NC-SA and are stripped. The attribution footer on the page is required;
share-alike means `arm.glb` stays CC BY-SA if redistributed.

What was done to it (`tools/build_o3d.mjs`, mapping in `tools/o3d_parts.json`):
the arm, forearm, hand and wrist, pectoral girdle, brachial plexus and the
ribs and sternum (as context) were kept; veins, bursae, tendon sheaths and the
fascial sleeves were left out; textures, UVs and materials were dropped; every
mesh was welded and simplified with meshoptimizer to about 400k triangles in
total; each long bone and carpal got a shrunken copy as a marrow core so the
cross-section shows cortex around medulla; positions and normals are quantized
(KHR_mesh_quantization, which Three.js reads without a decoder). Nerves and
arteries are real meshes now, so nothing is schematic.

The source file is kept at `assets/source/open3dmodel/upper-limb.glb`
(Draco-compressed, 6.9 MB, as downloaded 2025-07-24). To rebuild:

```
cd tools && npm i            # @gltf-transform/*, draco3dgltf, meshoptimizer
cd .. && node tools/build_o3d.mjs assets/source/open3dmodel/upper-limb.glb --out assets/model/arm.glb
```

The build fails and lists any source node missing from `tools/o3d_parts.json`;
`--list` prints the selected node names.

The previous model (milestone 1) came from BodyParts3D 3.0 (DBCLS, CC BY 4.0)
via `tools/build_model.py`, `tools/parts.py` and `tools/nerves.py`, which are
kept for reference; its nerves and arteries were hand-placed tubes.

## Live mode

Live is the fourth entry on the home screen (after Explore, Quiz and Imaging). Click **Live** (`#go-live`)
and allow the camera. The browser runs MediaPipe pose and hand landmarkers on your video. Point at your own
body with one index finger and the app lists the structures of that region; the other hand's index finger is a
virtual probe that scrubs through CT, MRI, X-ray and simulated ultrasound slices of the region. The brand
button returns to the body map and stops the camera.

Requirements: a camera, a secure context (HTTPS, or `127.0.0.1`/`localhost`) and WebGL2. Without them Live shows
a fallback card instead of the camera view; the rest of the app is unaffected.

Privacy: nothing is uploaded and no frames are stored. Landmark detection runs in the page, the model files are
served from this repo (`vendor/mediapipe`, `assets/ml`), and the camera is stopped on every exit (back button,
mode switch, tab hidden, page close). The usage counter may count that Live was opened, never what was pointed at.

Tests (each `tools/live/*_test.mjs` takes a base URL and an optional Chromium path, like `tools/smoke_test.mjs`;
`W=390 H=844` runs at phone size):

```
python3 tools/serve.py --port 8137 &
node tools/live/smoke_test_live.mjs http://127.0.0.1:8137/ /opt/pw-browsers/chromium
node tools/live/view_test.mjs http://127.0.0.1:8137/ /opt/pw-browsers/chromium
```

The smoke test uses Chromium's fake camera, opens Live, fails on any request to a host other than the local
server (plus the page's existing GoatCounter and Kit scripts), then leaves via the brand button and checks the
camera tracks ended. Module contracts and the file map are in [`docs/live/README.md`](docs/live/README.md); the
pre-release list is `docs/live/release-checklist.md`.

## Testing

```
npm i -D playwright          # once; needs a Chromium it can launch
python3 tools/serve.py --port 8123 &
node tools/smoke_test.mjs http://127.0.0.1:8123/
```

The test plays the 10 original questions by clicking each answer on screen
from the question's starting view, then checks the score, the share link and
the signup form. `W=390 H=844 TOUCH=1` runs it at phone size; `ALL=1` plays
every question in the bank and lists any whose answer is not clickable from
its starting view. Pass `/opt/pw-browsers/chromium` (or any Chromium path) as
a third argument if Playwright has no browser of its own.

## Analytics events

`visit` (with `via`: direct, referral, share), `return_visit` (a visitor back
between 1 hour and 7 days after their first visit), `start` (`set`, `n`),
`answer` (`q`, `qid`, `correct`, `clicked`, `ms`, `set`, `n`), `finish`
(`score`, `seconds`, `set`, `n`), `share_click`, `signup_open`, `signup` (on
Kit's `ckjs:submission:complete` event), plus `explore`, `select`, `quit` and
`quiz_fab` from the explore UI. `src/analytics.js` sends each one to
GoatCounter as an event count (`start`, `answer-correct`, `answer-wrong`,
`finish-7of10`, `share-click`, `signup-open`, `signup`, `visit-share`, ...;
GoatCounter keeps counts per name, so the other fields are dropped) and, when
`eventsUrl` is set, as JSON to `serve.py` with a random `visitor` id
(localStorage) and `session` id (sessionStorage); no personal data.
