# Hand Nerves 3D Challenge

The 3D anatomy practice app (milestone 2 of the Anatomy and Imaging Practice
Suite PRD): one static page with a whole upper limb model (shoulder to fingertips) and a bank of 50
"click the structure" questions served as sets of 10 (daily, random, by topic,
clinical cases). No accounts, no build step.

## Run it

```
python3 tools/serve.py            # http://127.0.0.1:8000
```

`serve.py` serves the page and also collects anonymous analytics events and
email signups into `data/events.jsonl` and `data/signups.jsonl`. Read the
milestone metrics with:

```
python3 tools/report.py
```

Any static host can serve the page too (everything is plain files); point
`src/config.js` at wherever events and signups should go, or set both URLs to
`""` to disable them.

## Layout

```
index.html, styles.css      the page
src/app.js                  wiring: boot, DOM callbacks, set chooser, share, signup
src/engine.js               quiz engine: state, score, timer, feedback, share URL (no DOM, no three)
src/renderers/mesh.js       the Three.js renderer: model, layers, cross-section, picking, highlight
src/sets.js                 question sets: daily (seeded by UTC date), random, per topic, clinical
src/bank.js                 loads the question bank JSON
src/analytics.js            anonymous events (random visitor id in localStorage)
src/config.js               endpoints and the draft-question gate
assets/questions/upper-limb.json   the question bank (50 records, see below)
assets/model/arm.glb        the model (6 MB, 415 meshes incl. marrow cores, ~400k triangles)
assets/model/structures.json   mesh -> structure/layer map, display names, regions, limb axis
vendor/three/               Three.js 0.169 (MIT): core, TrackballControls, GLTFLoader
tools/build_o3d.mjs         rebuilds arm.glb from the Open3DModel GLB (see below)
tools/o3d_parts.json        source node -> structure key, layer, display name
tools/build_model.py, parts.py, nerves.py   the old BodyParts3D pipeline (milestone 1)
tools/serve.py, report.py   local server and metrics (per set, per question accuracy)
tools/smoke_test.mjs        end-to-end browser test (Playwright); ALL=1 plays every question
tools/questions_md.py       regenerates docs/question-review.md from the bank
docs/question-review.md     all 50 questions laid out for clinician review
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

**Two 3D models.** `CONFIG.models` lists the meshes (upper limb, lower limb), each with a GLB and a structures.json; a bank file's top-level `model` says which one its questions are asked on, and sets are grouped by model in the chooser (the first model keeps the original set ids, the others are prefixed, e.g. `?set=lower-limb:daily`). The switch builds one mesh renderer per model on first use; the active one owns the layer checkboxes, the cross-section slider, the view and zoom buttons (rebuilt from the model's `regions`, labelled by `regionLabels`/`viewLabels` when present) and the attribution line (chosen from `meta.source`). The lower limb ships as `assets/model/lower-limb.glb`, converted from the Open3DModel lower limb GLB (CC BY-SA 4.0, source kept in `assets/source/open3dmodel/lower-limb.glb`) by `tools/lower_limb/build_o3d_lower.mjs`: real lumbar and sacral plexus nerves, arteries, named veins, knee and ankle ligaments and menisci, 168 structures, with 46 draft questions in `assets/questions/lower-limb.json` and the review sheet in `docs/lower-limb-question-review.md`. An earlier BodyParts3D build with schematic nerves (`tools/lower_limb/build_lower_limb.py`, STL files in `/mnt/project-files/lower-limb/source/`) is kept as a fallback in `/mnt/project-files/lower-limb/assets/model-bodyparts3d/`. A region frames its listed structures on any layer, so the lower-limb knee region can list menisci and ligaments beside the patella. `tools/switch_test.mjs` checks switching between models.

**MRI questions.** The same volume renderer draws MR studies. A study's `study.json` declares `"modality": "MR"`, a `sequence` (T1, T2), its window presets with labels and a `defaultWindow`, and its own `attribution`, `license` and `sourceUrl`, which the footer shows while that study is active; `docs/mri-format.md` describes the fields. MR signal is rescaled to 0..4095 by `tools/pack_study.py --modality MR` (CT output is unchanged), and `tools/merge_masks.py` turns a TotalSegmentator per-structure mask folder into the single labelmap it needs. Sets are titled by modality ("CT scan", "MRI: Abdomen", "MRI: Pelvis"). Two sample MR studies ship: `ts-mr-example-sm` (T1 abdomen, 3 mm, the TotalSegmentator MRI example, CC BY 4.0; the sequence is inferred and awaits clinician confirmation) and `msd-prostate-04` (T2 prostate, Medical Segmentation Decathlon, CC BY-SA 4.0), with 18 and 4 draft questions in `assets/questions/mri-*.json` and the review sheet in `docs/mri-question-review.md`. More studies come from Zenodo record 11367005 (TotalSegmentator MRI), packed the same way.

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
(`score`, `seconds`, `set`, `n`), `share_click`, `signup_open`, `signup`. Every event carries a random `visitor` id
(localStorage) and `session` id (sessionStorage); no personal data. Emails go
only to `data/signups.jsonl`.
