# Live mode

Point at your own body with the camera; the app lists the region's structures, and the other index finger
scrubs CT, MRI, X-ray and simulated ultrasound slices. Everything runs in the browser; nothing is uploaded.

Contracts (data shapes, coordinates, module APIs): [`src/live/CONTRACTS.md`](../../src/live/CONTRACTS.md).
Before a release: [`release-checklist.md`](release-checklist.md). Top-level notes: [`README.md`](../../README.md#live-mode).

## File map by workstream

| | Files |
|---|---|
| A, view | `src/live/view.js`, `src/live/live.css`, the `#live` section and `#go-live` in `index.html` |
| B, tracking | `src/live/tracking.js`, `vendor/mediapipe/`, `assets/ml/` |
| C, pointing | `src/live/pointing.js`, `assets/live/segments.json` |
| D, probe | `src/live/probe.js`, `assets/live/studies.json` |
| E, ultrasound | `src/live/probe-us.js`, the usframes renderer, `assets/ultrasound/live-views.json` |
| F, data | import scripts under `tools/live/` and the data they write; NOTICE rows |
| G, docs and test | `README.md`, `NOTICE.md` privacy text, `docs/live/`, `tools/live/smoke_test_live.mjs` |

## How the pieces call each other

`app.js` opens `view.js` from `#go-live`. The view checks camera, secure context and WebGL2 (fallback card if
any is missing), gets the camera stream and creates the tracker from `tracking.js`. Each video frame, the
tracker calls `onFrame` with pose and hand landmarks in image space (sides already corrected for the selfie
view). The view passes the pointing hand to `pointing.js`, which uses `segments.json` to map the fingertip on the
body to a region and its structure list; the view renders the list. The other hand goes to `probe.js`, which
maps its fingertip to a slice position in a study from `studies.json` and draws CT, MRI or X-ray; for the
ultrasound modality it delegates to `probe-us.js`, which draws simulated frames using `live-views.json`.
Leaving Live (brand button, mode switch, page hide) calls `tracker.stop()` and stops every camera track.
