# Real ultrasound frame stacks

Layout under `assets/usframes/<id>/`:

```
stack.json
frames/000.jpg  frames/001.jpg ...   (zero-padded 3 digits, sweep order)
```

`stack.json`:

```json
{
  "version": 1,
  "id": "sample-synthetic",
  "title": "Synthetic sample",
  "modality": "ultrasound",
  "ext": "jpg",
  "source": "where the clip came from",
  "license": "SPDX id or text",
  "segment": "trunk",
  "side": null,
  "frac": [0.2, 0.3],
  "frames": 24,
  "width": 160,
  "height": 120,
  "labels": [ [ { "key": "vessel", "name": "Vessel", "poly": [[0.4, 0.4], [0.5, 0.4], [0.45, 0.5]] } ] ]
}
```

- `ext` is optional, default `jpg`; the sample uses `png`.
- `segment` and `side` use the ids of `assets/live/segments.json` (side is `"left"`, `"right"` or null).
- `frac` is the span of the segment (proximal 0 -> distal 1) that the sweep covers, frame 0 first.
- `labels` is optional. When present it has one entry per frame: a list of `{ key, name, poly }`
  with `poly` as `[x, y]` points normalised 0..1 over the frame.
- Renderer: `createUsFramesRenderer` in `src/renderers/usframes.js`. `show({ study, view: { frac }, layers })`
  takes `view.frac` as 0..1 along the stack (0 = first frame) and draws the nearest frame. Include `"labels"`
  in `layers` to outline labels. The switch hosts it as kind `"usframes"`; `study` is the stack id.
