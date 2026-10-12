# MRI studies in the volume package format

An MRI study is the same package as a CT study (imaging/docs/volume-format.md):
`study.json` plus two gzip'd typed arrays, prepared offline by
`mri/tools/pack_study.py` (a superset of `imaging/tools/pack_study.py`; with
`--modality CT` its output is unchanged). Everything MRI-specific is declared
in `study.json`; the renderer reads it and hard-codes nothing.

```
assets/volumes/<study-id>/
  study.json
  image.i16.gz      Int16 voxels, rescaled MR signal 0..4095 (CT studies keep ct.i16.gz in HU)
  labels.u8.gz      Uint8 label values, as for CT
  *.b64.txt         base64 copies for text-only hosts (--b64), as the hosted artifact needs
```

## New manifest fields

```json
{
  "modality": "MR",                       // "CT" (default when absent) or "MR"
  "sequence": "T1",                       // short code shown in the viewer badge and used by question tags
  "sequenceLabel": "T1-weighted, non-contrast (abdomen, 3 mm)",   // badge tooltip
  "sourceUrl": "https://zenodo.org/records/11367005",             // attribution footer link
  "intensity": { "units": "arbitrary", "stored_range": [0, 4095],
                 "rescaled_from": [lo, hi], "note": "..." },
  "image": { "file": "image.i16.gz", "dtype": "int16" },
  "ct":    { "file": "image.i16.gz", "dtype": "int16" },          // alias so the old loader still works
  "defaultWindow": "soft",
  "windows": {
    "soft":   { "width": 3734, "level": 1872, "label": "Default" },
    "tissue": { "width": 2706, "level": 740,  "label": "Tissue" },
    "bright": { "width": 2146, "level": 3022, "label": "Bright" },
    "dark":   { "width": 1480, "level": 740,  "label": "Dark" }
  }
}
```

- **Intensity rescaling.** MR signal has no units and differs between scanners
  and sequences, so the packer maps the 0.5th..99.8th percentile of the
  non-background voxels onto 0..4095 (clipped). The window presets are then in
  stored units and mean the same thing on every study; the renderer's
  width/level drag already scales with the current width, so it feels the same
  on HU and on rescaled MR.
- **Presets** are computed from the image histogram, not fixed constants:
  `soft` (the 1st..99th percentile, the default everywhere `soft` was the CT
  default), `tissue` (10th..90th, separates liver, spleen and muscle), `bright`
  (upper range: fluid on T2, fat on T1, enhancing vessels after contrast), and
  `dark` (lower range: cortical bone, air, flow voids). The key `soft` is kept
  for the default so existing views (`"window": "soft"`) and the renderer's
  fallback keep working; `label` is the button text.
- **`defaultWindow`** names the preset the renderer starts with and returns to
  in `setDefaultLayers()`; absent, it is `soft`, else the first preset.
- **Named views** now pick the plane: axial through the centroid unless that
  slice holds none of the structure (intervertebral discs on a 3 mm volume),
  then coronal, then sagittal. The CT packer always wrote axial.

## Question records

Unchanged, plus two tags the sets and review sheet use:

```json
"tags": { "topic": "organs", "region": "abdomen", "difficulty": 1, "modality": "MRI", "sequence": "T1" }
```

The stem names the sequence in words ("On this T1-weighted MRI, click the
liver.") because the badge alone is easy to miss, and the explanation says what
the structure looks like on that weighting. `sets.js` titles a scan set from
`tags.modality` of its questions ("CT scan", "MRI scan", or "MRI: Abdomen" and
"MRI: Pelvis" when two MRI studies exist).

## Making more MRI studies

TotalSegmentator MRI dataset (Zenodo 11367005, CC BY 4.0, 298 MR series with
per-structure masks; zenodo.org is blocked from the build environment):

```
python3 tools/merge_masks.py --dir sXXXX/segmentations --classmap data/raw/totalsegmentator-example-mr/class_map_total_mr.json --out sXXXX/labels.nii.gz
python3 tools/pack_study.py --image sXXXX/mri.nii.gz --seg sXXXX/labels.nii.gz --classmap .../class_map_total_mr.json \
    --id ts-mr-sXXXX --modality MR --sequence T1 --sequence-label "T1-weighted VIBE" \
    --source "TotalSegmentator MRI dataset sXXXX" --source-url https://zenodo.org/records/11367005 \
    --license "CC BY 4.0" --attribution "TotalSegmentator MRI dataset (Akinci D'Antonoli et al.)" \
    --out assets/volumes/ts-mr-sXXXX --crop --max-dim 256 --b64
```

The dataset's `meta.csv` gives the sequence per series (T1, T2, and others);
pass it as `--sequence`. The class map is the `total_mr` table from
TotalSegmentator's `map_to_binary.py` (50 classes; vertebrae and discs are one
label each, unlike CT).
