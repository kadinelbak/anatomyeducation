# Volume package format (imaging milestone)

A "study" is one CT volume plus its labelmap, prepared offline by
`tools/pack_study.py` and shipped as static files. The browser never parses
NIfTI or DICOM; it reads a small JSON manifest and two gzip'd typed arrays.

```
assets/volumes/<study-id>/
  study.json        manifest (below)
  ct.i16.gz         Int16 little-endian voxels, Hounsfield units, gzip
  labels.u8.gz      Uint8 voxels, label values, gzip (Uint16 "labels.u16.gz" if > 255 labels)
```

Both arrays are stored in RAS voxel order, x fastest: index = i + nx*(j + ny*k),
where +i is the patient's left-to-right... no: in RAS, +i points to the patient's
Right, +j to Anterior, +k to Superior. The renderer flips x when drawing so the
screen shows radiological convention (patient's right on the viewer's left).
The browser decodes the gzip streams with `DecompressionStream("gzip")`.

## study.json

```json
{
  "id": "ts-example-sm",
  "source": "TotalSegmentator example CT (wasserth/TotalSegmentator, tests/reference_files)",
  "license": "CC BY 4.0",
  "attribution": "Wasserthal et al., TotalSegmentator, Radiology: AI 2023",
  "dims": [nx, ny, nz],
  "spacing": [sx, sy, sz],
  "ct": { "file": "ct.i16.gz", "dtype": "int16" },
  "labels": { "file": "labels.u8.gz", "dtype": "uint8" },
  "windows": {
    "soft":  { "width": 400,  "level": 40 },
    "lung":  { "width": 1500, "level": -600 },
    "bone":  { "width": 1800, "level": 400 }
  },
  "structures": {
    "5":  { "key": "liver",  "name": "Liver",  "group": "organ" },
    "1":  { "key": "spleen", "name": "Spleen", "group": "organ" }
  },
  "views": {
    "liver-axial": { "plane": "axial", "frac": 0.42, "window": "soft" }
  }
}
```

- `structures` maps label value -> stable key, display name and a group used by
  the layers/outline toggle. Keys are TotalSegmentator class names where the data
  comes from TotalSegmentator (`liver`, `kidney_left`, `vertebrae_L1`, ...). A
  question's `target`/`accept` use these keys, never the numeric values.
- `views` are named starting positions a question can reference in its `view`
  field. A question can also give an inline view string `"axial:0.42:soft"`
  (plane, fraction 0..1 along that axis, optional window). `frac` is relative to
  the volume, so the same question survives re-cropping of the study.
- `windows` are named presets; the renderer also lets the student drag to adjust.

## Question record for scan questions

Same record as mesh questions (PRD, "A question record"), with
`"renderer": "volume"`, a `"study"` field naming the study id, `target` and
`accept` holding structure keys, `view` a named or inline view, and `layers`
listing overlay hints visible when the question opens (`[]` for none; `["outline"]`
draws faint outlines of every labelled structure, which is a hint, not an answer).
