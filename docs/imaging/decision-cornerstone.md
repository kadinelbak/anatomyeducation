# Decision: Cornerstone3D core, vendored as one file

Date 2026-10-11. The PRD names Cornerstone3D (MIT) as the second renderer. The
open question was whether it fits an app with no build step and a phone-first
page. Checked by building and running it in headless Chromium:

| | Cornerstone3D core 5.11.7 | Plain 2D-canvas MPR (not built) |
|---|---|---|
| Ships as | one prebuilt ES module, 2.9 MB raw, 0.8 MB gzipped; no workers, no wasm | ~500 lines, 0 KB extra |
| Needs | WebGL2 (every current phone has it) | nothing |
| Gives | GPU multiplanar volume viewport, correct spacing and orientation, window/level, labelmap overlay via a second volume and colormap; later: DICOM, MPR obliques, measurement tools, 3D rendering | just what the quiz needs today |
| Risk | version churn in a fast-moving library; the bundle is rebuilt by `tools/build_cornerstone.sh` | we own every bug; no path to real DICOM studies |

Chosen: Cornerstone3D core, because it works build-free (the bundle is vendored
the same way Three.js is in anatomy-app), its cost is under a megabyte over the
wire, and it is the path to clinical DICOM studies and MRI in milestone 4. The
"tools" package (segmentation display, annotations) is not bundled; highlights
are done with a per-state colormap on the label volume, which is enough for
click-the-structure questions.

The one-file bundle only re-exports what the renderer uses (see
`tools/build_cornerstone.sh`); rebuilding it needs Node and npm access, which
this environment had. unpkg and jsdelivr were blocked, so the bundle is checked
in rather than loaded from a CDN. That also matches "nothing goes public yet".
