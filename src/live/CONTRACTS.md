# Live mode: module contracts

Shared contract for the seven Live workstreams. Each workstream owns the files listed in
`docs/live/live-mode-prd.md` (Build plan) and nothing else. Every module is a plain ES module
under `src/live/`, no bundler, no framework, same style as `src/app.js` (2-space indent,
double quotes, semicolons, `$()` helpers local to the module). Nothing here may fetch from
another origin at runtime; models and data are served from the repo (`vendor/`, `assets/`).

## 1. Coordinates

- Image space: `{ x, y }` normalised 0..1 over the **un-mirrored** camera frame (x grows to the
  image right). The view mirrors for display; modules never mirror.
- World space (from MediaPipe): `{ x, y, z }` in metres, pose origin at the hip midpoint.
- A landmark: `{ x, y, z, v }` where `v` is visibility/presence 0..1 (hands: `v = 1`).
- Side names are the **user's** anatomical side (`"left" | "right"`), already corrected for the
  selfie camera. `tracking.js` does this correction once; nobody else flips.

## 2. tracking.js (workstream B)

```js
export async function createTracker({ video, onFrame, onStatus, budgetMs = 33 }) -> Tracker
// Tracker
tracker.start()            // starts requestVideoFrameCallback / rAF loop
tracker.stop()             // stops loop; models stay warm
tracker.dispose()          // frees models
tracker.setNumHands(n)     // 1 or 2 (budget fallback)
tracker.stats              // { fps, poseMs, handMs, backend: "mediapipe-gpu" | "mediapipe-wasm" | "tfjs" }
```

`onFrame(frame)` is called at most once per video frame with:

```js
{
  t: 1234.5,                        // performance.now() ms
  width, height,                    // video pixel size
  pose: null | {                    // null when no person
    landmarks: Landmark[33],        // image space, BlazePose indices
    world: Landmark[33],            // world space
    mask: null | { width, height, data: Uint8Array } // person mask, 0/255, optional
  },
  hands: [                          // 0..2 entries, order stable by handedness
    { side: "left" | "right", landmarks: Landmark[21], world: Landmark[21], score: 0..1 }
  ]
}
```

`onStatus(status)` with `status` in `"loading" | "tracking" | "no-person" | "slow" | "error"`
plus an optional `message` string for the status pill.

Fixture mode: `createTracker({ fixture: "tools/live/fixtures/<name>.json" })` replays recorded
frames from JSON (`{ fps, frames: [frame, ...] }`) instead of running models, so Playwright tests
never need a camera. Workstream B records at least one fixture, `forearm-point.json`, with a
person pointing at their own right forearm, and one `two-hands-probe.json`.

## 3. pointing.js (workstream C)

```js
export async function createPointer({ segmentsUrl = "assets/live/segments.json" }) -> Pointer
pointer.update(frame) -> PointResult | null       // pure function of the frame, no DOM
pointer.outline(frame, segmentId) -> {x,y}[]      // polygon in image space for the overlay
```

`PointResult`:

```js
{
  hand: "left" | "right",         // the pointing hand
  tip: { x, y },                   // fingertip, image space
  segment: "forearm",              // id from segments.json
  side: "left" | "right" | null,   // body side of that segment (null for midline: head, neck, trunk)
  frac: 0..1,                      // proximal 0 -> distal 1 (trunk: top 0 -> bottom 1)
  facing: "front" | "back",        // which surface of the body faces the camera
  aspect: "front" | "back" | "inner" | "outer" | null,
  region: { model: "arm", key: "forearm", label: "Right forearm" },
  structures: [ { key: "radius", name: "Radius", layer: "bone" }, ... ],  // headline first, then the region's list
  stable: true | false             // true after 400 ms in the same segment + band
}
```

`assets/live/segments.json`:

```json
{
  "version": 1,
  "segments": {
    "forearm": {
      "label": "Forearm",
      "from": [13, 14], "to": [15, 16],          // pose indices [left, right]; trunk/head use "poly"
      "model": "arm",                            // key of CONFIG.models / assets/model/*.structures.json
      "bands": [ { "frac": [0, 1], "region": "forearm" } ],
      "headline": { "front": ["radius", "ulna", "flexor_carpi_radialis", "median_nerve", "radial_artery"],
                    "back":  ["radius", "ulna", "extensor_digitorum", "radial_nerve"] }
    }
  }
}
```

Structure keys and names come from the model's structures JSON (`regions`, `structures`, `nodes`
with `layer`); pointing.js loads those files via `CONFIG.models[model].structuresUrl` and must not
duplicate their contents. The arm model's file is `assets/model/structures.json`.

## 4. probe.js and probe-us.js (workstreams D and E)

```js
export async function createProbe({ studiesUrl = "assets/live/studies.json", renderers }) -> Probe
probe.modalitiesFor(point)  -> [ { id: "ct" | "mri" | "xray" | "ultrasound", label, study, simulated: bool } ]
probe.request(point, probeTip, modality) -> ProbeRequest | null
probe.apply(req)            -> Promise<void>   // drives renderers[kind].show({ study, view, layers })
```

`probeTip` is the other hand's `{ tip: {x,y}, dir: {x,y} }` (dir = unit vector from hand
landmark 5 to 8 in image space). `ProbeRequest`:

```js
{
  kind: "volume" | "xray" | "ultrasound",     // renderer kind in src/renderers/switch.js
  study: "ts-s1042",
  view: { plane: "axial", frac: 0.42, window: "soft" }          // volume (CT, MRI)
     |  { axis: "ap" | "lat", frac: 0.42 }                       // xray (see xray.js parseView)
     |  { frac: 0.42, angle: 15, tilt: 0, rot: 0 | 90, depth: 16 } // ultrasound (views.json fields)
  caption: "Right forearm, transverse, 40% from the elbow",
  simulated: true | false
}
```

`renderers` is the object returned by `createRendererSwitch` in `src/renderers/switch.js`; the
view (workstream A) creates one for the Live scan window. Plane rule: finger `dir` within 35°
of the segment axis = longitudinal (`rot: 90`, volume `plane: "coronal"` or `"sagittal"` by
aspect), otherwise transverse (`rot: 0`, `plane: "axial"`).

`assets/live/studies.json` (workstream D owns the file; E adds only `ultrasound` entries):

```json
{
  "version": 1,
  "studies": {
    "ts-s1042": {
      "kind": "volume", "modality": "CT", "segment": "trunk", "side": null,
      "frac": [0.0, 0.45],            // the body-fraction span this study covers
      "axis": 2,                      // voxel axis that runs along the segment (0 = x, 1 = y, 2 = z)
      "slices": [10, 140],            // voxel index range matching frac[0] .. frac[1]
      "proximalIsHigh": true,         // frac 0 is at slices[1] when true
      "window": "soft"
    }
  },
  "ultrasound": {
    "ts-s1042": { "segment": "trunk", "frac": [0.0, 0.45], "angleFront": 0, "angleBack": 180, "depth": 16 }
  }
}
```

Real ultrasound frame stacks (workstream E): `assets/usframes/<id>/stack.json` +
`frames/NNN.jpg`, format in `docs/live/frame-format.md`; renderer `src/renderers/usframes.js`
exposes the same `show/highlight/clearHighlight/setPickEnabled/setActive` surface as the other
scan renderers so the switch can host it under kind `"usframes"`.

## 5. view.js (workstream A)

Owns `#live` in `index.html`, `src/live/live.css`, and the only lines added to `src/app.js`:
registering the Live button and `openLive()` / `closeLive()`. `view.js` exports:

```js
export function createLiveView({ root, onExit, openExplore, config }) -> { open(), close(), get active() }
```

It wires tracker -> pointer -> probe each frame, draws the overlay (landmarks, outline, probe
glyph) on a canvas over the video, fills the structures panel, and hosts the scan window.
The camera MediaStream is stopped in `close()` and on `visibilitychange` after 30 s hidden.

## 6. Tests

Each workstream adds a Playwright script under `tools/live/` runnable as
`node tools/live/<name>.mjs http://127.0.0.1:<port>/ /opt/pw-browsers/chromium` against
`python3 tools/serve.py --port <port>`. Pure logic (pointing, probe maths) also gets a Node
unit script that needs no browser. Use the port your brief assigns so parallel runs do not collide.
