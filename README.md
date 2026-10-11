# Hand Nerves 3D Challenge

The 3D anatomy practice app (milestone 2 of the Anatomy and Imaging Practice
Suite PRD): one static page with a hand and forearm model and a bank of 50
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
assets/model/arm.glb        the model (5.0 MB, 141 meshes incl. marrow cores, ~300k triangles)
assets/model/structures.json   mesh -> structure/layer map, display names, forearm axis
vendor/three/               Three.js 0.169 (MIT): core, TrackballControls, GLTFLoader
tools/build_model.py        rebuilds arm.glb from BodyParts3D files
tools/parts.py              which BodyParts3D parts are used, and the structure names
tools/nerves.py             schematic nerve and artery paths
tools/serve.py, report.py   local server and metrics (per set, per question accuracy)
tools/smoke_test.mjs        end-to-end browser test (Playwright); ALL=1 plays every question
tools/questions_md.py       regenerates docs/question-review.md from the bank
docs/question-review.md     all 50 questions laid out for clinician review
```

## Questions and sets

Each record in `assets/questions/upper-limb.json` is renderer-independent:
`target` and `accept` are structure keys (from `assets/model/structures.json`),
`view` and `layers` set the starting camera and visible layers, `tags` give
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

## The model

Source: [BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/) 3.0
(DBCLS), licensed **CC BY 4.0** (per the DBCLS license page, updated 2025-02-27; it
was CC BY-SA 2.1 JP before). The attribution footer on the page is required
by the license; there is no share-alike obligation on the modified meshes.

What was done to it (`tools/build_model.py`): the right arm's bones, forearm
and hand muscles, flexor retinaculum, interosseous membrane and skin were
cropped from fingertips to just above the elbow, long tendons were split off
the extrinsic muscles into their own layer by local thickness, every mesh
was simplified for phones, and each bone got a shrunken copy as a marrow
core so the cross-section shows cortex around medulla. Cut faces are drawn
with a stencil-capping pass per layer (skin cap doubles as subcutaneous fat).

**BodyParts3D has no forearm or hand nerves and no radial or ulnar artery
trunks** (checked in the 3.0 parts list and the 4.x manifest; 4.x only has a
few digital branches). The median, ulnar and radial nerves with their main
branches, and the radial and ulnar arteries with the superficial palmar arch,
are therefore **schematic tubes** placed by hand against this model's muscles
and bones (`tools/nerves.py`). They show the course, not true calibre or
branching, and the page says so. They need the same clinician review as the
questions.

To rebuild: download `BodyParts3D_3.0_obj_95.zip` from the link above (or the
STL mirror at github.com/Kevin-Mattheus-Moerman/BodyParts3D), then

```
python3 -m pip install numpy scipy trimesh fast-simplification rtree shapely mapbox_earcut networkx
python3 tools/build_model.py <dir with the .obj or .stl files>
python3 tools/build_model.py --cached      # after editing nerves.py only
```

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
