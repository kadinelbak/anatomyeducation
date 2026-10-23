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
tracker.stats              // { fps, poseMs, handMs, faceMs, backend: "mediapipe-gpu" | "mediapipe-wasm" | "tfjs" }
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
  ],
  face: null | { blink: { left: 0..1, right: 0..1 } }  // 1 = eye closed; null when no face
}
```

`face` comes from the MediaPipe FaceLandmarker (`assets/ml/face_landmarker.task`, blendshapes
`eyeBlinkLeft`/`eyeBlinkRight`; no face landmarks are exposed). It runs on the frames where pose does
not (pose on even frames, face on odd ones); between runs the last reading is repeated. `left`/`right`
are the user's sides (the model's labels are swapped once, like handedness). If the face model fails to
load, `face` stays `null` and pose/hands are unaffected.

`onStatus(status)` with `status` in `"loading" | "tracking" | "no-person" | "slow" | "error"`
plus an optional `message` string for the status pill.

Fixture mode: `createTracker({ fixture: "tools/live/fixtures/<name>.json" })` replays recorded
frames from JSON (`{ fps, frames: [frame, ...] }`) instead of running models, so Playwright tests
never need a camera. Workstream B records at least one fixture, `forearm-point.json`, with a
person pointing at their own right forearm, and one `two-hands-probe.json`. A fixture frame may carry
`face` (passed through unchanged; `null` when absent). `record_fixture.mjs` accepts an optional
`"blinks": [[startMs, endMs], ...]` in a landmark description: frames inside a range get
`face.blink` 0.9/0.9, all others 0.05/0.05; without `blinks` no face field is written.

## 3. pointing.js (workstream C)

```js
export async function createPointer({ segmentsUrl = "assets/live/segments.json" }) -> Pointer
pointer.update(frame) -> PointResult | null       // frames + internal vote/lock state, no DOM
pointer.lock() -> bool        // force-lock the current leader now (the view calls it on a tap); false if none
pointer.unlock()              // release the lock; seeking restarts on the next frame
pointer.locked                // getter, bool
pointer.reset()               // forget all smoothing and lock state
pointer.outline(frame, segmentId, side?) -> {x,y}[]   // polygon in image space; "forearm" or "forearm:left"
pointer.outlines(frame) -> [ { id, side, label: "Right forearm", poly: {x,y}[] } ]  // every visible segment
pointer.measure(frame) -> { sample: Sample | null, hint: string | null }  // one calibration sample
pointer.calibrate(samples) -> Calibration | null  // median of >= 10 samples; null when too few
pointer.setCalibration(cal | null)                // override segment radii (null = defaults)
pointer.getCalibration() -> Calibration | null
pointer.setPointerHand(side | null)               // "left" | "right": only that hand may point; null = either
pointer.pointerHand                               // getter, "left" | "right" | null
```

Hand roles: with `setPointerHand(side)` only that hand's fingertip is a pointing candidate; the other
hand is the control hand (see section 7) and never selects, leads, locks or retargets a segment. With
`null` (the default) either hand may point, as before.

Selection is **coarse then fine**. The coarse key is the segment instance (`segment` + `side`).
It is chosen with a generous contact radius (1.4 x the segment radius), hysteresis (the leader
keeps the lead out to 1.3 x that contact radius unless a challenger's normalised distance is
below 0.6 x the leader's and at least 0.15 lower) and an 8-frame plurality vote on the coarse key.
`frac`, `aspect`, `region` and `structures` are refinement recomputed from the fingertip every
frame and never change the coarse key. When the same key has led for 900 ms it **locks**: segment
and side are frozen (fine fields keep refining while the tip is on that segment) until
`unlock()`, until no pointing candidate has been seen for 1500 ms, or until a different segment
has led for 1500 ms (the lock then releases and the new segment locks after its own 900 ms);
during the no-candidate grace period `update` keeps returning the locked result. Contacts are rejected when the pose model's own index
tip of the pointing hand (pose landmark 19 left / 20 right, visibility >= 0.3, within one shoulder
width of the hand tip) is nearer the camera than the limb at the contact point by more than 0.6
shoulder widths (pose `z`; skipped when every `z` is 0 or missing). A hanging arm's finger on its
own thigh or leg is ranked as a resting hand (+0.5), so the other hand's point wins.

`PointResult`:

```js
{
  hand: "left" | "right",         // the pointing hand
  tip: { x, y },                   // fingertip, image space
  segment: "forearm",              // id from segments.json (frozen while locked)
  side: "left" | "right" | null,   // body side of that segment (null for midline: head, neck, trunk)
  coarse: { segment: "forearm", side: "right", label: "Right forearm" },   // "Trunk", "Head", ...
  frac: 0..1,                      // proximal 0 -> distal 1 (trunk: top 0 -> bottom 1)
  facing: "front" | "back",        // which surface of the body faces the camera
  aspect: "front" | "back" | "inner" | "outer" | null,
  region: { model: "arm", key: "forearm", label: "Right forearm" },
  structures: [ { key: "radius", name: "Radius", layer: "bone" }, ... ],  // headline first, then the region's list
  progress: 0..1,                  // time the coarse key has led / 900 ms (1 once locked)
  locked: true | false,            // segment and side frozen
  stable: true | false             // alias of locked, for older callers
}
```

Calibration (arms-out stance: both wrists visible, each `|wrist.x - shoulder.x| > 1.1` and
`|wrist.y - shoulder.y| < 0.5` shoulder widths, hips visible). `measure` returns `sample: null` and
a short `hint` ("Step back so I can see your hips", "Hold your arms out to the sides") otherwise.

```js
Sample = { t, lengths: { forearm: { left: 0.74, right: 0.75 }, ... },   // segment length / shoulder width
              widths:  { forearm: { left: 0.38, right: 0.40 }, ... } }  // mask width at the midpoint / shoulder width
Calibration = { version: 1, at: "2026-10-23T12:00:00.000Z", samples: 12,
                radii: { upper_arm, forearm, thigh, leg },   // half-width in shoulder widths, clamped 0.5x..2x default
                lengths: { upper_arm, forearm, thigh, leg } }
```

Widths are measured from `frame.pose.mask` by walking perpendicular to the capsule axis at its
midpoint until the mask ends (when one side runs on more than twice as far, e.g. into the other
thigh, twice the shorter side is used); without a mask a sample holds lengths only. The view
persists the calibration (localStorage) and passes it back with `setCalibration`.

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
     |  { axis: "ap" | "lateral", zoom: 1, cx: 0.5, cy: 0.42 }     // xray (xray.js parseView; cy = frac along the long axis)
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

Selection is lock-based: every frame the overlay draws all `pointer.outlines(frame)` as faint dashed
zones, the led segment (`result.coarse`) brighter, the locked one solid `#4fb3ff` with its label, plus a
progress ring on the fingertip. The pill reads "Hold on: <label>" until `result.locked`, then
"<label> · locked" with an Unlock button (also Escape, or tapping the stage); tapping the stage while
a candidate exists calls `pointer.lock()`. The panel and probe follow the locked flag only. A
Calibrate button (and a first-use card, skippable via `localStorage live.calibration.skipped`) runs
`pointer.measure` / `calibrate` / `setCalibration` and stores the result in `live.calibration.v1`;
pointing is paused meanwhile. Key R (or the "Record 10 s" button with `?live-debug=1`) records up to
600 frames into the `tools/live/record_fixture.mjs` fixture schema and downloads
`live-recording-<timestamp>.json`.

Gesture flow (state "hand" -> "seek" -> "locked"): after tracking starts, unless `localStorage live.pointerHand`
is set, the pill asks the user to raise the hand to point with (`gestures.update(...).raised`), then
`pointer.setPointerHand(side)` and the choice is stored; "Change hand" (`.live-hand`) clears it. No pointing is
evaluated in "hand". On lock the stage wrapper `.live-zoom` (video + overlay) scales to the segment's padded
bounding box (max 3x, eased per frame, back to identity on unlock). The pointer hand's index finger drives the
probe; the control hand counts 1-4 = CT/MRI/X-ray/Ultrasound, fist + blink advances the `.current` structure
(Enter or a tap opens it in Explore), open palm for 1 s unlocks. Fixture: `tools/live/make_gesture_fixture.mjs`.

## 6. Tests

Each workstream adds a Playwright script under `tools/live/` runnable as
`node tools/live/<name>.mjs http://127.0.0.1:<port>/ /opt/pw-browsers/chromium` against
`python3 tools/serve.py --port <port>`. Pure logic (pointing, probe maths) also gets a Node
unit script that needs no browser. Use the port your brief assigns so parallel runs do not collide.

## 7. gestures.js

```js
export function createGestures({ holdMs = 600, openMs = 1000, blinkMinMs = 60, blinkMaxMs = 700 } = {}) -> Gestures
export function readHand(hand, frame) -> HandRead | null     // pure, one hand of a tracker frame
gestures.update(frame, { pointerHand }) -> GestureResult    // pointerHand: "left" | "right" | null
gestures.reset()                                             // forget every timer
```

```js
GestureResult = {
  hands: { left: HandRead | null, right: HandRead | null },  // highest-score hand per side
  control: (HandRead & { side }) | null,  // the hand that is not pointerHand; null when pointerHand is null or it is absent
  raised: "left" | "right" | null,        // level: four fingers up (thumb free), wrist at or above its own shoulder (pose 11 / 12), steady holdMs, forgiving of flicker
  count: null | 1 | 2 | 3 | 4,            // edge: control hand's index..pinky count steady holdMs; once, then null until it changes or drops
  fist: boolean,                          // level: control hand steady fist for 300 ms
  open: boolean,                          // level: control hand steady open palm for openMs
  blink: boolean                          // edge: both eyes >= 0.5 for blinkMinMs..blinkMaxMs after being open (< 0.3), on reopening
}
HandRead = { fingers: 0..5, extended: { thumb, index, middle, ring, pinky }, shape: "fist" | "point" | "open" | "count" | "other", raised }
```

Finger rule (pixel space; the view's fixture generator uses the same rule): index..pinky (tips
8/12/16/20, PIPs 6/10/14/18, MCPs 5/9/13/17) is extended when `dist(tip, wrist) > 1.6 * dist(mcp, wrist)`
and `dist(tip, wrist) > dist(pip, wrist)`; the thumb when `dist(4, 5) > 0.8 * dist(0, 5)`. Shapes ignore
the thumb: fist = none of index..pinky, point = index only, open = all four plus the thumb, count = any
other subset (four fingers with the thumb tucked is a count of 4); "other" = degenerate landmarks. An
open palm never emits a count, so "release" (open) and "4 = ultrasound" (count) cannot collide. "Steady" = the same reading every update for the hold time; up to 2
consecutive missing / "other" frames keep the timer, a third (or a different reading) restarts it.
A blink needs `frame.face.blink` (null face for more than 2 frames re-arms it: eyes must be seen open
again). The view decides what each signal does; gestures.js holds no app state.
