# Volume renderer: interface and behaviour

`createVolumeRenderer({ container, studiesBase, studyUrl, onPick })` returns the same
object `createMeshRenderer` returns in anatomy-app (`src/renderers/mesh.js`), so
`createEngine({ renderer, ... })` works unchanged:

| call | mesh renderer | volume renderer |
|---|---|---|
| `show({ view, layers, study })` | camera preset + visible layers (`study` ignored) | if `study` names a different study id, load it first (fetched once, cached), then `resolveView(view)`: plane, slice = round(frac*(depth-1)), window preset; `layers` includes `"outline"` -> faint overlay of every labelled structure; else no overlay. Resets zoom/pan. Returns a promise; picks during a load are ignored. |
| `highlight(id, "good"\|"bad")` | tint meshes | fill the structure's label mask on the current slice (green/red, ~45% alpha) and, if the structure has no voxels on the current slice, jump to the slice through its centroid in the current plane (like the mesh renderer turning a hidden layer on). Several highlights can be active. |
| `clearHighlight()` | restore colours | remove all fills |
| `name(id)` | display name | `study.name(key)`; unknown key -> the key itself |
| `setDefaultLayers()` | default layer set | no overlay, soft window, keep plane/slice |
| `setPickEnabled(on)` | clicks answer vs hover labels | same: when on, a tap/click on a labelled voxel calls `onPick(key)`; a tap on an unlabelled voxel does nothing except a brief "nothing labelled here" ring at the tap point. When off, hover (mouse) and tap show a label with the structure's name. |
| `debug` | internals | `{ volume, state, setPlane, setSlice, setWindow, pickAt }` |

`id` values are structure keys (`"liver"`, `"kidney_left"`), never label numbers.

## Interaction (phone first)

- Scroll slices: mouse wheel; vertical one-finger drag; the slice slider.
- Window/level: named preset buttons (Soft, Lung, Bone) and right-drag or
  two-finger vertical drag (left-right = width, up-down = level).
- Plane: Axial / Coronal / Sagittal buttons. Switching keeps the crosshair
  position: the new slice is the one through the voxel at the centre of the
  old view.
- Zoom and pan: pinch, ctrl+wheel, and a `+`/`-` pair; shift-drag pans. Reset
  on `show()`.
- The image is drawn with the correct aspect from `spacing` (non-isotropic
  voxels must not look squashed), nearest-neighbour for the labelmap, bilinear
  for the CT. Radiological convention: the patient's right is on the viewer's
  left, marked with R/L (axial, coronal) or A/P (sagittal) letters at the edges.
- A tap is a pointerup within 6 px of pointerdown, as in the mesh renderer.

## DOM the renderer owns

`container` is an empty block element. The renderer appends a `<canvas>` that
fills it, plus a small toolbar (`.vol-toolbar`: plane buttons, window buttons,
zoom, slice slider) and a hover label. All class names start with `vol-`.
Styles live in `imaging/src/renderers/volume.css` and are loaded by the page.
No ids are assumed to exist in the page (unlike mesh.js, which reads `#slice`,
`#controls`, `input[data-layer]` from index.html); this is what makes it
droppable into any page.

## Loading

`loadStudy(studyUrl)` from `src/volume.js` fetches `study.json` and the two
gzip'd arrays (decoded with `DecompressionStream`). The sample study is 0.5 MB.
Studies of 256^3 Int16 are ~16-30 MB gzipped; the packer's `--crop` and
`--max-dim` keep them under ~8 MB for phones.

## Implementation choice

See docs/decision-cornerstone.md for why the renderer is a plain 2D-canvas
multiplanar viewer with no library rather than a Cornerstone3D viewport, and
what it would take to swap one in.
