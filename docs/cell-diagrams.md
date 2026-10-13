# Labelled cell diagrams

The twelve stylised cell studies (`assets/cells/cl-*` and `generic-cell`) have a 2D labelled diagram as well as
the hand-placed 3D model. The cell renderer opens them in **Diagram** view by default; the toolbar's **3D**
button switches to the old model and back. The four Allen Cell studies have no diagram and stay 3D only.

## Study manifest

```json
"diagram": { "file": "diagram.svg", "attribution": "Original labelled diagram drawn for the Hand Nerves 3D project", "license": "CC BY-SA 4.0" }
```

The footer shows the diagram's attribution and licence while the diagram is on screen, and the model's line in 3D.
Servier Medical Art (CC BY 4.0) was the preferred source, but its site could not be reached from the build
environment to confirm the licence or fetch the art, so every diagram is original SVG drawn for this app.

## SVG contract

* One `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">`, no `width`/`height`, no `<script>`,
  `<image>`, `<foreignObject>`, event attributes or external `href`s. Gradient, pattern, filter and clip ids are
  prefixed with the study id (`cl57-nuc-grad`) because the app inlines the SVG into the page.
* No background rectangle: the renderer draws the paper colour `#f6f3ec` behind it.
* **Clickable parts**: each is a `<g data-part="KEY">` holding all of its shapes. `KEY` is exactly the key the 3D
  model gives that part: the bare `key` for a part with no `count`, or `key-1` … `key-N` for a stamped part with
  `count: N` (draw any number of copies from 1 to N, numbered from 1). Question banks accept these keys, so a click
  on a diagram region answers a question exactly as a click on the 3D part does. `data-part` groups never nest.
* Decoration that is not a part (cytoplasm, extracellular space, neighbouring tissue that is not in `parts`) has no
  `data-part`; clicks on it name nothing.
* The plasma membrane (or sarcolemma, soma outline) is a **stroke**, not a filled shape, so its interior stays
  cytoplasm. Give thin or tiny parts an invisible hit shape inside their group (`fill="transparent"` or
  `stroke="transparent"` with a wide `stroke-width`), at least 18 units across, so they can be tapped on a phone.
  Paint order matters: later shapes win the click, so draw large parts first and small ones on top.
* **Labels**: one `<g class="dg-labels">` drawn last, holding a `<g data-label="BASEKEY">` per part (one per
  distinct part name is enough) with a leader line (`polyline`/`line`, stroke `#4a5560`, width 1.5, a dot of r 3 at
  the part end) and a `<text>` in the left or right margin. Text: `font-family="system-ui, sans-serif"`,
  `font-size="22"`, fill `#1f2933`. Leader lines do not cross. The renderer hides the whole group during
  questions, so the labels may name the parts freely.

## Look

Textbook illustration: soft gradients, clean outlines (`#2d3a4a` family, 1.5–2.5 units), no drop shadows heavier
than a hint. Shared palette so the same organelle looks the same in every cell:

| Structure | Fill | Outline / detail |
|---|---|---|
| Cytoplasm | `#fbf3e6` to `#f3e3cc` radial | none |
| Plasma membrane | bilayer: `#8fa3d6` outer stroke 9, `#e6ecf8` inner stroke 3 | |
| Nucleus | `#8b7cc8` to `#6a5aa8` | envelope `#43367a`, chromatin specks `#4d3f8a` |
| Nucleolus | `#3b2c78` | |
| Mitochondrion | `#f6b26b` | outer `#b8642a`, cristae `#c97a3a` |
| Rough ER | `#7cc0d0` cisternae | outline `#2f7f94`, ribosome dots `#244f5e` |
| Smooth ER | `#a8dcd4` tubules | `#3f9a8e` |
| Golgi | `#f5cf5f` stacked curved cisternae | `#b38b1d`, budding vesicles |
| Lysosome | `#e98aa2` | `#a8405c`, darker granules |
| Secretory vesicle | `#f8e2a8` | `#c9a54a` |
| Collagen / matrix | `#e9dcbc` banded `#cdb98a` | |
| Bone / mineral | `#efe6d2` with lamellae `#d6c7a4` | |
| Myelin | `#efe9f7` lamellae `#b9a9d8` | |
| Actin / myofilaments | `#d9827a` | `#a34a42` |

Check a diagram with `python3 tools/check_diagrams.py <study-id>` (prints the keys it may use) and look at it
with `node tools/diagram_shot.mjs <study-id>` (add `--hits` to colour every clickable region).
